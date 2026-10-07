import type { AppController } from "./controller.js";
import type { AppSnapshot, NewSessionLocalDraft, PendingExtensionSuggestionView } from "./model.js";

/** A continuation belongs to the original selection and runtime incarnation,
 * not whichever project or connection is selected when it returns. */
export function newSessionSuggestionContext(
  controller: AppController,
  snapshot: AppSnapshot,
  selection: NewSessionLocalDraft["selection"],
  runtimeSessionId?: string
): string | undefined {
  const profile = controller.state.activeProfile;
  if (profile === undefined || controller.state.connectionState !== "connected" || selection.kind === "unselected") return undefined;
  const target = selection.kind === "target" ? snapshot.targets.find((item) => item.id === selection.targetId && !item.archived) : undefined;
  if (selection.kind === "target" && target === undefined) return undefined;
  const backendId = selection.kind === "dialogue" ? selection.backendId : target?.backendId;
  const backend = snapshot.backends.find((item) => item.id === backendId && item.health !== "unavailable");
  if (backend === undefined || backend.capabilities.get("input.text")?.supported !== true) return undefined;
  const runtime = runtimeSessionId === undefined ? undefined : snapshot.sessions.find((item) => item.id === runtimeSessionId
    && item.backendId === backend.id && !item.archived && item.state !== "closed" && item.runtimeAttached === true
    && (target === undefined ? item.projectId === undefined : item.targetId === target.id));
  if (runtimeSessionId !== undefined && runtime === undefined) return undefined;
  return JSON.stringify([1, profile.serverId, profile.id, controller.state.connectionGeneration ?? 0, snapshot.generation.toString(10),
    selection.kind, target?.id ?? backend.id, target?.revision.toString(10) ?? "",
    backend.id, backend.instanceGeneration ?? 0, backend.version,
    runtime?.id ?? "", runtime?.generation.toString(10) ?? ""]);
}

export function pendingExtensionSuggestionContext(
  controller: AppController,
  snapshot: AppSnapshot,
  pending: PendingExtensionSuggestionView
): string | undefined {
  return newSessionSuggestionContext(controller, snapshot, pending.draft.selection, pending.runtimeSessionId);
}
