import react from "@vitejs/plugin-react";
import { getRequestListener } from "@hono/node-server";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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

/**
 * Emit dist/sw.js from pwa/service-worker.js with this build's hashed asset list, so an installed app can open
 * offline and picks up a new version (the file's bytes change whenever any asset does).
 */
function serviceWorker(): Plugin {
  return {
    name: "rental-service-worker",
    apply: "build",
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle)
        .filter((f) => f.startsWith("assets/"))
        .sort()
        .map((f) => `/${f}`);
      const id = createHash("sha256").update(assets.join("\n")).digest("hex").slice(0, 12);
      const source = readFileSync(new URL("./pwa/service-worker.js", import.meta.url), "utf8")
        .replace("__BUILD_ID__", id)
        .replace("__ASSETS__", JSON.stringify(assets));
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

/** Run git and return its trimmed output, or null when git or the repository isn't there (e.g. in Docker). */
function git(...args: string[]): string | null {
  try {
    return (
      execFileSync("git", ["-c", "safe.directory=*", ...args], {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/**
 * The version shown in the app: the commit's date plus its hash, linked to the commit. GIT_SHA / GIT_DATE (Docker
 * build args) win over git, and a build without either still works.
 */
function buildInfo() {
  const sha = process.env.GIT_SHA?.trim() || git("rev-parse", "HEAD");
  const date =
    process.env.GIT_DATE?.trim() || git("log", "-1", "--format=%cs") || new Date().toISOString().slice(0, 10);
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
    repository?: { url?: string };
  };
  const repo = pkg.repository?.url?.replace(/^git\+/, "").replace(/\.git$/, "");
  return { date, sha, url: sha && repo ? `${repo}/commit/${sha}` : null };
}

export default defineConfig({
  define: {
    __APP_BUILD__: JSON.stringify(buildInfo()),
  },
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
  plugins: lazyPlugins(() => [react(), devApi(), serviceWorker()]),
});
