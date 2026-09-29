import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import type { NodeDevicePeerRuntimeExecutableMap } from "@joko/device-peer";

import { auditClaudeSessionRuntimeAssets } from "./claude-session-runtime-probe.js";
import { auditTerminalRuntimeAssets } from "./terminal-runtime-probe.js";

interface StagedCodexExecutableModule {
  discoverCodexExecutable(environment?: NodeJS.ProcessEnv): string | undefined;
}

interface StagedClaudeNativeLocatorModule {
  locateClaudeNativeRuntime(options: {
    readonly sdkEntry: string;
    readonly platform?: NodeJS.Platform;
    readonly arch?: string;
    readonly preferMusl?: boolean;
  }): Promise<{ readonly executable: string }>;
}

/**
 * Resolves process-local runtime identities only after the staged runtime and
 * each selected entry have been authenticated. The resulting map stays in the
 * Desktop main process and is never projected into renderer or durable state.
 */
export async function createAuditedDesktopDevicePeerRuntimeExecutables(options: {
  readonly runtimeRoot: string;
  readonly electronExecutable: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly preferMusl?: boolean;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
}): Promise<NodeDevicePeerRuntimeExecutableMap> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const [terminalAudit, claudeAudit] = await Promise.all([
    auditTerminalRuntimeAssets(options.runtimeRoot, platform, arch),
    auditClaudeSessionRuntimeAssets(options.runtimeRoot)
  ]);
  const runtimeRoot = terminalAudit.runtimeRoot;
  if (!samePath(runtimeRoot, claudeAudit.runtimeRoot)) {
    throw new Error("The staged Device peer runtime audits resolved different roots.");
  }
  const electronExecutable = await canonicalRegularFile(options.electronExecutable);
  const nodeEnvironment = Object.freeze({ ELECTRON_RUN_AS_NODE: "1" });

  const piRoot = resolve(runtimeRoot, "node_modules/@earendil-works/pi-coding-agent");
  const piManifest = await readManifest(piRoot, "package.json");
  if (piManifest["name"] !== "@earendil-works/pi-coding-agent"
    || piManifest["version"] !== "0.84.4"
    || !isRecord(piManifest["bin"])
    || piManifest["bin"]["pi"] !== "dist/bundle/cli.js") {
    throw new Error("The staged Device peer Pi runtime has an unexpected identity.");
  }
  const piEntry = await containedRegularFile(piRoot, resolve(piRoot, "dist/bundle/cli.js"));

  const located: Record<string, unknown> = {
    node: Object.freeze({ executable: electronExecutable, environment: nodeEnvironment }),
    pi: Object.freeze({
      executable: electronExecutable,
      argumentPrefix: Object.freeze([piEntry]),
      environment: nodeEnvironment
    })
  };

  const codexModulePath = await containedRegularFile(runtimeRoot, resolve(runtimeRoot, "dist/codex-executable.js"));
  const codexModule: unknown = await import(pathToFileURL(codexModulePath).href);
  if (!isStagedCodexExecutableModule(codexModule)) {
    throw new Error("The staged Device peer Codex locator is invalid.");
  }
  const codexExecutable = codexModule.discoverCodexExecutable({ ...(options.environment ?? process.env) });
  if (codexExecutable !== undefined) {
    located["codex"] = Object.freeze({ executable: await canonicalRegularFile(codexExecutable) });
  }

  const adapterRoot = resolve(dirname(claudeAudit.runtimeEntry), "..");
  const claudeLocatorPath = await containedRegularFile(
    adapterRoot,
    resolve(adapterRoot, "dist/native-runtime-locator.js")
  );
  const claudeLocator: unknown = await import(pathToFileURL(claudeLocatorPath).href);
  if (!isStagedClaudeNativeLocatorModule(claudeLocator)) {
    throw new Error("The staged Device peer Claude locator is invalid.");
  }
  const claude = await claudeLocator.locateClaudeNativeRuntime({
    sdkEntry: claudeAudit.sdkEntry,
    platform,
    arch,
    ...(options.preferMusl === undefined ? {} : { preferMusl: options.preferMusl })
  });
  located["claude"] = Object.freeze({
    executable: electronExecutable,
    argumentPrefix: Object.freeze([claudeAudit.managerEntry]),
    environment: Object.freeze({
      ...nodeEnvironment,
      JOKO_CLAUDE_EXECUTABLE: claude.executable,
      JOKO_CLAUDE_LOCATOR_MODE: "device-peer"
    })
  });

  return Object.freeze(located) as NodeDevicePeerRuntimeExecutableMap;
}

/** Selects the exact staged runtime used by both Desktop development and the
 * packaged application. The development build emits main.js beside the staged
 * runtime, while packaging relocates the same tree under resources. */
export function resolveDesktopDevicePeerRuntimeRoot(options: {
  readonly packaged: boolean;
  readonly resourcesPath: string;
  readonly sourceDirectory: string;
}): string {
  const base = options.packaged ? options.resourcesPath : options.sourceDirectory;
  if (!isAbsolute(base) || resolve(base) !== base) {
    throw new Error("The Desktop Device peer runtime base is invalid.");
  }
  return resolve(base, "orchestrator-runtime");
}

async function readManifest(root: string, name: string): Promise<Record<string, unknown>> {
  const path = await containedRegularFile(root, resolve(root, name));
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(value)) throw new Error("A staged Device peer runtime manifest is invalid.");
  return value;
}

async function containedRegularFile(rootValue: string, pathValue: string): Promise<string> {
  const root = resolve(rootValue);
  const path = resolve(pathValue);
  const child = relative(root, path);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("A staged Device peer runtime entry escapes its package.");
  }
  return canonicalRegularFile(path);
}

async function canonicalRegularFile(pathValue: string): Promise<string> {
  const path = resolve(pathValue);
  if (!isAbsolute(pathValue) || path !== pathValue) {
    throw new Error("A Device peer runtime executable path is invalid.");
  }
  const information = await lstat(path);
  if (!information.isFile() || information.isSymbolicLink()) {
    throw new Error("A Device peer runtime executable is not a regular file.");
  }
  const canonical = await realpath(path);
  if (!samePath(canonical, path)) throw new Error("A Device peer runtime executable is not canonical.");
  return canonical;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isStagedCodexExecutableModule(value: unknown): value is StagedCodexExecutableModule {
  return isRecord(value) && typeof value["discoverCodexExecutable"] === "function";
}

function isStagedClaudeNativeLocatorModule(value: unknown): value is StagedClaudeNativeLocatorModule {
  return isRecord(value) && typeof value["locateClaudeNativeRuntime"] === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
