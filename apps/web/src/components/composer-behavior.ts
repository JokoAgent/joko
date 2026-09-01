import type { ComposerSendShortcutPreference } from "../local-state.js";
import type { AppController } from "../controller.js";
import type { BackendView, QueueItemView } from "../model.js";

export type ComposerEnterIntent = "queue" | "steer" | "native" | "ignore" | null;
export type ComposerSubmissionKind = "send" | "bash" | "reset" | "review";
export type ComposerEscapeIntent = "collapseQueue" | "stopRun" | "stopShell" | "exitShell" | null;
export type ComposerPaletteKeyIntent =
  | { readonly kind: "move"; readonly index: number }
  | { readonly kind: "select"; readonly index: number }
  | { readonly kind: "close" }
  | null;
export type ComposerHistoryKeyIntent = { readonly index: number } | null;
export type TypedComposerPalette = "commands" | "mention" | null;
export interface UserShellDraft {
  readonly command: string;
  readonly excludeFromContext: boolean;
  readonly prefix: "none" | "include" | "exclude";
}

export interface ComposerAttachmentPolicy {
  readonly images: boolean;
  readonly files: boolean;
  readonly maximumItems?: number;
  readonly maximumBytes?: number;
}

export interface ComposerQueueWindow<T> {
  readonly items: readonly T[];
  readonly collapsible: boolean;
  readonly hiddenCount: number;
}

export type QueueReorderShortcutIntent =
  | { readonly placement: "first" | "last" }
  | { readonly placement: "before" | "after"; readonly anchorIndex: number };

export function resolveQueueReorderShortcut(key: string, index: number, count: number): QueueReorderShortcutIntent | null {
  if (!Number.isInteger(index) || !Number.isInteger(count) || count <= 1 || index < 0 || index >= count) return null;
  if (key === "ArrowUp" && index > 0) return { placement: "before", anchorIndex: index - 1 };
  if (key === "ArrowDown" && index < count - 1) return { placement: "after", anchorIndex: index + 1 };
  if (key === "Home" && index > 0) return { placement: "first" };
  if (key === "End" && index < count - 1) return { placement: "last" };
  return null;
}

export function composerQueueWindow<T>(items: readonly T[], expanded: boolean, collapseAt = 5, collapsedCount = 3): ComposerQueueWindow<T> {
  const collapsible = items.length >= collapseAt;
  const visibleCount = collapsible && !expanded ? Math.min(collapsedCount, items.length) : items.length;
  return {
    items: items.slice(0, visibleCount),
    collapsible,
    hiddenCount: Math.max(0, items.length - visibleCount)
  };
}

export interface ComposerEnterEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly repeat: boolean;
  readonly isComposing: boolean;
}

export interface ComposerEscapeEvent {
  readonly key: string;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly paletteTarget: boolean;
}

/** Composer priority: disclosure first, then active work, then Shell mode. */
export function resolveComposerEscapeIntent(
  event: ComposerEscapeEvent,
  context: {
    readonly queueExpanded: boolean;
    readonly canStopRun: boolean;
    readonly shellRunning: boolean;
    readonly shellMode: boolean;
  }
): ComposerEscapeIntent {
  if (event.key !== "Escape" || event.repeat || event.isComposing || event.paletteTarget) return null;
  if (context.queueExpanded) return "collapseQueue";
  if (context.canStopRun) return "stopRun";
  if (context.shellRunning) return "stopShell";
  if (context.shellMode) return "exitShell";
  return null;
}

export interface ComposerOwnershipToken {
  readonly sessionId: string;
  readonly generation: number;
  readonly draftRevision: number;
}

export function resolveComposerEnterIntent(
  event: ComposerEnterEvent,
  preference: ComposerSendShortcutPreference,
  options: { readonly turnRunning: boolean; readonly platform?: string }
): ComposerEnterIntent {
  if (event.key !== "Enter" || event.shiftKey || event.altKey) return null;
  if (event.isComposing) return "native";

  const hasModifier = event.ctrlKey || (isMacPlatform(options.platform) && event.metaKey);
  if (event.repeat) {
    const isSendShortcut = preference === "enter" || hasModifier;
    return isSendShortcut ? "ignore" : "native";
  }
  if (preference === "modifier-enter") return hasModifier ? "queue" : "native";
  if (!hasModifier) return "queue";
  return options.turnRunning ? "steer" : "queue";
}

export function getComposerSendShortcutLabel(preference: ComposerSendShortcutPreference, platform?: string): string {
  if (preference === "enter") return "Enter";
  return isMacPlatform(platform) ? "⌘+Enter" : "Ctrl+Enter";
}

export function currentComposerPlatform(): string | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.platform;
}

export function resolveComposerPaletteKey(key: string, activeIndex: number, itemCount: number): ComposerPaletteKeyIntent {
  if (key === "Escape") return { kind: "close" };
  if (itemCount <= 0) return null;
  const current = Math.min(Math.max(activeIndex, 0), itemCount - 1);
  if (key === "Home") return { kind: "move", index: 0 };
  if (key === "End") return { kind: "move", index: itemCount - 1 };
  if (key === "ArrowDown") return { kind: "move", index: (current + 1) % itemCount };
  if (key === "ArrowUp") return { kind: "move", index: (current - 1 + itemCount) % itemCount };
  if (key === "Enter" || key === "Tab") return { kind: "select", index: current };
  return null;
}

export function resolveTypedComposerPalette(text: string, isComposing: boolean, bashMode: boolean): TypedComposerPalette {
  if (isComposing || bashMode) return null;
  if (text === "/") return "commands";
  if (text === "@") return "mention";
  return null;
}

/** Supports Pi's `!` / `!!` shell prefixes alongside the graphical Shell toggle. */
export function resolveUserShellDraft(
  text: string,
  shellMode: boolean,
  explicitExcludeFromContext: boolean
): UserShellDraft | null {
  const value = text;
  if (value.startsWith("!!")) {
    return { command: value.slice(2).trim(), excludeFromContext: true, prefix: "exclude" };
  }
  if (value.startsWith("!")) {
    return {
      command: value.slice(1).trim(),
      excludeFromContext: explicitExcludeFromContext,
      prefix: "include"
    };
  }
  if (!shellMode) return null;
  return { command: text.trim(), excludeFromContext: explicitExcludeFromContext, prefix: "none" };
}

export function resolveComposerAttachmentPolicy(
  backend: BackendView | undefined,
  modelSupportsImages: boolean | undefined
): ComposerAttachmentPolicy {
  const image = backend?.capabilities.get("input.image");
  const file = backend?.capabilities.get("input.file");
  const images = image?.supported === true && modelSupportsImages === true;
  const files = file?.supported === true;
  const limits = [images ? image : undefined, files ? file : undefined];
  const itemLimits = limits.flatMap((capability) => capability?.maximumItems === undefined ? [] : [capability.maximumItems]);
  const byteLimits = limits.flatMap((capability) => capability?.maximumBytes === undefined ? [] : [capability.maximumBytes]);
  return {
    images,
    files,
    ...(itemLimits.length > 0 ? { maximumItems: Math.min(...itemLimits) } : {}),
    ...(byteLimits.length > 0 ? { maximumBytes: Math.min(...byteLimits) } : {})
  };
}

export function hasPendingComposerQueueItems(items: readonly QueueItemView[], sessionId: string): boolean {
  return items.some((item) => item.sessionId === sessionId && (
    item.state === "accepted"
    || item.state === "queued"
    || item.state === "dispatching"
    || item.state === "dispatchUnknown"
  ));
}

export function resolveComposerHistoryKey(
  key: string,
  text: string,
  activeIndex: number,
  historyLength: number,
  activeEntryUnmodified: boolean
): ComposerHistoryKeyIntent {
  if (historyLength <= 0 || (key !== "ArrowUp" && key !== "ArrowDown")) return null;
  if (activeIndex >= 0 && !activeEntryUnmodified) return null;
  if (key === "ArrowUp") {
    if (activeIndex === -1 && text.trim() !== "") return null;
    const next = Math.min(activeIndex + 1, historyLength - 1);
    return next === activeIndex ? null : { index: next };
  }
  if (activeIndex < 0) return null;
  return { index: activeIndex - 1 };
}

export async function pauseQueueThenAbort(
  controller: Pick<AppController, "abort" | "pauseQueue">,
  sessionId: string,
  runId: string,
  hasPendingQueueItems: boolean,
  queueAlreadyPaused: boolean
): Promise<void> {
  if (hasPendingQueueItems && !queueAlreadyPaused) await controller.pauseQueue(sessionId);
  await controller.abort(runId);
}

export async function pauseQueueThenAbortRetry(
  controller: Pick<AppController, "abortRetry" | "pauseQueue">,
  sessionId: string,
  runId: string,
  hasPendingQueueItems: boolean,
  queueAlreadyPaused: boolean
): Promise<void> {
  if (hasPendingQueueItems && !queueAlreadyPaused) await controller.pauseQueue(sessionId);
  await controller.abortRetry(runId);
}

export class ComposerOperationGuard {
  readonly #draftRevisions = new Map<string, number>();
  readonly #submissions = new Map<string, ComposerSubmissionKind>();
  #activeSessionId: string | undefined;
  #generation = 0;

  activate(sessionId: string): void {
    if (this.#activeSessionId === sessionId) return;
    this.#activeSessionId = sessionId;
    this.#generation += 1;
  }

  capture(sessionId: string): ComposerOwnershipToken {
    if (this.#activeSessionId !== sessionId) throw new Error("Composer ownership must be captured for the active session.");
    return { sessionId, generation: this.#generation, draftRevision: this.draftRevision(sessionId) };
  }

  markDraftEdited(sessionId: string): void {
    this.#draftRevisions.set(sessionId, this.draftRevision(sessionId) + 1);
  }

  ownsActivation(token: ComposerOwnershipToken): boolean {
    return this.#activeSessionId === token.sessionId && this.#generation === token.generation;
  }

  draftUnchanged(token: ComposerOwnershipToken): boolean {
    return this.draftRevision(token.sessionId) === token.draftRevision;
  }

  /**
   * Atomically consume the draft revision captured by one accepted operation.
   * Advancing the revision also fences draft reads and autosaves that began
   * before acceptance, including an A -> B -> A route round trip.
   */
  consumeUnchangedDraft(token: ComposerOwnershipToken): boolean {
    if (!this.draftUnchanged(token)) return false;
    this.#draftRevisions.set(token.sessionId, token.draftRevision + 1);
    return true;
  }

  beginSubmission(sessionId: string, kind: ComposerSubmissionKind): boolean {
    if (this.#submissions.has(sessionId)) return false;
    this.#submissions.set(sessionId, kind);
    return true;
  }

  finishSubmission(sessionId: string, kind: ComposerSubmissionKind): void {
    if (this.#submissions.get(sessionId) === kind) this.#submissions.delete(sessionId);
  }

  activeSubmission(sessionId: string): ComposerSubmissionKind | undefined {
    return this.#submissions.get(sessionId);
  }

  get activeSessionId(): string | undefined {
    return this.#activeSessionId;
  }

  private draftRevision(sessionId: string): number {
    return this.#draftRevisions.get(sessionId) ?? 0;
  }
}

function isMacPlatform(platform: string | undefined): boolean {
  return /darwin|mac|iphone|ipad/i.test(platform ?? "");
}
