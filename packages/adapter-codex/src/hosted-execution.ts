import { randomUUID } from "node:crypto";
import { realpath, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { assertHostedExecution, hostedExecutionEnvironmentNote, type AdapterContext, type HostedExecution } from "@joko/core";
import type { AppServerHost } from "./host.js";
import type { JsonObject } from "./protocol.js";
import type { CodexMcpSessionInput, CodexMcpRuntimeLease } from "./adapter.js";
import { CODEX_HOSTED_GUEST_THREAD_CONFIG, assertNoCodexUserInstructions, codexGuestFeatureOverrides, listCodexFeatures } from "./hosted-guest.js";

/** Private native execution transport. Never persist these values in a Session. */
export interface CodexHostedExecServerLease {
  readonly execServerUrl: string;
  readonly authBearerToken: string;
  readonly assertCurrent: () => void;
  close(): Promise<void>;
}
export interface CodexHostedExecutionOptions {
  readonly execution: HostedExecution;
  readonly openExecServer: (execution: HostedExecution) => Promise<CodexHostedExecServerLease>;
  /** Source-owned MCP facade; never use the model computer's local catalog. */
  readonly openMcpBridge?: (input: CodexMcpSessionInput) => Promise<CodexMcpRuntimeLease>;
}

/** One dedicated app-server's Source execution environment and isolated policy. */
export class CodexHostedExecution {
  readonly #options: CodexHostedExecutionOptions;
  readonly #environmentId = "joko-source-" + randomUUID();
  #lease?: CodexHostedExecServerLease;
  #prepared?: { host: AppServerHost; generation: number; configuration: JsonObject };
  #flight?: Promise<void>;
  #closed = false;
  constructor(options: CodexHostedExecutionOptions) { assertHostedExecution(options.execution); this.#options = options; }
  get execution(): HostedExecution { return this.#options.execution; }
  assertCurrent(): void {
    if (this.#closed) throw new Error("The hosted native execution environment is closed.");
    assertHostedExecution(this.execution); this.#lease?.assertCurrent();
  }
  assertContext(context: AdapterContext): void {
    this.assertCurrent(); const selected = context.hostedExecution, own = this.execution;
    if (!selected || selected.channel.endpoint !== own.channel.endpoint || selected.channel.bearer !== own.channel.bearer
      || selected.source.sessionId !== own.source.sessionId || selected.source.targetId !== own.source.targetId
      || selected.source.generation !== own.source.generation || selected.trust !== own.trust
      || selected.workspace.root !== own.workspace.root) throw new Error("The native Session belongs to another task executor.");
    assertHostedExecution(selected);
  }
  assertModel(providerId: string | undefined, modelId: string | undefined): void {
    this.assertCurrent(); const own = this.execution;
    if (own.trust === "guest" && (providerId !== own.providerId || !modelId || !own.modelIds.includes(modelId))) {
      throw new Error("The selected Provider or model is not shared with this task.");
    }
  }
  environments(): JsonObject {
    this.assertCurrent(); const workspace = this.execution.workspace;
    return { environments: [{ environmentId: this.#environmentId, cwd: workspace.root,
      runtimeWorkspaceRoots: [workspace.root, ...workspace.additionalRoots] }] };
  }
  instructions(instructions?: string): string {
    return [instructions?.trim(), hostedExecutionEnvironmentNote(this.execution)].filter(Boolean).join("\n\n");
  }
  configuration(): JsonObject {
    this.assertCurrent(); if (!this.#prepared) throw new Error("The hosted native environment is not prepared.");
    return { ...this.#prepared.configuration };
  }
  async prepare(host: AppServerHost, profileDirectory: string, signal: AbortSignal): Promise<void> {
    this.assertCurrent(); const generation = await host.ensureStarted();
    if (this.#prepared?.host === host && this.#prepared.generation === generation) return;
    if (this.#flight) { await this.#flight; return this.prepare(host, profileDirectory, signal); }
    const flight = this.#prepare(host, generation, profileDirectory, signal); this.#flight = flight;
    try { await flight; } finally { if (this.#flight === flight) this.#flight = undefined; }
  }
  async #prepare(host: AppServerHost, generation: number, profileDirectory: string, signal: AbortSignal): Promise<void> {
    const assert = () => { this.assertCurrent(); signal.throwIfAborted(); if (!host.isActiveGeneration(generation)) throw new Error("The hosted native process changed."); };
    assert(); const own = this.execution;
    if (own.trust === "guest") {
      const actual = host.initializeResult?.codexHome;
      const homeInfo = await lstat(own.guestHome);
      if (!homeInfo.isDirectory() || homeInfo.isSymbolicLink() || !actual
        || await realpath(actual) !== await realpath(own.guestHome)
        || await realpath(profileDirectory) !== await realpath(own.guestHome)
        || resolve(own.guestHome) !== await realpath(own.guestHome)) throw new Error("The shared native process has no isolated Codex home.");
      await assertNoCodexUserInstructions(actual);
    }
    const effective = await host.request("config/read", { includeLayers: false }, { signal, beforeDispatch: assert });
    const config = effective.value && typeof effective.value === "object" && !Array.isArray(effective.value) ? effective.value["config"] : undefined;
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("The native configuration could not be isolated.");
    const mcp = config["mcp_servers"];
    if (mcp !== undefined && (!mcp || typeof mcp !== "object" || Array.isArray(mcp))) throw new Error("The native MCP configuration could not be isolated.");
    const configuration: JsonObject = { "memories.generate_memories": false, "memories.use_memories": false };
    for (const name of Object.keys(mcp ?? {})) {
      if (!name || name.length > 512 || /[\u0000-\u001f\u007f]/u.test(name)) throw new Error("The native MCP identity is invalid.");
      configuration[`mcp_servers.${JSON.stringify(name)}.enabled`] = false;
    }
    if (own.trust === "guest") Object.assign(configuration, CODEX_HOSTED_GUEST_THREAD_CONFIG,
      codexGuestFeatureOverrides(await listCodexFeatures(async cursor => {
        const page = await host.request("experimentalFeature/list", { limit: 200, ...(cursor ? { cursor } : {}) }, { signal, beforeDispatch: assert });
        return page.value;
      })));
    assert();
    this.#lease ??= await this.#options.openExecServer(own); assert();
    const url = new URL(this.#lease.execServerUrl);
    if (url.protocol !== "ws:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || !url.port
      || url.username || url.password || url.search || url.hash || url.pathname !== "/ws/exec-server"
      || !/^[A-Za-z0-9_-]{32,256}$/u.test(this.#lease.authBearerToken)) throw new Error("The native execution relay is invalid.");
    await host.request("environment/add", { environmentId: this.#environmentId,
      execServerUrl: this.#lease.execServerUrl, authBearerToken: this.#lease.authBearerToken }, { signal, beforeDispatch: assert });
    assert(); this.#prepared = { host, generation, configuration };
  }
  async close(): Promise<void> { this.#closed = true; await this.#lease?.close(); }
}
