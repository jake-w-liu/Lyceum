import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { JSDOM } from "jsdom";

const JS_BUDGET_BYTES = 120 * 1024;
const CSS_BUDGET_BYTES = 32 * 1024;
const BUNDLE_ORIGIN = "https://bundle.invalid";
const BUNDLE_DOCUMENT_URL = `${BUNDLE_ORIGIN}/index.html`;

export function checkBundleSize({
  distDir = "dist",
  jsBudgetBytes = JS_BUDGET_BYTES,
  cssBudgetBytes = CSS_BUDGET_BYTES,
  log = console.log,
  error = console.error,
} = {}) {
  const indexHtml = join(distDir, "index.html");
  const html = readFileSync(indexHtml, "utf8");
  const { scripts, styles } = collectInitialAssets(html);

  if (scripts.length === 0) {
    throw new Error("No initial module script or modulepreload found in dist/index.html");
  }

  const jsSize = reportAssets("js", scripts, distDir, log);
  const cssSize = reportAssets("css", styles, distDir, log);
  let failed = false;

  log(`initial js total: ${bytes(jsSize.gzip)} gzip (${bytes(jsSize.raw)} raw)`);
  if (jsSize.gzip > jsBudgetBytes) {
    error(
      `Initial JS budget exceeded: ${bytes(jsSize.gzip)} > ${bytes(jsBudgetBytes)}`,
    );
    failed = true;
  }

  log(`initial css total: ${bytes(cssSize.gzip)} gzip (${bytes(cssSize.raw)} raw)`);
  if (cssSize.gzip > cssBudgetBytes) {
    error(
      `Initial CSS budget exceeded: ${bytes(cssSize.gzip)} > ${bytes(cssBudgetBytes)}`,
    );
    failed = true;
  }

  return { failed, jsSize, cssSize, scripts, styles };
}

function bytes(n) {
  return `${(n / 1024).toFixed(1)} KiB`;
}

function reportAssets(kind, assets, distDir, log) {
  let gzip = 0;
  let raw = 0;
  for (const asset of assets) {
    const path = distPath(distDir, asset);
    const assetGzip = gzipSync(readFileSync(path)).length;
    const assetRaw = statSync(path).size;
    gzip += assetGzip;
    raw += assetRaw;
    log(`initial ${kind} ${asset}: ${bytes(assetGzip)} gzip (${bytes(assetRaw)} raw)`);
  }
  return { gzip, raw };
}

function distPath(distDir, assetUrl) {
  const reference = assetUrl.trim();
  // `bundle.invalid` is only a resolution sentinel. Without rejecting absolute
  // references first, a literal https://bundle.invalid/... (or its // form)
  // has the same origin as the sentinel and is incorrectly treated as a local
  // dist asset even though the browser would fetch it from the network.
  if (
    /^[a-z][a-z\d+.-]*:/i.test(reference) ||
    /^[\\/]{2}/.test(reference)
  ) {
    throw new Error(`Initial asset must be local: ${assetUrl}`);
  }

  const url = new URL(reference, BUNDLE_DOCUMENT_URL);
  if (url.origin !== BUNDLE_ORIGIN) {
    throw new Error(`Initial asset must be local: ${assetUrl}`);
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (cause) {
    throw new Error(`Initial asset has invalid URL encoding: ${assetUrl}`, { cause });
  }

  const root = resolve(distDir);
  const path = resolve(root, pathname.replace(/^\/+/, ""));
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new Error(`Initial asset escapes dist/: ${assetUrl}`);
  }
  return path;
}

function collectInitialAssets(html) {
  // Parse as HTML rather than matching source text. In particular, browsers
  // decode character references in URL attributes before URL resolution:
  // `https&#58;//host/...` is external even though the raw source has no colon.
  // Parsing also ignores commented-out tags and handles quoted `>` characters.
  const dom = new JSDOM(html, { url: BUNDLE_DOCUMENT_URL });
  try {
    const { document } = dom.window;
    const baseElement = document.querySelector("base[href]");
    const baseReference = baseElement?.getAttribute("href");
    if (baseReference?.trim()) {
      // Validate the effective base's decoded raw form as well. An explicit
      // base pointing at the sentinel host must not inherit the sentinel's
      // trusted-local meaning merely because its resolved origin matches.
      resolveLocalAssetReference(baseReference, BUNDLE_DOCUMENT_URL);
    }
    const scripts = unique([
      ...collectElementAssets(document, "script[src]", "src", "type", "module"),
      ...collectElementAssets(
        document,
        "link[href]",
        "href",
        "rel",
        "modulepreload",
      ),
    ]);
    const styles = unique(
      collectElementAssets(
        document,
        "link[href]",
        "href",
        "rel",
        "stylesheet",
      ),
    );
    return { scripts, styles };
  } finally {
    dom.window.close();
  }
}

function collectElementAssets(
  document,
  selector,
  urlAttribute,
  tokenAttribute,
  expectedToken,
) {
  const assets = [];
  for (const element of document.querySelectorAll(selector)) {
    const tokens = (element.getAttribute(tokenAttribute) ?? "")
      .toLowerCase()
      .split(/\s+/);
    if (!tokens.includes(expectedToken)) continue;
    const asset = element.getAttribute(urlAttribute);
    if (asset) assets.push(resolveLocalAssetReference(asset, document.baseURI));
  }
  return assets;
}

function resolveLocalAssetReference(assetUrl, baseUrl) {
  const reference = assetUrl.trim();
  // Check the decoded raw attribute before resolution too: an explicit URL to
  // the sentinel origin is still external browser input, not a local reference.
  if (
    /^[a-z][a-z\d+.-]*:/i.test(reference) ||
    /^[\\/]{2}/.test(reference)
  ) {
    throw new Error(`Initial asset must be local: ${assetUrl}`);
  }
  const resolved = new URL(reference, baseUrl);
  if (resolved.origin !== BUNDLE_ORIGIN) {
    throw new Error(`Initial asset must be local: ${assetUrl}`);
  }
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

function unique(values) {
  return [...new Set(values)];
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isMainModule()) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "..");
  const result = checkBundleSize({ distDir: join(repoRoot, "dist") });
  if (result.failed) process.exitCode = 1;
}
