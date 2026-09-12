// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { emptySnapshot, type BackendView, type ScheduleView, type SessionView, type TargetView, type WorkspaceView } from "../model.js";
import type { WorktreeRemovalPreflightSummary } from "../worktree-removal-preflight.js";
import { SchedulesPage } from "./SchedulesPage.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("Schedule editor isolated workspace controls", () => {
  it("probes independently from enabled state and submits the selected source and refresh behavior", async () => {
    const saveSchedule = vi.fn(async () => undefined);
    const probeTargetWorktree = vi.fn(async () => ({
      targetId: "target-one",
      eligibility: "eligible" as const,
      repositoryRoot: "D:\\workspace",
      currentBranch: "main",
      headCommit: "a".repeat(40),
      canRefreshRemote: true
    }));
    const listTargetWorktreeSources = vi.fn(async () => [{
      ref: "refs/heads/main",
      commit: "a".repeat(40),
      name: "main",
      remote: false,
      current: true
    }, {
      ref: "refs/heads/release",
      commit: "b".repeat(40),
      name: "release",
      remote: false,
      current: false
    }]);
    const snapshot = {
      ...emptySnapshot(),
      workspaces: [workspace]
    };
    const controller = {
      state: { snapshot, preferences: { navigationOpen: true } },
      getSchedulerRuntime: async () => ({
        instanceId: "scheduler-test",
        inFlight: 0,
        slotsInUse: 0,
        maxConcurrentRuns: 8,
        runs: [],
        waiting: []
      }),
      probeTargetWorktree,
      listTargetWorktreeSources,
      saveSchedule
    } as unknown as AppController;
    const container = await render(controller);

    await act(async () => findButton(container, "New schedule").click());
    await act(async () => Promise.resolve());
    expect(probeTargetWorktree).toHaveBeenCalledWith("target-one", expect.any(AbortSignal));
    expect(listTargetWorktreeSources).toHaveBeenCalledWith("target-one", expect.any(AbortSignal));

    const isolation = container.querySelector<HTMLElement>('.new-task-worktree[aria-label="Isolated worktree"]')!;
    const enable = isolation.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(enable.disabled).toBe(false);
    await act(async () => enable.click());

    const source = isolation.querySelector<HTMLSelectElement>("select")!;
    await act(async () => setValue(source, "refs/heads/release", "change"));
    const refresh = isolation.querySelector<HTMLInputElement>(".new-task-worktree__refresh input")!;
    await act(async () => refresh.click());
    await act(async () => setValue(findInputByLabel(container, "Name"), "Release review", "input"));
    await act(async () => setValue(container.querySelector<HTMLTextAreaElement>("textarea")!, "Inspect the release branch", "input"));

    const submit = container.querySelector<HTMLButtonElement>('form button[type="submit"]')!;
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    await act(async () => Promise.resolve());

    expect(saveSchedule).toHaveBeenCalledWith(undefined, expect.objectContaining({
      enabled: true,
      sessionMode: "fresh",
      executionMode: "agent",
      useWorktree: true,
      worktreeSourceRef: "refs/heads/release",
      refreshWorktreeRemote: true
    }));

    await act(async () => findButton(container, "New schedule").click());
    await act(async () => Promise.resolve());
    await act(async () => setValue(findSelectByLabel(container, "Use a template"), "nightly-test-repair", "change"));
    await act(async () => findButton(container, "Use a template").click());
    expect(findInputByLabel(container, "Name").value).toBe("Nightly test self-healing");
    expect(container.querySelector<HTMLInputElement>('.new-task-worktree input[type="checkbox"]')?.checked).toBe(true);
  });
});

describe("Schedule deletion worktree preview", () => {
  it("shows dirty and unknown workspace warnings for archive and delete choices", async () => {
    const view = await renderDeletion(vi.fn(async () => ({ clean: 0, dirty: 1, unknown: 1 })));
    const dialog = await view.openDeleteDialog();

    await act(async () => radioWithText(dialog, "Archive tasks").click());
    expect(dialog.textContent).toContain("Workspaces with uncommitted changes: 1. Their exact state will be preserved for restoration.");
    expect(dialog.textContent).toContain("Workspace states that could not be verified: 1. Review them before continuing.");

    await act(async () => radioWithText(dialog, "Delete tasks").click());
    expect(dialog.textContent).toContain("Workspaces with uncommitted changes: 1. Their recovery snapshots will be transferred to the repository stash.");
    expect(dialog.textContent).toContain("Workspace states that could not be verified: 1. Review them before continuing.");
  });

  it("stops deletion when the confirmation preview changes and requires confirmation of the new state", async () => {
    const initial = { clean: 2, dirty: 0, unknown: 0 } as const;
    const changed = { clean: 1, dirty: 1, unknown: 0 } as const;
    const prepareSessionRemoval = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValue(changed);
    const view = await renderDeletion(prepareSessionRemoval);
    const dialog = await view.openDeleteDialog();
    await act(async () => radioWithText(dialog, "Archive tasks").click());

    await act(async () => findButton(dialog, "Delete schedule").click());
    await vi.waitFor(() => expect(prepareSessionRemoval).toHaveBeenCalledTimes(2));
    expect(view.deleteSchedule).not.toHaveBeenCalled();
    expect(dialog.textContent).toContain("Workspaces with uncommitted changes: 1. Their exact state will be preserved for restoration.");

    await act(async () => findButton(dialog, "Delete schedule").click());
    await vi.waitFor(() => expect(view.deleteSchedule).toHaveBeenCalledExactlyOnceWith("schedule-one", "archive"));
    expect(prepareSessionRemoval).toHaveBeenCalledTimes(3);
    expect(view.refresh).toHaveBeenCalledOnce();
  });

  it("keeps deletion unavailable after a preview failure and recovers only through retry", async () => {
    const prepareSessionRemoval = vi.fn()
      .mockRejectedValueOnce(new Error("workspace preview unavailable"))
      .mockResolvedValue({ clean: 2, dirty: 0, unknown: 0 });
    const view = await renderDeletion(prepareSessionRemoval);
    const dialog = await view.openDeleteDialog(false);

    await vi.waitFor(() => expect(dialog.textContent).toContain("Could not inspect generated tasks. Retry before deleting this schedule."));
    expect(findButton(dialog, "Delete schedule").disabled).toBe(true);
    expect(view.deleteSchedule).not.toHaveBeenCalled();

    await act(async () => findButton(dialog, "Retry").click());
    await vi.waitFor(() => expect(dialog.textContent).toContain("2 generated tasks"));
    expect(prepareSessionRemoval).toHaveBeenCalledTimes(2);
    expect(findButton(dialog, "Delete schedule").disabled).toBe(false);
    expect(view.deleteSchedule).not.toHaveBeenCalled();
  });
});

const target: TargetView = {
  id: "target-one",
  backendId: "backend-one",
  name: "Project",
  workspaceId: "workspace-one",
  revision: 1n,
  workspaceName: "Project",
  trusted: true,
  pinned: false,
  archived: false
};

const workspace: WorkspaceView = {
  id: "workspace-one",
  targetId: "target-one",
  name: "Project",
  kind: "userProject",
  serverPath: "D:\\workspace",
  trusted: true,
  dirty: false,
  entries: []
};

const backend: BackendView = {
  id: "backend-one",
  name: "Backend",
  version: "1",
  health: "healthy",
  capabilities: new Map([["input.text", {
    name: "Text input",
    supported: true,
    options: []
  }]])
};

async function renderDeletion(
  prepareSessionRemoval: (sessions: readonly SessionView[]) => Promise<WorktreeRemovalPreflightSummary | undefined>
): Promise<{
  readonly container: HTMLDivElement;
  readonly deleteSchedule: ReturnType<typeof vi.fn>;
  readonly refresh: ReturnType<typeof vi.fn>;
  readonly openDeleteDialog: (waitForResult?: boolean) => Promise<HTMLElement>;
}> {
  const schedule = deletionSchedule();
  const sessions = [generatedSession("generated-one"), generatedSession("generated-two")];
  const snapshot = {
    ...emptySnapshot(),
    workspaces: [workspace],
    targets: [target],
    backends: [backend],
    schedules: [schedule],
    sessions
  };
  const deleteSchedule = vi.fn(async (_scheduleId: string, disposition: "keep" | "archive" | "delete") => ({
    scheduleId: schedule.id,
    disposition,
    generatedSessionIds: sessions.map((session) => session.id),
    completedSessionIds: sessions.map((session) => session.id),
    failures: [],
    inflightCount: 0
  }));
  const refresh = vi.fn(async () => undefined);
  const controller = {
    state: { snapshot, preferences: { navigationOpen: true }, activeProfile: undefined },
    navigate: vi.fn(),
    refresh,
    getSchedulerRuntime: vi.fn(async () => ({
      instanceId: "scheduler-test",
      inFlight: 0,
      slotsInUse: 0,
      maxConcurrentRuns: 8,
      runs: [],
      waiting: []
    })),
    listScheduleRunHistory: vi.fn(async () => ({ history: [], totalSize: 0 })),
    runSchedule: vi.fn(async () => undefined),
    setScheduleEnabled: vi.fn(async () => undefined),
    deleteSchedule
  } as unknown as AppController;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<SchedulesPage
    controller={controller}
    schedules={[schedule]}
    sessions={sessions}
    targets={[target]}
    models={[]}
    backends={[backend]}
    extraDirectories={[]}
    locale="en"
    t={(key, values) => translate("en", key, values)}
    runAction={(_key, action) => { void action(); }}
    onOpenNavigation={() => undefined}
    prepareSessionRemoval={prepareSessionRemoval}
  />));
  const openDeleteDialog = async (waitForResult = true): Promise<HTMLElement> => {
    const row = required(container.querySelector<HTMLElement>(`#schedule-row-${schedule.id}`));
    await act(async () => required(row.querySelector<HTMLElement>("summary")).click());
    await act(async () => findButton(required(row.querySelector<HTMLElement>('[role="menu"]')), "Delete").click());
    const dialog = required(container.querySelector<HTMLElement>('[role="alertdialog"]'));
    if (waitForResult) await vi.waitFor(() => expect(dialog.textContent).toContain("2 generated tasks"));
    return dialog;
  };
  return { container, deleteSchedule, refresh, openDeleteDialog };
}

function deletionSchedule(): ScheduleView {
  return {
    id: "schedule-one",
    name: "Workspace cleanup",
    backendId: backend.id,
    targetId: target.id,
    sessionMode: "fresh",
    enabled: true,
    kind: "manual",
    expression: "",
    timezone: "UTC",
    inputText: "",
    executionMode: "script",
    script: { command: "node cleanup.mjs", capabilities: [] },
    useWorktree: true,
    refreshWorktreeRemote: false,
    permissionMode: "ask",
    planMode: false,
    extraDirectoryIds: [],
    silentWhenIdle: false,
    notifyDesktop: true,
    overlapPolicy: "queue",
    misfirePolicy: "runOnce",
    unreadRunCount: 0,
    history: [],
    source: "user"
  };
}

function generatedSession(id: string): SessionView {
  return {
    id,
    backendId: backend.id,
    targetId: target.id,
    name: id,
    state: "idle",
    generation: 1n,
    pinned: false,
    archived: false,
    updatedAt: 1,
    permissionMode: "ask",
    planMode: false,
    fastMode: false,
    automationOrigin: { kind: "scheduler", scheduleId: "schedule-one" }
  };
}

function radioWithText(container: ParentNode, text: string): HTMLButtonElement {
  const radio = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    .find((candidate) => candidate.textContent?.includes(text));
  if (radio === undefined) throw new Error(`Radio not found: ${text}`);
  return radio;
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected fixture value.");
  return value;
}

async function render(controller: AppController): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<SchedulesPage
    controller={controller}
    schedules={[]}
    sessions={[]}
    targets={[target]}
    models={[]}
    backends={[backend]}
    extraDirectories={[]}
    locale="en"
    t={(key, values) => translate("en", key, values)}
    runAction={(_key, action) => { void action(); }}
    onOpenNavigation={() => undefined}
    prepareSessionRemoval={async (sessions) => ({ clean: sessions.length, dirty: 0, unknown: 0 })}
  />));
  return container;
}

function findButton(container: ParentNode, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text));
  if (button === undefined) throw new Error(`Button not found: ${text}`);
  return button;
}

function findInputByLabel(container: ParentNode, text: string): HTMLInputElement {
  const label = [...container.querySelectorAll("label")].find((candidate) => candidate.textContent?.trim().startsWith(text));
  const input = label?.querySelector("input");
  if (!(input instanceof HTMLInputElement)) throw new Error(`Input not found: ${text}`);
  return input;
}

function findSelectByLabel(container: ParentNode, text: string): HTMLSelectElement {
  const label = [...container.querySelectorAll("label")].find((candidate) => candidate.textContent?.trim().startsWith(text));
  const select = label?.querySelector("select");
  if (!(select instanceof HTMLSelectElement)) throw new Error(`Select not found: ${text}`);
  return select;
}

function setValue(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string, event: "input" | "change"): void {
  const prototype = control instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(control, value);
  control.dispatchEvent(new Event(event, { bubbles: true }));
}
