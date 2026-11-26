import { createHash } from "node:crypto";
import type { SessionDescriptor } from "@joko/core";
import type { OperationalStore, PartnerStore } from "@joko/store";
import type { PartnerManager } from "./partner-manager.js";
import type { PartnerSessionTaskManager } from "./partner-session-tasks.js";
import type { PartnerHomeRuntimeAdapter } from "./partner-home-runtime.js";
import type { DevicePeerOwner } from "./device-peer-owner.js";

type GlancePhase = "running" | "waiting-permission" | "waiting-answer" | "errored" | "usage-limit" | "idle";
export interface PartnerObservedTask {
  readonly sessionId: string; readonly targetId: string; readonly generation: number; readonly title: string;
  readonly phase: GlancePhase; readonly phaseSince: number; readonly startedAt?: number; readonly question?: string;
  readonly creatorPartnerId?: string; readonly interactionId?: string; readonly readOnly: boolean;
  readonly online: boolean; readonly deviceId?: string; readonly deviceName?: string;
}

/** Glance reads the original tasks on demand. Opening it never schedules work. */
export class PartnerAutonomyManager {
  constructor(readonly options: { readonly store: OperationalStore; readonly profiles: PartnerStore; readonly partners: PartnerManager;
    readonly tasks: PartnerSessionTaskManager; readonly home?: () => PartnerHomeRuntimeAdapter | undefined;
    readonly peers?: Pick<DevicePeerOwner, "captureBinding">; readonly now?: () => number }) {}

  glance(partnerId: string, token = "", offset = 0) {
    const { store, profiles, partners, tasks } = this.options;
    const partner = partners.getPartner(partnerId);
    if (partner.lifecycle === "deleted" || partner.lifecycle === "archived" || partner.initializationState !== "ready"
      || !partner.canonicalSessionId || partners.isHomeChanging(partnerId)) throw new Error("The Partner is unavailable.");
    const home = store.getSession(partner.canonicalSessionId).descriptor;
    if (home.archived || home.deletedAt !== undefined || home.targetId !== partner.homeTargetId) throw new Error("The Partner home changed.");
    if (home.remoteWorkspace) {
      const runtime = this.options.home?.();
      if (!runtime) throw new Error("The Partner's execution computer is unavailable.");
      runtime.assertDeviceHomeCurrent(partner, home, store.getTarget(home.targetId));
    }
    const ids = new Set<string>();
    const creators = new Map<string, string>();
    for (const { descriptor } of store.listSessions({ targetId: partner.homeTargetId, includeArchived: true, excludeHidden: true })) ids.add(descriptor.id);
    for (const id of tasks.ownedSessions(partnerId)) { ids.add(id); creators.set(id, partnerId); }
    for (const task of profiles.listDelegations(partnerId)) {
      if (task.childSessionId) { ids.add(task.childSessionId); creators.set(task.childSessionId, task.requesterPartnerId); }
    }
    for (const row of store.listSettings("service", "partner.workbench.background")) {
      const task = row.value as { version?: number; sessionId?: string; partnerId?: string; status?: string } | null;
      if (task?.version !== 1 || typeof task.sessionId !== "string" || typeof task.partnerId !== "string" || task.status === "failed") continue;
      if (task.partnerId === partnerId) ids.add(task.sessionId);
      if (!creators.has(task.sessionId)) creators.set(task.sessionId, task.partnerId);
    }
    const sessions = [...ids].flatMap(id => {
      const session = store.findSession(id)?.descriptor;
      if (!session || id === home.id || session.deletedAt !== undefined || session.hidden || store.findCollaborationWorkerBySession(id)) return [];
      const link = profiles.getSessionLink(id);
      if (link && link.role !== "delegation" && link.role !== "routine") return [];
      if (link?.delegationId) creators.set(id, profiles.getDelegation(link.delegationId).requesterPartnerId);
      return [session];
    }).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    const rows = sessions.slice(0, 30).map(session => this.#row(session, tasks.creatorForSession(session.id) ?? creators.get(session.id)));
    const snapshotToken = hash(JSON.stringify([partnerId, String(partner.revision), rows]));
    if (token && token !== snapshotToken) throw new Error("The task observation page expired. Refresh the list.");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > rows.length || !token && offset !== 0) throw new Error("The task observation offset is invalid.");
    return { partnerId, partnerRevision: partner.revision, snapshotToken, rows: rows.slice(offset), observedAt: (this.options.now ?? Date.now)(),
      workingCount: rows.filter(row => row.phase === "running" || row.phase === "usage-limit").length,
      waitingCount: rows.filter(row => row.phase === "waiting-permission" || row.phase === "waiting-answer").length };
  }

  #row(session: SessionDescriptor, creatorPartnerId: string | undefined): PartnerObservedTask {
    const { store } = this.options;
    const run = store.listRuns({ sessionId: session.id, limit: 1 })[0]?.descriptor;
    const interaction = run && store.listInteractions({ sessionId: session.id, status: "open", limit: 100 })
      .find(item => item.generation === session.binding.generation && item.runId === run.id);
    let phase: GlancePhase = "idle";
    if (interaction) phase = interaction.kind === "permission" ? "waiting-permission" : "waiting-answer";
    else if (run?.state === "failed" || run?.state === "dispatch_unknown") phase = "errored";
    else if (run?.state === "retrying" && /usage|quota|rate.limit/iu.test([run.error?.code, run.error?.message].join(" "))) phase = "usage-limit";
    else if (run && ["running", "queued", "waiting", "retrying"].includes(run.state)) phase = "running";
    const question = interaction?.payload.kind === "question" ? interaction.payload.prompt
      : interaction?.payload.kind === "permission" ? interaction.payload.title : undefined;
    const remote = session.remoteWorkspace;
    let online = true;
    if (remote?.kind === "device_peer") {
      try { online = !!this.options.peers?.captureBinding(remote.controllerDeviceId, remote.targetDeviceId); }
      catch { online = false; }
    }
    return { sessionId: session.id, generation: session.binding.generation, targetId: session.targetId, title: session.title,
      ...(creatorPartnerId === undefined ? {} : { creatorPartnerId }), phase, phaseSince: interaction?.createdAt ?? run?.endedAt ?? run?.startedAt ?? session.updatedAt,
      startedAt: run?.startedAt, interactionId: interaction?.id, question: question && Array.from(question).slice(0, 140).join(""),
      readOnly: !!remote, online, ...(remote?.kind === "device_peer" ? { deviceId: remote.targetDeviceId, deviceName: store.getTarget(session.targetId).descriptor.displayName } : {}) };
  }
}

export function followUpId(partnerId: string): string { return `builtin-follow-up-${hash(partnerId).slice(0, 40)}`; }

/** A service-owned follow-up Session can message only a child it delegated. */
export function canSendFollowUpTaskMessage(
  profiles: Pick<PartnerStore, "getSessionLink" | "getPartner" | "getDelegation">,
  caller: SessionDescriptor,
  targetSessionId: string | undefined
): boolean {
  const link = profiles.getSessionLink(caller.id);
  if (link?.role !== "routine") return true;
  const key = `routine:${followUpId(link.partnerId)}`;
  if (link.routineKey !== key && !link.routineKey?.startsWith(`${key}:`)) return true;
  const owner = profiles.getPartner(link.partnerId);
  if (!targetSessionId || owner.lifecycle !== "active" || owner.initializationState !== "ready" || owner.pauseCleanupPending
    || owner.profileVersion !== link.profileVersion || owner.homeTargetId !== caller.targetId) return false;

  const child = profiles.getSessionLink(targetSessionId);
  if (child?.role !== "delegation" || !child.delegationId) return false;
  const delegation = profiles.getDelegation(child.delegationId);
  return delegation.requesterPartnerId === owner.id && delegation.childSessionId === targetSessionId
    && delegation.targetPartnerId === child.partnerId && delegation.targetProfileVersion === child.profileVersion
    && delegation.status !== "cancelled";
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
