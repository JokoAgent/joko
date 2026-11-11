// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppWithController, reserveMessageDeepLinkHistoryPage } from "./App.js";
import { useAppController, type AppController, type ControllerState } from "./controller.js";
import { DEFAULT_UI_PREFERENCES, LocalState } from "./local-state.js";
import { addSessionSplit, writeSessionSplitLayout } from "./session-split-layout.js";
import {
  emptySnapshot,
  type ScheduleRunHistoryView,
  type ScheduleView,
  type SessionAttentionView,
  type SessionView,
  type TimelineHistoryCursorView,
  type TimelineItemView
} from "./model.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
const renderedApps = new Set<() => Promise<void>>();
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  // This App boundary owns handoff and message traversal; provide a normal
  // occupied viewport so jsdom's zero dimensions do not request extra history.
  vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(1_200);
});

afterEach(async () => {
  for (const dispose of [...renderedApps]) await dispose();
  Reflect.deleteProperty(window, "jokoDesktop");
  window.location.hash = "";
  vi.restoreAllMocks();
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});

describe("Desktop system handoff App boundary", () => {
  it("renders explicit recovery when an ownerless linked task is unavailable", async () => {
    const fixture = renderApp(connectedState({ route: { kind: "session", sessionId: "missing-task" } }));
    await fixture.render();
    expect(fixture.container.textContent).toContain("This linked task is unavailable on the current machine.");
    expect(fixture.container.textContent).toContain("Joko will not guess a destination.");
    await fixture.dispose();
  });

  it("does not resolve an exact machine link against the previous machine snapshot during handoff", async () => {
    const sharedTask = session("shared-task");
    const loadSessionTimelinePage = vi.fn<AppController["loadSessionTimelinePage"]>(async () => ({ items: [] }));
    const route = {
      kind: "session",
      profileId: "profile-b",
      sessionId: sharedTask.id,
      messageId: "profile-b-message"
    } as const;
    const previousMachine = connectedState({ route, sessions: [sharedTask] });
    const fixture = renderApp(previousMachine, { loadSessionTimelinePage });

    await fixture.render();
    expect(fixture.container.textContent).toContain("Connecting to Joko");
    expect(fixture.container.textContent).not.toContain("The link did not identify another machine");
    expect(loadSessionTimelinePage).not.toHaveBeenCalled();

    const targetProfile = {
      id: "profile-b",
      deviceId: "device-b",
      serverId: "server-b",
      name: "Remote",
      origin: "https://remote.example"
    };
    await fixture.render({
      ...previousMachine,
      connectionState: "connecting",
      profiles: [...previousMachine.profiles, targetProfile],
      activeProfile: targetProfile
    });
    expect(fixture.container.textContent).toContain("Connecting to Joko");
    expect(fixture.container.textContent).not.toContain("The link did not identify another machine");
    expect(loadSessionTimelinePage).not.toHaveBeenCalled();
    await fixture.dispose();
  });

  it("renders exact-owner recovery when the linked task is missing after handoff", async () => {
    const fixture = renderApp({
      ...connectedState({
        route: { kind: "session", profileId: "profile-a", sessionId: "missing-task" },
        sessions: [session("another-task")]
      }),
      error: "This cached task no longer exists on the selected machine."
    });

    await fixture.render();
    expect(fixture.container.textContent).toContain("This linked task is unavailable on the current machine.");
    expect(fixture.container.textContent).toContain("This cached task no longer exists on the selected machine.");
    expect(fixture.container.textContent).not.toContain("Connecting to Joko");
    expect(fixture.container.textContent).not.toContain("The link did not identify another machine");
    await fixture.dispose();
  });

  it("does not reuse an around-message window from another machine with the same task id", async () => {
    const sharedTask = session("shared-task");
    const linkedMessage = timelineItem("shared-message");
    const loadSessionTimelineAround = vi.fn<AppController["loadSessionTimelineAround"]>()
      .mockResolvedValueOnce([linkedMessage])
      .mockResolvedValueOnce([]);
    const fixture = renderApp(connectedState({
      route: {
        kind: "session",
        profileId: "profile-a",
        sessionId: sharedTask.id,
        messageId: linkedMessage.id,
        messageEventId: "event-a"
      },
      sessions: [sharedTask]
    }), { loadSessionTimelineAround });

    await fixture.render();
    await act(async () => {
      await vi.waitFor(() => expect(loadSessionTimelineAround).toHaveBeenCalledTimes(1));
    });

    const targetProfile = {
      id: "profile-b",
      deviceId: "device-b",
      serverId: "server-b",
      name: "Remote",
      origin: "https://remote.example"
    };
    await fixture.render({
      ...connectedState({
        route: {
          kind: "session",
          profileId: targetProfile.id,
          sessionId: sharedTask.id,
          messageId: linkedMessage.id,
          messageEventId: "event-b"
        },
        sessions: [sharedTask]
      }),
      profiles: [targetProfile],
      activeProfile: targetProfile
    });
    await act(async () => {
      await vi.waitFor(() => expect(loadSessionTimelineAround).toHaveBeenCalledTimes(2));
    });
    expect(loadSessionTimelineAround).toHaveBeenLastCalledWith(sharedTask.id, "event-b", 160);
    await fixture.dispose();
  });

  it("keeps an adopted message link consumed after deletion and resolves a new opening separately", async () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("timeline") ? 600 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("timeline") ? 720 : 0;
    });
    const task = session("task-a");
    const linkedMessage = timelineItem("shared-message");
    const neighbor = { ...timelineItem("surviving-answer"), sequence: 2n };
    const loadSessionTimelineAround = vi.fn<AppController["loadSessionTimelineAround"]>()
      .mockResolvedValueOnce([linkedMessage])
      .mockResolvedValueOnce([]);
    const initial = connectedState({
      route: {
        kind: "session",
        profileId: "profile-a",
        sessionId: task.id,
        messageId: linkedMessage.id,
        messageEventId: "event-a"
      },
      sessions: [task]
    });
    const fixture = renderApp(initial, { loadSessionTimelineAround });

    await fixture.render();
    expect(loadSessionTimelineAround).toHaveBeenCalledOnce();
    expect(fixture.container.querySelector('[data-message-client-id="shared-message"]')?.closest(".timeline__row")
      ?.getAttribute("aria-current")).toBe("true");
    const afterDeletion = {
      ...initial,
      snapshot: {
        ...initial.snapshot,
        timelineHistoryRevisionBySession: new Map([[task.id, 1n]]),
        timelineBySession: new Map([[task.id, [neighbor]]])
      }
    };
    await fixture.render(afterDeletion);
    expect(loadSessionTimelineAround).toHaveBeenCalledOnce();
    expect(fixture.container.textContent).toContain(neighbor.text);
    expect(fixture.container.textContent).not.toContain(linkedMessage.text);
    expect(fixture.container.textContent).not.toContain("That message is no longer available in the task timeline.");

    await fixture.render({ ...afterDeletion, navigationRevision: 1 });
    expect(loadSessionTimelineAround).toHaveBeenCalledTimes(2);
    expect(loadSessionTimelineAround).toHaveBeenLastCalledWith(task.id, "event-a", 160);
    expect(fixture.container.textContent).toContain("That message is no longer available in the task timeline.");
    await fixture.dispose();
  });

  it("resolves an unconsumed message link against the new history revision", async () => {
    const task = session("task-a");
    const linkedMessage = timelineItem("shared-message");
    const original = deferred<readonly TimelineItemView[]>();
    const replacement = deferred<readonly TimelineItemView[]>();
    const loadSessionTimelineAround = vi.fn<AppController["loadSessionTimelineAround"]>()
      .mockReturnValueOnce(original.promise)
      .mockReturnValueOnce(replacement.promise);
    const initial = connectedState({
      route: { kind: "session", sessionId: task.id, messageId: linkedMessage.id, messageEventId: "event-a" },
      sessions: [task]
    });
    const fixture = renderApp(initial, { loadSessionTimelineAround });

    await fixture.render();
    expect(loadSessionTimelineAround).toHaveBeenCalledOnce();
    await fixture.render({
      ...initial,
      snapshot: { ...initial.snapshot, timelineHistoryRevisionBySession: new Map([[task.id, 1n]]) }
    });
    expect(loadSessionTimelineAround).toHaveBeenCalledTimes(2);

    await act(async () => original.resolve([linkedMessage]));
    expect(fixture.container.textContent).not.toContain(linkedMessage.text);
    expect(fixture.container.querySelector(".action-progress")).not.toBeNull();
    await act(async () => replacement.resolve([]));
    expect(fixture.container.textContent).toContain("That message is no longer available in the task timeline.");
    await fixture.dispose();
  });

  it.each(["original", "rebound"] as const)("scopes message deletion in a non-route split pane to the %s view", async (scope) => {
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(1_000);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("timeline") ? 600 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("timeline") ? 720 : 0;
    });
    const taskA = session("task-a");
    const taskB = { ...session("task-b"), generation: 8n };
    const messageA = { ...timelineItem("answer-a"), sourceEventId: "event-a" };
    const messageB = { ...timelineItem("answer-b"), sourceEventId: "event-b" };
    const initial = connectedState({ route: { kind: "session", sessionId: taskA.id }, sessions: [taskA, taskB] });
    const profile = { ...initial.activeProfile!, serverId: "message-delete-split-test" };
    const original = deferred<void>();
    const deleteSessionMessage = vi.fn<AppController["deleteSessionMessage"]>()
      .mockReturnValueOnce(original.promise)
      .mockResolvedValueOnce(undefined);
    const navigate = vi.fn();
    const state: ControllerState = {
      ...initial,
      profiles: [profile],
      activeProfile: profile,
      snapshot: {
        ...initial.snapshot,
        timelineBySession: new Map([[taskA.id, [messageA]], [taskB.id, [messageB]]]),
        backends: [{ id: taskB.backendId, name: "Pi", version: "1", health: "healthy",
          capabilities: new Map([["session.message_delete", { name: "session.message_delete", supported: true, options: [] }]]) }]
      }
    };
    window.location.hash = "#/tasks/task-a";
    writeSessionSplitLayout(profile.serverId, addSessionSplit({}, taskB.id, taskA.id, "right"));
    const fixture = renderApp(state, { deleteSessionMessage, navigate });
    const dialog = () => document.querySelector(".message-delete-dialog");
    const confirm = () => dialog()?.querySelector<HTMLButtonElement>("button.button--danger");
    const openB = async (): Promise<void> => {
      const pane = fixture.container.querySelector('[data-session-split-pane="task-b"]')!;
      const row = pane.querySelector('[data-message-client-id="answer-b"]')?.closest(".timeline__row");
      const more = row?.querySelector<HTMLElement>("summary");
      expect(more).toBeInstanceOf(HTMLElement);
      await act(async () => {
        more?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
        more?.click();
        row?.querySelector<HTMLButtonElement>('button[aria-label="Delete message"]')?.click();
      });
      expect(dialog()).not.toBeNull();
    };
    const clickConfirm = async (): Promise<void> => {
      const button = confirm();
      expect(button).toBeInstanceOf(HTMLButtonElement);
      await act(async () => { button?.click(); button?.click(); });
    };
    try {
      await fixture.render();
      expect(fixture.container.querySelector('[data-session-split-pane="task-a"]')).not.toBeNull();
      await openB();
      await clickConfirm();
      expect(deleteSessionMessage).toHaveBeenCalledExactlyOnceWith(taskB.id, "event-b", 8n);
      expect(dialog()?.getAttribute("aria-busy")).toBe("true");
      expect(navigate).not.toHaveBeenCalled();
      expect(window.location.hash).toBe("#/tasks/task-a");
      if (scope === "original") {
        await act(async () => original.resolve());
      } else {
        await fixture.render({ ...state, connectionGeneration: 2 });
        expect(dialog()).toBeNull();
        await openB();
        await act(async () => original.reject(new Error("Previous connection failed")));
        expect(dialog()?.querySelector("[role='alert']")).toBeNull();
        expect(dialog()?.getAttribute("aria-busy")).toBe("false");
        await clickConfirm();
        expect(deleteSessionMessage.mock.calls).toEqual([[taskB.id, "event-b", 8n], [taskB.id, "event-b", 8n]]);
      }
      expect(dialog()).toBeNull();
    } finally {
      await fixture.dispose();
      writeSessionSplitLayout(profile.serverId, {});
    }
  });

  it.each(["matching", "different"] as const)("only replaces the source split slot when the child has %s lineage", async (lineage) => {
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(1_000);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("timeline") ? 600 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("timeline") ? 720 : 0;
    });
    const taskA = session("task-a");
    const taskB = { ...session("task-b"), generation: 8n };
    const prompt = { ...timelineItem("prompt-b"), kind: "user" as const, sourceEventId: "event-b", nativeParentEntryId: "previous-native-entry" };
    const child: SessionView = {
      ...session("task-fork"),
      derivationOrigin: { kind: "fork", sourceSessionId: taskB.id, sourceMessageId: prompt.id,
        sourceEventId: lineage === "matching" ? "event-b" : "different-event", sourceSessionAvailable: true, sourceMessageAvailable: true }
    };
    const initial = connectedState({ route: { kind: "session", sessionId: taskA.id }, sessions: [taskA, taskB] });
    const profile = { ...initial.activeProfile!, serverId: "message-fork-split-test" };
    const branch = deferred<string>();
    const forkSession = vi.fn<AppController["forkSession"]>(() => branch.promise);
    const readDraftSnapshot = vi.fn<AppController["readDraftSnapshot"]>(async () => ({ revision: 0 }));
    const saveDraftIfRevision = vi.fn<AppController["saveDraftIfRevision"]>(async () => 1);
    const navigate = vi.fn();
    const state: ControllerState = {
      ...initial, profiles: [profile], activeProfile: profile,
      snapshot: {
        ...initial.snapshot,
        timelineBySession: new Map([[taskB.id, [prompt]]]),
        backends: [{ id: taskB.backendId, name: "Codex", version: "1", health: "healthy",
          capabilities: new Map([["session.fork", { name: "session.fork", supported: true, options: [] }]]) }]
      }
    };
    window.location.hash = "#/tasks/task-a";
    writeSessionSplitLayout(profile.serverId, addSessionSplit({}, taskB.id, taskA.id, "right"));
    const fixture = renderApp(state, { forkSession, readDraftSnapshot, saveDraftIfRevision, navigate });
    try {
      await fixture.render();
      const pane = (id: string) => fixture.container.querySelector(`[data-session-split-pane="${id}"]`);
      const fork = pane(taskB.id)?.querySelector<HTMLButtonElement>('button[aria-label="Fork from here"]');
      expect(fork).toBeInstanceOf(HTMLButtonElement);
      await act(async () => { fork?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); fork?.click(); });
      const confirm = fixture.container.querySelector<HTMLButtonElement>('[data-message-fork-confirm="true"]');
      expect(confirm).toBeInstanceOf(HTMLButtonElement);
      await act(async () => { confirm?.click(); confirm?.click(); });
      expect(forkSession).toHaveBeenCalledExactlyOnceWith(taskB.id, "previous-native-entry", expect.any(String), {
        messageId: prompt.id, eventId: "event-b", expectedGeneration: 8n
      });
      await act(async () => { pane(taskA.id)?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); });
      await act(async () => branch.resolve(child.id));
      expect(saveDraftIfRevision).toHaveBeenCalledExactlyOnceWith(child.id, expect.objectContaining({ text: "prompt-b" }), 0);
      expect(pane(taskB.id)).not.toBeNull();
      expect(navigate).not.toHaveBeenCalled();

      await fixture.render({ ...state, snapshot: { ...state.snapshot, sessions: [taskA, taskB, child] } });
      expect(pane(taskA.id)).not.toBeNull();
      if (lineage === "matching") {
        expect(navigate).toHaveBeenCalledExactlyOnceWith({ kind: "session", sessionId: child.id });
        expect(pane(taskB.id)).toBeNull();
        expect(pane(child.id)).not.toBeNull();
      } else {
        expect(navigate).not.toHaveBeenCalled();
        expect(pane(taskB.id)).not.toBeNull();
        expect(pane(child.id)).toBeNull();
      }
    } finally {
      await fixture.dispose();
      writeSessionSplitLayout(profile.serverId, {});
    }
  });

  it.each(["succeeds", "fails"])("keeps the first message location when the later around read %s", async (outcome) => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("timeline") ? 600 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("timeline") ? 720 : 0;
    });
    const task = session("task-a");
    const linkedMessage = timelineItem("linked-answer");
    const firstPage = deferred<Awaited<ReturnType<AppController["loadSessionTimelinePage"]>>>();
    const around = deferred<readonly TimelineItemView[] | Error>();
    const loadSessionTimelinePage = vi.fn<AppController["loadSessionTimelinePage"]>(() => firstPage.promise);
    const loadSessionTimelineAround = vi.fn<AppController["loadSessionTimelineAround"]>(async () => {
      const result = await around.promise;
      if (result instanceof Error) throw result;
      return result;
    });
    const fixture = renderApp(connectedState({
      route: { kind: "session", sessionId: task.id, messageId: linkedMessage.id, messageEventId: "event-a" },
      sessions: [task]
    }), { loadSessionTimelinePage, loadSessionTimelineAround });

    await fixture.render();
    expect(loadSessionTimelinePage).toHaveBeenCalledWith(task.id, undefined, 240);
    expect(loadSessionTimelineAround).toHaveBeenCalledWith(task.id, "event-a", 160);
    expect(fixture.container.querySelector(".action-progress")).not.toBeNull();

    await act(async () => firstPage.resolve({ items: [linkedMessage] }));
    const viewport = fixture.container.querySelector<HTMLDivElement>(".timeline")!;
    const row = viewport.querySelector('[data-message-client-id="linked-answer"]')?.closest<HTMLElement>(".timeline__row");
    expect(row?.getAttribute("aria-current")).toBe("true");
    expect(document.activeElement).toBe(row);
    expect(fixture.container.querySelector(".action-progress")).toBeNull();
    await act(async () => {
      viewport.focus();
      viewport.scrollTop = 200;
      viewport.dispatchEvent(new Event("scroll"));
    });
    const scrollTo = vi.mocked(viewport.scrollTo);
    scrollTo.mockClear();

    await act(async () => around.resolve(outcome === "succeeds" ? [linkedMessage] : new Error("Controlled late around failure")));
    expect(viewport.scrollTop).toBe(200);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(viewport);
    expect(fixture.container.textContent).not.toContain("Controlled late around failure");
    await fixture.dispose();
  });

  it("reuses history during navigation but reads the latest page after reconnecting with an unchanged Session descriptor", async () => {
    const task = session("task-a");
    const initial = connectedState({ route: { kind: "session", sessionId: task.id }, sessions: [task] });
    const loadSessionTimelinePage = vi.fn<AppController["loadSessionTimelinePage"]>()
      .mockResolvedValueOnce({ items: [timelineItem("earlier-answer")] })
      .mockResolvedValueOnce({ items: [{ ...timelineItem("offline-answer"), sequence: 2n }] });
    const fixture = renderApp(initial, { loadSessionTimelinePage });
    await fixture.render();
    expect(loadSessionTimelinePage).toHaveBeenCalledOnce();
    await fixture.render({ ...initial, route: { kind: "settings" } });
    await fixture.render();
    expect(loadSessionTimelinePage).toHaveBeenCalledOnce();

    await fixture.render({ ...initial, connectionState: "offline" });
    await fixture.render();
    expect(loadSessionTimelinePage).toHaveBeenCalledTimes(2);
    expect(loadSessionTimelinePage).toHaveBeenLastCalledWith(task.id, undefined, 240);
    await fixture.dispose();
  });

  it("keeps the cursor between a refreshed latest page and an exhausted older window", async () => {
    const task = session("task-a");
    const initial = connectedState({ route: { kind: "session", sessionId: task.id }, sessions: [task] });
    const earlier = timelineItem("earlier-answer");
    const middle = { ...timelineItem("middle-answer"), sequence: 2n };
    const latest = { ...timelineItem("latest-answer"), sequence: 3n };
    const loadSessionTimelinePage = vi.fn<AppController["loadSessionTimelinePage"]>()
      .mockResolvedValueOnce({ items: [earlier] })
      .mockResolvedValueOnce({ items: [latest], nextBeforeCursor: historyCursor(3n) })
      .mockResolvedValueOnce({ items: [earlier, middle] });
    const fixture = renderApp(initial, { loadSessionTimelinePage });
    await fixture.render();
    await fixture.render({ ...initial, connectionState: "offline" });
    await fixture.render({ ...initial, snapshot: { ...initial.snapshot, sessions: [{ ...task, updatedAt: 2 }] } });
    await act(async () => {
      fixture.container.querySelector(".timeline")!.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await act(async () => {
      [...fixture.container.querySelectorAll("button")].find(button => button.textContent === "Load earlier activity")?.click();
    });
    expect(loadSessionTimelinePage).toHaveBeenCalledTimes(3);
    expect(loadSessionTimelinePage).toHaveBeenLastCalledWith(task.id, historyCursor(3n), 240);
    await fixture.dispose();
  });

  it("reports a message-only link after authoritative history is exhausted", async () => {
    const task = session("task-a");
    const loadSessionTimelinePage = vi.fn(async () => ({ items: [] }));
    const fixture = renderApp(connectedState({
      route: { kind: "session", sessionId: task.id, messageId: "missing-message" },
      sessions: [task]
    }), { loadSessionTimelinePage });
    await fixture.render();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(loadSessionTimelinePage).toHaveBeenCalledOnce();
    expect(fixture.container.textContent).toContain("That message is no longer available in the task timeline.");
    await fixture.dispose();
  });

  it("fails a message-only history search stable and offers an explicit retry", async () => {
    const task = session("task-a");
    const loadSessionTimelinePage = vi.fn<AppController["loadSessionTimelinePage"]>(async (_sessionId, beforeCursor) => {
      if (beforeCursor === undefined) return { items: [], nextBeforeCursor: historyCursor(10n) };
      throw new Error("history unavailable");
    });
    const fixture = renderApp(connectedState({
      route: { kind: "session", sessionId: task.id, messageId: "missing-message" },
      sessions: [task]
    }), { loadSessionTimelinePage });

    await fixture.render();
    await act(async () => {
      await vi.waitFor(() => {
        expect(loadSessionTimelinePage).toHaveBeenCalledTimes(2);
        expect(fixture.container.textContent).toContain("Message search is unavailable.");
        expect(fixture.container.textContent).toContain("Retry");
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(loadSessionTimelinePage).toHaveBeenCalledTimes(2);
    const retry = [...fixture.container.querySelectorAll("button")]
      .find((button) => button.textContent === "Retry");
    expect(retry).toBeDefined();
    await act(async () => { retry?.click(); });
    await act(async () => {
      await vi.waitFor(() => expect(loadSessionTimelinePage).toHaveBeenCalledTimes(3));
    });
    expect(loadSessionTimelinePage).toHaveBeenLastCalledWith(task.id, historyCursor(10n), 240);
    expect(fixture.container.textContent).toContain("Message search is unavailable.");
    await fixture.dispose();
  });

  it.each([
    ["repeats", historyCursor(10n)],
    ["moves forward", historyCursor(11n)]
  ])("fails a message-only history search when the next cursor %s", async (_case, stalledCursor) => {
    const task = session("task-a");
    const loadSessionTimelinePage = vi.fn<AppController["loadSessionTimelinePage"]>(async (_sessionId, beforeCursor) => ({
      items: [],
      nextBeforeCursor: beforeCursor === undefined ? historyCursor(10n) : stalledCursor
    }));
    const fixture = renderApp(connectedState({
      route: { kind: "session", sessionId: task.id, messageId: "missing-message" },
      sessions: [task]
    }), { loadSessionTimelinePage });

    await fixture.render();
    await act(async () => {
      await vi.waitFor(() => {
        expect(loadSessionTimelinePage).toHaveBeenCalledTimes(2);
        expect(fixture.container.textContent).toContain("That message is no longer available in the task timeline.");
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(loadSessionTimelinePage).toHaveBeenCalledTimes(2);
    await fixture.dispose();
  });

  it("restarts message traversal when the authoritative history revision changes", async () => {
    const task = session("task-a");
    const linkedMessage = timelineItem("older-message");
    const stalePage = deferred<Awaited<ReturnType<AppController["loadSessionTimelinePage"]>>>();
    const loadSessionTimelinePage = vi.fn<AppController["loadSessionTimelinePage"]>()
      .mockResolvedValueOnce({ items: [], nextBeforeCursor: historyCursor(10n) })
      .mockImplementationOnce(async () => stalePage.promise)
      .mockResolvedValueOnce({ items: [], nextBeforeCursor: historyCursor(20n) })
      .mockResolvedValueOnce({ items: [linkedMessage] });
    const initial = connectedState({
      route: { kind: "session", sessionId: task.id, messageId: linkedMessage.id },
      sessions: [task]
    });
    const fixture = renderApp(initial, { loadSessionTimelinePage });

    await fixture.render();
    await act(async () => {
      await vi.waitFor(() => expect(loadSessionTimelinePage).toHaveBeenCalledTimes(2));
    });
    await fixture.render({
      ...initial,
      snapshot: {
        ...initial.snapshot,
        timelineHistoryRevisionBySession: new Map([[task.id, 1n]])
      }
    });
    await act(async () => {
      await vi.waitFor(() => expect(loadSessionTimelinePage).toHaveBeenCalledTimes(4));
    });
    expect(loadSessionTimelinePage.mock.calls[2]?.[1]).toBeUndefined();
    expect(loadSessionTimelinePage.mock.calls[3]?.[1]).toEqual(historyCursor(20n));
    expect(fixture.container.textContent).not.toContain("That message is no longer available in the task timeline.");
    stalePage.resolve({ items: [], nextBeforeCursor: historyCursor(9n) });
    await act(async () => { await Promise.resolve(); });
    await fixture.dispose();
  });

  it("allows the final budgeted history page and rejects only the next request", () => {
    const search = {
      key: "message-link",
      seenCursors: new Set<string>(),
      pageRequests: 255,
      lastCursor: historyCursor(10n)
    };
    expect(reserveMessageDeepLinkHistoryPage(search, historyCursor(9n))).toBe(true);
    expect(search.pageRequests).toBe(256);
    expect(reserveMessageDeepLinkHistoryPage(search, historyCursor(8n))).toBe(false);
    expect(search.pageRequests).toBe(256);
  });

  it("acknowledges a repeated same-hash delivery only after a new navigation occurrence commits", async () => {
    window.history.replaceState(window.history.state, "", "#/settings/providers");
    let navigateListener: ((delivery: JokoDesktopDeepLinkDelivery) => void) | undefined;
    const acknowledge = vi.fn(async () => true);
    Object.defineProperty(window, "jokoDesktop", {
      configurable: true,
      value: {
        platform: "win32",
        capabilities: ["navigation.deepLinks"],
        applicationMenu: {
          configure: vi.fn(async () => undefined),
          onCommand: vi.fn(() => vi.fn())
        },
        selectionContextMenu: {
          setLocale: vi.fn(async () => undefined),
          onAddToChat: vi.fn(() => vi.fn())
        },
        setTrayIcon: vi.fn(async () => undefined),
        deepLinks: {
          takePending: vi.fn(async () => undefined),
          acknowledge,
          onNavigate: vi.fn((listener: (delivery: JokoDesktopDeepLinkDelivery) => void) => {
            navigateListener = listener;
            return vi.fn();
          })
        }
      } as unknown as JokoDesktopApi
    });
    const navigate = vi.fn<AppController["navigate"]>();
    const initial = {
      ...connectedState({ route: { kind: "settings" } }),
      navigationRevision: 7
    };
    const fixture = renderApp(initial, { navigate });
    await fixture.render();

    await act(async () => navigateListener?.(delivery(3, { kind: "settings", section: "providers" })));
    expect(navigate).toHaveBeenCalledWith(
      { kind: "settings" },
      expect.objectContaining({ exactHash: "#/settings/providers", isCurrent: expect.any(Function) })
    );
    expect(acknowledge).not.toHaveBeenCalled();

    await fixture.render({ ...initial, navigationRevision: 8 });
    await act(async () => {
      await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledExactlyOnceWith({
        documentOccurrence: "document-one",
        deliveryOccurrence: 3
      }));
    });
    await fixture.dispose();
  });

  it("acknowledges only the newest portable delivery after its import surface commits", async () => {
    let navigateListener: ((delivery: JokoDesktopDeepLinkDelivery) => void) | undefined;
    const acknowledge = vi.fn(async () => true);
    Object.defineProperty(window, "jokoDesktop", {
      configurable: true,
      value: {
        platform: "win32",
        capabilities: ["navigation.deepLinks"],
        applicationMenu: {
          configure: vi.fn(async () => undefined),
          onCommand: vi.fn(() => vi.fn())
        },
        selectionContextMenu: {
          setLocale: vi.fn(async () => undefined),
          onAddToChat: vi.fn(() => vi.fn())
        },
        setTrayIcon: vi.fn(async () => undefined),
        deepLinks: {
          takePending: vi.fn(async () => undefined),
          acknowledge,
          onNavigate: vi.fn((listener: (delivery: JokoDesktopDeepLinkDelivery) => void) => {
            navigateListener = listener;
            return vi.fn();
          })
        }
      } as unknown as JokoDesktopApi
    });
    const fixture = renderApp(connectedState({ route: { kind: "settings" } }));
    await fixture.render();

    const first = {
      documentOccurrence: "portable-document",
      deliveryOccurrence: 4,
      navigation: { kind: "portable" }
    } satisfies JokoDesktopDeepLinkDelivery;
    await act(async () => {
      navigateListener?.(first);
      expect(fixture.container.querySelector('[role="alertdialog"]')).toBeNull();
      expect(acknowledge).not.toHaveBeenCalled();
    });
    expect(fixture.container.querySelector('[role="alertdialog"]')?.textContent).toContain("Import task");
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith({
      documentOccurrence: "portable-document",
      deliveryOccurrence: 4
    });

    acknowledge.mockClear();
    const older = {
      documentOccurrence: "portable-document",
      deliveryOccurrence: 5,
      navigation: { kind: "portable" }
    } satisfies JokoDesktopDeepLinkDelivery;
    const newer = {
      documentOccurrence: "portable-document",
      deliveryOccurrence: 6,
      navigation: { kind: "portable" }
    } satisfies JokoDesktopDeepLinkDelivery;
    await act(async () => {
      navigateListener?.(older);
      navigateListener?.(newer);
      expect(acknowledge).not.toHaveBeenCalled();
    });
    expect(fixture.container.querySelector('[role="alertdialog"]')?.textContent).toContain("Import task");
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith({
      documentOccurrence: "portable-document",
      deliveryOccurrence: 6
    });
    await fixture.dispose();
  });

  it("keeps an older route fenced when portable wins inside the controller leave gate", async () => {
    let navigateListener: ((delivery: JokoDesktopDeepLinkDelivery) => void) | undefined;
    const acknowledge = vi.fn(async () => true);
    const controllerGate = deferred<void>();
    const committed = vi.fn();
    let routeSignal: AbortSignal | undefined;
    const navigate = vi.fn<AppController["navigate"]>((route, options) => {
      routeSignal = options?.signal;
      void controllerGate.promise.then(() => {
        if (options?.isCurrent?.() !== false) committed(route);
      });
    });
    Object.defineProperty(window, "jokoDesktop", {
      configurable: true,
      value: desktopDeepLinkApi((listener) => { navigateListener = listener; }, acknowledge)
    });
    const fixture = renderApp(connectedState({
      route: { kind: "files", sessionId: "task-a", file: "notes.md" },
      sessions: [session("task-a")]
    }), { navigate });
    await fixture.render();
    await act(async () => navigateListener?.(delivery(7, { kind: "settings", section: "providers" })));
    expect(navigate).toHaveBeenCalledOnce();
    expect(routeSignal?.aborted).toBe(false);

    await act(async () => navigateListener?.(delivery(8, { kind: "portable" })));
    expect(routeSignal?.aborted).toBe(true);
    await act(async () => controllerGate.resolve(undefined));
    await act(async () => { await Promise.resolve(); });

    expect(committed).not.toHaveBeenCalled();
    expect(fixture.container.querySelector('[role="alertdialog"]')?.textContent).toContain("Import task");
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith({
      documentOccurrence: "document-one",
      deliveryOccurrence: 8
    });
    await fixture.dispose();
  });

  it("lets only the newest controller-gated route delivery commit and acknowledge", async () => {
    let navigateListener: ((delivery: JokoDesktopDeepLinkDelivery) => void) | undefined;
    const acknowledge = vi.fn(async () => true);
    const controllerGates = [deferred<void>(), deferred<void>()] as const;
    const committed = vi.fn((route: Parameters<AppController["navigate"]>[0], exactHash: string | undefined) => {
      if (exactHash !== undefined) window.location.hash = exactHash;
    });
    const navigate = vi.fn<AppController["navigate"]>((route, options) => {
      const gate = controllerGates[navigate.mock.calls.length - 1];
      void gate?.promise.then(() => {
        if (options?.isCurrent?.() !== false) committed(route, options?.exactHash);
      });
    });
    Object.defineProperty(window, "jokoDesktop", {
      configurable: true,
      value: desktopDeepLinkApi((listener) => { navigateListener = listener; }, acknowledge)
    });
    const initial = connectedState({
      route: { kind: "files", sessionId: "task-a", file: "notes.md" },
      sessions: [session("task-a")]
    });
    const fixture = renderApp(initial, { navigate });
    await fixture.render();
    await act(async () => navigateListener?.(delivery(9, { kind: "settings", section: "general" })));
    await act(async () => navigateListener?.(delivery(10, { kind: "settings", section: "providers" })));
    expect(navigate).toHaveBeenCalledTimes(2);

    await act(async () => controllerGates[0].resolve(undefined));
    expect(committed).not.toHaveBeenCalled();
    await act(async () => controllerGates[1].resolve(undefined));
    expect(committed).toHaveBeenCalledExactlyOnceWith({ kind: "settings" }, "#/settings/providers");
    expect(acknowledge).not.toHaveBeenCalled();

    await fixture.render({
      ...connectedState({ route: { kind: "settings" }, sessions: [session("task-a")] }),
      navigationRevision: 1
    });
    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledExactlyOnceWith({
      documentOccurrence: "document-one",
      deliveryOccurrence: 10
    }));
    await fixture.dispose();
  });

  it("retires an uncommitted portable surface when a newer route wins", async () => {
    let navigateListener: ((delivery: JokoDesktopDeepLinkDelivery) => void) | undefined;
    const acknowledge = vi.fn(async () => true);
    const navigate = vi.fn<AppController["navigate"]>((_route, options) => {
      if (options?.exactHash !== undefined) window.location.hash = options.exactHash;
    });
    Object.defineProperty(window, "jokoDesktop", {
      configurable: true,
      value: desktopDeepLinkApi((listener) => { navigateListener = listener; }, acknowledge)
    });
    const initial = connectedState({ route: { kind: "settings" } });
    const fixture = renderApp(initial, { navigate });
    await fixture.render();

    await act(async () => {
      navigateListener?.(delivery(11, { kind: "portable" }));
      navigateListener?.(delivery(12, { kind: "settings", section: "providers" }));
    });
    expect(fixture.container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(acknowledge).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledExactlyOnceWith(
      { kind: "settings" },
      expect.objectContaining({ exactHash: "#/settings/providers", isCurrent: expect.any(Function) })
    );

    await fixture.render({ ...initial, navigationRevision: 1 });
    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledExactlyOnceWith({
      documentOccurrence: "document-one",
      deliveryOccurrence: 12
    }));
    await fixture.dispose();
  });

  it("keeps the newest delivery and sends notifications with an exact machine route", async () => {
    let navigateListener: ((delivery: JokoDesktopDeepLinkDelivery) => void) | undefined;
    const pending = deferred<JokoDesktopDeepLinkDelivery | undefined>();
    const acknowledge = vi.fn(async () => true);
    const notify = vi.fn(async () => undefined);
    const navigate = vi.fn<AppController["navigate"]>((_route, options) => {
      if (options?.exactHash !== undefined) window.location.hash = options.exactHash;
    });
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    Object.defineProperty(window, "jokoDesktop", {
      configurable: true,
      value: {
        platform: "win32",
        capabilities: ["navigation.deepLinks", "notifications.session"],
        applicationMenu: {
          configure: vi.fn(async () => undefined),
          onCommand: vi.fn(() => vi.fn())
        },
        selectionContextMenu: {
          setLocale: vi.fn(async () => undefined),
          onAddToChat: vi.fn(() => vi.fn())
        },
        setTrayIcon: vi.fn(async () => undefined),
        notify,
        deepLinks: {
          takePending: vi.fn(() => pending.promise),
          acknowledge,
          onNavigate: vi.fn((listener: (delivery: JokoDesktopDeepLinkDelivery) => void) => {
            navigateListener = listener;
            return vi.fn();
          })
        }
      } as unknown as JokoDesktopApi
    });
    const baselineTask = session("task-a");
    const baseline = connectedState({
      route: { kind: "session", sessionId: "missing-task" },
      sessions: [baselineTask]
    });
    const fixture = renderApp(baseline, { navigate });
    await fixture.render();
    expect(navigateListener).toBeTypeOf("function");

    const newer = delivery(2, { kind: "settings", section: "providers" });
    const older = delivery(1, { kind: "settings", section: "general" });
    await act(async () => {
      navigateListener?.(newer);
      pending.resolve(older);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(window.location.hash).toBe("#/settings/providers");
    expect(navigate).toHaveBeenCalledWith(
      { kind: "settings" },
      expect.objectContaining({ exactHash: "#/settings/providers", isCurrent: expect.any(Function) })
    );
    expect(navigate.mock.calls.filter(([, options]) => options?.exactHash === "#/settings/providers")).toHaveLength(1);
    expect(acknowledge).not.toHaveBeenCalled();

    await fixture.render({
      ...connectedState({ route: { kind: "settings" }, sessions: [baselineTask] }),
      navigationRevision: 1
    });
    await act(async () => {
      await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledExactlyOnceWith({
        documentOccurrence: "document-one",
        deliveryOccurrence: 2
      }));
    });

    await fixture.render(connectedState({
      route: baseline.route,
      sessions: [session("task-a", attention("done", 4n))]
    }));
    expect(notify).toHaveBeenCalledWith({
      title: "Joko · Task task-a",
      body: "Task finished",
      navigation: { kind: "session", profileId: "profile-a", sessionId: "task-a" }
    });
    await fixture.dispose();
  });

  it("projects a long controlled Schedule name into one valid native notification title", async () => {
    const notify = vi.fn<JokoDesktopApi["notify"]>(async () => undefined);
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    Object.defineProperty(window, "jokoDesktop", {
      configurable: true,
      value: {
        platform: "win32",
        capabilities: ["notifications.session"],
        applicationMenu: {
          configure: vi.fn(async () => undefined),
          onCommand: vi.fn(() => vi.fn())
        },
        selectionContextMenu: {
          setLocale: vi.fn(async () => undefined),
          onAddToChat: vi.fn(() => vi.fn())
        },
        setTrayIcon: vi.fn(async () => undefined),
        notify
      } as unknown as JokoDesktopApi
    });
    const longName = `Nightly\u0000${"🔎 review ".repeat(32)}`;
    const running = schedule(scheduleRun("schedule-run", "running"), longName);
    const fixture = renderApp(connectedState({
      route: { kind: "settings" },
      schedules: [running]
    }));
    await fixture.render();
    expect(notify).not.toHaveBeenCalled();

    const completed = schedule(scheduleRun("schedule-run", "completed", { finishedAt: 20 }), longName);
    await fixture.render(connectedState({ route: { kind: "settings" }, schedules: [completed] }));
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
    const title = notify.mock.calls[0]?.[0].title;
    expect(title).toHaveLength(160);
    expect(title).toMatch(/^Joko · /u);
    expect(title).toMatch(/…$/u);
    expect(title).not.toMatch(/[\u0000-\u001f\u007f]/u);

    await fixture.render(connectedState({ route: { kind: "settings" }, schedules: [completed] }));
    expect(notify).toHaveBeenCalledOnce();
    await fixture.dispose();
  });

  it("rechecks the real controller navigation owner after its asynchronous leave gate", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    vi.spyOn(LocalState, "open").mockResolvedValue({
      listProfiles: async () => [],
      listMachineCaches: async () => [],
      readPreferences: async () => DEFAULT_UI_PREFERENCES
    } as unknown as LocalState);
    window.history.replaceState(window.history.state, "", "#/files/task-a?file=notes.md");
    let current!: AppController;
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    function ControllerProbe(): null {
      current = useAppController();
      return null;
    }
    try {
      await act(async () => { root.render(createElement(ControllerProbe)); });
      await vi.waitFor(() => expect(current.state.ready).toBe(true));
      expect(current.state.route).toEqual({ kind: "files", sessionId: "task-a", file: "notes.md" });
      const navigationRevision = current.state.navigationRevision;
      let ownerCurrent = true;
      await act(async () => {
        current.navigate({ kind: "settings" }, { isCurrent: () => ownerCurrent });
        ownerCurrent = false;
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(current.state.route).toEqual({ kind: "files", sessionId: "task-a", file: "notes.md" });
      expect(current.state.navigationRevision).toBe(navigationRevision);
      expect(window.location.hash).toBe("#/files/task-a?file=notes.md");
    } finally {
      await act(async () => { root.unmount(); });
      host.remove();
    }
  });

  it("restores the exact prior hash when a same-route handoff is retired before hashchange", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    vi.spyOn(LocalState, "open").mockResolvedValue({
      listProfiles: async () => [],
      listMachineCaches: async () => [],
      readPreferences: async () => DEFAULT_UI_PREFERENCES
    } as unknown as LocalState);
    window.history.replaceState(window.history.state, "", "#/settings/general");
    let current!: AppController;
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    function ControllerProbe(): null {
      current = useAppController();
      return null;
    }
    try {
      await act(async () => { root.render(createElement(ControllerProbe)); });
      await vi.waitFor(() => expect(current.state.ready).toBe(true));
      const navigationRevision = current.state.navigationRevision;
      const occurrence = new AbortController();
      await act(async () => {
        current.navigate(
          { kind: "settings" },
          { exactHash: "#/settings/providers", signal: occurrence.signal }
        );
        expect(window.location.hash).toBe("#/settings/providers");
        occurrence.abort();
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      });

      expect(window.location.hash).toBe("#/settings/general");
      expect(current.state.route).toEqual({ kind: "settings" });
      expect(current.state.navigationRevision).toBe(navigationRevision);
    } finally {
      await act(async () => { root.unmount(); });
      host.remove();
    }
  });
});

function renderApp(
  initialState: ControllerState,
  methods: Partial<AppController> = {}
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (state = initialState): Promise<void> => {
    const controller = {
      state,
      navigate: vi.fn(),
      refreshMachines: vi.fn(async () => undefined),
      partnerGroupApi: () => undefined,
      probeRuntimeActivity: vi.fn(async () => ({ state: "idle" as const })),
      setMachineSelection: vi.fn(async () => undefined),
      setNavigationOpen: vi.fn(async () => undefined),
      setNavigationLayout: vi.fn(async () => undefined),
      resetLayoutPreferences: vi.fn(async () => undefined),
      refreshProviderModels: vi.fn(async () => undefined),
      loadSessionTimelinePage: vi.fn(async () => ({ items: [] })),
      getPortableReplacementCleanup: vi.fn(async () => undefined),
      ...methods
    } as unknown as AppController;
    await act(async () => { root.render(createElement(AppWithController, { controller })); });
  };
  const dispose = async (): Promise<void> => {
    renderedApps.delete(dispose);
    await act(async () => { root.unmount(); });
    container.remove();
  };
  renderedApps.add(dispose);
  return { container, render, dispose };
}

function connectedState(options: {
  readonly route: ControllerState["route"];
  readonly sessions?: readonly SessionView[];
  readonly schedules?: readonly ScheduleView[];
}): ControllerState {
  return {
    ready: true,
    connectionState: "connected",
    connectionGeneration: 1,
    profiles: [{ id: "profile-a", deviceId: "device-a", serverId: "server-a", name: "Local", origin: "http://127.0.0.1" }],
    machineCaches: [],
    machinePresenceByProfile: {},
    activeProfile: { id: "profile-a", deviceId: "device-a", serverId: "server-a", name: "Local", origin: "http://127.0.0.1" },
    discoveredNodes: [],
    discoveryState: "idle",
    managedOrchestratorStatus: undefined,
    automaticConnectionAvailable: true,
    snapshot: {
      ...emptySnapshot(),
      revision: 1n,
      sessions: options.sessions ?? [],
      schedules: options.schedules ?? []
    },
    route: options.route,
    navigationRevision: 0,
    preferences: DEFAULT_UI_PREFERENCES,
    systemLocale: "en",
    effectiveLocale: "en",
    extensionNotifications: []
  };
}

function session(id: string, value?: SessionAttentionView): SessionView {
  return {
    id,
    backendId: "backend",
    targetId: "target",
    name: `Task ${id}`,
    state: "idle",
    pinned: false,
    archived: false,
    generation: 3n,
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    ...(value === undefined ? {} : { attention: value }),
    updatedAt: 1
  };
}

function schedule(history: ScheduleRunHistoryView, name: string): ScheduleView {
  return {
    id: "schedule-one",
    name,
    source: "user",
    backendId: "backend",
    targetId: "target",
    sessionMode: "fresh",
    enabled: true,
    kind: "manual",
    expression: "",
    timezone: "UTC",
    inputText: "Inspect",
    executionMode: "agent",
    permissionMode: "ask",
    planMode: false,
    useWorktree: false,
    refreshWorktreeRemote: false,
    extraDirectoryIds: [],
    silentWhenIdle: false,
    notifyDesktop: true,
    overlapPolicy: "queue",
    misfirePolicy: "runOnce",
    unreadRunCount: 0,
    history: [history]
  };
}

function scheduleRun(
  id: string,
  state: ScheduleRunHistoryView["state"],
  extra: Partial<ScheduleRunHistoryView> = {}
): ScheduleRunHistoryView {
  return {
    id,
    runId: id,
    sessionId: "session-one",
    state,
    scheduledAt: 10,
    triggeredAt: 10,
    zeroCost: true,
    costAttribution: "zero",
    ...extra
  };
}

function attention(kind: SessionAttentionView["kind"], sequence: bigint): SessionAttentionView {
  const cursor = (value: bigint) => ({ opaqueToken: `cursor-${value}`, sequence: value, generation: 3n });
  return {
    kind,
    unread: true,
    subjectCursor: cursor(sequence - 1n),
    attentionCursor: cursor(sequence),
    readThroughCursor: cursor(sequence - 1n),
    updatedAt: Number(sequence)
  };
}

function historyCursor(sequence: bigint): TimelineHistoryCursorView {
  return { opaqueToken: `history-${sequence}`, sequence, generation: 3n };
}

function timelineItem(id: string): TimelineItemView {
  return { id, sequence: 1n, kind: "assistant", createdAt: 1, text: id };
}

function delivery(
  deliveryOccurrence: number,
  navigation: JokoDesktopDeepLinkNavigation
): JokoDesktopDeepLinkDelivery {
  return { documentOccurrence: "document-one", deliveryOccurrence, navigation };
}

function desktopDeepLinkApi(
  subscribe: (listener: (delivery: JokoDesktopDeepLinkDelivery) => void) => void,
  acknowledge: (acknowledgement: JokoDesktopDeepLinkAcknowledgement) => Promise<boolean>
): JokoDesktopApi {
  return {
    platform: "win32",
    capabilities: ["navigation.deepLinks"],
    applicationMenu: {
      configure: vi.fn(async () => undefined),
      onCommand: vi.fn(() => vi.fn())
    },
    selectionContextMenu: {
      setLocale: vi.fn(async () => undefined),
      onAddToChat: vi.fn(() => vi.fn())
    },
    setTrayIcon: vi.fn(async () => undefined),
    deepLinks: {
      takePending: vi.fn(async () => undefined),
      acknowledge,
      onNavigate: vi.fn((listener: (delivery: JokoDesktopDeepLinkDelivery) => void) => {
        subscribe(listener);
        return vi.fn();
      })
    }
  } as unknown as JokoDesktopApi;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
