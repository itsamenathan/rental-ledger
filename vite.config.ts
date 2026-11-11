import react from "@vitejs/plugin-react";
import { getRequestListener } from "@hono/node-server";
import { defineConfig, lazyPlugins, type Plugin, type ViteDevServer } from "vite-plus";

/** Serve the Hono API from the dev server so `vp dev` runs the whole app with live reload of server code. */
function devApi(): Plugin {
  return {
    name: "rental-dev-api",
    apply: "serve",
    configureServer(server: ViteDevServer) {
      const apps = new WeakMap<object, (req: never, res: never) => void>();
      server.middlewares.use(async (req, res, next) => {
        if (!/^\/(api\/|mcp(\/|\?|$)|llms\.txt|healthz)/.test(req.url ?? "")) return next();
        try {
          const mod = await server.ssrLoadModule("/server/dev-entry.ts");
          let listener = apps.get(mod);
          if (!listener) {
            listener = getRequestListener(mod.createDevApp().fetch) as never;
            apps.set(mod, listener);
          }
          listener(req as never, res as never);
        } catch (err) {
          next(err);
        }
      });
    },
  };
}

export default defineConfig({
  fmt: {
    printWidth: 120,
  },
  lint: {
    plugins: ["react", "typescript", "oxc"],
    rules: {
      "react/rules-of-hooks": "error",
      "react/only-export-components": ["warn", { allowConstantExport: true }],
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
  },
  test: {
    include: ["server/**/*.test.ts"],
    environment: "node",
  },
  server: { port: 5173 },
  plugins: lazyPlugins(() => [react(), devApi()]),
});
