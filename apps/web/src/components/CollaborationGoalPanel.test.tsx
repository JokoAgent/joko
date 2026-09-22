// @vitest-environment jsdom

import { act, type JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import {
  emptySnapshot,
  type CollaborationGoalTreeView,
  type CollaborationGoalView,
  type CollaborationQueueEntryView,
  type CollaborationWorkerView,
  type SessionView,
  type TargetView
} from "../model.js";
import { CollaborationGoalPanel } from "./CollaborationGoalPanel.js";
import type { Translator } from "./types.js";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
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

describe("CollaborationGoalPanel", () => {
  it("uses exact worker and Queue revisions for contiguous merge and interrupt replacement", async () => {
    const current = tree();
    const mergeCollaborationDispatches = vi.fn(async () => current);
    const interruptCollaborationWorker = vi.fn(async () => ({ tree: current, stopOutcome: "unconfirmed" as const }));
    const view = controller({ mergeCollaborationDispatches, interruptCollaborationWorker });
    await render(panel(view));
    expect(host.textContent).toContain("Worker one");
    expect(host.textContent).toContain("First pending instruction");

    const queueChoices = [...host.querySelectorAll<HTMLButtonElement>(".collaboration-queue-item [role='checkbox']")];
    await act(async () => { queueChoices[0]!.click(); queueChoices[1]!.click(); });
    await act(async () => { button("collaboration.queueMerge").click(); await settle(); });
    expect(mergeCollaborationDispatches).toHaveBeenCalledWith(
      expect.objectContaining({ id: "goal-one", revision: 4n }),
      expect.objectContaining({ id: "worker-one", revision: 7n }),
      [
        expect.objectContaining({ dispatch: expect.objectContaining({ id: "dispatch-one", revision: 11n }), queueItem: expect.objectContaining({ revision: 21n }) }),
        expect.objectContaining({ dispatch: expect.objectContaining({ id: "dispatch-two", revision: 12n }), queueItem: expect.objectContaining({ revision: 22n }) })
      ],
      expect.any(AbortSignal)
    );

    const message = required(host.querySelector<HTMLTextAreaElement>(".collaboration-panel__message textarea"));
    await act(async () => changeValue(message, "Replace the active work safely"));
    await act(async () => { button("collaboration.interrupt").click(); await settle(); });
    expect(interruptCollaborationWorker).toHaveBeenCalledWith(
      expect.objectContaining({ id: "goal-one", revision: 4n }),
      expect.objectContaining({ id: "worker-one", revision: 7n, sessionGeneration: 3n }),
      "Replace the active work safely",
      expect.any(AbortSignal)
    );
    expect(host.textContent).toContain("collaboration.interruptOutcome.unconfirmed");
  });

  it("creates a Goal with the mounted lead generation and preserves a failed draft", async () => {
    const createCollaborationGoal = vi.fn()
      .mockRejectedValueOnce(new Error("hard limit"))
      .mockResolvedValueOnce(tree());
    const view = controller({
      listCollaborationGoals: vi.fn(async () => []),
      createCollaborationGoal
    });
    await render(panel(view));
    const inputs = [...host.querySelectorAll<HTMLInputElement>(".collaboration-panel__empty input")];
    const objective = required(host.querySelector<HTMLTextAreaElement>(".collaboration-panel__empty textarea"));
    await act(async () => {
      changeValue(inputs[0]!, "Ship collaboration");
      changeValue(objective, "Verify the complete durable lifecycle");
      changeValue(inputs[1]!, "3");
    });
    await act(async () => { button("collaboration.createGoal").click(); await settle(); });
    expect(createCollaborationGoal).toHaveBeenNthCalledWith(
      1, "lead-session", 9n, "Ship collaboration", "Verify the complete durable lifecycle", 3, expect.any(AbortSignal)
    );
    expect(inputs[0]!.value).toBe("Ship collaboration");
    expect(objective.value).toBe("Verify the complete durable lifecycle");
    expect(host.textContent).toContain("hard limit");

    await act(async () => { button("collaboration.createGoal").click(); await settle(); });
    expect(createCollaborationGoal).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("Worker one");
  });

  it("starts a new Goal after the prior Goal becomes terminal while retaining history", async () => {
    const archived = tree({
      goal: goal({ status: "archived", completedAt: 5_000 }),
      workers: [worker({ status: "archived", focused: false, runtimeReleased: true })],
      queue: [],
      focusedWorkerId: undefined
    });
    const next = tree({ goal: goal({ id: "goal-next", title: "Next Goal" }), workers: [], queue: [], focusedWorkerId: undefined });
    const createCollaborationGoal = vi.fn(async () => next);
    await render(panel(controller({
      listCollaborationGoals: vi.fn(async () => [archived.goal]),
      getCollaborationGoal: vi.fn(async () => archived),
      createCollaborationGoal
    })));

    expect(host.textContent).toContain("collaboration.newGoal");
    const form = required(host.querySelector<HTMLFormElement>(".collaboration-panel__empty"));
    const inputs = [...form.querySelectorAll<HTMLInputElement>("input")];
    const objective = required(form.querySelector<HTMLTextAreaElement>("textarea"));
    await act(async () => {
      changeValue(inputs[0]!, "Next Goal");
      changeValue(objective, "Continue the durable collaboration history.");
    });
    await act(async () => { button("collaboration.createGoal").click(); await settle(); });
    expect(createCollaborationGoal).toHaveBeenCalledWith(
      "lead-session", 9n, "Next Goal", "Continue the durable collaboration history.", undefined,
      expect.any(AbortSignal)
    );
    expect(host.textContent).toContain("Next Goal");
  });

  it("retires a late Goal response when the mounted connection owner changes", async () => {
    let resolveOld!: (value: readonly CollaborationGoalView[]) => void;
    const oldGoals = new Promise<readonly CollaborationGoalView[]>((resolve) => { resolveOld = resolve; });
    const old = controller({ listCollaborationGoals: vi.fn(() => oldGoals) });
    const nextTree = tree({ goal: { ...goal(), id: "goal-next", title: "New owner Goal" }, workers: [] });
    const next = controller({
      listCollaborationGoals: vi.fn(async () => [nextTree.goal]),
      getCollaborationGoal: vi.fn(async () => nextTree)
    });
    await render(panel(old, "owner-old"));
    await render(panel(next, "owner-next"));
    expect(host.textContent).toContain("New owner Goal");
    await act(async () => { resolveOld([goal({ title: "Old owner Goal" })]); await settle(); });
    expect(host.textContent).toContain("New owner Goal");
    expect(host.textContent).not.toContain("Old owner Goal");
  });

  it("uses QueueItem lifecycle authority so completed dispatch history is not shown as pending", async () => {
    const completed = tree({
      workers: [worker({ status: "completed" })],
      queue: [
        {
          ...queueEntry(0),
          queueItem: { ...queueEntry(0).queueItem!, state: "completed" }
        }
      ]
    });
    const setCollaborationGoalStatus = vi.fn(async () => ({
      ...completed,
      goal: { ...completed.goal, status: "completed" as const }
    }));
    const view = controller({
      listCollaborationGoals: vi.fn(async () => [completed.goal]),
      getCollaborationGoal: vi.fn(async () => completed),
      setCollaborationGoalStatus
    });
    await render(panel(view));

    expect(host.textContent).not.toContain("First pending instruction");
    expect(host.textContent).toContain("collaboration.queueEmpty");
    const complete = button("collaboration.endGoal");
    expect(complete.disabled).toBe(false);
    await act(async () => { complete.click(); await settle(); });
    expect(setCollaborationGoalStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: "goal-one" }),
      "completed",
      expect.any(AbortSignal)
    );
  });

  it("moves keyboard focus into the opened panel and closes it with Escape", async () => {
    const onClose = vi.fn();
    await render(panel(controller(), "owner-keyboard", onClose));
    const region = required(host.querySelector<HTMLElement>(".collaboration-panel"));
    expect(document.activeElement).toBe(region);

    await act(async () => region.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true
    })));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("requires explicit confirmation before stopping and archiving the Goal's workers", async () => {
    const setCollaborationGoalStatus = vi.fn(async () => tree({
      goal: goal({ status: "stopped", completedAt: 5_000 })
    }));
    await render(panel(controller({ setCollaborationGoalStatus })));

    await act(async () => button("collaboration.stopGoal").click());
    expect(setCollaborationGoalStatus).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("collaboration.stopConfirmTitle");
    await act(async () => button("common.cancel", document.body).click());
    expect(setCollaborationGoalStatus).not.toHaveBeenCalled();

    await act(async () => button("collaboration.stopGoal").click());
    await act(async () => { button("collaboration.stopConfirmAction", document.body).click(); await settle(); });
    expect(setCollaborationGoalStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: "goal-one", revision: 4n }),
      "stopped",
      expect.any(AbortSignal)
    );
  });

  it("does not overlap polling and preserves an explicit history selection over a late refresh", async () => {
    vi.useFakeTimers();
    let resolveRefresh!: (value: readonly CollaborationGoalView[]) => void;
    const refresh = new Promise<readonly CollaborationGoalView[]>((resolve) => { resolveRefresh = resolve; });
    const first = tree();
    const second = tree({
      goal: goal({ id: "goal-two", title: "Selected history Goal" }),
      workers: [],
      queue: [],
      focusedWorkerId: undefined
    });
    const listCollaborationGoals = vi.fn()
      .mockResolvedValueOnce([first.goal, second.goal])
      .mockReturnValueOnce(refresh);
    const getCollaborationGoal = vi.fn(async (id: string) => id === second.goal.id ? second : first);
    await render(panel(controller({ listCollaborationGoals, getCollaborationGoal })));

    await act(async () => { vi.advanceTimersByTime(2_500); await settle(); });
    expect(listCollaborationGoals).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(7_500); await settle(); });
    expect(listCollaborationGoals).toHaveBeenCalledTimes(2);

    const history = required(host.querySelector<HTMLSelectElement>(".collaboration-panel__goal select"));
    await act(async () => { changeSelect(history, second.goal.id); await settle(); });
    expect(host.textContent).toContain("Selected history Goal");

    await act(async () => { resolveRefresh([first.goal, second.goal]); await settle(); });
    expect(host.textContent).toContain("Selected history Goal");
    expect(getCollaborationGoal).toHaveBeenCalledTimes(2);
  });

  it("shows a worker task's parent Goal without granting lead mutations or nested Goal creation", async () => {
    const current = tree();
    const createCollaborationGoal = vi.fn(async () => current);
    const stopCollaborationWorker = vi.fn(async () => current);
    const view = controller({ createCollaborationGoal, stopCollaborationWorker });
    await render(panel(view, "owner-worker", () => undefined, session({ id: "worker-session", name: "Worker" })));

    expect(view.listCollaborationGoals).toHaveBeenCalledWith("worker-session", true, expect.any(AbortSignal));
    expect(view.getCollaborationGoal).toHaveBeenCalledWith("goal-one", "worker-session", expect.any(AbortSignal));
    expect(host.textContent).toContain("collaboration.workerReadOnly");
    expect(button("collaboration.stopGoal").disabled).toBe(true);
    expect(button("collaboration.addWorker").disabled).toBe(true);
    expect(button("common.stop").disabled).toBe(true);
    expect(host.textContent).not.toContain("collaboration.createGoal");
    expect(createCollaborationGoal).not.toHaveBeenCalled();
    expect(stopCollaborationWorker).not.toHaveBeenCalled();
  });
});

function panel(
  value: AppController,
  ownerKey = "owner-one",
  onClose = () => undefined,
  sessionValue = session()
): JSX.Element {
  return <CollaborationGoalPanel
    controller={value}
    session={sessionValue}
    models={[]}
    locale="en"
    ownerKey={ownerKey}
    open
    readOnly={false}
    onClose={onClose}
    t={t}
  />;
}

async function render(value: JSX.Element): Promise<void> {
  await act(async () => { root.render(value); await settle(); });
}

function controller(overrides: Partial<AppController> = {}): AppController {
  const value = tree();
  const snapshot = { ...emptySnapshot(), targets: [target()] };
  return {
    state: { snapshot },
    listCollaborationGoals: vi.fn(async () => [value.goal]),
    getCollaborationGoal: vi.fn(async () => value),
    createCollaborationGoal: vi.fn(async () => value),
    setCollaborationGoalStatus: vi.fn(async () => value),
    createCollaborationWorker: vi.fn(async () => value),
    updateCollaborationWorker: vi.fn(async () => value),
    focusCollaborationWorker: vi.fn(async () => value),
    wakeCollaborationWorker: vi.fn(async () => value),
    stopCollaborationWorker: vi.fn(async () => value),
    releaseCollaborationWorker: vi.fn(async () => value),
    archiveCollaborationWorker: vi.fn(async () => value),
    sendCollaborationWorkerMessage: vi.fn(async () => value),
    interruptCollaborationWorker: vi.fn(async () => ({ tree: value, stopOutcome: "stopped" })),
    editCollaborationDispatch: vi.fn(async () => value),
    cancelCollaborationDispatch: vi.fn(async () => value),
    mergeCollaborationDispatches: vi.fn(async () => value),
    navigate: vi.fn(),
    ...overrides
  } as unknown as AppController;
}

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "lead-session",
    backendId: "backend-one",
    targetId: "target-one",
    name: "Lead",
    state: "idle",
    pinned: false,
    archived: false,
    generation: 9n,
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    updatedAt: 9_000,
    ...overrides
  };
}

function target(): TargetView {
  return {
    id: "target-one",
    revision: 1n,
    backendId: "backend-one",
    name: "Workspace",
    workspaceId: "workspace-one",
    workspaceName: "Workspace",
    trusted: true,
    pinned: false,
    archived: false
  };
}

function goal(overrides: Partial<CollaborationGoalView> = {}): CollaborationGoalView {
  return {
    id: "goal-one",
    revision: 4n,
    leadId: "lead-one",
    leadSessionId: "lead-session",
    backendId: "backend-one",
    targetId: "target-one",
    sessionGeneration: 9n,
    backendInstanceGeneration: 2n,
    title: "Durable collaboration",
    objective: "Exercise every collaboration boundary",
    maximumWorkers: 4,
    status: "active",
    createdAt: 1_000,
    updatedAt: 4_000,
    ...overrides
  };
}

function worker(overrides: Partial<CollaborationWorkerView> = {}): CollaborationWorkerView {
  return {
    id: "worker-one",
    revision: 7n,
    goalId: "goal-one",
    sessionId: "worker-session",
    route: {
      backendId: "backend-one",
      targetId: "target-one",
      providerId: "provider-one",
      modelId: "model-one",
      effort: "high",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    },
    sessionGeneration: 3n,
    backendInstanceGeneration: 2n,
    label: "Worker one",
    role: "Verifier",
    assignment: "Validate the queue and interrupt lifecycle",
    status: "running",
    focused: true,
    runtimeReleased: false,
    softLimitWarning: false,
    createdAt: 2_000,
    updatedAt: 4_000,
    ...overrides
  };
}

function queueEntry(index: number): CollaborationQueueEntryView {
  const word = ["First", "Second", "Third"][index]!;
  const number = index + 1;
  const message = `${word} pending instruction`;
  return {
    dispatch: {
      id: `dispatch-${["one", "two", "three"][index]}`,
      revision: BigInt(10 + number),
      goalId: "goal-one",
      workerId: "worker-one",
      callerLeadSessionId: "lead-session",
      operationId: `operation-${number}`,
      queueItemId: `queue-${number}`,
      message,
      status: "queued",
      createdAt: 3_000 + index,
      updatedAt: 3_000 + index
    },
    queueItem: {
      id: `queue-${number}`,
      sessionId: "worker-session",
      revision: BigInt(20 + number),
      generation: 3n,
      source: "user",
      mode: "followUp",
      text: message,
      state: "accepted",
      editLocked: false,
      ordinal: index,
      createdAt: 3_000 + index
    }
  };
}

function tree(overrides: Partial<CollaborationGoalTreeView> = {}): CollaborationGoalTreeView {
  return {
    goal: goal(),
    workers: [worker()],
    queue: [queueEntry(0), queueEntry(1), queueEntry(2)],
    focusedWorkerId: "worker-one",
    ...overrides
  };
}

function button(label: string, container: ParentNode = host): HTMLButtonElement {
  const result = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.includes(label));
  if (result === undefined) throw new Error(`Missing ${label} button.`);
  return result;
}

function changeValue(control: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter === undefined) throw new Error("Missing native value setter.");
  setter.call(control, value);
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
}

function changeSelect(control: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  if (setter === undefined) throw new Error("Missing native select value setter.");
  setter.call(control, value);
  control.dispatchEvent(new Event("change", { bubbles: true }));
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected rendered value.");
  return value;
}

const t: Translator = (key) => key;

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
