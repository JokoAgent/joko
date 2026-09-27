import { useEffect, useRef } from "react";
import { isStartupUpdateInteractionBlocked } from "./startup-update-interaction.js";
import {
  isDedicatedHardwareVoiceRoutedEvent,
  parseDedicatedHardwareActionDelivery,
  parseDedicatedHardwareTaskCatalog,
  type DedicatedHardwareBridge,
  type DedicatedHardwareCommand,
  type DedicatedHardwareRoutedActionEvent,
  type DedicatedHardwareTaskAction,
  type DedicatedHardwareTaskCatalog,
  type DedicatedHardwareVoiceRoutedEvent
} from "./dedicated-hardware.js";
import type { SessionView } from "./model.js";
import { sidebarSessionNaturalPriority } from "./sidebar-layout.js";
import {
  captureAppInputTimeline,
  captureAppInputVoice,
  dispatchAppInputComposerAction,
  dispatchAppInputFocusedCommand,
  dispatchAppInputOwnedCommand,
  dispatchAppInputScroll,
  isAppInputOwnedCommand,
  type AppInputScrollCapture,
  type AppInputVoiceCapture
} from "./app-input-owners.js";

const TASK_PUBLICATION_DEBOUNCE_MS = 80;
const SCROLL_WATCHDOG_MS = 10_000;
const SCROLL_MIN_SPEED = 90;
const SCROLL_MAX_SPEED = 2_600;

export interface DedicatedHardwareRendererHandlers {
  readonly command: (command: DedicatedHardwareCommand) => boolean;
  readonly task: (delivery: Readonly<{
    task: DedicatedHardwareTaskAction;
    focusRequestId: string | null;
  }>) => boolean;
  readonly fixedLink: (linkId: "product-feedback" | "documentation") => boolean;
}

function documentAcceptsDedicatedHardwarePress(doc: Document, requireForeground = true, allowInteractionDialog = false): boolean {
  const ownerWindow = doc.defaultView;
  const focused = doc.activeElement;
  const blockingFocusedOverlay = allowInteractionDialog
    ? "[role='listbox'], [role='menu'], [role='combobox'][aria-expanded='true'], [data-morph-side]"
    : "[aria-modal='true'], [role='dialog'], [role='listbox'], [role='menu'], [role='combobox'][aria-expanded='true'], [data-morph-side]";
  return ownerWindow !== null && !ownerWindow.closed && ownerWindow.top === ownerWindow
    && (!requireForeground || doc.visibilityState === "visible" && doc.hasFocus())
    && (allowInteractionDialog || !doc.body.classList.contains("modal-open"))
    && doc.body.dataset.appShortcutRecording !== "1"
    && doc.querySelector("[data-gamepad-preview], [data-dedicated-hardware-preview]") === null
    && doc.querySelector("[data-morph-side]:not([inert])") === null
    && (focused === null || !focused.matches("iframe, webview, embed, object"))
    && (focused === null || focused.closest(blockingFocusedOverlay) === null)
    && !isStartupUpdateInteractionBlocked();
}

function scrollSpeed(distance: number): number {
  const normalized = Math.min(1, Math.max(0, (distance - 0.5) / 0.5));
  return SCROLL_MIN_SPEED + (SCROLL_MAX_SPEED - SCROLL_MIN_SPEED) * normalized * normalized;
}

/** Owns renderer delivery state. All payloads are reparsed at this trust boundary. */
export class DedicatedHardwareRendererInput {
  private voice: {
    readonly owner: AppInputVoiceCapture;
    readonly ownerActivationId: string;
    readonly activationId: string | undefined;
    readonly state: "pressed" | "toggle-ready" | "finishing";
  } | undefined;
  private scroll: {
    readonly owner: AppInputScrollCapture;
    direction: "up" | "down";
    distance: number;
    lastFrameAt: number;
    frame: number;
    watchdog: number;
  } | undefined;
  private active = true;

  constructor(
    private readonly doc: Document,
    private readonly handlers: DedicatedHardwareRendererHandlers
  ) {}

  handle(raw: unknown): boolean {
    if (!this.active) return false;
    let delivery;
    try { delivery = parseDedicatedHardwareActionDelivery(raw); } catch { return false; }
    const { event, focusRequestId } = delivery;
    if (event.kind === "scroll") return this.handleScroll(event);
    if (isDedicatedHardwareVoiceRoutedEvent(event)) return this.handleVoice(event);
    const mainWindowNavigation = event.action.kind === "task"
      || event.action.kind === "command" && (event.action.command === "previous-task" || event.action.command === "next-task");
    const interactionDialog = event.action.kind === "command"
      && (event.action.command === "approve" || event.action.command === "reject");
    const action = event.action;
    if (event.phase !== "press"
      || !documentAcceptsDedicatedHardwarePress(
        this.doc,
        !mainWindowNavigation,
        interactionDialog
      )) return false;
    if (action.kind === "command") {
      if (isAppInputOwnedCommand(action.command)) return dispatchAppInputOwnedCommand(this.doc, action.command);
      if (action.command === "activate" || action.command === "back") {
        return dispatchAppInputFocusedCommand(this.doc, action.command);
      }
      if (action.command === "focus-composer") return dispatchAppInputComposerAction(this.doc, { kind: "focus" });
      if (action.command === "scroll-up" || action.command === "scroll-down") {
        return dispatchAppInputScroll(this.doc, action.command === "scroll-up" ? -240 : 240);
      }
      if (this.doc.body.classList.contains("modal-open")) return false;
      return this.handlers.command(action.command);
    }
    if (this.doc.body.classList.contains("modal-open")) return false;
    if (action.kind === "task") return this.handlers.task({ task: action, focusRequestId });
    if (action.kind === "skill") {
      return dispatchAppInputComposerAction(this.doc, {
        kind: "skill",
        skill: { serverId: action.serverId, resourceId: action.resourceId, name: action.name }
      });
    }
    if (action.kind === "composer-text") {
      return dispatchAppInputComposerAction(this.doc, { kind: "composer-text", text: action.text });
    }
    return this.handlers.fixedLink(action.linkId);
  }

  dispose(): void {
    if (!this.active) return;
    this.active = false;
    this.voice?.owner.cancel();
    this.voice = undefined;
    this.stopScroll();
  }

  private handleScroll(event: Extract<DedicatedHardwareRoutedActionEvent, { kind: "scroll" }>): boolean {
    if (event.phase === "release" || event.phase === "cancel") return this.stopScroll();
    if (event.phase === "press") {
      if (!documentAcceptsDedicatedHardwarePress(this.doc)) { this.stopScroll(); return false; }
      this.stopScroll();
      const owner = captureAppInputTimeline(this.doc);
      const ownerWindow = this.doc.defaultView;
      if (owner === undefined || ownerWindow === null) return false;
      const state = {
        owner,
        direction: event.direction,
        distance: event.distance,
        lastFrameAt: ownerWindow.performance.now(),
        frame: 0,
        watchdog: 0
      };
      const tick = (now: number): void => {
        if (this.scroll !== state) return;
        const elapsed = Math.max(0, Math.min(100, now - state.lastFrameAt));
        state.lastFrameAt = now;
        const magnitude = scrollSpeed(state.distance) * elapsed / 1_000;
        if (!state.owner.scroll(state.direction === "up" ? -magnitude : magnitude)) { this.stopScroll(); return; }
        state.frame = ownerWindow.requestAnimationFrame(tick);
      };
      this.scroll = state;
      state.frame = ownerWindow.requestAnimationFrame(tick);
      this.armScrollWatchdog(state);
      return true;
    }
    if (event.phase !== "move") return false;
    const state = this.scroll;
    if (state === undefined) return false;
    state.direction = event.direction;
    state.distance = event.distance;
    this.armScrollWatchdog(state);
    return true;
  }

  private handleVoice(event: DedicatedHardwareVoiceRoutedEvent): boolean {
    if (event.phase === "press") {
      if (event.activationKind === "start") {
        if (this.voice !== undefined || !documentAcceptsDedicatedHardwarePress(this.doc)) return false;
        const owner = captureAppInputVoice(this.doc, event.ownerActivationId);
        if (owner === undefined || owner.ownerActivationId !== event.ownerActivationId) return false;
        this.voice = {
          owner,
          ownerActivationId: event.ownerActivationId,
          activationId: event.activationId,
          state: "pressed"
        };
        return true;
      }
      const voice = this.voice;
      if (voice === undefined || voice.state !== "toggle-ready"
        || voice.ownerActivationId !== event.ownerActivationId) return false;
      if (!voice.owner.finish()) {
        this.voice = undefined;
        return false;
      }
      this.voice = {
        owner: voice.owner,
        ownerActivationId: voice.ownerActivationId,
        activationId: event.activationId,
        state: "finishing"
      };
      return true;
    }

    const voice = this.voice;
    if (voice === undefined || voice.ownerActivationId !== event.ownerActivationId) return false;
    if (event.releaseKind === "cancel") {
      const matchingActivation = voice.state === "toggle-ready"
        ? event.activationKind === "start" && event.activationId === voice.ownerActivationId
        : event.activationId === voice.activationId;
      if (!matchingActivation) return false;
      this.voice = undefined;
      return voice.state === "finishing" ? true : voice.owner.cancel();
    }
    if (voice.state === "finishing") {
      if (event.activationId !== voice.activationId || event.activationKind !== "toggle-finish") return false;
      this.voice = undefined;
      return true;
    }
    if (voice.state !== "pressed" || event.activationId !== voice.activationId
      || event.activationKind !== "start") return false;
    if (event.releaseKind === "tap") {
      this.voice = {
        owner: voice.owner,
        ownerActivationId: voice.ownerActivationId,
        activationId: undefined,
        state: "toggle-ready"
      };
      return true;
    }
    this.voice = undefined;
    return voice.owner.finish();
  }

  private armScrollWatchdog(state: NonNullable<DedicatedHardwareRendererInput["scroll"]>): void {
    const ownerWindow = this.doc.defaultView;
    if (ownerWindow === null) { this.stopScroll(); return; }
    if (state.watchdog !== 0) ownerWindow.clearTimeout(state.watchdog);
    state.watchdog = ownerWindow.setTimeout(() => {
      if (this.scroll === state) this.stopScroll();
    }, SCROLL_WATCHDOG_MS);
  }

  private stopScroll(): boolean {
    const state = this.scroll;
    this.scroll = undefined;
    const ownerWindow = this.doc.defaultView;
    if (state === undefined) return false;
    if (ownerWindow !== null) {
      ownerWindow.cancelAnimationFrame(state.frame);
      ownerWindow.clearTimeout(state.watchdog);
    }
    return true;
  }
}

export function useDedicatedHardwareInput(
  bridge: DedicatedHardwareBridge | undefined,
  handlers: DedicatedHardwareRendererHandlers
): void {
  const latest = useRef(handlers); latest.current = handlers;
  useEffect(() => {
    if (bridge?.onDedicatedHardwareAction === undefined) return;
    const input = new DedicatedHardwareRendererInput(document, {
      command: (command) => latest.current.command(command),
      task: (task) => latest.current.task(task),
      fixedLink: (linkId) => latest.current.fixedLink(linkId)
    });
    const retire = (): void => input.dispose();
    const unsubscribe = bridge.onDedicatedHardwareAction((raw) => { input.handle(raw); });
    window.addEventListener("pagehide", retire);
    return () => {
      window.removeEventListener("pagehide", retire);
      input.dispose();
      unsubscribe();
    };
  }, [bridge]);
}

export interface DedicatedHardwareTaskCatalogInput {
  readonly profileId: string;
  readonly serverId: string;
  readonly connectionGeneration: bigint;
  readonly snapshotRevision: bigint;
  readonly sessions: readonly SessionView[];
  readonly sidebarSessionIds: readonly string[];
  readonly viewedSessionId?: string;
}

export function createDedicatedHardwareTaskCatalog(input: DedicatedHardwareTaskCatalogInput): DedicatedHardwareTaskCatalog {
  const sidebarOrder = new Map(input.sidebarSessionIds.map((id, index) => [id, index]));
  const sessions = [...input.sessions].sort((left, right) => {
    const leftOrder = sidebarOrder.get(left.id);
    const rightOrder = sidebarOrder.get(right.id);
    if (leftOrder !== undefined || rightOrder !== undefined) return (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER);
    return Number(right.pinned) - Number(left.pinned)
      || (right.lastUserInputAt ?? right.updatedAt) - (left.lastUserInputAt ?? left.updatedAt)
      || left.id.localeCompare(right.id);
  }).slice(0, 100);
  const catalog: DedicatedHardwareTaskCatalog = {
    version: 1,
    profileId: input.profileId,
    serverId: input.serverId,
    connectionGeneration: input.connectionGeneration.toString(10),
    snapshotRevision: input.snapshotRevision.toString(10),
    tasks: sessions.map((session) => ({
      sessionId: session.id,
      sessionGeneration: session.generation.toString(10),
      targetId: session.targetId,
      title: validCatalogTitle(session.name) ? session.name : null,
      pinned: session.pinned,
      userSendAt: nonnegativeSafeInteger(session.lastUserInputAt) ? session.lastUserInputAt : null,
      sidebarOrder: sidebarOrder.get(session.id) ?? null,
      catalogEligible: !session.archived,
      priorityRank: session.archived ? null : sidebarSessionNaturalPriority(session, { viewedSessionId: input.viewedSessionId })
    }))
  };
  const parsed = parseDedicatedHardwareTaskCatalog(catalog);
  if (parsed === undefined) throw new TypeError("Dedicated hardware task catalog source is invalid.");
  return parsed;
}

export function visibleDedicatedHardwareTaskOrder(doc: Document): readonly string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const element of doc.querySelectorAll<HTMLElement>(".sidebar [data-session-id], .workspace-session-tabs-bar [data-session-id]")) {
    const id = element.dataset.sessionId;
    if (id === undefined || seen.has(id) || element.getClientRects().length === 0
      || element.closest("[hidden], [inert], [aria-hidden='true']") !== null) continue;
    seen.add(id); ids.push(id);
  }
  return ids;
}

export function useDedicatedHardwareTaskCatalogPublisher(
  bridge: DedicatedHardwareBridge | undefined,
  catalog: DedicatedHardwareTaskCatalog | undefined
): void {
  const lastOwner = useRef<DedicatedHardwareTaskCatalog | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  const publicationChain = useRef<Promise<void>>(Promise.resolve());
  const enqueue = (target: DedicatedHardwareBridge, value: DedicatedHardwareTaskCatalog): void => {
    publicationChain.current = publicationChain.current.catch(() => undefined).then(async () => {
      await target.publishDedicatedHardwareTasks(value);
    }).catch(() => undefined);
  };
  useEffect(() => {
    if (bridge === undefined) return;
    const previous = lastOwner.current;
    const previousKey = previous === undefined ? undefined : `${previous.profileId}\u0000${previous.serverId}`;
    const nextKey = catalog === undefined ? undefined : `${catalog.profileId}\u0000${catalog.serverId}`;
    if (previous !== undefined && previousKey !== nextKey) {
      enqueue(bridge, { ...previous, tasks: [] });
      lastOwner.current = undefined;
    }
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    if (catalog === undefined) return;
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      lastOwner.current = catalog;
      enqueue(bridge, catalog);
    }, TASK_PUBLICATION_DEBOUNCE_MS);
    return () => {
      if (timer.current !== undefined) { window.clearTimeout(timer.current); timer.current = undefined; }
    };
  }, [bridge, catalog]);
  useEffect(() => () => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    const previous = lastOwner.current;
    if (bridge !== undefined && previous !== undefined) {
      enqueue(bridge, { ...previous, tasks: [] });
    }
  }, [bridge]);
}

function nonnegativeSafeInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

function validCatalogTitle(value: string): boolean {
  return value.length <= 512 && value.trim() === value && !hasLoneSurrogate(value)
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    && new TextEncoder().encode(value).byteLength <= 2_048;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}
