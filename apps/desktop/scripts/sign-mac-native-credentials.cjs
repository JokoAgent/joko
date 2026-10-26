const { createHash } = require("node:crypto");
const { lstat, readFile, realpath, writeFile } = require("node:fs/promises");
const { createRequire } = require("node:module");
const { join, resolve, sep } = require("node:path");
const { auditNativeRemoteDesktop, auditNativeGamepad, auditNativeMenuBar, auditNativeSystemFrontmostInput } = require("./audit-packaged.cjs");
const { SIMPLE_NATIVE_ARTIFACTS, REMOTE_NATIVE_DIGEST_ARTIFACTS, boundedRegularFile, refreshSimpleNativeManifest } = require("./native-helper-artifacts.cjs");
const simpleAudits = { gamepad: auditNativeGamepad, menuBar: auditNativeMenuBar, frontmost: auditNativeSystemFrontmostInput };

// The pinned signer signs inner Mach-O files before asking for the outer App's
// options. Refresh those final digests here, before the outer resource seal.
function createSignHook(sign, audit = auditNativeRemoteDesktop) {
  return async function signMacNativeCredentials(options) {
    if (options.platform !== "darwin" || typeof options.app !== "string" || !options.app.endsWith(".app")) {
      throw new Error("The native credential signer requires its macOS App owner.");
    }
    const appPath = resolve(options.app);
    const resourcesRoot = join(appPath, "Contents", "Resources");
    const root = join(resourcesRoot, "native-remote-desktop");
    const credentialHelper = join(root, "joko-macos-remote-credentials");
    await boundedRegularFile(root, join(root, "manifest.json"), 4096);
    const { architecture } = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    if (!["x64", "arm64"].includes(architecture)) throw new Error("The native helper architecture is invalid.");
    await audit(root, "darwin", architecture);
    for (const [kind, auditSimple] of Object.entries(simpleAudits)) {
      await auditSimple(join(resourcesRoot, SIMPLE_NATIVE_ARTIFACTS[kind].directory), "darwin", architecture);
    }
    const preservedInputs = await selectedPinggySigningInputs(resourcesRoot, architecture);
    const original = options.optionsForFile;
    let sealed = false;
    await sign({
      ...options,
      ...(preservedInputs.size === 0 ? {} : { ignore: file => preservedInputs.has(resolve(file)) || ignoredBy(options.ignore, file) }),
      optionsForFile: async file => {
        const defaults = await original?.(file);
        if (resolve(file) === credentialHelper) {
          return { ...defaults, hardenedRuntime: true,
            entitlements: resolve(__dirname, "..", "native", "remote-desktop", "credentials.entitlements.plist") };
        }
        if (resolve(file) === appPath) {
          for (const [path, expected] of preservedInputs) {
            await boundedRegularFile(resourcesRoot, path, 268_435_456);
            if (createHash("sha256").update(await readFile(path)).digest("hex") !== expected) {
              throw new Error("The selected Pinggy runtime changed before the outer App seal.");
            }
          }
          await refreshManifest(root, audit);
          for (const [kind, auditSimple] of Object.entries(simpleAudits)) {
            const artifact = SIMPLE_NATIVE_ARTIFACTS[kind];
            await refreshSimpleNativeManifest(join(resourcesRoot, artifact.directory), artifact, "darwin", architecture, auditSimple);
          }
          sealed = true;
        }
        return defaults;
      }
    });
    if (!sealed) throw new Error("The native credential manifest was not included in the outer App seal.");
  };
}

function ignoredBy(ignore, file) {
  return (Array.isArray(ignore) ? ignore : [ignore]).some(value => typeof value === "function" ? value(file)
    : value !== undefined && value !== null && file.match(value) !== null);
}

/** These inputs run in the independent official Node process. Re-signing them
 * would invalidate their pinned preparation hashes; the outer App is still sealed. */
async function selectedPinggySigningInputs(resourcesRoot, architecture) {
  const root = join(resourcesRoot, "orchestrator-runtime", "dist", "linkspan-runtime"), path = join(root, "selected.json");
  const info = await lstat(path).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  const preserved = new Map();
  if (info === undefined) return preserved;
  await boundedRegularFile(root, path, 65_536);
  const selected = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(selected.backends)) throw new Error("The selected Linkspan signing receipt is invalid.");
  if (!selected.backends.includes("pinggy-sdk")) return preserved;
  const target = `darwin-${architecture}`, sdk = selected.prepared?.pinggy, node = sdk?.nodeRuntime;
  const sdkDirectory = `pinggy/pinggy-0.5.3/${target}/node-137`, executable = `pinggy/node-v24.16.0/${target}/node`;
  if (selected.target !== target || sdk?.target !== target || sdk?.version !== "0.5.3" || sdk?.nodeAbi !== "137" || sdk?.sdkDirectory !== sdkDirectory
    || node?.target !== target || node?.version !== "24.16.0" || node?.nodeAbi !== "137" || node?.executable !== executable
    || !/^[a-f0-9]{64}$/u.test(node?.sha256 ?? "") || !/^[a-f0-9]{64}$/u.test(node?.archiveSha256 ?? "")) {
    throw new Error("The selected Pinggy signing identity is invalid.");
  }
  const preserve = async (relativePath, expected, maximumBytes) => {
    const file = join(root, relativePath);
    await boundedRegularFile(root, file, maximumBytes);
    if (createHash("sha256").update(await readFile(file)).digest("hex") !== expected) throw new Error("The selected Pinggy signing input was modified.");
    if (preserved.has(file)) throw new Error("The selected Pinggy signing receipt repeats an input.");
    preserved.set(file, expected);
  };
  await preserve(executable, node.sha256, 268_435_456);
  await boundedRegularFile(root, join(root, executable, "..", "LICENSE"), 2_097_152);
  await boundedRegularFile(root, join(root, sdkDirectory, "LICENSE.pinggy-sdk"), 2_097_152);
  await boundedRegularFile(root, join(root, sdkDirectory, "dist", "index.js"), 16_777_216);
  const receiptPath = join(root, sdkDirectory, "prepared.json");
  await boundedRegularFile(root, receiptPath, 65_536);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")), files = receipt.archive?.files;
  if (receipt.version !== "0.5.3" || receipt.target !== target || receipt.nodeAbi !== "137" || receipt.archive?.target !== target || receipt.archive?.abi !== "137"
    || !Array.isArray(files) || files.length < 1 || files.length > 32 || !files.some(file => file.path === "lib/addon.node")) {
    throw new Error("The selected Pinggy SDK signing receipt is invalid.");
  }
  for (const file of files) {
    if (!/^lib\/[a-zA-Z0-9_.-]+\.(?:node|dylib)$/u.test(file.path ?? "") || !/^[a-f0-9]{64}$/u.test(file.sha256 ?? "")
      || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 134_217_728) throw new Error("The selected Pinggy SDK signing input is invalid.");
    await preserve(`${sdkDirectory}/${file.path}`, file.sha256, file.bytes);
  }
  return preserved;
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
  for (const { field, name, digest } of REMOTE_NATIVE_DIGEST_ARTIFACTS.darwin) {
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
