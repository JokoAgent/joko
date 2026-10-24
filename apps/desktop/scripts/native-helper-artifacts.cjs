const { createHash } = require("node:crypto");
const { lstat, readFile, realpath, writeFile } = require("node:fs/promises");
const { join, resolve } = require("node:path");

// Build, package audit and signature sealing share these exact artifact owners.
const SIMPLE_NATIVE_ARTIFACTS = Object.freeze({
  hardware: Object.freeze({ directory: "native-hardware", maximumBytes: 8 * 1024 * 1024,
    helpers: Object.freeze({ win32: "joko-windows-micro-helper.exe" }) }),
  gamepad: Object.freeze({ directory: "native-gamepad", maximumBytes: 16 * 1024 * 1024,
    helpers: Object.freeze({ darwin: "joko-macos-gamepad-helper" }) }),
  menuBar: Object.freeze({ directory: "native-menu-bar", maximumBytes: 16 * 1024 * 1024,
    helpers: Object.freeze({ darwin: "joko-macos-menu-bar-helper" }) }),
  frontmost: Object.freeze({ directory: "native-system-frontmost-input", maximumBytes: 2 * 1024 * 1024,
    helpers: Object.freeze({ win32: "joko-windows-frontmost-input.node", darwin: "joko-macos-frontmost-input.node", linux: "joko-linux-frontmost-input.node" }) })
});
const REMOTE_NATIVE_DIGEST_ARTIFACTS = Object.freeze({
  darwin: Object.freeze([
    { field: "inputHelper", name: "joko-macos-remote-desktop-input", digest: "inputSha256" },
    { field: "captureHelper", name: "joko-macos-remote-desktop-capture", digest: "captureSha256" },
    { field: "credentialHelper", name: "joko-macos-remote-credentials", digest: "credentialSha256" }
  ].map(Object.freeze)),
  win32: Object.freeze([
    { field: "inputHelper", name: "joko-windows-remote-desktop-input.exe", digest: "inputSha256" },
    { field: "windowsHostService", name: "joko-windows-remote-desktop-host.exe", digest: "windowsHostServiceSha256" },
    { field: "windowsHostAddon", name: "joko-windows-remote-desktop-host.node", digest: "windowsHostAddonSha256" }
  ].map(Object.freeze))
});

async function readSimpleNativeManifest(root, artifact, platform, architecture) {
  const path = join(root, "manifest.json");
  await boundedRegularFile(root, path, 4096);
  const manifest = JSON.parse(await readFile(path, "utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) ||
    Object.keys(manifest).sort().join(",") !== "architecture,helper,platform,protocolVersion,sha256" ||
    manifest.platform !== platform || manifest.architecture !== architecture || manifest.protocolVersion !== 1 ||
    manifest.helper !== artifact.helpers[platform] || typeof manifest.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(manifest.sha256)) {
    throw new Error("The native helper manifest does not match its package owner.");
  }
  return manifest;
}

async function boundedRegularFile(root, path, maximumBytes) {
  const [directory, info, canonicalRoot, canonical] = await Promise.all([lstat(root), lstat(path), realpath(root), realpath(path)]);
  if (!directory.isDirectory() || directory.isSymbolicLink() || canonicalRoot !== resolve(root) ||
    !info.isFile() || info.isSymbolicLink() || canonical !== resolve(path) ||
    info.size < 1 || info.size > maximumBytes) throw new Error("The native helper package file is unsafe.");
}

async function refreshSimpleNativeManifest(root, artifact, platform, architecture, audit) {
  const manifest = await readSimpleNativeManifest(root, artifact, platform, architecture);
  const path = join(root, manifest.helper);
  await boundedRegularFile(root, path, artifact.maximumBytes);
  manifest.sha256 = digest(await readFile(path));
  await writeFile(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await audit(root, platform, architecture);
}

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
module.exports = { SIMPLE_NATIVE_ARTIFACTS, REMOTE_NATIVE_DIGEST_ARTIFACTS, readSimpleNativeManifest,
  refreshSimpleNativeManifest, boundedRegularFile, digest };
