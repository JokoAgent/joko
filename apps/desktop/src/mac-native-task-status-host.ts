import type {
  DesktopNativeTaskStatusAction,
  DesktopNativeTaskStatusDecision,
  DesktopNativeTaskStatusDisplay,
  DesktopNativeTaskStatusPhase,
  DesktopNativeTaskStatusSoundEvent,
  DesktopNativeTaskStatusSettings,
  DesktopNativeTaskStatusSnapshot
} from "./channels.js";
import {
  isNewerNativeTaskStatusSnapshot,
  isSilentDesktopNativeTaskStatusSound,
  nativeTaskStatusPermissionDecisionAllowed,
  projectDesktopNativeTaskStatusSurface,
  type DesktopNativeTaskStatusSurface
} from "./native-task-status.js";
import {
  resolveDesktopNativeTaskStatusLayoutPreference,
  type DesktopNativeTaskStatusLayoutPreference
} from "./native-task-status-layout-settings.js";

const ACTION_SCHEME = "joko-task-status:";
const MAXIMUM_VISIBLE_TASK_ROWS = 5;
const MINIMUM_TASK_STATUS_WIDTH = 280;
const MAXIMUM_TASK_STATUS_WIDTH = 920;
const TASK_STATUS_SCREEN_EDGE_GUTTER = 12;
const TASK_STATUS_POINTER_POLL_MS = 50;
export const NATIVE_TASK_STATUS_HOVER_INTENT_MS = 500;
export const NATIVE_TASK_STATUS_POINTER_LEAVE_GRACE_MS = 150;
export const NATIVE_TASK_STATUS_HOVER_COOLDOWN_MS = 300;
export const NATIVE_TASK_STATUS_COMPLETION_DWELL_MS = 8_000;
export const NATIVE_TASK_STATUS_ERROR_DWELL_MS = 12_000;
export const NATIVE_TASK_STATUS_SMART_SUPPRESSION_DWELL_MS = 5_000;
export const NATIVE_TASK_STATUS_EXPANDED_MIN_DWELL_MS = 1_000;
export const NATIVE_TASK_STATUS_COMPACT_CURRENT_MIN_DWELL_MS = 1_200;
export const NATIVE_TASK_STATUS_UNREAD_TERMINAL_TTL_MS = 4 * 60 * 60 * 1_000;
export const NATIVE_TASK_STATUS_WINDOW_INTERACTION = Object.freeze({
  resizable: true,
  movable: true,
  minWidth: MINIMUM_TASK_STATUS_WIDTH,
  maxWidth: MAXIMUM_TASK_STATUS_WIDTH,
  minHeight: 46,
  focusable: false,
  acceptFirstMouse: true
});

export interface NativeTaskStatusPoint {
  readonly x: number;
  readonly y: number;
}

export interface NativeTaskStatusWindowBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface NativeTaskStatusWindow {
  readonly isDestroyed: () => boolean;
  readonly setBounds: (bounds: NativeTaskStatusWindowBounds) => void;
  readonly loadDocument: (dataUrl: string) => Promise<void>;
  readonly showInactive: () => void;
  readonly destroy: () => void;
  readonly onClosed: (listener: () => void) => void;
  readonly onWillNavigate: (listener: (url: string) => void) => void;
  readonly onBoundsChanged: (listener: (bounds: NativeTaskStatusWindowBounds) => void) => void;
  readonly denyNewWindows: () => void;
}

export interface MacNativeTaskStatusHostOptions {
  readonly supported: boolean;
  readonly getDisplays: () => readonly DesktopNativeTaskStatusDisplay[];
  readonly createWindow: (bounds: NativeTaskStatusWindowBounds) => NativeTaskStatusWindow;
  readonly onAction: (action: DesktopNativeTaskStatusAction) => void;
  readonly onNewTask: () => void;
  readonly onOpenSettings: () => void;
  readonly onToggleSounds: () => void | Promise<void>;
  readonly playSound: (sound: DesktopNativeTaskStatusSettings["sounds"]["sounds"][DesktopNativeTaskStatusSoundEvent]) => void | Promise<void>;
  readonly getCursorPoint?: () => NativeTaskStatusPoint;
  readonly getVisibleSessionIds?: () => readonly string[];
  readonly getLayoutPreferences?: () => readonly DesktopNativeTaskStatusLayoutPreference[];
  readonly onLayoutPreference?: (preference: DesktopNativeTaskStatusLayoutPreference) => void | Promise<void>;
  readonly now?: () => number;
  readonly setTimer?: (listener: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

export interface MacNativeTaskStatusHost {
  readonly setSettings: (settings: DesktopNativeTaskStatusSettings) => void;
  readonly setApplicationFocused: (focused: boolean) => void;
  readonly publish: (snapshot: DesktopNativeTaskStatusSnapshot) => void;
  readonly refreshDisplays: () => void;
  readonly refreshVisibility: () => void;
  readonly surface: () => DesktopNativeTaskStatusSurface | undefined;
  readonly dispose: () => void;
}

interface HostedWindow {
  readonly displayId: number;
  readonly window: NativeTaskStatusWindow;
  display: DesktopNativeTaskStatusDisplay;
  displayIndex: number;
  bounds: NativeTaskStatusWindowBounds;
  renderToken: number;
}

export function createMacNativeTaskStatusHost(options: MacNativeTaskStatusHostOptions): MacNativeTaskStatusHost {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((listener: () => void, delayMs: number): unknown => setTimeout(listener, delayMs));
  const clearTimer = options.clearTimer ?? ((timer: unknown): void => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let settings: DesktopNativeTaskStatusSettings | undefined;
  let snapshot: DesktopNativeTaskStatusSnapshot | undefined;
  let manualExpandedDisplayId: number | undefined;
  let disposed = false;
  let observedSnapshot = false;
  let terminalTimer: unknown;
  let terminalTimerAt: number | undefined;
  let terminalTimerArmed = false;
  let smartTimer: unknown;
  let smartTimerAt: number | undefined;
  let smartTimerArmed = false;
  let compactCurrentSessionId: string | undefined;
  let compactCurrentUntil: number | undefined;
  let compactTimer: unknown;
  let compactTimerAt: number | undefined;
  let compactTimerArmed = false;
  let applicationFocused = false;
  let pointerTimer: unknown;
  let pointerTimerArmed = false;
  let hoveredDisplayId: number | undefined;
  let hoveredSince: number | undefined;
  let pointerLeftSince: number | undefined;
  let hoverCooldownUntil = 0;
  let waitForPointerExit = false;
  let manualExpandedAt: number | undefined;
  let layoutPreferences = Object.freeze([
    ...(options.getLayoutPreferences?.() ?? [])
  ]) as readonly DesktopNativeTaskStatusLayoutPreference[];
  const hosted = new Map<number, HostedWindow>();
  const soundCooldownUntil = new Map<DesktopNativeTaskStatusSoundEvent, number>();
  const terminalRevealUntil = new Map<string, number>();
  const terminalObservedAt = new Map<string, number>();
  const smartSuppressions = new Map<string, { readonly identity: string; readonly until: number }>();

  const playConfiguredSound = (event: DesktopNativeTaskStatusSoundEvent): void => {
    if (settings?.sounds.enabled !== true) return;
    const sound = settings.sounds.sounds[event];
    if (isSilentDesktopNativeTaskStatusSound(sound)) return;
    const at = now();
    if ((soundCooldownUntil.get(event) ?? 0) > at) return;
    soundCooldownUntil.set(event, at + soundCooldown(event));
    void Promise.resolve(options.playSound(sound)).catch(() => undefined);
  };

  const cancelTerminalTimer = (): void => {
    if (!terminalTimerArmed) return;
    clearTimer(terminalTimer);
    terminalTimer = undefined;
    terminalTimerAt = undefined;
    terminalTimerArmed = false;
  };

  const cancelPointerTimer = (): void => {
    if (!pointerTimerArmed) return;
    clearTimer(pointerTimer);
    pointerTimer = undefined;
    pointerTimerArmed = false;
  };

  const cancelSmartTimer = (): void => {
    if (!smartTimerArmed) return;
    clearTimer(smartTimer);
    smartTimer = undefined;
    smartTimerAt = undefined;
    smartTimerArmed = false;
  };

  const cancelCompactTimer = (): void => {
    if (!compactTimerArmed) return;
    clearTimer(compactTimer);
    compactTimer = undefined;
    compactTimerAt = undefined;
    compactTimerArmed = false;
  };

  const currentSurface = (startDwell = false): {
    readonly surface: DesktopNativeTaskStatusSurface | undefined;
    readonly terminalDeadline?: number;
    readonly smartDeadline?: number;
    readonly compactDeadline?: number;
  } => {
    if (snapshot === undefined) return { surface: undefined };
    const at = now();
    const manualExpanded = manualExpandedDisplayId !== undefined;
    const unexpiredSessions = snapshot.sessions.filter((session) => {
      if (!isTerminalPhase(session.phase)) return true;
      const observedAt = terminalObservedAt.get(transientKey(session.sessionId, session.phase));
      return observedAt === undefined || observedAt + NATIVE_TASK_STATUS_UNREAD_TERMINAL_TTL_MS > at;
    });
    const visibleSessionIds = applicationFocused
      ? new Set(options.getVisibleSessionIds?.() ?? [])
      : new Set<string>();
    const suppressibleSessions = unexpiredSessions.filter((session) =>
      visibleSessionIds.has(session.sessionId) && session.phase === "interaction" && session.permission === undefined
    );
    const suppressibleById = new Map(suppressibleSessions.map((session) => [session.sessionId, session]));
    for (const [sessionId] of smartSuppressions) if (!suppressibleById.has(sessionId)) smartSuppressions.delete(sessionId);
    if (startDwell) {
      for (const session of suppressibleSessions) {
        const identity = smartSuppressionIdentity(snapshot.ownerId, session);
        if (smartSuppressions.get(session.sessionId)?.identity !== identity) {
          smartSuppressions.set(session.sessionId, {
            identity,
            until: at + NATIVE_TASK_STATUS_SMART_SUPPRESSION_DWELL_MS
          });
        }
      }
    }
    let smartDeadline: number | undefined;
    const smartExpiredSessionIds = new Set<string>();
    for (const [sessionId, suppression] of smartSuppressions) {
      if (suppression.until <= at) {
        if (!manualExpanded) smartExpiredSessionIds.add(sessionId);
      } else if (smartDeadline === undefined || suppression.until < smartDeadline) {
        smartDeadline = suppression.until;
      }
    }
    const retainedSessions = unexpiredSessions.filter((session) =>
      !smartExpiredSessionIds.has(session.sessionId)
    );
    const activeSessions = retainedSessions.filter((session) => {
      if (manualExpanded) return true;
      if (!isTerminalPhase(session.phase)) return true;
      const key = transientKey(session.sessionId, session.phase);
      const deadline = terminalRevealUntil.get(key);
      return deadline === undefined || deadline > at;
    });
    const retainedSnapshot = {
      ...snapshot,
      sessions: Object.freeze(retainedSessions)
    };
    const retainedSurface = projectDesktopNativeTaskStatusSurface(retainedSnapshot, { manualExpanded });
    const activeSnapshot = {
      ...snapshot,
      sessions: Object.freeze(activeSessions)
    };
    let surface = projectDesktopNativeTaskStatusSurface(activeSnapshot, { manualExpanded });
    if (!manualExpanded && surface.policy !== "blocking" &&
      retainedSessions.some((session) => isTerminalPhase(session.phase)) &&
      !activeSessions.some((session) => isTerminalPhase(session.phase))) {
      surface = projectDesktopNativeTaskStatusSurface(retainedSnapshot, { suppressTransient: true });
    } else {
      surface = Object.freeze({
        ...surface,
        sessions: retainedSurface.sessions,
        counts: retainedSurface.counts
      });
    }
    if (surface.mode === "closed") {
      surface = Object.freeze({
        ...surface,
        mode: manualExpanded ? "expanded" : "compact",
        policy: manualExpanded ? "manual" : "peek"
      });
    }
    if (!manualExpanded && surface.policy === "blocking" && surface.current !== undefined &&
      suppressibleById.has(surface.current.sessionId) && !smartExpiredSessionIds.has(surface.current.sessionId)) {
      surface = Object.freeze({ ...surface, mode: "compact" });
    } else if (!manualExpanded && surface.policy === "transient" && surface.current !== undefined &&
      visibleSessionIds.has(surface.current.sessionId)) {
      surface = Object.freeze({ ...surface, mode: "compact" });
    }
    let terminalDeadline: number | undefined;
    if (surface.policy === "transient" && surface.current !== undefined) {
      const key = transientKey(surface.current.sessionId, surface.current.phase);
      let revealDeadline = terminalRevealUntil.get(key);
      if (revealDeadline === undefined && startDwell) {
        revealDeadline = at + terminalDwell(surface.current.phase);
        terminalRevealUntil.set(key, revealDeadline);
      }
      if (revealDeadline !== undefined && revealDeadline > at) terminalDeadline = revealDeadline;
    }
    for (const session of retainedSessions) {
      if (!isTerminalPhase(session.phase)) continue;
      const observedAt = terminalObservedAt.get(transientKey(session.sessionId, session.phase));
      if (observedAt === undefined) continue;
      const ttlDeadline = observedAt + NATIVE_TASK_STATUS_UNREAD_TERMINAL_TTL_MS;
      if (ttlDeadline > at && (terminalDeadline === undefined || ttlDeadline < terminalDeadline)) {
        terminalDeadline = ttlDeadline;
      }
    }
    let compactDeadline: number | undefined;
    if (!manualExpanded && surface.mode === "compact" && surface.policy === "peek") {
      const candidate = surface.current;
      if (candidate?.phase === "running") {
        const previous = compactCurrentSessionId === undefined
          ? undefined
          : surface.sessions.find((session) => session.sessionId === compactCurrentSessionId && session.phase === "running");
        if (previous !== undefined && previous.sessionId !== candidate.sessionId &&
          compactCurrentUntil !== undefined && compactCurrentUntil > at) {
          surface = Object.freeze({
            ...surface,
            current: previous,
            sessions: Object.freeze([
              previous,
              ...surface.sessions.filter((session) => session.sessionId !== previous.sessionId)
            ])
          });
          compactDeadline = compactCurrentUntil;
        } else if (startDwell && compactCurrentSessionId !== candidate.sessionId) {
          compactCurrentSessionId = candidate.sessionId;
          compactCurrentUntil = at + NATIVE_TASK_STATUS_COMPACT_CURRENT_MIN_DWELL_MS;
        }
      } else if (startDwell) {
        compactCurrentSessionId = candidate?.sessionId;
        compactCurrentUntil = undefined;
      }
    }
    return {
      surface,
      ...(terminalDeadline === undefined ? {} : { terminalDeadline }),
      ...(smartDeadline === undefined ? {} : { smartDeadline }),
      ...(compactDeadline === undefined ? {} : { compactDeadline })
    };
  };

  const syncTerminalTimer = (deadline: number | undefined): void => {
    if (deadline === undefined) {
      cancelTerminalTimer();
      return;
    }
    if (terminalTimerArmed && terminalTimerAt === deadline) return;
    cancelTerminalTimer();
    terminalTimerAt = deadline;
    terminalTimerArmed = true;
    terminalTimer = setTimer(() => {
      terminalTimer = undefined;
      terminalTimerAt = undefined;
      terminalTimerArmed = false;
      render();
    }, Math.max(0, deadline - now()));
  };

  const syncSmartTimer = (deadline: number | undefined): void => {
    if (deadline === undefined) {
      cancelSmartTimer();
      return;
    }
    if (smartTimerArmed && smartTimerAt === deadline) return;
    cancelSmartTimer();
    smartTimerAt = deadline;
    smartTimerArmed = true;
    smartTimer = setTimer(() => {
      smartTimer = undefined;
      smartTimerAt = undefined;
      smartTimerArmed = false;
      render();
    }, Math.max(0, deadline - now()));
  };

  const syncCompactTimer = (deadline: number | undefined): void => {
    if (deadline === undefined) {
      cancelCompactTimer();
      return;
    }
    if (compactTimerArmed && compactTimerAt === deadline) return;
    cancelCompactTimer();
    compactTimerAt = deadline;
    compactTimerArmed = true;
    compactTimer = setTimer(() => {
      compactTimer = undefined;
      compactTimerAt = undefined;
      compactTimerArmed = false;
      render();
    }, Math.max(0, deadline - now()));
  };

  const syncPointerTimer = (): void => {
    if (options.getCursorPoint === undefined || disposed || hosted.size === 0 || settings?.enabled !== true) {
      cancelPointerTimer();
      return;
    }
    if (pointerTimerArmed) return;
    pointerTimerArmed = true;
    pointerTimer = setTimer(() => {
      pointerTimer = undefined;
      pointerTimerArmed = false;
      trackPointer();
    }, TASK_STATUS_POINTER_POLL_MS);
  };

  const trackPointer = (): void => {
    if (disposed || options.getCursorPoint === undefined || hosted.size === 0) {
      cancelPointerTimer();
      return;
    }
    const at = now();
    const point = options.getCursorPoint();
    const hovered = [...hosted.values()].find((entry) => pointInsideBounds(point, entry.bounds));
    const surface = currentSurface().surface;
    const wasPointerInside = hoveredDisplayId !== undefined;
    if (hovered !== undefined) {
      pointerLeftSince = undefined;
      if (waitForPointerExit) {
        hoveredDisplayId = undefined;
        hoveredSince = undefined;
      } else if (manualExpandedDisplayId !== undefined) {
        hoveredDisplayId = hovered.displayId;
        hoveredSince = undefined;
        if (manualExpandedDisplayId !== hovered.displayId) {
          manualExpandedDisplayId = hovered.displayId;
          manualExpandedAt = at;
          render();
          return;
        }
      } else if (surface?.policy === "peek" && at >= hoverCooldownUntil) {
        if (hoveredDisplayId !== hovered.displayId || hoveredSince === undefined) {
          hoveredDisplayId = hovered.displayId;
          hoveredSince = at;
        } else if (at - hoveredSince >= NATIVE_TASK_STATUS_HOVER_INTENT_MS) {
          manualExpandedDisplayId = hovered.displayId;
          manualExpandedAt = at;
          hoveredSince = undefined;
          render();
          return;
        }
      } else {
        hoveredDisplayId = hovered.displayId;
        hoveredSince = undefined;
      }
    } else {
      hoveredDisplayId = undefined;
      hoveredSince = undefined;
      waitForPointerExit = false;
      if (wasPointerInside) hoverCooldownUntil = at + NATIVE_TASK_STATUS_HOVER_COOLDOWN_MS;
      if (manualExpandedDisplayId !== undefined) {
        pointerLeftSince ??= at;
        const collapseAt = Math.max(
          pointerLeftSince + NATIVE_TASK_STATUS_POINTER_LEAVE_GRACE_MS,
          (manualExpandedAt ?? at) + NATIVE_TASK_STATUS_EXPANDED_MIN_DWELL_MS
        );
        if (at >= collapseAt) {
          manualExpandedDisplayId = undefined;
          manualExpandedAt = undefined;
          pointerLeftSince = undefined;
          render();
          return;
        }
      } else {
        pointerLeftSince = undefined;
      }
    }
    syncPointerTimer();
  };

  const destroyWindows = (): void => {
    cancelPointerTimer();
    for (const entry of hosted.values()) {
      if (!entry.window.isDestroyed()) entry.window.destroy();
    }
    hosted.clear();
    hoveredDisplayId = undefined;
    hoveredSince = undefined;
    pointerLeftSince = undefined;
    hoverCooldownUntil = 0;
    waitForPointerExit = false;
    manualExpandedAt = undefined;
  };

  const handleNavigation = (displayId: number, rawUrl: string): void => {
    if (disposed || snapshot === undefined || !rawUrl.startsWith(ACTION_SCHEME)) return;
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return;
    }
    if (url.protocol !== ACTION_SCHEME) return;
    if (url.hostname === "toggle") {
      const surface = surfaceForDisplay(currentSurface().surface, manualExpandedDisplayId, displayId);
      if (surface === undefined || surface.mode === "closed") return;
      if (surface.policy === "manual") {
        manualExpandedDisplayId = undefined;
        manualExpandedAt = undefined;
        hoverCooldownUntil = now() + NATIVE_TASK_STATUS_HOVER_COOLDOWN_MS;
        waitForPointerExit = true;
      } else {
        manualExpandedDisplayId = displayId;
        manualExpandedAt = now();
      }
      playConfiguredSound("select");
      render();
      return;
    }
    if (url.hostname === "settings") {
      playConfiguredSound("select");
      options.onOpenSettings();
      return;
    }
    if (url.hostname === "new-task") {
      playConfiguredSound("select");
      options.onNewTask();
      return;
    }
    if (url.hostname === "toggle-sounds") {
      playConfiguredSound("select");
      void Promise.resolve(options.onToggleSounds()).catch(() => undefined);
      return;
    }
    const sessionId = url.searchParams.get("sessionId");
    if (sessionId === null) return;
    const session = snapshot.sessions.find((candidate) => candidate.sessionId === sessionId);
    if (session === undefined) return;
    if (url.hostname === "focus") {
      playConfiguredSound("select");
      options.onAction({ kind: "focus", sessionId });
      return;
    }
    if (url.hostname !== "permission" || session.permission === undefined) return;
    const interactionId = url.searchParams.get("interactionId");
    const generation = url.searchParams.get("generation");
    const decision = parseDecision(url.searchParams.get("decision"));
    if (interactionId !== session.permission.interactionId || generation !== session.permission.generation ||
      decision === undefined || !nativeTaskStatusPermissionDecisionAllowed(session, decision)) return;
    playConfiguredSound("select");
    options.onAction({ kind: "permission", sessionId, interactionId, generation, decision });
  };

  const handleWindowBoundsChanged = (
    entry: HostedWindow,
    next: NativeTaskStatusWindowBounds
  ): void => {
    if (disposed || entry.window.isDestroyed() || settings === undefined) return;
    if (sameWindowBounds(entry.bounds, next)) return;
    const surface = surfaceForDisplay(currentSurface().surface, manualExpandedDisplayId, entry.displayId);
    if (surface === undefined) return;
    const horizontalChanged = Math.round(next.x) !== entry.bounds.x || Math.round(next.width) !== entry.bounds.width;
    const normalized = normalizedWindowBounds(entry.display, next, surface, settings.layout);
    entry.bounds = normalized;
    entry.window.setBounds(normalized);
    if (!horizontalChanged) return;
    const existing = resolveDesktopNativeTaskStatusLayoutPreference(
      layoutPreferences,
      entry.display,
      entry.displayIndex
    );
    const preference = layoutPreferenceFromBounds(
      entry.display,
      entry.displayIndex,
      normalized,
      surface.mode,
      settings.layout,
      existing
    );
    layoutPreferences = Object.freeze(existing === undefined
      ? [...layoutPreferences, preference]
      : layoutPreferences.map((candidate) => candidate === existing ? preference : candidate));
    if (options.onLayoutPreference !== undefined) {
      void Promise.resolve(options.onLayoutPreference(preference)).catch(() => undefined);
    }
  };

  const render = (): void => {
    if (disposed || !options.supported || settings?.enabled !== true || snapshot === undefined) {
      cancelTerminalTimer();
      cancelSmartTimer();
      cancelCompactTimer();
      destroyWindows();
      return;
    }
    const allDisplays = options.getDisplays();
    const displays = selectedDisplays(allDisplays, settings.display);
    if (manualExpandedDisplayId !== undefined && !displays.some((display) => display.id === manualExpandedDisplayId)) {
      manualExpandedDisplayId = undefined;
      manualExpandedAt = undefined;
    }
    const resolved = currentSurface(true);
    const surface = resolved.surface;
    syncTerminalTimer(resolved.terminalDeadline);
    syncSmartTimer(resolved.smartDeadline);
    syncCompactTimer(resolved.compactDeadline);
    if (surface === undefined || surface.mode === "closed") {
      destroyWindows();
      return;
    }
    const selectedIds = new Set(displays.map((display) => display.id));
    for (const [displayId, entry] of hosted) {
      if (selectedIds.has(displayId)) continue;
      if (!entry.window.isDestroyed()) entry.window.destroy();
      hosted.delete(displayId);
    }
    for (const display of displays) {
      const displaySurface = surfaceForDisplay(surface, manualExpandedDisplayId, display.id);
      if (displaySurface === undefined) continue;
      const document = renderNativeTaskStatusDocument(displaySurface, settings, snapshot.locale);
      const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(document)}`;
      const displayIndex = Math.max(0, allDisplays.findIndex((candidate) => candidate.id === display.id));
      const preference = resolveDesktopNativeTaskStatusLayoutPreference(
        layoutPreferences,
        display,
        displayIndex
      );
      const bounds = windowBounds(display, displaySurface, settings.layout, preference);
      let entry = hosted.get(display.id);
      if (entry === undefined || entry.window.isDestroyed()) {
        const window = options.createWindow(bounds);
        entry = { displayId: display.id, display, displayIndex, window, bounds, renderToken: 0 };
        hosted.set(display.id, entry);
        window.onWillNavigate((url) => handleNavigation(display.id, url));
        const target = entry;
        window.onBoundsChanged((next) => handleWindowBoundsChanged(target, next));
        window.denyNewWindows();
        window.onClosed(() => {
          if (hosted.get(display.id)?.window === window) hosted.delete(display.id);
        });
      } else {
        entry.display = display;
        entry.displayIndex = displayIndex;
        entry.bounds = bounds;
        entry.window.setBounds(bounds);
      }
      entry.renderToken += 1;
      const renderToken = entry.renderToken;
      const target = entry;
      void entry.window.loadDocument(dataUrl).then(() => {
        if (!disposed && hosted.get(display.id) === target && target.renderToken === renderToken &&
          !target.window.isDestroyed()) target.window.showInactive();
      }).catch(() => undefined);
    }
    syncPointerTimer();
  };

  return Object.freeze({
    setSettings: (next: DesktopNativeTaskStatusSettings) => {
      settings = next;
      if (!next.enabled) {
        manualExpandedDisplayId = undefined;
        manualExpandedAt = undefined;
      }
      render();
    },
    setApplicationFocused: (focused: boolean) => {
      if (applicationFocused === focused) return;
      applicationFocused = focused;
      render();
    },
    publish: (next: DesktopNativeTaskStatusSnapshot) => {
      if (disposed || !options.supported || !isNewerNativeTaskStatusSnapshot(snapshot, next)) return;
      const previous = snapshot;
      if (previous?.ownerId !== next.ownerId) {
        manualExpandedDisplayId = undefined;
        manualExpandedAt = undefined;
        smartSuppressions.clear();
        compactCurrentSessionId = undefined;
        compactCurrentUntil = undefined;
        terminalRevealUntil.clear();
        terminalObservedAt.clear();
      }
      const nextTerminalKeys = new Set(next.sessions
        .filter((session) => isTerminalPhase(session.phase))
        .map((session) => transientKey(session.sessionId, session.phase)));
      for (const key of terminalRevealUntil.keys()) if (!nextTerminalKeys.has(key)) terminalRevealUntil.delete(key);
      for (const key of terminalObservedAt.keys()) if (!nextTerminalKeys.has(key)) terminalObservedAt.delete(key);
      const observedAt = now();
      for (const key of nextTerminalKeys) if (!terminalObservedAt.has(key)) terminalObservedAt.set(key, observedAt);
      snapshot = next;
      if (observedSnapshot && settings?.enabled === true) {
        const event = highestSoundEvent(previous, next);
        if (event !== undefined) playConfiguredSound(event);
      }
      observedSnapshot = true;
      render();
    },
    refreshDisplays: render,
    refreshVisibility: render,
    surface: () => currentSurface().surface,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      cancelTerminalTimer();
      cancelSmartTimer();
      cancelCompactTimer();
      destroyWindows();
    }
  });
}

function surfaceForDisplay(
  surface: DesktopNativeTaskStatusSurface | undefined,
  expandedDisplayId: number | undefined,
  displayId: number
): DesktopNativeTaskStatusSurface | undefined {
  if (surface === undefined || surface.policy !== "manual" || expandedDisplayId === undefined ||
    expandedDisplayId === displayId) return surface;
  return Object.freeze({ ...surface, mode: "compact", policy: "peek" });
}

export function renderNativeTaskStatusDocument(
  surface: DesktopNativeTaskStatusSurface,
  settings: DesktopNativeTaskStatusSettings,
  locale: "en" | "zh-CN" | "en-XA"
): string {
  const strings = locale === "zh-CN" ? ZH_STRINGS : EN_STRINGS;
  const current = surface.current;
  const rowCandidates = surface.policy === "manual"
    ? surface.sessions
    : surface.policy === "transient"
      ? surface.sessions.filter((session) => isTerminalPhase(session.phase))
      : current === undefined ? [] : [current];
  const rows = rowCandidates.slice(0, MAXIMUM_VISIBLE_TASK_ROWS);
  const compactBody = current === undefined
    ? `<div class="compact-row compact-row--idle">
        <span class="phase-mark phase-mark--idle" aria-hidden="true"></span>
        <div class="idle-main"><strong>Joko</strong><span>${escapeHtml(strings.ready)}</span></div>
        ${countBadge(surface.counts.total, strings, true)}
        <a class="icon-action" href="${ACTION_SCHEME}//toggle" aria-label="${escapeAttribute(strings.expand)}" title="${escapeAttribute(strings.expand)}">${nativeIcon("chevron-down")}</a>
      </div>`
    : `<div class="compact-row">
        ${phaseMark(current.phase)}
        <a class="task-main" href="${focusUrl(current.sessionId)}"><strong>${escapeHtml(current.title || strings.untitled)}</strong><span>${escapeHtml(phaseLabel(current.phase, strings, current.interactionKind))}</span></a>
        ${countBadge(surface.counts.total, strings)}
        <a class="icon-action" href="${ACTION_SCHEME}//toggle" aria-label="${escapeAttribute(strings.expand)}" title="${escapeAttribute(strings.expand)}">${nativeIcon("chevron-down")}</a>
      </div>`;
  const soundLabel = settings.sounds.enabled ? strings.mute : strings.unmute;
  const soundIcon = nativeIcon(settings.sounds.enabled ? "volume" : "volume-off");
  const emptyState = surface.sessions.length === 0
    ? `<div class="empty-state"><strong>${escapeHtml(strings.readyForTask)}</strong><p>${escapeHtml(strings.noTasks)}</p><a class="new-task-action" href="${ACTION_SCHEME}//new-task">${escapeHtml(strings.newTask)}</a></div>`
    : "";
  const toggleLabel = surface.policy === "blocking" || surface.policy === "transient"
    ? strings.showAll
    : strings.collapse;
  const toggleIcon = surface.policy === "blocking" || surface.policy === "transient"
    ? nativeIcon("list")
    : nativeIcon("chevron-up");
  const expandedBody = `<div class="expanded-shell">
      <header><div><strong>${escapeHtml(strings.heading)}</strong><span>${escapeHtml(strings.taskCount(surface.counts.total))}</span></div><nav><a href="${ACTION_SCHEME}//toggle-sounds" aria-label="${escapeAttribute(soundLabel)}" title="${escapeAttribute(soundLabel)}">${soundIcon}</a><a href="${ACTION_SCHEME}//settings" aria-label="${escapeAttribute(strings.settings)}" title="${escapeAttribute(strings.settings)}">${nativeIcon("settings")}</a><a href="${ACTION_SCHEME}//toggle" aria-label="${escapeAttribute(toggleLabel)}" title="${escapeAttribute(toggleLabel)}">${toggleIcon}</a></nav></header>
      ${emptyState || `<div class="task-list">${rows.map((session) => renderSessionRow(session, strings)).join("")}</div>`}
      ${rowCandidates.length > rows.length ? `<div class="more">${escapeHtml(strings.more(rowCandidates.length - rows.length))}</div>` : ""}
    </div>`;
  const body = surface.mode === "compact" ? compactBody : expandedBody;
  const density = settings.layout === "compact" ? " density-compact" : "";
  return `<!doctype html><html lang="${locale === "zh-CN" ? "zh-CN" : "en"}"><head>
    <meta charset="utf-8"><meta name="color-scheme" content="light dark">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; media-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>${NATIVE_TASK_STATUS_CSS}</style></head>
    <body><main class="status-surface${density}" role="status" aria-live="polite">${body}</main></body></html>`;
}

type NativeTaskStatusIcon = "chevron-down" | "chevron-up" | "list" | "settings" | "volume" | "volume-off";

const NATIVE_TASK_STATUS_ICON_PATHS: Readonly<Record<NativeTaskStatusIcon, string>> = Object.freeze({
  "chevron-down": `<path d="m6 9 6 6 6-6"/>`,
  "chevron-up": `<path d="m18 15-6-6-6 6"/>`,
  list: `<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>`,
  settings: `<path d="M20 7h-9M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>`,
  volume: `<path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/>`,
  "volume-off": `<path d="M11 5 6 9H2v6h4l5 4V5ZM22 9l-6 6M16 9l6 6"/>`
});

function nativeIcon(icon: NativeTaskStatusIcon): string {
  return `<svg class="native-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${NATIVE_TASK_STATUS_ICON_PATHS[icon]}</svg>`;
}

function renderSessionRow(session: DesktopNativeTaskStatusSurface["sessions"][number], strings: NativeStrings): string {
  const permission = session.permission;
  const actions = permission === undefined ? "" : `<div class="permission-actions">
    ${permission.deny ? actionLink(session, "deny", strings.deny, "danger") : ""}
    ${permission.allow ? actionLink(session, "allow", strings.allow, "secondary") : ""}
    ${permission.allowForSession ? actionLink(session, "allowForSession", strings.allowForSession, "primary") : ""}
  </div>`;
  const activity = session.activityLines.length === 0 ? "" : `<ol class="activity-lines" aria-label="${escapeAttribute(strings.recentActivity)}">${session.activityLines.map((line) =>
    `<li class="activity-line activity-line--${line.kind}"><span aria-hidden="true"></span><p>${escapeHtml(line.text)}</p></li>`).join("")}</ol>`;
  return `<article class="task-row task-row--${session.phase}">
    <div class="task-status">${phaseMark(session.phase)}<span>${escapeHtml(phaseLabel(session.phase, strings, session.interactionKind))}</span></div>
    <a class="task-copy" href="${focusUrl(session.sessionId)}"><strong>${escapeHtml(session.title || strings.untitled)}</strong>${session.detail ? `<p>${escapeHtml(session.detail)}</p>` : ""}</a>
    <a class="focus-action" href="${focusUrl(session.sessionId)}">${escapeHtml(strings.focus)}</a>
    ${activity}
    ${actions}
  </article>`;
}

function actionLink(
  session: DesktopNativeTaskStatusSurface["sessions"][number],
  decision: DesktopNativeTaskStatusDecision,
  label: string,
  tone: "danger" | "secondary" | "primary"
): string {
  const permission = session.permission;
  if (permission === undefined) return "";
  const parameters = new URLSearchParams({
    sessionId: session.sessionId,
    interactionId: permission.interactionId,
    generation: permission.generation,
    decision
  });
  return `<a class="decision decision--${tone}" href="${ACTION_SCHEME}//permission?${parameters.toString()}">${escapeHtml(label)}</a>`;
}

export function selectedDisplays(
  displays: readonly DesktopNativeTaskStatusDisplay[],
  target: DesktopNativeTaskStatusSettings["display"]
): readonly DesktopNativeTaskStatusDisplay[] {
  if (displays.length === 0) return [];
  if (target.mode === "all") return displays;
  const exact = displays.find((display) => display.id === target.displayId);
  if (exact !== undefined) return [exact];
  if (target.displayName !== undefined) {
    const named = displays.filter((display) => display.name === target.displayName);
    if (named.length === 1) return named;
    if (target.displayBounds !== undefined) {
      const namedAtBounds = named.find((display) => sameDisplayBounds(display.bounds, target.displayBounds!));
      if (namedAtBounds !== undefined) return [namedAtBounds];
    }
  }
  if (target.displayBounds !== undefined) {
    const atBounds = displays.find((display) => sameDisplayBounds(display.bounds, target.displayBounds!));
    if (atBounds !== undefined) return [atBounds];
  }
  if (target.displayIndex !== undefined && displays[target.displayIndex] !== undefined) {
    return [displays[target.displayIndex]!];
  }
  return [displays.find((display) => display.primary) ?? displays[0]!];
}

function sameDisplayBounds(
  left: DesktopNativeTaskStatusDisplay["bounds"],
  right: DesktopNativeTaskStatusDisplay["bounds"]
): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

function windowBounds(
  display: DesktopNativeTaskStatusDisplay,
  surface: DesktopNativeTaskStatusSurface,
  layout: DesktopNativeTaskStatusSettings["layout"],
  preference?: DesktopNativeTaskStatusLayoutPreference
): NativeTaskStatusWindowBounds {
  const defaultWidth = defaultNativeTaskStatusWidth(layout);
  const maximumWidth = Math.max(1, Math.min(MAXIMUM_TASK_STATUS_WIDTH,
    display.bounds.width - TASK_STATUS_SCREEN_EDGE_GUTTER * 2));
  const minimumWidth = Math.min(maximumWidth, surface.mode === "expanded"
    ? defaultWidth
    : MINIMUM_TASK_STATUS_WIDTH);
  const preferredWidth = surface.mode === "expanded"
    ? preference?.expandedWidth
    : preference?.compactWidth;
  const width = clampInteger(preferredWidth ?? defaultWidth, minimumWidth, maximumWidth);
  const centerXRatio = preference?.centerXRatio ?? 0.5;
  const desiredCenterX = display.bounds.x + display.bounds.width * centerXRatio;
  const x = clampInteger(
    Math.round(desiredCenterX - width / 2),
    display.bounds.x + TASK_STATUS_SCREEN_EDGE_GUTTER,
    display.bounds.x + display.bounds.width - TASK_STATUS_SCREEN_EDGE_GUTTER - width
  );
  return Object.freeze({
    x,
    y: display.bounds.y + 6,
    width,
    height: nativeTaskStatusHeight(display, surface, layout)
  });
}

function normalizedWindowBounds(
  display: DesktopNativeTaskStatusDisplay,
  candidate: NativeTaskStatusWindowBounds,
  surface: DesktopNativeTaskStatusSurface,
  layout: DesktopNativeTaskStatusSettings["layout"]
): NativeTaskStatusWindowBounds {
  const defaultWidth = layout === "compact" ? 340 : 420;
  const maximumWidth = Math.max(1, Math.min(MAXIMUM_TASK_STATUS_WIDTH,
    display.bounds.width - TASK_STATUS_SCREEN_EDGE_GUTTER * 2));
  const minimumWidth = Math.min(maximumWidth, surface.mode === "expanded"
    ? defaultWidth
    : MINIMUM_TASK_STATUS_WIDTH);
  const width = clampInteger(candidate.width, minimumWidth, maximumWidth);
  const desiredCenter = Number.isFinite(candidate.x) && Number.isFinite(candidate.width)
    ? candidate.x + candidate.width / 2
    : display.bounds.x + display.bounds.width / 2;
  const x = clampInteger(
    Math.round(desiredCenter - width / 2),
    display.bounds.x + TASK_STATUS_SCREEN_EDGE_GUTTER,
    display.bounds.x + display.bounds.width - TASK_STATUS_SCREEN_EDGE_GUTTER - width
  );
  return Object.freeze({
    x,
    y: display.bounds.y + 6,
    width,
    height: nativeTaskStatusHeight(display, surface, layout)
  });
}

function nativeTaskStatusHeight(
  display: DesktopNativeTaskStatusDisplay,
  surface: DesktopNativeTaskStatusSurface,
  layout: DesktopNativeTaskStatusSettings["layout"]
): number {
  if (surface.mode === "compact") return 46;
  const visibleRows = Math.min(
    surface.policy === "manual"
      ? surface.sessions.length
      : surface.policy === "transient"
        ? surface.sessions.filter((session) => isTerminalPhase(session.phase)).length
        : surface.current === undefined ? 0 : 1,
    MAXIMUM_VISIBLE_TASK_ROWS
  );
  const desired = visibleRows === 0
    ? layout === "compact" ? 190 : 210
    : 72 + visibleRows * (layout === "compact" ? 118 : 148);
  return Math.max(46, Math.min(display.bounds.height - 24, desired));
}

function layoutPreferenceFromBounds(
  display: DesktopNativeTaskStatusDisplay,
  displayIndex: number,
  bounds: NativeTaskStatusWindowBounds,
  mode: DesktopNativeTaskStatusSurface["mode"],
  layout: DesktopNativeTaskStatusSettings["layout"],
  existing?: DesktopNativeTaskStatusLayoutPreference
): DesktopNativeTaskStatusLayoutPreference {
  const centerXRatio = Math.min(1, Math.max(0,
    (bounds.x + bounds.width / 2 - display.bounds.x) / display.bounds.width
  ));
  return Object.freeze({
    displayId: display.id,
    displayName: display.name,
    displayIndex,
    displayBounds: Object.freeze({ ...display.bounds }),
    centerXRatio,
    compactWidth: mode === "compact"
      ? bounds.width
      : existing?.compactWidth ?? defaultNativeTaskStatusWidth(layout),
    expandedWidth: mode === "expanded"
      ? bounds.width
      : existing?.expandedWidth ?? defaultNativeTaskStatusWidth(layout)
  });
}

function defaultNativeTaskStatusWidth(layout: DesktopNativeTaskStatusSettings["layout"]): number {
  return layout === "compact" ? 340 : 420;
}

function sameWindowBounds(left: NativeTaskStatusWindowBounds, right: NativeTaskStatusWindowBounds): boolean {
  return left.x === Math.round(right.x) && left.y === Math.round(right.y) &&
    left.width === Math.round(right.width) && left.height === Math.round(right.height);
}

function pointInsideBounds(point: NativeTaskStatusPoint, bounds: NativeTaskStatusWindowBounds): boolean {
  return point.x >= bounds.x && point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y && point.y <= bounds.y + bounds.height;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  const finite = Number.isFinite(value) ? Math.round(value) : minimum;
  return Math.min(maximum, Math.max(minimum, finite));
}

function highestSoundEvent(
  previous: DesktopNativeTaskStatusSnapshot | undefined,
  next: DesktopNativeTaskStatusSnapshot
): Exclude<DesktopNativeTaskStatusSoundEvent, "select"> | undefined {
  if (previous === undefined || previous.ownerId !== next.ownerId) return undefined;
  const phases = new Map(previous.sessions.map((session) => [session.sessionId, session.phase]));
  const changed = next.sessions
    .filter((session) => phases.get(session.sessionId) !== session.phase)
    .map((session) => session.phase);
  if (changed.includes("interaction")) return "attention";
  if (changed.includes("error")) return "error";
  if (changed.includes("completed")) return "complete";
  if (changed.includes("running")) return "start";
  return undefined;
}

function soundCooldown(event: DesktopNativeTaskStatusSoundEvent): number {
  if (event === "select") return 200;
  if (event === "start") return 800;
  return 1_500;
}

function parseDecision(value: string | null): DesktopNativeTaskStatusDecision | undefined {
  return value === "allow" || value === "allowForSession" || value === "deny" ? value : undefined;
}

function transientKey(sessionId: string, phase: DesktopNativeTaskStatusPhase): string {
  return `${sessionId}\u0000${phase}`;
}

function smartSuppressionIdentity(
  ownerId: string,
  session: DesktopNativeTaskStatusSnapshot["sessions"][number]
): string {
  return `${ownerId}\u0000${session.sessionId}\u0000${session.interactionKind ?? "interaction"}\u0000${session.updatedAt}`;
}

function terminalDwell(phase: DesktopNativeTaskStatusPhase): number {
  return phase === "error"
    ? NATIVE_TASK_STATUS_ERROR_DWELL_MS
    : NATIVE_TASK_STATUS_COMPLETION_DWELL_MS;
}

function isTerminalPhase(phase: DesktopNativeTaskStatusPhase): boolean {
  return phase === "completed" || phase === "error";
}

function focusUrl(sessionId: string): string {
  return `${ACTION_SCHEME}//focus?${new URLSearchParams({ sessionId }).toString()}`;
}

function phaseMark(phase: DesktopNativeTaskStatusPhase): string {
  return `<span class="phase-mark phase-mark--${phase}" aria-hidden="true"></span>`;
}

function countBadge(count: number, strings: NativeStrings, force = false): string {
  return count > (force ? 0 : 1)
    ? `<span class="count" aria-label="${escapeAttribute(strings.taskCount(count))}">${count}</span>`
    : "";
}

interface NativeStrings {
  readonly heading: string;
  readonly running: string;
  readonly interaction: string;
  readonly completed: string;
  readonly error: string;
  readonly focus: string;
  readonly allow: string;
  readonly allowForSession: string;
  readonly deny: string;
  readonly expand: string;
  readonly collapse: string;
  readonly showAll: string;
  readonly settings: string;
  readonly mute: string;
  readonly unmute: string;
  readonly ready: string;
  readonly readyForTask: string;
  readonly noTasks: string;
  readonly newTask: string;
  readonly untitled: string;
  readonly recentActivity: string;
  readonly awaitingPermission: string;
  readonly awaitingQuestion: string;
  readonly awaitingPlan: string;
  readonly taskCount: (count: number) => string;
  readonly more: (count: number) => string;
}

const EN_STRINGS: NativeStrings = Object.freeze({
  heading: "Task status",
  running: "Running",
  interaction: "Needs input",
  completed: "Completed",
  error: "Needs attention",
  focus: "Open",
  allow: "Allow",
  allowForSession: "Allow for task",
  deny: "Deny",
  expand: "Expand task status",
  collapse: "Collapse task status",
  showAll: "Show all tasks",
  settings: "Open task-status settings",
  mute: "Mute task-status sounds",
  unmute: "Turn on task-status sounds",
  ready: "Ready",
  readyForTask: "Ready for a new task",
  noTasks: "Running tasks and requests that need your attention will appear here.",
  newTask: "New task",
  untitled: "Untitled task",
  recentActivity: "Recent activity",
  awaitingPermission: "Awaiting permission",
  awaitingQuestion: "Awaiting your reply",
  awaitingPlan: "Awaiting plan review",
  taskCount: (count: number) => `${count} ${count === 1 ? "task" : "tasks"}`,
  more: (count: number) => `${count} more`
});

const ZH_STRINGS: NativeStrings = Object.freeze({
  heading: "任务状态",
  running: "正在运行",
  interaction: "需要输入",
  completed: "已完成",
  error: "需要关注",
  focus: "打开",
  allow: "允许",
  allowForSession: "本任务允许",
  deny: "拒绝",
  expand: "展开任务状态",
  collapse: "收起任务状态",
  showAll: "显示所有任务",
  settings: "打开任务状态设置",
  mute: "关闭任务状态声音",
  unmute: "开启任务状态声音",
  ready: "就绪",
  readyForTask: "可以开始新任务",
  noTasks: "运行中的任务和需要你处理的请求会显示在这里。",
  newTask: "新建任务",
  untitled: "未命名任务",
  recentActivity: "最近活动",
  awaitingPermission: "等待权限确认",
  awaitingQuestion: "等待你的回复",
  awaitingPlan: "等待计划审核",
  taskCount: (count: number) => `${count} 个任务`,
  more: (count: number) => `还有 ${count} 个`
});

function phaseLabel(
  phase: DesktopNativeTaskStatusPhase,
  strings: NativeStrings,
  interactionKind?: DesktopNativeTaskStatusSurface["sessions"][number]["interactionKind"]
): string {
  if (phase === "running") return strings.running;
  if (phase === "interaction") {
    if (interactionKind === "permission") return strings.awaitingPermission;
    if (interactionKind === "plan") return strings.awaitingPlan;
    if (interactionKind !== undefined) return strings.awaitingQuestion;
    return strings.interaction;
  }
  if (phase === "completed") return strings.completed;
  return strings.error;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]!);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

const NATIVE_TASK_STATUS_CSS = `
  :root { color-scheme:light dark; --surface:rgb(250 250 250 / .94); --raised:rgb(255 255 255 / .88); --surface-hover:rgb(228 228 228 / .9); --text:#0d0d0d; --muted:#5f5f5f; --line:rgb(216 216 216 / .9); --line-strong:rgb(189 189 189 / .92); --accent:#ff9800; --accent-edge:#c66e00; --accent-hover:#e68900; --accent-strong:#985100; --accent-soft:#fff1dc; --accent-ink:#17120a; --green:#197451; --amber:#925800; --red:#b33a32; --red-soft:#f9e4e1; --blue:#2f668f; --shadow:0 1px 2px rgb(0 0 0 / .07),0 12px 30px rgb(0 0 0 / .18); font-family:"Inter Variable",Inter,-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei UI","Segoe UI",sans-serif; font-synthesis:none; }
  @media (prefers-color-scheme:dark) { :root { --surface:rgb(21 21 21 / .94); --raised:rgb(32 32 32 / .9); --surface-hover:rgb(44 44 44 / .94); --text:#f2f2f2; --muted:#b8b8b8; --line:rgb(51 51 51 / .94); --line-strong:rgb(77 77 77 / .96); --accent-edge:#ff9800; --accent-hover:#ffad2e; --accent-strong:#ffb13b; --accent-soft:#35220a; --green:#69c49f; --amber:#f4b84f; --red:#f0847d; --red-soft:#422321; --blue:#79a8d3; --shadow:0 1px 2px rgb(0 0 0 / .25),0 14px 34px rgb(0 0 0 / .42); } }
  * { box-sizing:border-box; }
  html, body { margin:0; padding:0; width:100%; height:100%; overflow:hidden; background:transparent; color:var(--text); -webkit-font-smoothing:antialiased; }
  a { color:inherit; text-decoration:none; -webkit-app-region:no-drag; }
  a:focus-visible { outline:2px solid var(--accent-edge); outline-offset:2px; }
  ::selection { background:color-mix(in srgb,var(--accent) 28%,transparent); }
  .status-surface { width:100%; height:100%; overflow:hidden; border:1px solid var(--line); border-radius:18px; background:var(--surface); box-shadow:var(--shadow); backdrop-filter:blur(24px) saturate(1.2); }
  .compact-row { height:100%; display:flex; align-items:center; gap:10px; padding:7px 10px 7px 14px; -webkit-app-region:drag; user-select:none; }
  .idle-main { min-width:0; flex:1; display:flex; align-items:baseline; gap:8px; }
  .idle-main strong { font-size:13px; }
  .idle-main span { color:var(--muted); font-size:11px; }
  .task-main { min-width:0; flex:1; display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:10px; }
  .task-main strong, .task-copy strong { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-size:13px; }
  .task-main span, .expanded-shell header span, .task-status, .more { color:var(--muted); font-size:11px; }
  .count { min-width:21px; height:21px; display:grid; place-items:center; border-radius:999px; background:var(--raised); border:1px solid var(--line); font-size:11px; font-weight:650; }
  .icon-action, .expanded-shell nav a { width:28px; height:28px; display:grid; place-items:center; border:1px solid var(--line); border-radius:8px; background:var(--raised); color:var(--muted); transition:background .15s,border-color .15s,color .15s,transform .15s; }
  .icon-action:hover, .expanded-shell nav a:hover { border-color:var(--line-strong); background:var(--surface-hover); color:var(--text); }
  .icon-action:active, .expanded-shell nav a:active { transform:scale(.96); }
  .native-icon { width:15px; height:15px; display:block; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
  .expanded-shell { height:100%; display:flex; flex-direction:column; padding:12px; gap:10px; }
  .expanded-shell header { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:0 2px; -webkit-app-region:drag; user-select:none; }
  .expanded-shell header > div { min-width:0; display:flex; align-items:baseline; gap:8px; }
  .expanded-shell header strong { font-size:14px; }
  .expanded-shell nav { display:flex; gap:6px; }
  .task-list { min-height:0; overflow:auto; display:flex; flex-direction:column; gap:7px; }
  .empty-state { min-height:0; flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:7px; border:1px solid var(--line); border-radius:12px; padding:14px; background:var(--raised); text-align:center; }
  .empty-state strong { font-size:13px; }
  .empty-state p { max-width:300px; margin:0; color:var(--muted); font-size:11px; line-height:1.4; }
  .new-task-action { margin-top:2px; border:1px solid var(--accent); border-radius:999px; padding:7px 12px; background:var(--accent); color:var(--accent-ink); font-size:11px; font-weight:700; transition:background .15s,border-color .15s,transform .15s; }
  .new-task-action:hover { border-color:var(--accent-hover); background:var(--accent-hover); }
  .new-task-action:active { transform:scale(.98); }
  .task-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:7px 10px; padding:10px; border:1px solid var(--line); border-radius:12px; background:var(--raised); }
  .task-status { grid-column:1 / -1; display:flex; align-items:center; gap:7px; }
  .task-copy { min-width:0; display:block; }
  .task-copy p { margin:3px 0 0; color:var(--muted); font-size:11px; line-height:1.35; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; }
  .activity-lines { grid-column:1 / -1; min-width:0; display:grid; gap:4px; margin:0; padding:6px 0 0; border-top:1px solid var(--line); list-style:none; }
  .activity-line { min-width:0; display:grid; grid-template-columns:6px minmax(0,1fr); align-items:center; gap:7px; }
  .activity-line > span { width:5px; height:5px; border-radius:999px; background:var(--muted); }
  .activity-line--user > span { background:var(--accent); }
  .activity-line--assistant > span { background:var(--green); }
  .activity-line--tool > span { background:var(--amber); }
  .activity-line p { min-width:0; overflow:hidden; margin:0; color:var(--muted); font-size:10px; text-overflow:ellipsis; white-space:nowrap; }
  .focus-action { align-self:start; padding:5px 8px; border:1px solid var(--line); border-radius:999px; background:transparent; font-size:11px; transition:background .15s,border-color .15s,transform .15s; }
  .focus-action:hover { border-color:var(--line-strong); background:var(--surface-hover); }
  .focus-action:active { transform:scale(.98); }
  .permission-actions { grid-column:1 / -1; display:flex; justify-content:flex-end; gap:6px; padding-top:2px; }
  .decision { padding:6px 9px; border:1px solid var(--line); border-radius:999px; font-size:11px; font-weight:650; transition:background .15s,border-color .15s,transform .15s; }
  .decision:hover { border-color:var(--line-strong); background:var(--surface-hover); }
  .decision:active { transform:scale(.98); }
  .decision--primary { border-color:var(--accent); background:var(--accent); color:var(--accent-ink); }
  .decision--primary:hover { border-color:var(--accent-hover); background:var(--accent-hover); }
  .decision--secondary { background:var(--raised); }
  .decision--danger { color:var(--red); }
  .decision--danger:hover { background:var(--red-soft); }
  .phase-mark { width:8px; height:8px; flex:0 0 auto; border-radius:999px; background:var(--muted); }
  .phase-mark--idle { background:var(--green); box-shadow:0 0 0 3px color-mix(in srgb,var(--green) 14%,transparent); }
  .phase-mark--running { background:var(--blue); box-shadow:0 0 0 3px color-mix(in srgb,var(--blue) 18%,transparent); }
  .phase-mark--interaction { background:var(--amber); }
  .phase-mark--completed { background:var(--green); }
  .phase-mark--error { background:var(--red); }
  .more { text-align:center; }
  .density-compact .expanded-shell { padding:9px; gap:7px; }
  .density-compact .task-row { padding:7px 9px; gap:5px 8px; }
  @media (prefers-reduced-motion:reduce) { .icon-action, .expanded-shell nav a, .new-task-action, .focus-action, .decision { transition:none; } }
  @media (prefers-reduced-transparency:reduce) { .status-surface { backdrop-filter:none; background:var(--surface); } }
  @media (prefers-contrast:more) { .status-surface, .task-row, .empty-state, .icon-action, .expanded-shell nav a { border-color:var(--line-strong); } }
`;
