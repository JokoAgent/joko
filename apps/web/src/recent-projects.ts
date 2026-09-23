import type { AppSnapshot, TargetView } from "./model.js";

/** Device-local history, never a source of workspace authority. */
export interface RecentProject {
  readonly targetId: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly serverPath: string;
  readonly remoteHostTargetId?: string;
  readonly remoteHostId?: string;
  readonly remoteWorkspaceRoot?: string;
  readonly lastUsedAt: number;
}

export const MAX_RECENT_PROJECTS = 10;
const RECENT_PROJECTS_CHANNEL = "joko-recent-projects-v1";

/** Cross-window hints carry only the owner key; every reader still loads its own durable record. */
export function publishRecentProjectsChange(owner: string): void {
  try {
    const channel = new BroadcastChannel(RECENT_PROJECTS_CHANNEL);
    channel.postMessage({ owner });
    channel.close();
  } catch { /* Browser storage can be unavailable without blocking task creation. */ }
}

export function subscribeRecentProjectsChange(owner: string, onChange: () => void): () => void {
  try {
    const channel = new BroadcastChannel(RECENT_PROJECTS_CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const value = event.data;
      if (value !== null && typeof value === "object" && !Array.isArray(value)
        && (value as Record<string, unknown>)["owner"] === owner) onChange();
    };
    return () => channel.close();
  } catch { return () => undefined; }
}

export function recentProjectForTarget(snapshot: AppSnapshot, targetId: string, at = Date.now()): RecentProject | undefined {
  const target = snapshot.targets.find((candidate) => candidate.id === targetId && !candidate.archived);
  const workspace = snapshot.workspaces.find((candidate) => candidate.id === target?.workspaceId && candidate.targetId === targetId);
  if (target === undefined || workspace?.kind !== "userProject") return undefined;
  const entry: RecentProject = {
    targetId, workspaceId: workspace.id, name: target.name, serverPath: workspace.serverPath,
    ...(target.remoteWorkspace === undefined ? {} : {
      remoteHostTargetId: target.remoteWorkspace.hostTargetId,
      remoteHostId: target.remoteWorkspace.hostId,
      remoteWorkspaceRoot: target.remoteWorkspace.workspaceRoot
    }),
    lastUsedAt: at
  };
  return validRecentProject(entry) ? entry : undefined;
}

export function resolveRecentProject(entry: RecentProject, snapshot: AppSnapshot): TargetView | undefined {
  const target = snapshot.targets.find((candidate) => candidate.id === entry.targetId && !candidate.archived
    && candidate.workspaceId === entry.workspaceId);
  const workspace = snapshot.workspaces.find((candidate) => candidate.id === entry.workspaceId
    && candidate.targetId === entry.targetId && candidate.kind === "userProject");
  if (target === undefined || workspace === undefined || normalizePath(workspace.serverPath) !== normalizePath(entry.serverPath)) return undefined;
  if (target.remoteWorkspace?.hostTargetId !== entry.remoteHostTargetId
    || target.remoteWorkspace?.hostId !== entry.remoteHostId
    || target.remoteWorkspace?.workspaceRoot !== entry.remoteWorkspaceRoot) return undefined;
  return target;
}

export function recentProjectKey(entry: RecentProject): string {
  return `${entry.remoteHostTargetId ?? ""}\u0000${entry.remoteHostId ?? ""}\u0000${normalizePath(entry.remoteWorkspaceRoot ?? entry.serverPath)}`;
}

export function withRecentProject(current: readonly RecentProject[], entry: RecentProject): readonly RecentProject[] {
  if (!validRecentProject(entry)) throw new Error("The recent project identity is invalid.");
  const existing = normalizeRecentProjects(current);
  const newest = Math.max(Date.now(), entry.lastUsedAt, (existing[0]?.lastUsedAt ?? 0) + 1);
  const next = { ...entry, lastUsedAt: newest };
  return [next, ...existing.filter((candidate) => recentProjectKey(candidate) !== recentProjectKey(next))].slice(0, MAX_RECENT_PROJECTS);
}

export function withoutRecentProject(current: readonly RecentProject[], entry: RecentProject): readonly RecentProject[] {
  const key = recentProjectKey(entry);
  return normalizeRecentProjects(current).filter((candidate) => recentProjectKey(candidate) !== key
    || candidate.targetId !== entry.targetId || candidate.workspaceId !== entry.workspaceId);
}

export function normalizeRecentProjects(value: unknown): readonly RecentProject[] {
  if (!Array.isArray(value)) return [];
  const entries = value.filter(validRecentProject).map((entry) => ({
    targetId: entry.targetId, workspaceId: entry.workspaceId, name: entry.name,
    serverPath: entry.serverPath,
    ...(entry.remoteHostId === undefined ? {} : { remoteHostTargetId: entry.remoteHostTargetId,
      remoteHostId: entry.remoteHostId, remoteWorkspaceRoot: entry.remoteWorkspaceRoot }),
    lastUsedAt: entry.lastUsedAt
  })).sort((left, right) => right.lastUsedAt - left.lastUsedAt);
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = recentProjectKey(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_RECENT_PROJECTS);
}

function validRecentProject(value: unknown): value is RecentProject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (!validText(entry["targetId"], 256) || !validText(entry["workspaceId"], 256)
    || !validText(entry["name"], 120) || !validText(entry["serverPath"], 4096)
    || typeof entry["lastUsedAt"] !== "number" || !Number.isSafeInteger(entry["lastUsedAt"])
    || entry["lastUsedAt"] < 0) return false;
  const remoteHostTarget = entry["remoteHostTargetId"];
  const remoteHost = entry["remoteHostId"];
  const remoteRoot = entry["remoteWorkspaceRoot"];
  return remoteHostTarget === undefined && remoteHost === undefined && remoteRoot === undefined
    || validText(remoteHostTarget, 256) && validText(remoteHost, 256) && validText(remoteRoot, 4096);
}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function normalizePath(path: string): string {
  let normalized = path.trim().replace(/\\/gu, "/");
  while (normalized.length > 1 && normalized.endsWith("/") && !/^[A-Za-z]:\/$/u.test(normalized)) normalized = normalized.slice(0, -1);
  return normalized;
}
