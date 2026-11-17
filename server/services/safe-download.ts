/**
 * Download a user-supplied URL (booking calendar feeds) without letting it reach the server's own network.
 *
 * Every address a hostname resolves to is checked at connect time (inside the socket's DNS lookup, so a name can't
 * resolve to a public address for a check and a private one for the connection), literal IPs are checked before
 * connecting, and redirects are followed by hand so each hop is checked the same way. Set
 * CALENDAR_ALLOW_PRIVATE_NETWORK=true to allow feeds served from your own network.
 */
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Readable } from "node:stream";

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
] as const)
  blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const)
  blocked.addSubnet(net, prefix, "ipv6");

/** True for loopback, private, link-local and other addresses that aren't on the public internet. */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return blocked.check(mapped[1]!, "ipv4");
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family === 6) return blocked.check(address, "ipv6");
  return true; // not an address at all: refuse
}

export class BlockedAddressError extends Error {
  constructor() {
    super("That link points to a private network address, which isn't allowed");
    this.name = "BlockedAddressError";
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

function guardedLookup(hostname: string, options: LookupOptions, callback: LookupCallback) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address)))
      return callback(new BlockedAddressError() as NodeJS.ErrnoException, []);
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
}

function decoded(res: IncomingMessage): Readable {
  switch ((res.headers["content-encoding"] ?? "").toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return res.pipe(createGunzip());
    case "deflate":
      return res.pipe(createInflate());
    case "br":
      return res.pipe(createBrotliDecompress());
    default:
      return res;
  }
}

export interface DownloadOptions {
  maxBytes: number;
  timeoutMs: number;
  accept?: string;
  allowPrivate?: boolean;
  maxRedirects?: number;
}

/** GET a URL as text. Throws BlockedAddressError, a TimeoutError, or an Error with a message fit to show. */
export async function safeDownload(url: string, opts: DownloadOptions): Promise<string> {
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let current = new URL(url);
  for (let hop = 0; ; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:")
      throw new Error("Only http(s) links are allowed");
    const host = current.hostname.replace(/^\[|\]$/g, "");
    if (!opts.allowPrivate && isIP(host) && isPrivateAddress(host)) throw new BlockedAddressError();
    const res = await get(current, opts, signal);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (hop >= (opts.maxRedirects ?? 5)) throw new Error("The calendar link redirected too many times");
      current = new URL(res.headers.location, current);
      continue;
    }
    if (status < 200 || status >= 300) {
      res.resume();
      throw new Error(`The calendar link answered ${status} ${res.statusMessage ?? ""}`.trim());
    }
    const declared = Number(res.headers["content-length"] ?? 0);
    if (declared > opts.maxBytes) {
      res.destroy();
      throw new Error("The calendar is too large");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const body = decoded(res);
    try {
      for await (const chunk of body) {
        size += (chunk as Buffer).byteLength;
        if (size > opts.maxBytes) throw new Error("The calendar is too large");
        chunks.push(chunk as Buffer);
      }
    } catch (e) {
      res.destroy();
      if (signal.aborted) throw timeoutError();
      throw e;
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }
}

function timeoutError() {
  const e = new Error("The calendar link didn't answer in time");
  e.name = "TimeoutError";
  return e;
}

function get(url: URL, opts: DownloadOptions, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(url, {
      method: "GET",
      signal,
      headers: { accept: opts.accept ?? "*/*", "accept-encoding": "gzip, deflate, br" },
      ...(opts.allowPrivate ? {} : { lookup: guardedLookup as never }),
    });
    req.on("response", resolve);
    req.on("error", (e) => reject(signal.aborted ? timeoutError() : e));
    req.end();
  });
}
