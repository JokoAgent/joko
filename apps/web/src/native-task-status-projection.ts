import { NATIVE_TASK_STATUS_SESSION_LIMIT } from "@joko/contracts";
import type { AppSnapshot, ConnectionProfile, PartnerProfileView } from "./model.js";
import { projectNativeTaskStatusSnapshot } from "./native-task-status-bridge.js";
import type { NativeTaskStatusLiveSource } from "./native-task-status-sources.js";

export interface NativeTaskStatusRoute {
  readonly profileId: string; readonly serverId: string; readonly sessionId: string; readonly generation: bigint;
  readonly sourceGeneration: bigint;
  readonly epoch?: number; readonly partnerId?: string;
}
export function nativeTaskStatusRouteKey(route: NativeTaskStatusRoute): string {
  return JSON.stringify([route.profileId, route.serverId, route.sourceGeneration.toString(), route.generation.toString(), route.sessionId]);
}
export function composeNativeTaskStatusProjection(input: {
  readonly ownerId: string; readonly revision: bigint; readonly locale: JokoDesktopNativeTaskStatusSnapshot["locale"];
  readonly primary?: { readonly profile: ConnectionProfile; readonly snapshot: AppSnapshot };
  readonly remotes: readonly NativeTaskStatusLiveSource[]; readonly selectedProfileIds: ReadonlySet<string>;
}): { readonly snapshot: JokoDesktopNativeTaskStatusSnapshot; readonly routes: ReadonlyMap<string, NativeTaskStatusRoute> } {
  const routes = new Map<string, NativeTaskStatusRoute>();
  const local: JokoDesktopNativeTaskStatusSnapshot["sessions"][number][] = [], companions: typeof local = [], tasks: typeof local = [];
  const project = (profile: ConnectionProfile, snapshot: AppSnapshot, source?: NativeTaskStatusLiveSource): void => {
    const partners = new Map((source?.partners ?? []).filter(partner => ["active", "paused"].includes(partner.lifecycle) && partner.canonicalSessionId)
      .map(partner => [partner.canonicalSessionId!, partner]));
    const eligible = snapshot.sessions.filter(session => !session.hidden && !session.archived
      && (!source || partners.has(session.id) || input.selectedProfileIds.has(profile.id)));
    const base = projectNativeTaskStatusSnapshot({ ownerId: input.ownerId, revision: input.revision, locale: input.locale,
      sessions: eligible, interactions: snapshot.interactions, timelineBySession: snapshot.timelineBySession,
      inputHandoffs: snapshot.inputHandoffs });
    const byId = new Map(base.sessions.map(session => [session.sessionId, session]));
    const observedCompletions = new Set<string>();
    if (source) for (const session of eligible) if (!byId.has(session.id) && session.taskActivity?.silent && session.state === "idle") {
      observedCompletions.add(session.id);
      byId.set(session.id, { sessionId: session.id, title: session.name, detail: "", phase: "completed", activityLines: [], updatedAt: session.updatedAt });
    }
    if (source) for (const session of eligible) {
      const partner = partners.get(session.id);
      if (!partner || byId.has(session.id) || !partner.activity.unreadReplyCount) continue;
      byId.set(session.id, { sessionId: session.id, title: partner.displayName, detail: "", phase: "completed", activityLines: [], updatedAt: partner.activity.latestReplyAt ?? session.updatedAt });
    }
    for (const projected of byId.values()) {
      const session = eligible.find(value => value.id === projected.sessionId)!;
      const partner = partners.get(session.id);
      const route: NativeTaskStatusRoute = { profileId: profile.id, serverId: profile.serverId, sessionId: session.id,
        generation: session.generation, sourceGeneration: snapshot.generation, ...(source ? { epoch: source.epoch } : {}), ...(partner ? { partnerId: partner.id } : {}) };
      const sessionId = nativeTaskStatusRouteKey(route);
      if (sessionId.length > 1024) continue;
      routes.set(sessionId, route);
      if (!source) { local.push({ ...projected, sessionId }); continue; }
      const { permission: _permission, ...remote } = projected;
      const summary = session.taskActivity ? session.taskActivity.completedReplySummary
        : partner?.activity.unreadReplyCount ? partner.activity.latestReplyPreview ?? "" : "";
      const line = summary.replace(/\s+/gu, " ").trim().slice(0, 300);
      const value: typeof projected = { ...remote, sessionId,
        title: partner?.displayName.slice(0, 160) ?? projected.title,
        detail: projected.phase === "completed" ? line : projected.detail,
        activityLines: projected.phase === "completed" ? line ? [{ id: "completed-reply", kind: "status", text: line }] : [] : projected.activityLines,
        remote: { sourceId: JSON.stringify([profile.id, profile.serverId, source.epoch, snapshot.generation.toString()]),
          runId: session.taskActivity?.runId ?? session.activeRunId ?? "", completionNotification: session.taskActivity?.completionNotification ?? "none",
          silent: session.taskActivity?.silent === true,
          ...(observedCompletions.has(session.id) ? { observedCompletionOnly: true } : {}),
          ...(partner ? { companion: { ...nativeTaskCompanion(partner), ...(source.artworkByPartnerId?.[partner.id] ? { artwork: source.artworkByPartnerId[partner.id] } : {}) } } : {}) } };
      (partner ? companions : tasks).push(value);
    }
  };
  if (input.primary) project(input.primary.profile, input.primary.snapshot);
  for (const source of input.remotes) if (source.profile.id !== input.primary?.profile.id) project(source.profile, source.snapshot, source);
  const sessions = [...companions, ...local, ...tasks].slice(0, NATIVE_TASK_STATUS_SESSION_LIMIT);
  const kept = new Set(sessions.map(session => session.sessionId));
  for (const key of routes.keys()) if (!kept.has(key)) routes.delete(key);
  return { snapshot: { ownerId: input.ownerId, revision: input.revision.toString(), locale: input.locale, sessions }, routes };
}

function nativeTaskCompanion(partner: PartnerProfileView): NonNullable<NonNullable<JokoDesktopNativeTaskStatusSnapshot["sessions"][number]["remote"]>["companion"]> {
  const preset = typeof partner.avatar === "string" ? partner.avatar : "photo";
  return { name: partner.displayName.slice(0, 160), glyph: preset === "spark" ? "◆" : preset === "leaf" ? "❧" : preset === "wave" ? "≈" : Array.from(partner.displayName)[0] ?? "●",
    tint: preset === "leaf" ? "#197451" : preset === "wave" ? "#2f668f" : "#ff9800" };
}
