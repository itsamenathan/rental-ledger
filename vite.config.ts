import react from "@vitejs/plugin-react";
import { getRequestListener } from "@hono/node-server";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, lazyPlugins, type Plugin, type Rolldown, type ViteDevServer } from "vite-plus";

type OutputFile = Rolldown.OutputAsset | Rolldown.OutputChunk;

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
 * The scanner's text reader (the tesseract worker/core and its English model, ~4.5 MB gzipped). It's only downloaded
 * when someone scans, so the service worker caches it on first use instead of on every install.
 */
const isScannerAsset = (f: OutputFile) =>
  f.type === "asset" && f.originalFileNames.some((n) => /tesseract\.js/.test(n));

/**
 * Emit dist/sw.js from pwa/service-worker.js with this build's hashed asset list, so an installed app can open
 * offline and picks up a new version (the file's bytes change whenever any asset does).
 */
function serviceWorker(): Plugin {
  return {
    name: "rental-service-worker",
    apply: "build",
    generateBundle(_options, bundle) {
      const files = Object.values(bundle).filter((f) => f.fileName.startsWith("assets/"));
      const list = (pick: (f: OutputFile) => boolean) =>
        files
          .filter(pick)
          .map((f) => `/${f.fileName}`)
          .sort();
      const assets = list((f) => !isScannerAsset(f));
      const scanner = list(isScannerAsset);
      const id = createHash("sha256").update(assets.join("\n")).digest("hex").slice(0, 12);
      const source = readFileSync(new URL("./pwa/service-worker.js", import.meta.url), "utf8")
        .replace("__BUILD_ID__", id)
        .replace("__ASSETS__", JSON.stringify(assets))
        .replace("__SCANNER_ASSETS__", JSON.stringify(scanner));
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

const COMPRESSIBLE = /\.(js|css|svg|json)$/;

/**
 * Write a .gz beside each built script and stylesheet; the production server sends it to browsers that accept gzip
 * (`precompressed` in server/main.ts). The tesseract core goes from ~3.9 MB to ~1.5 MB. Done after the files are written,
 * when every plugin has finished changing them.
 */
function precompress(): Plugin {
  let outDir = "dist";
  return {
    name: "rental-precompress",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    writeBundle(_options, bundle) {
      for (const name of Object.keys(bundle)) {
        if (!name.startsWith("assets/") || !COMPRESSIBLE.test(name)) continue;
        const data = readFileSync(resolve(outDir, name));
        if (data.length >= 1024) writeFileSync(resolve(outDir, `${name}.gz`), gzipSync(data, { level: 9 }));
      }
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
    include: ["server/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
  },
  // `.ts.net` lets `tailscale serve` front the dev server with https (see `scripts/harness https`); Vite would
  // otherwise answer 403 to the tailnet hostname.
  server: { port: 5173, allowedHosts: [".ts.net"] },
  plugins: lazyPlugins(() => [react(), devApi(), serviceWorker(), precompress()]),
});
