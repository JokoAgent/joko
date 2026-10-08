import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { hostname } from "node:os";

import { locateClaudeNativeRuntime } from "@joko/adapter-claude-code";
import {
  NodeDevicePeerAgentExecutor,
  NodeDevicePeerAgentLifecycle,
  type DevicePeerTerminalHandle,
  type DevicePeerTerminalStartRequest,
  type DevicePeerTerminalTransportPort,
  type NodeDevicePeerAgentConnection,
  type NodeDevicePeerAgentLifecycleOptions,
  type NodeDevicePeerRuntimeExecutableMap
} from "@joko/device-peer";
import {
  inspectKeyDirectoryPermissions,
  inspectPrivateKeyPermissions
} from "@joko/remote-ssh";
import { spawnTerminalHost, terminalEnvironment } from "@joko/tool-terminal";
import { DeviceKind } from "@joko/contracts";

import type { OrchestratorConfig } from "./config.js";

type ServiceDevicePeerAgentConfig = NonNullable<OrchestratorConfig["devicePeerAgent"]>;

export interface ServiceDevicePeerAgentOptions {
  readonly config: ServiceDevicePeerAgentConfig;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly createExecutor?: NodeDevicePeerAgentLifecycleOptions["createExecutor"];
  readonly validateCredential?: (credentialPath: string) => Promise<void>;
  readonly readAuthKey?: (credentialPath: string) => Promise<string | undefined>;
  readonly readDefaultDeviceName?: () => string;
  readonly runRoute?: NodeDevicePeerAgentLifecycleOptions["runRoute"];
  readonly wait?: NodeDevicePeerAgentLifecycleOptions["wait"];
  readonly retryBaseDelayMs?: number;
  readonly retryMaximumDelayMs?: number;
  readonly runtimeExecutables?: NodeDevicePeerRuntimeExecutableMap;
}

/**
 * Standalone Orchestrator host owner for a Service Device's outbound route.
 * Its controller identity and private credential file are deployment-owned;
 * it never reuses Desktop profile state or exposes an IPC surface.
 */
export class ServiceDevicePeerAgent {
  readonly #connection: NodeDevicePeerAgentConnection;
  readonly #credentialPath: string;
  readonly #validateCredential: (credentialPath: string) => Promise<void>;
  readonly #readAuthKey: (credentialPath: string) => Promise<string | undefined>;
  readonly #lifecycle: NodeDevicePeerAgentLifecycle;
  #started = false;
  #closed = false;

  constructor(options: ServiceDevicePeerAgentOptions) {
    this.#connection = Object.freeze({
      credentialId: options.config.connectionId,
      deviceId: options.config.deviceId,
      serverId: options.config.controllerServerId,
      origin: options.config.controllerOrigin,
      expectedDeviceKind: DeviceKind.SERVICE
    });
    this.#credentialPath = options.config.credentialPath;
    this.#validateCredential = options.validateCredential ?? validateServiceDevicePeerCredentialFile;
    this.#readAuthKey = options.readAuthKey ?? readServiceDevicePeerAuthKey;
    const terminal = serviceTerminalPort(options.environment ?? process.env);
    const createExecutor = options.createExecutor ?? (() => new NodeDevicePeerAgentExecutor({
      recentDirectoriesPath: serviceRecentDirectoriesPath(options.config),
      terminals: terminal,
      runtimeExecutables: options.runtimeExecutables ?? {}
    }));
    this.#lifecycle = new NodeDevicePeerAgentLifecycle({
      createExecutor,
      readDefaultDeviceName: options.readDefaultDeviceName ?? (() => hostname().trim() || "Unknown Device"),
      readAuthKey: (credentialId) => credentialId === this.#connection.credentialId
        ? this.#readAuthKey(this.#credentialPath)
        : Promise.resolve(undefined),
      isAuthorityCurrent: (candidate) => this.#started && !this.#closed
        && sameConnection(candidate, this.#connection),
      ...(options.runRoute === undefined ? {} : { runRoute: options.runRoute }),
      ...(options.wait === undefined ? {} : { wait: options.wait }),
      ...(options.retryBaseDelayMs === undefined ? {} : { retryBaseDelayMs: options.retryBaseDelayMs }),
      ...(options.retryMaximumDelayMs === undefined
        ? {}
        : { retryMaximumDelayMs: options.retryMaximumDelayMs })
    });
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error("The Service Device peer agent is closed.");
    if (this.#started) return;
    try {
      // Permission/shape metadata may fail startup, but bearer bytes remain
      // unread until the route anonymously proves the saved server identity.
      await this.#validateCredential(this.#credentialPath);
    } catch {
      throw new Error("The Service Device peer credential file is unavailable or unsafe.");
    }
    if (this.#closed) throw new Error("The Service Device peer agent is closed.");
    this.#started = true;
    this.#lifecycle.setConnection(this.#connection);
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#started = false;
    }
    await this.#lifecycle.dispose();
  }
}

/** Builds the process-local Service locator without projecting it into any
 * durable target/session binding. Explicit owner configuration wins; bundled
 * Node/Pi/Claude entries are resolved and identity-checked in this runtime. */
export async function createServiceDevicePeerRuntimeExecutables(
  config: Pick<OrchestratorConfig, "piExecutable" | "codexExecutable" | "claudeCodeExecutable">
): Promise<NodeDevicePeerRuntimeExecutableMap> {
  const nodeExecutable = await canonicalRuntimeExecutable(process.execPath);
  const nodeEnvironment = process.versions.electron === undefined
    ? undefined
    : Object.freeze({ ELECTRON_RUN_AS_NODE: "1" });
  const located: Record<string, unknown> = {
    node: Object.freeze({
      executable: nodeExecutable,
      ...(nodeEnvironment === undefined ? {} : { environment: nodeEnvironment })
    })
  };

  if (config.piExecutable !== undefined) {
    located["pi"] = Object.freeze({ executable: await canonicalRuntimeExecutable(config.piExecutable) });
  } else {
    const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const piRoot = resolve(dirname(piEntry), "..");
    const piManifest = await readRuntimeManifest(piRoot);
    if (piManifest["name"] !== "@earendil-works/pi-coding-agent"
      || piManifest["version"] !== "0.84.4"
      || !isRecord(piManifest["bin"])
      || piManifest["bin"]["pi"] !== "dist/bundle/cli.js") {
      throw new Error("The Service Device peer Pi locator is unavailable.");
    }
    located["pi"] = Object.freeze({
      executable: nodeExecutable,
      argumentPrefix: Object.freeze([
        await canonicalRuntimeExecutable(resolve(piRoot, "dist/bundle/cli.js"))
      ]),
      ...(nodeEnvironment === undefined ? {} : { environment: nodeEnvironment })
    });
  }

  if (config.codexExecutable !== undefined) {
    located["codex"] = Object.freeze({
      executable: await canonicalRuntimeExecutable(config.codexExecutable)
    });
  }

  const adapterEntry = await canonicalRuntimeExecutable(
    fileURLToPath(import.meta.resolve("@joko/adapter-claude-code"))
  );
  const adapterRoot = resolve(dirname(adapterEntry), "..");
  const managerEntry = await canonicalRuntimeExecutable(resolve(
    adapterRoot,
    "dist/remote-manager/device-peer-manager.mjs"
  ));
  const claudeExecutable = config.claudeCodeExecutable === undefined
    ? (await locateClaudeNativeRuntime({
        sdkEntry: await realpath(createRequire(adapterEntry).resolve("@anthropic-ai/claude-agent-sdk"))
      })).executable
    : await canonicalRuntimeExecutable(config.claudeCodeExecutable);
  located["claude"] = Object.freeze({
    executable: nodeExecutable,
    argumentPrefix: Object.freeze([managerEntry]),
    environment: Object.freeze({
      ...(nodeEnvironment ?? {}),
      JOKO_CLAUDE_EXECUTABLE: claudeExecutable,
      JOKO_CLAUDE_LOCATOR_MODE: "device-peer"
    })
  });

  return Object.freeze(located) as NodeDevicePeerRuntimeExecutableMap;
}

function serviceTerminalPort(environmentSource: Readonly<NodeJS.ProcessEnv>): DevicePeerTerminalTransportPort {
  const environment = Object.freeze(terminalEnvironment(environmentSource));
  return Object.freeze({
    async open(request: DevicePeerTerminalStartRequest): Promise<DevicePeerTerminalHandle> {
      const terminal = await spawnTerminalHost(request.executable, [...request.args], {
        cwd: request.cwd,
        cols: request.cols,
        rows: request.rows,
        env: environment
      }, request.signal);
      return {
        ...(terminal.pid === undefined ? {} : { pid: terminal.pid }),
        onData: (listener) => terminal.onData(listener),
        onExit: (listener) => terminal.onExit(listener),
        write: async (data) => { await terminal.write(data); },
        resize: async (cols, rows) => { await terminal.resize(cols, rows); },
        kill: async () => { await terminal.kill(); },
        pause: () => terminal.pause(),
        resume: () => terminal.resume()
      };
    }
  });
}

export async function validateServiceDevicePeerCredentialFile(path: string): Promise<void> {
  const directory = dirname(path);
  const signal = new AbortController().signal;
  await inspectKeyDirectoryPermissions(directory, signal);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  let permissionLease: Awaited<ReturnType<typeof inspectPrivateKeyPermissions>> | undefined;
  try {
    permissionLease = await inspectPrivateKeyPermissions(directory, basename(path), handle, signal);
    const information = await handle.stat();
    if (!information.isFile() || information.isSymbolicLink()
      || information.size < 43 || information.size > 45) {
      throw new Error("unsafe");
    }
    await permissionLease.verifyFinal();
  } finally {
    await permissionLease?.close().catch(() => undefined);
    await handle.close().catch(() => undefined);
  }
}

export async function readServiceDevicePeerAuthKey(path: string): Promise<string | undefined> {
  const directory = dirname(path);
  const signal = new AbortController().signal;
  await inspectKeyDirectoryPermissions(directory, signal);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  let permissionLease: Awaited<ReturnType<typeof inspectPrivateKeyPermissions>> | undefined;
  let bytes: Buffer | undefined;
  let sentinel: Buffer | undefined;
  try {
    permissionLease = await inspectPrivateKeyPermissions(directory, basename(path), handle, signal);
    const information = await handle.stat();
    if (!information.isFile() || information.isSymbolicLink() || information.size < 43 || information.size > 45) {
      return undefined;
    }
    bytes = Buffer.alloc(information.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    sentinel = Buffer.alloc(1);
    const extra = await handle.read(sentinel, 0, 1, offset);
    if (offset !== bytes.byteLength || extra.bytesRead !== 0) return undefined;
    await permissionLease.verifyFinal();
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const match = /^([A-Za-z0-9_-]{43})(?:\r?\n)?$/u.exec(value);
    return match?.[1];
  } catch {
    return undefined;
  } finally {
    bytes?.fill(0);
    sentinel?.fill(0);
    await permissionLease?.close().catch(() => undefined);
    await handle.close().catch(() => undefined);
  }
}

function serviceRecentDirectoriesPath(config: ServiceDevicePeerAgentConfig): string {
  return join(config.stateDirectory, "recent-directories.json");
}

function sameConnection(
  left: NodeDevicePeerAgentConnection,
  right: NodeDevicePeerAgentConnection
): boolean {
  return left.credentialId === right.credentialId
    && left.deviceId === right.deviceId
    && left.serverId === right.serverId
    && left.expectedDeviceKind === right.expectedDeviceKind
    && left.origin === right.origin;
}

async function readRuntimeManifest(root: string): Promise<Record<string, unknown>> {
  const bytes = await readFile(await canonicalRuntimeExecutable(resolve(root, "package.json")));
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!isRecord(value)) throw new Error("The Service Device peer runtime locator is unavailable.");
    return value;
  } finally {
    bytes.fill(0);
  }
}

async function canonicalRuntimeExecutable(pathValue: string): Promise<string> {
  if (!isAbsolute(pathValue) || resolve(pathValue) !== pathValue) {
    throw new Error("The Service Device peer runtime locator is unavailable.");
  }
  const information = await lstat(pathValue);
  if (!information.isFile() || information.isSymbolicLink()) {
    throw new Error("The Service Device peer runtime locator is unavailable.");
  }
  const canonical = await realpath(pathValue);
  if (process.platform === "win32"
    ? canonical.toLowerCase() !== pathValue.toLowerCase()
    : canonical !== pathValue) {
    throw new Error("The Service Device peer runtime locator is unavailable.");
  }
  return canonical;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
