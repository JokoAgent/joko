import type { AppSnapshot, ConnectionProfile, MachineCacheView, MachinePresenceView, MachineSessionCacheView } from "./model.js";

export type MachineSelection = "all" | readonly string[];

const MAX_SELECTED_MACHINES = 64;
const MAX_CACHED_SESSIONS = 500;
const MAX_ID_LENGTH = 256;
const MAX_NAME_LENGTH = 512;
const SESSION_STATES = new Set<MachineSessionCacheView["state"]>(["idle", "running", "waiting", "retrying", "error", "closed"]);

export function normalizeMachineSelection(value: unknown): MachineSelection {
  if (value === "all") return "all";
  if (!Array.isArray(value)) return "all";
  const selected: string[] = [];
  for (const candidate of value) {
    if (!safeIdentifier(candidate) || selected.includes(candidate)) continue;
    selected.push(candidate);
    if (selected.length >= MAX_SELECTED_MACHINES) break;
  }
  return selected.length === 0 ? "all" : selected;
}

export function selectedMachineProfileIds(
  selection: MachineSelection,
  profiles: readonly ConnectionProfile[]
): readonly string[] {
  if (selection === "all") return profiles.map((profile) => profile.id);
  const available = new Set(profiles.map((profile) => profile.id));
  return selection.filter((id) => available.has(id));
}

export function toggleMachineProfile(
  selection: MachineSelection,
  profileId: string,
  profiles: readonly ConnectionProfile[]
): MachineSelection {
  const allIds = profiles.map((profile) => profile.id);
  if (!allIds.includes(profileId)) return selection;
  if (selection === "all") return [profileId];
  const selected = new Set(selection);
  if (selected.has(profileId)) selected.delete(profileId);
  else selected.add(profileId);
  if (selected.size === 0) return "all";
  if (selected.size === allIds.length && allIds.every((id) => selected.has(id))) return "all";
  return allIds.filter((id) => selected.has(id));
}

export function machineCacheFromSnapshot(profile: ConnectionProfile, snapshot: AppSnapshot, now = Date.now()): MachineCacheView {
  const targets = new Map(snapshot.targets.map((target) => [target.id, target.name] as const));
  const interactions = new Map(snapshot.interactions.map((interaction) => [interaction.sessionId, interaction.kind] as const));
  return {
    profileId: profile.id,
    serverId: profile.serverId,
    name: boundedText(profile.name, MAX_NAME_LENGTH) || boundedText(snapshot.server.name, MAX_NAME_LENGTH) || profile.id,
    origin: profile.origin,
    updatedAt: now,
    sessions: [...snapshot.sessions]
      .filter((session) => safeIdentifier(session.id))
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
      .slice(0, MAX_CACHED_SESSIONS)
      .map((session) => ({
        id: session.id,
        name: boundedText(session.name, MAX_NAME_LENGTH) || session.id,
        state: session.state,
        ...(targets.get(session.targetId) === undefined ? {} : { targetName: boundedText(targets.get(session.targetId)!, MAX_NAME_LENGTH) }),
        pinned: session.pinned,
        archived: session.archived,
        lastActivityAt: session.updatedAt,
        ...(session.attention === undefined ? {} : {
          attentionKind: session.attention.kind,
          attentionUnread: session.attention.unread
        }),
        ...(interactions.get(session.id) === undefined ? {} : { interactionKind: interactions.get(session.id) })
      }))
  };
}

export function normalizeMachineCache(value: unknown): MachineCacheView | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "name,origin,profileId,serverId,sessions,updatedAt" ||
    !safeIdentifier(record["profileId"]) || !safeIdentifier(record["serverId"]) ||
    typeof record["origin"] !== "string" || record["origin"].length > 2_048 || !Array.isArray(record["sessions"])) return undefined;
  if (typeof record["updatedAt"] !== "number" || !Number.isSafeInteger(record["updatedAt"]) || record["updatedAt"] < 0) return undefined;
  const name = boundedText(record["name"], MAX_NAME_LENGTH);
  if (name === "" || name !== record["name"]) return undefined;
  const rawSessions = record["sessions"];
  if (rawSessions.length > MAX_CACHED_SESSIONS) return undefined;
  const sessions: MachineSessionCacheView[] = [];
  for (const raw of rawSessions) {
    const session = normalizeCachedSession(raw);
    if (session === undefined || sessions.some((candidate) => candidate.id === session.id)) return undefined;
    sessions.push(session);
  }
  return {
    profileId: record["profileId"],
    serverId: record["serverId"],
    name,
    origin: record["origin"],
    updatedAt: record["updatedAt"],
    sessions
  };
}

export function selectedRemoteMachineCaches(
  caches: readonly MachineCacheView[],
  activeProfileId: string,
  selection: MachineSelection,
  profiles: readonly ConnectionProfile[]
): readonly MachineCacheView[] {
  const selected = new Set(selectedMachineProfileIds(selection, profiles));
  return caches
    .filter((cache) => cache.profileId !== activeProfileId && selected.has(cache.profileId))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) || left.profileId.localeCompare(right.profileId));
}

/**
 * Selects only authenticated live gateways for remote content operations.
 * Offline caches remain a navigation aid, but never grant authority to search
 * message content. Identity-mismatched and revoked profiles therefore fail
 * closed even if untrusted caller input claims a connected transport.
 */
export function selectedReachableRemoteProfileIds(
  selection: MachineSelection,
  profiles: readonly ConnectionProfile[],
  activeProfileId: string | undefined,
  presenceByProfile: Readonly<Record<string, MachinePresenceView>>,
  connectedProfileIds: ReadonlySet<string>
): readonly string[] {
  return selectedMachineProfileIds(selection, profiles).filter((profileId) =>
    profileId !== activeProfileId
    && presenceByProfile[profileId] === "online"
    && connectedProfileIds.has(profileId)
  );
}

function normalizeCachedSession(value: unknown): MachineSessionCacheView | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const required = ["archived", "id", "lastActivityAt", "name", "pinned", "state"];
  const allowed = new Set([...required, "attentionKind", "attentionUnread", "interactionKind", "targetName"]);
  if (required.some((key) => !Object.hasOwn(record, key)) || Object.keys(record).some((key) => !allowed.has(key)) ||
    !safeIdentifier(record["id"]) || !SESSION_STATES.has(record["state"] as MachineSessionCacheView["state"]) ||
    boundedText(record["name"], MAX_NAME_LENGTH) === "" || boundedText(record["name"], MAX_NAME_LENGTH) !== record["name"] || typeof record["pinned"] !== "boolean" ||
    typeof record["archived"] !== "boolean") return undefined;
  const lastActivityAt = record["lastActivityAt"];
  if (typeof lastActivityAt !== "number" || !Number.isSafeInteger(lastActivityAt) || lastActivityAt < 0) return undefined;
  const attentionKind = record["attentionKind"];
  const interactionKind = record["interactionKind"];
  const hasTargetName = Object.hasOwn(record, "targetName");
  const targetName = boundedText(record["targetName"], MAX_NAME_LENGTH);
  const hasAttentionKind = Object.hasOwn(record, "attentionKind");
  const hasAttentionUnread = Object.hasOwn(record, "attentionUnread");
  const hasInteractionKind = Object.hasOwn(record, "interactionKind");
  if (
    (hasTargetName && (targetName === "" || targetName !== record["targetName"]))
    || hasAttentionKind !== hasAttentionUnread
    || (hasAttentionKind && attentionKind !== "done" && attentionKind !== "awaiting" && attentionKind !== "error")
    || (hasAttentionUnread && typeof record["attentionUnread"] !== "boolean")
    || (hasInteractionKind && interactionKind !== "permission" && interactionKind !== "question" && interactionKind !== "plan" && interactionKind !== "select" && interactionKind !== "confirm" && interactionKind !== "input" && interactionKind !== "editor")
  ) return undefined;
  return {
    id: record["id"],
    name: boundedText(record["name"], MAX_NAME_LENGTH),
    state: record["state"] as MachineSessionCacheView["state"],
    ...(hasTargetName ? { targetName } : {}),
    pinned: record["pinned"],
    archived: record["archived"],
    lastActivityAt,
    ...(hasAttentionKind
      ? { attentionKind: attentionKind as NonNullable<MachineSessionCacheView["attentionKind"]>, attentionUnread: record["attentionUnread"] as boolean }
      : {}),
    ...(hasInteractionKind
      ? { interactionKind: interactionKind as NonNullable<MachineSessionCacheView["interactionKind"]> }
      : {})
  };
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH && !/[\u0000-\u001f\u007f]/u.test(value);
}

function boundedText(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}
