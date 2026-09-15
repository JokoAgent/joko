// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot, type SessionView, type TargetView } from "../model.js";
import { DEFAULT_SIDEBAR_OWNER_LAYOUT } from "../sidebar-layout.js";
import { ProjectsPage } from "./ProjectsPage.js";

const roots: Root[] = [];
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren(); vi.unstubAllGlobals();
});

it("restores the same project once and includes it in the current sidebar filter after persistence", async () => {
  const view = await mount();
  expect(view.host.querySelector(".project-card dl")?.textContent).toContain("projects.tasks1");
  const restore = button(view.host, "projects.restore");
  await act(async () => { restore.click(); restore.click(); });
  expect(view.archiveTarget).toHaveBeenCalledExactlyOnceWith("project", false);
  expect(restore.disabled).toBe(true);
  expect(view.setSidebarOwnerLayout).not.toHaveBeenCalled();
  await act(async () => { view.resolve(); await view.settled(); });
  expect(view.setSidebarOwnerLayout).toHaveBeenCalledExactlyOnceWith({ projectFilter: ["other", "project"] });
  expect(view.errors).toEqual([]);
});

it.each(["failure", "owner-change", "disconnect-reconnect", "unmount"] as const)("does not adopt a restored project filter after %s", async (change) => {
  const view = await mount();
  await act(async () => button(view.host, "projects.restore").click());
  if (change === "owner-change") await view.changeOwner();
  if (change === "disconnect-reconnect") {
    await view.changeConnection("offline");
    await view.changeConnection("connected");
  }
  if (change === "unmount") await view.unmount();
  await act(async () => {
    if (change === "failure") view.reject(new Error("Project update failed"));
    else view.resolve();
    await view.settled();
  });
  expect(view.setSidebarOwnerLayout).not.toHaveBeenCalled();
  if (change === "failure") {
    expect(view.errors).toHaveLength(1);
    expect(button(view.host, "projects.restore").disabled).toBe(false);
  }
});

it.each(["empty", "next-card", "user-focus", "owner-change"] as const)("continues restored-card focus only while its original input scope owns it: %s", async (outcome) => {
  const view = await mount(outcome === "next-card");
  const restore = button(view.host, "projects.restore");
  await act(async () => { restore.focus(); restore.click(); });
  if (outcome === "user-focus") {
    const other = document.createElement("button"); document.body.append(other);
    other.focus(); other.blur();
  }
  if (outcome === "owner-change") await view.changeOwner();
  await act(async () => { view.resolve(); await view.settled(); });
  await view.commitArchive();
  await act(async () => { await new Promise((resolve) => window.requestAnimationFrame(resolve)); });
  expect(restore.isConnected).toBe(false);
  if (outcome === "empty") expect(document.activeElement).toBe(button(view.host, "nav.archived"));
  else if (outcome === "next-card") expect(document.activeElement).toBe(button(view.host, "projects.restore"));
  else expect(document.activeElement).toBe(document.body);
});

it("deletes each selected project task through its lifecycle operation before deleting the empty project", async () => {
  const first = { ...projectTask("first-task"), targetId: "runtime-target" };
  const second = projectTask("second-task");
  const executionOnly = { ...projectTask("execution-only"), projectId: "other-project" };
  const deleteSession = vi.fn(async () => undefined);
  const deleteTarget = vi.fn(async () => undefined);
  const prepareSessionRemoval = vi.fn(async (_sessions: readonly SessionView[]) => ({ clean: 0, dirty: 2, unknown: 0 }));
  const view = await mountProjectDeletion({
    sessions: [first, executionOnly, second],
    deleteSession,
    deleteTarget,
    prepareSessionRemoval
  });

  await chooseProjectTaskDeletion(view.host, prepareSessionRemoval);
  await act(async () => {
    button(required(view.host.querySelector<HTMLElement>("[role='dialog']")), "common.delete").click();
    await view.settled();
  });

  expect(prepareSessionRemoval).toHaveBeenCalledTimes(2);
  expect(prepareSessionRemoval).toHaveBeenLastCalledWith([first, second]);
  expect(deleteSession.mock.calls).toEqual([[first.id, false], [second.id, false]]);
  expect(deleteTarget).toHaveBeenCalledExactlyOnceWith("project", false);
  expect(deleteSession.mock.invocationCallOrder[1]).toBeLessThan(deleteTarget.mock.invocationCallOrder[0]!);
  expect(view.errors).toEqual([]);
});

it("keeps the project when one task lifecycle deletion fails", async () => {
  const first = projectTask("first-task");
  const second = projectTask("second-task");
  const deleteSession = vi.fn(async (sessionId: string) => {
    if (sessionId === second.id) throw new Error("Task cleanup failed");
  });
  const deleteTarget = vi.fn(async () => undefined);
  const prepareSessionRemoval = vi.fn(async () => ({ clean: 2, dirty: 0, unknown: 0 }));
  const view = await mountProjectDeletion({ sessions: [first, second], deleteSession, deleteTarget, prepareSessionRemoval });

  await chooseProjectTaskDeletion(view.host, prepareSessionRemoval);
  await act(async () => {
    button(required(view.host.querySelector<HTMLElement>("[role='dialog']")), "common.delete").click();
    await view.settled();
  });

  expect(deleteSession.mock.calls).toEqual([[first.id, false], [second.id, false]]);
  expect(deleteTarget).not.toHaveBeenCalled();
  expect(view.errors).toEqual([expect.objectContaining({ message: "Task cleanup failed" })]);
});

async function mount(secondProject = false) {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.push(root);
  let resolve!: () => void; let reject!: (error: Error) => void;
  const pending = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  const archiveTarget = vi.fn(() => pending);
  const setSidebarOwnerLayout = vi.fn(async () => undefined);
  const target: TargetView = { id: "project", backendId: "backend", name: "Project", workspaceId: "workspace", revision: 1n, workspaceName: "Workspace", trusted: false, pinned: true, archived: true };
  const task: SessionView = { id: "task", backendId: "backend", targetId: "other", projectId: target.id, name: "Moved task", state: "idle", generation: 0n, pinned: false, archived: false, updatedAt: 1, permissionMode: "ask", planMode: false, fastMode: false };
  let snapshot = { ...emptySnapshot(), targets: [target, ...(secondProject ? [{ ...target, id: "second-project", name: "Second project" }] : [])], sessions: [task, { ...task, id: "moved-out", targetId: target.id, projectId: "other" }] };
  let controller = {
    state: {
      connectionState: "connected", activeProfile: { id: "profile", serverId: "owner" },
      preferences: { ...DEFAULT_UI_PREFERENCES, sidebarOwnerLayouts: { owner: { ...DEFAULT_SIDEBAR_OWNER_LAYOUT, projectFilter: ["other"] } } }
    }, archiveTarget, setSidebarOwnerLayout
  } as unknown as AppController;
  let operation: Promise<void> = Promise.resolve();
  const errors: unknown[] = [];
  const render = () => act(async () => root.render(<ProjectsPage controller={controller} snapshot={snapshot} t={(key) => key}
    runAction={(_key, action) => { operation = action().catch((error) => { errors.push(error); }); }} onOpenNavigation={() => undefined}
    prepareSessionRemoval={async (sessions) => ({ clean: sessions.length, dirty: 0, unknown: 0 })} />));
  await render();
  await act(async () => button(host, "nav.archived").click());
  return { host, archiveTarget, setSidebarOwnerLayout, errors, resolve, reject, settled: () => operation,
    changeOwner: async () => {
      controller = { ...controller, state: { ...controller.state, activeProfile: { ...controller.state.activeProfile!, id: "new-profile", serverId: "new-owner" } } };
      await render();
    },
    changeConnection: async (connectionState: "connected" | "offline") => {
      controller = { ...controller, state: { ...controller.state, connectionState } };
      await render();
    },
    commitArchive: async () => {
      snapshot = { ...snapshot, targets: snapshot.targets.map((project) => project.id === target.id ? { ...project, archived: false } : project) };
      await render();
    },
    unmount: () => act(async () => root.unmount())
  };
}

async function mountProjectDeletion(input: {
  readonly sessions: readonly SessionView[];
  readonly deleteSession: AppController["deleteSession"];
  readonly deleteTarget: AppController["deleteTarget"];
  readonly prepareSessionRemoval: (sessions: readonly SessionView[]) => Promise<{ readonly clean: number; readonly dirty: number; readonly unknown: number }>;
}) {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.push(root);
  const target: TargetView = { id: "project", backendId: "backend", name: "Project", workspaceId: "workspace", revision: 1n, workspaceName: "Workspace", trusted: false, pinned: false, archived: false };
  const snapshot = { ...emptySnapshot(), targets: [target], sessions: input.sessions };
  const controller = {
    state: {
      connectionState: "connected",
      activeProfile: { id: "profile", serverId: "owner" },
      preferences: { ...DEFAULT_UI_PREFERENCES, sidebarOwnerLayouts: {} }
    },
    deleteSession: input.deleteSession,
    deleteTarget: input.deleteTarget
  } as unknown as AppController;
  let operation = Promise.resolve();
  const errors: unknown[] = [];
  await act(async () => root.render(<ProjectsPage
    controller={controller}
    snapshot={snapshot}
    t={(key) => key}
    runAction={(_key, action) => { operation = action().catch((error) => { errors.push(error); }); }}
    onOpenNavigation={() => undefined}
    prepareSessionRemoval={input.prepareSessionRemoval}
  />));
  return { host, errors, settled: () => operation };
}

async function chooseProjectTaskDeletion(
  host: HTMLElement,
  prepareSessionRemoval: ReturnType<typeof vi.fn>
): Promise<void> {
  await act(async () => button(required(host.querySelector<HTMLElement>(".project-card")), "common.delete").click());
  const dialog = required(host.querySelector<HTMLElement>("[role='dialog']"));
  const deleteTasks = required([...dialog.querySelectorAll<HTMLLabelElement>("label")]
    .find((label) => label.textContent?.includes("projects.deleteSessions"))
    ?.querySelector<HTMLInputElement>("input"));
  const confirmation = required(dialog.querySelector<HTMLInputElement>(".field input"));
  await act(async () => {
    deleteTasks.click();
    setNativeValue(confirmation, "Project");
    confirmation.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await vi.waitFor(() => expect(prepareSessionRemoval).toHaveBeenCalledOnce());
}

function projectTask(id: string): SessionView {
  return { id, backendId: "backend", targetId: "project", projectId: "project", name: id, state: "idle", generation: 0n, pinned: false, archived: false, updatedAt: 1, permissionMode: "ask", planMode: false, fastMode: false };
}

function setNativeValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected project fixture element.");
  return value;
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === label);
  if (result === undefined) throw new Error(`Missing ${label} action.`);
  return result;
}
