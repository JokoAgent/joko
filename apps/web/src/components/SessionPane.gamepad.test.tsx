// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import type { AppShortcutOverrides } from "../app-shortcuts.js";
import { dispatchGamepadOwnedAction, type GamepadOwnedAction } from "../gamepad-actions.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot, type BackendView, type ModelView, type SessionView, type TimelineItemView } from "../model.js";
import { SessionPane } from "./SessionPane.js";

vi.mock("./Composer.js", () => ({ Composer: () => <button>Message input</button> }));
vi.mock("./Timeline.js", () => ({
  Timeline: ({ items, onForkMessage }: {
    readonly items: readonly TimelineItemView[];
    readonly onForkMessage?: (item: TimelineItemView) => void;
  }) => onForkMessage === undefined ? null : <button type="button" data-testid="message-fork" onClick={() => onForkMessage(items[0]!)}>Fork message</button>,
  StreamingMarkdown: () => null
}));
vi.mock("./ModelPicker.js", () => ({ ModelPicker: () => null }));
const roots: Root[] = [];
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("requestAnimationFrame", () => 0); });
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  document.body.replaceChildren(); document.body.className = ""; Reflect.deleteProperty(window.navigator, "clipboard"); vi.unstubAllGlobals();
});
const model: ModelView = { backendId: "backend", providerId: "provider", providerName: "Provider", modelId: "model", name: "Model", available: true, supportsImages: false,
  supportsFast: true, efforts: ["low", "medium", "high"], inputModalities: ["text"], outputModalities: ["text"], contextWindow: 8192, maximumOutputTokens: 2048,
  inputCostMicrosPerMillion: 0, outputCostMicrosPerMillion: 0, currencyCode: "USD" };
const session: SessionView = { id: "task", backendId: "backend", targetId: "target", name: "Task", state: "idle", generation: 1n,
  pinned: false, archived: false, updatedAt: 1, fastMode: false, planMode: false, permissionMode: "ask", effort: "medium", model };
const backend: BackendView = { id: "backend", name: "Backend", health: "healthy", version: "1", capabilities: new Map(
  ["model.effort", "model.fast_mode", "plan_mode", "turn.abort", "session.fork", "session.clone"].map((name) => [name, { name, supported: true, options: [] }])) };
const message: TimelineItemView = { id: "message", kind: "assistant", text: "Finished response", nativeEntryId: "native-entry", sourceEventId: "event", sequence: 1n, createdAt: 1 };
const learningRun = { id: "learning", revision: 1n, state: "distilling" as const, sourceKind: "session" as const,
  backendId: "backend", targetId: "target", sourceSessionId: "task", distillationSessionId: "distillation",
  summary: "", createdAt: 1, updatedAt: 1, expiresAt: 100 };

describe("session gamepad actions", () => {
  it("applies bounded reasoning and Fast changes to the current model and prevents overlapping model updates", async () => {
    const view = await mount();
    let complete!: () => void;
    view.api.setModel.mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve; }));
    await view.action("effort-increase"); await view.action("toggle-fast");
    expect(view.api.setModel).toHaveBeenCalledExactlyOnceWith("task", "provider", "model", "high", false);
    await act(async () => { complete(); await Promise.all(view.pending); });
    await view.render({ ...session, effort: "high", fastMode: true });
    await view.action("effort-increase"); expect(view.api.setModel).toHaveBeenCalledOnce();
    await view.action("effort-decrease"); await view.flush();
    expect(view.api.setModel).toHaveBeenLastCalledWith("task", "provider", "model", "medium", true);
    await view.action("toggle-fast"); await view.flush();
    expect(view.api.setModel).toHaveBeenLastCalledWith("task", "provider", "model", "high", false);
    await view.action("toggle-plan"); await view.flush();
    expect(view.api.setPlanMode).toHaveBeenCalledExactlyOnceWith("task", true);
  });

  it("respects read-only and capability withdrawal while leaving the existing Stop owner available", async () => {
    const view = await mount();
    await view.render(session, { ...backend, capabilities: new Map() });
    await view.action("toggle-fast"); await view.action("toggle-plan"); await view.action("effort-increase");
    expect(view.api.setModel).not.toHaveBeenCalled(); expect(view.api.setPlanMode).not.toHaveBeenCalled();
    await view.render({ ...session, state: "running", activeRunId: "run" }, backend, true);
    await view.action("toggle-fast"); await view.action("toggle-pin"); await view.action("archive-task");
    expect(view.api.setModel).not.toHaveBeenCalled(); expect(view.api.pinSession).not.toHaveBeenCalled(); expect(view.archive).not.toHaveBeenCalled();
    await view.action("stop"); await view.flush(); expect(view.api.abort).toHaveBeenCalledExactlyOnceWith("run");
  });

  it("keeps side chat input and task actions while withholding immutable native controls", async () => {
    const view = await mount();
    const sideChat: SessionView = { ...session, derivationOrigin: {
      kind: "fork", sideChat: true, sourceSessionId: "parent",
      sourceSessionAvailable: true, sourceMessageAvailable: false
    } };
    await view.render(sideChat);
    await view.action("toggle-fast"); await view.action("effort-increase"); await view.action("toggle-plan");
    await view.action("fork-task");
    expect(view.api.setModel).not.toHaveBeenCalled();
    expect(view.api.setPlanMode).not.toHaveBeenCalled();
    expect(view.api.forkSession).not.toHaveBeenCalled();
    expect(view.host.textContent).toContain("Message input");
    await view.action("toggle-pin"); await view.flush();
    expect(view.api.pinSession).toHaveBeenCalledExactlyOnceWith("task", true);
    await view.render({ ...sideChat, worktree: {
      leaseId: "0123456789abcdef01234567", workspaceId: "workspace", workingPath: "D:/independent",
      repositoryRoot: "D:/repository", branch: "joko/side-chat", sourceRef: "main",
      sourceCommit: "0123456789abcdef0123456789abcdef01234567", sourceStrategy: "explicit",
      sourceRefreshed: false, state: "active", acquiredAt: 1, updatedAt: 1
    } });
    await view.action("toggle-fast"); await view.flush();
    expect(view.api.setModel).toHaveBeenCalledOnce();
  });

  it("delegates archive and copy to their existing owners and opens the fork confirmation before dispatch", async () => {
    const view = await mount();
    await view.action("toggle-pin"); await view.flush(); expect(view.api.pinSession).toHaveBeenCalledExactlyOnceWith("task", true);
    await view.action("archive-task"); expect(view.archive).toHaveBeenCalledOnce();
    await view.action("copy-task-link"); expect(view.copy).toHaveBeenCalledOnce();
    await view.action("fork-task");
    expect(document.querySelector("[data-message-fork-confirm='true']")).not.toBeNull();
    expect(view.api.forkSession).not.toHaveBeenCalled();
    await view.action("approve"); expect(view.api.forkSession).not.toHaveBeenCalled();
    await act(async () => document.querySelector<HTMLButtonElement>("[data-message-fork-confirm='true']")!.click());
    await view.flush(); expect(view.api.forkSession).toHaveBeenCalledOnce();
    expect(view.api.forkSession.mock.calls[0]?.slice(0, 2)).toEqual(["task", "native-entry"]);
  });

  it("copies the complete current task through the configured gamepad action and reports the result", async () => {
    const view = await mount();
    const writeText = vi.fn(async (_value: string) => undefined);
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });
    view.api.loadSessionTimelinePage.mockResolvedValueOnce({ items: [
      { ...message, id: "user", kind: "user", text: "Question", sequence: 1n },
      { ...message, id: "answer", text: "Answer", sequence: 2n }
    ] });
    await view.action("copy-conversation-markdown");
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith("## timeline.you\n\nQuestion\n\n## timeline.agent\n\nAnswer"));
    expect(view.api.loadSessionTimelinePage).toHaveBeenCalledExactlyOnceWith("task", undefined, 500);
    expect(view.host.textContent).toContain("session.conversationCopy.copied");
  });

  it("leaves the clipboard unchanged for empty or failed history and discards an old task response", async () => {
    const view = await mount();
    const writeText = vi.fn(async (_value: string) => undefined);
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });
    view.api.loadSessionTimelinePage.mockResolvedValueOnce({ items: [] });
    await view.action("copy-conversation-markdown");
    await vi.waitFor(() => expect(view.host.textContent).toContain("session.conversationCopy.empty"));
    expect(writeText).not.toHaveBeenCalled();
    view.api.loadSessionTimelinePage.mockRejectedValueOnce(new Error("offline"));
    await view.action("copy-conversation-markdown");
    await vi.waitFor(() => expect(view.host.textContent).toContain("session.conversationCopy.read-failed"));
    expect(writeText).not.toHaveBeenCalled();
    let resolvePage!: (value: { items: TimelineItemView[] }) => void;
    view.api.loadSessionTimelinePage.mockImplementationOnce(() => new Promise((resolve) => { resolvePage = resolve; }));
    await view.action("copy-conversation-markdown");
    await view.render({ ...session, id: "other-task" });
    await act(async () => resolvePage({ items: [message] }));
    expect(writeText).not.toHaveBeenCalled();
    expect(view.host.textContent).not.toContain("session.conversationCopy.copied");
  });

  it("reports clipboard rejection without claiming that the conversation was copied", async () => {
    const view = await mount();
    const writeText = vi.fn(async (_value: string) => { throw new Error("denied"); });
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });
    view.api.loadSessionTimelinePage.mockResolvedValueOnce({ items: [message] });
    await view.action("copy-conversation-markdown");
    await vi.waitFor(() => expect(view.host.textContent).toContain("session.conversationCopy.clipboard-failed"));
    expect(writeText).toHaveBeenCalledOnce();
    expect(view.host.textContent).not.toContain("session.conversationCopy.copied");
  });

  it("routes a saved keyboard binding only to the focused task pane", async () => {
    const overrides: AppShortcutOverrides = { "copy-conversation-markdown": { code: "KeyY", key: "y", meta: false, ctrl: true, alt: false, shift: false } };
    const first = await mount(overrides);
    const second = await mount(overrides);
    await second.render({ ...session, id: "other-task" });
    const writeText = vi.fn(async (_value: string) => undefined);
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });
    second.api.loadSessionTimelinePage.mockResolvedValueOnce({ items: [message] });
    const keydown = new KeyboardEvent("keydown", { key: "y", code: "KeyY", ctrlKey: true, bubbles: true, cancelable: true });
    second.host.querySelector<HTMLButtonElement>("button")!.focus();
    await act(async () => { second.host.querySelector<HTMLButtonElement>("button")!.dispatchEvent(keydown); });
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(keydown.defaultPrevented).toBe(true);
    expect(first.api.loadSessionTimelinePage).not.toHaveBeenCalled();
    expect(second.api.loadSessionTimelinePage).toHaveBeenCalledExactlyOnceWith("other-task", undefined, 500);
    document.body.classList.add("modal-open");
    const blocked = new KeyboardEvent("keydown", { key: "y", code: "KeyY", ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => { second.host.querySelector<HTMLButtonElement>("button")!.dispatchEvent(blocked); });
    expect(blocked.defaultPrevented).toBe(false);
    expect(second.api.loadSessionTimelinePage).toHaveBeenCalledOnce();
  });

  it("exposes clone and message fork for an isolated workspace only when the backend can derive it", async () => {
    const view = await mount();
    const isolatedSession: SessionView = {
      ...session,
      worktree: {
        leaseId: "0123456789abcdef01234567",
        workspaceId: "workspace",
        workingPath: "D:/worktrees/task",
        repositoryRoot: "D:/repository",
        branch: "joko/task",
        sourceRef: "main",
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        sourceStrategy: "explicit",
        sourceRefreshed: false,
        state: "active",
        acquiredAt: 1,
        updatedAt: 1
      }
    };

    await view.render(isolatedSession, backend);
    expect(view.menuLabels()).not.toContain("session.clone");
    expect(view.host.querySelector('[data-testid="message-fork"]')).toBeNull();
    await view.action("fork-task");
    expect(document.querySelector("[data-message-fork-confirm='true']")).toBeNull();
    expect(view.api.forkSession).not.toHaveBeenCalled();

    const derivingBackend: BackendView = {
      ...backend,
      capabilities: new Map([
        ...backend.capabilities,
        ["workspace.derive", { name: "workspace.derive", supported: true, options: [] }]
      ])
    };
    await view.render(isolatedSession, derivingBackend);
    expect(view.menuLabels()).toContain("session.clone");
    expect(view.host.querySelector('[data-testid="message-fork"]')).not.toBeNull();

    await act(async () => view.menuButton("session.clone").click());
    await view.flush();
    expect(view.api.cloneSession).toHaveBeenCalledWith("task", "session.cloneSuffix", {
      messageId: "message",
      eventId: "event"
    });
    expect(view.api.navigate).toHaveBeenCalledWith({ kind: "session", sessionId: "cloned" });

    await act(async () => view.host.querySelector<HTMLButtonElement>('[data-testid="message-fork"]')!.click());
    expect(document.querySelector("[data-message-fork-confirm='true']")).not.toBeNull();
  });

  it.each(["fork", "clone", "learn"] as const)("does not let an old %s result replace a later task navigation", async (action) => {
    const view = await mount();
    let complete!: () => void;
    if (action === "fork") view.api.forkSession.mockImplementationOnce(() => new Promise((resolve) => { complete = () => resolve("forked"); }));
    if (action === "clone") view.api.cloneSession.mockImplementationOnce(() => new Promise((resolve) => { complete = () => resolve("cloned"); }));
    if (action === "learn") view.api.startSkillLearning.mockImplementationOnce(() => new Promise((resolve) => { complete = () => resolve(learningRun); }));
    await view.derive(action);
    await view.render({ ...session, id: "other-task" }, backend, false, { navigationRevision: 2 });
    await act(async () => { complete(); await Promise.all(view.pending); });
    expect(view.api.navigate).not.toHaveBeenCalled();
  });

  it("does not save a late user-message fork prompt into a replacement connection", async () => {
    const view = await mount();
    const userMessage: TimelineItemView = { ...message, kind: "user", text: "Keep my source prompt", nativeEntryId: undefined, nativeParentEntryId: "parent-entry" };
    await view.render(session, backend, false, {}, [userMessage]);
    let complete!: () => void;
    view.api.forkSession.mockImplementationOnce(() => new Promise((resolve) => { complete = () => resolve("forked"); }));
    await view.derive("fork");
    await view.render(session, backend, false, {
      activeProfile: { id: "replacement", serverId: "replacement-server", deviceId: "device", name: "Other node", origin: "https://other.example" },
      connectionGeneration: 2
    }, [userMessage]);
    await act(async () => { complete(); await Promise.all(view.pending); });
    expect(view.api.saveDraft).not.toHaveBeenCalled();
    expect(view.api.navigate).not.toHaveBeenCalled();
    expect(userMessage.text).toBe("Keep my source prompt");
  });

  it.each(["fork", "clone", "learn"] as const)("keeps current %s success usable and reports its current failure", async (action) => {
    const view = await mount();
    await view.derive(action);
    await view.flush();
    expect(view.api.navigate).toHaveBeenCalledExactlyOnceWith({ kind: "session", sessionId: action === "fork" ? "forked" : action === "clone" ? "cloned" : "distillation" });
    view.api.navigate.mockClear();
    const failure = new Error("source operation failed");
    if (action === "fork") view.api.forkSession.mockRejectedValueOnce(failure);
    if (action === "clone") view.api.cloneSession.mockRejectedValueOnce(failure);
    if (action === "learn") view.api.startSkillLearning.mockRejectedValueOnce(failure);
    await view.derive(action);
    await expect(view.flush()).rejects.toThrow("source operation failed");
    expect(view.api.navigate).not.toHaveBeenCalled();
  });

  it.each(["fork", "clone", "learn"] as const)("discards a stale %s failure after leaving the source task", async (action) => {
    const view = await mount();
    let fail!: () => void;
    if (action === "fork") view.api.forkSession.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = () => reject(new Error("old failure")); }));
    if (action === "clone") view.api.cloneSession.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = () => reject(new Error("old failure")); }));
    if (action === "learn") view.api.startSkillLearning.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = () => reject(new Error("old failure")); }));
    await view.derive(action);
    await view.render({ ...session, id: "other-task" });
    await act(async () => { fail(); await Promise.all(view.pending); });
    expect(view.api.navigate).not.toHaveBeenCalled();
  });

  it.each(["connection", "generation", "return", "pagehide"] as const)("retires an in-flight clone on %s even when the task ID is unchanged", async (change) => {
    const view = await mount();
    let complete!: () => void;
    view.api.cloneSession.mockImplementationOnce(() => new Promise((resolve) => { complete = () => resolve("cloned"); }));
    await view.derive("clone");
    if (change === "connection") await view.render(session, backend, false, { connectionGeneration: 2 });
    if (change === "generation") await view.render({ ...session, generation: 2n });
    if (change === "return") {
      await view.render({ ...session, id: "other-task" }, backend, false, { navigationRevision: 2 });
      await view.render(session, backend, false, { navigationRevision: 3 });
    }
    if (change === "pagehide") await act(async () => window.dispatchEvent(new Event("pagehide")));
    await act(async () => { complete(); await Promise.all(view.pending); });
    expect(view.api.navigate).not.toHaveBeenCalled();
  });

  it.each(["fork", "clone"] as const)("allows a newer action to own navigation while an old %s completes and leaves Fork usable", async (action) => {
    const view = await mount();
    let complete!: () => void;
    if (action === "fork") view.api.forkSession.mockImplementationOnce(() => new Promise((resolve) => { complete = () => resolve("old-fork"); }));
    else view.api.cloneSession.mockImplementationOnce(() => new Promise((resolve) => { complete = () => resolve("old-clone"); }));
    await view.derive(action);
    await view.derive("learn");
    await act(async () => { complete(); await Promise.all(view.pending); });
    expect(view.api.navigate).toHaveBeenCalledExactlyOnceWith({ kind: "session", sessionId: "distillation" });
    await view.derive("fork");
    await view.flush();
    expect(view.api.navigate).toHaveBeenLastCalledWith({ kind: "session", sessionId: "forked" });
  });

  it("saves the original user fork prompt before navigation and does not navigate if ownership changes during save", async () => {
    const view = await mount();
    const userMessage: TimelineItemView = { ...message, kind: "user", text: "Keep my source prompt", nativeEntryId: undefined, nativeParentEntryId: "parent-entry" };
    await view.render(session, backend, false, {}, [userMessage]);
    let completeSave!: () => void;
    view.api.saveDraft.mockImplementationOnce(() => new Promise((resolve) => { completeSave = resolve; }));
    await view.derive("fork");
    expect(view.api.saveDraft).toHaveBeenCalledWith("forked", expect.objectContaining({ text: "Keep my source prompt", attachments: [], mentions: [] }));
    expect(view.api.navigate).not.toHaveBeenCalled();
    await view.render({ ...session, id: "other-task" });
    await act(async () => { completeSave(); await Promise.all(view.pending); });
    expect(view.api.navigate).not.toHaveBeenCalled();
  });

  it("does not dispatch a cancelled fork confirmation", async () => {
    const view = await mount();
    await act(async () => view.host.querySelector<HTMLButtonElement>('[data-testid="message-fork"]')!.click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>(".modal button")].find((button) => button.textContent === "common.cancel")!.click());
    expect(view.api.forkSession).not.toHaveBeenCalled();
    expect(view.api.navigate).not.toHaveBeenCalled();
  });
});

async function mount(overrides: AppShortcutOverrides = {}) {
  const api = { setModel: vi.fn<AppController["setModel"]>(async () => undefined), setPlanMode: vi.fn(async () => undefined),
    getPortableReplacementCleanup: vi.fn(async () => undefined),
    listPartners: vi.fn(async () => ({ partners: [], directory: { revision: 1n, activeCount: 0, archivedCount: 0, errorCount: 0, updatedAt: 0, templates: [], avatarPresets: [] } })),
    pinSession: vi.fn(async () => undefined), abort: vi.fn(async () => undefined), forkSession: vi.fn<AppController["forkSession"]>(async () => "forked"),
    loadSessionTimelinePage: vi.fn<AppController["loadSessionTimelinePage"]>(async () => ({ items: [] })),
    saveDraft: vi.fn<AppController["saveDraft"]>(async () => undefined),
    startSkillLearning: vi.fn<AppController["startSkillLearning"]>(async () => learningRun),
    cloneSession: vi.fn<AppController["cloneSession"]>(async () => "cloned"), navigate: vi.fn(), exportSession: vi.fn(), getArtifactUrl: vi.fn(), releaseArtifactUrl: vi.fn() };
  const archive = vi.fn(); const copy = vi.fn(); const pending: Promise<unknown>[] = [];
  const host = document.body.appendChild(document.createElement("div")); const root = createRoot(host); roots.push(root);
  const controller = { ...api } as unknown as AppController;
  const render = async (current = session, currentBackend = backend, readOnly = false, stateOverrides: Partial<AppController["state"]> = {}, items = [message]) => {
    const snapshot = { ...emptySnapshot(), revision: 1n, sessions: [current], backends: [currentBackend], models: [model], timelineBySession: new Map([[current.id, items]]) };
    Object.assign(controller, { ...api, state: { ready: true, connectionState: "connected", connectionGeneration: 1, navigationRevision: 1,
      activeProfile: { id: "profile", serverId: "server", deviceId: "device", name: "Node", origin: "https://node.example" },
      preferences: { ...DEFAULT_UI_PREFERENCES, appShortcutOverrides: overrides }, snapshot, route: { kind: "session", sessionId: current.id }, ...stateOverrides } });
    await act(async () => root.render(<SessionPane controller={controller} session={current} backend={currentBackend} reviewReadOnly={readOnly} models={[model]} timeline={items}
      timelineHasEarlier={false} timelineHistoryLoading={false} onLoadEarlierTimeline={async () => undefined} extensionWidgets={[]} extensionStatuses={[]}
      queue={[]} extraDirectories={[]} resources={[]} commandRefreshSignal={[]} remainingInteractions={0} navigationOpen inspectorOpen t={(key) => key}
      runAction={(_key, action) => { const result = action(); void result.catch(() => undefined); pending.push(result); }} onOpenNavigation={() => undefined} onOpenInspector={() => undefined} onRename={() => undefined} onDelete={() => undefined}
      onArchive={archive} onCopyTaskLink={copy} />));
    host.querySelector<HTMLButtonElement>("button")!.focus();
  };
  await render();
  return { api, archive, copy, render, pending, host,
    derive: async (action: "fork" | "clone" | "learn") => {
      await act(async () => {
        if (action === "fork") host.querySelector<HTMLButtonElement>('[data-testid="message-fork"]')!.click();
        else [...host.querySelectorAll<HTMLButtonElement>("[role='menuitem']")].find((candidate) => candidate.textContent?.trim() === (action === "clone" ? "session.clone" : "skills.learning.fromSession"))!.click();
      });
      if (action === "fork") await act(async () => document.querySelector<HTMLButtonElement>("[data-message-fork-confirm='true']")!.click());
    },
    menuLabels: () => [...host.querySelectorAll<HTMLButtonElement>("[role='menuitem']")].map((item) => item.textContent?.trim()),
    menuButton: (label: string) => {
      const item = [...host.querySelectorAll<HTMLButtonElement>("[role='menuitem']")].find((candidate) => candidate.textContent?.trim() === label);
      if (item === undefined) throw new Error(`Missing menu item: ${label}`);
      return item;
    },
    action: async (action: GamepadOwnedAction) => act(async () => { dispatchGamepadOwnedAction(document, action); }),
    flush: async () => act(async () => { await Promise.all(pending); }) };
}
