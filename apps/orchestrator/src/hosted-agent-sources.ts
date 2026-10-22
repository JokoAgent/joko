import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { CAPABILITIES, JokoError, type AdapterContext, type BackendDescriptor, type Capability, type ProviderModel } from "@joko/core";
import { HostedAgentSourceAdapter, type HostedAgentDeviceSource } from "@joko/adapter-hosted";
import { TaskShareStore, type ConnectionRecord, type OperationalStore } from "@joko/store";
import type { BackendInstanceRegistry } from "./backend-instance-registry.js";
import type { DevicePeerOwner } from "./device-peer-owner.js";
import type { SessionHost } from "./session-host.js";
import type { HostedAgentExecutorPolicy } from "./hosted-agent-executor.js";
import { HostedAgentConnectClient } from "./hosted-agent-connect-client.js";
import { HostedAgentPoller } from "./hosted-agent-poller.js";
import { createHostedAgentPeerTransport } from "./hosted-agent-peer-transport.js";
import { createHostedAgentSourceController } from "./hosted-agent-source-controller.js";
import { fromProtoCapability, fromProtoTimestamp } from "./proto-mapper.js";
import { snapshotSourceProjectFiles } from "./hosted-agent-project-files.js";
import type { CommandConcurrencyGate } from "@joko/runtime-governance";
import type { HostedAgentClaudeWebFetchOptions } from "./hosted-agent-claude-web-network.js";
import type { BlobRef } from "@joko/core";

const SCOPE = "hosted-sources.v1";
const FORWARDED = new Set(["session.resume", "session.detach", "session.tree", "turn.stream", "turn.abort", "turn.steer", "turn.follow_up", "input.text",
  "input.image", "model.list", "model.switch", "model.effort", "model.fast_mode", "permission.modes", "permission.change", "plan_mode", "context.usage", "context.compact",
  "context.auto_compact", "context.auto_retry", "workspace.files", "workspace.files.watch", "workspace.files.write", "workspace.diff", "workspace.generated_files",
  "runtime.commands", "runtime.tools", "runtime.user_shell", "interaction.permission", "interaction.question", "interaction.plan_review"]);
interface SourceRecord {
  readonly format: 1;
  readonly source: HostedAgentDeviceSource;
  readonly deviceName: string;
  readonly catalog: JsonValue;
  readonly remoteControlEnabled: boolean;
}
interface SourceEntry { readonly id: string; record: SourceRecord; catalog: contract.HostedAgentBackendCatalog; available: boolean; }
interface Pool { readonly client: HostedAgentConnectClient; readonly poller: HostedAgentPoller; readonly assertCurrent: () => void; }
export interface HostedAgentSourcesOptions {
  readonly store: OperationalStore; readonly peers: DevicePeerOwner; readonly registry: BackendInstanceRegistry;
  readonly host: SessionHost; readonly temporaryRoot: string; readonly readPolicy: (context: AdapterContext) => HostedAgentExecutorPolicy;
  readonly commandConcurrencyGate?: CommandConcurrencyGate;
  readonly resolveCodexExecutable?: () => Promise<string | undefined>;
  readonly readBlob: (blob: BlobRef) => Promise<Uint8Array>;
  readonly resolveProxy?: HostedAgentClaudeWebFetchOptions["resolveProxy"];
  readonly environmentProxyForTarget?: HostedAgentClaudeWebFetchOptions["environmentProxyForTarget"];
}
const runFile = promisify(execFile);

/** Owns durable model-source identities independently of browser Connections
 * and local native installations. Discovery never creates a product task. */
export class HostedAgentSources {
  readonly #options: HostedAgentSourcesOptions;
  readonly #entries = new Map<string, SourceEntry>();
  readonly #refreshing = new Map<string, Promise<void>>();
  readonly #pools = new Map<string, Pool>();
  #closed = false;
  #discoveryClosed = false;
  constructor(options: HostedAgentSourcesOptions) { this.#options = options; }
  async initialize(): Promise<void> {
    for (const row of this.#options.store.listSettingsByKeyPrefix("service", SCOPE, "source:")) {
      const record = parseRecord(row.value), id = sourceId(record.source);
      if (row.key !== `source:${id}`) throw new Error("The saved native source identity conflicts.");
      const catalog = parseCatalog(record.catalog, record.source.backendId), entry = { id, record, catalog, available: false };
      this.#entries.set(id, entry); await this.#install(entry);
    }
  }
  source(backendId: string): HostedAgentDeviceSource | undefined { return this.#entries.get(backendId)?.record.source; }
  modelAvailable(backendId: string, providerId: string, modelId: string): boolean | undefined {
    const entry = this.#entries.get(backendId); if (!entry) return undefined;
    return entry.available && entry.record.remoteControlEnabled && entry.catalog.providers.some(provider => provider.providerId === providerId
      && provider.connected && provider.remoteInvocationEnabled && provider.models.some(model => model.key?.modelId === modelId));
  }
  refresh(connection: ConnectionRecord): Promise<void> {
    if (this.#closed || this.#discoveryClosed) return Promise.reject(new Error("Native source discovery is closed."));
    const pending = this.#refreshing.get(connection.deviceId); if (pending) return pending;
    const refreshing = this.#refresh(connection).finally(() => { if (this.#refreshing.get(connection.deviceId) === refreshing) this.#refreshing.delete(connection.deviceId); });
    this.#refreshing.set(connection.deviceId, refreshing); return refreshing;
  }
  async close(): Promise<void> {
    await this.stopDiscovery(); this.#closed = true;
    await Promise.all([...this.#pools.values()].map(pool => pool.poller.close())); this.#pools.clear();
  }
  async stopDiscovery(): Promise<void> { this.#discoveryClosed = true; await Promise.allSettled([...this.#refreshing.values()]); }
  async #refresh(connection: ConnectionRecord): Promise<void> {
    const visible = this.#options.peers.listForCapabilities(connection, ["native_agents"]);
    const outcomes = await Promise.allSettled(visible.map(async device => {
      const source = { controllerDeviceId: connection.deviceId, targetDeviceId: device.targetDeviceId }, pool = this.#pool(source);
      const snapshot = await pool.client.catalog(AbortSignal.timeout(15_000)); pool.assertCurrent();
      if (snapshot.backends.length > 64) throw new Error("The native source catalog is too large.");
      const catalogs = snapshot.backends.map(catalog => parseCatalog(toJson(contract.HostedAgentBackendCatalogSchema, catalog), catalog.backendId));
      if (new Set(catalogs.map(catalog => catalog.backendId)).size !== catalogs.length) throw new Error("The native source catalog has duplicate identities.");
      for (const catalog of catalogs) {
        const identity = { ...source, backendId: catalog.backendId }, id = sourceId(identity);
        const record: SourceRecord = { format: 1, source: identity, deviceName: device.displayName, catalog: toJson(contract.HostedAgentBackendCatalogSchema, catalog),
          remoteControlEnabled: snapshot.remoteControlEnabled };
        const prior = this.#entries.get(id), entry = prior ?? { id, record, catalog, available: true };
        entry.record = record; entry.catalog = catalog; entry.available = true; this.#entries.set(id, entry);
        this.#options.store.setSetting("service", SCOPE, `source:${id}`, record);
        if (prior) await this.#options.registry.refresh(id); else await this.#install(entry);
      }
      return catalogs.map(catalog => sourceId({ ...source, backendId: catalog.backendId }));
    }));
    const seen = new Set(outcomes.flatMap(outcome => outcome.status === "fulfilled" ? outcome.value : []));
    // A failed or incomplete node response does not erase its last known
    // identities. They remain unavailable until an authoritative refresh.
    for (const entry of this.#entries.values()) if (entry.record.source.controllerDeviceId === connection.deviceId && !seen.has(entry.id)) {
      entry.available = false; await this.#options.registry.refresh(entry.id);
    }
  }
  async #install(entry: SourceEntry): Promise<void> {
    const snapshot = await this.#options.registry.add({ instanceId: entry.id, adapterKind: "hosted", displayName: entry.catalog.displayName,
      create: ({ generation }) => new HostedAgentSourceAdapter({ id: entry.id, source: entry.record.source, describe: () => this.#descriptor(entry),
        onRuntimeUnavailable: context => this.#options.host.invalidateRuntime({ backendId: entry.id, backendInstanceGeneration: generation,
          sessionId: context.sessionId, generation: context.generation }),
        readPolicy: context => {
          const policy = this.#options.readPolicy(context), session = this.#session(context.sessionId);
          return { permissionMode: policy.permissionMode, fastMode: session?.fastMode ?? false, ...(session?.effort === undefined ? {} : { effort: session.effort }) };
        }, assertContext: context => this.#assertContext(context),
        workspace: async context => {
          this.#assertContext(context);
          let isGitRepository = false;
          try { isGitRepository = (await runFile("git", ["rev-parse", "--is-inside-work-tree"], {
            cwd: context.target.workspaceRoot, signal: context.signal, timeout: 5000, windowsHide: true, maxBuffer: 1024
          })).stdout.trim() === "true"; } catch { context.signal.throwIfAborted(); }
          const contextFiles = await snapshotSourceProjectFiles(context, { assertCurrent: () => this.#assertContext(context) });
          this.#assertContext(context);
          return { platform: process.platform as "win32" | "linux" | "darwin", shell: "bash", isGitRepository, contextFiles,
            ...(context.appendSystemPrompt === undefined ? {} : { personalInstructions: context.appendSystemPrompt }) };
        },
        capture: async (runId, context) => {
          this.#assertContext(context); const pool = this.#pool(entry.record.source);
          const codexExecutable = await this.#options.resolveCodexExecutable?.(); this.#assertContext(context); pool.assertCurrent();
          const authority = this.#options.peers.captureBinding(entry.record.source.controllerDeviceId, entry.record.source.targetDeviceId, ["native_agents"]);
          const cleanup = this.#options.peers.captureHostedAgentCleanup(authority, runId);
          return { client: pool.client, assertCurrent: pool.assertCurrent, close: cleanup,
            createController: input => createHostedAgentSourceController({ ...input, poller: pool.poller, temporaryRoot: this.#options.temporaryRoot,
              readPolicy: this.#options.readPolicy, assertContext: sourceContext => this.#assertContext(sourceContext), assertCurrent: pool.assertCurrent,
              ...(codexExecutable === undefined ? {} : { codexExecutable }),
              readBlob: blob => this.#options.readBlob(blob),
              ...(this.#options.resolveProxy === undefined ? {} : { resolveProxy: this.#options.resolveProxy }),
              ...(this.#options.environmentProxyForTarget === undefined ? {} : { environmentProxyForTarget: this.#options.environmentProxyForTarget }),
              ...(this.#options.commandConcurrencyGate === undefined ? {} : { commandConcurrencyGate: this.#options.commandConcurrencyGate }) }) };
        } }) });
    const adapter = this.#options.registry.adapter(entry.id); if (!adapter || snapshot.state !== "available") throw new Error("The native source Adapter could not be installed.");
    this.#options.host.installBackendInstance(adapter, snapshot.descriptor);
  }
  #pool(source: Pick<HostedAgentDeviceSource, "controllerDeviceId" | "targetDeviceId">): Pool {
    const authority = this.#options.peers.captureBinding(source.controllerDeviceId, source.targetDeviceId, ["native_agents"]);
    const key = JSON.stringify([source.controllerDeviceId, source.targetDeviceId, authority.identity.relationRevision.toString(), authority.identity.routeGeneration]);
    const prior = this.#pools.get(key); if (prior) { prior.assertCurrent(); return prior; }
    const assertCurrent = () => { if (this.#closed) throw new Error("Native sources are closed."); authority.assertCurrent(["native_agents"]); };
    const client = new HostedAgentConnectClient(createClient(contract.HostedAgentService, createHostedAgentPeerTransport({ owner: this.#options.peers, authority })), assertCurrent);
    const pool = { client, assertCurrent, poller: new HostedAgentPoller(client) }; this.#pools.set(key, pool); return pool;
  }
  #descriptor(entry: SourceEntry): BackendDescriptor {
    const native = new Map(entry.catalog.capabilities.map(fromProtoCapability).map(capability => [capability.key, capability]));
    const capabilities = new Map<string, Capability>(CAPABILITIES.map(key => {
      const capability = native.get(key), supported = FORWARDED.has(key) && capability?.supported === true;
      if (!supported) return [key, { key, supported: false, reason: "not_implemented" }];
      // Native auto approval does not supply the original task's AI review.
      return [key, key === "permission.modes" ? { ...capability!, options: (capability!.options ?? []).filter(mode => mode !== "auto") } : capability!];
    }));
    capabilities.set("model.remote_execution", { key: "model.remote_execution", supported: true });
    const hasModels = entry.catalog.providers.some(provider => provider.connected && provider.remoteInvocationEnabled && provider.models.length > 0);
    return { id: entry.id, adapterKind: "hosted", instanceGeneration: 0, displayName: `${entry.catalog.displayName} · ${entry.record.deviceName}`, version: entry.catalog.version,
      health: entry.available && entry.record.remoteControlEnabled && hasModels ? "healthy" : "unavailable", installationState: "installed", authenticationState: "not_required",
      capabilities, models: entry.catalog.providers.flatMap(provider => provider.models.map(fromModel)), providers: entry.catalog.providers.map(provider => ({ providerId: provider.providerId,
        displayName: `${provider.displayName} · ${entry.catalog.displayName} · ${entry.record.deviceName}`, api: provider.models[0]?.api ?? "", authenticationState: provider.connected ? "not_required" : "signed_out", loginMethods: [],
        supportsLogin: false, supportsLogout: false, supportsRefresh: false, supportsModelRefresh: false })), tools: [], diagnostics: [] };
  }
  #assertContext(context: AdapterContext): void {
    if (this.#closed) throw new Error("Native sources are closed."); context.signal.throwIfAborted();
    const author = context.operationId === undefined ? undefined : new TaskShareStore(this.#options.store).getAuthorForOperation(context.operationId);
    if (author?.sessionId === context.sessionId) throw new JokoError({ code: "HOSTED_AGENT_TASK_GUEST_DENIED", message: "Shared-task guests cannot invoke a remote Agent source.",
      phase: "authorization", retryable: false, stateMayHaveChanged: false, recovery: "Use an owner-authorized local model for guest input." });
  }
  #session(id: string) { try { return this.#options.store.getSession(id).descriptor; } catch { return undefined; } }
}
function sourceId(source: HostedAgentDeviceSource): string {
  return "hosted-" + createHash("sha256").update(JSON.stringify([source.controllerDeviceId, source.targetDeviceId, source.backendId])).digest("hex").slice(0, 32);
}
function parseRecord(value: unknown): SourceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The saved native source is invalid.");
  const record = value as SourceRecord;
  if (record.format !== 1 || !record.source || typeof record.deviceName !== "string" || typeof record.remoteControlEnabled !== "boolean"
    || Object.keys(record).some(key => !["format", "source", "deviceName", "catalog", "remoteControlEnabled"].includes(key))
    || Object.keys(record.source).some(key => !["controllerDeviceId", "targetDeviceId", "backendId"].includes(key))
    || ![record.source.controllerDeviceId, record.source.targetDeviceId, record.source.backendId].every(validIdentity)) throw new Error("The saved native source is invalid.");
  return record;
}
function parseCatalog(json: JsonValue, backendId: string): contract.HostedAgentBackendCatalog {
  const catalog = fromJson(contract.HostedAgentBackendCatalogSchema, json);
  if (!validIdentity(backendId) || catalog.backendId !== backendId || !catalog.displayName || catalog.providers.length > 256
    || new Set(catalog.providers.map(provider => provider.providerId)).size !== catalog.providers.length) throw new Error("The native source catalog is invalid.");
  let count = 0;
  for (const provider of catalog.providers) {
    if (!validIdentity(provider.providerId) || !provider.displayName) throw new Error("The native source Provider is invalid.");
    const models = new Set<string>();
    for (const model of provider.models) {
      if (++count > 4096 || model.backendId !== backendId || model.key?.providerId !== provider.providerId || !validIdentity(model.key.modelId)
        || models.has(model.key.modelId)) throw new Error("The native source model is invalid.");
      models.add(model.key.modelId); fromModel(model);
    }
  }
  return catalog;
}
function validIdentity(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\0\r\n]/u.test(value); }
function fromModel(model: contract.ModelDescriptor): ProviderModel {
  const number = (value: bigint) => { const result = Number(value); if (!Number.isSafeInteger(result) || result < 0) throw new Error("The native source model limits are invalid."); return result; };
  if (!model.key || !model.displayName || !model.api) throw new Error("The native source model is invalid.");
  return { providerId: model.key.providerId, modelId: model.key.modelId, displayName: model.displayName, logicalId: model.logicalId || model.key.modelId,
    api: model.api, contextWindow: number(model.contextWindowTokens), maxOutputTokens: number(model.maximumOutputTokens),
    supportsImages: model.inputModalities.includes(contract.ModelInputModality.IMAGE), thinkingLevels: model.effortLevels.map(level => level.effortId),
    ...(model.defaultEffort === undefined ? {} : { defaultEffort: model.defaultEffort }), supportsFastMode: model.supportsFastMode,
    ...(model.description === undefined ? {} : { description: model.description }),
    ...(model.defaultVisible === undefined ? {} : { defaultVisible: model.defaultVisible }),
    ...(model.displayThinkingLevels.length ? { displayThinkingLevels: [...model.displayThinkingLevels] } : {}),
    ...(model.declaredModalities?.input === undefined ? {} : { declaredInputModalities: [...model.declaredModalities.input.values] }),
    ...(model.declaredModalities?.output === undefined ? {} : { declaredOutputModalities: [...model.declaredModalities.output.values] }),
    ...(model.declaredSupportsImages === undefined ? {} : { declaredSupportsImages: model.declaredSupportsImages }),
    ...(model.declaredSupportsFastMode === undefined ? {} : { declaredSupportsFastMode: model.declaredSupportsFastMode }),
    ...(model.referenceApi === undefined ? {} : { referenceApi: model.referenceApi }),
    ...(["matching", "compatibility", "unknown"].includes(model.protocolMode ?? "") ? { protocolMode: model.protocolMode as ProviderModel["protocolMode"] } : {}),
    ...(["declared", "estimated"].includes(model.contextWindowSource ?? "") ? { contextWindowSource: model.contextWindowSource as "declared" | "estimated" } : {}),
    ...(["declared", "estimated"].includes(model.maxOutputTokensSource ?? "") ? { maxOutputTokensSource: model.maxOutputTokensSource as "declared" | "estimated" } : {}),
    ...(model.priceSource === contract.ModelPriceSource.UNSPECIFIED ? {} : { pricing: {
      source: model.priceSource === contract.ModelPriceSource.PROVIDER_REFERENCE ? "providerReference" as const : "upstream" as const,
      currencyCode: model.currencyCode, ...(model.priceUpdatedAt === undefined ? {} : { updatedAt: fromProtoTimestamp(model.priceUpdatedAt)! }) } }),
    cost: { input: number(model.inputCostMicrosPerMillion) / 1_000_000, output: number(model.outputCostMicrosPerMillion) / 1_000_000,
      cacheRead: number(model.cacheReadCostMicrosPerMillion) / 1_000_000, cacheWrite: number(model.cacheWriteCostMicrosPerMillion) / 1_000_000 } };
}
