import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { config } from "./config.ts";
import { AppError } from "./context.ts";
import { errorResponse, resolveActor, type Env } from "./http/middleware.ts";
import { authRoutes } from "./http/auth-routes.ts";
import { api } from "./http/api-routes.ts";
import { mcpRoutes } from "./http/mcp.ts";
import { API_GUIDE } from "./guide.ts";

export function createApp() {
  const app = new Hono<Env>();
  app.onError(errorResponse);
  app.use("*", secureHeaders({ crossOriginResourcePolicy: "same-origin", contentSecurityPolicy: undefined }));
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: config.maxUploadBytes + 1024 * 1024,
      onError: () => {
        throw new AppError(413, "Request too large");
      },
    }),
  );
  app.use(
    "/mcp",
    bodyLimit({
      maxSize: 40 * 1024 * 1024,
      onError: () => {
        throw new AppError(413, "Request too large");
      },
    }),
  );

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/llms.txt", (c) => c.text(API_GUIDE, 200, { "Content-Type": "text/markdown; charset=utf-8" }));
  app.get("/api/docs", (c) => c.text(API_GUIDE, 200, { "Content-Type": "text/markdown; charset=utf-8" }));

  app.use("/api/*", resolveActor("api"));
  app.use("/mcp", resolveActor("mcp"));
  app.route("/api/auth", authRoutes);
  app.route("/api", api);
  app.route("/mcp", mcpRoutes);
  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));
  return app;
}
