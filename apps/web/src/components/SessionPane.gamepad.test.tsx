// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
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
  document.body.replaceChildren(); document.body.className = ""; vi.unstubAllGlobals();
});
const model: ModelView = { backendId: "backend", providerId: "provider", providerName: "Provider", modelId: "model", name: "Model", available: true, supportsImages: false,
  supportsFast: true, efforts: ["low", "medium", "high"], inputModalities: ["text"], outputModalities: ["text"], contextWindow: 8192, maximumOutputTokens: 2048,
  inputCostMicrosPerMillion: 0, outputCostMicrosPerMillion: 0, currencyCode: "USD" };
const session: SessionView = { id: "task", backendId: "backend", targetId: "target", name: "Task", state: "idle", generation: 1n,
  pinned: false, archived: false, updatedAt: 1, fastMode: false, planMode: false, permissionMode: "ask", effort: "medium", model };
const backend: BackendView = { id: "backend", name: "Backend", health: "healthy", version: "1", capabilities: new Map(
  ["model.effort", "model.fast_mode", "plan_mode", "turn.abort", "session.fork", "session.clone"].map((name) => [name, { name, supported: true, options: [] }])) };
const message: TimelineItemView = { id: "message", kind: "assistant", text: "Finished response", nativeEntryId: "native-entry", sourceEventId: "event", sequence: 1n, createdAt: 1 };

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
});

async function mount() {
  const api = { setModel: vi.fn<AppController["setModel"]>(async () => undefined), setPlanMode: vi.fn(async () => undefined),
    pinSession: vi.fn(async () => undefined), abort: vi.fn(async () => undefined), forkSession: vi.fn<AppController["forkSession"]>(async () => "forked"),
    cloneSession: vi.fn<AppController["cloneSession"]>(async () => "cloned"), navigate: vi.fn(), exportSession: vi.fn(), getArtifactUrl: vi.fn(), releaseArtifactUrl: vi.fn() };
  const archive = vi.fn(); const copy = vi.fn(); const pending: Promise<unknown>[] = [];
  const host = document.body.appendChild(document.createElement("div")); const root = createRoot(host); roots.push(root);
  const render = async (current = session, currentBackend = backend, readOnly = false) => {
    const snapshot = { ...emptySnapshot(), revision: 1n, sessions: [current], backends: [currentBackend], models: [model], timelineBySession: new Map([[current.id, [message]]]) };
    const controller = { ...api, state: { ready: true, connectionState: "connected", preferences: DEFAULT_UI_PREFERENCES, snapshot, route: { kind: "session", sessionId: current.id } } } as unknown as AppController;
    await act(async () => root.render(<SessionPane controller={controller} session={current} backend={currentBackend} reviewReadOnly={readOnly} models={[model]} timeline={[message]}
      timelineHasEarlier={false} timelineHistoryLoading={false} onLoadEarlierTimeline={async () => undefined} extensionWidgets={[]} extensionStatuses={[]}
      queue={[]} extraDirectories={[]} resources={[]} commandRefreshSignal={[]} remainingInteractions={0} navigationOpen inspectorOpen t={(key) => key}
      runAction={(_key, action) => { pending.push(action()); }} onOpenNavigation={() => undefined} onOpenInspector={() => undefined} onRename={() => undefined} onDelete={() => undefined}
      onArchive={archive} onCopyTaskLink={copy} />));
    host.querySelector<HTMLButtonElement>("button")!.focus();
  };
  await render();
  return { api, archive, copy, render, pending, host,
    menuLabels: () => [...host.querySelectorAll<HTMLButtonElement>("[role='menuitem']")].map((item) => item.textContent?.trim()),
    menuButton: (label: string) => {
      const item = [...host.querySelectorAll<HTMLButtonElement>("[role='menuitem']")].find((candidate) => candidate.textContent?.trim() === label);
      if (item === undefined) throw new Error(`Missing menu item: ${label}`);
      return item;
    },
    action: async (action: GamepadOwnedAction) => act(async () => { dispatchGamepadOwnedAction(document, action); }),
    flush: async () => act(async () => { await Promise.all(pending); }) };
}
