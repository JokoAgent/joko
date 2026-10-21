import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { redactSecrets, type AdapterContext, type NativeSkillPolicy, type SessionDescriptor } from "@joko/core";
import { RevisionConflictError, SessionRuntimeHandoffStore, StoreError, type OperationalStore, type PartnerStore } from "@joko/store";
import type { PartnerManager } from "./partner-manager.js";
import type { McpRouter } from "./mcp-router.js";
import { fromProtoRevision, toProtoRevision } from "./proto-mapper.js";
import type { PiResourceManager } from "./resource-manager.js";

export interface ConnectionSelection { readonly mode: "inherit" | "allowlist"; readonly ids: readonly string[] }
export interface ConnectionPreferences { readonly mcp: ConnectionSelection; readonly toolsets: ConnectionSelection; readonly skills: ConnectionSelection; readonly revision?: bigint }
const key = "partner-connections.preferences";
const inherited = (): ConnectionSelection => ({ mode: "inherit", ids: [] });
function selection(value: unknown): ConnectionSelection {
  const raw = value as Partial<ConnectionSelection> | null;
  if (!raw || Object.keys(raw).some(field => field !== "mode" && field !== "ids")
    || raw.mode !== "inherit" && raw.mode !== "allowlist" || !Array.isArray(raw.ids)
    || raw.ids.some(id => typeof id !== "string" || !id || id.length > 256
      || /[\u0000-\u001f\u007f]/u.test(id) || redactSecrets(id) !== id)
    || new Set(raw.ids).size !== raw.ids.length || raw.mode === "inherit" && raw.ids.length !== 0) throw new StoreError("Connection references are invalid.");
  return { mode: raw.mode, ids: [...raw.ids].sort() };
}
export class PartnerConnectionPreferences {
  constructor(readonly store: OperationalStore) {}
  read(targetId: string): ConnectionPreferences {
    const record = this.store.findSetting<unknown>("target", targetId, key);
    if (!record) return { mcp: inherited(), toolsets: inherited(), skills: { mode: "allowlist", ids: [] } };
    const value = record.value as { format?: unknown; mcp?: unknown; toolsets?: unknown; skills?: unknown } | null;
    if (!value || value.format !== 1 || Object.keys(value).some(field => !["format", "mcp", "toolsets", "skills"].includes(field))) throw new StoreError("Connection preferences are invalid.");
    const skills = selection(value.skills); if (skills.mode !== "allowlist") throw new StoreError("Skill references require explicit selections.");
    return { mcp: selection(value.mcp), toolsets: selection(value.toolsets), skills, revision: record.revision };
  }
  update(targetId: string, expected: bigint | undefined, value: Omit<ConnectionPreferences, "revision">): ConnectionPreferences {
    const mcp = selection(value.mcp), toolsets = selection(value.toolsets), skills = selection(value.skills);
    if (skills.mode !== "allowlist") throw new StoreError("Skill references require explicit selections.");
    return this.store.transaction(() => {
      const current = this.read(targetId);
      if (current.revision !== expected) throw new RevisionConflictError("Connection preferences", targetId, expected ?? 0n, current.revision ?? 0n);
      if (JSON.stringify([current.mcp, current.toolsets, current.skills]) !== JSON.stringify([mcp, toolsets, skills])) this.store.setSetting("target", targetId, key, { format: 1, mcp, toolsets, skills });
      return this.read(targetId);
    });
  }
  remove(targetId: string): void { this.store.deleteSetting("target", targetId, key); }
}
function protoSelection(value: ConnectionSelection) { return { mode: value.mode === "inherit" ? contract.PartnerConnectionMode.INHERIT : contract.PartnerConnectionMode.ALLOWLIST, ids: [...value.ids] }; }
function fromSelection(value: contract.PartnerConnectionSelection | undefined): ConnectionSelection {
  if (!value || value.mode !== contract.PartnerConnectionMode.INHERIT && value.mode !== contract.PartnerConnectionMode.ALLOWLIST) throw new StoreError("Connection selection is required.");
  return selection({ mode: value.mode === contract.PartnerConnectionMode.INHERIT ? "inherit" : "allowlist", ids: value.ids });
}
export class PartnerConnectionsManager {
  constructor(readonly partners: PartnerManager, readonly profiles: PartnerStore, readonly store: OperationalStore,
    readonly preferences: PartnerConnectionPreferences, readonly router: McpRouter,
    readonly inheritedToolsetEnabled?: (sessionId: string, targetId: string, id: string) => boolean,
    readonly resources?: PiResourceManager,
    readonly skillMetadata?: (partnerId: string, signal: AbortSignal, backendId?: string) => Promise<readonly { id: string; name: string; nativeName: string; description: string }[]>,
    readonly groupHomeTarget: (sessionId: string, targetId: string) => string | undefined = () => undefined) {}
  owner(partnerId: string, expected?: bigint, writable = false): contract.PartnerConnectionsOwner {
    const profile = this.partners.getPartner(partnerId);
    if (profile.lifecycle === "deleted" || profile.initializationState !== "ready" || !profile.canonicalSessionId) throw new ConnectError("Partner connections are unavailable.", Code.FailedPrecondition);
    if (expected !== undefined && profile.revision !== expected) throw new ConnectError("Partner changed.", Code.Aborted);
    const session = this.store.getSession(profile.canonicalSessionId).descriptor;
    const target = this.store.getTarget(profile.homeTargetId).descriptor;
    const link = this.profiles.getSessionLink(session.id);
    if (session.targetId !== target.id || session.remoteWorkspace?.kind === "ssh" || target.remoteWorkspace?.kind === "ssh" || !target.trusted || session.deletedAt !== undefined
      || link?.partnerId !== partnerId || link.role !== "canonical") throw new ConnectError("Partner connections owner changed.", Code.FailedPrecondition);
    const readOnly = profile.lifecycle === "archived" || profile.pauseCleanupPending === true || this.partners.isHomeChanging(partnerId)
      || this.partners.listPendingRestarts().some(item => item.partnerId === partnerId);
    if (writable && readOnly) throw new ConnectError("Partner connections are read-only.", Code.FailedPrecondition);
    return create(contract.PartnerConnectionsOwnerSchema, { partnerId, homeTargetId: target.id, canonicalSessionId: session.id, revision: toProtoRevision(profile.revision), readOnly });
  }
  catalog(sessionId?: string, targetId?: string) {
    const mcp = this.router.list().map(server => ({ kind: contract.PartnerConnectionKind.MCP, id: server.id,
      name: redactSecrets(server.displayName).slice(0, 256), available: server.enabled && server.state === "connected",
      inherited: server.enabled && server.state === "connected", identity: `${server.version}:${server.runtimeGeneration}` }));
    const toolsets = this.router.toolsetCatalog().map(item => ({ kind: contract.PartnerConnectionKind.TOOLSET, id: item.id,
      name: redactSecrets(item.name).slice(0, 256), available: item.available,
      inherited: item.available && (sessionId && targetId && this.inheritedToolsetEnabled
        ? this.inheritedToolsetEnabled(sessionId, targetId, item.id)
        : this.router.toolPolicyDeclarations().find(policy => policy.id === item.id)?.productDefaultEnabled === true), identity: item.revision }));
    const target = targetId ? this.store.getTarget(targetId).descriptor : undefined;
    const backendId = sessionId ? this.store.getSession(sessionId).descriptor.backendId : target?.backendId;
    const profile = targetId ? this.profiles.listPartners().find(item => item.homeTargetId === targetId && item.lifecycle !== "deleted") : undefined;
    const own = new Set(profile ? this.resources?.listPartnerSkills(profile.id, targetId!).map(item => item.resource.id) : []);
    const capability = backendId ? this.store.getBackend(backendId).descriptor.capabilities.get("runtime.resources") : undefined;
    const supported = capability?.supported === true && capability.options?.includes("skill") === true;
    const skills = target && this.resources ? this.resources.list({ kind: "skill" })
      .filter(item => item.backendId === backendId || own.has(item.id))
      .filter(item => item.state !== "removed" && (item.targetId === undefined || item.targetId === target.id))
      .map(item => ({ kind: contract.PartnerConnectionKind.SKILL, id: item.id, name: redactSecrets(item.name).slice(0, 256),
        available: !!supported && target.trusted && target.remoteWorkspace?.kind !== "ssh" && item.enabled && ["approved", "installed", "loaded"].includes(item.state)
          && !item.symbolicLinkDetected && !item.specialFileDetected, inherited: false, personal: own.has(item.id),
        identity: JSON.stringify([item.discoveredRevision, item.enabled, item.approvedAt, item.approvedByConnectionId,
          ["approved", "installed", "loaded"].includes(item.state) ? "ready" : item.state]) })) : [];
    const entries = [...skills, ...mcp, ...toolsets].sort((a, b) => a.kind - b.kind || a.id.localeCompare(b.id, "en"));
    return { entries, revision: createHash("sha256").update(JSON.stringify(entries)).digest("hex") };
  }
  read(partnerId: string): contract.PartnerConnections {
    const owner = this.owner(partnerId), saved = this.preferences.read(owner.homeTargetId), catalog = this.catalog(owner.canonicalSessionId, owner.homeTargetId);
    return create(contract.PartnerConnectionsSchema, { owner, ...(saved.revision ? { revision: toProtoRevision(saved.revision) } : {}),
      catalogRevision: catalog.revision, entries: catalog.entries.map(({ identity: _, ...entry }) => entry), mcp: protoSelection(saved.mcp), toolsets: protoSelection(saved.toolsets), skills: protoSelection(saved.skills) });
  }
  async readForClient(partnerId: string, signal: AbortSignal, query?: string): Promise<contract.PartnerConnections> {
    signal.throwIfAborted(); const value = this.read(partnerId);
    const matching = new Set<string>();
    const search = query?.trim().toLocaleLowerCase();
    if (this.skillMetadata && value.entries.some(item => item.kind === contract.PartnerConnectionKind.SKILL && item.available)) {
      const metadata = new Map((await this.skillMetadata(partnerId, signal)).map(item => [item.id, item]));
      signal.throwIfAborted(); const current = this.read(partnerId);
      if (current.owner!.revision!.value !== value.owner!.revision!.value || current.revision?.value !== value.revision?.value
        || current.catalogRevision !== value.catalogRevision) throw new ConnectError("Connection catalog changed. Refresh before saving.", Code.Aborted);
      for (const entry of value.entries) if (entry.kind === contract.PartnerConnectionKind.SKILL && metadata.has(entry.id)) {
        const item = metadata.get(entry.id)!;
        if (!search || `${entry.id} ${item.name} ${item.description}`.toLocaleLowerCase().includes(search)) matching.add(entry.id);
        entry.name = item.name.slice(0, 256); entry.description = item.description.slice(0, 1_000);
      }
    }
    if (search) value.entries = value.entries.filter(entry => matching.has(entry.id) || `${entry.id} ${entry.name} ${entry.description}`.toLocaleLowerCase().includes(search));
    return value;
  }
  update(request: contract.UpdatePartnerConnectionsRequest): contract.PartnerConnections {
    const profileRevision = fromProtoRevision(request.expectedPartnerRevision, "expected_partner_revision");
    const revision = request.expectedRevision ? fromProtoRevision(request.expectedRevision, "expected_revision") : undefined;
    const next = { mcp: fromSelection(request.mcp), toolsets: fromSelection(request.toolsets), skills: fromSelection(request.skills) };
    if (next.skills.mode !== "allowlist") throw new StoreError("Skill references require explicit selections.");
    this.store.transaction(() => {
      const owner = this.owner(request.partnerId, profileRevision, true), current = this.preferences.read(owner.homeTargetId), catalog = this.catalog(owner.canonicalSessionId, owner.homeTargetId);
      if (request.expectedCatalogRevision !== catalog.revision) throw new ConnectError("Connection catalog changed. Refresh before saving.", Code.Aborted);
      for (const [kind, name] of [[contract.PartnerConnectionKind.MCP, "mcp"], [contract.PartnerConnectionKind.TOOLSET, "toolsets"], [contract.PartnerConnectionKind.SKILL, "skills"]] as const) {
        if (kind === contract.PartnerConnectionKind.SKILL && next.skills.ids.some(id => catalog.entries.some(entry => entry.kind === kind && entry.id === id && "personal" in entry && entry.personal))) throw new StoreError("Personal skills are independent of external references.");
        for (const id of next[name].ids) if (!current[name].ids.includes(id) && !catalog.entries.some(entry => entry.kind === kind && entry.id === id && entry.available)) throw new StoreError("An unavailable connection cannot be selected.");
      }
      this.preferences.update(owner.homeTargetId, revision, next);
    });
    return this.read(request.partnerId);
  }
  targetReferences(targetId: string) {
    if (!this.profiles.listPartners().some(profile => profile.homeTargetId === targetId && profile.lifecycle !== "deleted")) return undefined;
    const saved = this.preferences.read(targetId);
    return { ...(saved.mcp.mode === "allowlist" ? { mcpIds: new Set(saved.mcp.ids) } : {}),
      ...(saved.toolsets.mode === "allowlist" ? { toolsetIds: new Set(saved.toolsets.ids) } : {}) };
  }
  targetSkillReferences(targetId: string): ReadonlySet<string> | undefined {
    const profile = this.profiles.listPartners().find(item => item.homeTargetId === targetId && item.lifecycle !== "deleted");
    if (!profile) return undefined;
    return new Set([...this.preferences.read(targetId).skills.ids, ...this.resources?.listPartnerSkills(profile.id, targetId).map(item => item.resource.id) ?? []]);
  }
  async nativeSkillPolicy(context: AdapterContext): Promise<NativeSkillPolicy | undefined> {
    const homeTargetId = this.groupHomeTarget(context.sessionId, context.target.id) ?? context.target.id;
    const profile = this.profiles.listPartners().find(item => item.homeTargetId === homeTargetId && item.lifecycle !== "deleted");
    if (!profile) return undefined;
    const target = this.store.getTarget(context.target.id), backend = this.store.getBackend(context.target.backendId).descriptor;
    const assertCurrent = () => {
      const current = this.profiles.getPartner(profile.id);
      // Host owns new/replacement Session binding admission. Before native
      // creation, neither that binding nor its canonical link is published yet.
      if (current.homeTargetId !== homeTargetId || homeTargetId !== context.target.id && this.groupHomeTarget(context.sessionId, context.target.id) !== homeTargetId
        || current.lifecycle !== "active" || current.pauseCleanupPending
        || target.descriptor.remoteWorkspace?.kind === "ssh" || context.target.remoteWorkspace?.kind === "ssh"
        || target.descriptor.backendId !== context.target.backendId && !new SessionRuntimeHandoffStore(this.store).admitsTarget({
          sessionId: context.sessionId, targetId: context.target.id, backendId: context.target.backendId, generation: context.generation,
          backendInstanceGeneration: context.backendInstanceGeneration ?? -1, workspaceRoot: context.target.workspaceRoot,
          ...(context.operationId === undefined ? {} : { operationId: context.operationId })
        })
        || this.store.getTarget(context.target.id).revision !== target.revision || !target.descriptor.trusted
        || backend.instanceGeneration !== context.backendInstanceGeneration
        || this.store.getBackend(backend.id).descriptor.instanceGeneration !== backend.instanceGeneration) throw new Error("The private skill runtime owner changed.");
    };
    assertCurrent();
    const allowed = this.targetSkillReferences(homeTargetId)!, overrides = new Map<string, "on" | "off">();
    const metadata = this.skillMetadata && profile.initializationState === "ready" ? await this.skillMetadata(profile.id, context.signal, context.target.backendId) : [];
    assertCurrent();
    for (const item of metadata) if (item.nativeName) overrides.set(item.nativeName,
      allowed.has(item.id) || overrides.get(item.nativeName) === "on" ? "on" : "off");
    return { mode: "explicit", overrides: Object.freeze(Object.fromEntries(overrides)), assertCurrent };
  }
  runtimeIdentity(session: SessionDescriptor): string | undefined {
    const link = this.profiles.getSessionLink(session.id); if (!link) return undefined;
    const profile = this.profiles.getPartner(link.partnerId);
    if (profile.homeTargetId !== session.targetId && this.groupHomeTarget(session.id, session.targetId) !== profile.homeTargetId || profile.lifecycle === "deleted") return undefined;
    const saved = this.preferences.read(profile.homeTargetId);
    return createHash("sha256").update(JSON.stringify([saved.mcp, saved.toolsets, saved.skills, this.catalog(profile.canonicalSessionId, profile.homeTargetId).revision])).digest("hex");
  }
}
type ConnectionMethods = Pick<ServiceImpl<typeof contract.PartnerService>, "getPartnerConnections" | "updatePartnerConnections">;
export function createPartnerConnectionMethods(manager: PartnerConnectionsManager | undefined, authenticate: (context: HandlerContext) => unknown): ConnectionMethods {
  const run = <T>(context: HandlerContext, operation: (manager: PartnerConnectionsManager) => Promise<T>): Promise<T> => {
    authenticate(context); context.signal.throwIfAborted(); if (!manager) throw new ConnectError("Partner connections are unavailable.", Code.Unimplemented);
    const failure = (error: unknown): never => {
      if (error instanceof ConnectError) throw error;
      if (error instanceof RevisionConflictError) throw new ConnectError("Connections changed. Refresh before saving.", Code.Aborted);
      if (error instanceof StoreError) throw new ConnectError("Connection references are invalid or unavailable.", Code.InvalidArgument);
      throw new ConnectError("Connections could not be read or changed.", Code.Unavailable);
    };
    try { return operation(manager).catch(failure); } catch (error) { return failure(error); }
  };
  return { getPartnerConnections: (request, context) => run(context, async owner => create(contract.GetPartnerConnectionsResponseSchema, { connections: await owner.readForClient(request.partnerId, context.signal) })),
    updatePartnerConnections: (request, context) => run(context, async owner => { owner.update(request); return create(contract.UpdatePartnerConnectionsResponseSchema, { connections: await owner.readForClient(request.partnerId, context.signal) }); }) };
}
