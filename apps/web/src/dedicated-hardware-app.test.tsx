// @vitest-environment jsdom
import { act, useCallback, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DedicatedHardwareRendererInput,
  createDedicatedHardwareTaskCatalog,
  useDedicatedHardwareTaskCatalogPublisher,
  type DedicatedHardwareRendererHandlers
} from "./dedicated-hardware-app.js";
import { createDefaultDedicatedHardwareSettings, DEDICATED_HARDWARE_MODELS,
  type DedicatedHardwareBridge, type DedicatedHardwareTaskCatalog } from "./dedicated-hardware.js";
import { useAppInputCommandOwner, useAppInputComposerOwner, useAppInputTimelineOwner } from "./app-input-owners.js";
import type { InteractionView, SessionView } from "./model.js";

const roots: Root[] = [];

function delivery(event: unknown, focusRequestId: string | null = null): unknown {
  return { version: 1, event, focusRequestId };
}

function voicePress(
  activationId = "1",
  ownerActivationId = activationId,
  activationKind: "start" | "toggle-finish" = "start"
): unknown {
  return delivery({
    kind: "button", phase: "press", action: { kind: "voice" },
    activationId, ownerActivationId, activationKind, releaseKind: null
  });
}

function voiceRelease(
  activationId = "1",
  ownerActivationId = activationId,
  activationKind: "start" | "toggle-finish" = "start",
  releaseKind: "tap" | "hold" | "cancel" = "tap"
): unknown {
  return delivery(releaseKind === "cancel"
    ? {
      kind: "button", phase: "cancel", action: { kind: "voice" },
      activationId, ownerActivationId, activationKind, releaseKind
    }
    : {
      kind: "button", phase: "release", action: { kind: "voice" },
      activationId, ownerActivationId, activationKind, releaseKind
    });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  document.body.replaceChildren();
  document.body.className = "";
});

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
  document.body.className = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function InputOwners({ insertText, insertSkill, keyInput, voice, scroll }: {
  readonly insertText: (text: string) => boolean;
  readonly insertSkill: (skill: { readonly serverId: string; readonly resourceId: string; readonly name: string }) => boolean;
  readonly keyInput?: (key: "ArrowUp" | "ArrowDown" | "Enter") => boolean;
  readonly voice?: Parameters<typeof useAppInputComposerOwner>[2]["voice"];
  readonly scroll: (deltaY: number) => void;
}) {
  const [composer, setComposer] = useState<HTMLDivElement>();
  const bindComposer = useCallback((node: HTMLDivElement | null) => setComposer(node ?? undefined), []);
  const timeline = useRef<HTMLDivElement>(null);
  useAppInputComposerOwner(composer, "task-one:1", {
    focus: () => true,
    insertText,
    insertSkill,
    ...(keyInput === undefined ? {} : { key: keyInput }),
    ...(voice === undefined ? {} : { voice })
  });
  useAppInputTimelineOwner(timeline, "task-one:1", scroll);
  return <main className="session-pane" data-input-session-id="task-one">
    <div ref={bindComposer}><button type="button">Composer</button></div>
    <div ref={timeline} />
  </main>;
}

function InteractionOwner({ approve }: { readonly approve: () => void }) {
  const [owner, setOwner] = useState<HTMLDivElement>();
  const bindOwner = useCallback((node: HTMLDivElement | null) => setOwner(node ?? undefined), []);
  useAppInputCommandOwner(owner, "interaction:1", "interaction", { approve });
  return <div role="dialog" aria-modal="true"><button type="button">Dialog focus</button><div ref={bindOwner} /></div>;
}

async function mount(children: React.ReactNode): Promise<Root> {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host); roots.push(root);
  await act(async () => root.render(children));
  return root;
}

describe("dedicated hardware renderer input", () => {
  it("routes only fixed composer keys through the current owner and retires delivery on pagehide", async () => {
    const keyInput = vi.fn(() => true);
    await mount(<InputOwners insertText={() => true} insertSkill={() => true} keyInput={keyInput} scroll={() => undefined} />);
    document.querySelector<HTMLButtonElement>("button")!.focus();
    const command = vi.fn(() => false);
    const input = new DedicatedHardwareRendererInput(document, { command, task: () => false, fixedLink: () => false });
    for (const key of ["ArrowUp", "ArrowDown", "Enter"] as const) {
      expect(input.handle(delivery({ kind: "button", phase: "press", action: { kind: "composer-key", key } }))).toBe(true);
    }
    expect(keyInput.mock.calls).toEqual([["ArrowUp"], ["ArrowDown"], ["Enter"]]);
    expect(command).not.toHaveBeenCalled();
    expect(input.handle(delivery({ kind: "button", phase: "press", action: { kind: "composer-key", key: "A" } }))).toBe(false);
    window.dispatchEvent(new Event("pagehide"));
    expect(input.handle(delivery({ kind: "button", phase: "press", action: { kind: "composer-key", key: "ArrowUp" } }))).toBe(false);
    expect(keyInput).toHaveBeenCalledTimes(3);
    input.dispose();
  });

  it("strictly parses payloads and routes text, exact skills, fixed links, and tasks through current owners", async () => {
    const text = vi.fn(() => true);
    const skill = vi.fn(() => true);
    const task = vi.fn(() => true);
    const fixedLink = vi.fn(() => true);
    await mount(<InputOwners insertText={text} insertSkill={skill} scroll={() => undefined} />);
    document.querySelector<HTMLButtonElement>("button")!.focus();
    const input = new DedicatedHardwareRendererInput(document, {
      command: () => false,
      task,
      fixedLink
    });

    const focused = document.querySelector<HTMLButtonElement>("button")!;
    const activated = vi.fn();
    const escaped = vi.fn();
    focused.addEventListener("click", activated);
    focused.addEventListener("keydown", (event) => { if (event.key === "Escape") escaped(); });
    expect(input.handle(delivery({ kind: "button", phase: "press", action: { kind: "command", command: "activate" } }))).toBe(true);
    expect(input.handle(delivery({ kind: "button", phase: "press", action: { kind: "command", command: "back" } }))).toBe(true);
    expect(activated).toHaveBeenCalledOnce();
    expect(escaped).toHaveBeenCalledOnce();

    expect(input.handle(delivery({ kind: "button", phase: "press", action: { kind: "composer-text", text: "Draft only" } }))).toBe(true);
    expect(text).toHaveBeenCalledExactlyOnceWith("Draft only");
    expect(input.handle(delivery({
      kind: "button", phase: "press",
      action: { kind: "skill", serverId: "server", resourceId: "skill", name: "Review" }
    }))).toBe(true);
    expect(skill).toHaveBeenCalledExactlyOnceWith({ serverId: "server", resourceId: "skill", name: "Review" });
    const taskAction = {
      kind: "task", profileId: "profile", serverId: "server", connectionGeneration: "1", snapshotRevision: "2",
      sessionId: "task-two", sessionGeneration: "3", targetId: "target-two", focusWindow: false
    } as const;
    expect(input.handle(delivery({ kind: "button", phase: "press", action: taskAction }))).toBe(true);
    expect(task).toHaveBeenCalledExactlyOnceWith({ task: taskAction, focusRequestId: null });
    expect(input.handle(delivery({ kind: "button", phase: "press", action: { kind: "fixed-link", linkId: "documentation" } }))).toBe(true);
    expect(fixedLink).toHaveBeenCalledExactlyOnceWith("documentation");

    expect(input.handle(delivery({ kind: "button", phase: "press", action: { kind: "composer-text", text: "No", extra: true } }))).toBe(false);
    expect(input.handle({ kind: "button", phase: "press", action: { kind: "command", command: "submit" } })).toBe(false);
    expect(text).toHaveBeenCalledOnce();
    input.dispose();
  });

  it("binds voice and continuous scroll to the press owner, then cancels them on release or retirement", async () => {
    let capture: object | undefined;
    const start = vi.fn(() => { capture = {}; return true; });
    const finish = vi.fn(async () => { capture = undefined; });
    const cancel = vi.fn(() => { capture = undefined; });
    const deltas: number[] = [];
    let frameId = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameId += 1; frames.set(frameId, callback); return frameId;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
    const root = await mount(<InputOwners insertText={() => true} insertSkill={() => true} scroll={(delta) => deltas.push(delta)} voice={{
      enabled: true,
      isActive: () => capture !== undefined,
      getCaptureIdentity: () => capture,
      start,
      finish,
      cancel
    }} />);
    document.querySelector<HTMLButtonElement>("button")!.focus();
    const input = new DedicatedHardwareRendererInput(document, handlers());

    expect(input.handle(voicePress())).toBe(true);
    const outside = document.body.appendChild(document.createElement("button")); outside.focus();
    expect(input.handle(voiceRelease())).toBe(true);
    expect(start).toHaveBeenCalledOnce();
    expect(finish).not.toHaveBeenCalled();

    expect(input.handle(voicePress("2", "1", "toggle-finish"))).toBe(true);
    expect(input.handle(voiceRelease("2", "1", "toggle-finish"))).toBe(true);
    await Promise.resolve();
    expect(finish).toHaveBeenCalledOnce();

    document.querySelector<HTMLButtonElement>("button")!.focus();
    expect(input.handle(delivery({ kind: "scroll", phase: "press", direction: "down", distance: 1 }))).toBe(true);
    vi.mocked(document.hasFocus).mockReturnValue(false);
    expect(input.handle(delivery({ kind: "scroll", phase: "move", direction: "up", distance: .75 }))).toBe(true);
    const tick = frames.values().next().value as FrameRequestCallback;
    outside.focus();
    tick(window.performance.now() + 16);
    expect(deltas.some((delta) => delta < 0)).toBe(true);
    expect(input.handle(delivery({ kind: "scroll", phase: "release" }))).toBe(true);

    vi.mocked(document.hasFocus).mockReturnValue(true);
    document.querySelector<HTMLButtonElement>("button")!.focus();
    expect(input.handle(voicePress("3"))).toBe(true);
    expect(input.handle(voiceRelease("3", "3", "start", "hold"))).toBe(true);
    await Promise.resolve();
    expect(finish).toHaveBeenCalledTimes(2);

    expect(input.handle(voicePress("4"))).toBe(true);
    input.dispose();
    expect(cancel).toHaveBeenCalledOnce();

    await act(async () => root.unmount());
    roots.splice(roots.indexOf(root), 1);
  });

  it("rejects raw, mismatched, and stale voice completions without releasing the captured owner", async () => {
    let capture: object | undefined;
    const start = vi.fn(() => { capture = {}; return true; });
    const finish = vi.fn(async () => { capture = undefined; });
    const cancel = vi.fn(() => { capture = undefined; });
    await mount(<InputOwners insertText={() => true} insertSkill={() => true} scroll={() => undefined} voice={{
      enabled: true,
      isActive: () => capture !== undefined,
      getCaptureIdentity: () => capture,
      start,
      finish,
      cancel
    }} />);
    document.querySelector<HTMLButtonElement>("button")!.focus();
    const input = new DedicatedHardwareRendererInput(document, handlers());

    expect(input.handle(delivery({ kind: "button", phase: "press", action: { kind: "voice" } }))).toBe(false);
    expect(input.handle(voicePress())).toBe(true);
    expect(input.handle(voiceRelease("2", "1"))).toBe(false);
    expect(finish).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(input.handle(voiceRelease())).toBe(true);
    expect(input.handle(voiceRelease("1", "1", "start", "hold"))).toBe(false);
    expect(input.handle(voiceRelease("1", "1", "start", "cancel"))).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    input.dispose();
  });

  it("fails closed while overlays, shortcut recording, or preview owns input", async () => {
    const fixedLink = vi.fn(() => true);
    await mount(<InputOwners insertText={() => true} insertSkill={() => true} scroll={() => undefined} />);
    const owner = document.querySelector<HTMLButtonElement>("button")!;
    owner.focus();
    const input = new DedicatedHardwareRendererInput(document, { ...handlers(), fixedLink });
    const event = delivery({ kind: "button", phase: "press", action: { kind: "fixed-link", linkId: "product-feedback" } });

    const dialog = document.body.appendChild(document.createElement("div"));
    dialog.setAttribute("role", "dialog");
    const dialogButton = dialog.appendChild(document.createElement("button"));
    dialogButton.focus();
    expect(input.handle(event)).toBe(false);
    dialog.remove(); owner.focus();
    document.body.dataset.appShortcutRecording = "1";
    expect(input.handle(event)).toBe(false);
    delete document.body.dataset.appShortcutRecording;
    const preview = document.body.appendChild(document.createElement("div"));
    preview.dataset.dedicatedHardwarePreview = "true";
    expect(input.handle(event)).toBe(false);
    expect(fixedLink).not.toHaveBeenCalled();
    input.dispose();
  });

  it("admits approve and reject through a focused dialog only to its exact interaction owner", async () => {
    const approve = vi.fn();
    await mount(<InteractionOwner approve={approve} />);
    document.body.classList.add("modal-open");
    const dialog = document.querySelector<HTMLElement>("[role='dialog']")!;
    dialog.querySelector<HTMLButtonElement>("button")!.focus();
    const input = new DedicatedHardwareRendererInput(document, handlers());

    expect(input.handle(delivery({ kind: "button", phase: "press", action: { kind: "command", command: "approve" } }))).toBe(true);
    expect(approve).toHaveBeenCalledOnce();
    expect(input.handle(delivery({ kind: "button", phase: "press", action: { kind: "command", command: "submit" } }))).toBe(false);

    const menu = dialog.appendChild(document.createElement("div"));
    menu.setAttribute("role", "menu");
    menu.tabIndex = 0;
    menu.focus();
    expect(input.handle(delivery({ kind: "button", phase: "press", action: { kind: "command", command: "approve" } }))).toBe(false);
    expect(approve).toHaveBeenCalledOnce();
    input.dispose();
  });

  it("allows only main-window task navigation commands to bypass hidden main-window focus", async () => {
    const command = vi.fn(() => true);
    const task = vi.fn(() => true);
    const fixedLink = vi.fn(() => true);
    await mount(<InputOwners insertText={() => true} insertSkill={() => true} scroll={() => undefined} />);
    vi.mocked(document.hasFocus).mockReturnValue(false);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    const input = new DedicatedHardwareRendererInput(document, { command, task, fixedLink });
    const taskAction = {
      kind: "task", profileId: "profile", serverId: "server", connectionGeneration: "1", snapshotRevision: "2",
      sessionId: "task", sessionGeneration: "3", targetId: "target", focusWindow: true
    } as const;
    expect(input.handle(delivery({ kind: "button", phase: "press", action: taskAction }, "1"))).toBe(true);
    expect(input.handle(delivery({ kind: "button", phase: "press", action: { kind: "command", command: "next-task" } }))).toBe(true);
    expect(input.handle(delivery({ kind: "button", phase: "press", action: { kind: "fixed-link", linkId: "documentation" } }))).toBe(false);
    expect(task).toHaveBeenCalledExactlyOnceWith({ task: taskAction, focusRequestId: "1" });
    expect(command).toHaveBeenCalledExactlyOnceWith("next-task");
    expect(fixedLink).not.toHaveBeenCalled();
    document.body.classList.add("modal-open");
    expect(input.handle(delivery({ kind: "button", phase: "press", action: taskAction }, "2"))).toBe(false);
    input.dispose();
  });

  it("stops a captured scroll owner when its component retires", async () => {
    let callback: FrameRequestCallback | undefined;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((next) => { callback = next; return 1; });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const root = await mount(<InputOwners insertText={() => true} insertSkill={() => true} scroll={() => undefined} />);
    document.querySelector<HTMLButtonElement>("button")!.focus();
    const input = new DedicatedHardwareRendererInput(document, handlers());
    expect(input.handle(delivery({ kind: "scroll", phase: "press", direction: "down", distance: .75 }))).toBe(true);
    await act(async () => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    callback?.(window.performance.now() + 16);
    expect(input.handle(delivery({ kind: "scroll", phase: "release" }))).toBe(false);
    input.dispose();
  });
});

describe("dedicated hardware task catalog", () => {
  it("publishes exact durable task fields, current priority, visible order, and the 100 item budget", () => {
    const sessions = Array.from({ length: 101 }, (_, index) => session(index));
    sessions[1] = { ...sessions[1]!, archived: true, pinned: true };
    const catalog = createDedicatedHardwareTaskCatalog({
      profileId: "profile",
      serverId: "server",
      connectionGeneration: 9n,
      snapshotRevision: 12n,
      sessions,
      interactions: [],
      sidebarSessionIds: [sessions[2]!.id, sessions[0]!.id],
      viewedSessionId: sessions[0]!.id
    });
    expect(catalog.tasks).toHaveLength(100);
    expect(catalog.tasks[0]).toMatchObject({
      sessionId: sessions[2]!.id,
      sessionGeneration: "3",
      targetId: "target-2",
      userSendAt: 2_000,
      sidebarOrder: 0,
      catalogEligible: true
    });
    expect(catalog.tasks.find((task) => task.sessionId === sessions[1]!.id)).toMatchObject({
      catalogEligible: false,
      priorityRank: null
    });
    expect(catalog.connectionGeneration).toBe("9");
    expect(catalog.snapshotRevision).toBe("12");
  });

  it("projects only current session state, exact generation interaction, and durable unread attention", () => {
    const waiting = { ...session(0), id: "waiting", state: "waiting" as const };
    const stale = { ...session(1), id: "stale" };
    const current = { ...session(2), id: "current" };
    const done = { ...session(3), id: "done", state: "idle" as const,
      attention: { kind: "done" as const, unread: true, subjectCursor: { opaqueToken: "subject", sequence: 1n, generation: 1n },
        attentionCursor: { opaqueToken: "attention", sequence: 2n, generation: 1n },
        readThroughCursor: { opaqueToken: "read", sequence: 0n, generation: 1n }, updatedAt: 4 } };
    const error = { ...session(4), id: "error", state: "error" as const };
    const archived = { ...session(5), id: "archived", archived: true, state: "running" as const };
    const projection = createDedicatedHardwareTaskCatalog({
      profileId: "profile", serverId: "server", connectionGeneration: 1n, snapshotRevision: 1n,
      sessions: [waiting, stale, current, done, error, archived], sidebarSessionIds: [],
      interactions: [interaction(stale.id, 99n), interaction(current.id, current.generation)]
    });
    const activity = Object.fromEntries(projection.tasks.map((task) => [task.sessionId, task.activity]));
    expect(activity).toEqual({
      waiting: { phase: "running", attention: false },
      stale: { phase: null, attention: false },
      current: { phase: "needs-interaction", attention: false },
      done: { phase: "completed", attention: true },
      error: { phase: "error", attention: false },
      archived: { phase: null, attention: false }
    });
  });

  it("debounces publication and clears the previous owner on switch and unmount", async () => {
    vi.useFakeTimers();
    const publish = vi.fn(async () => undefined);
    const bridge = bridgeWith(publish);
    const first = catalog("profile-one", "server-one", "task-one");
    const second = catalog("profile-two", "server-two", "task-two");
    const root = await mount(<Publisher bridge={bridge} catalog={first} />);
    await act(async () => { vi.advanceTimersByTime(80); await Promise.resolve(); });
    expect(publish).toHaveBeenCalledExactlyOnceWith(first);

    await act(async () => root.render(<Publisher bridge={bridge} catalog={second} />));
    expect(publish).toHaveBeenLastCalledWith({ ...first, tasks: [] });
    await act(async () => { vi.advanceTimersByTime(80); await Promise.resolve(); });
    expect(publish).toHaveBeenLastCalledWith(second);
    await act(async () => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    expect(publish).toHaveBeenLastCalledWith({ ...second, tasks: [] });
  });

  it("replays the current catalog after a valid controller state broadcast and stops on page retirement", async () => {
    vi.useFakeTimers();
    const publish = vi.fn<DedicatedHardwareBridge["publishDedicatedHardwareTasks"]>(async () => undefined);
    let stateChanged: ((value: unknown) => void) | undefined;
    const bridge = { ...bridgeWith(publish), onDedicatedHardwareStateChanged: (listener: (value: unknown) => void) => {
      stateChanged = listener; return () => { stateChanged = undefined; };
    } };
    const source = catalog("profile", "server", "task");
    await mount(<Publisher bridge={bridge} catalog={source} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(80); });
    expect(publish).toHaveBeenCalledTimes(1);
    const snapshot = { version: 1, models: Object.fromEntries(DEDICATED_HARDWARE_MODELS.map((model) => [model, {
      model, status: "disabled", reason: null, devicePresent: null, transport: null, firmwareVersion: null,
      batteryPercent: null, charging: null, inputPermission: "unknown", settingsError: null,
      keymap: model === "creator-micro-2" ? { phase: "idle", backupAvailable: false, failure: null } : null,
      settings: createDefaultDedicatedHardwareSettings(model),
      taskSlots: Array.from({ length: 6 }, (_, slot) => ({ slot, sessionId: null, title: null }))
    }])) };
    await act(async () => { stateChanged?.(snapshot); stateChanged?.(snapshot); await vi.advanceTimersByTimeAsync(80); });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith(source);
    await act(async () => { window.dispatchEvent(new Event("pagehide")); stateChanged?.(snapshot); await vi.advanceTimersByTimeAsync(80); });
    expect(publish).toHaveBeenLastCalledWith({ ...source, tasks: [] });
    expect(publish.mock.calls.filter(([value]) => value.tasks.length > 0)).toHaveLength(2);
  });
});

function Publisher({ bridge, catalog: value }: { readonly bridge: DedicatedHardwareBridge; readonly catalog: DedicatedHardwareTaskCatalog }) {
  useDedicatedHardwareTaskCatalogPublisher(bridge, value);
  return null;
}

function handlers(): DedicatedHardwareRendererHandlers {
  return { command: () => false, task: () => false, fixedLink: () => false };
}

function session(index: number): SessionView {
  return {
    id: `task-${index}`,
    backendId: "backend",
    targetId: `target-${index}`,
    name: `Task ${index}`,
    state: index % 3 === 0 ? "running" : "idle",
    pinned: false,
    archived: false,
    generation: BigInt(index + 1),
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    updatedAt: index * 100,
    lastUserInputAt: index * 1_000
  };
}

function catalog(profileId: string, serverId: string, sessionId: string): DedicatedHardwareTaskCatalog {
  return {
    version: 1,
    profileId,
    serverId,
    connectionGeneration: "1",
    snapshotRevision: "2",
    tasks: [{
      sessionId,
      sessionGeneration: "1",
      targetId: "target",
      title: "Task",
      pinned: false,
      userSendAt: 1,
      sidebarOrder: 0,
      catalogEligible: true,
      priorityRank: 1,
      activity: { phase: "running", attention: false }
    }]
  };
}

function interaction(sessionId: string, generation: bigint): InteractionView {
  return { id: `interaction-${sessionId}`, sessionId, generation, kind: "question", title: "Question", message: "",
    options: [], fields: [], planSteps: [], createdAt: 0 };
}

function bridgeWith(publishDedicatedHardwareTasks: DedicatedHardwareBridge["publishDedicatedHardwareTasks"]): DedicatedHardwareBridge {
  return {
    getDedicatedHardwareState: async () => undefined,
    setDedicatedHardwareSettings: async () => undefined,
    resetDedicatedHardwareSettings: async () => undefined,
    probeDedicatedHardware: async () => undefined,
    recoverDedicatedHardwareKeymap: async () => undefined,
    setDedicatedHardwarePreview: async () => undefined,
    publishDedicatedHardwareTasks,
    acknowledgeDedicatedHardwareTaskFocus: async () => false
  };
}
