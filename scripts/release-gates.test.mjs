import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { checkBundleSize } from "./check-bundle-size.mjs";
import { checkVersionConsistency } from "./check-version-consistency.mjs";
import { isPathInside } from "./path-boundary.mjs";

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("bundle-size release gate", () => {
  it("applies the JavaScript budget to aggregate initial bytes", () => {
    const distDir = temporaryDirectory("bundle-total");
    mkdirSync(join(distDir, "assets"), { recursive: true });
    writeFileSync(
      join(distDir, "index.html"),
      '<script src="/assets/a.js" type="module"></script>\n' +
        '<script type="module" src="/assets/b.js"></script>',
    );
    writeFileSync(join(distDir, "assets/a.js"), deterministicBytes(80 * 1024));
    writeFileSync(join(distDir, "assets/b.js"), deterministicBytes(80 * 1024));

    const result = checkBundleSize({
      distDir,
      jsBudgetBytes: 120 * 1024,
      log() {},
      error() {},
    });

    assert.equal(result.failed, true);
    assert.ok(result.jsSize.gzip > 120 * 1024);
  });

  it("counts unique modulepreloads and accepts either attribute order", () => {
    const distDir = temporaryDirectory("bundle-preloads");
    mkdirSync(join(distDir, "assets"), { recursive: true });
    writeFileSync(
      join(distDir, "index.html"),
      '<script src="/assets/entry.js" type="module"></script>\n' +
        "<link href='/assets/shared.js' rel='modulepreload'>\n" +
        "<link rel='modulepreload' href='/assets/shared.js'>",
    );
    writeFileSync(join(distDir, "assets/entry.js"), deterministicBytes(1024));
    writeFileSync(join(distDir, "assets/shared.js"), deterministicBytes(2048));

    const result = checkBundleSize({
      distDir,
      jsBudgetBytes: 1024 * 1024,
      log() {},
      error() {},
    });

    assert.deepEqual(result.scripts, ["/assets/entry.js", "/assets/shared.js"]);
    assert.equal(result.failed, false);
  });

  it("rejects absolute and protocol-relative initial asset URLs", () => {
    for (const assetUrl of [
      "https://bundle.invalid/assets/entry.js",
      "//bundle.invalid/assets/entry.js",
      String.raw`\\bundle.invalid\assets\entry.js`,
      "https&#58;//bundle.invalid/assets/entry.js",
    ]) {
      const distDir = temporaryDirectory("bundle-external-url");
      mkdirSync(join(distDir, "assets"), { recursive: true });
      writeFileSync(
        join(distDir, "index.html"),
        `<script type="module" src="${assetUrl}"></script>`,
      );
      // This local file proves the gate rejects the URL itself rather than
      // accidentally resolving the sentinel host back into dist/.
      writeFileSync(join(distDir, "assets/entry.js"), "local decoy");
      writeFileSync(join(distDir, "https&"), "entity-reference decoy");

      assert.throws(
        () => checkBundleSize({ distDir, log() {}, error() {} }),
        /Initial asset must be local/,
      );
    }
  });

  it("rejects a relative asset resolved through an external base URL", () => {
    for (const baseUrl of [
      "https://external.invalid/",
      "//bundle.invalid/",
    ]) {
      const distDir = temporaryDirectory("bundle-external-base");
      writeFileSync(
        join(distDir, "index.html"),
        `<base href="${baseUrl}">\n` +
          '<script type="module" src="entry.js"></script>',
      );
      writeFileSync(join(distDir, "entry.js"), "local decoy");

      assert.throws(
        () => checkBundleSize({ distDir, log() {}, error() {} }),
        /Initial asset must be local/,
      );
    }
  });

  it("resolves relative initial assets through a local base path", () => {
    const distDir = temporaryDirectory("bundle-local-base");
    mkdirSync(join(distDir, "nested"), { recursive: true });
    writeFileSync(
      join(distDir, "index.html"),
      '<base href="/nested/">\n' +
        '<script type="module" src="entry.js"></script>',
    );
    writeFileSync(join(distDir, "nested/entry.js"), "local asset");

    const result = checkBundleSize({ distDir, log() {}, error() {} });

    assert.deepEqual(result.scripts, ["/nested/entry.js"]);
    assert.equal(result.failed, false);
  });

  it("applies the CSS budget to aggregate initial bytes", () => {
    const distDir = temporaryDirectory("bundle-css-total");
    mkdirSync(join(distDir, "assets"), { recursive: true });
    writeFileSync(
      join(distDir, "index.html"),
      '<script type="module" src="/assets/entry.js"></script>\n' +
        '<link rel="stylesheet" href="/assets/a.css">\n' +
        '<link href="/assets/b.css" rel="stylesheet">',
    );
    writeFileSync(join(distDir, "assets/entry.js"), deterministicBytes(1024));
    writeFileSync(join(distDir, "assets/a.css"), deterministicBytes(24 * 1024));
    writeFileSync(join(distDir, "assets/b.css"), deterministicBytes(24 * 1024));

    const result = checkBundleSize({
      distDir,
      cssBudgetBytes: 32 * 1024,
      log() {},
      error() {},
    });

    assert.equal(result.failed, true);
    assert.ok(result.cssSize.gzip > 32 * 1024);
  });
});

describe("version-consistency release gate", () => {
  it("accepts an application version shared by every source", () => {
    const root = versionFixture("1.2.3");
    const result = checkVersionConsistency(root);
    assert.equal(result.version, "1.2.3");
    assert.equal(result.sources.length, 6);
  });

  it("reports every source when one version differs", () => {
    const root = versionFixture("1.2.3", { tauriVersion: "1.2.2" });
    assert.throws(
      () => checkVersionConsistency(root),
      /src-tauri\/tauri\.conf\.json: 1\.2\.2/,
    );
  });
});

describe("bundle cleanup path boundary", () => {
  it("accepts descendants without accepting sibling prefix collisions", () => {
    const targetRoot = join(tmpdir(), "target");
    const root = join(targetRoot, "bundle");
    assert.equal(isPathInside(root, join(root, "dmg", "Lyceum.dmg")), true);
    assert.equal(
      isPathInside(root, join(targetRoot, "bundle-backup", "Lyceum.dmg")),
      false,
    );
    assert.equal(isPathInside(root, root), false);
  });
});

describe("Node toolchain boundary", () => {
  it("pins a Node version accepted by the locked build dependencies", () => {
    const packageJson = readJson(new URL("../package.json", import.meta.url));
    const packageLock = readJson(
      new URL("../package-lock.json", import.meta.url),
    );
    const pinnedNode = readFileSync(
      new URL("../.nvmrc", import.meta.url),
      "utf8",
    ).trim();
    const vitePackage = readJson(
      new URL("../node_modules/vite/package.json", import.meta.url),
    );
    const pdfjsPackage = readJson(
      new URL("../node_modules/pdfjs-dist/package.json", import.meta.url),
    );

    assert.equal(
      packageLock.packages[""].engines.node,
      packageJson.engines.node,
    );
    assert.equal(packageJson.engines.node, `>=${pinnedNode}`);
    assert.equal(satisfiesEngine(pinnedNode, vitePackage.engines.node), true);
    assert.equal(satisfiesEngine(pinnedNode, pdfjsPackage.engines.node), true);
  });
});

describe("PDF.js WebKit rendering boundary", () => {
  it("locks a release with the Safari soft-mask fallback", () => {
    const packageLock = readJson(
      new URL("../package-lock.json", import.meta.url),
    );
    const pdfjsPackage = readJson(
      new URL("../node_modules/pdfjs-dist/package.json", import.meta.url),
    );
    const lockedVersion =
      packageLock.packages["node_modules/pdfjs-dist"].version;
    const viewerCss = readFileSync(
      new URL("../src/styles/global.css", import.meta.url),
      "utf8",
    );

    assert.equal(pdfjsPackage.version, lockedVersion);
    // PDF.js 6.0.227 is the first release containing upstream b823271,
    // the pixel-buffer SMask fallback used when Safari lacks ctx.filter.
    assert.ok(compareVersions(lockedVersion, "6.0.227") >= 0);
    assert.match(viewerCss, /font-size:\s*calc\([^;]*--font-height/);
    assert.match(viewerCss, /scaleX\(var\(--scale-x\)\)/);
    assert.match(viewerCss, /\.pdf-text-layer \.markedContent\s*{\s*display:\s*contents/);
  });
});

describe("test command routing", () => {
  it("keeps focused Vitest arguments separate from the full release gates", () => {
    const packageJson = readJson(new URL("../package.json", import.meta.url));
    assert.equal(packageJson.scripts.test, "vitest run");
    assert.equal(
      packageJson.scripts["test:all"],
      "npm test && npm run test:scripts",
    );
    assert.match(packageJson.scripts.check, /(?:^|\s)npm run test:all(?:\s|$)/);

    for (const workflow of [
      "../.github/workflows/ci.yml",
      "../.github/workflows/release.yml",
    ]) {
      const source = readFileSync(new URL(workflow, import.meta.url), "utf8");
      assert.match(source, /^\s*- run: npm run test:all\s*$/m);
      assert.doesNotMatch(source, /^\s*- run: npm test\s*$/m);
    }
  });
});

describe("GitHub Actions determinism", () => {
  it("pins actions, runners, toolchains, and locked Rust gates", () => {
    for (const workflow of [
      "../.github/workflows/ci.yml",
      "../.github/workflows/release.yml",
    ]) {
      const source = readFileSync(new URL(workflow, import.meta.url), "utf8");
      assert.doesNotMatch(source, /runs-on:\s+[^\n]*latest/);
      assert.doesNotMatch(source, /uses:\s+[^\s@]+@v\d/);
      assert.doesNotMatch(source, /dtolnay\/rust-toolchain@stable/);
      assert.match(source, /cargo clippy --locked --all-targets -- -D warnings/);
      assert.match(source, /cargo test --locked -- --test-threads=1/);
    }
  });

  it("keeps the release Windows resource compiler setup aligned with CI", () => {
    const source = readFileSync(
      new URL("../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );
    assert.match(source, /Install LLVM for Windows resource compilation/);
    assert.match(source, /RC_x86_64_pc_windows_msvc/);
    assert.match(source, /CI_SKIP_TAURI_BUILD/);
  });
});

function temporaryDirectory(name) {
  const root = mkdtempSync(join(tmpdir(), `lyceum-${name}-`));
  temporaryRoots.push(root);
  return root;
}

function readJson(url) {
  return JSON.parse(readFileSync(url, "utf8"));
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

function satisfiesEngine(version, range) {
  return range.split("||").some((alternative) =>
    alternative
      .trim()
      .split(/\s+/)
      .every((comparator) => satisfiesComparator(version, comparator)),
  );
}

function satisfiesComparator(version, comparator) {
  const match = /^(\^|>=|>|<=|<|=)?(\d+(?:\.\d+){0,2})$/.exec(comparator);
  assert.ok(match, `Unsupported Node engine comparator: ${comparator}`);
  const [, operator = "=", boundary] = match;
  const comparison = compareVersions(version, boundary);

  switch (operator) {
    case ">=":
      return comparison >= 0;
    case ">":
      return comparison > 0;
    case "<=":
      return comparison <= 0;
    case "<":
      return comparison < 0;
    case "=":
      return comparison === 0;
    case "^": {
      const [major = 0, minor = 0, patch = 0] = boundary
        .split(".")
        .map(Number);
      const upper =
        major > 0
          ? `${major + 1}.0.0`
          : minor > 0
            ? `0.${minor + 1}.0`
            : `0.0.${patch + 1}`;
      return comparison >= 0 && compareVersions(version, upper) < 0;
    }
    default:
      return false;
  }
}

function deterministicBytes(length) {
  const bytes = Buffer.alloc(length);
  let state = 1;
  for (let index = 0; index < bytes.length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

function versionFixture(version, { tauriVersion = version } = {}) {
  const root = temporaryDirectory("versions");
  mkdirSync(join(root, "src-tauri"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify({ version, packages: { "": { version } } }),
  );
  writeFileSync(
    join(root, "src-tauri/Cargo.toml"),
    `[package]\nname = "lyceum"\nversion = "${version}"\n`,
  );
  writeFileSync(
    join(root, "src-tauri/Cargo.lock"),
    `version = 4\n\n[[package]]\nname = "lyceum"\nversion = "${version}"\n`,
  );
  writeFileSync(
    join(root, "src-tauri/tauri.conf.json"),
    JSON.stringify({ version: tauriVersion }),
  );
  return root;
}
