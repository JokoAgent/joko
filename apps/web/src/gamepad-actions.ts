import { useLayoutEffect, useRef, type RefObject } from "react";
import type { GamepadAction } from "./gamepad-input.js";

export const GAMEPAD_INSPECTOR_ACTIONS = ["open-terminal", "open-browser-tab", "toggle-review-tab"] as const satisfies readonly GamepadAction[];
export type GamepadInspectorAction = (typeof GAMEPAD_INSPECTOR_ACTIONS)[number];
export interface GamepadInspectorRequest {
  readonly requestId: number;
  readonly action: GamepadInspectorAction;
  readonly sessionId: string;
  readonly sessionGeneration: bigint;
  readonly connectionGeneration: bigint;
  readonly profileId: string;
  readonly navigationRevision: number;
}
export function isGamepadInspectorAction(action: GamepadAction): action is GamepadInspectorAction {
  return (GAMEPAD_INSPECTOR_ACTIONS as readonly string[]).includes(action);
}

export function gamepadInspectorRequestOwned(doc: Document, request: GamepadInspectorRequest): boolean {
  return doc.visibilityState === "visible" && doc.hasFocus()
    && !doc.body.classList.contains("modal-open") && doc.body.dataset.appShortcutRecording !== "1"
    && doc.querySelector("[data-gamepad-preview]") === null
    && currentGamepadTaskRoot(doc)?.dataset.gamepadSessionId === request.sessionId;
}

export const GAMEPAD_OWNED_ACTIONS = [
  "approve", "reject", "submit", "stop", "toggle-plan", "toggle-fast", "effort-increase", "effort-decrease",
  "toggle-pin", "archive-task", "fork-task", "copy-task-link", "copy-conversation-markdown", "add-attachments", "open-commands", "scroll-bottom"
] as const satisfies readonly GamepadAction[];
export type GamepadOwnedAction = (typeof GAMEPAD_OWNED_ACTIONS)[number];
type ActionOwner = "composer" | "session" | "interaction";
export type GamepadActionHandlers = Partial<Record<GamepadOwnedAction, () => void>>;
const owners = new WeakMap<HTMLElement, { readonly kind: ActionOwner; readonly run: (action: GamepadOwnedAction) => boolean }>();

function available(node: Element | null | undefined, doc: Document): node is HTMLElement {
  return node !== null && node !== undefined && node.isConnected && node.ownerDocument === doc
    && node.closest("[hidden], [inert], [aria-hidden='true']") === null;
}

/** A focused split pane is authoritative; unrelated popovers never select the first task. */
export function currentGamepadTaskRoot(doc: Document): HTMLElement | null {
  const focused = doc.activeElement;
  if (focused !== null && (!available(focused, doc) || focused.matches("iframe, webview, embed, object"))) return null;
  if (focused?.closest("[aria-modal='true'], [role='dialog'], [role='listbox'], [role='menu'], [role='combobox'][aria-expanded='true'], [data-morph-side]") !== null && focused !== null) return null;
  const exact = focused?.closest(".session-pane, .new-task-page");
  if (available(exact, doc)) return exact;
  const split = doc.querySelector(".session-split-pane.is-focused");
  if (split !== null) {
    const pane = split.querySelector(".session-pane");
    return available(pane, doc) ? pane : null;
  }
  const panes = [...doc.querySelectorAll<HTMLElement>(".session-pane, .new-task-page")].filter((node) => available(node, doc));
  return panes.length === 1 ? panes[0]! : null;
}

export function isGamepadOwnedAction(action: GamepadAction): action is GamepadOwnedAction {
  return (GAMEPAD_OWNED_ACTIONS as readonly string[]).includes(action);
}

/** Dispatches to one registered, visible owner without clicking or searching application controls. */
export function dispatchGamepadOwnedAction(doc: Document, action: GamepadOwnedAction): boolean {
  const focused = doc.activeElement;
  if (focused !== null && !available(focused, doc)) return false;
  let target: HTMLElement | null = null;
  if (action === "approve" || action === "reject") {
    const exact = focused?.closest<HTMLElement>("[data-gamepad-actions='interaction']");
    if (available(exact, doc)) target = exact;
    else {
      // Portalled interaction dialogs must own focus before accepting a decision.
      const dialog = focused?.closest("[aria-modal='true'], [role='dialog']");
      if (dialog !== null && dialog !== undefined) target = dialog.querySelector("[data-gamepad-actions='interaction']");
      else if (!doc.body.classList.contains("modal-open")) target = currentGamepadTaskRoot(doc)?.querySelector("[data-gamepad-actions='interaction']") ?? null;
    }
  } else {
    if (doc.body.classList.contains("modal-open")) return false;
    const root = currentGamepadTaskRoot(doc);
    const kind = action === "submit" || action === "add-attachments" || action === "open-commands" ? "composer" : "session";
    if (root?.dataset.gamepadActions === kind) target = root;
    else target = root?.querySelector(`[data-gamepad-actions='${kind}']`) ?? null;
  }
  if (!available(target, doc)) return false;
  return owners.get(target)?.run(action) ?? false;
}

/** Component scope and DOM lifetime jointly own each action; rerenders replace handlers without replay. */
export function useGamepadActions(
  root: HTMLElement | undefined | RefObject<HTMLElement | null>,
  scope: unknown,
  kind: ActionOwner,
  handlers: GamepadActionHandlers
): void {
  const latest = useRef({ scope, handlers }); latest.current = { scope, handlers };
  const pageActive = useRef(true);
  useLayoutEffect(() => {
    const node = root !== undefined && "current" in root ? root.current : root;
    if (node === null || node === undefined) return;
    const doc = node.ownerDocument;
    let active = true;
    const registration = {
      kind,
      run: (action: GamepadOwnedAction): boolean => {
        if (!active || !pageActive.current || latest.current.scope !== scope || owners.get(node) !== registration || !available(node, doc)) return false;
        const handler = latest.current.handlers[action];
        if (handler === undefined) return false;
        handler(); return true;
      }
    };
    const retire = (): void => { pageActive.current = false; };
    const restore = (): void => { pageActive.current = true; };
    owners.set(node, registration); node.dataset.gamepadActions = kind;
    doc.defaultView?.addEventListener("pagehide", retire);
    doc.defaultView?.addEventListener("pageshow", restore);
    return () => {
      active = false;
      if (owners.get(node) === registration) { owners.delete(node); delete node.dataset.gamepadActions; }
      doc.defaultView?.removeEventListener("pagehide", retire);
      doc.defaultView?.removeEventListener("pageshow", restore);
    };
  });
}
