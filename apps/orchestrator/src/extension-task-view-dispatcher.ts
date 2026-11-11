import { randomUUID } from "node:crypto";
import type { OperationalStore } from "@joko/store";
import type { ExtensionCatalogDescriptor } from "./extension-catalog.js";

export function extensionTaskViewInstallation(extension: ExtensionCatalogDescriptor): string | undefined {
  if (!extension.installed || !extension.enabled || extension.owner.kind !== "resource" || !extension.taskView
    || !["ready", "not_required"].includes(extension.setup.state)) return undefined;
  return JSON.stringify([extension.owner.resourceId, extension.owner.resourceVersion.toString(),
    extension.owner.discoveredRevision, extension.taskView.extensionEntry]);
}

export function localExtensionTaskViewSession(store: OperationalStore, sessionId: string) {
  const session = store.findSession(sessionId)?.descriptor;
  if (!session || session.archived || session.hidden || session.deletedAt !== undefined || session.remoteWorkspace) return undefined;
  const target = store.getTarget(session.targetId).descriptor;
  if (target.remoteWorkspace || store.getBackend(session.backendId).descriptor.adapterKind === "hosted"
    || store.findSessionRuntimePolicy(sessionId)?.policy === "review_read_only") return undefined;
  return session;
}

export interface ExtensionTaskViewOpen {
  readonly requestId: string;
  readonly extensionId: string;
  readonly extensionRevision: bigint;
  readonly sessionId: string;
  readonly focus: boolean;
}

interface Viewer {
  readonly connectionId: string;
  readonly focusedSessionId?: string;
  readonly assertCurrent: () => void;
  readonly send: (event: ExtensionTaskViewOpen) => boolean;
}

export interface ExtensionTaskViewOrigin {
  readonly sourceSessionId?: string;
  /** Captured by the host from a real card action, never supplied by a plugin. */
  readonly gesture?: {
    readonly connectionId: string;
    readonly observedAt: number;
    readonly assertCurrent: () => void;
    readonly consume: () => boolean;
  };
}

export type ExtensionTaskViewResult = { readonly ok: true; readonly sessionId: string; readonly focusRequested?: true }
  | { readonly ok: false; readonly errorCode: "PERMISSION_DENIED" | "INVALID_REQUEST" | "HOST_NOT_READY"; readonly message: string };

interface Options {
  readonly authority: (extensionId: string) => { readonly installationKey: string; readonly revision: bigint } | undefined;
  readonly taskAvailable: (extensionId: string, sessionId: string) => boolean;
  readonly now?: () => number;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const taskId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._:-]{1,512}$/u.test(value);
const fail = (errorCode: "PERMISSION_DENIED" | "INVALID_REQUEST" | "HOST_NOT_READY", message: string): ExtensionTaskViewResult => ({ ok: false, errorCode, message });

/** Transient delivery to explicitly registered UI instances; owns no Task or page state. */
export class ExtensionTaskViewDispatcher {
  readonly #viewers = new Map<symbol, Viewer>();
  constructor(private readonly options: Options) {}

  register(viewer: Viewer): () => void {
    viewer.assertCurrent();
    if (!viewer.connectionId || viewer.focusedSessionId !== undefined && !taskId(viewer.focusedSessionId)) throw new Error("Invalid task-view viewer context.");
    if (this.#viewers.size >= 128) throw new Error("Task-view viewer capacity reached.");
    const key = Symbol(); this.#viewers.set(key, viewer);
    return () => { this.#viewers.delete(key); };
  }

  request(extensionId: string, installationKey: string, payload: unknown, origin: ExtensionTaskViewOrigin = {}): ExtensionTaskViewResult {
    const authority = this.options.authority(extensionId);
    if (!authority || !installationKey || authority.installationKey !== installationKey) return fail("PERMISSION_DENIED", "The plugin task view is unavailable.");
    if (payload !== undefined && !record(payload)) return fail("INVALID_REQUEST", "A task-view request must be an object.");
    const request: Record<string, unknown> = payload ?? {};
    if (Object.keys(request).some(key => !["sessionId", "peek", "focus"].includes(key))
      || request.sessionId !== undefined && !taskId(request.sessionId)
      || request.peek !== undefined && request.peek !== true
      || request.focus !== undefined && typeof request.focus !== "boolean") return fail("INVALID_REQUEST", "Invalid task-view request.");
    const viewers = [...this.#viewers].flatMap(([key, viewer]) => {
      try { viewer.assertCurrent(); return [viewer]; }
      catch { this.#viewers.delete(key); return []; }
    });
    const focused = new Set(viewers.filter(viewer => origin.gesture === undefined || viewer.connectionId === origin.gesture.connectionId)
      .flatMap(viewer => viewer.focusedSessionId === undefined ? [] : [viewer.focusedSessionId]));
    const sessionId = request.sessionId ?? (focused.size === 1 ? [...focused][0] : undefined);
    if (!taskId(sessionId)) return fail("HOST_NOT_READY", "No current task can host the plugin page. Specify a task.");
    if (!this.options.taskAvailable(extensionId, sessionId)) return fail("PERMISSION_DENIED", "The target task is unavailable for this plugin.");
    if (request.peek === true) return { ok: true, sessionId };
    let focusViewer: Viewer | undefined;
    if (request.focus === true) {
      const gesture = origin.gesture, now = (this.options.now ?? Date.now)();
      if (!gesture || !Number.isSafeInteger(gesture.observedAt) || gesture.observedAt > now || now - gesture.observedAt >= 3_000) {
        return fail("PERMISSION_DENIED", "Focusing a task requires the current user action.");
      }
      const candidates = viewers.filter(viewer => viewer.connectionId === gesture.connectionId
        && (origin.sourceSessionId === undefined || viewer.focusedSessionId === origin.sourceSessionId));
      if (candidates.length !== 1) return fail("HOST_NOT_READY", "The original task window is no longer available.");
      focusViewer = candidates[0];
      try {
        gesture.assertCurrent();
        if (!gesture.consume()) return fail("PERMISSION_DENIED", "The original user action was already consumed.");
      }
      catch { return fail("PERMISSION_DENIED", "The original user action is no longer current."); }
    }
    const event: ExtensionTaskViewOpen = { requestId: randomUUID(), extensionId, extensionRevision: authority.revision, sessionId, focus: false };
    let delivered = false;
    for (const viewer of viewers) {
      if (focusViewer !== undefined && viewer !== focusViewer) continue;
      try { viewer.assertCurrent(); delivered = viewer.send({ ...event, focus: viewer === focusViewer }) || delivered; }
      catch { /* A closing UI cannot prevent delivery to another current UI. */ }
    }
    if (!delivered) return fail("HOST_NOT_READY", "No current user interface can open the plugin task view.");
    return { ok: true, sessionId, ...(focusViewer !== undefined ? { focusRequested: true as const } : {}) };
  }
}
