import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import { redactSecrets, type PartnerGroupLane, type PartnerGroupPlan, type PartnerGroupRecord, type PromptInput, type SessionDescriptor } from "@joko/core";
import { PartnerGroupStore, PartnerStore, type OperationalStore, type PartnerProfileRecord } from "@joko/store";
import type { PartnerGroupRuntime, PartnerGroupSession, PartnerGroupTurnResult } from "./partner-group-manager.js";
import type { SessionHost } from "./session-host.js";
import type { SessionRuntimeProfile } from "./session-runtime-control.js";
import type { WorkspaceService } from "./workspace-service.js";

const STOP_SCOPE = "partner-group-runtime";
interface StopReceipt { readonly version: 1; readonly operationId: string; readonly phase: "holding" | "stopped"; readonly queuePauseRevision?: string; }

/** Hidden Sessions use the same native, Queue and private-profile owners as other Partner work. */
export class PartnerGroupSessionRuntime implements PartnerGroupRuntime {
  readonly #held = new Set<string>();
  readonly #retiring = new Set<string>();
  readonly #stops = new Map<string, Promise<boolean>>();
  constructor(readonly groups: PartnerGroupStore, readonly profiles: PartnerStore, readonly store: OperationalStore,
    readonly host: SessionHost, readonly workspaces: Pick<WorkspaceService, "register">) {
    // This owner must exist before SessionHost.initialize can drain recovered inputs.
    for (const lane of groups.lanes()) if (lane.sessionId && lane.phase !== "archived") this.#held.add(lane.sessionId);
  }
  #lane(sessionId: string): PartnerGroupLane | undefined { return this.groups.lanes().find(lane => lane.sessionId === sessionId); }
  isGroupSession(sessionId: string): boolean { return this.profiles.getSessionLink(sessionId)?.role === "group"; }
  interactionChanged(sessionId: string): void {
    const lane = this.#lane(sessionId); if (lane && this.groups.find(lane.groupId)?.lifecycle === "active") this.groups.appendChange(lane.groupId, "round");
  }
  isGroupTarget(targetId: string): boolean {
    const metadata = this.store.getTarget(targetId).metadata;
    return metadata !== null && typeof metadata === "object" && !Array.isArray(metadata) && "kind" in metadata && metadata.kind === "partner_group";
  }
  isHeld(sessionId: string): boolean { return this.#held.has(sessionId) || this.store.findSetting("service", STOP_SCOPE, sessionId) !== undefined; }
  isRetiring(sessionId: string): boolean {
    const lane = this.#lane(sessionId);
    return this.#retiring.has(sessionId) || lane !== undefined && (lane.phase === "archived" || this.groups.find(lane.groupId)?.lifecycle !== "active");
  }
  ownedSessions(partnerId: string): readonly string[] { return this.groups.lanes().filter(lane => lane.partnerId === partnerId && lane.sessionId).map(lane => lane.sessionId!); }
  homeTarget(sessionId: string, targetId: string): string | undefined {
    const lane = this.#lane(sessionId), link = this.profiles.getSessionLink(sessionId);
    if (!lane || lane.phase === "archived" || link?.role !== "group" || link.partnerId !== lane.partnerId) return undefined;
    const profile = this.profiles.getPartner(lane.partnerId), target = this.store.getTarget(targetId).descriptor;
    if (profile.lifecycle !== "active" || profile.initializationState !== "ready" || !target.trusted || target.remoteWorkspace !== undefined) return undefined;
    if (lane.planId === null) return targetId === profile.homeTargetId ? profile.homeTargetId : undefined;
    const plan = this.groups.getPlan(lane.planId);
    return plan.groupId === lane.groupId && plan.workDir !== null && target.workspaceRoot === plan.workDir ? profile.homeTargetId : undefined;
  }
  validTarget(session: SessionDescriptor, partnerId: string): boolean {
    const lane = this.#lane(session.id);
    if (!lane || lane.partnerId !== partnerId || lane.phase === "archived") return false;
    if (lane.planId === null) return session.targetId === this.profiles.getPartner(partnerId).homeTargetId;
    const plan = this.groups.getPlan(lane.planId), target = this.store.getTarget(session.targetId).descriptor;
    return plan.groupId === lane.groupId && plan.workDir !== null && target.workspaceRoot === plan.workDir && target.trusted && target.remoteWorkspace === undefined;
  }
  fallback(input: { readonly sessionId: string; readonly current: SessionRuntimeProfile; readonly visitedRoutes: readonly string[]; readonly currentHop: number }) {
    const lane = this.#lane(input.sessionId); if (!lane) return { owned: false };
    const profile = this.profiles.getPartner(lane.partnerId);
    if (profile.lifecycle !== "active" || profile.initializationState !== "ready" || this.isHeld(input.sessionId)) return { owned: true };
    const version = this.profiles.listProfileVersions(profile.id).find(item => item.version === lane.profileVersion);
    const routes = version?.capabilities.modelChain ?? [];
    const key = (route: SessionRuntimeProfile) => JSON.stringify([route.backendId, route.providerId, route.modelId]);
    const visited = new Set([...input.visitedRoutes, key(input.current)]), index = routes.findIndex(route => key(route) === key(input.current));
    const candidate = input.currentHop >= routes.length - 1 ? undefined : routes.slice(Math.max(0, index + 1)).find(route => !visited.has(key(route)));
    return candidate ? { owned: true, candidate } : { owned: true };
  }
  async recover(lanes: readonly PartnerGroupLane[]): Promise<void> {
    for (const saved of lanes) {
      const lane = this.#observeCreation(saved);
      if (lane.sessionId === null || lane.phase === "archived") continue;
      // Recovery closes the old execution; a new group send or explicit step retry owns the next input.
      await this.stop(lane.sessionId);
    }
  }
  #observeCreation(lane: PartnerGroupLane): PartnerGroupLane {
    const operation = this.store.findOperation<{ sessionId: string }>(lane.operationId);
    if (operation?.status === "completed" && operation.response?.sessionId) {
      const sessionId = operation.response.sessionId;
      const link = this.profiles.getSessionLink(sessionId);
      if (link?.role !== "group" || link.partnerId !== lane.partnerId) throw unavailable();
      this.store.getSession(sessionId);
      if (lane.phase !== "ready" || lane.sessionId !== sessionId) return this.groups.updateLane(lane, { phase: "ready", sessionId, profileVersion: link.profileVersion });
    }
    return lane;
  }
  async ensureLane(input: Parameters<PartnerGroupRuntime["ensureLane"]>[0]): Promise<PartnerGroupSession> {
    const { group, partner, plan } = input;
    const assertProfile = () => {
      input.signal.throwIfAborted(); input.assertCurrent();
      const current = this.profiles.getPartner(partner.id);
      if (current.revision !== partner.revision || current.profileVersion !== partner.profileVersion || current.lifecycle !== "active"
        || current.initializationState !== "ready" || current.pauseCleanupPending || this.profiles.isPartnerSessionRestarting(current.canonicalSessionId ?? "")) throw unavailable();
    };
    assertProfile();
    let lane = this.groups.claimLane({ groupId: group.id, partnerId: partner.id, planId: plan?.id ?? null, profileVersion: partner.profileVersion, operationId: `group-lane:${randomUUID()}` });
    lane = this.#observeCreation(lane);
    if (lane.phase === "archived") throw unavailable();
    if (lane.phase === "unknown") {
      const original = this.store.findOperation(lane.operationId);
      // The private callback commits the lane Session id before any native creation.
      // A terminal call that never reached that callback has no native effect to repeat.
      if (lane.sessionId === null && (!original || original.status === "failed")) lane = this.groups.retryClosedLane(lane, `group-lane:${randomUUID()}`);
      else if (lane.sessionId !== null && this.host.isPrivateSessionCreationClosed(lane.operationId, lane.sessionId)) {
        const closed = lane;
        this.profiles.discardUnstoredGroupSessionLink(closed.sessionId!, closed.partnerId, closed.profileVersion);
        lane = this.groups.retryClosedLane(closed, `group-lane:${randomUUID()}`);
        this.#held.delete(closed.sessionId!); this.host.releasePrivateSessionCreationReceipt(closed.operationId, closed.sessionId!);
      }
    }
    const targetId = await this.#target(group, partner, plan, assertProfile); assertProfile();
    const target = this.store.getTarget(targetId);
    const directory = await realpath(target.descriptor.workspaceRoot); assertProfile();
    if (directory !== target.descriptor.workspaceRoot || !(await stat(directory)).isDirectory()) throw unavailable();
    const assertTarget = () => { assertProfile(); const live = this.store.getTarget(targetId);
      if (live.revision !== target.revision || !live.descriptor.trusted || live.descriptor.remoteWorkspace !== undefined || live.descriptor.workspaceRoot !== directory) throw unavailable(); };
    const primary = partner.capabilities.modelChain[0]!;
    let fresh = false;
    if (lane.phase !== "ready") {
      // A claimed native effect is observed through its original Operation, never recreated under another identity.
      if (lane.phase === "unknown" || this.store.findOperation(lane.operationId) !== undefined) throw unavailable();
      try {
        const created = await this.host.createServiceSession({ operationId: lane.operationId, serviceKind: "partner", targetId, runtimeBackendId: primary.backendId,
          title: `${group.name} · ${partner.displayName}`, providerId: primary.providerId, modelId: primary.modelId,
          ...(primary.effort === undefined ? {} : { effort: primary.effort }), fastMode: primary.fastMode,
          permissionMode: partner.capabilities.permissionMode, planMode: partner.capabilities.planMode, appendSystemPrompt: partner.identitySource,
          nativeStart: { kind: "new" }, initialPlacement: "dialogue", assertServiceScope: assertTarget,
          preparePrivateSession: async sessionId => {
            assertTarget();
            this.profiles.bindGroupSession({ partnerId: partner.id, expectedRevision: partner.revision, profileVersion: partner.profileVersion, sessionId });
            lane = this.groups.updateLane(lane, { phase: "preparing", sessionId, profileVersion: partner.profileVersion });
            this.#held.add(sessionId);
          } });
        lane = this.groups.updateLane(lane, { phase: "ready", sessionId: created.value.sessionId, profileVersion: partner.profileVersion });
        fresh = true;
      } catch (error) {
        lane = this.groups.updateLane(lane, { phase: "unknown", sessionId: lane.sessionId, profileVersion: lane.profileVersion });
        throw error;
      }
    }
    if (!lane.sessionId) throw unavailable();
    const sessionId = lane.sessionId;
    if (!fresh && this.#held.has(sessionId) && !this.#readStop(sessionId) && !await this.stop(sessionId)) throw unavailable();
    const stopped = this.#readStop(sessionId); if (stopped?.phase === "holding" && !await this.stop(sessionId)) throw unavailable();
    assertTarget();
    const session = this.store.getSession(sessionId).descriptor;
    if (session.targetId !== targetId || session.archived || session.deletedAt !== undefined || !this.validTarget(session, partner.id)) throw unavailable();
    if (lane.profileVersion !== partner.profileVersion) {
      const link = this.profiles.getSessionLink(sessionId);
      if (link?.profileVersion !== lane.profileVersion) throw unavailable();
      this.profiles.advanceGroupSessionProfile(sessionId, lane.profileVersion, partner.revision);
      lane = this.groups.updateLane(lane, { phase: "ready", sessionId, profileVersion: partner.profileVersion });
    }
    await this.host.updateServiceSessionPrompt(sessionId, partner.identitySource); assertTarget();
    const runtime = this.host.getSessionRuntimeControl(sessionId);
    const route = runtime.pending?.profile ?? runtime.effective;
    if (!route || route.backendId !== primary.backendId || route.providerId !== primary.providerId || route.modelId !== primary.modelId
      || route.effort !== primary.effort || route.fastMode !== primary.fastMode) {
      this.store.updateSession(sessionId, { permissionMode: partner.capabilities.permissionMode, planMode: partner.capabilities.planMode });
      await this.host.setSessionRuntimeControl({ sessionId, expectedGeneration: runtime.generation, patch: { ...primary } }); assertTarget();
    }
    const settings = await this.host.applySessionSettings(sessionId, { providerId: primary.providerId, modelId: primary.modelId,
      ...(primary.effort === undefined ? {} : { effort: primary.effort }), fastMode: primary.fastMode,
      permissionMode: partner.capabilities.permissionMode, planMode: partner.capabilities.planMode }, { requireNativeObservation: true, reconcileNativePolicy: true });
    assertTarget();
    if (!settings || settings.providerId !== primary.providerId || settings.modelId !== primary.modelId || settings.fastMode !== primary.fastMode
      || settings.permissionMode !== undefined && settings.permissionMode !== partner.capabilities.permissionMode
      || settings.planMode !== undefined && settings.planMode !== partner.capabilities.planMode) throw unavailable();
    this.store.updateSession(sessionId, { title: `${group.name} · ${partner.displayName}`, permissionMode: partner.capabilities.permissionMode,
      planMode: partner.capabilities.planMode, effort: primary.effort ?? null });
    this.#resume(sessionId);
    const profileVersion = lane.profileVersion;
    const assertCurrent = () => { assertTarget(); const current = this.store.getSession(sessionId).descriptor, link = this.profiles.getSessionLink(sessionId);
      if (current.targetId !== targetId || current.archived || current.deletedAt !== undefined || link?.role !== "group"
        || link.partnerId !== partner.id || link.profileVersion !== profileVersion || this.isRetiring(sessionId)) throw unavailable(); };
    assertCurrent(); return { sessionId, assertCurrent };
  }
  async #target(group: PartnerGroupRecord, partner: PartnerProfileRecord, plan: PartnerGroupPlan | undefined, assertCurrent: () => void): Promise<string> {
    if (!plan) return partner.homeTargetId;
    if (plan.groupId !== group.id || !plan.workDir) throw unavailable();
    const directory = await realpath(plan.workDir); assertCurrent();
    if (directory !== plan.workDir || !(await stat(directory)).isDirectory()) throw unavailable();
    const targetId = `group-target:${createHash("sha256").update(JSON.stringify([group.id, plan.id, partner.id, directory])).digest("hex").slice(0, 32)}`;
    if (!this.store.listTargets().some(item => item.descriptor.id === targetId)) {
      await this.workspaces.register({ id: targetId, root: directory, displayName: group.name, trusted: true }); assertCurrent();
      await this.host.registerTarget({ id: targetId, backendId: partner.capabilities.modelChain[0]!.backendId, workspaceRoot: directory,
        displayName: basename(directory), trusted: true, managed: group.projectDir === null }, { workspaceId: targetId, kind: "partner_group", partnerId: partner.id }); assertCurrent();
    }
    const target = this.store.getTarget(targetId).descriptor;
    if (target.workspaceRoot !== directory || !target.trusted || target.remoteWorkspace !== undefined) throw unavailable();
    return targetId;
  }
  async execute(input: Parameters<PartnerGroupRuntime["execute"]>[0]): Promise<PartnerGroupTurnResult> {
    const { sessionId } = input.lane; input.signal.throwIfAborted(); input.lane.assertCurrent();
    if (this.isHeld(sessionId)) throw unavailable();
    const prompt: PromptInput = { text: input.prompt,
      images: input.attachments.filter(item => item.category === "image").map(item => ({ blob: item.blob, alt: item.name })),
      files: input.attachments.filter(item => item.category !== "image").map(item => ({ blob: item.blob })), mentions: [], disposition: "prompt" };
    const admitted = this.host.enqueueServiceInput({ operationId: `group-input:${input.clientId}`, sessionId, source: "system", prompt });
    let accepted = false;
    while (!input.signal.aborted) {
      input.lane.assertCurrent();
      const item = this.store.getQueueItem(admitted.value.queueItemId), run = this.store.getRun(admitted.value.runId).descriptor;
      if (!accepted && item.backendAcceptedAt !== undefined) { input.onAccepted(); accepted = true; }
      if (run.state === "dispatch_unknown" || run.error?.stateMayHaveChanged) { await this.stop(sessionId); return { status: "unknown", text: "" }; }
      if (run.state === "completed") return { status: "completed", text: this.#reply(sessionId, run.id) };
      if (run.state === "failed") return { status: "failed", text: "" };
      if (run.state === "aborted" || item.state === "cancelled") return { status: "cancelled", text: "" };
      await waitForObservation(input.signal);
    }
    return { status: "cancelled", text: "" };
  }
  #reply(sessionId: string, runId: string): string {
    let beforeCursor: bigint | undefined;
    for (;;) {
      const events = this.store.listEvents({ sessionId, order: "desc", limit: 200, ...(beforeCursor === undefined ? {} : { beforeCursor }) });
      for (const event of events) if (event.runId === runId && event.payload.type === "message_complete" && event.payload.role === "assistant") {
        return redactSecrets(event.payload.blocks.filter(block => block.kind === "text").map(block => block.text).join("\n")).trim();
      }
      if (events.length < 200) return "";
      beforeCursor = events.at(-1)!.globalCursor;
    }
  }
  hasPendingInteraction(sessionId: string): boolean { return this.store.listInteractions({ sessionId, status: "open", limit: 1 }).length > 0; }
  #readStop(sessionId: string): StopReceipt | undefined {
    const record = this.store.findSetting<StopReceipt>("service", STOP_SCOPE, sessionId)?.value;
    if (record && (typeof record !== "object" || Array.isArray(record)
      || Object.keys(record).some(key => !["version", "operationId", "phase", "queuePauseRevision"].includes(key))
      || record.version !== 1 || typeof record.operationId !== "string" || !record.operationId.startsWith("group-stop:") || record.operationId.length > 100
      || !["holding", "stopped"].includes(record.phase)
      || record.queuePauseRevision !== undefined && (typeof record.queuePauseRevision !== "string" || !/^[1-9][0-9]{0,15}$/u.test(record.queuePauseRevision) || BigInt(record.queuePauseRevision) > BigInt(Number.MAX_SAFE_INTEGER)))) throw unavailable();
    return record;
  }
  #saveStop(sessionId: string, receipt: StopReceipt): void { this.store.setSetting("service", STOP_SCOPE, sessionId, receipt); }
  stop(sessionId: string): Promise<boolean> {
    const pending = this.#stops.get(sessionId); if (pending) return pending;
    const action = this.#stop(sessionId).finally(() => this.#stops.delete(sessionId)); this.#stops.set(sessionId, action); return action;
  }
  async #stop(sessionId: string): Promise<boolean> {
    const lane = this.#lane(sessionId); if (!lane) return false;
    this.#held.add(sessionId);
    let receipt = this.#readStop(sessionId);
    if (receipt?.phase === "stopped") return true;
    receipt ??= { version: 1, operationId: `group-stop:${randomUUID()}`, phase: "holding" }; this.#saveStop(sessionId, receipt);
    try {
      const before = this.store.getSession(sessionId).descriptor;
      const assertCurrent = () => { const current = this.store.getSession(sessionId).descriptor;
        if (current.targetId !== before.targetId || current.binding.generation !== before.binding.generation || this.#lane(sessionId)?.operationId !== lane.operationId) throw unavailable(); };
      const revision = this.host.preparePartnerPauseQueue({ sessionId, operationId: receipt.operationId, wasQueuePaused: this.store.getQueueControl(sessionId).paused });
      if (revision !== undefined) { receipt = { ...receipt, queuePauseRevision: revision.toString() }; this.#saveStop(sessionId, receipt); }
      await this.host.pausePartnerSession({ sessionId, operationId: receipt.operationId, assertCurrent, pauseGoal: async () => undefined, cancelQueued: true });
      assertCurrent(); this.#saveStop(sessionId, { ...receipt, phase: "stopped" }); return true;
    } catch { return false; }
  }
  #resume(sessionId: string): void {
    const receipt = this.#readStop(sessionId);
    if (receipt?.phase === "holding") throw unavailable();
    if (receipt) {
      this.host.restorePartnerQueue({ sessionId, operationId: receipt.operationId, ...(receipt.queuePauseRevision ? { queuePauseRevision: BigInt(receipt.queuePauseRevision) } : {}) });
      this.store.deleteSetting("service", STOP_SCOPE, sessionId);
    }
    this.#held.delete(sessionId);
  }
  async archive(saved: PartnerGroupLane): Promise<void> {
    const lane = this.#observeCreation(saved);
    if (lane.phase === "archived") return;
    if (lane.sessionId === null) {
      const original = this.store.findOperation(lane.operationId);
      if (original && original.status !== "failed") throw unavailable();
      this.groups.updateLane(lane, { phase: "archived", sessionId: null, profileVersion: lane.profileVersion }); return;
    }
    const sessionId = lane.sessionId;
    if (this.host.isPrivateSessionCreationClosed(lane.operationId, sessionId)) {
      this.profiles.discardUnstoredGroupSessionLink(sessionId, lane.partnerId, lane.profileVersion);
      this.groups.updateLane(lane, { phase: "archived", sessionId, profileVersion: lane.profileVersion });
      this.#held.delete(sessionId); this.host.releasePrivateSessionCreationReceipt(lane.operationId, sessionId); return;
    }
    this.#retiring.add(sessionId); this.#held.add(sessionId);
    await this.host.retirePartnerSession(sessionId, `${lane.operationId}:archive`);
    this.groups.updateLane(lane, { phase: "archived", sessionId, profileVersion: lane.profileVersion });
    this.store.deleteSetting("service", STOP_SCOPE, sessionId);
  }
}
function unavailable(): Error { return new Error("The group execution owner is unavailable or awaiting confirmed recovery."); }
function waitForObservation(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => { const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, 100); signal.addEventListener("abort", finish, { once: true }); if (signal.aborted) finish(); });
}
