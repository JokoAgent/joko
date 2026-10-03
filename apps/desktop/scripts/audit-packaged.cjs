const { createHash } = require("node:crypto");
const { lstat, readFile, readdir, realpath } = require("node:fs/promises");
const { basename, extname, isAbsolute, join, relative, resolve, sep } = require("node:path");
const { pathToFileURL } = require("node:url");

const FORBIDDEN_SEGMENTS = new Set([
  "__tests__",
  "coverage",
  "fixtures",
  "test",
  "tests",
  "workspace"
]);
const FORBIDDEN_EXTENSIONS = new Set([
  ".cts",
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".cxx",
  ".db",
  ".fs",
  ".fsx",
  ".go",
  ".h",
  ".hh",
  ".hpp",
  ".hxx",
  ".java",
  ".jsdoc",
  ".keep",
  ".kt",
  ".kts",
  ".log",
  ".map",
  ".m",
  ".mm",
  ".mts",
  ".py",
  ".pyi",
  ".proto",
  ".rb",
  ".rs",
  ".scala",
  ".swift",
  ".ts",
  ".tsbuildinfo",
  ".tsx"
]);
const MAXIMUM_RUNTIME_FILES = 80_000;
const MAXIMUM_RUNTIME_BYTES = 2 * 1024 * 1024 * 1024;
const DEDICATED_HARDWARE_SDK_DIRECTORY = "dedicated-hardware-sdk";
const DEDICATED_HARDWARE_SDK_LOCK = "joko-dedicated-hardware-sdk.lock.json";
const DEDICATED_HARDWARE_SDK_PACKAGE = "@worklouder/device-kit-oai";
const MAXIMUM_DEDICATED_HARDWARE_SDK_LOCK_BYTES = 64 * 1024;
const MAXIMUM_DEDICATED_HARDWARE_SDK_HANDSHAKE_BYTES = 72 * 1024;
const MAXIMUM_DEDICATED_HARDWARE_KEYMAP_BACKUP_PATH_CODE_UNITS = 4_096;
const DEDICATED_HARDWARE_SDK_DIRECTORY_DIGEST_DOMAIN = "joko-dedicated-hardware-sdk-directory-v1";
const AUDITED_ELECTRON_VERSION = "43.6.0";
const AUDITED_ELECTRON_MODULES_ABI = 148;
const AUDITED_NODE_API_VERSION = 10;

// Deliberately empty until an exact artifact has independent installation and
// redistribution approval. A self-authored lock is not proof of that grant.
const APPROVED_DEDICATED_HARDWARE_SDK_ARTIFACTS = Object.freeze([]);

module.exports = async function auditPackaged(context) {
  const {
    ORCHESTRATOR_BUNDLED_NPM_RUNTIME,
    ORCHESTRATOR_RUNTIME_PACKAGES,
    auditClaudeSessionRuntimeAssets,
    auditTerminalRuntimeAssets,
    sqliteVecElectronBuilderArchitecture,
    sqliteVecRuntimeTarget
  } = await import(
    pathToFileURL(resolve(__dirname, "..", "dist", "runtime-staging.js")).href
  );
  const targetArch = sqliteVecElectronBuilderArchitecture(context.arch);
  const sqliteVecTarget = sqliteVecRuntimeTarget(context.electronPlatformName, targetArch);
  const productFilename = context.packager.appInfo.productFilename;
  const resourcesRoot = context.electronPlatformName === "darwin"
    ? resolve(context.appOutDir, `${productFilename}.app`, "Contents", "Resources")
    : resolve(context.appOutDir, "resources");
  const applicationRoot = resolve(resourcesRoot, "app");
  const runtimeRoot = resolve(resourcesRoot, "orchestrator-runtime");
  const nativeVoiceShortcutRoot = resolve(resourcesRoot, "native-voice-shortcut");
  const nativeSimulatorHidRoot = resolve(resourcesRoot, "native-simulator-hid");
  const nativeSimulatorH264Root = resolve(resourcesRoot, "native-simulator-h264");
  if (context.packager.config.electronVersion !== AUDITED_ELECTRON_VERSION) {
    throw new Error("The dedicated hardware SDK ABI audit is not pinned to the packaged Electron version.");
  }
  const dedicatedHardwareSdk = await auditDedicatedHardwareSdkDirectory(
    resolve(resourcesRoot, DEDICATED_HARDWARE_SDK_DIRECTORY),
    APPROVED_DEDICATED_HARDWARE_SDK_ARTIFACTS,
    {
      platform: context.electronPlatformName,
      architecture: targetArch,
      electronModulesAbi: AUDITED_ELECTRON_MODULES_ABI,
      nodeApiVersion: AUDITED_NODE_API_VERSION
    }
  );

  const updaterConfigPath = resolve(resourcesRoot, "app-update.yml");
  await assertCanonicalRegularFile(updaterConfigPath, "The packaged application is missing app-update.yml.");
  const updaterConfig = await readFile(updaterConfigPath, "utf8");
  const normalizedUpdaterConfig = updaterConfig.replaceAll("\r\n", "\n");
  if (normalizedUpdaterConfig.includes("\r") || normalizedUpdaterConfig !== "updaterCacheDirName: joko-updater\n") {
    throw new Error("The packaged app-update.yml must contain only the audited updater cache name.");
  }
  await auditNativeTaskStatusSounds(resolve(resourcesRoot, "native-task-status-sounds"));
  await auditWdaSourceAssets(resolve(resourcesRoot, "ios-simulator"), context.electronPlatformName);
  const nativeVoiceShortcut = await auditNativeVoiceShortcut(
    nativeVoiceShortcutRoot,
    context.electronPlatformName,
    targetArch
  );
  await auditNativeSystemFrontmostInput(resolve(resourcesRoot, "native-system-frontmost-input"),
    context.electronPlatformName, targetArch);
  await auditNativeSimulatorHelper(nativeSimulatorHidRoot, context.electronPlatformName,
    targetArch, "Simulator HID", "joko-simulator-hid");
  await auditNativeSimulatorHelper(nativeSimulatorH264Root, context.electronPlatformName,
    targetArch, "Simulator H.264", "joko-simulator-h264");

  const applicationEntries = await readdir(applicationRoot, { withFileTypes: true });
  const unexpectedApplicationRoot = applicationEntries.find((entry) =>
    !["dist", "node_modules", "package.json"].includes(entry.name)
  );
  if (unexpectedApplicationRoot !== undefined) {
    throw new Error(`Unexpected packaged application input: ${unexpectedApplicationRoot.name}`);
  }
  const applicationAudit = await auditRegularDistributionTree(applicationRoot, "packaged application", {
    forbidSourceDirectories: true,
    allowNodeModulesSourceDirectories: true
  });
  for (const required of [
    "package.json",
    join("dist", "main.js"),
    join("dist", "preload.cjs"),
    join("dist", "runtime-process-monitor-preload.cjs"),
    join("dist", "web", "index.html"),
    join("dist", "dedicated-hardware", "utility-entry.js")
  ]) {
    await assertCanonicalRegularFile(resolve(applicationRoot, required), `The packaged application is missing ${required}.`);
  }
  await auditElectronUpdaterRuntime(applicationRoot);
  await auditDesktopUpdateControlRuntime(applicationRoot);
  if (await lstat(resolve(applicationRoot, "dist", "orchestrator-runtime")).catch(() => undefined) !== undefined) {
    throw new Error("The managed Orchestrator runtime must not be embedded in the application tree.");
  }
  const runtimeAudit = await auditRegularDistributionTree(runtimeRoot, "packaged Orchestrator runtime", {
    forbidSourceDirectories: false
  });
  for (const descriptor of ORCHESTRATOR_RUNTIME_PACKAGES) {
    const manifestPath = descriptor.candidatePath === "."
      ? "package.json"
      : join(descriptor.candidatePath, "package.json");
    await assertCanonicalRegularFile(
      resolve(runtimeRoot, manifestPath),
      `The packaged Orchestrator runtime is missing ${descriptor.name}.`
    );
  }
  for (const required of [
    join("dist", "main.js"),
    join("node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
    join("node_modules", "extract-zip", "package.json"),
    join("node_modules", "fastify", "package.json"),
    join("node_modules", "sharp", "package.json"),
    join("node_modules", "undici", "package.json"),
    join("node_modules", "sqlite-vec", "package.json"),
    ORCHESTRATOR_BUNDLED_NPM_RUNTIME.manifestRelativePath,
    ORCHESTRATOR_BUNDLED_NPM_RUNTIME.cliRelativePath
  ]) {
    await assertCanonicalRegularFile(resolve(runtimeRoot, required), `The packaged Orchestrator runtime is missing ${required}.`);
  }
  const npmRuntime = await auditBundledNpmRuntime(runtimeRoot, ORCHESTRATOR_BUNDLED_NPM_RUNTIME);
  const sqliteVec = await auditSqliteVecRuntime(runtimeRoot, sqliteVecTarget);
  const terminal = await auditTerminalRuntimeAssets(runtimeRoot, context.electronPlatformName, targetArch);
  const claudeSession = await auditClaudeSessionRuntimeAssets(runtimeRoot);
  process.stdout.write(
    `JOKO_DESKTOP_ARTIFACT_AUDIT_OK appFiles=${applicationAudit.files} runtimeFiles=${runtimeAudit.files} runtimeBytes=${runtimeAudit.bytes} npm=${npmRuntime.version} sqliteVec=${sqliteVec.version} terminal=${terminal.version} sessionSdk=${claudeSession.version} voiceShortcut=${nativeVoiceShortcut} dedicatedHardwareSdk=${dedicatedHardwareSdk.status} target=${context.electronPlatformName}-${targetArch}\n`
  );
};

/**
 * Audits only the explicitly supplied packaged resources directory. It never
 * discovers SDK candidates in checkouts, installed applications, PATH, or
 * node_modules. Absence is the expected fail-closed state until an exact
 * artifact is added to the production approval allowlist above.
 */
async function auditDedicatedHardwareSdkDirectory(
  root,
  approvedArtifacts = APPROVED_DEDICATED_HARDWARE_SDK_ARTIFACTS,
  runtimeTarget = currentDedicatedHardwareSdkRuntimeTarget()
) {
  const canonicalRoot = resolve(root);
  const rootInfo = await lstat(canonicalRoot).catch(() => undefined);
  if (rootInfo === undefined) return Object.freeze({ status: "unavailable" });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() ||
      !samePath(await realpath(canonicalRoot), canonicalRoot)) {
    throw new Error("The packaged dedicated hardware SDK directory is unsafe.");
  }

  const lockPath = resolve(canonicalRoot, DEDICATED_HARDWARE_SDK_LOCK);
  const lockBytes = await readStableDedicatedHardwareSdkFile(
    lockPath,
    MAXIMUM_DEDICATED_HARDWARE_SDK_LOCK_BYTES
  );
  let lock;
  try {
    lock = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(lockBytes));
  } catch {
    throw new Error("The packaged dedicated hardware SDK lock is invalid JSON or UTF-8.");
  }
  if (!isDedicatedHardwareSdkLock(lock)) {
    throw new Error("The packaged dedicated hardware SDK lock does not match the strict v1 shape.");
  }
  if (!sameDedicatedHardwareSdkTarget(lock.target, runtimeTarget)) {
    throw new Error("The packaged dedicated hardware SDK target or ABI does not match this artifact.");
  }

  const expectedFiles = [DEDICATED_HARDWARE_SDK_LOCK, ...lock.files.map((entry) => entry.relativePath)].sort();
  const expectedDirectories = dedicatedHardwareSdkManifestDirectories(lock.files);
  const before = await discoverDedicatedHardwareSdkTree(canonicalRoot);
  if (!sameStringArray(before.files, expectedFiles) ||
      !sameStringArray(before.directories, expectedDirectories)) {
    throw new Error("The packaged dedicated hardware SDK directory contains unexpected files.");
  }

  const digestInputs = [];
  for (const expected of lock.files) {
    const path = dedicatedHardwareSdkManifestPath(canonicalRoot, expected.relativePath);
    const bytes = await readStableDedicatedHardwareSdkFile(path, expected.size);
    const integrity = sha512Integrity(bytes);
    if (bytes.byteLength !== expected.size || integrity !== expected.integrity) {
      throw new Error(`The packaged dedicated hardware SDK file failed integrity verification: ${expected.relativePath}`);
    }
    digestInputs.push({ ...expected, bytes });
  }
  if (createDedicatedHardwareSdkDirectoryIntegrity(digestInputs) !== lock.directoryIntegrity) {
    throw new Error("The packaged dedicated hardware SDK directory failed canonical integrity verification.");
  }
  const after = await discoverDedicatedHardwareSdkTree(canonicalRoot);
  if (!sameStringArray(after.files, expectedFiles) ||
      !sameStringArray(after.directories, expectedDirectories)) {
    throw new Error("The packaged dedicated hardware SDK directory changed while it was audited.");
  }
  const finalLockBytes = await readStableDedicatedHardwareSdkFile(
    lockPath,
    MAXIMUM_DEDICATED_HARDWARE_SDK_LOCK_BYTES
  );
  if (!lockBytes.equals(finalLockBytes)) {
    throw new Error("The packaged dedicated hardware SDK lock changed while it was audited.");
  }
  assertDedicatedHardwareSdkHandshakeBudget({
    kind: "staged",
    stagingDirectory: canonicalRoot,
    manifest: lock
  });

  const approved = approvedArtifacts.some((candidate) =>
    isDedicatedHardwareSdkLock(candidate) && canonicalJson(candidate) === canonicalJson(lock)
  );
  if (!approved) {
    throw new Error("No exact dedicated hardware SDK artifact is approved for redistribution.");
  }
  return Object.freeze({
    status: "locked",
    packageVersion: lock.packageVersion,
    manifestIntegrity: lock.manifestIntegrity,
    directoryIntegrity: lock.directoryIntegrity,
    redistributionGrantId: lock.redistributionGrantId
  });
}

function isDedicatedHardwareSdkLock(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "directoryIntegrity",
    "entry",
    "files",
    "license",
    "manifestIntegrity",
    "nativeAddons",
    "packageName",
    "packageVersion",
    "redistributionGrantId",
    "target",
    "version"
  ];
  if (!(keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]) &&
    value.version === 1 && value.packageName === DEDICATED_HARDWARE_SDK_PACKAGE &&
    typeof value.packageVersion === "string" && value.packageVersion.length <= 128 &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value.packageVersion) &&
    isBoundedDedicatedHardwareSdkIdentity(value.redistributionGrantId, 256) &&
    isDedicatedHardwareSdkFileReference(value.license, false) &&
    isDedicatedHardwareSdkTarget(value.target) &&
    isDedicatedHardwareSdkFileReference(value.entry, true) &&
    isDedicatedHardwareSdkNativeAddons(value.nativeAddons) &&
    isDedicatedHardwareSdkFileManifest(value.files) &&
    isSha512Integrity(value.directoryIntegrity) && isSha512Integrity(value.manifestIntegrity) &&
    dedicatedHardwareSdkReferencesMatch(value))) return false;
  const { manifestIntegrity: _manifestIntegrity, ...withoutManifestIntegrity } = value;
  return createDedicatedHardwareSdkManifestIntegrity(withoutManifestIntegrity) === value.manifestIntegrity;
}

module.exports.auditDedicatedHardwareSdkDirectory = auditDedicatedHardwareSdkDirectory;
module.exports.createDedicatedHardwareSdkDirectoryIntegrity = createDedicatedHardwareSdkDirectoryIntegrity;
module.exports.createDedicatedHardwareSdkManifestIntegrity = createDedicatedHardwareSdkManifestIntegrity;
module.exports.dedicatedHardwareSdkHandshakeBytes = dedicatedHardwareSdkHandshakeBytes;
module.exports.assertDedicatedHardwareSdkHandshakeBudget = assertDedicatedHardwareSdkHandshakeBudget;

function dedicatedHardwareSdkHandshakeBytes(sdk, keymapBackupDirectory = maximumKeymapBackupPathBudgetValue()) {
  return Buffer.byteLength(JSON.stringify({
    version: 1,
    generation: 1,
    requestId: "g1:1",
    kind: "handshake",
    sdk,
    keymapBackupDirectory
  }), "utf8");
}

function assertDedicatedHardwareSdkHandshakeBudget(sdk) {
  const handshakeBytes = dedicatedHardwareSdkHandshakeBytes(sdk);
  if (handshakeBytes > MAXIMUM_DEDICATED_HARDWARE_SDK_HANDSHAKE_BYTES) {
    throw new Error("The packaged dedicated hardware SDK identity exceeds the utility handshake boundary.");
  }
  return handshakeBytes;
}

function maximumKeymapBackupPathBudgetValue() {
  // The strict protocol permits 4,096 UTF-16 code units. A BMP scalar can
  // consume three UTF-8 bytes per code unit, so reserve a valid POSIX absolute
  // path at that maximum rather than assuming the build host's short userData.
  return `/${"\u0800".repeat(MAXIMUM_DEDICATED_HARDWARE_KEYMAP_BACKUP_PATH_CODE_UNITS - 1)}`;
}

function isDedicatedHardwareSdkTarget(value) {
  return hasExactObjectKeys(value, ["architecture", "electronModulesAbi", "nodeApiVersion", "platform"]) &&
    ["win32", "darwin", "linux"].includes(value.platform) && ["x64", "arm64"].includes(value.architecture) &&
    isPositiveSafeInteger(value.electronModulesAbi) && isPositiveSafeInteger(value.nodeApiVersion);
}

function isDedicatedHardwareSdkFileReference(value, requireModuleEntry) {
  return hasExactObjectKeys(value, ["integrity", "relativePath"]) &&
    isDedicatedHardwareSdkRelativePath(value.relativePath) &&
    (!requireModuleEntry || value.relativePath.endsWith(".mjs")) && isSha512Integrity(value.integrity);
}

function isDedicatedHardwareSdkNativeAddons(value) {
  if (!Array.isArray(value) || value.length > 64) return false;
  for (const addon of value) {
    if (!hasExactObjectKeys(addon, ["abi", "identity", "integrity", "relativePath"]) ||
        !isBoundedDedicatedHardwareSdkIdentity(addon.identity, 256) ||
        !/^[A-Za-z0-9@][A-Za-z0-9@/._:+-]*$/u.test(addon.identity) ||
        !isDedicatedHardwareSdkRelativePath(addon.relativePath) || !addon.relativePath.endsWith(".node") ||
        !isSha512Integrity(addon.integrity) || !["electron-modules", "node-api"].includes(addon.abi)) return false;
  }
  return isStrictlySortedUnique(value, (item) => item.identity) &&
    isCaseInsensitiveUnique(value.map((item) => item.relativePath));
}

function isDedicatedHardwareSdkFileManifest(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 512) return false;
  let totalBytes = 0;
  for (const file of value) {
    if (!hasExactObjectKeys(file, ["integrity", "relativePath", "size"]) ||
        !isDedicatedHardwareSdkRelativePath(file.relativePath) || !isPositiveSafeInteger(file.size) ||
        file.size > 128 * 1024 * 1024 || !isSha512Integrity(file.integrity)) return false;
    totalBytes += file.size;
  }
  return Number.isSafeInteger(totalBytes) && totalBytes <= 512 * 1024 * 1024 &&
    isStrictlySortedUnique(value, (item) => item.relativePath) &&
    isCaseInsensitiveUnique(value.map((item) => item.relativePath));
}

function dedicatedHardwareSdkReferencesMatch(lock) {
  const fileByPath = new Map(lock.files.map((file) => [file.relativePath, file]));
  if (fileByPath.get(lock.license.relativePath)?.integrity !== lock.license.integrity ||
      fileByPath.get(lock.entry.relativePath)?.integrity !== lock.entry.integrity) return false;
  const nativePaths = new Set(lock.nativeAddons.map((addon) => addon.relativePath));
  return !lock.nativeAddons.some((addon) => fileByPath.get(addon.relativePath)?.integrity !== addon.integrity) &&
    !lock.files.some((file) => file.relativePath.endsWith(".node") !== nativePaths.has(file.relativePath));
}

function createDedicatedHardwareSdkManifestIntegrity(value) {
  return sha512Integrity(Buffer.from(canonicalJson(value), "utf8"));
}

function createDedicatedHardwareSdkDirectoryIntegrity(entries) {
  const digest = createHash("sha512");
  digest.update(`${DEDICATED_HARDWARE_SDK_DIRECTORY_DIGEST_DOMAIN}\0`, "utf8");
  for (const entry of entries) {
    digest.update(JSON.stringify({
      relativePath: entry.relativePath,
      size: entry.size,
      integrity: entry.integrity
    }), "utf8");
    digest.update("\0", "utf8");
    digest.update(entry.bytes);
    digest.update("\0", "utf8");
  }
  return `sha512-${digest.digest("base64")}`;
}

async function discoverDedicatedHardwareSdkTree(root) {
  const files = [];
  const directories = [];
  const visit = async (directory, relativeDirectory, depth) => {
    if (depth > 16) throw new Error("The packaged dedicated hardware SDK directory is nested too deeply.");
    const entries = (await readdir(directory)).sort();
    if (entries.length > 513 || new Set(entries).size !== entries.length ||
        !isCaseInsensitiveUnique(entries)) {
      throw new Error("The packaged dedicated hardware SDK directory entries are invalid or ambiguous.");
    }
    for (const name of entries) {
      if (!isDedicatedHardwareSdkPathSegment(name)) {
        throw new Error("The packaged dedicated hardware SDK directory contains an unsafe path.");
      }
      const path = resolve(directory, name);
      assertContained(root, path);
      const info = await lstat(path);
      if (info.isSymbolicLink() || !samePath(await realpath(path), path)) {
        throw new Error("The packaged dedicated hardware SDK directory contains a redirected entry.");
      }
      const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
      if (info.isDirectory()) {
        directories.push(relativePath);
        await visit(path, relativePath, depth + 1);
      } else if (info.isFile()) {
        files.push(relativePath);
      } else {
        throw new Error("The packaged dedicated hardware SDK directory contains a non-regular entry.");
      }
    }
  };
  await visit(root, "", 0);
  return Object.freeze({ files: Object.freeze(files.sort()), directories: Object.freeze(directories.sort()) });
}

async function readStableDedicatedHardwareSdkFile(path, maximumBytes) {
  if (!samePath(await realpath(path), path)) {
    throw new Error("The packaged dedicated hardware SDK file is redirected.");
  }
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > maximumBytes) {
    throw new Error("The packaged dedicated hardware SDK file is missing, unsafe, or outside its size boundary.");
  }
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (bytes.byteLength !== before.size || !sameDedicatedHardwareSdkFileInfo(before, after) ||
      !samePath(await realpath(path), path)) {
    throw new Error("The packaged dedicated hardware SDK file changed while it was audited.");
  }
  return bytes;
}

function dedicatedHardwareSdkManifestDirectories(files) {
  const directories = new Set();
  for (const file of files) {
    const parts = file.relativePath.split("/");
    for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join("/"));
  }
  return [...directories].sort();
}

function dedicatedHardwareSdkManifestPath(root, relativePath) {
  const path = resolve(root, ...relativePath.split("/"));
  assertContained(root, path);
  return path;
}

function currentDedicatedHardwareSdkRuntimeTarget() {
  const electronModulesAbi = Number(process.versions.modules);
  const nodeApiVersion = Number(process.versions.napi);
  if (!["win32", "darwin", "linux"].includes(process.platform) ||
      !["x64", "arm64"].includes(process.arch) ||
      !isPositiveSafeInteger(electronModulesAbi) || !isPositiveSafeInteger(nodeApiVersion)) return undefined;
  return { platform: process.platform, architecture: process.arch, electronModulesAbi, nodeApiVersion };
}

function sameDedicatedHardwareSdkTarget(left, right) {
  return right !== undefined && left.platform === right.platform && left.architecture === right.architecture &&
    left.electronModulesAbi === right.electronModulesAbi && left.nodeApiVersion === right.nodeApiVersion;
}

function sameDedicatedHardwareSdkFileInfo(left, right) {
  return right.isFile() && !right.isSymbolicLink() && left.size === right.size &&
    left.dev === right.dev && left.ino === right.ino && left.mtimeMs === right.mtimeMs;
}

function isDedicatedHardwareSdkRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\\") ||
      value.startsWith("/") || value.endsWith("/") || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return false;
  const segments = value.split("/");
  return segments.length <= 16 && segments.every(isDedicatedHardwareSdkPathSegment);
}

function isDedicatedHardwareSdkPathSegment(value) {
  return value.length > 0 && value.length <= 255 && value !== "." && value !== ".." &&
    /^[A-Za-z0-9@][A-Za-z0-9@._+-]*$/u.test(value);
}

function isBoundedDedicatedHardwareSdkIdentity(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value.trim() === value &&
    !hasLoneSurrogate(value) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function isSha512Integrity(value) {
  return typeof value === "string" && /^sha512-[A-Za-z0-9+/]{86}==$/u.test(value);
}

function hasExactObjectKeys(value, expected) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isStrictlySortedUnique(values, select) {
  return values.every((value, index) => index === 0 || select(values[index - 1]) < select(value));
}

function isCaseInsensitiveUnique(values) {
  return new Set(values.map((value) => value.toLowerCase())).size === values.length;
}

function sameStringArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("Canonical SDK manifest numbers must be safe integers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  throw new TypeError("The SDK manifest cannot be canonicalized.");
}

function sha512Integrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function hasLoneSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

async function auditBundledNpmRuntime(runtimeRoot, expected) {
  const manifestPath = resolve(runtimeRoot, expected.manifestRelativePath);
  const manifest = await readJsonManifest(manifestPath, expected.name);
  if (manifest.name !== expected.name || manifest.version !== expected.version ||
      manifest.bin?.npm !== expected.packageBinTarget) {
    throw new Error("The packaged npm runtime identity is invalid.");
  }
  const packageRoot = resolve(manifestPath, "..");
  await assertPackageFile(
    packageRoot,
    expected.packageBinTarget,
    "The packaged npm CLI entry is missing or unsafe."
  );
  return { version: manifest.version };
}

async function auditElectronUpdaterRuntime(applicationRoot) {
  const updaterRoot = resolve(applicationRoot, "node_modules", "electron-updater");
  const updaterManifestPath = resolve(updaterRoot, "package.json");
  await assertCanonicalRegularFile(updaterManifestPath, "The packaged application is missing electron-updater.");
  const updaterManifest = await readJsonManifest(updaterManifestPath, "electron-updater");
  if (updaterManifest.name !== "electron-updater" || updaterManifest.version !== "6.8.9" ||
      updaterManifest.main !== "out/main.js") {
    throw new Error("The packaged electron-updater identity or entry is not the audited 6.8.9 runtime.");
  }
  await assertPackageFile(updaterRoot, "out/main.js", "The packaged electron-updater entry is missing or unsafe.");
  for (const dependency of Object.keys(updaterManifest.dependencies ?? {}).sort()) {
    const dependencyRoot = await resolvePackagedDependencyRoot(applicationRoot, updaterRoot, dependency);
    const dependencyManifest = await readJsonManifest(resolve(dependencyRoot, "package.json"), dependency);
    if (dependencyManifest.name !== dependency) {
      throw new Error(`The packaged electron-updater dependency identity is invalid: ${dependency}`);
    }
  }

  const builderRuntimeRoot = await resolvePackagedDependencyRoot(applicationRoot, updaterRoot, "builder-util-runtime");
  const builderRuntimeManifest = await readJsonManifest(
    resolve(builderRuntimeRoot, "package.json"),
    "builder-util-runtime"
  );
  if (builderRuntimeManifest.name !== "builder-util-runtime" || builderRuntimeManifest.version !== "9.7.0" ||
      builderRuntimeManifest.main !== "out/index.js") {
    throw new Error("The packaged builder-util-runtime identity or entry is not the audited 9.7.0 runtime.");
  }
  await assertPackageFile(
    builderRuntimeRoot,
    "out/index.js",
    "The packaged builder-util-runtime entry is missing or unsafe."
  );

  const debugRoot = await resolvePackagedDependencyRoot(applicationRoot, builderRuntimeRoot, "debug");
  const debugManifest = await readJsonManifest(resolve(debugRoot, "package.json"), "debug");
  if (debugManifest.name !== "debug" || debugManifest.version !== "4.4.3" || debugManifest.main !== "./src/index.js") {
    throw new Error("The packaged debug identity or entry is not the audited 4.4.3 runtime.");
  }
  for (const required of ["./src/index.js", "./src/node.js", "./src/common.js"]) {
    await assertPackageFile(debugRoot, required, `The packaged debug runtime is missing ${required}.`);
  }
}

async function auditDesktopUpdateControlRuntime(applicationRoot) {
  for (const expected of [
    { name: "@connectrpc/connect", version: "2.1.2", entry: "dist/esm/index.js" },
    { name: "@connectrpc/connect-node", version: "2.1.2", entry: "dist/esm/index.js" },
    { name: "yaml", version: "2.9.0", entry: "dist/index.js" }
  ]) {
    const packageRoot = await resolvePackagedDependencyRoot(applicationRoot, applicationRoot, expected.name);
    const manifest = await readJsonManifest(resolve(packageRoot, "package.json"), expected.name);
    if (manifest.name !== expected.name || manifest.version !== expected.version) {
      throw new Error(`The packaged Desktop update dependency identity is invalid: ${expected.name}`);
    }
    await assertPackageFile(
      packageRoot,
      expected.entry,
      `The packaged Desktop update dependency entry is missing or unsafe: ${expected.name}`
    );
  }
}

async function resolvePackagedDependencyRoot(applicationRoot, packageRoot, dependency) {
  const candidates = [
    resolve(packageRoot, "node_modules", dependency),
    resolve(applicationRoot, "node_modules", dependency)
  ];
  for (const candidate of candidates) {
    const manifestPath = resolve(candidate, "package.json");
    const info = await lstat(manifestPath).catch(() => undefined);
    if (info !== undefined && info.isFile() && !info.isSymbolicLink() && samePath(await realpath(manifestPath), manifestPath)) {
      return candidate;
    }
  }
  throw new Error(`The packaged electron-updater dependency is missing: ${dependency}`);
}

async function auditSqliteVecRuntime(runtimeRoot, target) {
  const packageRoot = resolve(runtimeRoot, "node_modules", "sqlite-vec");
  const manifestPath = resolve(packageRoot, "package.json");
  await assertCanonicalRegularFile(manifestPath, "The packaged Orchestrator runtime is missing the sqlite-vec manifest.");
  const manifest = await readJsonManifest(manifestPath, "sqlite-vec");
  if (manifest.name !== "sqlite-vec" || typeof manifest.version !== "string" || manifest.version === "") {
    throw new Error("The packaged sqlite-vec package identity is invalid.");
  }
  if (manifest.optionalDependencies?.[target.packageName] !== manifest.version) {
    throw new Error("The packaged sqlite-vec manifest does not pin the target native package generation.");
  }
  const commonJsTarget = manifestRelativeTarget(manifest.main, "sqlite-vec main");
  const moduleTarget = manifestRelativeTarget(manifest.exports?.["."]?.import, "sqlite-vec import export");
  await assertPackageFile(packageRoot, commonJsTarget, "The packaged sqlite-vec CommonJS entry is missing or unsafe.");
  await assertPackageFile(packageRoot, moduleTarget, "The packaged sqlite-vec ESM entry is missing or unsafe.");

  const nativePackageRoot = resolve(runtimeRoot, target.packageRelativePath);
  const nativeManifestPath = resolve(nativePackageRoot, "package.json");
  await assertCanonicalRegularFile(nativeManifestPath, `The packaged Orchestrator runtime is missing ${target.packageName}.`);
  const nativeManifest = await readJsonManifest(nativeManifestPath, target.packageName);
  if (nativeManifest.name !== target.packageName || nativeManifest.version !== manifest.version) {
    throw new Error("The packaged sqlite-vec JS and native package identities do not match.");
  }
  if (!Array.isArray(nativeManifest.os) || !nativeManifest.os.includes(target.platform) ||
      !Array.isArray(nativeManifest.cpu) || !nativeManifest.cpu.includes(target.arch)) {
    throw new Error("The packaged sqlite-vec native metadata does not match the artifact target.");
  }
  if (nativeManifest.exports?.[`./${target.binaryName}`]?.default !== `./${target.binaryName}`) {
    throw new Error("The packaged sqlite-vec native package does not export the target binary.");
  }
  await assertCanonicalRegularFile(
    resolve(runtimeRoot, target.binaryRelativePath),
    `The packaged Orchestrator runtime is missing ${target.packageName}/${target.binaryName}.`
  );
  return { version: manifest.version };
}

async function assertPackageFile(packageRoot, relativeTarget, message) {
  const candidate = resolve(packageRoot, relativeTarget);
  assertContained(packageRoot, candidate);
  await assertCanonicalRegularFile(candidate, message);
}

function manifestRelativeTarget(value, label) {
  if (typeof value !== "string" || !value.startsWith("./") || value.includes("\0")) {
    throw new Error(`The packaged ${label} is invalid.`);
  }
  return value;
}

async function readJsonManifest(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`The packaged ${label} manifest is invalid JSON.`);
  }
}

async function auditRegularDistributionTree(root, label, options) {
  const canonicalRoot = resolve(root);
  const rootInfo = await lstat(canonicalRoot).catch(() => undefined);
  if (rootInfo === undefined || !rootInfo.isDirectory() || rootInfo.isSymbolicLink() ||
    !samePath(await realpath(canonicalRoot), canonicalRoot)) {
    throw new Error(`The ${label} root is missing or unsafe.`);
  }
  let files = 0;
  let bytes = 0;
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const candidate = resolve(directory, entry.name);
      assertContained(canonicalRoot, candidate);
      assertDistributionPath(relative(canonicalRoot, candidate), options);
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) throw new Error(`The ${label} contains a link: ${candidate}`);
      if (info.isDirectory()) {
        if (!samePath(await realpath(candidate), candidate)) {
          throw new Error(`The ${label} contains a non-canonical directory: ${candidate}`);
        }
        await visit(candidate);
        continue;
      }
      if (!info.isFile()) throw new Error(`The ${label} contains a special file: ${candidate}`);
      files += 1;
      bytes += info.size;
      if (files > MAXIMUM_RUNTIME_FILES || bytes > MAXIMUM_RUNTIME_BYTES) {
        throw new Error(`The ${label} exceeds the audited distribution limits.`);
      }
    }
  };
  await visit(canonicalRoot);
  return { files, bytes };
}

async function assertCanonicalRegularFile(path, message) {
  const canonical = resolve(path);
  const info = await lstat(canonical).catch(() => undefined);
  if (info === undefined || !info.isFile() || info.isSymbolicLink() || !samePath(await realpath(canonical), canonical)) {
    throw new Error(message);
  }
}

async function auditNativeTaskStatusSounds(root) {
  const expected = [
    "error-buzz.mp3",
    "gem-collect.mp3",
    "item-fanfare.mp3",
    "item-found.mp3",
    "ring-chime.mp3",
    "secret-chime.mp3",
    "startup-chime.mp3",
    "victory-fanfare.mp3"
  ];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const names = entries.map((entry) => entry.name).sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new Error("The packaged native task-status sound catalog is incomplete or contains unexpected files.");
  }
  let bytes = 0;
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    await assertCanonicalRegularFile(path, `The packaged native task-status sound is unsafe: ${entry.name}`);
    bytes += (await lstat(path)).size;
  }
  if (bytes <= 0 || bytes > 2 * 1024 * 1024) throw new Error("The packaged native task-status sounds exceed the audited size boundary.");
}

async function auditWdaSourceAssets(root, platform) {
  const manifestPath = resolve(root, "manifest.json");
  const licensePath = resolve(root, "LICENSE.appium-webdriveragent");
  await assertCanonicalRegularFile(manifestPath, "The packaged driver source manifest is missing or unsafe.");
  await assertCanonicalRegularFile(licensePath, "The packaged driver source license is missing or unsafe.");
  const manifest = await readJsonManifest(manifestPath, "driver source");
  if (Object.keys(manifest).sort().join(",") !==
      "archiveFileName,archiveSha256,archiveUrl,license,licenseSha256,name,revision,tag" ||
      manifest.name !== "WebDriverAgent" || manifest.tag !== "v15.1.6" ||
      manifest.revision !== "5f8280e761dc0b5b9b28368e63a8f0cc8d868346" ||
      manifest.archiveFileName !== "WebDriverAgent-v15.1.6.tar.gz" ||
      manifest.archiveUrl !== "https://codeload.github.com/appium/WebDriverAgent/tar.gz/refs/tags/v15.1.6" ||
      manifest.archiveSha256 !== "98c8f7102768aa10530c9b124be39d66a06a146631708416348b88f2db1a56c3" ||
      manifest.license !== "BSD-3-Clause" ||
      manifest.licenseSha256 !== "d9910c6ba5e4c29ae415ee3ce875c9e18a60d8bc4d7fe2c2d104db2a718b1bb4") {
    throw new Error("The packaged driver source manifest differs from the pinned release.");
  }
  const license = await readFile(licensePath);
  if (createHash("sha256").update(license).digest("hex") !== manifest.licenseSha256) {
    throw new Error("The packaged driver source license failed integrity verification.");
  }
  const expected = ["LICENSE.appium-webdriveragent", "manifest.json"];
  if (platform === "darwin") expected.push(manifest.archiveFileName);
  expected.sort();
  const entries = await readdir(root, { withFileTypes: true });
  const names = entries.map(entry => entry.name).sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new Error("The packaged driver source assets are incomplete or unexpected.");
  }
  if (platform !== "darwin") return;
  const archivePath = resolve(root, manifest.archiveFileName);
  await assertCanonicalRegularFile(archivePath, "The packaged driver source archive is missing or unsafe.");
  const info = await lstat(archivePath);
  if (info.size <= 0 || info.size > 8 * 1024 * 1024) throw new Error("The packaged driver source archive exceeds its size limit.");
  const archive = await readFile(archivePath);
  if (createHash("sha256").update(archive).digest("hex") !== manifest.archiveSha256) {
    throw new Error("The packaged driver source archive failed integrity verification.");
  }
}

async function auditNativeSystemFrontmostInput(root, platform, targetArch) {
  const helper = platform === "win32" ? "joko-windows-frontmost-input.node" : null;
  const expected = (helper === null ? ["manifest.json"] : [helper, "manifest.json"]).sort();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const names = entries.map(entry => entry.name).sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new Error("The packaged native foreground input directory is incomplete or contains unexpected files.");
  }
  for (const entry of entries) {
    await assertCanonicalRegularFile(resolve(root, entry.name), "The packaged native foreground input is unsafe.");
  }
  const manifest = await readJsonManifest(resolve(root, "manifest.json"), "native foreground input");
  if (Object.keys(manifest).sort().join(",") !== "architecture,helper,platform,protocolVersion,sha256"
    || manifest.architecture !== targetArch || manifest.platform !== platform
    || manifest.helper !== helper || manifest.protocolVersion !== 1
    || (helper === null ? manifest.sha256 !== null
      : typeof manifest.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(manifest.sha256))) {
    throw new Error("The packaged native foreground input identity does not match the artifact target.");
  }
  if (helper === null) return;
  const path = resolve(root, helper);
  const info = await lstat(path);
  if (info.size <= 0 || info.size > 2 * 1024 * 1024
    || createHash("sha256").update(await readFile(path)).digest("hex") !== manifest.sha256) {
    throw new Error("The packaged native foreground input failed integrity verification.");
  }
}

async function auditNativeVoiceShortcut(root, platform, targetArch) {
  const helper = platform === "darwin"
    ? "joko-macos-key-listener"
    : platform === "win32"
      ? "joko-windows-function-key-listener.exe"
      : null;
  const expected = (helper === null ? ["manifest.json"] : [helper, "manifest.json"]).sort();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const names = entries.map((entry) => entry.name).sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new Error("The packaged native voice-shortcut helper directory is incomplete or contains unexpected files.");
  }
  for (const entry of entries) {
    await assertCanonicalRegularFile(
      resolve(root, entry.name),
      `The packaged native voice-shortcut file is unsafe: ${entry.name}`
    );
  }
  const manifest = await readJsonManifest(resolve(root, "manifest.json"), "native voice-shortcut");
  if (Object.keys(manifest).sort().join(",") !== "architecture,helper,platform,protocolVersion" ||
      manifest.architecture !== targetArch || manifest.platform !== platform ||
      manifest.helper !== helper || manifest.protocolVersion !== 1) {
    throw new Error("The packaged native voice-shortcut manifest does not match the artifact target.");
  }
  if (helper === null) return "not-required";
  const helperInfo = await lstat(resolve(root, helper));
  if (helperInfo.size <= 0 || helperInfo.size > 8 * 1024 * 1024) {
    throw new Error("The packaged native voice-shortcut helper exceeds the audited size boundary.");
  }
  if (platform === "darwin" && (helperInfo.mode & 0o111) === 0) {
    throw new Error("The packaged macOS voice-shortcut helper is not executable.");
  }
  return helper;
}

async function auditNativeSimulatorHelper(root, platform, targetArch, label, helperName) {
  const manifest = await readJsonManifest(resolve(root, "manifest.json"), label);
  const helper = manifest.helper;
  const expected = (helper === null ? ["manifest.json"] : [helperName, "manifest.json"]).sort();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const names = entries.map(entry => entry.name).sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new Error(`The packaged ${label} helper directory is incomplete or contains unexpected files.`);
  }
  for (const entry of entries) {
    await assertCanonicalRegularFile(resolve(root, entry.name),
      `The packaged ${label} file is unsafe: ${entry.name}`);
  }
  if (Object.keys(manifest).sort().join(",") !== "architecture,helper,platform,protocolVersion" ||
      (platform === "darwin" && helper !== null ?
        !["universal", targetArch === "x64" ? "x86_64" : targetArch].includes(manifest.architecture) :
        manifest.architecture !== (platform === "darwin" && targetArch === "x64" ? "x86_64" : targetArch)) ||
      manifest.platform !== platform ||
      ![null, platform === "darwin" ? helperName : null].includes(helper) ||
      (platform !== "darwin" && helper !== null) || manifest.protocolVersion !== 1) {
    throw new Error(`The packaged ${label} manifest does not match the artifact target.`);
  }
  if (helper === null) return;
  const info = await lstat(resolve(root, helper));
  if (info.size <= 0 || info.size > 16 * 1024 * 1024 || (info.mode & 0o111) === 0) {
    throw new Error(`The packaged macOS ${label} helper is invalid or not executable.`);
  }
}

function assertDistributionPath(path, options) {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (FORBIDDEN_SEGMENTS.has(lower)) throw new Error(`Distribution contains a forbidden directory: ${normalized}`);
    const dependencySourceAllowed = options.allowNodeModulesSourceDirectories === true &&
      segments[0]?.toLowerCase() === "node_modules";
    if (options.forbidSourceDirectories && !dependencySourceAllowed && (lower === "src" || lower === "source")) {
      throw new Error(`Distribution contains a source directory: ${normalized}`);
    }
    if (lower === ".env" || lower.startsWith(".env.")) {
      throw new Error(`Distribution contains an environment file: ${normalized}`);
    }
  }
  const lowerBase = basename(normalized).toLowerCase();
  const extension = extname(lowerBase);
  if (/\.test\.[^/]+$/u.test(lowerBase)) throw new Error(`Distribution contains a test file: ${normalized}`);
  if (FORBIDDEN_EXTENSIONS.has(extension) || lowerBase.endsWith(".db-shm") || lowerBase.endsWith(".db-wal")) {
    throw new Error(`Distribution contains a forbidden source or state file: ${normalized}`);
  }
}

function assertContained(root, candidate) {
  const suffix = relative(root, candidate);
  if (suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix))) return;
  throw new Error("The packaged Orchestrator runtime path escapes its resources root.");
}

function samePath(left, right) {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}
