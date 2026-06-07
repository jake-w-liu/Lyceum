import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  process.exit(0);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundleRoot = path.join(repoRoot, "src-tauri", "target", "release", "bundle");
const bundleImagePattern = /^.+\.dmg$/;

for (const mount of mountedStaleImages()) {
  try {
    execFileSync("hdiutil", ["detach", mount.device], { stdio: "inherit" });
    console.log(`[cleanup-macos-bundle] detached ${mount.device}`);
  } catch (error) {
    console.warn(
      `[cleanup-macos-bundle] could not detach ${mount.device}: ${error.message}`,
    );
  }
}

for (const dir of ["macos", "dmg"]) {
  const absoluteDir = path.join(bundleRoot, dir);
  if (!existsSync(absoluteDir)) continue;
  for (const name of readdirSync(absoluteDir)) {
    if (!bundleImagePattern.test(name)) continue;
    const image = path.join(absoluteDir, name);
    rmSync(image, { force: true });
    console.log(`[cleanup-macos-bundle] removed ${path.relative(repoRoot, image)}`);
  }
}

function mountedStaleImages() {
  let info = "";
  try {
    info = execFileSync("hdiutil", ["info"], { encoding: "utf8" });
  } catch {
    return [];
  }

  const mounts = [];
  let currentImage = null;
  let currentDevices = [];

  const flush = () => {
    if (!currentImage) return;
    const name = path.basename(currentImage);
    if (
      currentImage.startsWith(bundleRoot) &&
      bundleImagePattern.test(name) &&
      currentDevices.length > 0
    ) {
      mounts.push({
        image: currentImage,
        device: shortestDevice(currentDevices),
      });
    }
  };

  for (const line of info.split(/\r?\n/)) {
    const imageMatch = line.match(/^image-path\s*:\s*(.+)$/);
    if (imageMatch) {
      flush();
      currentImage = imageMatch[1].trim();
      currentDevices = [];
      continue;
    }

    if (currentImage) {
      const deviceMatch = line.match(/^(\/dev\/disk\d+)/);
      if (deviceMatch) currentDevices.push(deviceMatch[1]);
    }
  }
  flush();

  return mounts;
}

function shortestDevice(devices) {
  return Array.from(new Set(devices)).sort((a, b) => a.length - b.length)[0];
}
