import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "./app.ts";
import { config } from "./config.ts";
import { closeDb, getDb } from "./db.ts";
import { startScheduler } from "./scheduler.ts";
import { seedDefaults } from "./seed.ts";
import { initTelemetry, log, shutdownTelemetry } from "./telemetry.ts";

initTelemetry();

const db = getDb();
seedDefaults(db);

const app = createApp();
const dist = resolve(import.meta.dirname, "../dist");
const indexHtml = readFileSync(resolve(dist, "index.html"), "utf8");

app.use(
  "/assets/*",
  serveStatic({ root: dist, onFound: (_p, c) => c.header("Cache-Control", "public, max-age=31536000, immutable") }),
);
// The service worker and manifest must be re-checked on every load so installed apps pick up new versions.
const revalidate = serveStatic({ root: dist, onFound: (_p, c) => c.header("Cache-Control", "no-cache") });
app.use("/sw.js", revalidate);
app.use("/manifest.webmanifest", revalidate);
app.use("*", serveStatic({ root: dist }));
// SPA fallback for client-side routes
app.get("*", (c) => c.html(indexHtml, 200, { "Cache-Control": "no-cache" }));

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  log.info({ port: info.port, db: config.databasePath }, "rental ledger listening");
});

const stopScheduler = startScheduler();

const shutdown = () => {
  log.info("shutting down");
  stopScheduler();
  server.close();
  closeDb(getDb()); // a restore swaps the handle
  void shutdownTelemetry().finally(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
