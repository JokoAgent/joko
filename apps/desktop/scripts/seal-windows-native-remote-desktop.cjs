const { createHash } = require("node:crypto");
const { readFile, writeFile } = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { auditNativeRemoteDesktop } = require("./audit-packaged.cjs");
const { REMOTE_NATIVE_DIGEST_ARTIFACTS } = require("./native-helper-artifacts.cjs");

// afterPack creates these extra resources. Sign them through the same configured
// Windows signer as Main before committing their final packaged byte identities.
function createSealHook(audit = auditNativeRemoteDesktop) {
  return async function sealWindowsNativeRemoteDesktop(context) {
    if (context.electronPlatformName !== "win32") return;
    const architecture = context.arch === 1 ? "x64" : context.arch === 3 ? "arm64" : null;
    if (architecture === null || typeof context.appOutDir !== "string"
      || typeof context.packager?.signIf !== "function") {
      throw new Error("The Windows native Remote Desktop seal requires its exact package owner.");
    }
    const root = resolve(context.appOutDir, "resources", "native-remote-desktop");
    await audit(root, "win32", architecture);
    const manifestPath = join(root, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    for (const { name } of REMOTE_NATIVE_DIGEST_ARTIFACTS.win32.filter(artifact => artifact.name.endsWith(".exe"))) {
      await context.packager.signIf(join(root, name));
    }
    for (const { name, digest } of REMOTE_NATIVE_DIGEST_ARTIFACTS.win32) {
      manifest[digest] = createHash("sha256").update(await readFile(join(root, name))).digest("hex");
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await audit(root, "win32", architecture);
  };
}

module.exports = createSealHook();
module.exports.createSealHook = createSealHook;
