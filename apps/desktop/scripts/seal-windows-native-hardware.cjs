const { readFile, writeFile } = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { SIMPLE_NATIVE_ARTIFACTS, readSimpleNativeManifest, refreshSimpleNativeManifest, boundedRegularFile, digest } = require("./native-helper-artifacts.cjs");
const { REMOTE_NATIVE_DIGEST_ARTIFACTS } = require("./native-helper-artifacts.cjs");

// electron-builder may sign extraResources before afterPack. Re-establish the
// audited build bytes, then invoke that same configured signer before sealing.
async function sealWindowsNativeHardware(context, architecture, audit, sourceRoot = resolve(__dirname, "..", "dist", "native-hardware")) {
  if (context.electronPlatformName !== "win32") return;
  if (!["x64", "arm64"].includes(architecture) || typeof context.packager?.signIf !== "function") {
    throw new Error("The Windows native USB seal requires its exact package owner.");
  }
  const artifact = SIMPLE_NATIVE_ARTIFACTS.hardware;
  const root = resolve(context.appOutDir, "resources", artifact.directory);
  await audit(sourceRoot, "win32", architecture);
  const manifest = await readSimpleNativeManifest(sourceRoot, artifact, "win32", architecture);
  const packaged = await readSimpleNativeManifest(root, artifact, "win32", architecture);
  if (packaged.sha256 !== manifest.sha256) throw new Error("The packaged native USB source identity changed before signing.");
  const path = join(root, manifest.helper);
  await boundedRegularFile(root, path, artifact.maximumBytes);
  const bytes = await readFile(join(sourceRoot, manifest.helper));
  if (digest(bytes) !== manifest.sha256) throw new Error("The native USB build bytes changed before signing.");
  await writeFile(path, bytes);
  await context.packager.signIf(path);
  await refreshSimpleNativeManifest(root, artifact, "win32", architecture, audit);
}

async function restoreWindowsNativeRemoteDesktop(context, audit, sourceRoot = resolve(__dirname, "..", "dist", "native-remote-desktop")) {
  if (context.electronPlatformName !== "win32") return;
  const root = resolve(context.appOutDir, "resources", "native-remote-desktop");
  const sourceManifest = join(sourceRoot, "manifest.json"), packagedManifest = join(root, "manifest.json");
  await boundedRegularFile(sourceRoot, sourceManifest, 4096);
  await boundedRegularFile(root, packagedManifest, 4096);
  const manifest = JSON.parse(await readFile(sourceManifest, "utf8"));
  if (manifest.platform !== "win32" || !["x64", "arm64"].includes(manifest.architecture)) {
    throw new Error("The native Remote Desktop build source does not match its Windows owner.");
  }
  await audit(sourceRoot, "win32", manifest.architecture);
  if (JSON.stringify(JSON.parse(await readFile(packagedManifest, "utf8"))) !== JSON.stringify(manifest)) {
    throw new Error("The packaged native Remote Desktop source identity changed before signing.");
  }
  for (const { name, digest: digestField } of REMOTE_NATIVE_DIGEST_ARTIFACTS.win32) {
    const path = join(root, name);
    await boundedRegularFile(root, path, 16 * 1024 * 1024);
    const bytes = await readFile(join(sourceRoot, name));
    if (digest(bytes) !== manifest[digestField]) throw new Error("The native Remote Desktop build bytes changed before signing.");
    await writeFile(path, bytes);
  }
  await audit(root, "win32", manifest.architecture);
}

module.exports = { sealWindowsNativeHardware, restoreWindowsNativeRemoteDesktop };
