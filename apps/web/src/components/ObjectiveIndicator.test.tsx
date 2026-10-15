// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import type { ObjectiveView, SessionView } from "../model.js";
import { ObjectiveIndicator, type ObjectiveDialogRequest } from "./ObjectiveIndicator.js";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ObjectiveIndicator", () => {
  it("waits for the initial owner snapshot and never replaces an edited Dialog draft with a later snapshot", async () => {
    let resolveInitial!: (value: ObjectiveView | undefined) => void;
    const initial = new Promise<ObjectiveView | undefined>((resolve) => { resolveInitial = resolve; });
    const updates = snapshotChannel();
    const controller = objectiveController({
      getObjective: vi.fn(updates.get).mockImplementationOnce(() => initial)
    });
    const handled = vi.fn();

    await render(controller, undefined, handled);
    await vi.waitFor(() => expect(controller.getObjective).toHaveBeenCalledTimes(1));
    const request = dialogRequest(1);
    await render(controller, request, handled);
    expect(document.querySelector(".objective-dialog")).toBeNull();
    expect(document.body.textContent).toContain("objective.loading");

    await act(async () => resolveInitial(objective("Original objective", 1n)));
    const textarea = await waitForTextarea();
    expect(textarea.value).toBe("Original objective");
    await act(async () => changeValue(textarea, "Owner-edited draft"));

    updates.emit(objective("Remote replacement", 2n)); await poll();
    await vi.waitFor(() => expect(document.querySelector(".objective-indicator__text")?.textContent).toBe("Remote replacement"));
    expect(textarea.value).toBe("Owner-edited draft");
  });

  it("keeps an edit draft across same-owner revisions and rejects a replacement owner", async () => {
    const updates = snapshotChannel(objective("Original objective", 1n));
    const controller = objectiveController({
      getObjective: vi.fn(updates.get)
    });
    await render(controller);
    await vi.waitFor(() => expect(document.querySelector(".objective-indicator__text")?.textContent).toBe("Original objective"));
    await act(async () => required(document.querySelector<HTMLButtonElement>('button[aria-label="common.edit"]')).click());
    const textarea = await waitForTextarea();
    await act(async () => changeValue(textarea, "Owner-edited draft"));

    updates.emit(objective("Settled current text", 2n)); await poll();
    await vi.waitFor(() => expect(document.querySelector(".objective-indicator__text")?.textContent).toBe("Settled current text"));
    expect(textarea.value).toBe("Owner-edited draft");

    updates.emit(objective("Older revision", 1n)); await poll();
    expect(document.querySelector(".objective-indicator__text")?.textContent).toBe("Settled current text");

    updates.emit({ ...objective("Replacement owner", 3n), ownerGeneration: 4n }); await poll();
    await vi.waitFor(() => expect(document.querySelector(".objective-indicator__text")?.textContent).toBe("Replacement owner"));
    await act(async () => { primaryButton().click(); await settle(); });
    expect(controller.updateObjective).not.toHaveBeenCalled();
    expect(controller.setObjective).not.toHaveBeenCalled();
    expect(textarea.value).toBe("Owner-edited draft");
    expect(document.querySelector("[role='alert']")?.textContent).toContain("objective.ownerChanged");
  });

  it("does not turn a create Dialog into an update when another owner appears", async () => {
    const updates = snapshotChannel();
    const controller = objectiveController({
      getObjective: vi.fn(updates.get)
    });
    await render(controller);
    await vi.waitFor(() => expect(controller.getObjective).toHaveBeenCalledTimes(1));
    expect(controller.watchObjective).not.toHaveBeenCalled();
    await render(controller, dialogRequest(2));
    const textarea = await waitForTextarea();
    await act(async () => changeValue(textarea, "Create-owner draft"));

    updates.emit({ ...objective("Concurrent owner", 1n), ownerGeneration: 8n }); await poll();
    await vi.waitFor(() => expect(document.querySelector(".objective-indicator__text")?.textContent).toBe("Concurrent owner"));
    await act(async () => { primaryButton().click(); await settle(); });
    expect(controller.setObjective).not.toHaveBeenCalled();
    expect(controller.updateObjective).not.toHaveBeenCalled();
    expect(textarea.value).toBe("Create-owner draft");
    expect(document.querySelector("[role='alert']")?.textContent).toContain("objective.ownerChanged");
  });

  it("starts a replacement lifecycle when a completed Objective is edited", async () => {
    const completed = { ...objective("Finished objective", 4n), status: "complete" as const };
    const controller = objectiveController({
      getObjective: vi.fn(async () => completed),
      watchObjective: vi.fn(async function* (_sessionId: string, _afterRevision?: bigint, signal?: AbortSignal) {
        await untilAborted(signal);
      })
    });
    await render(controller);
    await vi.waitFor(() => expect(document.querySelector(".objective-indicator__text")?.textContent).toBe("Finished objective"));
    const edit = required(document.querySelector<HTMLButtonElement>('button[aria-label="common.edit"]'));
    await act(async () => edit.click());
    const textarea = await waitForTextarea();
    await act(async () => changeValue(textarea, "Replacement objective"));
    await act(async () => { primaryButton().click(); await settle(); });

    expect(controller.setObjective).toHaveBeenCalledWith(
      session.id,
      session.generation,
      "Replacement objective",
      { noProgressTurnLimit: 3 },
      expect.any(Object)
    );
    expect(controller.updateObjective).not.toHaveBeenCalled();
  });

  it("keeps a valid mount-time handoff until the initial Objective snapshot is ready", async () => {
    let resolveInitial!: (value: ObjectiveView | undefined) => void;
    const initial = new Promise<ObjectiveView | undefined>((resolve) => { resolveInitial = resolve; });
    const controller = objectiveController({
      getObjective: vi.fn(() => initial)
    });
    const handled = vi.fn();

    await render(controller, dialogRequest("home-goal"), handled);
    expect(handled).not.toHaveBeenCalled();
    expect(document.querySelector(".objective-dialog")).toBeNull();
    expect(document.body.textContent).toContain("objective.loading");

    await act(async () => resolveInitial(undefined));
    await waitForTextarea();
    expect(handled).not.toHaveBeenCalled();
  });

  it("bounds a single snapshot flight, continues through absence and read failures, and supports explicit observation retry", async () => {
    let resolveInitial!: (value: ObjectiveView | undefined) => void;
    let firstSignal!: AbortSignal;
    const initial = new Promise<ObjectiveView | undefined>(resolve => { resolveInitial = resolve; });
    const controller = objectiveController({ getObjective: vi.fn<AppController["getObjective"]>(async () => objective("Recovered", 3n))
      .mockImplementationOnce((_id, signal) => { firstSignal = signal!; return initial; })
      .mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Observation unavailable")) });
    await render(controller);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(firstSignal.aborted).toBe(true); expect(controller.getObjective).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("objective.loadFailed");
    await act(async () => resolveInitial(objective("Late timed out snapshot", 1n)));
    expect(document.body.textContent).not.toContain("Late timed out snapshot");
    await poll(); expect(controller.getObjective).toHaveBeenCalledTimes(2);
    expect(document.querySelector("[role='alert']")).toBeNull();
    await poll(); expect(document.body.textContent).toContain("Observation unavailable");
    await act(async () => required(document.querySelector<HTMLButtonElement>(".objective-indicator--error button")).click());
    expect(document.querySelector(".objective-indicator__text")?.textContent).toBe("Recovered");
    expect(controller.getObjective).toHaveBeenCalledTimes(4); expect(controller.watchObjective).not.toHaveBeenCalled();
  });

  it.each(["clear", "replace"] as const)("adopts a local %s receipt immediately and fences an older in-flight snapshot before refreshing", async action => {
    let snapshot: ObjectiveView | undefined = { ...objective("Original", 8n), status: action === "replace" ? "complete" : "active" };
    let resolveOld!: (value: ObjectiveView | undefined) => void;
    let oldSignal!: AbortSignal;
    const old = new Promise<ObjectiveView | undefined>(resolve => { resolveOld = resolve; });
    const getObjective = vi.fn<AppController["getObjective"]>(async () => snapshot).mockImplementationOnce(async () => snapshot)
      .mockImplementationOnce((_id, signal) => { oldSignal = signal!; return old; });
    const controller = objectiveController({ getObjective,
      clearObjective: vi.fn(async () => { snapshot = undefined; }),
      setObjective: vi.fn(async (_id, _generation, text) => { snapshot = { ...objective(text, 1n), ownerGeneration: 4n }; return snapshot; }) });
    await render(controller); await poll(); expect(getObjective).toHaveBeenCalledTimes(2);
    if (action === "clear") {
      await act(async () => { required(document.querySelector<HTMLButtonElement>('button[aria-label="objective.clear"]')).click(); await settle(); });
      expect(document.querySelector(".objective-indicator__text")).toBeNull();
    } else {
      await act(async () => required(document.querySelector<HTMLButtonElement>('button[aria-label="common.edit"]')).click());
      const textarea = await waitForTextarea(); await act(async () => changeValue(textarea, "Replacement receipt"));
      await act(async () => { primaryButton().click(); await settle(); });
      expect(document.querySelector(".objective-indicator__text")?.textContent).toBe("Replacement receipt");
    }
    expect(oldSignal.aborted).toBe(true); expect(getObjective).toHaveBeenCalledTimes(2);
    await act(async () => resolveOld(objective("Stale pre-mutation", 9n)));
    expect(getObjective).toHaveBeenCalledTimes(3);
    expect(document.body.textContent).not.toContain("Stale pre-mutation");
    expect(document.querySelector(".objective-indicator__text")?.textContent).toBe(action === "clear" ? undefined : "Replacement receipt");
    expect(controller.watchObjective).not.toHaveBeenCalled();
  });

  it("observes after an unknown write without replaying the mutation", async () => {
    const controller = objectiveController({ clearObjective: vi.fn(async () => { throw new Error("Write outcome unknown"); }) });
    await render(controller);
    await act(async () => { required(document.querySelector<HTMLButtonElement>('button[aria-label="objective.clear"]')).click(); await settle(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(controller.clearObjective).toHaveBeenCalledTimes(1);
    expect(controller.getObjective).toHaveBeenCalledTimes(5);
    expect(document.body.textContent).toContain("Write outcome unknown");
  });

  it.each(["profile", "server", "origin", "connection", "session", "sessionGeneration"] as const)("retires an in-flight read when its exact %s changes", async change => {
    let resolveOld!: (value: ObjectiveView | undefined) => void;
    let oldSignal!: AbortSignal;
    const old = new Promise<ObjectiveView | undefined>(resolve => { resolveOld = resolve; });
    let currentSession = session;
    const controller = objectiveController({ getObjective: vi.fn<AppController["getObjective"]>(async () => ({ ...objective("New owner", 2n), sessionId: currentSession.id, sessionGeneration: currentSession.generation }))
      .mockImplementationOnce((_id, signal) => { oldSignal = signal!; return old; }) });
    await render(controller);
    const profile = controller.state.activeProfile!;
    if (change === "session") currentSession = { ...session, id: "new-session" };
    else if (change === "sessionGeneration") currentSession = { ...session, generation: 10n };
    else if (change === "connection") Object.assign(controller.state, { connectionGeneration: 2 });
    else Object.assign(controller.state, { activeProfile: { ...profile,
      ...(change === "profile" ? { id: "profile-two" } : change === "server" ? { serverId: "server-two" } : { origin: "http://localhost:4518" }) } });
    await render(controller, undefined, vi.fn(), currentSession);
    expect(oldSignal.aborted).toBe(true);
    await act(async () => resolveOld(objective("Old owner", 99n)));
    expect(document.querySelector(".objective-indicator__text")?.textContent).toBe("New owner");
  });

  it.each(["pagehide", "unmount"] as const)("aborts a snapshot and rejects its late result after %s", async retirement => {
    let resolveOld!: (value: ObjectiveView | undefined) => void;
    let signal!: AbortSignal;
    const controller = objectiveController({ getObjective: vi.fn<AppController["getObjective"]>((_id, value) => { signal = value!; return new Promise(resolve => { resolveOld = resolve; }); }) });
    await render(controller);
    await act(async () => {
      if (retirement === "pagehide") window.dispatchEvent(new Event("pagehide"));
      else root.unmount();
    });
    expect(signal.aborted).toBe(true);
    await act(async () => resolveOld(objective("Retired result", 3n)));
    await poll(); expect(controller.getObjective).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("Retired result");
    if (retirement === "unmount") root = createRoot(host);
  });

  it("binds observation retirement to the actual host Window", async () => {
    await act(async () => root.unmount()); host.remove();
    const frame = document.body.appendChild(document.createElement("iframe"));
    const frameDocument = required(frame.contentDocument), frameWindow = required(frame.contentWindow);
    host = frameDocument.body.appendChild(frameDocument.createElement("div")); root = createRoot(host);
    let signal!: AbortSignal; let resolveOld!: (value: ObjectiveView | undefined) => void;
    const controller = objectiveController({ getObjective: vi.fn<AppController["getObjective"]>((_id, value) => { signal = value!; return new Promise(resolve => { resolveOld = resolve; }); }) });
    await render(controller);
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(signal.aborted).toBe(false);
    await act(async () => frameWindow.dispatchEvent(new Event("pagehide")));
    expect(signal.aborted).toBe(true);
    await act(async () => resolveOld(objective("Retired host", 3n)));
    expect(host.textContent).not.toContain("Retired host");
  });

  it.each([
    ["profile", { profileId: "profile-two" }],
    ["session", { sessionId: "task-two" }],
    ["session generation", { sessionGeneration: 10n }],
    ["connection", { connectionGeneration: 2 }],
    ["origin", { origin: "http://localhost:4518" }]
  ] as const)("retires a %s-mismatched handoff without opening it", async (_label, overrides) => {
    const controller = objectiveController();
    const handled = vi.fn();
    await render(controller, dialogRequest("stale", overrides), handled);
    await vi.waitFor(() => expect(handled).toHaveBeenCalledTimes(1));
    expect(document.querySelector(".objective-dialog")).toBeNull();
  });
});

const session: SessionView = {
  id: "task-one",
  backendId: "backend-one",
  targetId: "target-one",
  name: "Task one",
  state: "idle",
  pinned: false,
  archived: false,
  generation: 9n,
  fastMode: false,
  permissionMode: "ask",
  planMode: false,
  updatedAt: 1
};
const t = (key: string): string => key;

function dialogRequest(
  id: string | number,
  overrides: Partial<ObjectiveDialogRequest> = {}
): ObjectiveDialogRequest {
  return {
    id,
    serverId: "server-one",
    profileId: "profile-one",
    origin: "http://localhost:4318",
    connectionGeneration: 1,
    sessionId: session.id,
    sessionGeneration: session.generation,
    onSaved: vi.fn(),
    ...overrides
  };
}

async function render(
  controller: AppController,
  dialogRequest?: ObjectiveDialogRequest,
  onDialogRequestHandled = vi.fn(),
  currentSession = session
): Promise<void> {
  await act(async () => root.render(<ObjectiveIndicator
    controller={controller}
    session={currentSession}
    readOnly={false}
    dialogRequest={dialogRequest}
    onDialogRequestHandled={onDialogRequestHandled}
    t={t}
  />));
}

function objective(text: string, revision: bigint): ObjectiveView {
  return {
    sessionId: session.id,
    text,
    status: "active",
    maximumTurns: undefined,
    tokenBudget: undefined,
    noProgressTurnLimit: 3,
    turnsUsed: 2,
    tokensUsed: 1_000,
    noProgressTurns: 0,
    ownerGeneration: 3n,
    sessionGeneration: session.generation,
    startedAt: 1,
    revision
  };
}

function objectiveController(overrides: Partial<AppController> = {}): AppController {
  const current = objective("Current", 1n);
  return {
    state: {
      connectionState: "connected",
      connectionGeneration: 1,
      activeProfile: { id: "profile-one", serverId: "server-one", origin: "http://localhost:4318" },
      effectiveLocale: "en"
    },
    getObjective: vi.fn(async () => current),
    watchObjective: vi.fn(async function* (_sessionId: string, _afterRevision?: bigint, signal?: AbortSignal) {
      await untilAborted(signal);
    }),
    setObjective: vi.fn(async (_sessionId, _generation, text) => objective(text, current.revision + 1n)),
    updateObjective: vi.fn(async (_current, patch) => ({ ...current, ...patch, revision: current.revision + 1n })),
    pauseObjective: vi.fn(async () => current),
    resumeObjective: vi.fn(async () => current),
    clearObjective: vi.fn(async () => undefined),
    ...overrides
  } as unknown as AppController;
}

function snapshotChannel(initial?: ObjectiveView): {
  readonly get: () => Promise<ObjectiveView | undefined>;
  readonly emit: (update: ObjectiveView | undefined) => void;
} {
  let current = initial;
  return {
    get: async () => current,
    emit: update => { current = update; }
  };
}

async function poll(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
}

async function untilAborted(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return;
  await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
}

async function waitForTextarea(): Promise<HTMLTextAreaElement> {
  await vi.waitFor(() => {
    expect(document.querySelector<HTMLTextAreaElement>(".objective-dialog textarea")).not.toBeNull();
  });
  return required(document.querySelector<HTMLTextAreaElement>(".objective-dialog textarea"));
}

function primaryButton(): HTMLButtonElement {
  return required(document.querySelector<HTMLButtonElement>(".objective-dialog .button--primary"));
}

function changeValue(element: HTMLTextAreaElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected value.");
  return value;
}
