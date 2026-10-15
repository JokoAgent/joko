import type { BackendView, QueueItemView } from "./model.js";
import type { AppController, AppRoute } from "./controller.js";

/** Public location of a task; it never carries a foreign credential. */
export type TaskSource = { readonly kind: "own" } | {
  readonly kind: "joined";
  readonly homeProfileId: string;
  readonly homeServerId: string;
  readonly homeOrigin: string;
  readonly joinId: string;
  readonly remoteServerId: string;
  readonly shareId: string;
  readonly memberId: string;
  readonly sessionId: string;
  readonly generation: bigint;
  readonly memberGeneration: bigint;
};

export interface SessionAccess {
  readonly role: "host" | "guest";
  readonly memberId?: string;
  readonly editableQueueItemIds: ReadonlySet<string>;
}

export interface PendingTaskSharingAction {
  readonly operationId: string;
  readonly kind: "create" | "invite" | "remove" | "end" | "endAll" | "leave" | "join";
}

export function taskSourceKey(source: TaskSource): string {
  return source.kind === "own" ? "own" : JSON.stringify([
    source.homeProfileId, source.homeServerId, source.homeOrigin, source.joinId, source.remoteServerId, source.shareId,
    source.memberId, source.sessionId, source.generation.toString(), source.memberGeneration.toString()
  ]);
}

const returnRoutes = new Map<string, AppRoute>();
const returnKey = (profileId: string, joinId: string): string => JSON.stringify([profileId, joinId]);
export function openJoinedTask(controller: AppController, joinId: string): void {
  const profile = controller.state.activeProfile;
  if (!profile) return;
  if (controller.state.route.kind !== "sharedTask") returnRoutes.set(returnKey(profile.id, joinId), controller.state.route);
  controller.navigate({ kind: "sharedTask", profileId: profile.id, joinId });
}
export function returnFromJoinedTask(controller: AppController, profileId: string, joinId: string): void {
  const key = returnKey(profileId, joinId), route = returnRoutes.get(key); returnRoutes.delete(key);
  if (route) controller.navigate(route);
  else controller.navigate({ kind: "settings" }, { exactHash: "#/settings/sharing" });
}

const guestCapabilities = new Set([
  "input.text", "input.image", "input.file", "turn.steer", "turn.follow_up", "turn.resume",
  "turn.abort", "context.auto_retry", "model.switch", "model.effort", "model.fast_mode", "model.thinking",
  "context.usage", "subagents.list", "subagents.detail", "subagents.transcript", "background.tasks",
  "interaction.permission", "interaction.question", "interaction.plan_review"
]);

/** Backend support and task access are separate authorities. */
export function guestBackend(backend: BackendView): BackendView {
  return { ...backend, capabilities: new Map([...backend.capabilities].map(([name, capability]) => [name, {
    ...capability, supported: capability.supported && guestCapabilities.has(name)
  }])) };
}

export function canEditSharedQueueItem(access: SessionAccess | undefined, item: QueueItemView): boolean {
  return access?.role !== "guest" || access.editableQueueItemIds.has(item.id);
}

export function canOpenJoinedTask(status: string): boolean {
  return status === "active" || status === "disconnected";
}
