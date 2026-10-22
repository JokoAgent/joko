import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import type { PermissionMode, TargetDescriptor } from "@joko/core";
import { partnerHomeDirectoryName, type ConnectionRecord, type OperationalStore, type PartnerCapabilitiesRecord,
  type PartnerModelRouteRecord, type PartnerStore } from "@joko/store";
import type { ArtifactStore } from "./artifact-store.js";
import type { DevicePeerOwner, DevicePeerSelectionIdentity } from "./device-peer-owner.js";
import type { PartnerManager } from "./partner-manager.js";
import type { PartnerMemoryPreferences } from "./partner-memory-preferences.js";
import type { PartnerRoutineManager } from "./partner-routine-manager.js";
import type { PiResourceManager } from "./resource-manager.js";
import type { SessionHost } from "./session-host.js";
import type { WorkspaceService } from "./workspace-service.js";
import type { PartnerHomeFiles } from "./partner-home-files.js";
import { readPartnerHomeFiles } from "./partner-home-files.js";
import { copyPartnerHomeHistory } from "./partner-home-history.js";
import type { PartnerHomeSnapshots } from "./partner-home-snapshot.js";
import type { PartnerHomeWorkbench } from "./partner-home-workbench.js";
import { PartnerHomeError, type PartnerHomeLocation, type PartnerHomeMoveRecord, type PartnerHomeRecord,
  type PartnerHomeRuntime, type PartnerHomeStorage } from "./partner-home-owner.js";

export interface PartnerHomeModel {
  readonly route: PartnerModelRouteRecord;
  readonly displayName: string;
  readonly permissionModes: readonly PermissionMode[];
  readonly canSetPlanMode: boolean;
}
export interface PartnerHomeInspection { readonly location: PartnerHomeLocation; readonly platform: string; readonly models: readonly PartnerHomeModel[]; }
interface PortableProfile { readonly identity: string; readonly user: string; readonly instructions: string; }

/** The authority retains identity and approved data; each execution generation gets a fresh immutable Target. */
export class PartnerHomeRuntimeAdapter implements PartnerHomeRuntime {
  readonly authorityServerId: string;
  readonly local: PartnerHomeLocation & { readonly kind: "service" };
  constructor(private readonly options: { readonly serverId: string; readonly store: OperationalStore; readonly profiles: PartnerStore;
    readonly partners: PartnerManager; readonly host: SessionHost; readonly workspaces: WorkspaceService; readonly resources: PiResourceManager;
    readonly homesRoot: string; readonly peers: DevicePeerOwner; readonly files: PartnerHomeFiles; readonly storage: PartnerHomeStorage;
    readonly memoryPreferences: PartnerMemoryPreferences; readonly routines: PartnerRoutineManager; readonly artifacts: ArtifactStore;
    readonly snapshots: PartnerHomeSnapshots;
    readonly workbench?: PartnerHomeWorkbench;
    readonly ownedSessions: (partnerId: string) => readonly string[]; readonly assertOwner: () => void;
    readonly pauseGoal: (sessionId: string, operationId: string) => Promise<void>;
    readonly readProfileProjection: (partnerId: string, assertCurrent: () => void) => Promise<PortableProfile | undefined>;
    /** Adapter composition owns remote creation support. The UI never branches on Backend IDs. */
    readonly supportsRemoteCreation: (backendId: string) => boolean;
    readonly hasRemoteModelRoute: (backendId: string, providerId: string, modelId: string) => boolean;
    readonly retireWorkbench: (partnerId: string, targetId: string) => void;
  }) {
    this.authorityServerId = options.serverId;
    this.local = { kind: "service", deviceId: options.serverId, name: hostname() || "Service computer" };
  }
  assertOwner(): void { this.options.assertOwner(); }
  profile(partnerId: string) {
    this.assertOwner(); const profile = this.options.profiles.getPartner(partnerId);
    return { revision: profile.revision, lifecycle: profile.lifecycle, ready: profile.initializationState === "ready",
      ...(profile.canonicalSessionId ? { sessionId: profile.canonicalSessionId } : {}) };
  }
  sessions(partnerId: string): readonly string[] {
    const profile = this.options.profiles.getPartner(partnerId);
    const retired = new Set(this.options.storage.list().filter(move => move.partnerId === partnerId && move.committed).flatMap(move => move.sourceSessionIds));
    return [...new Set([...this.options.profiles.listSessionLinks(partnerId).flatMap(link => {
      let session; try { session = this.options.store.getSession(link.sessionId).descriptor; } catch { return []; }
      return session && session.targetId === profile.homeTargetId && link.role !== "history" ? [session.id] : [];
    }), ...this.options.ownedSessions(partnerId)])].filter(sessionId => !retired.has(sessionId));
  }
  management<T>(partnerId: string, action: () => Promise<T>): Promise<T> { return this.options.partners.runHomeManagement(partnerId, action); }

  targets(controller: ConnectionRecord): readonly { readonly selection?: DevicePeerSelectionIdentity; readonly name: string; readonly platform: string }[] {
    this.assertOwner(); return [{ name: this.local.name, platform: process.platform }, ...this.options.peers.list(controller)
      .filter(peer => peer.kind === "desktop" || peer.kind === "service")
      .map(peer => ({ selection: peer, name: peer.displayName, platform: peer.platform }))];
  }
  async inspect(controller: ConnectionRecord, partnerId: string, selected?: DevicePeerSelectionIdentity): Promise<PartnerHomeInspection> {
    this.profile(partnerId);
    if (!selected) return { location: this.local, platform: process.platform, models: this.#models(false) };
    const checked = await this.options.files.inspectDevice(controller, selected, partnerId); checked.assertCurrent(); this.assertOwner();
    return { location: checked.location, platform: checked.platform, models: this.#models(true) };
  }
  #models(remote: boolean): readonly PartnerHomeModel[] {
    return this.options.host.appDefaultModelChoices().flatMap(choice => {
      if (remote && (!this.options.supportsRemoteCreation(choice.backendId)
        || !this.options.hasRemoteModelRoute(choice.backendId, choice.providerId, choice.modelId))) return [];
      const backend = this.options.store.getBackend(choice.backendId).descriptor;
      const model = backend.models.find(item => item.providerId === choice.providerId && item.modelId === choice.modelId);
      const modes = backend.capabilities.get("permission.modes");
      if (!model || modes?.supported !== true) return [];
      return [{ route: { backendId: choice.backendId, providerId: choice.providerId, modelId: choice.modelId,
        ...(choice.effort ? { effort: choice.effort } : {}), fastMode: false }, displayName: `${model.displayName} · ${backend.displayName}`,
        permissionModes: (["ask", "acceptEdits", "auto", "bypassPermissions"] as const).filter(mode => modes.options?.includes(mode)),
        canSetPlanMode: backend.capabilities.get("plan_mode")?.supported === true }];
    });
  }
  async assertDestination(destination: PartnerHomeLocation, capabilities: PartnerCapabilitiesRecord): Promise<void> {
    this.assertOwner(); this.options.partners.validateHomeCapabilities(capabilities);
    if (destination.kind === "service") {
      if (destination.deviceId !== this.local.deviceId) throw new PartnerHomeError("target-unavailable", "This execution authority is unavailable.");
    } else {
      const current = this.options.peers.captureBinding(destination.controllerDeviceId, destination.deviceId, ["files", "process", "forwarding"]);
      current.assertCurrent(["files", "process", "forwarding"]);
      if (capabilities.modelChain.some(route => !this.options.supportsRemoteCreation(route.backendId))) {
        throw new PartnerHomeError("runtime-unavailable", "The selected computer cannot create this runtime.");
      }
    }
    const choices = this.#models(destination.kind === "device");
    if (capabilities.modelChain.some(route => !choices.some(choice => sameRoute(choice.route, route)))) {
      throw new PartnerHomeError("runtime-unavailable", "Select an available model for the new execution computer.");
    }
  }
  sourceAvailable(home: PartnerHomeRecord): boolean {
    if (home.location.kind === "service") return home.location.deviceId === this.local.deviceId;
    try { this.options.peers.captureBinding(home.location.controllerDeviceId, home.location.deviceId, ["files", "process"]).assertCurrent(); return true; }
    catch { return false; }
  }
  async busy(partnerId: string): Promise<boolean> {
    this.assertOwner();
    return this.options.routines.engine.list(partnerId).some(routine => routine.activity === "running")
      || this.sessions(partnerId).some(sessionId => this.options.store.listRuns({ sessionId, activeOnly: true, limit: 1 }).length > 0
      || this.options.store.listQueueItems({ sessionId, states: ["accepted", "dispatching", "backend_accepted", "dispatch_unknown"], limit: 1 }).length > 0
      || this.options.store.listInteractions({ sessionId, status: "open", limit: 1 }).length > 0);
  }
  async stop(move: PartnerHomeMoveRecord): Promise<void> {
    const assertCurrent = () => { this.assertOwner(); const latest = this.options.storage.move(move.requestId);
      if (latest?.fingerprint !== move.fingerprint || !latest.sourceFenced || latest.committed) {
      throw new PartnerHomeError("state-changed", "The shutdown owner changed."); } };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new PartnerHomeError("outcome-unknown", "The previous runtime has not confirmed shutdown.")), 30_000); });
    try {
      await Promise.race([Promise.all([...new Set([...move.sourceSessionIds, ...this.sessions(move.partnerId)])].map(async sessionId => {
        await this.options.pauseGoal(sessionId, `partner-home:${move.requestId}:pause:${sessionId}`); assertCurrent();
      await this.options.host.stopPartnerHomeSession(sessionId, assertCurrent); assertCurrent();
        for (;;) {
          const items = this.options.store.listQueueItems({ sessionId, states: ["accepted", "dispatching", "backend_accepted", "dispatch_unknown"], limit: 500 });
          if (!items.length) break;
          for (const item of items) { assertCurrent(); this.options.store.cancelQueueItem({ queueItemId: item.id, traceId: `partner-home:${move.requestId}:stopped` }); }
        }
      })), timeout]);
    } finally { clearTimeout(timer); }
  }
  async prepare(move: PartnerHomeMoveRecord, assertCurrent: () => void): Promise<string> {
    assertCurrent();
    await this.options.routines.suspendPartner(move.partnerId); assertCurrent();
    const source = this.options.store.getSession(move.sourceSessionId).descriptor;
    for (const target of this.options.store.listTargets()) if (target.descriptor.id === source.targetId
      || (target.metadata as { homeTargetId?: unknown } | null)?.homeTargetId === source.targetId) {
      await this.options.host.quiescePartnerTargetCreations(target.descriptor.id); assertCurrent();
    }
    const profile = this.options.profiles.getPartner(move.partnerId);
    const home = await this.options.partners.localHome(move.partnerId); assertCurrent();
    let snapshot = await this.options.snapshots.read(move, assertCurrent);
    if (!snapshot) {
      const preferences = this.options.memoryPreferences.read(source.targetId);
      const projection = await this.options.readProfileProjection(move.partnerId, assertCurrent); assertCurrent();
      const portable: PortableProfile = { identity: projection?.identity || profile.identitySource,
        user: preferences.userContext ?? projection?.user ?? "", instructions: projection?.instructions ?? "" };
      const avatar = typeof profile.avatar === "string" ? "AVATAR.svg" : profile.avatar.mimeType === "image/jpeg" ? "AVATAR.jpg"
        : profile.avatar.mimeType === "image/png" ? "AVATAR.png" : "AVATAR.webp";
      const files = [...await readPartnerHomeFiles(home, portable.identity, avatar, this.#memories(source.targetId), portable.user, assertCurrent),
        ...(portable.instructions ? [{ name: "INSTRUCTIONS.md", bytes: Buffer.from(portable.instructions) }] : [])];
      if (this.options.workbench) files.push({ name: "workbench.json", bytes: Buffer.from(JSON.stringify(await this.options.workbench.portable(profile.id, move.source.location, assertCurrent))) });
      const through = this.options.store.listEvents({ sessionId: source.id, order: "desc", limit: 1 })[0]?.globalCursor ?? 0n;
      const unavailableArtifactIds = await this.#verifyAttachments(source.id, through, assertCurrent); assertCurrent();
      snapshot = await this.options.snapshots.seal(move, { throughCursor: through.toString(),
        readThroughCursor: this.options.profiles.readState(profile.id).throughCursor.toString(), unavailableArtifactIds, profile: portable }, files, assertCurrent);
    }
    await this.options.files.prepare(move, snapshot.files, assertCurrent); assertCurrent();
    const target = this.#target(move, home), metadata = { kind: "partner_home", partnerId: move.partnerId,
      workspaceId: target.id, profileVersion: profile.profileVersion + 1, authorityDataRoot: home, homeGeneration: move.source.generation + 1 };
    await this.options.workspaces.register({ id: target.id, root: target.workspaceRoot, displayName: target.displayName, trusted: true,
      ...(target.remoteWorkspace ? { remote: { targetId: target.id, binding: target.remoteWorkspace } } : {}) }); assertCurrent();
    await this.options.host.registerTarget(target, metadata); assertCurrent();
    this.options.store.setSetting("target", target.id, "partner-home.profile", snapshot.metadata.profile);
    return snapshot.metadata.throughCursor;
  }
  async activate(move: PartnerHomeMoveRecord, assertCurrent: () => void): Promise<string> {
    assertCurrent(); const source = this.options.store.getSession(move.sourceSessionId).descriptor;
    const home = this.dataRootForPartner(move.partnerId), targetId = partnerHomeTargetId(move);
    const target = this.options.store.getTarget(targetId).descriptor;
    if (targetId !== target.id || target.workspaceRoot !== (move.destination.kind === "device" ? move.destination.root : home)) {
      throw new PartnerHomeError("state-changed", "The prepared home no longer matches its execution computer.");
    }
    const primary = move.capabilities.modelChain[0]!, profile = this.options.profiles.getPartner(move.partnerId);
    const snapshot = await this.options.snapshots.read(move, assertCurrent);
    if (!snapshot || snapshot.metadata.throughCursor !== move.historyThroughCursor) throw new PartnerHomeError("preparation-failed", "The sealed home data is unavailable.");
    await this.options.workbench?.move(move, assertCurrent); assertCurrent();
    await this.options.resources.movePartnerSkills({ partnerId: profile.id, sourceTargetId: source.targetId, targetId,
      backendId: primary.backendId, authorityRoot: home, assertCurrent }); assertCurrent();
    this.options.store.movePartnerMemory(source.targetId, targetId, profile.id);
    this.options.memoryPreferences.move(source.targetId, targetId); assertCurrent();
    const created = await this.options.host.createServiceSession({ operationId: `partner-home:${move.requestId}:session`, serviceKind: "partner",
      targetId, title: profile.displayName, providerId: primary.providerId, modelId: primary.modelId,
      ...(primary.effort ? { effort: primary.effort } : {}), fastMode: primary.fastMode, permissionMode: move.capabilities.permissionMode,
      planMode: move.capabilities.planMode, appendSystemPrompt: profile.identitySource, assertServiceScope: assertCurrent }); assertCurrent();
    const sessionId = created.value.sessionId;
    const restored = copyPartnerHomeHistory({ store: this.options.store, requestId: move.requestId, sourceSessionId: source.id,
      targetSessionId: sessionId, throughCursor: BigInt(move.historyThroughCursor!), readThroughCursor: BigInt(snapshot.metadata.readThroughCursor),
      unavailableArtifactIds: new Set(snapshot.metadata.unavailableArtifactIds),
      sourceName: move.source.location.name, assertCurrent }); assertCurrent();
    await this.management(move.partnerId, async () => {
      assertCurrent(); const live = this.options.profiles.getPartner(profile.id);
      if (live.canonicalSessionId !== sessionId) this.options.profiles.moveHome({ partnerId: profile.id, expectedRevision: BigInt(move.partnerRevision),
        sourceSessionId: source.id, targetId, sessionId, capabilities: move.capabilities });
    }); assertCurrent();
    await this.options.host.rebuildPartnerHomeContext(sessionId, `partner-home:${move.requestId}:context`, assertCurrent); assertCurrent();
    this.options.profiles.markRead(profile.id, restored.readThroughCursor);
    this.options.retireWorkbench(profile.id, source.targetId);
    await this.options.routines.prepareHomeChange(profile.id, move.requestId, assertCurrent); assertCurrent();
    return sessionId;
  }
  async settled(move: PartnerHomeMoveRecord): Promise<void> {
    if (move.phase === "ready" || !move.committed && !move.sourceFenced) await this.options.routines.resumePartner(move.partnerId);
  }
  dataRootForPartner(partnerId: string): string { return join(resolve(this.options.homesRoot), partnerHomeDirectoryName(partnerId)); }
  dataRoot(targetId: string): string | undefined {
    const target = this.options.store.getTarget(targetId), metadata = target.metadata as Record<string, unknown> | null;
    if (!metadata || metadata.kind !== "partner_home" || typeof metadata.partnerId !== "string") return undefined;
    const root = this.dataRootForPartner(metadata.partnerId);
    if (metadata.authorityDataRoot !== root) return undefined;
    const profile = this.options.profiles.getPartner(metadata.partnerId);
    const prepared = this.options.storage.list().some(move => move.partnerId === profile.id && partnerHomeTargetId(move) === targetId);
    return profile.homeTargetId === targetId || prepared ? root : undefined;
  }
  blocksInput(sessionId: string): boolean {
    if (this.options.storage.freezesInput(sessionId)) return true;
    const session = this.options.store.getSession(sessionId).descriptor;
    return this.blocksTarget(session.targetId) || this.options.storage.list().some(move => partnerHomeTargetId(move) === session.targetId && move.phase !== "ready");
  }
  blocksTarget(targetId: string): boolean {
    const metadata = this.options.store.getTarget(targetId).metadata as { homeTargetId?: unknown } | null;
    const root = typeof metadata?.homeTargetId === "string" ? metadata.homeTargetId : targetId;
    return this.options.storage.list().some(move => this.options.store.getSession(move.sourceSessionId).descriptor.targetId === root
      && (move.committed || move.sourceFenced));
  }
  blocksExecution(sessionId: string): boolean {
    if (this.options.storage.blocksSession(sessionId)) return true;
    const session = this.options.store.getSession(sessionId).descriptor;
    const metadata = this.options.store.getTarget(session.targetId).metadata as { homeTargetId?: unknown } | null;
    const root = typeof metadata?.homeTargetId === "string" ? metadata.homeTargetId : session.targetId;
    return this.options.storage.list().some(move => this.options.store.getSession(move.sourceSessionId).descriptor.targetId === root
      && (move.committed || move.sourceFenced && move.resumePhase !== "waiting"));
  }
  executionHome(targetId: string): TargetDescriptor | undefined {
    const target = this.options.store.getTarget(targetId), metadata = target.metadata as Record<string, unknown> | null;
    if (!metadata || typeof metadata.partnerId !== "string") return undefined;
    if (metadata.kind === "partner_home" && this.dataRoot(targetId) !== undefined) return target.descriptor;
    if (!["partner_workbench", "partner_session_task"].includes(String(metadata.kind)) || typeof metadata.homeTargetId !== "string"
      || typeof metadata.homeCanonicalSessionId !== "string") return undefined;
    const profile = this.options.profiles.getPartner(metadata.partnerId);
    if (profile.homeTargetId !== metadata.homeTargetId || profile.canonicalSessionId !== metadata.homeCanonicalSessionId) return undefined;
    const home = this.options.store.getTarget(profile.homeTargetId).descriptor;
    const child = target.descriptor.remoteWorkspace, binding = home.remoteWorkspace;
    if (child?.kind !== "device_peer" || binding?.kind !== "device_peer" || child.controllerDeviceId !== binding.controllerDeviceId || child.targetDeviceId !== binding.targetDeviceId) return undefined;
    return home;
  }
  #target(move: PartnerHomeMoveRecord, home: string): TargetDescriptor {
    const profile = this.options.profiles.getPartner(move.partnerId), destination = move.destination;
    return { id: partnerHomeTargetId(move), backendId: move.capabilities.modelChain[0]!.backendId, displayName: `${profile.displayName} home`,
      workspaceRoot: destination.kind === "device" ? destination.root : home, trusted: true, managed: true,
      ...(destination.kind === "device" ? { remoteWorkspace: { kind: "device_peer" as const, controllerDeviceId: destination.controllerDeviceId,
        targetDeviceId: destination.deviceId, workspaceRoot: destination.root } } : {}) };
  }
  #memories(targetId: string) {
    const entries: { id: string; title: string; body: string }[] = [];
    for (let offset = 0;; offset += 1000) { const page = this.options.store.listMakerMemoryEntries({ targetId, limit: 1000, offset });
      entries.push(...page.filter(item => item.kind !== "digest")); if (page.length < 1000) return entries; }
  }
  async #verifyAttachments(sessionId: string, through: bigint, assertCurrent: () => void): Promise<readonly string[]> {
    const unavailable = new Set<string>(), checked = new Set<string>();
    const verify = async (blob: import("@joko/core").BlobRef): Promise<void> => {
      if (checked.has(blob.id)) return; checked.add(blob.id);
      const artifact = this.options.store.findArtifact(blob.id), metadata = artifact?.metadata as { expiresAt?: number; audio?: import("@joko/core").AudioArtifactMetadata } | undefined;
      if (!artifact || artifact.deletedAt !== undefined || artifact.sessionId !== undefined && artifact.sessionId !== sessionId
        || blob.byteLength > 25 * 1024 * 1024 || typeof metadata?.expiresAt === "number" && metadata.expiresAt <= Date.now()) { unavailable.add(blob.id); return; }
      try { await this.options.artifacts.resolveBlobPath(blob); assertCurrent(); }
      catch (error) { assertCurrent(); if ((error as NodeJS.ErrnoException).code === "ENOENT") { unavailable.add(blob.id); return; } throw error; }
      if (metadata?.audio?.artwork) await verify(metadata.audio.artwork.blob);
    };
    let afterCursor = 0n;
    for (;;) { const page = this.options.store.listEvents({ sessionId, afterCursor, limit: 1000 }); if (!page.length) return [...unavailable];
      for (const event of page) {
        if (event.globalCursor > through) return [...unavailable]; afterCursor = event.globalCursor;
        if (event.payload.type !== "message_complete" || event.payload.role !== "user" || event.payload.partnerPrivateOrigin || event.payload.automaticContinuation || event.payload.objectiveContinuation || event.payload.inputHandoffContinuation) continue;
        for (const block of event.payload.blocks) if (block.kind === "image" || block.kind === "artifact") {
          await verify(block.blob); assertCurrent();
          if (block.kind === "artifact" && block.audioMetadata?.artwork) { await verify(block.audioMetadata.artwork.blob); assertCurrent(); }
        }
      }
      if (page.length < 1000) return [...unavailable];
    }
  }
}

export function partnerHomeTargetId(move: PartnerHomeMoveRecord): string {
  return `partner-home:${createHash("sha256").update(JSON.stringify([move.partnerId, move.source.generation + 1, move.requestId])).digest("hex").slice(0, 40)}`;
}
function sameRoute(left: PartnerModelRouteRecord, right: PartnerModelRouteRecord): boolean {
  return left.backendId === right.backendId && left.providerId === right.providerId && left.modelId === right.modelId;
}
