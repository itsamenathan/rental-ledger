import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rental-test-"));
process.env.TRUST_PROXY = "1";

const { openDb, setDb } = await import("./db.ts");
const { seedDefaults } = await import("./seed.ts");
const { createApp } = await import("./app.ts");
const { isPrivateAddress, safeDownload, BlockedAddressError } = await import("./services/safe-download.ts");

const db = openDb(":memory:");
setDb(db);
seedDefaults(db);
const app = createApp();

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("first-run setup", () => {
  it("enforces the password rules and creates only one admin when raced", async () => {
    expect((await post("/api/auth/setup", { email: "a@example.com" })).status).toBe(400);
    expect((await post("/api/auth/setup", { email: "a@example.com", password: "" })).status).toBe(400);
    expect((await post("/api/auth/setup", { email: "a@example.com", password: "short" })).status).toBe(400);
    const results = await Promise.all(
      ["a@example.com", "b@example.com", "c@example.com"].map(async (email) =>
        post("/api/auth/setup", { email, password: "correct horse battery" }),
      ),
    );
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 403, 403]);
  });
});

describe("login rate limits", () => {
  it("limits guesses per address without locking the user out elsewhere, and ignores spoofed hops", async () => {
    const login = (password: string, xff: string) =>
      post("/api/auth/login", { email: "a@example.com", password }, { "x-forwarded-for": xff });
    // With TRUST_PROXY=1 only the last hop counts; the client-supplied first entry changes nothing.
    for (let i = 0; i < 10; i++) expect((await login("wrong password", `10.9.9.${i}, 203.0.113.5`)).status).toBe(401);
    expect((await login("wrong password", "1.1.1.1, 203.0.113.5")).status).toBe(429);
    expect((await login("correct horse battery", "203.0.113.5")).status).toBe(429);
    // The real user, from their own address, still gets in.
    expect((await login("correct horse battery", "198.51.100.7")).status).toBe(200);
  });

  it("answers unknown emails like wrong passwords", async () => {
    const r = await post(
      "/api/auth/login",
      { email: "nobody@example.com", password: "whatever" },
      { "x-forwarded-for": "198.51.100.8" },
    );
    expect(r.status).toBe(401);
  });
});

describe("safe downloads", () => {
  it("knows which addresses are private", () => {
    for (const a of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "::",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
      "nonsense",
    ])
      expect(isPrivateAddress(a), a).toBe(true);
    for (const a of ["8.8.8.8", "1.1.1.1", "2606:4700::1111", "::ffff:8.8.8.8"])
      expect(isPrivateAddress(a), a).toBe(false);
  });

  let server: Server;
  let base = "";
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/redirect") return res.writeHead(302, { location: "/feed.ics" }).end();
      if (req.url === "/loop") return res.writeHead(302, { location: "/loop" }).end();
      if (req.url === "/big") return res.end("x".repeat(2000));
      res.writeHead(200, { "content-type": "text/calendar", "content-encoding": "gzip" });
      res.end(gzipSync("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const opts = { maxBytes: 1000, timeoutMs: 5000 };

  it("refuses private addresses, by IP and by name", async () => {
    await expect(safeDownload(`${base}/feed.ics`, opts)).rejects.toBeInstanceOf(BlockedAddressError);
    const named = base.replace("127.0.0.1", "localhost");
    await expect(safeDownload(`${named}/feed.ics`, opts)).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it("follows redirects, decompresses and caps the size when private feeds are allowed", async () => {
    const allowed = { ...opts, allowPrivate: true };
    expect(await safeDownload(`${base}/redirect`, allowed)).toContain("BEGIN:VCALENDAR");
    await expect(safeDownload(`${base}/loop`, allowed)).rejects.toThrow(/redirected too many times/);
    await expect(safeDownload(`${base}/big`, allowed)).rejects.toThrow(/too large/);
  });
});
