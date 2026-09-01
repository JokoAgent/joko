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

module.exports = async function auditPackaged(context) {
  const {
    ORCHESTRATOR_BUNDLED_NPM_RUNTIME,
    ORCHESTRATOR_RUNTIME_PACKAGES,
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

  const updaterConfigPath = resolve(resourcesRoot, "app-update.yml");
  await assertCanonicalRegularFile(updaterConfigPath, "The packaged application is missing app-update.yml.");
  const updaterConfig = await readFile(updaterConfigPath, "utf8");
  const normalizedUpdaterConfig = updaterConfig.replaceAll("\r\n", "\n");
  if (normalizedUpdaterConfig.includes("\r") || normalizedUpdaterConfig !== "updaterCacheDirName: joko-updater\n") {
    throw new Error("The packaged app-update.yml must contain only the audited updater cache name.");
  }
  await auditNativeTaskStatusSounds(resolve(resourcesRoot, "native-task-status-sounds"));
  const nativeVoiceShortcut = await auditNativeVoiceShortcut(
    nativeVoiceShortcutRoot,
    context.electronPlatformName,
    targetArch
  );

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
  for (const required of ["package.json", join("dist", "main.js"), join("dist", "preload.cjs"), join("dist", "web", "index.html")]) {
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
  process.stdout.write(
    `JOKO_DESKTOP_ARTIFACT_AUDIT_OK appFiles=${applicationAudit.files} runtimeFiles=${runtimeAudit.files} runtimeBytes=${runtimeAudit.bytes} npm=${npmRuntime.version} sqliteVec=${sqliteVec.version} voiceShortcut=${nativeVoiceShortcut} target=${context.electronPlatformName}-${targetArch}\n`
  );
};

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
