import { useLayoutEffect, useRef, type RefObject } from "react";

export const APP_INPUT_INSPECTOR_COMMANDS = ["open-terminal", "open-browser-tab", "toggle-review-tab"] as const;
export type AppInputInspectorCommand = (typeof APP_INPUT_INSPECTOR_COMMANDS)[number];

export const APP_INPUT_OWNED_COMMANDS = [
  "approve", "reject", "submit", "stop", "toggle-plan", "toggle-fast", "effort-increase", "effort-decrease",
  "toggle-pin", "archive-task", "fork-task", "copy-task-link", "copy-conversation-markdown", "add-photos", "add-files",
  "open-commands", "scroll-bottom"
] as const;
export type AppInputOwnedCommand = (typeof APP_INPUT_OWNED_COMMANDS)[number];
export type AppInputOwnerKind = "composer" | "session" | "interaction";
export type AppInputCommandHandlers = Partial<Record<AppInputOwnedCommand, () => void>>;

export interface AppInputSkillIdentity {
  readonly serverId: string;
  readonly resourceId: string;
  readonly name: string;
}

export interface AppInputVoiceOwnerOptions {
  readonly enabled: boolean;
  readonly isActive: () => boolean;
  readonly getCaptureIdentity: () => object | undefined;
  readonly start: () => boolean;
  readonly finish: () => Promise<unknown>;
  readonly cancel: () => void;
}

export interface AppInputComposerHandlers {
  readonly focus?: () => boolean;
  readonly key?: (key: "ArrowUp" | "ArrowDown" | "Enter") => boolean;
  readonly insertText?: (text: string) => boolean;
  readonly insertSkill?: (skill: AppInputSkillIdentity) => boolean;
  readonly voice?: AppInputVoiceOwnerOptions;
}

export type AppInputComposerAction =
  | { readonly kind: "focus" }
  | { readonly kind: "key"; readonly key: "ArrowUp" | "ArrowDown" | "Enter" }
  | { readonly kind: "composer-text"; readonly text: string }
  | { readonly kind: "skill"; readonly skill: AppInputSkillIdentity };

export interface AppInputVoiceCapture {
  readonly ownerActivationId: string;
  readonly finish: () => boolean;
  readonly cancel: () => boolean;
}

export interface AppInputScrollCapture {
  readonly scroll: (deltaY: number) => boolean;
}

interface CommandRegistration {
  readonly kind: AppInputOwnerKind;
  readonly run: (command: AppInputOwnedCommand) => boolean;
}

interface ComposerRegistration {
  readonly run: (action: AppInputComposerAction) => boolean;
  readonly voice: (phase: "press" | "release" | "cancel") => boolean;
}

interface TimelineRegistration {
  readonly run: (deltaY: number) => boolean;
}

const commandOwners = new WeakMap<HTMLElement, CommandRegistration>();
const composerOwners = new WeakMap<HTMLElement, ComposerRegistration>();
const timelineOwners = new WeakMap<HTMLElement, TimelineRegistration>();

function available(node: Element | null | undefined, doc: Document): node is HTMLElement {
  return node !== null && node !== undefined && node.isConnected && node.ownerDocument === doc
    && node.closest("[hidden], [inert], [aria-hidden='true']") === null;
}

/** A focused split pane is authoritative; unrelated popovers never select the first task. */
export function currentAppInputTaskRoot(doc: Document): HTMLElement | null {
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

export function isAppInputOwnedCommand(value: string): value is AppInputOwnedCommand {
  return (APP_INPUT_OWNED_COMMANDS as readonly string[]).includes(value);
}

export function isAppInputInspectorCommand(value: string): value is AppInputInspectorCommand {
  return (APP_INPUT_INSPECTOR_COMMANDS as readonly string[]).includes(value);
}

/** Routes activate/back only to the exact focused DOM owner; it never searches for a control. */
export function dispatchAppInputFocusedCommand(doc: Document, command: "activate" | "back"): boolean {
  const focused = doc.activeElement;
  if (!available(focused, doc) || focused.matches("iframe, webview, embed, object")) return false;
  if (command === "activate") {
    if (!(focused instanceof HTMLElement)
      || !focused.matches("button:not(:disabled), [role='button']:not([aria-disabled='true'])")) return false;
    focused.click();
    return true;
  }
  focused.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape", code: "Escape", bubbles: true, cancelable: true
  }));
  return true;
}

/** Dispatches to one registered, visible owner without clicking or searching application controls. */
export function dispatchAppInputOwnedCommand(doc: Document, command: AppInputOwnedCommand): boolean {
  const focused = doc.activeElement;
  if (focused !== null && !available(focused, doc)) return false;
  let target: HTMLElement | null = null;
  if (command === "approve" || command === "reject") {
    const exact = focused?.closest<HTMLElement>("[data-input-actions='interaction']");
    if (available(exact, doc)) target = exact;
    else {
      const dialog = focused?.closest("[aria-modal='true'], [role='dialog']");
      if (dialog !== null && dialog !== undefined) target = dialog.querySelector("[data-input-actions='interaction']");
      else if (!doc.body.classList.contains("modal-open")) target = currentAppInputTaskRoot(doc)?.querySelector("[data-input-actions='interaction']") ?? null;
    }
  } else {
    if (doc.body.classList.contains("modal-open") || doc.querySelector("[data-morph-side]:not([inert])") !== null) return false;
    const root = currentAppInputTaskRoot(doc);
    const kind = command === "submit" || command === "add-photos" || command === "add-files" || command === "open-commands" ? "composer" : "session";
    if (root?.dataset.inputActions === kind) target = root;
    else target = root?.querySelector(`[data-input-actions='${kind}']`) ?? null;
  }
  if (!available(target, doc)) return false;
  return commandOwners.get(target)?.run(command) ?? false;
}

/** Component scope and DOM lifetime jointly own each command; rerenders replace handlers without replay. */
export function useAppInputCommandOwner(
  root: HTMLElement | undefined | RefObject<HTMLElement | null>,
  scope: unknown,
  kind: AppInputOwnerKind,
  handlers: AppInputCommandHandlers
): void {
  const latest = useRef({ scope, handlers }); latest.current = { scope, handlers };
  const pageActive = useRef(true);
  useLayoutEffect(() => {
    const node = root !== undefined && "current" in root ? root.current : root;
    if (node === null || node === undefined) return;
    const doc = node.ownerDocument;
    let active = true;
    const registration: CommandRegistration = {
      kind,
      run: (command) => {
        if (!active || !pageActive.current || latest.current.scope !== scope || commandOwners.get(node) !== registration || !available(node, doc)) return false;
        const handler = latest.current.handlers[command];
        if (handler === undefined) return false;
        handler(); return true;
      }
    };
    const retire = (): void => { pageActive.current = false; };
    const restore = (): void => { pageActive.current = true; };
    commandOwners.set(node, registration); node.dataset.inputActions = kind;
    doc.defaultView?.addEventListener("pagehide", retire);
    doc.defaultView?.addEventListener("pageshow", restore);
    return () => {
      active = false;
      if (commandOwners.get(node) === registration) { commandOwners.delete(node); delete node.dataset.inputActions; }
      doc.defaultView?.removeEventListener("pagehide", retire);
      doc.defaultView?.removeEventListener("pageshow", restore);
    };
  });
}

function currentComposerRegistration(doc: Document): { readonly node: HTMLElement; readonly registration: ComposerRegistration } | undefined {
  if (doc.body.classList.contains("modal-open") || doc.querySelector("[data-morph-side]:not([inert])") !== null) return undefined;
  const task = currentAppInputTaskRoot(doc);
  const node = task?.matches("[data-input-composer]") === true
    ? task
    : task?.querySelector<HTMLElement>("[data-input-composer]");
  if (!available(node, doc)) return undefined;
  const registration = composerOwners.get(node);
  return registration === undefined ? undefined : { node, registration };
}

export function dispatchAppInputComposerAction(doc: Document, action: AppInputComposerAction): boolean {
  return currentComposerRegistration(doc)?.registration.run(action) ?? false;
}

/** Voice finish/cancel remains bound to the exact registration captured at press. */
export function captureAppInputVoice(
  doc: Document,
  ownerActivationId: string
): AppInputVoiceCapture | undefined {
  if (!/^[1-9][0-9]{0,63}$/u.test(ownerActivationId)) return undefined;
  const owner = currentComposerRegistration(doc)?.registration;
  if (owner === undefined || !owner.voice("press")) return undefined;
  let active = true;
  const finish = (phase: "release" | "cancel"): boolean => {
    if (!active) return false;
    active = false;
    return owner.voice(phase);
  };
  return Object.freeze({
    ownerActivationId,
    finish: () => finish("release"),
    cancel: () => finish("cancel")
  });
}

export function useAppInputComposerOwner(
  root: HTMLElement | undefined,
  scope: unknown,
  handlers: AppInputComposerHandlers
): void {
  const latest = useRef(handlers); latest.current = handlers;
  useLayoutEffect(() => {
    if (root === undefined) return;
    const doc = root.ownerDocument;
    let active = true;
    let pageActive = true;
    let voiceOwner: { readonly origin: AppInputVoiceOwnerOptions; readonly capture: object } | undefined;
    const cancelVoice = (): boolean => {
      const press = voiceOwner; voiceOwner = undefined;
      if (press === undefined) return false;
      if (press.origin.getCaptureIdentity() === press.capture) press.origin.cancel();
      return true;
    };
    const registration: ComposerRegistration = {
      run: (action) => {
        if (!active || !pageActive || composerOwners.get(root) !== registration || !available(root, doc)
          || currentComposerRegistration(doc)?.node !== root) return false;
        if (action.kind === "focus") return latest.current.focus?.() ?? false;
        if (action.kind === "key") return latest.current.key?.(action.key) ?? false;
        if (action.kind === "composer-text") return latest.current.insertText?.(action.text) ?? false;
        return latest.current.insertSkill?.(action.skill) ?? false;
      },
      voice: (phase) => {
        if (!active || !pageActive || composerOwners.get(root) !== registration || !available(root, doc)) return false;
        if (phase === "press") {
          if (currentComposerRegistration(doc)?.node !== root || voiceOwner !== undefined) return false;
          const origin = latest.current.voice;
          if (origin === undefined || !origin.enabled || origin.isActive() || !origin.start()) return false;
          const capture = origin.getCaptureIdentity();
          if (capture === undefined) { origin.cancel(); return false; }
          voiceOwner = { origin, capture };
          return true;
        }
        if (phase === "cancel") return cancelVoice();
        const press = voiceOwner; voiceOwner = undefined;
        if (press === undefined || press.origin.getCaptureIdentity() !== press.capture) return false;
        void press.origin.finish().catch(() => {
          if (press.origin.getCaptureIdentity() === press.capture) press.origin.cancel();
        });
        return true;
      }
    };
    const retire = (): void => { pageActive = false; cancelVoice(); };
    const restore = (): void => { pageActive = true; };
    composerOwners.set(root, registration); root.dataset.inputComposer = "true";
    doc.defaultView?.addEventListener("pagehide", retire);
    doc.defaultView?.addEventListener("pageshow", restore);
    return () => {
      active = false; cancelVoice();
      if (composerOwners.get(root) === registration) { composerOwners.delete(root); delete root.dataset.inputComposer; }
      doc.defaultView?.removeEventListener("pagehide", retire);
      doc.defaultView?.removeEventListener("pageshow", restore);
    };
  }, [root, scope]);
}

export function captureAppInputTimeline(doc: Document): AppInputScrollCapture | undefined {
  if (doc.body.classList.contains("modal-open") || doc.querySelector("[data-morph-side]:not([inert])") !== null) return undefined;
  const task = currentAppInputTaskRoot(doc);
  const node = task?.querySelector<HTMLElement>("[data-input-timeline]");
  if (!available(node, doc)) return undefined;
  const owner = timelineOwners.get(node);
  if (owner === undefined) return undefined;
  return { scroll: (deltaY) => owner.run(deltaY) };
}

export function dispatchAppInputScroll(doc: Document, deltaY: number): boolean {
  return captureAppInputTimeline(doc)?.scroll(deltaY) ?? false;
}

export function useAppInputTimelineOwner(
  root: RefObject<HTMLElement | null>,
  scope: unknown,
  onScroll: (deltaY: number) => void
): void {
  const latest = useRef(onScroll); latest.current = onScroll;
  useLayoutEffect(() => {
    const node = root.current;
    if (node === null) return;
    const doc = node.ownerDocument;
    let active = true;
    let pageActive = true;
    const registration: TimelineRegistration = {
      run: (deltaY) => {
        if (!active || !pageActive || timelineOwners.get(node) !== registration || !available(node, doc)
          || !Number.isFinite(deltaY)) return false;
        latest.current(deltaY); return true;
      }
    };
    const retire = (): void => { pageActive = false; };
    const restore = (): void => { pageActive = true; };
    timelineOwners.set(node, registration); node.dataset.inputTimeline = "true";
    doc.defaultView?.addEventListener("pagehide", retire);
    doc.defaultView?.addEventListener("pageshow", restore);
    return () => {
      active = false;
      if (timelineOwners.get(node) === registration) { timelineOwners.delete(node); delete node.dataset.inputTimeline; }
      doc.defaultView?.removeEventListener("pagehide", retire);
      doc.defaultView?.removeEventListener("pageshow", restore);
    };
  }, [root, scope]);
}
