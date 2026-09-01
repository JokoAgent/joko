import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  lstat,
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";

import {
  ORCHESTRATOR_BUNDLED_NPM_RUNTIME,
  ORCHESTRATOR_RUNTIME_CRITICAL_IMPORTS,
  ORCHESTRATOR_RUNTIME_PACKAGES,
  auditRegularRuntimeTree,
  copyRegularTree,
  digestFile,
  removeSafeTemporaryDirectory,
  replaceDirectoryFromPrepared,
  rewriteRuntimePackageManifestFile,
  runtimeBuildEnvironment,
  runtimeExecutablePath,
  sqliteVecElectronSmokeSource
} from "../dist/runtime-staging.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDirectory, "..");
const repositoryRoot = resolve(desktopRoot, "..", "..");
const distributionRoot = resolve(desktopRoot, "dist");
const destinationRoot = resolve(distributionRoot, "orchestrator-runtime");
const keepCandidate = process.env.JOKO_ORCHESTRATOR_RUNTIME_KEEP_CANDIDATE === "1";
const workRoot = await mkdtemp(join(await realpath(tmpdir()), "joko-orchestrator-runtime-"));
const workspaceRoot = join(workRoot, "workspace");
const candidateRoot = join(workRoot, "candidate");
const storeRoot = join(workRoot, "pnpm-store");
const isolatedHome = join(workRoot, "isolated-home");
const isolatedAppData = join(workRoot, "isolated-app-data");
const isolatedLocalAppData = join(workRoot, "isolated-local-app-data");
const isolatedTemporaryDirectory = join(workRoot, "isolated-temp");
const emptyNpmConfig = join(workRoot, "empty-user.npmrc");
const preparedRoot = join(distributionRoot, `.orchestrator-runtime-stage-${basename(workRoot)}`);
const rootStatePaths = [
  join(repositoryRoot, "node_modules", ".pnpm-workspace-state-v1.json"),
  join(repositoryRoot, "node_modules", ".modules.yaml")
];
const rootStateBefore = await Promise.all(rootStatePaths.map(digestFile));
let published = false;

try {
  await mkdir(workspaceRoot, { recursive: false, mode: 0o755 });
  for (const path of [isolatedHome, isolatedAppData, isolatedLocalAppData, isolatedTemporaryDirectory]) {
    await mkdir(path, { recursive: false, mode: 0o700 });
  }
  await writeFile(emptyNpmConfig, "", { flag: "wx", mode: 0o600 });
  await copyWorkspaceInputs();
  const lockDigest = await digestFile(join(workspaceRoot, "pnpm-lock.yaml"));
  if (lockDigest === undefined || lockDigest !== await digestFile(join(repositoryRoot, "pnpm-lock.yaml"))) {
    throw new Error("The isolated Orchestrator runtime workspace did not receive the exact frozen lockfile.");
  }

  const pnpm = await pnpmInvocation();
  await runCommand(pnpm.executable, [
    ...pnpm.arguments,
    "install",
    "--filter", "@joko/orchestrator...",
    "--prod",
    "--frozen-lockfile",
    "--node-linker=hoisted",
    "--store-dir", storeRoot
  ], {
    cwd: workspaceRoot,
    environment: isolatedProcessEnvironment(),
    timeoutMs: 10 * 60_000,
    label: "isolated pnpm production closure"
  });
  if (lockDigest !== await digestFile(join(workspaceRoot, "pnpm-lock.yaml"))) {
    throw new Error("pnpm changed the copied frozen lockfile while producing the runtime closure.");
  }
  await assertRepositoryStateUnchanged();

  await mkdir(candidateRoot, { recursive: false, mode: 0o755 });
  await copyCandidateApplication();
  await copyRegularTree(join(workspaceRoot, "node_modules"), join(candidateRoot, "node_modules"), {
    allowContainedLinks: true,
    skip: (path) => skippedInstalledPath(path)
  });
  await overlayWorkspacePackages();
  await auditRegularRuntimeTree(candidateRoot);
  const optionalDependency = await assertOptionalDependencyPreserved(candidateRoot);
  const importSmoke = await runCandidateImportSmoke(candidateRoot);
  const sqliteVecSmoke = await runCandidateSqliteVecSmoke(candidateRoot);
  const orchestratorSmoke = await runCandidateOrchestratorSmoke(candidateRoot);
  const audit = await auditRegularRuntimeTree(candidateRoot);
  const rootStateAfter = await assertRepositoryStateUnchanged();

  const preparedInfo = await lstat(preparedRoot).catch((error) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (preparedInfo !== undefined) await removeSafeTemporaryDirectory(preparedRoot);
  await copyRegularTree(candidateRoot, preparedRoot);
  await auditRegularRuntimeTree(preparedRoot);
  await replaceDirectoryFromPrepared(preparedRoot, destinationRoot);
  const stagedAudit = await auditRegularRuntimeTree(destinationRoot);
  if (stagedAudit.files !== audit.files || stagedAudit.bytes !== audit.bytes) {
    throw new Error("The atomically staged Orchestrator runtime differs from the verified candidate.");
  }
  published = true;
  process.stdout.write(`${JSON.stringify({
    event: "JOKO_ORCHESTRATOR_RUNTIME_STAGED",
    candidateRoot,
    destinationRoot,
    files: audit.files,
    bytes: audit.bytes,
    optionalDependency,
    criticalImportsResolvedWithinCandidate: importSmoke.criticalImports,
    piCliResolvedWithinCandidate: importSmoke.piCli,
    npmRuntime: importSmoke.npmRuntime,
    sqliteVec: sqliteVecSmoke,
    orchestratorHealth: orchestratorSmoke.health,
    orchestratorExitObserved: orchestratorSmoke.exitObserved,
    rootWorkspaceState: rootStatePaths.map((path, index) => ({
      path,
      before: rootStateBefore[index] ?? null,
      after: rootStateAfter[index] ?? null
    })),
    candidateRetained: keepCandidate
  })}\n`);
} finally {
  if (!published) await removeSafeTemporaryDirectory(preparedRoot).catch(() => undefined);
  if (keepCandidate && published) await pruneRetainedWorkRoot();
  if (!keepCandidate) await removeSafeTemporaryDirectory(workRoot).catch(() => undefined);
}

async function copyWorkspaceInputs() {
  for (const filename of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
    const source = join(repositoryRoot, filename);
    const destination = join(workspaceRoot, filename);
    await writeFile(destination, await readFile(source), { flag: "wx", mode: 0o644 });
  }
  for (const descriptor of ORCHESTRATOR_RUNTIME_PACKAGES) {
    const sourcePackageRoot = join(repositoryRoot, descriptor.workspacePath);
    const workspacePackageRoot = join(workspaceRoot, descriptor.workspacePath);
    await mkdir(workspacePackageRoot, { recursive: true, mode: 0o755 });
    await writeFile(
      join(workspacePackageRoot, "package.json"),
      await readFile(join(sourcePackageRoot, "package.json")),
      { flag: "wx", mode: 0o644 }
    );
    await rewriteRuntimePackageManifestFile(join(workspacePackageRoot, "package.json"), descriptor.name);
    await copyRegularTree(join(sourcePackageRoot, "dist"), join(workspacePackageRoot, "dist"));
    if (descriptor.name === "@joko/contracts") {
      await copyRegularTree(join(sourcePackageRoot, "proto"), join(workspacePackageRoot, "proto"));
    }
  }
}

async function copyCandidateApplication() {
  const source = join(workspaceRoot, "apps", "orchestrator");
  await writeFile(join(candidateRoot, "package.json"), await readFile(join(source, "package.json")), {
    flag: "wx",
    mode: 0o644
  });
  await copyRegularTree(join(source, "dist"), join(candidateRoot, "dist"));
}

async function overlayWorkspacePackages() {
  for (const descriptor of ORCHESTRATOR_RUNTIME_PACKAGES) {
    const sourcePackageRoot = join(repositoryRoot, descriptor.workspacePath);
    const packageRoot = resolve(candidateRoot, descriptor.candidatePath);
    if (descriptor.candidatePath !== ".") await mkdir(packageRoot, { recursive: true, mode: 0o755 });
    if (descriptor.candidatePath !== ".") {
      await writeFile(join(packageRoot, "package.json"), await readFile(join(sourcePackageRoot, "package.json")), {
        flag: "wx",
        mode: 0o644
      });
    }
    await rewriteRuntimePackageManifestFile(join(packageRoot, "package.json"), descriptor.name);
    if (descriptor.candidatePath !== ".") await copyRegularTree(join(sourcePackageRoot, "dist"), join(packageRoot, "dist"));
    if (descriptor.name === "@joko/contracts") {
      await copyRegularTree(join(sourcePackageRoot, "proto"), join(packageRoot, "proto"));
    }
  }
}

function skippedInstalledPath(path) {
  if (path === ".pnpm" || path.startsWith(".pnpm/")) return true;
  if (path === ".modules.yaml" || path === ".pnpm-workspace-state-v1.json") return true;
  return ORCHESTRATOR_RUNTIME_PACKAGES.some((descriptor) =>
    descriptor.candidatePath !== "." &&
    (path === descriptor.candidatePath.slice("node_modules/".length) ||
      path.startsWith(`${descriptor.candidatePath.slice("node_modules/".length)}/`))
  );
}

async function runCandidateImportSmoke(root) {
  const smokePath = join(root, ".joko-runtime-import-smoke.mjs");
  const source = [
    'import { readFile, realpath } from "node:fs/promises";',
    'import { dirname, isAbsolute, relative, resolve, sep } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    `const specifications = ${JSON.stringify(ORCHESTRATOR_RUNTIME_CRITICAL_IMPORTS)};`,
    `const npmRuntime = ${JSON.stringify(ORCHESTRATOR_BUNDLED_NPM_RUNTIME)};`,
    'const root = await realpath(dirname(fileURLToPath(import.meta.url)));',
    'const assertContained = (path) => {',
    '  const suffix = relative(root, path);',
    '  if (suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix))) return;',
    '  throw new Error(`Resolved module escaped isolated candidate: ${path}`);',
    '};',
    'for (const specification of specifications) {',
    '  const url = import.meta.resolve(specification);',
    '  if (!url.startsWith("file:")) throw new Error(`Non-file runtime resolution for ${specification}: ${url}`);',
    '  const path = await realpath(fileURLToPath(url));',
    '  assertContained(path);',
    '  await import(specification);',
    '}',
    'const piEntry = await realpath(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));',
    'const piCli = await realpath(resolve(dirname(piEntry), "cli.js"));',
    'assertContained(piCli);',
    'const npmManifestPath = await realpath(resolve(root, npmRuntime.manifestRelativePath));',
    'const npmCli = await realpath(resolve(root, npmRuntime.cliRelativePath));',
    'assertContained(npmManifestPath);',
    'assertContained(npmCli);',
    'const npmManifest = JSON.parse(await readFile(npmManifestPath, "utf8"));',
    'if (npmManifest.name !== npmRuntime.name || npmManifest.version !== npmRuntime.version || npmManifest.bin?.npm !== npmRuntime.packageBinTarget) {',
    '  throw new Error("The bundled npm runtime identity is invalid.");',
    '}',
    'process.stdout.write(JSON.stringify({ ok: true, root, piCli, npmCli, npmVersion: npmManifest.version }));'
  ].join("\n");
  await writeFile(smokePath, `${source}\n`, { flag: "wx", mode: 0o600 });
  try {
    const result = await runCommand(electronExecutable(), [smokePath], {
      cwd: root,
      environment: electronNodeEnvironment(),
      timeoutMs: 45_000,
      label: "repo-external Electron-Node import smoke"
    });
    const parsed = JSON.parse(result.stdout);
    if (parsed?.ok !== true || !samePath(await realpath(parsed.root), root)) {
      throw new Error("The isolated Electron-Node import smoke returned an invalid candidate identity.");
    }
    if (typeof parsed.npmCli !== "string" || parsed.npmVersion !== ORCHESTRATOR_BUNDLED_NPM_RUNTIME.version) {
      throw new Error("The isolated Electron-Node import smoke returned an invalid npm runtime identity.");
    }
    const npmResult = await runCommand(electronExecutable(), [parsed.npmCli, "--version"], {
      cwd: root,
      environment: electronNodeEnvironment(),
      timeoutMs: 45_000,
      label: "isolated bundled npm CLI smoke"
    });
    if (npmResult.stdout.trim() !== parsed.npmVersion) {
      throw new Error("The bundled npm CLI did not execute with its declared version.");
    }
    return {
      criticalImports: ORCHESTRATOR_RUNTIME_CRITICAL_IMPORTS.length,
      piCli: parsed.piCli,
      npmRuntime: { cli: parsed.npmCli, version: parsed.npmVersion }
    };
  } finally {
    await rm(smokePath, { force: false });
  }
}

async function runCandidateSqliteVecSmoke(root) {
  const smokePath = join(root, ".joko-runtime-sqlite-vec-smoke.mjs");
  await writeFile(smokePath, `${sqliteVecElectronSmokeSource(process.platform, process.arch)}\n`, {
    flag: "wx",
    mode: 0o600
  });
  try {
    const result = await runCommand(electronExecutable(), [smokePath, root], {
      cwd: root,
      environment: electronNodeEnvironment(),
      timeoutMs: 45_000,
      label: "isolated Electron-Node sqlite-vec smoke"
    });
    const parsed = JSON.parse(result.stdout);
    if (parsed?.ok !== true || typeof parsed.runtimeRoot !== "string" ||
        typeof parsed.version !== "string" || typeof parsed.electronVersion !== "string" ||
        typeof parsed.nativeBinary !== "string" ||
        !samePath(await realpath(parsed.runtimeRoot), root)) {
      throw new Error("The isolated sqlite-vec smoke returned an invalid runtime identity.");
    }
    return {
      version: parsed.version,
      electronVersion: parsed.electronVersion,
      nodeVersion: parsed.nodeVersion,
      moduleEntry: parsed.moduleEntry,
      nativePackageRoot: parsed.nativePackageRoot,
      nativeBinary: parsed.nativeBinary
    };
  } finally {
    await rm(smokePath, { force: false });
  }
}

async function runCandidateOrchestratorSmoke(root) {
  const publicPort = await selectLoopbackPort();
  const internalPort = await selectLoopbackPort(new Set([publicPort]));
  const smokeRoot = join(workRoot, "orchestrator-smoke");
  const workspace = join(smokeRoot, "workspace");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const environment = {
    ...electronNodeEnvironment(),
    JOKO_DATA_DIR: join(smokeRoot, "data"),
    JOKO_HOST: "127.0.0.1",
    JOKO_PORT: String(publicPort),
    JOKO_INTERNAL_PORT: String(internalPort),
    JOKO_PUBLIC_ORIGIN: `http://127.0.0.1:${publicPort}`,
    JOKO_ALLOW_INSECURE_LOOPBACK: "1",
    JOKO_ALLOW_INSECURE_LAN: "0",
    JOKO_LAN_DISCOVERY: "0",
    JOKO_BROWSER_ENABLED: "0",
    JOKO_WORKSPACE_ROOT: workspace,
    JOKO_WORKSPACE_TRUSTED: "0",
    JOKO_WEB_DIR: join(smokeRoot, "no-public-web"),
    JOKO_LOG_LEVEL: "silent"
  };
  const child = spawn(electronExecutable(), [join(root, "dist", "main.js")], {
    cwd: root,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const output = captureBoundedOutput(child, 64 * 1024);
  try {
    await waitForHealthyOrchestrator(`http://127.0.0.1:${publicPort}`, child, 30_000);
  } catch (error) {
    child.kill("SIGKILL");
    await waitForExit(child, 5_000).catch(() => undefined);
    const captured = output();
    throw new Error(`Isolated Orchestrator startup smoke failed: ${captured.stderr.slice(-2_000)}`, { cause: error });
  }
  child.kill("SIGTERM");
  await waitForExit(child, 10_000).catch(async () => {
    child.kill("SIGKILL");
    await waitForExit(child, 5_000);
  });
  const exitObserved = child.exitCode !== null || child.signalCode !== null;
  if (!exitObserved) throw new Error("The isolated Orchestrator smoke did not observe child termination.");
  return { health: "ok", exitObserved };
}

async function assertRepositoryStateUnchanged() {
  const after = await Promise.all(rootStatePaths.map(digestFile));
  if (after.some((digest, index) => digest !== rootStateBefore[index])) {
    throw new Error("Isolated runtime staging modified the repository node_modules workspace state.");
  }
  return after;
}

async function assertOptionalDependencyPreserved(root) {
  const manifestPath = join(root, "node_modules", "@mariozechner", "clipboard", "package.json");
  const info = await lstat(manifestPath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("The Pi optional clipboard dependency was not preserved as a regular package.");
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest?.name !== "@mariozechner/clipboard") {
    throw new Error("The preserved Pi optional dependency has an unexpected identity.");
  }
  return manifest.name;
}

function electronExecutable() {
  const executable = createRequire(import.meta.url)("electron");
  if (typeof executable !== "string" || executable === "") throw new Error("Electron executable is unavailable.");
  return executable;
}

async function pnpmInvocation() {
  if (process.platform !== "win32") return { executable: "pnpm", arguments: [] };
  const activeEntry = process.env.npm_execpath;
  if (
    typeof activeEntry === "string" &&
    isAbsolute(activeEntry) &&
    resolve(activeEntry) === activeEntry &&
    basename(activeEntry).toLowerCase() === "pnpm.cjs" &&
    await regularFileExists(activeEntry)
  ) {
    return { executable: process.execPath, arguments: [activeEntry] };
  }
  const diagnostics = [];
  for (const directory of (process.env.PATH ?? process.env.Path ?? "").split(delimiter).filter(Boolean)) {
    const direct = resolve(directory, "pnpm.exe");
    if (await regularFileExists(direct)) return { executable: direct, arguments: [] };
    const wrapper = resolve(directory, "pnpm.cmd");
    if (!await regularFileExists(wrapper)) continue;
    const packageEntry = resolve(directory, "..", "pnpm", "bin", "pnpm.cjs");
    if (await regularFileExists(packageEntry)) {
      return { executable: process.execPath, arguments: [packageEntry] };
    }
    const source = await readFile(wrapper, "utf8");
    const normalizedSource = source.toLowerCase();
    const prefix = normalizedSource.indexOf('"%~dp0');
    const suffix = normalizedSource.indexOf('pnpm.exe"', prefix + 6);
    if (prefix < 0 || suffix < 0) {
      diagnostics.push(`${wrapper}:not-direct`);
      continue;
    }
    const relativeExecutable = source.slice(prefix + 6, suffix + "pnpm.exe".length);
    if (relativeExecutable.includes("\r") || relativeExecutable.includes("\n") || relativeExecutable.includes('"')) continue;
    const executable = resolve(`${directory}${relativeExecutable.replaceAll("\\", "/")}`);
    if (await regularFileExists(executable)) return { executable, arguments: [] };
    diagnostics.push(`${wrapper}:missing-${executable}`);
  }
  throw new Error(`A directly executable pnpm binary could not be resolved without a command shell (${diagnostics.join("; ")}).`);
}

async function regularFileExists(path) {
  try {
    await access(path);
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

function electronNodeEnvironment() {
  const environment = isolatedProcessEnvironment();
  delete environment.NPM_CONFIG_USERCONFIG;
  return { ...environment, ELECTRON_RUN_AS_NODE: "1" };
}

function isolatedProcessEnvironment() {
  const environment = {
    ...runtimeBuildEnvironment(process.env),
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    APPDATA: isolatedAppData,
    LOCALAPPDATA: isolatedLocalAppData,
    TEMP: isolatedTemporaryDirectory,
    TMP: isolatedTemporaryDirectory,
    TMPDIR: isolatedTemporaryDirectory,
    // This is a controlled empty file, not an inherited npm setting. It stops
    // pnpm and lifecycle scripts from consulting a user npmrc containing auth.
    NPM_CONFIG_USERCONFIG: emptyNpmConfig
  };
  const inheritedPath = environment.PATH ?? environment.Path;
  delete environment.Path;
  environment.PATH = runtimeExecutablePath(inheritedPath, [repositoryRoot]);
  if (environment.PATH === "") throw new Error("No safe executable search path remains for isolated runtime staging.");
  return environment;
}

function runCommand(executable, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const append = (current, chunk) => `${current}${String(chunk)}`.slice(-256 * 1024);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const timeout = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    timeout.unref();
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`${options.label} could not start.`, { cause: error }));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0 && signal === null) resolvePromise({ stdout, stderr });
      else reject(new Error(`${options.label} failed (code=${String(code)}, signal=${String(signal)}): ${stderr.slice(-4_000)}`));
    });
  });
}

function captureBoundedOutput(child, maximumBytes) {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-maximumBytes); });
  child.stderr?.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-maximumBytes); });
  return () => ({ stdout, stderr });
}

async function waitForHealthyOrchestrator(origin, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Orchestrator exited before becoming healthy.");
    try {
      const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(500) });
      if (response.status === 200 && (await response.json())?.status === "ok") return;
    } catch {
      // The listener is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("Orchestrator did not become healthy before the smoke timeout.");
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("Child process did not exit before timeout."));
    }, timeoutMs);
    timeout.unref();
    const onExit = () => {
      clearTimeout(timeout);
      resolvePromise();
    };
    child.once("exit", onExit);
  });
}

function selectLoopbackPort(excluded = new Set()) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string" || excluded.has(address.port)) {
        server.close(() => selectLoopbackPort(excluded).then(resolvePromise, reject));
        return;
      }
      server.close((error) => error === undefined ? resolvePromise(address.port) : reject(error));
    });
  });
}

function samePath(left, right) {
  const first = resolve(left);
  const second = resolve(right);
  return process.platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second;
}

async function pruneRetainedWorkRoot() {
  for (const name of [
    "workspace",
    "pnpm-store",
    "orchestrator-smoke",
    "isolated-home",
    "isolated-app-data",
    "isolated-local-app-data",
    "isolated-temp"
  ]) {
    const path = join(workRoot, name);
    const info = await lstat(path).catch((error) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (info === undefined) continue;
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(path), path)) {
      throw new Error(`Retained candidate work child is unsafe: ${path}`);
    }
    await rm(path, { recursive: true, force: false });
  }
  const npmConfigInfo = await lstat(emptyNpmConfig).catch((error) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (npmConfigInfo !== undefined) {
    if (!npmConfigInfo.isFile() || npmConfigInfo.isSymbolicLink()) {
      throw new Error("Retained candidate npm config path is unsafe.");
    }
    await rm(emptyNpmConfig, { force: false });
  }
}
