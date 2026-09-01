import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { LocalRuntimeError } from "./errors.js";
import { managedRuntimeBinary, runtimeRoot, supportsManagedRuntimeInstall } from "./installer.js";
import { OllamaLoopbackClient } from "./ollama-client.js";
import { assertActiveOwner, assertPathWithin } from "./security.js";
import type { LocalRuntimeCapabilities, LocalRuntimeStatus, RuntimeOwnerGeneration } from "./types.js";

const MAC_APPLICATION = "/Applications/Ollama.app";
const MAC_OPEN = "/usr/bin/open";
const START_TIMEOUT_MS = 15_000;
const START_POLL_MS = 400;

export interface RuntimeLauncherOptions {
  readonly client: Pick<OllamaLoopbackClient, "version">;
  readonly dataRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
  readonly environment?: NodeJS.ProcessEnv;
  readonly exists?: (path: string) => boolean;
  readonly spawnProcess?: typeof spawn;
  readonly openApplication?: () => Promise<void>;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

interface RuntimeLaunchTarget {
  readonly source: "application" | "cli" | "managed_sidecar";
  readonly binary?: string;
}

function capabilities(input: { readonly install: boolean; readonly start: boolean; readonly ready: boolean }): LocalRuntimeCapabilities {
  return {
    canInstall: input.install,
    canStart: input.start,
    canListModels: input.ready,
    canPullModels: input.ready,
    canDeleteModels: input.ready,
    canPausePulls: input.ready
  };
}

function fixedCliCandidates(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): readonly string[] {
  if (platform === "win32") {
    return [
      ...(environment["LOCALAPPDATA"] === undefined ? [] : [join(environment["LOCALAPPDATA"], "Programs", "Ollama", "ollama.exe")]),
      ...(environment["ProgramFiles"] === undefined ? [] : [join(environment["ProgramFiles"], "Ollama", "ollama.exe")])
    ];
  }
  return ["/opt/homebrew/bin/ollama", "/usr/local/bin/ollama", "/usr/bin/ollama"];
}

function openMacApplication(): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(MAC_OPEN, ["-g", "-j", MAC_APPLICATION, "--args", "hidden"], { timeout: 5_000 }, (error) => {
      if (error === null) resolvePromise();
      else reject(new LocalRuntimeError("START_FAILED", "The local runtime application could not be opened."));
    });
  });
}

export class OllamaRuntimeLauncher {
  private readonly platform: NodeJS.Platform;
  private readonly arch: NodeJS.Architecture;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly exists: (path: string) => boolean;
  private readonly spawnProcess: typeof spawn;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private child: ChildProcess | undefined;
  private lastSource: LocalRuntimeStatus["source"] = "none";

  constructor(private readonly options: RuntimeLauncherOptions) {
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.environment = options.environment ?? process.env;
    this.exists = options.exists ?? existsSync;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
  }

  async status(owner?: RuntimeOwnerGeneration): Promise<LocalRuntimeStatus> {
    const target = await this.discover();
    const canInstall = supportsManagedRuntimeInstall(this.platform, this.arch) && target?.source !== "managed_sidecar";
    try {
      const version = await this.options.client.version();
      return {
        runtime: "ollama",
        state: "ready",
        source: this.lastSource === "none" ? "running" : this.lastSource,
        version,
        capabilities: capabilities({ install: canInstall, start: true, ready: true })
      };
    } catch (error) {
      if (error instanceof LocalRuntimeError && error.code === "PORT_CONFLICT") {
        return {
          runtime: "ollama",
          state: "port_conflict",
          source: "none",
          publicErrorCode: "PORT_CONFLICT",
          capabilities: capabilities({ install: false, start: false, ready: false })
        };
      }
      if (error instanceof LocalRuntimeError && error.code !== "RUNTIME_UNREACHABLE") {
        return {
          runtime: "ollama",
          state: "error",
          source: target?.source ?? "none",
          publicErrorCode: error.code,
          capabilities: capabilities({ install: canInstall, start: target !== undefined, ready: false })
        };
      }
      return {
        runtime: "ollama",
        state: target === undefined ? "absent" : "stopped",
        source: target?.source ?? "none",
        capabilities: capabilities({ install: canInstall, start: target !== undefined, ready: false })
      };
    }
  }

  async start(input: {
    readonly owner: RuntimeOwnerGeneration;
    readonly currentOwner: () => RuntimeOwnerGeneration | undefined;
    readonly signal?: AbortSignal;
  }): Promise<LocalRuntimeStatus> {
    assertActiveOwner(input.owner, input.currentOwner);
    const current = await this.status(input.owner);
    if (current.state === "ready" || current.state === "port_conflict") return current;
    const target = await this.discover();
    if (target === undefined) return current;
    try {
      if (target.source === "application") {
        await (this.options.openApplication ?? openMacApplication)();
      } else {
        const binary = target.binary;
        if (binary === undefined) throw new LocalRuntimeError("START_FAILED", "The runtime executable is missing.");
        if (target.source === "managed_sidecar") assertPathWithin(runtimeRoot(this.options.dataRoot), resolve(binary));
        this.stopManaged();
        const environment = {
          ...this.environment,
          OLLAMA_HOST: "127.0.0.1:11434",
          ...(target.source === "managed_sidecar" ? { OLLAMA_MODELS: join(runtimeRoot(this.options.dataRoot), "models") } : {})
        };
        const child = this.spawnProcess(binary, ["serve"], { stdio: "ignore", windowsHide: true, env: environment });
        this.child = child;
        child.once("exit", () => {
          if (this.child === child) this.child = undefined;
        });
      }
      this.lastSource = target.source;
      const deadline = this.now() + START_TIMEOUT_MS;
      while (this.now() < deadline) {
        if (input.signal?.aborted) throw new LocalRuntimeError("OPERATION_CANCELLED", "The operation was cancelled.");
        await this.sleep(START_POLL_MS);
        assertActiveOwner(input.owner, input.currentOwner);
        const status = await this.status(input.owner);
        if (status.state === "ready" || status.state === "port_conflict") return status;
      }
      throw new LocalRuntimeError("START_FAILED", "The local runtime did not become ready in time.");
    } catch (error) {
      if (error instanceof LocalRuntimeError && (error.code === "OWNER_CHANGED" || error.code === "OPERATION_CANCELLED")) this.stopManaged();
      if (error instanceof LocalRuntimeError) throw error;
      throw new LocalRuntimeError("START_FAILED", "The local runtime could not be started.");
    }
  }

  stopManaged(): void {
    const child = this.child;
    this.child = undefined;
    if (child !== undefined && !child.killed) child.kill("SIGTERM");
  }

  private async discover(): Promise<RuntimeLaunchTarget | undefined> {
    if (this.platform === "darwin" && this.exists(MAC_APPLICATION)) return { source: "application" };
    const cli = fixedCliCandidates(this.platform, this.environment).find((candidate) => this.exists(candidate));
    if (cli !== undefined) return { source: "cli", binary: cli };
    const managed = await managedRuntimeBinary(this.options.dataRoot);
    return managed === undefined ? undefined : { source: "managed_sidecar", binary: managed };
  }
}
