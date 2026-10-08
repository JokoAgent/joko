// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import type { ObjectiveView, ObjectiveWatchUpdateView, SessionView } from "../model.js";
import { ObjectiveIndicator, type ObjectiveDialogRequest } from "./ObjectiveIndicator.js";

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
  vi.unstubAllGlobals();
});

describe("ObjectiveIndicator", () => {
  it("waits for the initial owner snapshot and never replaces an edited Dialog draft with a later watch update", async () => {
    let resolveInitial!: (value: ObjectiveView | undefined) => void;
    const initial = new Promise<ObjectiveView | undefined>((resolve) => { resolveInitial = resolve; });
    const updates = watchChannel();
    const controller = objectiveController({
      getObjective: vi.fn(() => initial),
      watchObjective: vi.fn(updates.watch)
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

    await act(async () => updates.emit({ kind: "objective", objective: objective("Remote replacement", 2n) }));
    await vi.waitFor(() => expect(document.querySelector(".objective-indicator__text")?.textContent).toBe("Remote replacement"));
    expect(textarea.value).toBe("Owner-edited draft");
  });

  it("keeps an edit draft across same-owner revisions and rejects a replacement owner", async () => {
    const updates = watchChannel();
    const controller = objectiveController({
      getObjective: vi.fn(async () => objective("Original objective", 1n)),
      watchObjective: vi.fn(updates.watch)
    });
    await render(controller);
    await vi.waitFor(() => expect(document.querySelector(".objective-indicator__text")?.textContent).toBe("Original objective"));
    await act(async () => required(document.querySelector<HTMLButtonElement>('button[aria-label="common.edit"]')).click());
    const textarea = await waitForTextarea();
    await act(async () => changeValue(textarea, "Owner-edited draft"));

    await act(async () => updates.emit({ kind: "objective", objective: objective("Settled current text", 2n) }));
    await vi.waitFor(() => expect(document.querySelector(".objective-indicator__text")?.textContent).toBe("Settled current text"));
    expect(textarea.value).toBe("Owner-edited draft");

    await act(async () => updates.emit({
      kind: "objective",
      objective: { ...objective("Replacement owner", 3n), ownerGeneration: 4n }
    }));
    await vi.waitFor(() => expect(document.querySelector(".objective-indicator__text")?.textContent).toBe("Replacement owner"));
    await act(async () => { primaryButton().click(); await settle(); });
    expect(controller.updateObjective).not.toHaveBeenCalled();
    expect(controller.setObjective).not.toHaveBeenCalled();
    expect(textarea.value).toBe("Owner-edited draft");
    expect(document.querySelector("[role='alert']")?.textContent).toContain("objective.ownerChanged");
  });

  it("does not turn a create Dialog into an update when another owner appears", async () => {
    const updates = watchChannel();
    const controller = objectiveController({
      getObjective: vi.fn(async () => undefined),
      watchObjective: vi.fn(updates.watch)
    });
    await render(controller);
    await vi.waitFor(() => expect(controller.watchObjective).toHaveBeenCalledTimes(1));
    await render(controller, dialogRequest(2));
    const textarea = await waitForTextarea();
    await act(async () => changeValue(textarea, "Create-owner draft"));

    await act(async () => updates.emit({
      kind: "objective",
      objective: { ...objective("Concurrent owner", 1n), ownerGeneration: 8n }
    }));
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

  it.each([
    ["profile", { profileId: "profile-two" }],
    ["session", { sessionId: "task-two" }],
    ["session generation", { sessionGeneration: 10n }],
    ["connection", { connectionGeneration: 2 }]
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
  onDialogRequestHandled = vi.fn()
): Promise<void> {
  await act(async () => root.render(<ObjectiveIndicator
    controller={controller}
    session={session}
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
      activeProfile: { id: "profile-one", serverId: "server-one" },
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

function watchChannel(): {
  readonly watch: (_sessionId: string, _afterRevision?: bigint, signal?: AbortSignal) => AsyncGenerator<ObjectiveWatchUpdateView>;
  readonly emit: (update: ObjectiveWatchUpdateView) => void;
} {
  const queued: ObjectiveWatchUpdateView[] = [];
  let pending: ((value: ObjectiveWatchUpdateView | undefined) => void) | undefined;
  return {
    watch: async function* (_sessionId, _afterRevision, signal) {
      while (signal?.aborted !== true) {
        const update = queued.shift() ?? await new Promise<ObjectiveWatchUpdateView | undefined>((resolve) => {
          pending = resolve;
          signal?.addEventListener("abort", () => resolve(undefined), { once: true });
        });
        if (update === undefined) return;
        yield update;
      }
    },
    emit: (update) => {
      const resolve = pending;
      pending = undefined;
      if (resolve === undefined) queued.push(update);
      else resolve(update);
    }
  };
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
