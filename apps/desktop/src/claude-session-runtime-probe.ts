import * as crypto from "node:crypto";
import * as filesystem from "node:fs/promises";
import * as moduleApi from "node:module";
import * as paths from "node:path";

/** Audits the relocated built Session SDK owner and its published SDK dependency. */
export async function auditClaudeSessionRuntimeAssets(runtimeArgument: string) {
  return inspectClaudeSessionRuntimeAssets(runtimeArgument, { crypto, filesystem, moduleApi, paths });
}

async function inspectClaudeSessionRuntimeAssets(runtimeArgument: string, dependencies: {
  readonly crypto: typeof crypto;
  readonly filesystem: typeof filesystem;
  readonly moduleApi: typeof moduleApi;
  readonly paths: typeof paths;
}) {
  const { createHash } = dependencies.crypto;
  const { lstat, readFile, realpath } = dependencies.filesystem;
  const { createRequire } = dependencies.moduleApi;
  const { isAbsolute, relative, resolve, sep } = dependencies.paths;
  if (!isAbsolute(runtimeArgument) || resolve(runtimeArgument) !== runtimeArgument) {
    throw new Error("The Session SDK audit requires a normalized absolute runtime root.");
  }
  const runtimeRoot = await realpath(runtimeArgument);
  if (!samePath(runtimeRoot, runtimeArgument)) throw new Error("The Session SDK runtime root is not canonical.");
  const runtimeRequire = createRequire(await regularFile(runtimeRoot, resolve(runtimeRoot, "package.json")));
  const adapterRoot = resolve(runtimeRoot, "node_modules/@joko/adapter-claude-code");
  const adapterManifest = JSON.parse(await readFile(await regularFile(adapterRoot, resolve(adapterRoot, "package.json")), "utf8")) as {
    name?: string; exports?: Record<string, unknown>;
  };
  if (adapterManifest.name !== "@joko/adapter-claude-code" || adapterManifest.exports?.["."] !== "./dist/index.js") {
    throw new Error("The Session SDK runtime requires the built adapter package entry.");
  }
  await regularFile(adapterRoot, runtimeRequire.resolve("@joko/adapter-claude-code"));
  const runtimeEntry = await regularFile(adapterRoot, resolve(adapterRoot, "dist/sdk-runtime.js"));
  const ownerEntry = await regularFile(adapterRoot, resolve(adapterRoot, "dist/session-sdk-owner.js"));
  const workerEntry = await regularFile(adapterRoot, resolve(adapterRoot, "dist/session-sdk-worker.mjs"));
  const managerEntry = await regularFile(adapterRoot, resolve(adapterRoot, "dist/remote-manager/manager.mjs"));
  const sdkRoot = resolve(runtimeRoot, "node_modules/@anthropic-ai/claude-agent-sdk");
  const sdkManifest = JSON.parse(await readFile(await regularFile(sdkRoot, resolve(sdkRoot, "package.json")), "utf8")) as {
    name?: string; version?: string; main?: string;
  };
  if (sdkManifest.name !== "@anthropic-ai/claude-agent-sdk" || sdkManifest.version !== "0.3.259" || sdkManifest.main !== "sdk.mjs") {
    throw new Error("The Session SDK runtime requires the audited published SDK 0.3.259.");
  }
  // Resolve from the actual Worker location, just as its dynamic import does.
  const sdkEntry = await regularFile(sdkRoot, createRequire(workerEntry).resolve("@anthropic-ai/claude-agent-sdk"));
  if (!samePath(sdkEntry, resolve(sdkRoot, sdkManifest.main))) throw new Error("The Session SDK resolved an unexpected entry.");
  const assets = await Promise.all([runtimeEntry, ownerEntry, workerEntry, managerEntry, sdkEntry].map(async (path) => ({
    path, sha256: createHash("sha256").update(await readFile(path)).digest("hex")
  })));
  return { runtimeRoot, runtimeEntry, ownerEntry, workerEntry, managerEntry, sdkEntry, version: sdkManifest.version, assets };

  function samePath(left: string, right: string) {
    return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
  }
  async function regularFile(root: string, path: string) {
    const lexical = relative(root, path);
    if (lexical === ".." || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) throw new Error("A Session SDK asset escapes its package.");
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("A Session SDK asset is not a regular file.");
    const canonical = await realpath(path);
    if (!samePath(canonical, path)) throw new Error("A Session SDK asset is not canonical.");
    return canonical;
  }
}

/** Reads an absent isolated Session through the production Worker, without starting a Query. */
export function claudeSessionElectronSmokeSource(platform: string, arch: string): string {
  return `
import * as crypto from "node:crypto";
import * as filesystem from "node:fs/promises";
import * as moduleApi from "node:module";
import * as paths from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
const expected = ${JSON.stringify({ platform, arch })};
if (!process.versions.electron || process.platform !== expected.platform || process.arch !== expected.arch) {
  throw new Error("The Session SDK smoke requires the matching Electron-Node target.");
}
const inspectClaudeSessionRuntimeAssets = ${inspectClaudeSessionRuntimeAssets.toString()};
const inspected = await inspectClaudeSessionRuntimeAssets(process.argv[2], { crypto, filesystem, moduleApi, paths });
const temporaryRoot = await filesystem.mkdtemp(paths.join(await filesystem.realpath(tmpdir()), "joko-session-sdk-smoke-"));
const profile = paths.join(temporaryRoot, "profile");
const workspace = paths.join(temporaryRoot, "workspace");
let runtime;
try {
  await filesystem.mkdir(profile, { mode: 0o700 });
  await filesystem.mkdir(workspace, { mode: 0o700 });
  const { DefaultClaudeSdkRuntime } = await import(pathToFileURL(inspected.runtimeEntry).href);
  runtime = new DefaultClaudeSdkRuntime({
    environment: { CLAUDE_CONFIG_DIR: profile }, sessionOperationTimeoutMs: 15000, retirementTimeoutMs: 5000
  });
  const result = await runtime.getSessionInfo(crypto.randomUUID(), { dir: workspace, signal: AbortSignal.timeout(20000) });
  if (result !== undefined) throw new Error("The isolated Session SDK smoke returned unexpected Session data.");
  await runtime.closeSessionOperations();
  if ((await filesystem.readdir(profile)).length !== 0 || (await filesystem.readdir(workspace)).length !== 0) {
    throw new Error("The read-only Session SDK smoke wrote into its isolated profile or workspace.");
  }
} finally {
  try { await runtime?.closeSessionOperations(); }
  finally { await filesystem.rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}
// The parent also requires natural process exit; no process.exit hides a leaked Worker.
process.stdout.write(JSON.stringify({ ok: true, ...inspected, electronVersion: process.versions.electron,
  nodeVersion: process.versions.node, modulesVersion: process.versions.modules,
  missingSession: true, workerRetired: true, isolatedProfileUnchanged: true }));
`;
}
