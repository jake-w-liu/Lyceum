import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { cpSync, createReadStream, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// pdf.js decodes JBIG2/JPEG2000 images, ICC color profiles, non-embedded base
// fonts, and CID-keyed text via runtime files it fetches from *Url options —
// they ship in the pdfjs-dist package, not in our bundle. Serve them under
// /pdfjs-assets/ in dev and copy them into dist on build so every document type
// (e.g. scanned books) renders, not just LaTeX-generated PDFs.
const PDFJS_ASSET_ROUTE = "/pdfjs-assets/";
const PDFJS_ASSET_DIRS = ["wasm", "standard_fonts", "cmaps", "iccs"] as const;

function pdfjsAssetMime(file: string): string {
  if (file.endsWith(".wasm")) return "application/wasm";
  if (file.endsWith(".js")) return "text/javascript";
  if (file.endsWith(".icc")) return "application/octet-stream";
  return "application/octet-stream";
}

function pdfjsAssetsPlugin(): Plugin {
  const pdfjsDir = resolve("node_modules/pdfjs-dist");
  let outDir = "dist";
  return {
    name: "lyceum-pdfjs-assets",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? "").split("?")[0];
        if (!pathname.startsWith(PDFJS_ASSET_ROUTE)) return next();
        let rel: string;
        try {
          rel = decodeURIComponent(pathname.slice(PDFJS_ASSET_ROUTE.length));
        } catch {
          res.statusCode = 400;
          return res.end();
        }
        const file = join(pdfjsDir, rel);
        // Stay inside the package: no traversal, and only the declared dirs.
        const inPackage =
          file.startsWith(pdfjsDir + sep) &&
          (PDFJS_ASSET_DIRS as readonly string[]).includes(rel.split("/")[0]);
        let stat;
        try {
          stat = inPackage ? statSync(file) : null;
        } catch {
          stat = null;
        }
        if (!stat?.isFile()) {
          res.statusCode = 404;
          return res.end();
        }
        res.setHeader("Content-Type", pdfjsAssetMime(file));
        res.setHeader("Content-Length", stat.size);
        createReadStream(file).pipe(res);
      });
    },
    writeBundle() {
      for (const dir of PDFJS_ASSET_DIRS) {
        cpSync(join(pdfjsDir, dir), join(outDir, "pdfjs-assets", dir), {
          recursive: true,
        });
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), pdfjsAssetsPlugin()],

  // Heavy editors (Monaco/PDF.js/xterm/markdown-it) are intentionally split into
  // lazy chunks; the main bundle stays small. Raise the warning limit so those
  // expected large *lazy* chunks don't produce noise. (M12 performance pass.)
  build: {
    chunkSizeWarningLimit: 4000,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
