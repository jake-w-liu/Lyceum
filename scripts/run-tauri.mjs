import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };

if (process.platform === "darwin") {
  env.PATH = [
    path.join(repoRoot, "scripts", "macos-shims"),
    env.PATH ?? "",
  ].join(path.delimiter);
}

const command = process.platform === "win32" ? "tauri.cmd" : "tauri";
const child = spawn(command, process.argv.slice(2), {
  cwd: repoRoot,
  env,
  shell: process.platform === "win32",
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
