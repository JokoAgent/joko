const { createHash } = require("node:crypto");
const { lstat, readFile, realpath, writeFile } = require("node:fs/promises");
const { createRequire } = require("node:module");
const { join, resolve, sep } = require("node:path");
const { auditNativeRemoteDesktop } = require("./audit-packaged.cjs");

// The pinned signer signs inner Mach-O files before asking for the outer App's
// options. Refresh those final digests here, before the outer resource seal.
function createSignHook(sign, audit = auditNativeRemoteDesktop) {
  return async function signMacNativeCredentials(options) {
    if (options.platform !== "darwin" || typeof options.app !== "string" || !options.app.endsWith(".app")) {
      throw new Error("The native credential signer requires its macOS App owner.");
    }
    const appPath = resolve(options.app);
    const root = join(appPath, "Contents", "Resources", "native-remote-desktop");
    const credentialHelper = join(root, "joko-macos-remote-credentials");
    const original = options.optionsForFile;
    let sealed = false;
    await sign({
      ...options,
      optionsForFile: async file => {
        const defaults = await original?.(file);
        if (resolve(file) === credentialHelper) {
          return { ...defaults, hardenedRuntime: true,
            entitlements: resolve(__dirname, "..", "native", "remote-desktop", "credentials.entitlements.plist") };
        }
        if (resolve(file) === appPath) {
          await refreshManifest(root, audit);
          sealed = true;
        }
        return defaults;
      }
    });
    if (!sealed) throw new Error("The native credential manifest was not included in the outer App seal.");
  };
}

async function refreshManifest(root, audit) {
  const path = join(root, "manifest.json");
  const canonicalRoot = await realpath(root);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096) throw new Error("The native credential manifest is unsafe.");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  if (manifest.platform !== "darwin" || !["x64", "arm64"].includes(manifest.architecture)
    || Object.keys(manifest).sort().join(",") !== ["architecture", "captureHelper", "captureSha256",
      "credentialBundle", "credentialBundleSha256", "credentialHelper", "credentialSha256",
      "inputHelper", "inputSha256", "platform", "protocolVersion", "clipboardHelper", "clipboardSha256",
      "viewerDisplayScript", "viewerDisplaySha256", "viewerDisplayInterpreter",
      "privacyPlugin", "privacySha256", "privacyMetadata", "privacyMetadataSha256",
      "linuxCredentialDirectory", "linuxCredentialInterpreter", "linuxCredentialFiles",
      "windowsHostService", "windowsHostServiceSha256", "windowsHostAddon", "windowsHostAddonSha256", "windowsHostNodeApiVersion"].sort().join(",")
    || ["clipboardHelper", "clipboardSha256", "viewerDisplayScript", "viewerDisplaySha256", "viewerDisplayInterpreter",
      "privacyPlugin", "privacySha256", "privacyMetadata", "privacyMetadataSha256",
      "linuxCredentialDirectory", "linuxCredentialInterpreter", "linuxCredentialFiles",
      "windowsHostService", "windowsHostServiceSha256", "windowsHostAddon", "windowsHostAddonSha256", "windowsHostNodeApiVersion"].some(field => manifest[field] !== null)) {
    throw new Error("The native credential manifest does not match its App owner.");
  }
  for (const [field, name, digest] of [
    ["inputHelper", "joko-macos-remote-desktop-input", "inputSha256"],
    ["captureHelper", "joko-macos-remote-desktop-capture", "captureSha256"],
    ["credentialHelper", "joko-macos-remote-credentials", "credentialSha256"]
  ]) {
    if (manifest[field] !== name) throw new Error("The native credential helper identity is invalid.");
    const binary = join(root, name);
    const [info, canonical] = await Promise.all([lstat(binary), realpath(binary)]);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 64 || info.size > 16 * 1024 * 1024
      || !canonical.startsWith(`${canonicalRoot}${sep}`)) throw new Error("The native credential helper is unsafe.");
    manifest[digest] = createHash("sha256").update(await readFile(binary)).digest("hex");
  }
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await audit(root, "darwin", manifest.architecture);
}

module.exports = createSignHook(async options => {
  const builder = createRequire(require.resolve("electron-builder"));
  const { sign } = builder("app-builder-lib/out/codeSign/macCodeSign");
  await sign(options);
});
module.exports.createSignHook = createSignHook;
