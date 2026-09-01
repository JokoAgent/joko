// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot, type BackendView, type ScheduleView, type TargetView, type WorkspaceView } from "../model.js";
import { SchedulesPage } from "./SchedulesPage.js";
import type { RunAction, Translator } from "./types.js";

const roots: Root[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
});

describe("project automation schedule controls", () => {
  it("shows source-specific menu actions and exposes reconcile only for a project-owned group", async () => {
    const rendered = await renderSchedules();

    expect(required(rendered.row("project").querySelector(".schedule-source-chip")).textContent).toContain("scheduler.projectSource");
    expect(rendered.row("personal").querySelector(".schedule-source-chip")).toBeNull();
    expect(rendered.container.querySelector('[aria-label="scheduler.projectReconcile · Project"]')).not.toBeNull();

    const personalMenu = await rendered.openMenu("personal");
    expect(menuLabels(personalMenu)).toEqual([
      "scheduler.edit",
      "common.disable",
      "scheduler.projectPromote",
      "common.delete"
    ]);

    const projectMenu = await rendered.openMenu("project");
    expect(menuLabels(projectMenu)).toEqual([
      "common.disable",
      "scheduler.projectEdit",
      "scheduler.projectClone",
      "scheduler.projectRemove"
    ]);
  });

  it("promotes, clones, and reconciles through their exact controller operations before refreshing", async () => {
    const rendered = await renderSchedules();

    await act(async () => buttonWithText(await rendered.openMenu("personal"), "scheduler.projectPromote").click());
    await rendered.drainActions();
    expect(rendered.controller.promoteScheduleToProject).toHaveBeenCalledWith("personal");
    expect(rendered.controller.refresh).toHaveBeenCalledTimes(1);
    expect(rendered.container.querySelector('[role="status"]')?.textContent).toContain("scheduler.projectPromoted");

    await act(async () => buttonWithText(await rendered.openMenu("project"), "scheduler.projectClone").click());
    await rendered.drainActions();
    expect(rendered.controller.cloneProjectScheduleToUser).toHaveBeenCalledWith("project", "Project schedule (copy)");
    expect(rendered.controller.refresh).toHaveBeenCalledTimes(2);

    await act(async () => required(rendered.container.querySelector<HTMLButtonElement>('[aria-label="scheduler.projectReconcile · Project"]')).click());
    await rendered.drainActions();
    expect(rendered.controller.reconcileProjectAutomations).toHaveBeenCalledWith("target");
    expect(rendered.controller.refresh).toHaveBeenCalledTimes(3);
    expect(rendered.container.querySelector('[role="status"]')?.textContent).toContain("scheduler.projectReconciled");
  });

  it("returns project operation failures to the global action boundary without announcing success", async () => {
    const rendered = await renderSchedules((controller) => {
      controller.promoteScheduleToProject.mockRejectedValueOnce(new Error("config write failed"));
    });

    await act(async () => buttonWithText(await rendered.openMenu("personal"), "scheduler.projectPromote").click());
    await expect(rendered.drainActions()).rejects.toThrow("config write failed");
    expect(rendered.controller.refresh).not.toHaveBeenCalled();
    expect(rendered.container.querySelector(".schedule-project-notice")).toBeNull();
  });

  it("routes both remove confirmation branches without exposing ordinary project deletion", async () => {
    const rendered = await renderSchedules();

    await act(async () => buttonWithText(await rendered.openMenu("project"), "scheduler.projectRemove").click());
    let dialog = required(rendered.container.querySelector<HTMLElement>('[role="dialog"]'));
    expect(dialog.textContent).toContain(".joko/automations/schedules.json");
    expect(buttonWithText(dialog, "common.delete", false)).toBeUndefined();
    await act(async () => buttonWithText(dialog, "scheduler.projectDemote").click());
    await rendered.drainActions();
    expect(rendered.controller.removeProjectSchedule).toHaveBeenLastCalledWith("project", true);

    await act(async () => buttonWithText(await rendered.openMenu("project"), "scheduler.projectRemove").click());
    dialog = required(rendered.container.querySelector<HTMLElement>('[role="dialog"]'));
    await act(async () => buttonWithText(dialog, "scheduler.projectRemoveConfirm").click());
    await rendered.drainActions();
    expect(rendered.controller.removeProjectSchedule).toHaveBeenLastCalledWith("project", false);
  });

  it("locks project identity while editing and saves through the ordinary config-backed update", async () => {
    const rendered = await renderSchedules();

    await act(async () => buttonWithText(await rendered.openMenu("project"), "scheduler.projectEdit").click());
    const dialog = required(rendered.container.querySelector<HTMLElement>('[role="dialog"]'));
    const targetSelect = required(labelWithText(dialog, "scheduler.target").querySelector<HTMLSelectElement>("select"));
    const sessionModeSelect = required(labelWithText(dialog, "scheduler.sessionMode").querySelector<HTMLSelectElement>("select"));
    expect(targetSelect.disabled).toBe(true);
    expect(sessionModeSelect.querySelector('option[value="bound"]')).toBeNull();

    await act(async () => buttonWithText(dialog, "scheduler.saveChanges").click());
    await rendered.drainActions();
    expect(rendered.controller.saveSchedule).toHaveBeenCalledWith("project", expect.objectContaining({
      targetId: "target",
      name: "Project schedule"
    }));
    expect(rendered.controller.refresh).toHaveBeenCalledTimes(1);
    expect(rendered.container.querySelector('[role="status"]')?.textContent).toContain("scheduler.projectUpdated");
  });
});

async function renderSchedules(configure?: (controller: ReturnType<typeof controllerFixture>) => void): Promise<{
  readonly container: HTMLDivElement;
  readonly controller: ReturnType<typeof controllerFixture>;
  readonly row: (id: string) => HTMLElement;
  readonly openMenu: (id: string) => Promise<HTMLElement>;
  readonly drainActions: () => Promise<void>;
}> {
  const controller = controllerFixture();
  configure?.(controller);
  const actions: Promise<void>[] = [];
  const runAction: RunAction = (_key, action) => {
    const pending = action();
    actions.push(pending);
    void pending.catch(() => undefined);
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<SchedulesPage
    controller={controller as unknown as AppController}
    schedules={[projectSchedule(), personalSchedule()]}
    sessions={[]}
    targets={[target]}
    models={[]}
    backends={[backend]}
    extraDirectories={[]}
    locale="en"
    t={t}
    runAction={runAction}
    onOpenNavigation={vi.fn()}
  />));
  const row = (id: string): HTMLElement => required(container.querySelector<HTMLElement>(`#schedule-row-${id}`));
  const openMenu = async (id: string): Promise<HTMLElement> => {
    const summary = required(row(id).querySelector<HTMLElement>("summary"));
    await act(async () => summary.click());
    return required(row(id).querySelector<HTMLElement>('[role="menu"]'));
  };
  const drainActions = async (): Promise<void> => {
    await act(async () => {
      while (actions.length > 0) await Promise.all(actions.splice(0));
      await Promise.resolve();
    });
  };
  return { container, controller, row, openMenu, drainActions };
}

function controllerFixture() {
  const snapshot = {
    ...emptySnapshot(),
    targets: [target],
    workspaces: [workspace],
    schedules: [projectSchedule(), personalSchedule()],
    backends: [backend]
  };
  return {
    state: {
      snapshot,
      preferences: { ...DEFAULT_UI_PREFERENCES, navigationOpen: true },
      route: { kind: "schedules" },
      activeProfile: undefined
    },
    navigate: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
    getSchedulerRuntime: vi.fn().mockResolvedValue({ instanceId: "scheduler", inFlight: 0, slotsInUse: 0, maxConcurrentRuns: 4, runs: [], waiting: [] }),
    listScheduleRunHistory: vi.fn().mockResolvedValue({ history: [], totalSize: 0 }),
    runSchedule: vi.fn().mockResolvedValue(undefined),
    setScheduleEnabled: vi.fn().mockResolvedValue(undefined),
    deleteSchedule: vi.fn().mockResolvedValue(undefined),
    saveSchedule: vi.fn().mockResolvedValue(undefined),
    reconcileProjectAutomations: vi.fn().mockResolvedValue(undefined),
    promoteScheduleToProject: vi.fn().mockResolvedValue(undefined),
    cloneProjectScheduleToUser: vi.fn().mockResolvedValue(undefined),
    removeProjectSchedule: vi.fn().mockResolvedValue(undefined),
    probeTargetWorktree: vi.fn().mockResolvedValue({ targetId: "target", eligibility: "unavailable", canRefreshRemote: false }),
    listTargetWorktreeSources: vi.fn().mockResolvedValue([]),
    refreshProviderModels: vi.fn().mockResolvedValue(undefined)
  };
}

const target: TargetView = {
  id: "target",
  backendId: "backend",
  name: "Project",
  workspaceId: "workspace",
  workspaceName: "Project",
  trusted: true,
  pinned: false,
  archived: false
};

const workspace: WorkspaceView = {
  id: "workspace",
  targetId: "target",
  name: "Project",
  kind: "userProject",
  serverPath: "D:\\project",
  trusted: true,
  dirty: false,
  entries: []
};

const backend: BackendView = {
  id: "backend",
  name: "Backend",
  version: "1",
  health: "healthy",
  capabilities: new Map([
    ["input.text", { name: "input.text", supported: true, options: [] }],
    ["permission.modes", { name: "permission.modes", supported: true, options: ["ask"] }]
  ])
};

function projectSchedule(): ScheduleView {
  return {
    ...baseSchedule("project", "Project schedule"),
    source: "project",
    projectConfigId: "project-schedule",
    projectConfigPath: ".joko/automations/schedules.json"
  };
}

function personalSchedule(): ScheduleView {
  return { ...baseSchedule("personal", "Personal schedule"), source: "user" };
}

function baseSchedule(id: string, name: string): Omit<ScheduleView, "source"> {
  return {
    id,
    name,
    backendId: "backend",
    targetId: "target",
    sessionMode: "fresh",
    enabled: true,
    kind: "manual",
    expression: "",
    timezone: "UTC",
    inputText: "",
    executionMode: "script",
    script: { command: "node automation.mjs", capabilities: [] },
    useWorktree: false,
    refreshWorktreeRemote: false,
    permissionMode: "ask",
    planMode: false,
    extraDirectoryIds: [],
    silentWhenIdle: false,
    notifyDesktop: true,
    overlapPolicy: "queue",
    misfirePolicy: "runOnce",
    unreadRunCount: 0,
    history: []
  };
}

const t: Translator = (key, variables) => {
  if (key === "scheduler.projectCloneName") return `${String(variables?.["name"] ?? "")} (copy)`;
  if (key === "scheduler.projectRemoveBody") return `${String(variables?.["name"] ?? "")} · ${String(variables?.["path"] ?? "")}`;
  return String(key);
};

function menuLabels(menu: HTMLElement): readonly string[] {
  return [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map((button) => button.textContent?.trim() ?? "");
}

function labelWithText(container: HTMLElement, text: string): HTMLLabelElement {
  return required([...container.querySelectorAll<HTMLLabelElement>("label")].find((label) => label.textContent?.includes(text) === true));
}

function buttonWithText(container: HTMLElement, text: string, requiredResult?: true): HTMLButtonElement;
function buttonWithText(container: HTMLElement, text: string, requiredResult: false): HTMLButtonElement | undefined;
function buttonWithText(container: HTMLElement, text: string, requiredResult = true): HTMLButtonElement | undefined {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === text);
  return requiredResult ? required(button) : button;
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected fixture value.");
  return value;
}
