import { readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

const DIST_DIR = "dist";
const INDEX_HTML = join(DIST_DIR, "index.html");
const JS_BUDGET_BYTES = 120 * 1024;
const CSS_BUDGET_BYTES = 32 * 1024;

function bytes(n) {
  return `${(n / 1024).toFixed(1)} KiB`;
}

function distPath(assetUrl) {
  return join(DIST_DIR, assetUrl.replace(/^\//, ""));
}

function gzipSize(path) {
  return gzipSync(readFileSync(path)).length;
}

function collectAssets(html, tagPattern) {
  const assets = [];
  for (const match of html.matchAll(tagPattern)) assets.push(match[1]);
  return assets;
}

const html = readFileSync(INDEX_HTML, "utf8");
const scripts = collectAssets(html, /<script[^>]+type="module"[^>]+src="([^"]+)"/g);
const styles = collectAssets(html, /<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g);

if (scripts.length === 0) {
  throw new Error("No initial module script found in dist/index.html");
}

let failed = false;
for (const asset of scripts) {
  const path = distPath(asset);
  const size = gzipSize(path);
  console.log(`initial js ${asset}: ${bytes(size)} gzip (${bytes(statSync(path).size)} raw)`);
  if (size > JS_BUDGET_BYTES) {
    console.error(`Initial JS budget exceeded: ${bytes(size)} > ${bytes(JS_BUDGET_BYTES)}`);
    failed = true;
  }
}

for (const asset of styles) {
  const path = distPath(asset);
  const size = gzipSize(path);
  console.log(`initial css ${asset}: ${bytes(size)} gzip (${bytes(statSync(path).size)} raw)`);
  if (size > CSS_BUDGET_BYTES) {
    console.error(`Initial CSS budget exceeded: ${bytes(size)} > ${bytes(CSS_BUDGET_BYTES)}`);
    failed = true;
  }
}

if (failed) process.exit(1);
