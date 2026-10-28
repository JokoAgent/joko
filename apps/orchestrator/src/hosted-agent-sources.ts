import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { CAPABILITIES, JokoError, type AdapterContext, type BackendDescriptor, type Capability, type ProviderModel, type ToolCall, type NativeToolAuthorizationDecision,
  type ApprovedSkillSeed, type NativeSkillPolicyResolver, type ArtifactMentionResolver } from "@joko/core";
import { HostedAgentSourceAdapter, type HostedAgentDeviceSource } from "@joko/adapter-hosted";
import { NotFoundError, SessionRuntimeHandoffStore, TaskShareStore, type ConnectionRecord, type OperationalStore } from "@joko/store";
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
import { hostedDirectoryId } from "./hosted-agent-directories.js";
import { snapshotSourceInstructions } from "./hosted-agent-source-instructions.js";
import { HostedAgentSourceResources } from "./hosted-agent-source-resources.js";
import { prepareSourceWorkspaceInput } from "./hosted-agent-source-input.js";
import { HostedAgentSourceAttachments } from "./hosted-agent-source-attachments.js";
import { HostedAgentSourceMcp } from "./hosted-agent-source-mcp.js";
import { COLLABORATION_TOOL_POLICY_ID } from "./session-helper-tool-provider.js";
import type { McpRouter } from "./mcp-router.js";
import { join } from "node:path";
import type { RuntimeTextResourceSeed } from "./resource-manager.js";
import type { SourceProjectFilesOptions } from "./hosted-agent-project-files.js";
import type { CommandConcurrencyGate } from "@joko/runtime-governance";
import type { HostedAgentClaudeWebFetchOptions } from "./hosted-agent-claude-web-network.js";
import { nativeTextInferenceImages, type BlobRef } from "@joko/core";
import type { ProviderSharingDirectoryPort, ProviderSharingReceivedIdentity, ProviderSharingRecipient } from "./provider-sharing-ports.js";
import { providerSharingBackendId } from "./provider-sharing-ports.js";
import { createProviderGroupPeerTransport } from "./provider-group-peer.js";
import { createHostedAgentGuestPeerCapture } from "./hosted-agent-guest-peer-capture.js";
import type { ProviderGroupGuestSwitch } from "./provider-group-guest-switch.js";
import type { ProviderGroupStore } from "@joko/store";
import { captureHostedAgentPeerWorkspace, type HostedAgentPeerWorkspace } from "./hosted-agent-peer-workspace.js";
import { snapshotPeerSourceProject } from "./hosted-agent-peer-project-files.js";
import type { RemoteExecutionRouter } from "./remote-execution-router.js";

const SCOPE = "hosted-sources.v1";
const FORWARDED = new Set(["session.resume", "session.detach", "session.tree", "turn.stream", "turn.abort", "turn.steer", "turn.follow_up", "input.text",
  "input.image", "model.list", "model.switch", "model.effort", "model.fast_mode", "permission.modes", "permission.change", "plan_mode", "context.usage", "context.compact",
  "context.auto_compact", "context.auto_retry", "workspace.files", "workspace.files.watch", "workspace.files.write", "workspace.diff", "workspace.generated_files",
  "runtime.commands", "runtime.tools", "runtime.user_shell", "interaction.permission", "interaction.question", "interaction.plan_review", "workspace.extra_dirs",
  "subagents.list", "subagents.detail", "subagents.transcript", "subagents.stop", "subagents.steer", "subagents.follow_up", "subagents.resume",
  "background.tasks", "background.tasks.cancel", "session.rewind", "session.rewind_to_start"]);
interface SourceRecord {
  readonly format: 1;
  readonly source: HostedAgentDeviceSource;
  readonly deviceName: string;
  readonly catalog: JsonValue;
  readonly remoteControlEnabled: boolean;
  readonly received?: ProviderSharingReceivedIdentity;
}
interface SourceEntry { readonly id: string; record: SourceRecord; catalog: contract.HostedAgentBackendCatalog; available: boolean; }
interface Pool { readonly client: HostedAgentConnectClient; readonly poller: HostedAgentPoller; readonly assertCurrent: () => void; }
export interface HostedAgentSourcesOptions {
  readonly remoteExecution?: Pick<RemoteExecutionRouter, "workspace">;
  readonly store: OperationalStore; readonly peers: DevicePeerOwner; readonly registry: BackendInstanceRegistry;
  readonly host: SessionHost; readonly temporaryRoot: string; readonly readPolicy: (context: AdapterContext) => HostedAgentExecutorPolicy;
  readonly commandConcurrencyGate?: CommandConcurrencyGate;
  readonly resolveCodexExecutable?: () => Promise<string | undefined>;
  readonly readBlob: (blob: BlobRef) => Promise<Uint8Array>;
  readonly reviewTool?: (context: AdapterContext, call: ToolCall, signal: AbortSignal, assertCurrent: () => void, policy: HostedAgentExecutorPolicy) => Promise<NativeToolAuthorizationDecision>;
  readonly resolveTextResources?: (context: AdapterContext, nativeKind: string) => Promise<readonly RuntimeTextResourceSeed[]>;
  readonly resolveNativeSkills?: (context: AdapterContext, signal: AbortSignal, nativeKind: string) => Promise<readonly ApprovedSkillSeed[]>;
  readonly resolveNativeSkillPolicy?: NativeSkillPolicyResolver;
  readonly resolveFile?: (blob: BlobRef, context: AdapterContext) => Promise<string>;
  readonly resolveArtifactMention?: ArtifactMentionResolver;
  readonly mcpRouter?: McpRouter;
  readonly includeToolPolicy?: (context: AdapterContext, policyId: string) => boolean;
  readonly resolveMemoryPrompt?: (context: AdapterContext) => string | undefined;
  readonly resourceAllowed?: SourceProjectFilesOptions["resourceAllowed"];
  readonly resolveProxy?: HostedAgentClaudeWebFetchOptions["resolveProxy"];
  readonly environmentProxyForTarget?: HostedAgentClaudeWebFetchOptions["environmentProxyForTarget"];
  readonly sharing?: ProviderSharingDirectoryPort;
  readonly sourceDeviceId?: string;
}
const runFile = promisify(execFile);

/** Owns durable model-source identities independently of browser Connections
 * and local native installations. Discovery never creates a product task. */
export class HostedAgentSources {
  readonly #options: HostedAgentSourcesOptions;
  readonly #entries = new Map<string, SourceEntry>();
  readonly #refreshing = new Map<string, Promise<void>>();
  readonly #pools = new Map<string, Pool>();
  #groupSwitch?: ProviderGroupGuestSwitch;
  #groupStore?: ProviderGroupStore;
  readonly #preparedGroupMembers = new Map<string, string>();
  readonly #contextGuards = new WeakMap<AdapterContext, () => void>();
  readonly #attachments?: HostedAgentSourceAttachments;
  #closed = false;
  #discoveryClosed = false;
  constructor(options: HostedAgentSourcesOptions) {
    this.#options = options;
    if (options.resolveFile && options.resolveArtifactMention) this.#attachments = new HostedAgentSourceAttachments({ store: options.store,
      root: join(options.temporaryRoot, "inputs"), resolveFile: options.resolveFile, resolveArtifactMention: options.resolveArtifactMention, assertContext: context => this.#assertContext(context) });
  }
  installGroupSwitch(value: ProviderGroupGuestSwitch): void { if (this.#groupSwitch && this.#groupSwitch !== value) throw new Error("The Source group switch owner changed."); this.#groupSwitch = value; }
  installGroupStore(value: ProviderGroupStore): void { this.#groupStore = value; }
  prepareGroupMember(sessionId: string, backendId: string): void { this.#preparedGroupMembers.set(sessionId, backendId); }
  async initialize(): Promise<void> {
    await this.#attachments?.initialize();
    for (const row of this.#options.store.listSettingsByKeyPrefix("service", SCOPE, "source:")) {
      const record = parseRecord(row.value), id = record.received ? providerSharingBackendId(record.received.joinId, record.received.nativeBackendId) : sourceId(record.source);
      if (row.key !== `source:${id}`) throw new Error("The saved native source identity conflicts.");
      const catalog = parseCatalog(record.catalog, record.source.backendId), entry = { id, record, catalog, available: false };
      this.#entries.set(id, entry); await this.#install(entry);
    }
  }
  source(backendId: string): HostedAgentDeviceSource | undefined { return this.#entries.get(backendId)?.record.source; }
  sourceKind(backendId: string): "device" | "share" | undefined { const entry = this.#entries.get(backendId); return entry ? entry.record.received ? "share" : "device" : undefined; }
  groupCatalog(): readonly { readonly backendId: string; readonly source: HostedAgentDeviceSource; readonly name: string;
    readonly available: boolean; readonly catalog: contract.HostedAgentBackendCatalog; readonly received?: ProviderSharingReceivedIdentity }[] {
    return [...this.#entries.values()].map(entry => ({ backendId: entry.id, source: entry.record.source, name: entry.record.deviceName,
      available: entry.available && entry.record.remoteControlEnabled, catalog: entry.catalog, ...(entry.record.received ? { received: entry.record.received } : {}) }));
  }
  /** An owner-only coordinator uses the exact existing Device route. A
   * received Provider grant cannot obtain group management or quota access. */
  captureGroupPeer(backendId: string) {
    const entry = this.#entries.get(backendId); if (!entry || entry.record.received || !entry.catalog.nodeId) throw new Error("The group owner Device route is unavailable.");
    const authority = this.#options.peers.captureBinding(entry.record.source.controllerDeviceId, entry.record.source.targetDeviceId, ["native_agents"]);
    return { transport: createProviderGroupPeerTransport({ owner: this.#options.peers, authority }), assertCurrent: () => authority.assertCurrent(["native_agents"]),
      ownerNodeId: entry.catalog.nodeId, nativeBackendId: entry.record.source.backendId };
  }
  resolveGroupMember(nodeId: string, nativeBackendId: string, providerId: string): string | undefined {
    return [...this.#entries.values()].find(entry => entry.catalog.nodeId === nodeId && entry.record.source.backendId === nativeBackendId
      && !entry.record.received && entry.catalog.providers.some(provider => provider.providerId === providerId))?.id;
  }
  captureNativeForGroup(backendId: string, runId: string) {
    const entry = this.#entries.get(backendId); if (!entry) throw new Error("The group member native source is unavailable.");
    return this.#capture(entry, runId);
  }
  captureGuestForGroup(backendId: string, recipient: ProviderSharingRecipient, providerId: string, modelIds: readonly string[], assertCurrent: () => void, shouldPurge?: () => boolean) {
    const entry = this.#entries.get(backendId); if (!entry || entry.record.received) throw new Error("The owner Device group member is unavailable.");
    const authority = this.#options.peers.captureBinding(entry.record.source.controllerDeviceId, entry.record.source.targetDeviceId, ["native_agents"]);
    return createHostedAgentGuestPeerCapture({ owner: this.#options.peers, authority, recipient, backendId: entry.record.source.backendId, providerId, modelIds,
      assertCurrent, ...(shouldPurge === undefined ? {} : { shouldPurge }) });
  }
  async refreshShared(signal: AbortSignal): Promise<void> {
    if (this.#closed || this.#discoveryClosed) throw new Error("Native source discovery is closed.");
    const sharing = this.#options.sharing; if (!sharing) return;
    const seen = new Set<string>();
    await Promise.allSettled(sharing.listReceived().map(async received => {
      if (received.state !== "active") return;
      sharing.assertReceived(received); const sourceDeviceId = this.#options.sourceDeviceId;
      if (!sourceDeviceId) throw new Error("The original Provider source node is unavailable.");
      const captured = sharing.captureNative(received, sourceDeviceId);
      const snapshot = await captured.client.catalog(signal); captured.assertCurrent();
      const raw = snapshot.backends.find(backend => backend.backendId === received.nativeBackendId);
      if (!raw) throw new Error("The shared native catalog no longer contains its granted Backend.");
      const catalog = parseCatalog(toJson(contract.HostedAgentBackendCatalogSchema, raw), received.nativeBackendId);
      if (catalog.providers.some(provider => provider.providerId !== received.providerId)) throw new Error("The shared native catalog exceeds its Provider grant.");
      const identity: ProviderSharingReceivedIdentity = { joinId: received.joinId, shareId: received.shareId, memberId: received.memberId, generation: received.generation,
        hostServerId: received.hostServerId, nativeBackendId: received.nativeBackendId, providerId: received.providerId };
      const source = { controllerDeviceId: sourceDeviceId, targetDeviceId: received.hostServerId, backendId: received.nativeBackendId };
      const record: SourceRecord = { format: 1, source, deviceName: received.ownerName, received: identity,
        catalog: toJson(contract.HostedAgentBackendCatalogSchema, catalog), remoteControlEnabled: snapshot.remoteControlEnabled };
      const prior = this.#entries.get(received.backendId), entry = prior ?? { id: received.backendId, record, catalog, available: true };
      entry.record = record; entry.catalog = catalog; entry.available = true; this.#entries.set(entry.id, entry);
      seen.add(received.backendId);
      this.#options.store.setSetting("service", SCOPE, `source:${entry.id}`, record);
      if (prior) await this.#options.registry.refresh(entry.id); else await this.#install(entry);
    }));
    signal.throwIfAborted();
    for (const entry of this.#entries.values()) if (entry.record.received) {
      const received = sharing.listReceived().find(row => row.backendId === entry.id);
      if (!seen.has(entry.id) || received?.state !== "active") { entry.available = false; await this.#options.registry.refresh(entry.id); }
    }
  }
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
    for (const entry of this.#entries.values()) if (!entry.record.received && entry.record.source.controllerDeviceId === connection.deviceId && !seen.has(entry.id)) {
      entry.available = false; await this.#options.registry.refresh(entry.id);
    }
  }
  async #install(entry: SourceEntry): Promise<void> {
    const resources = new HostedAgentSourceResources();
    const peerWorkspaces = new Map<string, HostedAgentPeerWorkspace>();
    const mcps = new Map<string, HostedAgentSourceMcp>(), mcpKey = (context: AdapterContext) => JSON.stringify([context.sessionId, context.generation, context.backendInstanceGeneration]);
    const snapshot = await this.#options.registry.add({ instanceId: entry.id, adapterKind: "hosted", displayName: entry.catalog.displayName,
      create: ({ generation }) => new HostedAgentSourceAdapter({ id: entry.id, source: entry.record.source, describe: () => this.#descriptor(entry),
        inferNativeText: async input => {
          const nativeGeneration = Number(entry.catalog.instanceGeneration), providerId = input.providerId, modelId = input.modelId;
          const assertCurrent = () => {
            input.signal.throwIfAborted(); input.assertCurrent();
            const backend = this.#options.store.getBackend(entry.id).descriptor;
            if (this.#closed || !entry.available || !entry.record.remoteControlEnabled || input.backendInstanceGeneration !== generation
              || backend.instanceGeneration !== generation || Number(entry.catalog.instanceGeneration) !== nativeGeneration || !providerId || !modelId
              || !entry.catalog.providers.some(provider => provider.providerId === providerId && provider.connected && provider.remoteInvocationEnabled
                && provider.models.some(model => model.key?.modelId === modelId))) throw new Error("The isolated Source inference route changed.");
            input.assertModelAllowed(providerId, modelId);
          };
          assertCurrent();
          const captured = this.#capture(entry, randomUUID()); captured.assertCurrent();
          const requestId = randomUUID(), images = nativeTextInferenceImages(input);
          const owner = new AbortController(), signal = AbortSignal.any([owner.signal, input.signal]);
          const timer = setInterval(() => { try { assertCurrent(); captured.assertCurrent(); } catch (error) { owner.abort(error); } }, 100); timer.unref();
          try {
            const result = await captured.client.infer({ requestId, backendId: entry.record.source.backendId,
              backendInstanceGeneration: nativeGeneration, providerId: providerId!, modelId: modelId!, system: input.system, user: input.user, timeoutMs: input.timeoutMs,
              ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
              ...(images.length ? { images: images.map(image => ({ data: Buffer.from(image.data).toString("base64"), mimeType: image.mimeType })) } : {}) }, signal);
            assertCurrent(); captured.assertCurrent(); return result;
          } finally { clearInterval(timer); owner.abort(); }
        },
        onRuntimeUnavailable: context => this.#options.host.invalidateRuntime({ backendId: entry.id, backendInstanceGeneration: generation,
          sessionId: context.sessionId, generation: context.generation }),
        readPolicy: context => {
          const policy = this.#options.readPolicy(context), session = this.#session(context.sessionId);
          return { permissionMode: policy.permissionMode, fastMode: session?.fastMode ?? false, ...(session?.effort === undefined ? {} : { effort: session.effort }) };
        }, assertContext: context => this.#assertContext(context),
        ...(this.#options.remoteExecution ? { validateRemoteTarget: async (target: import("@joko/core").TargetDescriptor) => {
          if (target.remoteWorkspace?.kind !== "device_peer") throw new Error("This Source requires an authorized Device project.");
          const authority = await this.#options.remoteExecution!.workspace(target.remoteWorkspace); authority.assertCurrent();
          const canonical = await authority.files.realpath(target.workspaceRoot); authority.assertCurrent();
          const same = authority.pathStyle === "win32" ? canonical.toLowerCase() === target.workspaceRoot.toLowerCase() : canonical === target.workspaceRoot;
          const bound = authority.pathStyle === "win32" ? target.remoteWorkspace.workspaceRoot.toLowerCase() === target.workspaceRoot.toLowerCase() : target.remoteWorkspace.workspaceRoot === target.workspaceRoot;
          if (!same || !bound || (await authority.files.stat(canonical)).kind !== "directory") throw new Error("The Source Device workspace changed."); authority.assertCurrent();
        } } : {}),
        releaseWorkspace: async context => { const key = mcpKey(context), mcp = mcps.get(key), peer = peerWorkspaces.get(key); await mcp?.close();
          if (peer) { try { await peer.dispose(); } catch (error) { if (!this.#options.remoteExecution || !context.target.remoteWorkspace) throw error;
            const fresh = await this.#options.remoteExecution.workspace(context.target.remoteWorkspace); await peer.dispose(fresh); } }
          mcps.delete(key); peerWorkspaces.delete(key); await this.#attachments?.release(context); await resources.release(context); },
        deleteWorkspace: async context => { this.#assertContext(context); await this.#attachments?.forget(context.sessionId); },
        prepareInput: (input, context, shadow) => {
          this.#assertContext(context);
          const session = this.#options.store.getSession(context.sessionId).descriptor, target = this.#options.store.getTarget(context.target.id);
          const metadata = target.metadata, value = metadata !== null && typeof metadata === "object" && !Array.isArray(metadata) && "workspaceId" in metadata ? metadata.workspaceId : undefined;
          const workspaceId = readWorkerWorkspaceBinding(this.#options.store, session.id)?.workspaceId ?? session.worktree?.workspaceId
            ?? (typeof value === "string" && value ? value : target.descriptor.id);
          return prepareSourceWorkspaceInput(input, context, { shadow, workspaceId, resources, assertCurrent: () => this.#assertContext(context),
            ...(peerWorkspaces.get(mcpKey(context)) ? { capturePath: (reference: string, directory: boolean, stageFile: boolean) => peerWorkspaces.get(mcpKey(context))!.captureInput(reference, directory, shadow,
              join(this.#options.temporaryRoot, "peer-inputs", createHash("sha256").update(JSON.stringify([context.sessionId, context.generation])).digest("hex")), stageFile) } : {}),
            ...(this.#attachments ? { attachments: this.#attachments.begin(context, shadow) } : {}) });
        },
        ...(this.#options.resolveTextResources === undefined && this.#options.resolveNativeSkills === undefined ? {} : {
          resources: context => resources.resources(context),
          commands: context => resources.commands(context)
        }),
        takeGroupSwitch: context => this.#groupSwitch?.takeForOpen(context.sessionId, entry.id),
        takeNewGroupRound: context => this.#groupSwitch?.takeNewRound(context.sessionId) === true,
        isGroupMember: context => !entry.record.received && (this.#preparedGroupMembers.get(context.sessionId) === entry.id
          || this.#groupStore?.binding(context.sessionId)?.backendId === entry.id),
        workspace: async context => {
          this.#assertContext(context);
          const peer = context.target.remoteWorkspace ? peerWorkspaces.get(mcpKey(context)) ?? await captureHostedAgentPeerWorkspace(context, this.#options.remoteExecution ?? missingPeerWorkspace(), () => this.#assertContext(context)) : undefined;
          if (peer) peerWorkspaces.set(mcpKey(context), peer);
          await this.#attachments?.capture(context);
          const nativeKind = entry.catalog.nativeAdapterKind;
          let isGitRepository = false;
          try { isGitRepository = peer ? (await peer.process("git", ["rev-parse", "--is-inside-work-tree"], context.target.workspaceRoot, context.signal, 5)).output.toString("utf8").trim() === "true" : (await runFile("git", ["rev-parse", "--is-inside-work-tree"], {
            cwd: context.target.workspaceRoot, signal: context.signal, timeout: 5000, windowsHide: true, maxBuffer: 1024
          })).stdout.trim() === "true"; } catch { context.signal.throwIfAborted(); }
          const skills = this.#options.resolveNativeSkills ? await resources.captureSkills(context,
            await this.#options.resolveNativeSkills(context, context.signal, nativeKind), await this.#options.resolveNativeSkillPolicy?.(context)) : [];
          const textResources = await this.#options.resolveTextResources?.(context, nativeKind) ?? [];
          const skillIds = new Set(skills.map(skill => skill.id));
          const projectFiles = [...(peer ? await snapshotPeerSourceProject(context, peer, nativeKind, this.#options.resourceAllowed) : await snapshotSourceProjectFiles(context, { assertCurrent: () => this.#assertContext(context),
            ...(this.#options.resourceAllowed === undefined ? {} : { resourceAllowed: this.#options.resourceAllowed }) })),
            ...resources.capture(context, [...skills, ...textResources.filter(seed => !skillIds.has(seed.id))])];
          const contextFiles = peer ? projectFiles : await snapshotSourceInstructions(context, { files: projectFiles,
            nativeKind, assertCurrent: () => this.#assertContext(context) });
          const mcpEnabled = this.#options.mcpRouter !== undefined && entry.catalog.capabilities.some(capability => capability.name === "tool.mcp" && capability.support === contract.CapabilitySupport.SUPPORTED);
          if (mcpEnabled) {
            const key = mcpKey(context); await mcps.get(key)?.close();
            mcps.set(key, new HostedAgentSourceMcp({ router: this.#options.mcpRouter!, store: this.#options.store, context, assertCurrent: () => this.#assertContext(context),
              includeToolPolicy: policyId => this.#options.includeToolPolicy?.(context, policyId) ?? true }));
          }
          const memoryInstructions = mcpEnabled ? this.#options.resolveMemoryPrompt?.(context) : undefined;
          this.#assertContext(context);
          return { platform: peer?.platform ?? process.platform as "win32" | "linux" | "darwin", shell: "bash", isGitRepository, contextFiles,
            subagentsEnabled: this.#options.includeToolPolicy?.(context, COLLABORATION_TOOL_POLICY_ID) ?? true,
            ...(mcpEnabled ? { mcpEnabled: true as const } : {}), ...(memoryInstructions ? { memoryInstructions } : {}),
            additionalDirectoryIds: this.#options.readPolicy(context).approvedRoots.map(hostedDirectoryId),
            ...(context.appendSystemPrompt === undefined ? {} : { personalInstructions: context.appendSystemPrompt }) };
        },
        capture: async (runId, context) => {
          this.#assertContext(context); const captured = this.#capture(entry, runId), pool = captured.pool;
          const peer = context.target.remoteWorkspace ? await captureHostedAgentPeerWorkspace(context, this.#options.remoteExecution ?? missingPeerWorkspace(), () => this.#assertContext(context)) : undefined;
          if (peer) peerWorkspaces.set(mcpKey(context), peer);
          const codexExecutable = peer ? "codex" : await this.#options.resolveCodexExecutable?.(); this.#assertContext(context); pool.assertCurrent();
          return { client: pool.client, assertCurrent: pool.assertCurrent, close: captured.close,
            createController: input => createHostedAgentSourceController({ ...input, poller: pool.poller, temporaryRoot: this.#options.temporaryRoot,
              ...(peer ? { remote: peer } : {}),
              ...(mcps.get(mcpKey(input.context)) ? { mcp: mcps.get(mcpKey(input.context))! } : {}),
              readPolicy: sourceContext => {
                const policy = this.#options.readPolicy(sourceContext), authority = resources.authority(sourceContext, input.shadow), attachments = this.#attachments?.authority(sourceContext, input.shadow);
                const roots = [...authority.approvedRoots, ...(attachments?.files.map((file, index) => ({ id: `input:${index}`, path: file.path, access: "read_only" as const })) ?? [])];
                return { ...policy, revision: JSON.stringify([policy.revision, authority.revision, attachments?.revision]), approvedRoots: [...policy.approvedRoots,
                  ...roots.map(root => peer ? { ...root, path: peer.mountPath(root.path, () => { resources.authority(sourceContext, input.shadow); this.#attachments?.authority(sourceContext, input.shadow); }) } : root)] };
              }, aliases: sourceContext => { const aliases = [...resources.authority(sourceContext, input.shadow).aliases, ...(this.#attachments?.authority(sourceContext, input.shadow).aliases ?? [])];
                return peer ? peer.projectAliases(aliases, () => { resources.authority(sourceContext, input.shadow); this.#attachments?.authority(sourceContext, input.shadow); }) : aliases; },
              ...(this.#attachments ? { inputFiles: (sourceContext: AdapterContext) => { const files = this.#attachments!.authority(sourceContext, input.shadow).files; return peer ? peer.projectInputs(files) : files; } } : {}),
              assertContext: sourceContext => this.#assertContext(sourceContext), assertCurrent: pool.assertCurrent,
              ...(this.#options.reviewTool === undefined ? {} : { reviewTool: this.#options.reviewTool }),
              onGroupSwitch: offer => { this.#assertContext(context); pool.assertCurrent(); this.#groupSwitch?.offer(context.sessionId, entry.id, context.generation, offer); },
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
  #capture(entry: SourceEntry, runId: string): { readonly pool: Pool; readonly client: HostedAgentConnectClient; readonly assertCurrent: () => void; readonly close: (signal?: AbortSignal) => Promise<void> } {
    const received = entry.record.received;
    if (received) {
      const sharing = this.#options.sharing; if (!sharing || !this.#options.sourceDeviceId) throw new Error("Provider share authority is unavailable.");
      sharing.assertReceived(received); const captured = sharing.captureNative(received, this.#options.sourceDeviceId);
      const key = JSON.stringify(["share", received.joinId, received.nativeBackendId, received.generation, this.#options.sourceDeviceId]);
      let pool = this.#pools.get(key);
      if (!pool) { pool = { client: captured.client, assertCurrent: captured.assertCurrent, poller: new HostedAgentPoller(captured.client) }; this.#pools.set(key, pool); }
      pool.assertCurrent(); return { pool, client: pool.client, assertCurrent: pool.assertCurrent, close: (signal = AbortSignal.timeout(15_000)) => captured.close(runId, signal) };
    }
    const pool = this.#pool(entry.record.source);
    const authority = this.#options.peers.captureBinding(entry.record.source.controllerDeviceId, entry.record.source.targetDeviceId, ["native_agents"]);
    return { pool, client: pool.client, assertCurrent: pool.assertCurrent, close: this.#options.peers.captureHostedAgentCleanup(authority, runId) };
  }
  #descriptor(entry: SourceEntry): BackendDescriptor {
    const native = new Map(entry.catalog.capabilities.map(fromProtoCapability).map(capability => [capability.key, capability]));
    const capabilities = new Map<string, Capability>(CAPABILITIES.map(key => {
      const capability = native.get(key), supported = FORWARDED.has(key) && capability?.supported === true;
      if (!supported) return [key, { key, supported: false, reason: key === "session.fork" || key === "session.clone" ? "upstream_missing" : "not_implemented" }];
      return [key, key === "permission.modes" && !this.#options.reviewTool
        ? { ...capability!, options: (capability!.options ?? []).filter(mode => mode !== "auto") } : capability!];
    }));
    capabilities.set("model.remote_execution", { key: "model.remote_execution", supported: true });
    if ((this.#options.resolveTextResources || this.#options.resolveNativeSkills) && native.get("input.text")?.supported) {
      capabilities.set("runtime.resources", { key: "runtime.resources", supported: true, options: ["skill", "prompt"] });
      capabilities.set("input.mention", { key: "input.mention", supported: true, options: ["resource"] });
    }
    if (native.get("input.text")?.supported && native.get("workspace.files")?.supported) {
      capabilities.set("input.mention", { key: "input.mention", supported: true,
        options: [...(capabilities.get("input.mention")?.options ?? []), "workspace_file", "workspace_directory", "workspace_line_range"] });
      if (this.#attachments) {
        capabilities.set("input.file", { key: "input.file", supported: true });
        capabilities.set("input.mention", { key: "input.mention", supported: true, options: [...capabilities.get("input.mention")!.options!, "artifact"] });
      }
    }
    const hasModels = entry.catalog.providers.some(provider => provider.connected && provider.remoteInvocationEnabled && provider.models.length > 0);
    if (this.#options.mcpRouter && native.get("tool.mcp")?.supported) {
      capabilities.set("tool.mcp", { key: "tool.mcp", supported: true });
      if (this.#options.resolveMemoryPrompt) capabilities.set("memory.curated", { key: "memory.curated", supported: true });
    }
    return { id: entry.id, adapterKind: "hosted", instanceGeneration: 0, displayName: `${entry.catalog.displayName} · ${entry.record.deviceName}`, version: entry.catalog.version,
      health: entry.available && entry.record.remoteControlEnabled && hasModels ? "healthy" : "unavailable", installationState: "installed", authenticationState: "not_required",
      capabilities, models: entry.catalog.providers.flatMap(provider => provider.models.map(fromModel)), providers: entry.catalog.providers.map(provider => ({ providerId: provider.providerId,
        displayName: `${provider.displayName} · ${entry.catalog.displayName} · ${entry.record.deviceName}`, api: provider.models[0]?.api ?? "", authenticationState: provider.connected ? "not_required" : "signed_out", loginMethods: [],
        supportsLogin: false, supportsLogout: false, supportsRefresh: false, supportsModelRefresh: false,
        ...(["managed", "apiKey", "oauth", "subscription", "localKeyless", "customEndpoint"].includes(provider.accessKind) ? { accessKind: provider.accessKind as NonNullable<BackendDescriptor["providers"]>[number]["accessKind"] } : {}),
        ...(provider.accessProduct ? { accessProduct: provider.accessProduct } : {}) })), tools: [], diagnostics: [] };
  }
  #assertContext(context: AdapterContext): void {
    if (this.#closed) throw new Error("Native sources are closed."); context.signal.throwIfAborted();
    let guard = this.#contextGuards.get(context);
    if (!guard) {
      const targetRevision = this.#options.store.getTarget(context.target.id).revision;
      const generation = this.#options.store.getBackend(context.target.backendId).descriptor.instanceGeneration;
      const nativeKind = this.#entries.get(context.target.backendId)?.catalog.nativeAdapterKind;
      const session = this.#session(context.sessionId);
      const handoffs = new SessionRuntimeHandoffStore(this.#options.store);
      const admitsHandoff = () => handoffs.admitsTarget({ sessionId: context.sessionId, targetId: context.target.id,
        backendId: context.target.backendId, generation: context.generation, backendInstanceGeneration: context.backendInstanceGeneration ?? -1,
        workspaceRoot: context.target.workspaceRoot, ...(context.operationId === undefined ? {} : { operationId: context.operationId }) });
      const workspace = session?.backendId === context.target.backendId && session.binding.generation === context.generation
        ? this.#options.host.captureToolWorkspace({ sessionId: context.sessionId, targetId: context.target.id, generation: context.generation }) : undefined;
      guard = () => {
        const backend = this.#options.store.getBackend(context.target.backendId).descriptor, target = this.#options.store.getTarget(context.target.id);
        const current = this.#session(context.sessionId);
        if (backend.instanceGeneration !== generation || context.backendInstanceGeneration !== undefined && context.backendInstanceGeneration !== generation
          || this.#entries.get(context.target.backendId)?.catalog.nativeAdapterKind !== nativeKind
          || target.revision !== targetRevision || !target.descriptor.trusted
          || current !== undefined && (current.deletedAt !== undefined || current.archived
            || (current.backendId !== context.target.backendId || current.binding.generation !== context.generation || current.targetId !== context.target.id) && !admitsHandoff())
          || workspace !== undefined && (workspace.root !== context.target.workspaceRoot || workspace.remote !== (context.target.remoteWorkspace !== undefined))) throw new Error("The original Source task authority changed.");
        workspace?.assertCurrent();
      };
      this.#contextGuards.set(context, guard);
    }
    guard();
    const author = context.operationId === undefined ? undefined : new TaskShareStore(this.#options.store).getAuthorForOperation(context.operationId);
    if (author?.sessionId === context.sessionId) throw new JokoError({ code: "HOSTED_AGENT_TASK_GUEST_DENIED", message: "Shared-task guests cannot invoke a remote Agent source.",
      phase: "authorization", retryable: false, stateMayHaveChanged: false, recovery: "Use an owner-authorized local model for guest input." });
  }
  #session(id: string) {
    try { return this.#options.store.getSession(id).descriptor; }
    catch (error) { if (error instanceof NotFoundError && error.resource === "Session" && error.id === id) return undefined; throw error; }
  }
}
function sourceId(source: HostedAgentDeviceSource): string {
  return "hosted-" + createHash("sha256").update(JSON.stringify([source.controllerDeviceId, source.targetDeviceId, source.backendId])).digest("hex").slice(0, 32);
}
function missingPeerWorkspace(): never { throw new Error("The Source Device execution capability is unavailable."); }
function parseRecord(value: unknown): SourceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The saved native source is invalid.");
  const record = value as SourceRecord;
  if (record.format !== 1 || !record.source || typeof record.deviceName !== "string" || typeof record.remoteControlEnabled !== "boolean"
    || Object.keys(record).some(key => !["format", "source", "deviceName", "catalog", "remoteControlEnabled", "received"].includes(key))
    || Object.keys(record.source).some(key => !["controllerDeviceId", "targetDeviceId", "backendId"].includes(key))
    || ![record.source.controllerDeviceId, record.source.targetDeviceId, record.source.backendId].every(validIdentity)) throw new Error("The saved native source is invalid.");
  if (record.received && (Object.keys(record.received).some(key => !["joinId", "shareId", "memberId", "generation", "hostServerId", "nativeBackendId", "providerId"].includes(key))
    || ![record.received.joinId, record.received.shareId, record.received.memberId, record.received.hostServerId, record.received.nativeBackendId, record.received.providerId].every(validIdentity)
    || !Number.isSafeInteger(record.received.generation) || record.received.generation < 1)) throw new Error("The saved shared native source is invalid.");
  return record;
}
function parseCatalog(json: JsonValue, backendId: string): contract.HostedAgentBackendCatalog {
  const catalog = fromJson(contract.HostedAgentBackendCatalogSchema, json);
  if (!validIdentity(backendId) || catalog.backendId !== backendId || !catalog.displayName || catalog.providers.length > 256
    || !Number.isSafeInteger(Number(catalog.instanceGeneration)) || catalog.instanceGeneration < 1n
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
    supportsUltrafastMode: model.supportsUltrafastMode,
    ...(model.description === undefined ? {} : { description: model.description }),
    ...(model.defaultVisible === undefined ? {} : { defaultVisible: model.defaultVisible }),
    ...(model.displayThinkingLevels.length ? { displayThinkingLevels: [...model.displayThinkingLevels] } : {}),
    ...(model.declaredModalities?.input === undefined ? {} : { declaredInputModalities: [...model.declaredModalities.input.values] }),
    ...(model.declaredModalities?.output === undefined ? {} : { declaredOutputModalities: [...model.declaredModalities.output.values] }),
    ...(model.declaredSupportsImages === undefined ? {} : { declaredSupportsImages: model.declaredSupportsImages }),
    ...(model.declaredSupportsFastMode === undefined ? {} : { declaredSupportsFastMode: model.declaredSupportsFastMode }),
    ...(model.declaredSupportsUltrafastMode === undefined ? {} : { declaredSupportsUltrafastMode: model.declaredSupportsUltrafastMode }),
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
import { readWorkerWorkspaceBinding } from "./collaboration-worker-workspace.js";
