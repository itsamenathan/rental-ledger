/**
 * Minimal ZIP support (UTF-8 names, stored or deflate, no ZIP64, so archives stay under 4 GB and 65,535 entries).
 *
 * Downloads use `zipStream`, which reads and compresses one file at a time off the event loop and streams the result,
 * so a large export neither blocks other requests nor holds the whole archive in memory. Restores use `readZip`,
 * which lists entries from the central directory and inflates one entry at a time, never past its declared size.
 */
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { crc32, deflateRaw as deflateRawCb, deflateRawSync, inflateRaw as inflateRawCb } from "node:zlib";
import { badRequest } from "../context.ts";
import { enter } from "../maintenance.ts";

const deflateRaw = promisify(deflateRawCb);
const inflateRaw = promisify(inflateRawCb) as (buf: Buffer, opts: { maxOutputLength: number }) => Promise<Buffer>;

export interface Entry {
  name: string;
  data: Buffer;
}

/** A file to put in a streamed zip: bytes in hand, or a path read when its turn comes. */
export type ZipSource = Entry | { name: string; path: string };

/** Formats that don't shrink: stored as they are instead of spending CPU on deflate. */
const STORED = /\.(jpe?g|png|gif|webp|heic|heif|zip|gz|pdf)$/i;

function dosTime(when: Date) {
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2),
    date: ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  };
}

interface Packed {
  name: Buffer;
  method: 0 | 8;
  crc: number;
  packedSize: number;
  size: number;
  offset: number;
}

function localHeader(p: Packed, t: { time: number; date: number }) {
  const b = Buffer.alloc(30);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(20, 4);
  b.writeUInt16LE(0x0800, 6); // UTF-8 names
  b.writeUInt16LE(p.method, 8);
  b.writeUInt16LE(t.time, 10);
  b.writeUInt16LE(t.date, 12);
  b.writeUInt32LE(p.crc, 14);
  b.writeUInt32LE(p.packedSize, 18);
  b.writeUInt32LE(p.size, 22);
  b.writeUInt16LE(p.name.length, 26);
  return b;
}

function centralDirectory(entries: Packed[], t: { time: number; date: number }, offset: number) {
  const parts: Buffer[] = [];
  for (const p of entries) {
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(p.method, 10);
    c.writeUInt16LE(t.time, 12);
    c.writeUInt16LE(t.date, 14);
    c.writeUInt32LE(p.crc, 16);
    c.writeUInt32LE(p.packedSize, 20);
    c.writeUInt32LE(p.size, 24);
    c.writeUInt16LE(p.name.length, 28);
    c.writeUInt32LE(p.offset, 42);
    parts.push(c, p.name);
  }
  const cd = Buffer.concat(parts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([cd, end]);
}

const LIMIT = 0xffffffff;

/** Build a small zip in memory (tests, tiny archives). Downloads use `zipStream`. */
export function zip(entries: Entry[], when = new Date()): Buffer {
  const t = dosTime(when);
  const parts: Buffer[] = [];
  const packed: Packed[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = deflateRawSync(e.data);
    const p: Packed = {
      name: Buffer.from(e.name, "utf8"),
      method: 8,
      crc: crc32(e.data),
      packedSize: data.length,
      size: e.data.length,
      offset,
    };
    const header = localHeader(p, t);
    parts.push(header, p.name, data);
    packed.push(p);
    offset += header.length + p.name.length + data.length;
  }
  return Buffer.concat([...parts, centralDirectory(packed, t, offset)]);
}

export interface ZipResult {
  bytes: number;
  files: number;
  /** Names of path sources whose file was gone when its turn came (skipped). */
  missing: string[];
}

export interface ZipStream {
  stream: ReadableStream<Uint8Array>;
  /** Settles when the last byte is produced, or rejects if the zip fails or the reader cancels. */
  done: Promise<ZipResult>;
}

/**
 * Stream a zip of `sources`. `open` runs before the first entry and `close` after the last (or on cancel/failure),
 * for setup that should only happen if someone actually reads the stream (temp files, the maintenance gate).
 */
export function zipStream(
  sources: ZipSource[] | (() => AsyncIterable<ZipSource>),
  opts: { when?: Date; open?: () => void | Promise<void>; close?: () => void | Promise<void> } = {},
): ZipStream {
  let settle!: (r: ZipResult) => void;
  let fail!: (e: unknown) => void;
  const done = new Promise<ZipResult>((res, rej) => {
    settle = res;
    fail = rej;
  });
  done.catch(() => {}); // callers that don't wait on it must not get an unhandled rejection

  async function* chunks(): AsyncGenerator<Buffer> {
    const t = dosTime(opts.when ?? new Date());
    const packed: Packed[] = [];
    const missing: string[] = [];
    let offset = 0;
    let finished = false;
    try {
      await opts.open?.();
      for await (const s of typeof sources === "function" ? sources() : sources) {
        let data: Buffer;
        if ("data" in s) data = s.data;
        else {
          try {
            data = await readFile(s.path);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
            missing.push(s.name);
            continue;
          }
        }
        const method = data.length && !STORED.test(s.name) ? 8 : 0;
        const body = method === 8 ? await deflateRaw(data) : data;
        const p: Packed = {
          name: Buffer.from(s.name, "utf8"),
          method,
          crc: crc32(data),
          packedSize: body.length,
          size: data.length,
          offset,
        };
        if (packed.length === 0xffff || offset + 30 + p.name.length + body.length > LIMIT)
          throw new Error("The archive is too large for a zip without ZIP64");
        const header = localHeader(p, t);
        yield header;
        yield p.name;
        yield body;
        packed.push(p);
        offset += header.length + p.name.length + body.length;
      }
      const tail = centralDirectory(packed, t, offset);
      yield tail;
      finished = true;
      settle({ bytes: offset + tail.length, files: packed.length, missing });
    } catch (e) {
      fail(e);
      throw e;
    } finally {
      if (!finished) fail(new Error("The download was cancelled"));
      await opts.close?.();
    }
  }

  // One chunk buffered at a time: a file is read only when the previous one is on its way, and the gate stays held
  // until the archive has almost all been delivered.
  const readable = Readable.from(chunks(), { highWaterMark: 1 });
  return { stream: Readable.toWeb(readable) as ReadableStream<Uint8Array>, done };
}

/** A download: `zipStream` that holds the maintenance gate while it's being read, so a restore waits for it. */
export function gatedZipStream(sources: ZipSource[] | (() => AsyncIterable<ZipSource>), when?: Date): ZipStream {
  let release: (() => void) | undefined;
  return zipStream(sources, {
    when,
    open: () => {
      release = enter();
    },
    close: () => release?.(),
  });
}

/** Read a whole stream (tests, the CLI's small cases). */
export async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

/** An entry listed in a zip's central directory; `read()` inflates it. */
export interface ZipEntry {
  name: string;
  size: number;
  read: () => Promise<Buffer>;
}

/** List a zip's entries (folders left out) without inflating anything. Stored and deflate only, no ZIP64. */
export function readZip(buf: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw badRequest("Not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw badRequest("Corrupt zip file");
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const packedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (packedSize === LIMIT || size === LIMIT || local === LIMIT) throw badRequest("ZIP64 archives are not supported");
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw badRequest("Corrupt zip file");
    if (method !== 0 && method !== 8) throw badRequest(`Unsupported compression in ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + packedSize > buf.length) throw badRequest("Corrupt zip file");
    out.push({
      name,
      size,
      read: async () => {
        const packed = buf.subarray(start, start + packedSize);
        let data: Buffer;
        try {
          // Never inflate past the declared size: a zip bomb stops here instead of filling memory.
          data = method === 0 ? Buffer.from(packed) : await inflateRaw(packed, { maxOutputLength: Math.max(1, size) });
        } catch {
          throw badRequest(`Corrupt zip entry ${name}`);
        }
        if (data.length !== size || crc32(data) !== crc) throw badRequest(`Corrupt zip entry ${name}`);
        return data;
      },
    });
  }
  return out;
}

/** Inflate every entry (tests and small zips). */
export async function unzip(buf: Buffer): Promise<Entry[]> {
  const out: Entry[] = [];
  for (const e of readZip(buf)) out.push({ name: e.name, data: await e.read() });
  return out;
}
