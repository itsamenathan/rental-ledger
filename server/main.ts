import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "./app.ts";
import { config } from "./config.ts";
import { closeDb, getDb } from "./db.ts";
import { seedDefaults } from "./seed.ts";

const db = getDb();
seedDefaults(db);

const app = createApp();
const dist = resolve(import.meta.dirname, "../dist");
const indexHtml = readFileSync(resolve(dist, "index.html"), "utf8");

app.use(
  "/assets/*",
  serveStatic({ root: dist, onFound: (_p, c) => c.header("Cache-Control", "public, max-age=31536000, immutable") }),
);
app.use("*", serveStatic({ root: dist }));
// SPA fallback for client-side routes
app.get("*", (c) => c.html(indexHtml, 200, { "Cache-Control": "no-cache" }));

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Rental ledger listening on :${info.port} (db: ${config.databasePath})`);
});

const shutdown = () => {
  server.close();
  closeDb(db);
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
