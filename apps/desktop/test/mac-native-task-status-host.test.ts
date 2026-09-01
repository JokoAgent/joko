import { describe, expect, it } from "vitest";

import type { DesktopNativeTaskStatusAction } from "../src/channels.js";
import {
  createMacNativeTaskStatusHost,
  NATIVE_TASK_STATUS_COMPACT_CURRENT_MIN_DWELL_MS,
  NATIVE_TASK_STATUS_COMPLETION_DWELL_MS,
  NATIVE_TASK_STATUS_ERROR_DWELL_MS,
  NATIVE_TASK_STATUS_EXPANDED_MIN_DWELL_MS,
  NATIVE_TASK_STATUS_HOVER_INTENT_MS,
  NATIVE_TASK_STATUS_POINTER_LEAVE_GRACE_MS,
  NATIVE_TASK_STATUS_SMART_SUPPRESSION_DWELL_MS,
  NATIVE_TASK_STATUS_UNREAD_TERMINAL_TTL_MS,
  NATIVE_TASK_STATUS_WINDOW_INTERACTION,
  renderNativeTaskStatusDocument,
  selectedDisplays,
  type NativeTaskStatusWindow,
  type NativeTaskStatusWindowBounds
} from "../src/mac-native-task-status-host.js";
import {
  parseDesktopNativeTaskStatusSnapshot as parseNativeTaskStatusSnapshot,
  projectDesktopNativeTaskStatusSurface
} from "../src/native-task-status.js";

const SOUND_SETTINGS = {
  enabled: true,
  sounds: {
    start: { type: "builtin" as const, id: "startup-chime" as const },
    attention: { type: "builtin" as const, id: "secret-chime" as const },
    complete: { type: "builtin" as const, id: "gem-collect" as const },
    error: { type: "builtin" as const, id: "error-buzz" as const },
    select: { type: "builtin" as const, id: "none" as const }
  }
};

function parseDesktopNativeTaskStatusSnapshot(value: Record<string, unknown>) {
  return parseNativeTaskStatusSnapshot(value);
}

class FakeWindow implements NativeTaskStatusWindow {
  destroyed = false;
  bounds: NativeTaskStatusWindowBounds;
  documents: string[] = [];
  shown = 0;
  navigate?: (url: string) => void;
  closed?: () => void;
  boundsChanged?: (bounds: NativeTaskStatusWindowBounds) => void;

  constructor(bounds: NativeTaskStatusWindowBounds) { this.bounds = bounds; }
  isDestroyed = (): boolean => this.destroyed;
  setBounds = (bounds: NativeTaskStatusWindowBounds): void => { this.bounds = bounds; };
  loadDocument = async (dataUrl: string): Promise<void> => { this.documents.push(dataUrl); };
  showInactive = (): void => { this.shown += 1; };
  destroy = (): void => { this.destroyed = true; this.closed?.(); };
  onClosed = (listener: () => void): void => { this.closed = listener; };
  onWillNavigate = (listener: (url: string) => void): void => { this.navigate = listener; };
  onBoundsChanged = (listener: (bounds: NativeTaskStatusWindowBounds) => void): void => {
    this.boundsChanged = listener;
  };
  denyNewWindows = (): void => undefined;

  changeBounds(bounds: NativeTaskStatusWindowBounds): void {
    this.bounds = bounds;
    this.boundsChanged?.(bounds);
  }
}

class FakeClock {
  #at = 1_000;
  #sequence = 0;
  readonly #timers = new Map<number, { readonly at: number; readonly listener: () => void }>();

  now = (): number => this.#at;
  setTimer = (listener: () => void, delayMs: number): unknown => {
    const id = ++this.#sequence;
    this.#timers.set(id, { at: this.#at + delayMs, listener });
    return id;
  };
  clearTimer = (timer: unknown): void => {
    if (typeof timer === "number") this.#timers.delete(timer);
  };
  pending = (): number => this.#timers.size;
  advance(milliseconds: number): void {
    const target = this.#at + milliseconds;
    while (true) {
      const next = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (next === undefined) break;
      const [id, timer] = next;
      this.#timers.delete(id);
      this.#at = timer.at;
      timer.listener();
    }
    this.#at = target;
  }
}

describe("macOS native task-status host", () => {
  it("defines the ambient window as pointer-interactive but nonactivating", () => {
    expect(NATIVE_TASK_STATUS_WINDOW_INTERACTION).toMatchObject({
      resizable: true,
      movable: true,
      focusable: false,
      acceptFirstMouse: true
    });
  });

  it("renders selected displays and relays only snapshot-authorized, generation-fenced permission actions", () => {
    const windows: FakeWindow[] = [];
    const actions: DesktopNativeTaskStatusAction[] = [];
    let settingsOpens = 0;
    let newTasks = 0;
    let soundToggles = 0;
    const host = createMacNativeTaskStatusHost({
      supported: true,
      getDisplays: () => [
        { id: 1, name: "Primary", primary: true, bounds: { x: 0, y: 0, width: 1600, height: 900 } },
        { id: 2, name: "Second", primary: false, bounds: { x: 1600, y: 0, width: 1200, height: 800 } }
      ],
      createWindow: (bounds) => { const window = new FakeWindow(bounds); windows.push(window); return window; },
      onAction: (action) => actions.push(action),
      onNewTask: () => { newTasks += 1; },
      onOpenSettings: () => { settingsOpens += 1; },
      onToggleSounds: () => { soundToggles += 1; },
      playSound: () => undefined
    });
    host.setSettings({
      enabled: true,
      display: { mode: "display", displayId: 2 },
      layout: "normal",
      sounds: SOUND_SETTINGS
    });
    host.publish(parseDesktopNativeTaskStatusSnapshot({
      ownerId: "owner", revision: "3", locale: "en", sessions: [{
        sessionId: "task", title: "Permission", detail: "Review this command", phase: "interaction", interactionKind: "permission", activityLines: [{ id: "line", kind: "tool", text: "Run command" }], updatedAt: 2,
        permission: { interactionId: "request", generation: "8", allow: true, allowForSession: false, deny: true }
      }]
    }));
    expect(windows).toHaveLength(1);
    expect(windows[0]?.bounds.x).toBeGreaterThanOrEqual(1600);
    windows[0]?.navigate?.("joko-task-status://permission?sessionId=task&interactionId=request&generation=7&decision=allow");
    windows[0]?.navigate?.("joko-task-status://permission?sessionId=task&interactionId=request&generation=8&decision=allowForSession");
    expect(actions).toEqual([]);
    windows[0]?.navigate?.("joko-task-status://permission?sessionId=task&interactionId=request&generation=8&decision=allow");
    expect(actions).toEqual([{ kind: "permission", sessionId: "task", interactionId: "request", generation: "8", decision: "allow" }]);
    windows[0]?.navigate?.("joko-task-status://focus?sessionId=task");
    expect(actions.at(-1)).toEqual({ kind: "focus", sessionId: "task" });
    windows[0]?.navigate?.("joko-task-status://settings");
    expect(settingsOpens).toBe(1);
    windows[0]?.navigate?.("joko-task-status://new-task");
    windows[0]?.navigate?.("joko-task-status://toggle-sounds");
    expect(newTasks).toBe(1);
    expect(soundToggles).toBe(1);
  });

  it("creates no window on unsupported systems and escapes all task text in the Joko-owned document", () => {
    let creates = 0;
    const host = createMacNativeTaskStatusHost({
      supported: false,
      getDisplays: () => [{ id: 1, name: "Primary", primary: true, bounds: { x: 0, y: 0, width: 1000, height: 800 } }],
      createWindow: (bounds) => { creates += 1; return new FakeWindow(bounds); },
      onAction: () => undefined,
      onNewTask: () => undefined,
      onOpenSettings: () => undefined,
      onToggleSounds: () => undefined,
      playSound: () => undefined
    });
    host.setSettings({ enabled: true, display: { mode: "all" }, layout: "normal", sounds: SOUND_SETTINGS });
    const snapshot = parseDesktopNativeTaskStatusSnapshot({
      ownerId: "owner", revision: "1", locale: "en", sessions: [{
        sessionId: "task", title: "<script>alert(1)</script>", detail: "<img src=x>", phase: "interaction", activityLines: [{ id: "line", kind: "assistant", text: "<b>unsafe</b>" }], updatedAt: 1
      }]
    });
    host.publish(snapshot);
    expect(creates).toBe(0);
    const html = renderNativeTaskStatusDocument(projectDesktopNativeTaskStatusSurface(snapshot), {
      enabled: true, display: { mode: "all" }, layout: "normal", sounds: SOUND_SETTINGS
    }, "en");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).toContain("&lt;b&gt;unsafe&lt;/b&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("Content-Security-Policy");
  });

  it("labels each supported interaction kind with the matching waiting state", () => {
    const snapshot = parseDesktopNativeTaskStatusSnapshot({
      ownerId: "owner",
      revision: "4",
      locale: "en",
      sessions: [{
        sessionId: "plan",
        title: "Review plan",
        detail: "",
        phase: "interaction",
        interactionKind: "plan",
        activityLines: [],
        updatedAt: 4
      }]
    });
    const html = renderNativeTaskStatusDocument(projectDesktopNativeTaskStatusSurface(snapshot), {
      enabled: true, display: { mode: "all" }, layout: "normal", sounds: SOUND_SETTINGS
    }, "en");
    expect(html).toContain("Awaiting plan review");
  });

  it("remaps a persisted display identity when operating-system ids change", () => {
    const displays = [
      { id: 11, name: "Built-in", primary: true, bounds: { x: 0, y: 0, width: 1512, height: 982 } },
      { id: 19, name: "Studio", primary: false, bounds: { x: 1512, y: 0, width: 1920, height: 1080 } }
    ];
    expect(selectedDisplays(displays, {
      mode: "display",
      displayId: 2,
      displayName: "Studio",
      displayIndex: 1,
      displayBounds: { x: 1512, y: 0, width: 1920, height: 1080 }
    })).toEqual([displays[1]]);
    expect(selectedDisplays(displays, {
      mode: "display",
      displayId: 2,
      displayName: "Missing",
      displayIndex: 0
    })).toEqual([displays[0]]);
  });

  it("plays the configured transition and validated selection sounds", () => {
    const windows: FakeWindow[] = [];
    const played: unknown[] = [];
    const host = createMacNativeTaskStatusHost({
      supported: true,
      getDisplays: () => [{ id: 1, name: "Primary", primary: true, bounds: { x: 0, y: 0, width: 1200, height: 800 } }],
      createWindow: (bounds) => { const window = new FakeWindow(bounds); windows.push(window); return window; },
      onAction: () => undefined,
      onNewTask: () => undefined,
      onOpenSettings: () => undefined,
      onToggleSounds: () => undefined,
      playSound: (sound) => { played.push(sound); }
    });
    host.setSettings({
      enabled: true,
      display: { mode: "all" },
      layout: "normal",
      sounds: { ...SOUND_SETTINGS, sounds: { ...SOUND_SETTINGS.sounds, select: { type: "builtin", id: "item-found" } } }
    });
    host.publish(parseDesktopNativeTaskStatusSnapshot({ ownerId: "owner", revision: "1", locale: "en", sessions: [] }));
    host.publish(parseDesktopNativeTaskStatusSnapshot({
      ownerId: "owner", revision: "2", locale: "en",
      sessions: [{ sessionId: "task", title: "Task", detail: "", phase: "running", activityLines: [], updatedAt: 2 }]
    }));
    host.publish(parseDesktopNativeTaskStatusSnapshot({
      ownerId: "owner", revision: "3", locale: "en",
      sessions: [{ sessionId: "task", title: "Task", detail: "", phase: "interaction", activityLines: [], updatedAt: 3 }]
    }));
    windows[0]?.navigate?.("joko-task-status://focus?sessionId=task");
    expect(played).toEqual([
      { type: "builtin", id: "startup-chime" },
      { type: "builtin", id: "secret-chime" },
      { type: "builtin", id: "item-found" }
    ]);
  });

  it("reconciles windows immediately when the display topology changes", () => {
    const windows: FakeWindow[] = [];
    let displays = [{ id: 1, name: "Primary", primary: true, bounds: { x: 0, y: 0, width: 1200, height: 800 } }];
    const host = createMacNativeTaskStatusHost({
      supported: true,
      getDisplays: () => displays,
      createWindow: (bounds) => { const window = new FakeWindow(bounds); windows.push(window); return window; },
      onAction: () => undefined,
      onNewTask: () => undefined,
      onOpenSettings: () => undefined,
      onToggleSounds: () => undefined,
      playSound: () => undefined
    });
    host.setSettings({ enabled: true, display: { mode: "all" }, layout: "normal", sounds: SOUND_SETTINGS });
    host.publish(parseDesktopNativeTaskStatusSnapshot({
      ownerId: "owner", revision: "1", locale: "en",
      sessions: [{ sessionId: "task", title: "Task", detail: "", phase: "running", activityLines: [], updatedAt: 1 }]
    }));
    expect(windows).toHaveLength(1);
    displays = [
      displays[0]!,
      { id: 2, name: "Second", primary: false, bounds: { x: 1200, y: 0, width: 1000, height: 700 } }
    ];
    host.refreshDisplays();
    expect(windows).toHaveLength(2);
    displays = [displays[1]!];
    host.refreshDisplays();
    expect(windows[0]?.destroyed).toBe(true);
    expect(windows[1]?.destroyed).toBe(false);
  });

  it("keeps an idle surface available and exposes the real new-task action", () => {
    const windows: FakeWindow[] = [];
    let newTasks = 0;
    const host = createMacNativeTaskStatusHost({
      supported: true,
      getDisplays: () => [{ id: 1, name: "Primary", primary: true, bounds: { x: 0, y: 0, width: 1200, height: 800 } }],
      createWindow: (bounds) => { const window = new FakeWindow(bounds); windows.push(window); return window; },
      onAction: () => undefined,
      onNewTask: () => { newTasks += 1; },
      onOpenSettings: () => undefined,
      onToggleSounds: () => undefined,
      playSound: () => undefined
    });
    host.setSettings({ enabled: true, display: { mode: "all" }, layout: "normal", sounds: SOUND_SETTINGS });
    host.publish(parseDesktopNativeTaskStatusSnapshot({
      ownerId: "owner", revision: "1", locale: "en", sessions: []
    }));

    expect(windows).toHaveLength(1);
    expect(host.surface()).toMatchObject({ mode: "compact", policy: "peek", sessions: [] });
    windows[0]?.navigate?.("joko-task-status://toggle");
    expect(host.surface()).toMatchObject({ mode: "expanded", policy: "manual", sessions: [] });
    const document = decodeDataDocument(windows[0]?.documents.at(-1));
    expect(document).toContain("Ready for a new task");
    expect(document).toContain("joko-task-status://new-task");
    windows[0]?.navigate?.("joko-task-status://new-task");
    expect(newTasks).toBe(1);
  });

  it("uses hover intent and leave grace for deliberate ambient expansion", () => {
    const clock = new FakeClock();
    const windows: FakeWindow[] = [];
    let pointer = { x: -1, y: -1 };
    const host = createMacNativeTaskStatusHost({
      supported: true,
      getDisplays: () => [{ id: 1, name: "Primary", primary: true, bounds: { x: 0, y: 0, width: 1200, height: 800 } }],
      getCursorPoint: () => pointer,
      createWindow: (bounds) => { const window = new FakeWindow(bounds); windows.push(window); return window; },
      onAction: () => undefined,
      onNewTask: () => undefined,
      onOpenSettings: () => undefined,
      onToggleSounds: () => undefined,
      playSound: () => undefined,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    });
    host.setSettings({ enabled: true, display: { mode: "all" }, layout: "normal", sounds: SOUND_SETTINGS });
    host.publish(parseDesktopNativeTaskStatusSnapshot({
      ownerId: "owner", revision: "1", locale: "en", sessions: []
    }));
    pointer = { x: windows[0]!.bounds.x + 10, y: windows[0]!.bounds.y + 10 };
    clock.advance(NATIVE_TASK_STATUS_HOVER_INTENT_MS + 70);
    expect(host.surface()).toMatchObject({ mode: "expanded", policy: "manual" });

    pointer = { x: -1, y: -1 };
    clock.advance(NATIVE_TASK_STATUS_POINTER_LEAVE_GRACE_MS);
    expect(host.surface()).toMatchObject({ mode: "expanded", policy: "manual" });
    clock.advance(NATIVE_TASK_STATUS_EXPANDED_MIN_DWELL_MS);
    expect(host.surface()).toMatchObject({ mode: "compact", policy: "peek" });
    host.dispose();
    expect(clock.pending()).toBe(0);
  });

  it("expands only the hovered task-status window when all displays are enabled", () => {
    const clock = new FakeClock();
    const windows: FakeWindow[] = [];
    let pointer = { x: -1, y: -1 };
    const host = createMacNativeTaskStatusHost({
      supported: true,
      getDisplays: () => [
        { id: 1, name: "Primary", primary: true, bounds: { x: 0, y: 0, width: 1400, height: 900 } },
        { id: 2, name: "Studio", primary: false, bounds: { x: 1400, y: 0, width: 1200, height: 800 } }
      ],
      getCursorPoint: () => pointer,
      createWindow: (bounds) => { const window = new FakeWindow(bounds); windows.push(window); return window; },
      onAction: () => undefined,
      onNewTask: () => undefined,
      onOpenSettings: () => undefined,
      onToggleSounds: () => undefined,
      playSound: () => undefined,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    });
    host.setSettings({ enabled: true, display: { mode: "all" }, layout: "normal", sounds: SOUND_SETTINGS });
    host.publish(parseDesktopNativeTaskStatusSnapshot({
      ownerId: "owner", revision: "1", locale: "en", sessions: [{
        sessionId: "task", title: "Task", detail: "", phase: "running", activityLines: [], updatedAt: 1
      }]
    }));
    expect(windows.map((window) => window.bounds.height)).toEqual([46, 46]);

    pointer = { x: windows[1]!.bounds.x + 10, y: windows[1]!.bounds.y + 10 };
    clock.advance(NATIVE_TASK_STATUS_HOVER_INTENT_MS + 70);
    expect(windows.map((window) => window.bounds.height)).toEqual([46, 220]);
    expect(decodeDataDocument(windows[0]?.documents.at(-1))).toContain("compact-row");
    expect(decodeDataDocument(windows[1]?.documents.at(-1))).toContain("expanded-shell");

    pointer = { x: windows[0]!.bounds.x + 10, y: windows[0]!.bounds.y + 10 };
    clock.advance(50);
    expect(windows.map((window) => window.bounds.height)).toEqual([220, 46]);
    host.dispose();
  });

  it("restores and updates per-display horizontal placement and width", () => {
    const windows: FakeWindow[] = [];
    const saved: unknown[] = [];
    const display = { id: 11, name: "Studio", primary: true, bounds: { x: 0, y: 0, width: 1600, height: 900 } };
    const host = createMacNativeTaskStatusHost({
      supported: true,
      getDisplays: () => [display],
      getLayoutPreferences: () => [{
        displayId: 2,
        displayName: "Studio",
        displayIndex: 0,
        displayBounds: display.bounds,
        centerXRatio: 0.25,
        compactWidth: 500,
        expandedWidth: 700
      }],
      onLayoutPreference: (preference) => { saved.push(preference); },
      createWindow: (bounds) => { const window = new FakeWindow(bounds); windows.push(window); return window; },
      onAction: () => undefined,
      onNewTask: () => undefined,
      onOpenSettings: () => undefined,
      onToggleSounds: () => undefined,
      playSound: () => undefined
    });
    host.setSettings({ enabled: true, display: { mode: "all" }, layout: "normal", sounds: SOUND_SETTINGS });
    host.publish(parseDesktopNativeTaskStatusSnapshot({
      ownerId: "owner", revision: "1", locale: "en", sessions: [{
        sessionId: "task", title: "Task", detail: "", phase: "running", activityLines: [], updatedAt: 1
      }]
    }));
    expect(windows[0]?.bounds).toMatchObject({ x: 150, width: 500, y: 6, height: 46 });

    windows[0]?.changeBounds({ x: 300, y: 200, width: 600, height: 200 });
    expect(windows[0]?.bounds).toMatchObject({ x: 300, width: 600, y: 6, height: 46 });
    expect(saved).toEqual([expect.objectContaining({
      displayId: 11,
      displayName: "Studio",
      displayIndex: 0,
      centerXRatio: 0.375,
      compactWidth: 600,
      expandedWidth: 700
    })]);

    windows[0]?.navigate?.("joko-task-status://toggle");
    expect(windows[0]?.bounds).toMatchObject({ width: 700, height: 220 });
    windows[0]?.changeBounds({ x: 250, y: 200, width: 750, height: 300 });
    expect(saved.at(-1)).toEqual(expect.objectContaining({
      compactWidth: 600,
      expandedWidth: 750
    }));
  });

  it("reveals errors for twelve seconds and completions for eight while retaining unread terminal tasks", () => {
    const clock = new FakeClock();
    const host = createMacNativeTaskStatusHost({
      supported: true,
      getDisplays: () => [{ id: 1, name: "Primary", primary: true, bounds: { x: 0, y: 0, width: 1200, height: 800 } }],
      createWindow: (bounds) => new FakeWindow(bounds),
      onAction: () => undefined,
      onNewTask: () => undefined,
      onOpenSettings: () => undefined,
      onToggleSounds: () => undefined,
      playSound: () => undefined,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    });
    host.setSettings({ enabled: true, display: { mode: "all" }, layout: "normal", sounds: SOUND_SETTINGS });
    host.publish(parseDesktopNativeTaskStatusSnapshot({ ownerId: "owner", revision: "1", locale: "en", sessions: [] }));
    host.publish(parseDesktopNativeTaskStatusSnapshot({
      ownerId: "owner", revision: "2", locale: "en", sessions: [
        { sessionId: "error", title: "Error", detail: "", phase: "error", activityLines: [], updatedAt: 3 },
        { sessionId: "complete", title: "Complete", detail: "", phase: "completed", activityLines: [], updatedAt: 4 },
        { sessionId: "running", title: "Running", detail: "", phase: "running", activityLines: [], updatedAt: 2 }
      ]
    }));

    expect(host.surface()).toMatchObject({ policy: "transient", current: { sessionId: "error" } });
    expect(clock.pending()).toBe(1);
    clock.advance(NATIVE_TASK_STATUS_ERROR_DWELL_MS - 1);
    expect(host.surface()?.current?.sessionId).toBe("error");
    clock.advance(1);
    expect(host.surface()).toMatchObject({ policy: "transient", current: { sessionId: "complete" } });
    expect(clock.pending()).toBe(1);
    clock.advance(NATIVE_TASK_STATUS_COMPLETION_DWELL_MS);
    expect(host.surface()).toMatchObject({
      mode: "compact",
      policy: "peek",
      current: { sessionId: "error" },
      counts: { total: 3 }
    });
    expect(host.surface()?.sessions.map((session) => session.sessionId)).toEqual(["error", "complete", "running"]);
    expect(clock.pending()).toBe(1);
  });

  it("smart-suppresses every visible split interaction after five seconds and restores tasks on navigation", () => {
    const clock = new FakeClock();
    let visibleSessionIds: readonly string[] = ["ask", "plan"];
    const host = createMacNativeTaskStatusHost({
      supported: true,
      getDisplays: () => [{ id: 1, name: "Primary", primary: true, bounds: { x: 0, y: 0, width: 1200, height: 800 } }],
      createWindow: (bounds) => new FakeWindow(bounds),
      getVisibleSessionIds: () => visibleSessionIds,
      onAction: () => undefined,
      onNewTask: () => undefined,
      onOpenSettings: () => undefined,
      onToggleSounds: () => undefined,
      playSound: () => undefined,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    });
    host.setSettings({ enabled: true, display: { mode: "all" }, layout: "normal", sounds: SOUND_SETTINGS });
    host.setApplicationFocused(true);
    host.publish(parseDesktopNativeTaskStatusSnapshot({
      ownerId: "owner", revision: "1", locale: "en", sessions: [{
        sessionId: "ask", title: "Question", detail: "Choose an answer", phase: "interaction",
        interactionKind: "question", activityLines: [], updatedAt: 1
      }, {
        sessionId: "plan", title: "Plan", detail: "Review the plan", phase: "interaction",
        interactionKind: "plan", activityLines: [], updatedAt: 2
      }]
    }));

    expect(host.surface()).toMatchObject({ mode: "compact", policy: "blocking", counts: { total: 2 } });
    clock.advance(NATIVE_TASK_STATUS_SMART_SUPPRESSION_DWELL_MS - 1);
    expect(host.surface()?.counts.total).toBe(2);
    clock.advance(1);
    expect(host.surface()).toMatchObject({ mode: "compact", policy: "peek", counts: { total: 0 } });

    visibleSessionIds = ["plan"];
    host.refreshVisibility();
    host.publish(parseDesktopNativeTaskStatusSnapshot({
      ownerId: "owner", revision: "2", locale: "en", sessions: [{
        sessionId: "ask", title: "Question", detail: "Choose an answer", phase: "interaction",
        interactionKind: "question", activityLines: [], updatedAt: 1
      }, {
        sessionId: "plan", title: "Plan", detail: "Review the plan", phase: "interaction",
        interactionKind: "plan", activityLines: [], updatedAt: 2
      }]
    }));
    expect(host.surface()).toMatchObject({ mode: "expanded", policy: "blocking", counts: { total: 1 } });

    visibleSessionIds = ["ask"];
    host.publish(parseDesktopNativeTaskStatusSnapshot({
      ownerId: "owner", revision: "3", locale: "en", sessions: [{
        sessionId: "ask", title: "Permission", detail: "Review command", phase: "interaction",
        interactionKind: "permission", activityLines: [], updatedAt: 2,
        permission: { interactionId: "permission", generation: "1", allow: true, allowForSession: true, deny: true }
      }]
    }));
    expect(host.surface()).toMatchObject({ mode: "expanded", policy: "blocking", counts: { total: 1 } });
  });

  it("keeps the compact running task stable for the minimum dwell before switching", () => {
    const clock = new FakeClock();
    const host = createMacNativeTaskStatusHost({
      supported: true,
      getDisplays: () => [{ id: 1, name: "Primary", primary: true, bounds: { x: 0, y: 0, width: 1200, height: 800 } }],
      createWindow: (bounds) => new FakeWindow(bounds),
      onAction: () => undefined,
      onNewTask: () => undefined,
      onOpenSettings: () => undefined,
      onToggleSounds: () => undefined,
      playSound: () => undefined,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    });
    host.setSettings({ enabled: true, display: { mode: "all" }, layout: "normal", sounds: SOUND_SETTINGS });
    host.publish(parseDesktopNativeTaskStatusSnapshot({
      ownerId: "owner", revision: "1", locale: "en", sessions: [
        { sessionId: "first", title: "First", detail: "", phase: "running", activityLines: [], updatedAt: 1 }
      ]
    }));
    host.publish(parseDesktopNativeTaskStatusSnapshot({
      ownerId: "owner", revision: "2", locale: "en", sessions: [
        { sessionId: "first", title: "First", detail: "", phase: "running", activityLines: [], updatedAt: 1 },
        { sessionId: "second", title: "Second", detail: "", phase: "running", activityLines: [], updatedAt: 2 }
      ]
    }));

    expect(host.surface()?.current?.sessionId).toBe("first");
    clock.advance(NATIVE_TASK_STATUS_COMPACT_CURRENT_MIN_DWELL_MS - 1);
    expect(host.surface()?.current?.sessionId).toBe("first");
    clock.advance(1);
    expect(host.surface()?.current?.sessionId).toBe("second");
  });

  it("prunes terminal entries from the ambient list after the four-hour unread TTL", () => {
    const clock = new FakeClock();
    const host = createMacNativeTaskStatusHost({
      supported: true,
      getDisplays: () => [{ id: 1, name: "Primary", primary: true, bounds: { x: 0, y: 0, width: 1200, height: 800 } }],
      createWindow: (bounds) => new FakeWindow(bounds),
      onAction: () => undefined,
      onNewTask: () => undefined,
      onOpenSettings: () => undefined,
      onToggleSounds: () => undefined,
      playSound: () => undefined,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    });
    host.setSettings({ enabled: true, display: { mode: "all" }, layout: "normal", sounds: SOUND_SETTINGS });
    host.publish(parseDesktopNativeTaskStatusSnapshot({
      ownerId: "owner", revision: "1", locale: "en", sessions: [
        { sessionId: "error", title: "Error", detail: "", phase: "error", activityLines: [], updatedAt: 1 }
      ]
    }));
    clock.advance(NATIVE_TASK_STATUS_UNREAD_TERMINAL_TTL_MS - 1);
    expect(host.surface()?.counts.total).toBe(1);
    clock.advance(1);
    expect(host.surface()).toMatchObject({ mode: "compact", policy: "peek", counts: { total: 0 } });
  });

  it("lets a blocking interaction preempt terminal rotation and clears the resumed timer on dispose", () => {
    const clock = new FakeClock();
    const windows: FakeWindow[] = [];
    const host = createMacNativeTaskStatusHost({
      supported: true,
      getDisplays: () => [{ id: 1, name: "Primary", primary: true, bounds: { x: 0, y: 0, width: 1200, height: 800 } }],
      createWindow: (bounds) => { const window = new FakeWindow(bounds); windows.push(window); return window; },
      onAction: () => undefined,
      onNewTask: () => undefined,
      onOpenSettings: () => undefined,
      onToggleSounds: () => undefined,
      playSound: () => undefined,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    });
    host.setSettings({ enabled: true, display: { mode: "all" }, layout: "normal", sounds: SOUND_SETTINGS });
    host.publish(parseDesktopNativeTaskStatusSnapshot({
      ownerId: "owner", revision: "1", locale: "en", sessions: [
        { sessionId: "first", title: "First", detail: "", phase: "error", activityLines: [], updatedAt: 3 },
        { sessionId: "second", title: "Second", detail: "", phase: "completed", activityLines: [], updatedAt: 2 }
      ]
    }));
    clock.advance(1_000);
    host.publish(parseDesktopNativeTaskStatusSnapshot({
      ownerId: "owner", revision: "2", locale: "en", sessions: [
        { sessionId: "blocked", title: "Blocked", detail: "", phase: "interaction", interactionKind: "permission", activityLines: [], updatedAt: 4 },
        { sessionId: "first", title: "First", detail: "", phase: "error", activityLines: [], updatedAt: 3 },
        { sessionId: "second", title: "Second", detail: "", phase: "completed", activityLines: [], updatedAt: 2 }
      ]
    }));
    expect(host.surface()).toMatchObject({ policy: "blocking", current: { sessionId: "blocked" } });
    expect(clock.pending()).toBe(1);

    clock.advance(NATIVE_TASK_STATUS_ERROR_DWELL_MS);
    host.publish(parseDesktopNativeTaskStatusSnapshot({
      ownerId: "owner", revision: "3", locale: "en", sessions: [
        { sessionId: "first", title: "First", detail: "", phase: "error", activityLines: [], updatedAt: 3 },
        { sessionId: "second", title: "Second", detail: "", phase: "completed", activityLines: [], updatedAt: 2 }
      ]
    }));
    expect(host.surface()).toMatchObject({ policy: "transient", current: { sessionId: "second" } });
    expect(clock.pending()).toBe(1);

    host.dispose();
    expect(clock.pending()).toBe(0);
    expect(windows.every((window) => window.destroyed)).toBe(true);
  });
});

function decodeDataDocument(value: string | undefined): string {
  if (value === undefined) return "";
  return decodeURIComponent(value.slice(value.indexOf(",") + 1));
}
