import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function checkVersionConsistency(repoRoot = ".") {
  const versions = collectApplicationVersions(repoRoot);
  const expected = versions[0].version;
  const mismatches = versions.filter(({ version }) => version !== expected);

  if (mismatches.length > 0) {
    const details = versions
      .map(({ source, version }) => `  ${source}: ${version}`)
      .join("\n");
    throw new Error(`Application versions are inconsistent:\n${details}`);
  }

  return { version: expected, sources: versions };
}

export function collectApplicationVersions(repoRoot = ".") {
  const fromRoot = (path) => join(repoRoot, path);
  const sources = [
    ["package.json", () => readJson(fromRoot("package.json")).version],
    ["package-lock.json", () => readJson(fromRoot("package-lock.json")).version],
    [
      'package-lock.json packages[""].version',
      () => readJson(fromRoot("package-lock.json")).packages?.[""]?.version,
    ],
    [
      "src-tauri/Cargo.toml [package].version",
      () =>
        readTomlField(
          fromRoot("src-tauri/Cargo.toml"),
          "package",
          "version",
        ),
    ],
    [
      'src-tauri/Cargo.lock package "lyceum" version',
      () =>
        readCargoLockPackageVersion(
          fromRoot("src-tauri/Cargo.lock"),
          "lyceum",
        ),
    ],
    [
      "src-tauri/tauri.conf.json",
      () => readJson(fromRoot("src-tauri/tauri.conf.json")).version,
    ],
  ];

  return sources.map(([source, readVersion]) => {
    const version = readVersion();
    if (typeof version !== "string" || version.length === 0) {
      throw new Error(`Missing version in ${source}`);
    }
    return { source, version };
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readTomlField(path, sectionName, fieldName) {
  const text = readFileSync(path, "utf8");
  const section = tomlSection(text, sectionName);
  return quotedTomlField(section, fieldName, `${path} [${sectionName}]`);
}

function readCargoLockPackageVersion(path, packageName) {
  const text = readFileSync(path, "utf8");
  const packages = text.split(/^\[\[package\]\]\s*$/m).slice(1);
  const matches = packages.filter(
    (entry) => quotedTomlField(entry, "name", path) === packageName,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one package named ${JSON.stringify(packageName)} in ${path}, found ${matches.length}`,
    );
  }
  return quotedTomlField(matches[0], "version", `${path} package ${packageName}`);
}

function tomlSection(text, sectionName) {
  const header = `[${sectionName}]`;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) throw new Error(`Missing TOML section ${header}`);

  const sectionLines = lines.slice(start + 1);
  const end = sectionLines.findIndex((line) => /^\s*\[/.test(line));
  return (end < 0 ? sectionLines : sectionLines.slice(0, end)).join("\n");
}

function quotedTomlField(text, fieldName, source) {
  const escapedField = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(
    new RegExp(`^\\s*${escapedField}\\s*=\\s*"([^"]+)"`, "m"),
  );
  if (!match) throw new Error(`Missing ${fieldName} in ${source}`);
  return match[1];
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isMainModule()) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "..");
  const result = checkVersionConsistency(repoRoot);
  console.log(
    `application version ${result.version} is consistent across manifests and lockfiles`,
  );
}
