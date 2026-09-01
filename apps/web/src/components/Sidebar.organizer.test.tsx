// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot, type ScheduleView, type SessionView } from "../model.js";
import { DEFAULT_SIDEBAR_OWNER_LAYOUT, type SidebarDisplayPreferences } from "../sidebar-layout.js";
import { Sidebar, type SidebarProps } from "./Sidebar.js";
import { SIDEBAR_HOVER_CARD_CLOSE_DELAY_MS, SIDEBAR_HOVER_CARD_OPEN_DELAY_MS } from "./SidebarHoverCard.js";
import type { Translator } from "./types.js";

const roots: Root[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  window.localStorage.clear();
  document.documentElement.removeAttribute("style");
  Reflect.deleteProperty(window, "jokoDesktop");
  vi.useRealTimers();
});

describe("Sidebar organizer display controls", () => {
  it("hands a completed task drag to the Desktop outside-window fence", async () => {
    installDragPreviewTokens();
    const beginDragPreview = vi.fn().mockResolvedValue(true);
    const endDragPreview = vi.fn().mockResolvedValue(true);
    const openIfDroppedOutside = vi.fn().mockResolvedValue({ opened: false });
    Object.defineProperty(window, "jokoDesktop", {
      configurable: true,
      value: {
        capabilities: ["session.windows"],
        sessionWindows: { beginDragPreview, endDragPreview, openIfDroppedOutside }
      }
    });
    const rendered = await renderSidebar(DEFAULT_UI_PREFERENCES.sidebarDisplayPreferences, vi.fn());
    const button = rendered.container.querySelector<HTMLButtonElement>("[data-session-id='session']");
    const row = button?.closest<HTMLElement>(".session-row");
    if (button === null || row === null || button === undefined || row === undefined) {
      throw new Error("Task row was not rendered.");
    }
    const setData = vi.fn();
    const setDragImage = vi.fn();
    const clearData = vi.fn();
    const dragStart = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(dragStart, "dataTransfer", {
      value: { effectAllowed: "", setData, setDragImage, clearData }
    });
    await act(async () => {
      button.dispatchEvent(dragStart);
      await Promise.resolve();
    });
    const request = beginDragPreview.mock.calls[0]?.[0] as JokoDesktopSessionDragPreviewRequest | undefined;
    expect(request?.sessionId).toBe("session");
    expect(setDragImage).toHaveBeenCalledOnce();
    expect(clearData).toHaveBeenCalledOnce();
    expect(setData).not.toHaveBeenCalledWith("text/plain", expect.anything());
    expect(row.classList.contains("is-session-dragging")).toBe(true);
    await act(async () => {
      button.dispatchEvent(new Event("dragend", { bubbles: true }));
      button.dispatchEvent(new Event("dragend", { bubbles: true }));
      await Promise.resolve();
    });
    expect(row.classList.contains("is-session-dragging")).toBe(false);
    expect(openIfDroppedOutside).toHaveBeenCalledOnce();
    expect(openIfDroppedOutside).toHaveBeenCalledWith(request?.gestureId);
    expect(endDragPreview).not.toHaveBeenCalled();
  });

  it("does not open a task window after Escape cancels its native drag", async () => {
    installDragPreviewTokens();
    const beginDragPreview = vi.fn().mockResolvedValue(true);
    const endDragPreview = vi.fn().mockResolvedValue(true);
    const openIfDroppedOutside = vi.fn().mockResolvedValue({ opened: false });
    Object.defineProperty(window, "jokoDesktop", {
      configurable: true,
      value: {
        capabilities: ["session.windows"],
        sessionWindows: { beginDragPreview, endDragPreview, openIfDroppedOutside }
      }
    });
    const rendered = await renderSidebar(DEFAULT_UI_PREFERENCES.sidebarDisplayPreferences, vi.fn());
    const button = rendered.container.querySelector<HTMLButtonElement>("[data-session-id='session']");
    const row = button?.closest<HTMLElement>(".session-row");
    if (button === null || row === null || button === undefined || row === undefined) {
      throw new Error("Task row was not rendered.");
    }
    const dragStart = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(dragStart, "dataTransfer", {
      value: { effectAllowed: "", setData: vi.fn(), setDragImage: vi.fn(), clearData: vi.fn() }
    });
    await act(async () => {
      button.dispatchEvent(dragStart);
      await Promise.resolve();
    });
    expect(row.classList.contains("is-session-dragging")).toBe(true);

    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    window.dispatchEvent(escape);
    await act(async () => button.dispatchEvent(new Event("dragend", { bubbles: true })));

    expect(row.classList.contains("is-session-dragging")).toBe(false);
    expect(escape.defaultPrevented).toBe(false);
    expect(endDragPreview).toHaveBeenCalledOnce();
    expect(endDragPreview).toHaveBeenCalledWith(beginDragPreview.mock.calls[0]?.[0]?.gestureId);
    expect(openIfDroppedOutside).not.toHaveBeenCalled();
  });

  it("shows Session-owned pull request state in the sidebar hover surface", async () => {
    const tracked = {
      ...session(),
      codeHostPullRequests: [{
        key: "code.example/acme/widgets#42",
        host: "code.example",
        repositoryOwner: "acme",
        repositoryName: "widgets",
        number: 42,
        webUrl: "https://code.example/acme/widgets/pull/42",
        projection: {
          state: "open" as const,
          draft: true,
          title: "Sidebar review badge",
          headBranch: "feature/sidebar-badge",
          unresolvedReviewThreadCount: 3,
          observedAt: 1
        }
      }]
    };
    const rendered = await renderSidebar({
      ...DEFAULT_UI_PREFERENCES.sidebarDisplayPreferences,
      sessionInfoFields: ["pr"]
    }, vi.fn(), {
      snapshot: {
        ...emptySnapshot(),
        revision: 1n,
        server: { name: "Orchestrator", version: "test", health: "healthy" },
        backends: [{ id: "backend", name: "Backend", version: "1", health: "healthy", capabilities: new Map() }],
        targets: [{ id: "target", backendId: "backend", name: "Project", workspaceId: "workspace", workspaceName: "Project", trusted: true, pinned: false, archived: false }],
        sessions: [tracked]
      }
    });
    const button = rendered.container.querySelector<HTMLButtonElement>("[data-session-id='session']");
    const badge = button?.querySelector<HTMLElement>(".session-row__code-host");
    expect(button?.getAttribute("aria-label")).toContain("codeHost.statusDraft");
    expect(badge?.getAttribute("role")).toBe("img");
    expect(badge?.getAttribute("data-state")).toBe("draft");
    expect(badge?.getAttribute("aria-label")).toContain("codeHost.unresolvedReviewThreads");
    expect(badge?.textContent).toContain("#42");
    expect(badge?.querySelector(".session-row__code-host-review")?.textContent).toBe("");
  });

  it("shows actionable project and task details from pointer and keyboard focus", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T12:00:00.000Z"));
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    const running = { ...session(), id: "running", name: "Running task", state: "running" as const };
    const rendered = await renderSidebar(DEFAULT_UI_PREFERENCES.sidebarDisplayPreferences, vi.fn(), {
      onNavigate,
      onClose,
      snapshot: {
        ...emptySnapshot(),
        revision: 1n,
        server: { name: "Orchestrator", version: "test", health: "healthy" },
        backends: [{ id: "backend", name: "Local Backend", version: "1", health: "healthy", capabilities: new Map() }],
        targets: [{ id: "target", backendId: "backend", name: "Project", workspaceId: "workspace", workspaceName: "Project", trusted: true, pinned: false, archived: false }],
        sessions: [session(), running],
        workspaces: [{ id: "workspace", targetId: "target", name: "Project", kind: "userProject", serverPath: "D:\\joko", trusted: true, dirty: false, entries: [] }]
      }
    });
    const project = rendered.container.querySelector<HTMLElement>(".project-group__header");
    if (project === null) throw new Error("Project row was not rendered.");

    await act(async () => project.dispatchEvent(new Event("pointerover", { bubbles: true })));
    expect(document.body.querySelector(".sidebar-hover-card--project")).toBeNull();
    await act(async () => vi.advanceTimersByTime(SIDEBAR_HOVER_CARD_OPEN_DELAY_MS));
    const projectCard = document.body.querySelector<HTMLElement>(".sidebar-hover-card--project");
    expect(projectCard?.textContent).toContain("2 projects.tasks");
    expect(projectCard?.textContent).toContain("1 projects.activeTasks");
    expect(projectCard?.textContent).toContain("D:\\joko");

    await act(async () => project.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body })));
    expect(document.body.querySelector(".sidebar-hover-card--project")).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(SIDEBAR_HOVER_CARD_CLOSE_DELAY_MS));
    expect(document.body.querySelector(".sidebar-hover-card--project")).toBeNull();

    await act(async () => project.focus());
    expect(project.getAttribute("aria-haspopup")).toBe("dialog");
    await act(async () => {
      project.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
      vi.advanceTimersByTime(20);
    });
    const edit = document.body.querySelector<HTMLButtonElement>(".sidebar-hover-card__edit");
    expect(document.activeElement).toBe(edit);
    await act(async () => edit?.click());
    expect(onNavigate).toHaveBeenCalledWith({ kind: "projects", projectId: "target" });
    expect(onClose).toHaveBeenCalled();

    const task = rendered.container.querySelector<HTMLButtonElement>("[data-session-id='session']");
    if (task === null) throw new Error("Task row was not rendered.");
    await act(async () => task.focus());
    const taskCard = document.body.querySelector<HTMLElement>(".sidebar-hover-card--task");
    expect(taskCard?.textContent).toContain("Release task");
    expect(taskCard?.textContent).toContain("5 minutes ago");
    expect(taskCard?.textContent).toContain("Project");
    expect(taskCard?.querySelector(".sidebar-hover-card__environment")?.getAttribute("aria-label")).toBe("session.environment");
    await act(async () => task.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(document.body.querySelector(".sidebar-hover-card--task")).toBeNull();
  });

  it("presents a durable retrying run as ordinary running work", async () => {
    const retrying = { ...session(), state: "retrying" as const, activeRunId: "run-retry" };
    const rendered = await renderSidebar(DEFAULT_UI_PREFERENCES.sidebarDisplayPreferences, vi.fn(), {
      snapshot: {
        ...emptySnapshot(),
        revision: 1n,
        server: { name: "Orchestrator", version: "test", health: "healthy" },
        backends: [{ id: "backend", name: "Backend", version: "1", health: "healthy", capabilities: new Map() }],
        targets: [{ id: "target", backendId: "backend", name: "Project", workspaceId: "workspace", workspaceName: "Project", trusted: true, pinned: false, archived: false }],
        sessions: [retrying]
      }
    });

    const row = rendered.container.querySelector<HTMLElement>("[data-session-id='session']")?.closest<HTMLElement>(".session-row");
    expect(row?.textContent).toContain("session.running");
    expect(row?.textContent).not.toContain("session.retrying");
  });

  it("keeps main and pinned display modes independent and orders SessionView-backed information", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T12:00:00.000Z"));
    const onPreferencesChange = vi.fn();
    const pinnedSession = { ...session(), pinned: true };
    const rendered = await renderSidebar({
      ...DEFAULT_UI_PREFERENCES.sidebarDisplayPreferences,
      mainViewMode: "list",
      pinnedViewMode: "text",
      sessionInfoFields: ["time"]
    }, onPreferencesChange, {
      snapshot: {
        ...emptySnapshot(),
        revision: 1n,
        server: { name: "Orchestrator", version: "test", health: "healthy" },
        backends: [{ id: "backend", name: "Backend", version: "1", health: "healthy", capabilities: new Map() }],
        targets: [{ id: "target", backendId: "backend", name: "Project", workspaceId: "workspace", workspaceName: "Project", trusted: true, pinned: false, archived: false }],
        sessions: [pinnedSession]
      }
    });

    let menu = await openPinnedViewMenu(rendered.container);
    await act(async () => buttonWithText(menu, "nav.viewCard").click());
    expect(onPreferencesChange).toHaveBeenLastCalledWith({ pinnedViewMode: "card" });

    const pinnedHeading = rendered.container.querySelector<HTMLButtonElement>(".session-section--pinned .session-section__heading-label");
    if (pinnedHeading === null) throw new Error("Pinned section heading was not rendered.");
    await act(async () => pinnedHeading.click());
    expect(pinnedHeading.getAttribute("aria-expanded")).toBe("false");
    expect(rendered.container.querySelector(".session-section--pinned [data-session-id='session']")).toBeNull();
    await act(async () => pinnedHeading.click());
    expect(pinnedHeading.getAttribute("aria-expanded")).toBe("true");

    menu = await openOrganizer(rendered.container);
    await act(async () => buttonWithText(menu, "nav.viewText").click());
    expect(onPreferencesChange).toHaveBeenLastCalledWith({ mainViewMode: "text" });

    menu = await openOrganizer(rendered.container);
    await act(async () => buttonWithText(menu, "nav.sessionInfo").click());
    const taskInfoMenu = document.body.querySelector<HTMLElement>(".sidebar-list-settings__submenu");
    if (taskInfoMenu === null) throw new Error("Task information submenu was not rendered.");
    await act(async () => buttonWithText(taskInfoMenu, "nav.sessionInfoTokens").click());
    expect(onPreferencesChange).toHaveBeenLastCalledWith({ sessionInfoFields: ["time", "tokens"] });

    await rendered.rerender({
      ...DEFAULT_UI_PREFERENCES.sidebarDisplayPreferences,
      mainViewMode: "list",
      pinnedViewMode: "card",
      sessionInfoFields: ["cost", "time", "tokens", "pr", "worktree"]
    });
    expect(rendered.container.querySelector(".sidebar-main-view.sidebar-view--list")).not.toBeNull();
    expect(rendered.container.querySelector(".session-section--pinned.sidebar-view--card")).not.toBeNull();
    expect([...rendered.container.querySelectorAll<HTMLElement>(".session-row__metadata")].map((node) => node.textContent))
      .toEqual(["$0.125", "5 minutes ago", "1.4M"]);

    await rendered.rerender({
      ...DEFAULT_UI_PREFERENCES.sidebarDisplayPreferences,
      mainViewMode: "text",
      pinnedViewMode: "text",
      sessionInfoFields: []
    });
    expect(rendered.container.querySelector(".sidebar-main-view.sidebar-view--text")).not.toBeNull();
    expect(rendered.container.querySelector(".session-row__right-slot")?.textContent).toBe("");
  });

  it("promotes pinned projects as mixed pinned entries without duplicating individually pinned tasks", async () => {
    const onPinTarget = vi.fn();
    const pinnedTarget = { id: "pinned-target", backendId: "backend", name: "Pinned project", workspaceId: "workspace-pinned", workspaceName: "Pinned project", trusted: true, pinned: true, archived: false };
    const mainTarget = { id: "main-target", backendId: "backend", name: "Main project", workspaceId: "workspace-main", workspaceName: "Main project", trusted: true, pinned: false, archived: false };
    const individuallyPinned = { ...session(), id: "pinned-task", name: "Pinned task", projectId: pinnedTarget.id, targetId: pinnedTarget.id, pinned: true, updatedAt: 30 };
    const projectTask = { ...session(), id: "project-task", name: "Project task", projectId: pinnedTarget.id, targetId: pinnedTarget.id, updatedAt: 20 };
    const mainTask = { ...session(), id: "main-task", name: "Main task", projectId: mainTarget.id, targetId: mainTarget.id, updatedAt: 10 };
    const rendered = await renderSidebar(DEFAULT_UI_PREFERENCES.sidebarDisplayPreferences, vi.fn(), {
      snapshot: {
        ...emptySnapshot(),
        revision: 1n,
        server: { name: "Orchestrator", version: "test", health: "healthy" },
        backends: [{ id: "backend", name: "Backend", version: "1", health: "healthy", capabilities: new Map() }],
        targets: [pinnedTarget, mainTarget],
        sessions: [projectTask, individuallyPinned, mainTask]
      },
      onPinTarget
    });

    const pinnedTaskEntry = required(rendered.container.querySelector<HTMLElement>(".session-section--pinned [data-sortable-id='pinned-task']"));
    const pinnedProjectEntry = required(rendered.container.querySelector<HTMLElement>(".session-section--pinned [data-sortable-id='project:pinned-target']"));
    expect(pinnedTaskEntry.querySelector("[data-session-id='pinned-task']")).not.toBeNull();
    expect([...pinnedProjectEntry.querySelectorAll<HTMLElement>("[data-session-id]")].map((element) => element.dataset.sessionId)).toEqual(["project-task"]);
    expect(rendered.container.querySelector(".sidebar-main-view [data-session-id='pinned-task']")).toBeNull();
    expect(rendered.container.querySelector(".sidebar-main-view [data-session-id='project-task']")).toBeNull();
    expect(rendered.container.querySelector(".sidebar-main-view [data-session-id='main-task']")).not.toBeNull();

    const pinnedProjectMore = required(pinnedProjectEntry.querySelector<HTMLButtonElement>("[aria-label='common.more']"));
    mockRect(pinnedProjectMore, 220, 100, 28, 28);
    await act(async () => pinnedProjectMore.click());
    let projectMenu = required(document.body.querySelector<HTMLElement>(".sidebar-project-actions-menu"));
    await act(async () => buttonWithText(projectMenu, "projects.unpin").click());
    expect(onPinTarget).toHaveBeenLastCalledWith(pinnedTarget);
    const mainProjectMore = required(rendered.container.querySelector<HTMLButtonElement>(".sidebar-main-view [aria-label='common.more']"));
    mockRect(mainProjectMore, 220, 140, 28, 28);
    await act(async () => mainProjectMore.click());
    projectMenu = required(document.body.querySelector<HTMLElement>(".sidebar-project-actions-menu"));
    await act(async () => buttonWithText(projectMenu, "projects.pin").click());
    expect(onPinTarget).toHaveBeenLastCalledWith(mainTarget);
  });

  it("uses pinned task tiles and keyboard-reachable project and dialogue rail panels", async () => {
    const onPinTarget = vi.fn();
    const onNewDialogue = vi.fn();
    const pinnedTarget = { id: "pinned-target", backendId: "backend", name: "Pinned project", workspaceId: "workspace-pinned", workspaceName: "Pinned project", trusted: true, pinned: true, archived: false } as const;
    const mainTarget = { id: "main-target", backendId: "backend", name: "Main project", workspaceId: "workspace-main", workspaceName: "Main project", trusted: true, pinned: false, archived: false } as const;
    const pinnedTask = { ...session(), id: "pinned-task", name: "Pinned task", projectId: pinnedTarget.id, targetId: pinnedTarget.id, pinned: true, updatedAt: 30 };
    const mainTask = { ...session(), id: "main-task", name: "Main task", projectId: mainTarget.id, targetId: mainTarget.id, updatedAt: 20 };
    const { projectId: _projectId, ...dialogueTask } = { ...session(), id: "dialogue-task", name: "Dialogue task", targetId: mainTarget.id, updatedAt: 10 };
    const rendered = await renderSidebar(DEFAULT_UI_PREFERENCES.sidebarDisplayPreferences, vi.fn(), {
      mode: "rail",
      snapshot: {
        ...emptySnapshot(),
        revision: 1n,
        server: { name: "Orchestrator", version: "test", health: "healthy" },
        backends: [{ id: "backend", name: "Backend", version: "1", health: "healthy", capabilities: new Map([["input.text", { name: "input.text", supported: true, options: [] }]]) }],
        targets: [pinnedTarget, mainTarget],
        sessions: [pinnedTask, mainTask, dialogueTask]
      },
      onPinTarget,
      onNewDialogue
    });

    const rail = required(rendered.container.querySelector<HTMLElement>(".sidebar__rail-view"));
    expect([...rail.querySelectorAll<HTMLElement>(".sidebar__rail-pinned-tile")].map((element) => element.dataset.sessionId)).toEqual(["pinned-task"]);
    expect(rail.querySelector(".sidebar__rail-pinned-tile[data-session-id='main-task']")).toBeNull();
    expect(rail.querySelector(".sidebar__rail-pinned-tile[data-session-id='dialogue-task']")).toBeNull();

    const projectsTrigger = required(rail.querySelector<HTMLButtonElement>("[data-sidebar-rail-trigger='projects']"));
    mockRect(projectsTrigger, 70, 120, 36, 36);
    await act(async () => projectsTrigger.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    let projectPanel = required(document.body.querySelector<HTMLElement>(".sidebar-rail-panel[data-sidebar-rail-panel-level='1']"));
    expect(projectPanel.textContent).toContain("Pinned project");
    expect(projectPanel.textContent).toContain("Main project");
    const pinnedRailProject = [...projectPanel.querySelectorAll<HTMLElement>(".sidebar-rail-project")]
      .find((element) => element.textContent?.includes("Pinned project") === true);
    const pinnedRailMore = required(pinnedRailProject?.querySelector<HTMLButtonElement>("[aria-label='common.more']") ?? null);
    mockRect(pinnedRailMore, 306, 132, 24, 24);
    await act(async () => pinnedRailMore.click());
    const railProjectMenu = required(document.body.querySelector<HTMLElement>(".sidebar-project-actions-menu"));
    await act(async () => buttonWithText(railProjectMenu, "projects.unpin").click());
    expect(onPinTarget).toHaveBeenLastCalledWith(pinnedTarget);

    const mainProject = required([...projectPanel.querySelectorAll<HTMLElement>(".sidebar-rail-project")]
      .find((element) => element.textContent?.includes("Main project") === true)
      ?.querySelector<HTMLElement>(".project-group__header") ?? null);
    mockRect(mainProject, 118, 170, 220, 32);
    await act(async () => mainProject.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    const projectTasks = required(document.body.querySelector<HTMLElement>(".sidebar-rail-panel[data-sidebar-rail-panel-level='2']"));
    expect(projectTasks.querySelector("[data-session-id='main-task']")).not.toBeNull();

    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(document.body.querySelector(".sidebar-rail-panel")).toBeNull();

    const dialoguesTrigger = required(rail.querySelector<HTMLButtonElement>("[data-sidebar-rail-trigger='dialogues']"));
    mockRect(dialoguesTrigger, 70, 162, 36, 36);
    await act(async () => dialoguesTrigger.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    const dialoguePanel = required(document.body.querySelector<HTMLElement>(".sidebar-rail-panel[data-sidebar-rail-panel-level='1']"));
    expect(dialoguePanel.querySelector("[data-session-id='dialogue-task']")).not.toBeNull();
    expect(dialoguePanel.querySelector("[data-session-id='pinned-task']")).toBeNull();
    await act(async () => required(dialoguePanel.querySelector<HTMLButtonElement>("[aria-label='newTask.dialogue']")).click());
    expect(onNewDialogue).toHaveBeenCalledWith("backend");
  });

  it("executes the complete local project action surface with confirmation and inline rename", async () => {
    const target = { id: "target", backendId: "backend", name: "Project", workspaceId: "workspace", workspaceName: "Project", trusted: true, pinned: false, archived: false } as const;
    const idle = { ...session(), id: "idle-task", name: "Idle task" };
    const running = { ...session(), id: "running-task", name: "Running task", state: "running" as const, activeRunId: "run" };
    const onNewTaskInTarget = vi.fn();
    const onRenameTarget = vi.fn();
    const onRemoveTarget = vi.fn();
    const onSetTargetSessionsArchived = vi.fn();
    const onCopyTargetLink = vi.fn();
    const onNavigate = vi.fn();
    const rendered = await renderSidebar(DEFAULT_UI_PREFERENCES.sidebarDisplayPreferences, vi.fn(), {
      snapshot: {
        ...emptySnapshot(),
        revision: 1n,
        server: { name: "Orchestrator", version: "test", health: "healthy" },
        backends: [{ id: "backend", name: "Backend", version: "1", health: "healthy", capabilities: new Map([["workspace.files", { name: "workspace.files", supported: true, options: [] }]]) }],
        targets: [target],
        workspaces: [{ id: "workspace", targetId: target.id, name: "Project", kind: "userProject", serverPath: "/project", trusted: true, dirty: false, revision: "1", entries: [] }],
        sessions: [idle, running]
      },
      onNavigate,
      onNewTaskInTarget,
      onRenameTarget,
      onRemoveTarget,
      onSetTargetSessionsArchived,
      onCopyTargetLink
    });
    const project = required(rendered.container.querySelector<HTMLElement>(".sidebar-main-view .project-group"));
    await act(async () => required(project.querySelector<HTMLButtonElement>("[aria-label='projects.newTask']")).click());
    expect(onNewTaskInTarget).toHaveBeenCalledWith(target);

    const header = required(project.querySelector<HTMLElement>(".project-group__header"));
    await act(async () => header.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 })));
    const rename = required(project.querySelector<HTMLInputElement>("[aria-label='projects.renameLabel']"));
    await act(async () => {
      setNativeValue(rename, "Renamed project");
      rename.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onRenameTarget).toHaveBeenCalledWith(target, "Renamed project");

    const openMenu = async (): Promise<HTMLElement> => {
      const more = required(project.querySelector<HTMLButtonElement>("[aria-label='common.more']"));
      mockRect(more, 220, 120, 28, 28);
      await act(async () => more.click());
      return required(document.body.querySelector<HTMLElement>(".sidebar-project-actions-menu"));
    };
    let menu = await openMenu();
    await act(async () => buttonWithText(menu, "workspace.browseFiles").click());
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "files", sessionId: "idle-task" });

    menu = await openMenu();
    await act(async () => buttonWithText(menu, "projects.copyLink").click());
    expect(onCopyTargetLink).toHaveBeenCalledWith(target);

    menu = await openMenu();
    await act(async () => buttonWithText(menu, "projects.archiveAll").click());
    let dialog = required(document.body.querySelector<HTMLElement>("[role='alertdialog']"));
    await act(async () => buttonWithText(dialog, "projects.archiveAll").click());
    expect(onSetTargetSessionsArchived).toHaveBeenCalledWith(target, [idle], true);

    menu = await openMenu();
    await act(async () => buttonWithText(menu, "projects.removeFromSidebar").click());
    dialog = required(document.body.querySelector<HTMLElement>("[role='alertdialog']"));
    await act(async () => buttonWithText(dialog, "common.remove").click());
    expect(onRemoveTarget).toHaveBeenCalledWith(target);

    menu = await openMenu();
    await act(async () => buttonWithText(menu, "projects.search").click());
    await act(async () => { await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined))); });
    expect(document.activeElement).toBe(rendered.container.querySelector(".sidebar-search input"));
  });

  it("uses click-open filter and task-information submenus while keeping filter edits open", async () => {
    const onPreferencesChange = vi.fn();
    const onOwnerLayoutChange = vi.fn();
    const rendered = await renderSidebar(DEFAULT_UI_PREFERENCES.sidebarDisplayPreferences, onPreferencesChange, { onSidebarOwnerLayoutChange: onOwnerLayoutChange });

    const menu = await openOrganizer(rendered.container);
    expect(document.body.querySelector(".sidebar-list-settings__submenu")).toBeNull();
    await act(async () => buttonWithText(menu, "nav.filters").click());
    const filterSubmenu = document.body.querySelector<HTMLElement>(".sidebar-list-settings__submenu");
    if (filterSubmenu === null) throw new Error("Filter submenu was not rendered.");
    expect(buttonWithText(filterSubmenu, "nav.searchStatus")).toBeDefined();
    expect(buttonWithText(filterSubmenu, "nav.searchProjects")).toBeDefined();
    expect(buttonWithText(filterSubmenu, "nav.searchAgent")).toBeDefined();
    expect(buttonWithText(filterSubmenu, "nav.searchLastActivity")).toBeDefined();

    await act(async () => buttonWithText(filterSubmenu, "nav.searchProjects").click());
    let leaf = document.body.querySelectorAll<HTMLElement>(".sidebar-list-settings__submenu").item(1);
    expect(leaf).not.toBeNull();
    await act(async () => buttonWithExactText(leaf, "Project").click());
    expect(onOwnerLayoutChange).toHaveBeenLastCalledWith({ projectFilter: ["target"] });
    expect(document.body.contains(filterSubmenu)).toBe(true);

    await act(async () => buttonWithText(filterSubmenu, "nav.searchAgent").click());
    leaf = document.body.querySelectorAll<HTMLElement>(".sidebar-list-settings__submenu").item(1);
    await act(async () => buttonWithText(leaf, "Backend").click());
    expect(onPreferencesChange).toHaveBeenLastCalledWith({ backendId: "backend" });
    expect(document.body.contains(filterSubmenu)).toBe(true);

    await act(async () => {
      const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      leaf.dispatchEvent(escape);
    });
    expect(document.body.querySelectorAll(".sidebar-list-settings__submenu")).toHaveLength(1);
    const remainingSubmenu = document.body.querySelector<HTMLElement>(".sidebar-list-settings__submenu");
    if (remainingSubmenu === null) throw new Error("Filter submenu closed with its child.");
    await act(async () => remainingSubmenu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(document.body.querySelector(".sidebar-list-settings__submenu")).toBeNull();
    expect(document.body.querySelector(".sidebar-list-settings__menu")).not.toBeNull();
  });

  it("collapses every visible main-list group and omits the fold action when only pinned tasks remain", async () => {
    const onOwnerLayoutChange = vi.fn();
    const rendered = await renderSidebar(DEFAULT_UI_PREFERENCES.sidebarDisplayPreferences, vi.fn(), { onSidebarOwnerLayoutChange: onOwnerLayoutChange });
    const fold = rendered.container.querySelector<HTMLButtonElement>(".sidebar-list-settings__fold");
    if (fold === null) throw new Error("Fold-all action was not rendered.");
    expect(fold.disabled).toBe(false);
    await act(async () => fold.click());
    expect(onOwnerLayoutChange).toHaveBeenLastCalledWith({ collapsedProjectIds: ["target"], collapsedDialogue: false });

    const pinnedOnly = await renderSidebar(DEFAULT_UI_PREFERENCES.sidebarDisplayPreferences, vi.fn(), {
      snapshot: {
        ...emptySnapshot(),
        revision: 1n,
        server: { name: "Orchestrator", version: "test", health: "healthy" },
        backends: [{ id: "backend", name: "Backend", version: "1", health: "healthy", capabilities: new Map() }],
        targets: [{ id: "target", backendId: "backend", name: "Project", workspaceId: "workspace", workspaceName: "Project", trusted: true, pinned: false, archived: false }],
        sessions: [{ ...session(), pinned: true }]
      }
    });
    expect(pinnedOnly.container.querySelector(".sidebar-list-settings__fold")).toBeNull();
  });

  it("applies project, backend, and activity filters only to the main list", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-08-27T12:00:00.000Z");
    vi.setSystemTime(now);
    const sessions = [
      { ...session(), id: "visible", name: "Visible", updatedAt: now - 1_000 },
      { ...session(), id: "old", name: "Old", updatedAt: now - 8 * 86_400_000 },
      { ...session(), id: "other-backend", name: "Other backend", backendId: "other", updatedAt: now - 1_000 },
      { ...session(), id: "pinned", name: "Pinned", backendId: "other", pinned: true, updatedAt: now - 60 * 86_400_000 }
    ];
    const rendered = await renderSidebar({
      ...DEFAULT_UI_PREFERENCES.sidebarDisplayPreferences,
      backendId: "backend",
      lastActivity: "7d"
    }, vi.fn(), {
      sidebarOwnerLayouts: { owner: { ...DEFAULT_SIDEBAR_OWNER_LAYOUT, projectFilter: ["target"] } },
      snapshot: {
        ...emptySnapshot(),
        revision: 1n,
        server: { name: "Orchestrator", version: "test", health: "healthy" },
        backends: [
          { id: "backend", name: "Backend", version: "1", health: "healthy", capabilities: new Map() },
          { id: "other", name: "Other", version: "1", health: "healthy", capabilities: new Map() }
        ],
        targets: [{ id: "target", backendId: "backend", name: "Project", workspaceId: "workspace", workspaceName: "Project", trusted: true, pinned: false, archived: false }],
        sessions
      }
    });
    expect([...rendered.container.querySelectorAll<HTMLElement>(".sidebar__sessions [data-session-id]")].map((element) => element.dataset.sessionId)).toEqual(["pinned", "visible"]);
  });

  it("keeps archived pinned tasks in the independent pinned section", async () => {
    const rendered = await renderSidebar({ ...DEFAULT_UI_PREFERENCES.sidebarDisplayPreferences, status: "archived" }, vi.fn(), {
      snapshot: {
        ...emptySnapshot(),
        revision: 1n,
        server: { name: "Orchestrator", version: "test", health: "healthy" },
        backends: [{ id: "backend", name: "Backend", version: "1", health: "healthy", capabilities: new Map() }],
        targets: [{ id: "target", backendId: "backend", name: "Project", workspaceId: "workspace", workspaceName: "Project", trusted: true, pinned: false, archived: false }],
        sessions: [
          { ...session(), id: "archived-pinned", pinned: true, archived: true },
          { ...session(), id: "archived-main", pinned: false, archived: true }
        ]
      }
    });
    expect(rendered.container.querySelector(".session-section--pinned [data-session-id='archived-pinned']")).not.toBeNull();
    expect(rendered.container.querySelector(".sidebar-main-view [data-session-id='archived-main']")).not.toBeNull();
    expect(rendered.container.querySelector(".sidebar-main-view [data-session-id='archived-pinned']")).toBeNull();
  });

  it("keeps remote expanded and rail views on the same fail-closed content filters", async () => {
    const now = Date.parse("2026-08-27T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const localProfile = { id: "local", deviceId: "device-local", serverId: "server-local", name: "Local", origin: "http://127.0.0.1:1" };
    const remoteProfile = { id: "remote", deviceId: "device-remote", serverId: "server-remote", name: "Remote", origin: "https://remote.example" };
    const machineControl: NonNullable<SidebarProps["machineControl"]> = {
      profiles: [localProfile, remoteProfile],
      activeProfile: localProfile,
      presenceByProfile: { local: "current", remote: "online" },
      caches: [{
        profileId: "remote",
        serverId: "server-remote",
        name: "Remote",
        origin: "https://remote.example",
        updatedAt: now,
        sessions: [
          { id: "remote-fresh", name: "Fresh", state: "idle", pinned: false, archived: false, lastActivityAt: now - 1_000 },
          { id: "remote-old", name: "Old", state: "idle", pinned: false, archived: false, lastActivityAt: now - 60 * 86_400_000 },
          { id: "remote-pinned", name: "Pinned", state: "idle", pinned: true, archived: false, lastActivityAt: now - 60 * 86_400_000 },
          { id: "remote-archived", name: "Archived", state: "idle", pinned: false, archived: true, lastActivityAt: now - 1_000 }
        ]
      }],
      selection: "all",
      onSelectionChange: vi.fn(),
      onRefresh: vi.fn(),
      onSwitch: vi.fn(),
      onOpenCachedSession: vi.fn(),
      onOpenMessageMatch: vi.fn()
    };
    const onOwnerLayoutChange = vi.fn();
    const rendered = await renderSidebar({
      ...DEFAULT_UI_PREFERENCES.sidebarDisplayPreferences,
      backendId: "backend",
      lastActivity: "7d"
    }, vi.fn(), { machineControl, onSidebarOwnerLayoutChange: onOwnerLayoutChange });

    expect([...rendered.container.querySelectorAll<HTMLElement>(".session-row--remote [data-session-id]")].map((element) => element.dataset.sessionId)).toEqual(["remote-pinned"]);
    expect(rendered.container.querySelector(".session-section--pinned [data-sortable-id='remote:remote:remote-pinned']")).not.toBeNull();
    expect(rendered.container.querySelector(".remote-machine-session-sections [data-session-id='remote-pinned']")).toBeNull();
    expect([...rendered.container.querySelectorAll<HTMLElement>(".sidebar__rail-pinned-tile.is-remote")].map((element) => element.dataset.sessionId)).toEqual(["remote-pinned"]);

    await rendered.rerenderOwnerLayouts({ owner: { ...DEFAULT_SIDEBAR_OWNER_LAYOUT, collapsedProjectIds: ["target"] } });
    const foldDevices = rendered.container.querySelector<HTMLButtonElement>(".sidebar-list-settings__fold");
    expect(foldDevices?.getAttribute("aria-label")).toBe("nav.collapseAllDevices");
    await act(async () => foldDevices?.click());
    expect([...rendered.container.querySelectorAll<HTMLButtonElement>(".sidebar-device-section__header")].map((button) => button.getAttribute("aria-expanded"))).toEqual(["false"]);
    const expandAll = rendered.container.querySelector<HTMLButtonElement>(".sidebar-list-settings__fold");
    expect(expandAll?.getAttribute("aria-label")).toBe("nav.expandAllGroups");
    await act(async () => expandAll?.click());
    expect(onOwnerLayoutChange).toHaveBeenLastCalledWith({ collapsedProjectIds: [], collapsedDialogue: false });
    expect([...rendered.container.querySelectorAll<HTMLButtonElement>(".sidebar-device-section__header")].map((button) => button.getAttribute("aria-expanded"))).toEqual(["true"]);

    await rendered.rerender({ ...DEFAULT_UI_PREFERENCES.sidebarDisplayPreferences, status: "all", lastActivity: "all" });
    expect(new Set([...rendered.container.querySelectorAll<HTMLElement>(".session-row--remote [data-session-id]")].map((element) => element.dataset.sessionId)))
      .toEqual(new Set(["remote-fresh", "remote-old", "remote-pinned", "remote-archived"]));
  });

  it("groups by navigation project and exposes the complete project move submenu", async () => {
    const onMoveSessionProject = vi.fn();
    const projectA = {
      id: "project-a",
      backendId: "backend",
      name: "Project A",
      workspaceId: "workspace-a",
      workspaceName: "Project A",
      trusted: true,
      pinned: false,
      archived: false
    } as const;
    const projectB = { ...projectA, id: "project-b", name: "Project B", workspaceId: "workspace-b", workspaceName: "Project B" };
    const moved = { ...session(), id: "session-moved", name: "Moved task", targetId: "project-a", projectId: "project-b" };
    const { projectId: _projectId, ...dialogue } = { ...session(), id: "session-dialogue", name: "Dialogue task" };
    const rendered = await renderSidebar(DEFAULT_UI_PREFERENCES.sidebarDisplayPreferences, vi.fn(), {
      snapshot: {
        ...emptySnapshot(),
        revision: 1n,
        server: { name: "Orchestrator", version: "test", health: "healthy" },
        backends: [{ id: "backend", name: "Backend", version: "1", health: "healthy", capabilities: new Map() }],
        targets: [projectA, projectB],
        sessions: [moved, dialogue]
      },
      onMoveSessionProject
    });

    const projectGroups = [...rendered.container.querySelectorAll<HTMLElement>(".project-group")];
    expect(projectGroups.find((group) => group.querySelector(".project-group__name")?.textContent === "Project B")?.textContent).toContain("Moved task");
    expect(projectGroups.some((group) => group.querySelector(".project-group__name")?.textContent === "Project A")).toBe(false);
    expect(projectGroups.find((group) => group.querySelector(".project-group__name")?.textContent === "nav.dialogue")?.textContent).toContain("Dialogue task");

    const row = rendered.container.querySelector<HTMLElement>("[data-session-id='session-moved']")?.closest<HTMLElement>(".session-row");
    const trigger = row?.querySelector<HTMLButtonElement>(".session-menu > button");
    if (trigger === null || trigger === undefined) throw new Error("Session action trigger was not rendered.");
    mockRect(trigger, 240, 120, 28, 28);
    await act(async () => trigger.click());
    let menu = document.body.querySelector<HTMLElement>(".session-menu-popover");
    if (menu === null) throw new Error("Session action menu was not rendered.");
    const projectTrigger = buttonWithText(menu, "session.moveToProject");
    mockRect(projectTrigger, 248, 150, 176, 31);
    projectTrigger.focus();
    await act(async () => projectTrigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    let projectMenu = document.body.querySelector<HTMLElement>(".session-project-menu-popover");
    if (projectMenu === null) throw new Error("Project submenu was not rendered.");
    expect(buttonWithText(projectMenu, "Project B").disabled).toBe(true);
    const projectAButton = buttonWithText(projectMenu, "Project A");
    await act(async () => projectAButton.click());
    expect(onMoveSessionProject).toHaveBeenLastCalledWith(moved, { kind: "project", projectId: "project-a" });

    await act(async () => trigger.click());
    menu = document.body.querySelector<HTMLElement>(".session-menu-popover");
    if (menu === null) throw new Error("Session action menu was not reopened.");
    const reopenedProjectTrigger = buttonWithText(menu, "session.moveToProject");
    mockRect(reopenedProjectTrigger, 248, 150, 176, 31);
    await act(async () => reopenedProjectTrigger.click());
    projectMenu = document.body.querySelector<HTMLElement>(".session-project-menu-popover");
    if (projectMenu === null) throw new Error("Project submenu was not reopened.");
    const dialogueButton = buttonWithText(projectMenu, "session.moveToDialogue");
    await act(async () => dialogueButton.click());
    expect(onMoveSessionProject).toHaveBeenLastCalledWith(moved, { kind: "dialogue" });
  });

  it("opens the task menu at the row context point and supports synchronous selection, inline rename, bulk actions, and inline archive confirmation", async () => {
    const onNavigate = vi.fn();
    const onRename = vi.fn();
    const onArchive = vi.fn();
    const onBulkArchive = vi.fn();
    const sessions = [
      { ...session(), id: "session-a", name: "Alpha" },
      { ...session(), id: "session-b", name: "Beta" },
      { ...session(), id: "session-c", name: "Gamma" }
    ];
    const rendered = await renderSidebar(DEFAULT_UI_PREFERENCES.sidebarDisplayPreferences, vi.fn(), {
      snapshot: {
        ...emptySnapshot(),
        revision: 1n,
        server: { name: "Orchestrator", version: "test", health: "healthy" },
        backends: [{ id: "backend", name: "Backend", version: "1", health: "healthy", capabilities: new Map() }],
        targets: [{ id: "target", backendId: "backend", name: "Project", workspaceId: "workspace", workspaceName: "Project", trusted: true, pinned: false, archived: false }],
        sessions
      },
      onNavigate,
      onRename,
      onArchive,
      onBulkArchive
    });

    const first = rendered.container.querySelector<HTMLButtonElement>("[data-session-id='session-a']");
    const last = rendered.container.querySelector<HTMLButtonElement>("[data-session-id='session-c']");
    if (first === null || last === null) throw new Error("Task rows were not rendered.");
    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 82, clientY: 90 });
    await act(async () => first.dispatchEvent(contextMenu));
    expect(contextMenu.defaultPrevented).toBe(true);
    expect(document.body.querySelector<HTMLElement>(".session-menu-popover")?.style.left).toBe("82px");
    await act(async () => document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));

    await act(async () => first.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true, detail: 1 })));
    await act(async () => last.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true, detail: 1 })));
    expect(rendered.container.querySelectorAll(".session-row.is-selected")).toHaveLength(3);
    expect(onNavigate).not.toHaveBeenCalled();
    const bulkArchive = rendered.container.querySelector<HTMLButtonElement>(`.sidebar-bulk-actions button[aria-label='session.archive']`);
    if (bulkArchive === null) throw new Error("Bulk archive action was not rendered.");
    await act(async () => bulkArchive.click());
    expect(onBulkArchive).toHaveBeenCalledWith(sessions);

    await act(async () => {
      first.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      first.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
      first.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
    });
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "session", sessionId: "session-a" });
    expect(onRename).not.toHaveBeenCalled();

    const doubleClickRenameInput = rendered.container.querySelector<HTMLInputElement>(".session-row__rename-input");
    if (doubleClickRenameInput === null) throw new Error("Inline rename input was not rendered after double-click.");
    await act(async () => {
      setNativeValue(doubleClickRenameInput, "Alpha renamed");
      doubleClickRenameInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      doubleClickRenameInput.blur();
    });
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenLastCalledWith(sessions[0], "Alpha renamed");

    const renamedRow = rendered.container.querySelector<HTMLElement>("[data-session-id='session-a']")?.closest<HTMLElement>(".session-row");
    const menuTrigger = renamedRow?.querySelector<HTMLButtonElement>(".session-menu > button");
    if (menuTrigger === null || menuTrigger === undefined) throw new Error("Task menu trigger was not restored after rename.");
    mockRect(menuTrigger, 240, 120, 28, 28);
    await act(async () => menuTrigger.click());
    const menu = document.body.querySelector<HTMLElement>(".session-menu-popover");
    if (menu === null) throw new Error("Task menu was not rendered for inline rename.");
    await act(async () => buttonWithText(menu, "session.rename").click());
    const menuRenameInput = rendered.container.querySelector<HTMLInputElement>(".session-row__rename-input");
    if (menuRenameInput === null) throw new Error("Task menu did not start inline rename.");
    await act(async () => {
      setNativeValue(menuRenameInput, "Discard this title");
      menuRenameInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(rendered.container.querySelector(".session-row__rename-input")).toBeNull();

    const blurRenameButton = rendered.container.querySelector<HTMLButtonElement>("[data-session-id='session-a']");
    if (blurRenameButton === null) throw new Error("Task row was not restored after cancelling rename.");
    await act(async () => blurRenameButton.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 })));
    const blurRenameInput = rendered.container.querySelector<HTMLInputElement>(".session-row__rename-input");
    if (blurRenameInput === null) throw new Error("Inline rename input was not restored for blur commit.");
    await act(async () => {
      setNativeValue(blurRenameInput, "Alpha blurred");
      blurRenameInput.blur();
    });
    expect(onRename).toHaveBeenCalledTimes(2);
    expect(onRename).toHaveBeenLastCalledWith(sessions[0], "Alpha blurred");

    const quickArchive = rendered.container.querySelector<HTMLElement>("[data-session-id='session-a']")?.closest(".session-row")?.querySelector<HTMLButtonElement>(".session-row__quick-archive");
    if (quickArchive === null || quickArchive === undefined) throw new Error("Quick archive action was not rendered.");
    await act(async () => quickArchive.click());
    const confirm = rendered.container.querySelector<HTMLElement>("[data-session-id='session-a']")?.closest(".session-row")?.querySelector<HTMLButtonElement>(".session-row__archive-confirm");
    if (confirm === null || confirm === undefined) throw new Error("Inline archive confirmation was not rendered.");
    await act(async () => confirm.click());
    expect(onArchive).toHaveBeenCalledWith(sessions[0]);
  });

  it("scrolls the active task row into the nearest visible position", async () => {
    const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    try {
      await renderSidebar(DEFAULT_UI_PREFERENCES.sidebarDisplayPreferences, vi.fn(), {
        activeSessionId: "session"
      });
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", behavior: "smooth" });
    } finally {
      if (original === undefined) delete (Element.prototype as Partial<Element>).scrollIntoView;
      else Object.defineProperty(Element.prototype, "scrollIntoView", original);
    }
  });

  it("collapses project, dialogue, and flat lists to five old tasks and resets Show all after a section collapse", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00.000Z"));
    const oldTime = Date.parse("2026-08-20T12:00:00.000Z");
    const projectSessions = Array.from({ length: 8 }, (_, index) => ({
      ...session(),
      id: `project-${index}`,
      name: `Project task ${index}`,
      updatedAt: oldTime - index
    }));
    const dialogueSessions = Array.from({ length: 8 }, (_, index) => {
      const { projectId: _projectId, ...dialogue } = {
        ...session(),
        id: `dialogue-${index}`,
        name: `Dialogue task ${index}`,
        updatedAt: oldTime - index
      };
      return dialogue;
    });
    const snapshot = {
      ...emptySnapshot(),
      revision: 1n,
      server: { name: "Orchestrator", version: "test", health: "healthy" as const },
      backends: [{ id: "backend", name: "Backend", version: "1", health: "healthy" as const, capabilities: new Map() }],
      targets: [{ id: "target", backendId: "backend", name: "Project", workspaceId: "workspace", workspaceName: "Project", trusted: true, pinned: false, archived: false }],
      sessions: [...projectSessions, ...dialogueSessions]
    };
    const rendered = await renderSidebar(DEFAULT_UI_PREFERENCES.sidebarDisplayPreferences, vi.fn(), { snapshot });
    const projectGroup = [...rendered.container.querySelectorAll<HTMLElement>(".project-group")]
      .find((group) => group.querySelector(".project-group__name")?.textContent === "Project");
    const dialogueGroup = rendered.container.querySelector<HTMLElement>(".project-group--dialogue");
    if (projectGroup === undefined || dialogueGroup === null) throw new Error("Project and Dialogue groups were not rendered.");

    expect(projectGroup.querySelectorAll("[data-session-id]")).toHaveLength(5);
    expect(dialogueGroup.querySelectorAll("[data-session-id]")).toHaveLength(5);
    await act(async () => buttonWithText(projectGroup, "nav.showAllTasks").click());
    await act(async () => buttonWithText(dialogueGroup, "nav.showAllTasks").click());
    expect(projectGroup.querySelectorAll("[data-session-id]")).toHaveLength(8);
    expect(dialogueGroup.querySelectorAll("[data-session-id]")).toHaveLength(8);

    await rendered.rerenderOwnerLayouts({
      owner: {
        ...DEFAULT_SIDEBAR_OWNER_LAYOUT,
        collapsedProjectIds: ["target"],
        collapsedDialogue: true
      }
    });
    await rendered.rerenderOwnerLayouts({ owner: DEFAULT_SIDEBAR_OWNER_LAYOUT });
    expect(projectGroup.querySelectorAll("[data-session-id]")).toHaveLength(5);
    expect(dialogueGroup.querySelectorAll("[data-session-id]")).toHaveLength(5);

    const flat = await renderSidebar({
      ...DEFAULT_UI_PREFERENCES.sidebarDisplayPreferences,
      groupBy: "flat"
    }, vi.fn(), { snapshot: { ...snapshot, sessions: projectSessions } });
    expect(flat.container.querySelectorAll(".session-section--flat [data-session-id]")).toHaveLength(5);
    expect(buttonWithText(flat.container, "nav.showAllTasks")).toBeDefined();
  });

  it("groups fresh schedule runs and exposes the reference schedule controls", async () => {
    const operations: string[] = [];
    const onNavigate = vi.fn();
    const onRunSchedule = vi.fn(async () => undefined);
    const onToggleSchedule = vi.fn(async () => undefined);
    const onDeleteSchedule = vi.fn(async (_schedule: ScheduleView, disposition: "keep" | "archive" | "delete") => { operations.push(disposition); });
    const onOwnerLayoutChange = vi.fn();
    const runs = [
      { ...session(), id: "run-new", name: "Newest run", updatedAt: 20, automationOrigin: { kind: "scheduler" as const, scheduleId: "daily" } },
      { ...session(), id: "run-old", name: "Older run", updatedAt: 10, automationOrigin: { kind: "scheduler" as const, scheduleId: "daily" } }
    ];
    const daily = schedule("daily", []);
    const rendered = await renderSidebar(DEFAULT_UI_PREFERENCES.sidebarDisplayPreferences, vi.fn(), {
      snapshot: {
        ...emptySnapshot(),
        revision: 1n,
        server: { name: "Orchestrator", version: "test", health: "healthy" },
        backends: [{ id: "backend", name: "Backend", version: "1", health: "healthy", capabilities: new Map() }],
        targets: [{ id: "target", backendId: "backend", name: "Project", workspaceId: "workspace", workspaceName: "Project", trusted: true, pinned: false, archived: false }],
        sessions: runs,
        schedules: [daily]
      },
      onNavigate,
      onRunSchedule,
      onToggleSchedule,
      onDeleteSchedule,
      onPreviewScheduleDeletion: async () => ({ generatedSessionIds: runs.map((run) => run.id), inflightCount: 0 }),
      onSidebarOwnerLayoutChange: onOwnerLayoutChange
    });

    let group = required(rendered.container.querySelector<HTMLElement>("[data-schedule-group-id='daily']"));
    expect(group.querySelectorAll("[data-session-id]")).toHaveLength(0);

    await act(async () => required(group.querySelector<HTMLButtonElement>(".schedule-session-group__main")).click());
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "session", sessionId: "run-new" });
    await act(async () => required(group.querySelector<HTMLButtonElement>(".schedule-session-group__schedule")).click());
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "schedules", scheduleId: "daily" });

    await act(async () => required(group.querySelector<HTMLButtonElement>(".schedule-session-group__toggle")).click());
    expect(group.querySelectorAll("[data-session-id]")).toHaveLength(2);
    await act(async () => required(rendered.container.querySelector<HTMLButtonElement>(".sidebar-list-settings__fold")).click());
    expect(group.querySelectorAll("[data-session-id]")).toHaveLength(0);
    expect(onOwnerLayoutChange).toHaveBeenLastCalledWith({ collapsedProjectIds: ["target"], collapsedDialogue: false });
    await rendered.rerenderOwnerLayouts({ owner: { ...DEFAULT_SIDEBAR_OWNER_LAYOUT, collapsedProjectIds: ["target"] } });
    const expandAll = required(rendered.container.querySelector<HTMLButtonElement>(".sidebar-list-settings__fold"));
    expect(expandAll.getAttribute("aria-label")).toBe("nav.expandAllGroups");
    await act(async () => expandAll.click());
    expect(onOwnerLayoutChange).toHaveBeenLastCalledWith({ collapsedProjectIds: [], collapsedDialogue: false });
    await rendered.rerenderOwnerLayouts({ owner: DEFAULT_SIDEBAR_OWNER_LAYOUT });
    group = required(rendered.container.querySelector<HTMLElement>("[data-schedule-group-id='daily']"));
    expect(group.querySelectorAll("[data-session-id]")).toHaveLength(2);
    await act(async () => required(group.querySelector<HTMLButtonElement>(".schedule-session-group__run")).click());
    expect(onRunSchedule).toHaveBeenCalledWith(daily);

    const menu = required(group.querySelector<HTMLDetailsElement>(".schedule-session-group__menu"));
    await act(async () => required(menu.querySelector<HTMLElement>("summary")).click());
    await act(async () => buttonWithText(menu, "common.disable").click());
    expect(onToggleSchedule).toHaveBeenCalledWith(daily);

    await act(async () => required(menu.querySelector<HTMLElement>("summary")).click());
    await act(async () => buttonWithText(menu, "common.delete").click());
    let dialog = required(document.body.querySelector<HTMLElement>(".schedule-delete-dialog"));
    expect(dialog.textContent).toContain("scheduler.deleteGeneratedCount");
    expect(buttonWithText(dialog, "scheduler.deleteOptionKeep").getAttribute("aria-checked")).toBe("true");
    await act(async () => buttonWithText(dialog, "scheduler.deleteConfirm").click());
    expect(onDeleteSchedule).toHaveBeenCalledWith(daily, "keep");
    expect(operations).toEqual(["keep"]);

    await act(async () => required(menu.querySelector<HTMLElement>("summary")).click());
    await act(async () => buttonWithText(menu, "common.delete").click());
    dialog = required(document.body.querySelector<HTMLElement>(".schedule-delete-dialog"));
    await act(async () => buttonWithText(dialog, "scheduler.deleteOptionArchive").click());
    await act(async () => buttonWithText(dialog, "scheduler.deleteConfirm").click());
    expect(onDeleteSchedule).toHaveBeenLastCalledWith(daily, "archive");
    expect(operations).toEqual(["keep", "archive"]);

    await act(async () => required(menu.querySelector<HTMLElement>("summary")).click());
    await act(async () => buttonWithText(menu, "common.delete").click());
    dialog = required(document.body.querySelector<HTMLElement>(".schedule-delete-dialog"));
    await act(async () => buttonWithText(dialog, "scheduler.deleteOptionDelete").click());
    await act(async () => buttonWithText(dialog, "scheduler.deleteConfirmWithTasks").click());
    expect(onDeleteSchedule).toHaveBeenLastCalledWith(daily, "delete");
    expect(operations).toEqual(["keep", "archive", "delete"]);
  });

  it("does not dispose generated tasks when deleting their schedule fails", async () => {
    const runs = [
      { ...session(), id: "run-new", updatedAt: 20, automationOrigin: { kind: "scheduler" as const, scheduleId: "daily" } },
      { ...session(), id: "run-old", updatedAt: 10, automationOrigin: { kind: "scheduler" as const, scheduleId: "daily" } }
    ];
    const rendered = await renderSidebar(DEFAULT_UI_PREFERENCES.sidebarDisplayPreferences, vi.fn(), {
      snapshot: scheduleSnapshot(runs),
      onDeleteSchedule: vi.fn(async () => { throw new Error("schedule delete failed"); }),
      onPreviewScheduleDeletion: async () => ({ generatedSessionIds: runs.map((run) => run.id), inflightCount: 0 })
    });
    const group = required(rendered.container.querySelector<HTMLElement>("[data-schedule-group-id='daily']"));
    const menu = required(group.querySelector<HTMLDetailsElement>(".schedule-session-group__menu"));

    await act(async () => required(menu.querySelector<HTMLElement>("summary")).click());
    await act(async () => buttonWithText(menu, "common.delete").click());
    const dialog = required(document.body.querySelector<HTMLElement>(".schedule-delete-dialog"));
    await act(async () => buttonWithText(dialog, "scheduler.deleteOptionArchive").click());
    await act(async () => buttonWithText(dialog, "scheduler.deleteConfirm").click());

    expect(document.body.querySelector(".schedule-delete-dialog")).not.toBeNull();
  });

  it("uses the latest run status while expanded and the whole-group status while collapsed", async () => {
    const runs = [
      { ...session(), id: "latest", updatedAt: 20, automationOrigin: { kind: "scheduler" as const, scheduleId: "daily" } },
      { ...session(), id: "older-error", updatedAt: 10, attention: attention("error", 1n), automationOrigin: { kind: "scheduler" as const, scheduleId: "daily" } }
    ];
    const rendered = await renderSidebar(DEFAULT_UI_PREFERENCES.sidebarDisplayPreferences, vi.fn(), {
      snapshot: scheduleSnapshot(runs),
      onDeleteSchedule: vi.fn(async () => undefined)
    });
    const group = required(rendered.container.querySelector<HTMLElement>("[data-schedule-group-id='daily']"));
    const headerStatus = (): HTMLElement | null => group.querySelector(".schedule-session-group__status [data-sidebar-right-status]");

    expect(headerStatus()?.dataset.sidebarRightStatus).toBe("error");
    await act(async () => required(group.querySelector<HTMLButtonElement>(".schedule-session-group__toggle")).click());
    expect(headerStatus()).toBeNull();
    await act(async () => required(group.querySelector<HTMLButtonElement>(".schedule-session-group__toggle")).click());
    expect(headerStatus()?.dataset.sidebarRightStatus).toBe("error");
  });

  it("resets a group's show-all state when its focus anchor leaves or its fold changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T12:00:00.000Z"));
    const runs = Array.from({ length: 7 }, (_, index) => ({
      ...session(),
      id: `run-${index}`,
      updatedAt: Date.parse("2026-08-20T12:00:00.000Z") - index,
      attention: attention("error", BigInt(index + 1)),
      automationOrigin: { kind: "scheduler" as const, scheduleId: "daily" }
    }));
    const rendered = await renderSidebar(DEFAULT_UI_PREFERENCES.sidebarDisplayPreferences, vi.fn(), {
      snapshot: scheduleSnapshot(runs),
      activeSessionId: "outside",
      onDeleteSchedule: vi.fn(async () => undefined)
    });
    const group = required(rendered.container.querySelector<HTMLElement>("[data-schedule-group-id='daily']"));

    expect(group.querySelectorAll("[data-session-id]")).toHaveLength(5);
    await act(async () => buttonWithText(group, "nav.showAllTasks").click());
    expect(group.querySelectorAll("[data-session-id]")).toHaveLength(7);
    await rendered.rerenderActiveSessionId("run-0");
    expect(group.querySelectorAll("[data-session-id]")).toHaveLength(7);
    await rendered.rerenderActiveSessionId("outside-again");
    expect(group.querySelectorAll("[data-session-id]")).toHaveLength(5);

    await act(async () => buttonWithText(group, "nav.showAllTasks").click());
    expect(group.querySelectorAll("[data-session-id]")).toHaveLength(7);
    await act(async () => required(group.querySelector<HTMLButtonElement>(".schedule-session-group__toggle")).click());
    await act(async () => required(group.querySelector<HTMLButtonElement>(".schedule-session-group__toggle")).click());
    expect(group.querySelectorAll("[data-session-id]")).toHaveLength(5);
  });

  it("requests drawer closure after every route-bearing primary navigation action", async () => {
    const onNavigate = vi.fn();
    const onNewTask = vi.fn();
    const onClose = vi.fn();
    const rendered = await renderSidebar(DEFAULT_UI_PREFERENCES.sidebarDisplayPreferences, vi.fn(), {
      onNavigate,
      onNewTask,
      onClose
    });

    const routes = [
      ["nav.projects", { kind: "projects" }],
      ["nav.schedules", { kind: "schedules" }],
      ["nav.tools", { kind: "tools" }],
      ["nav.settings", { kind: "settings" }]
    ] as const;
    for (const [label, route] of routes) {
      await act(async () => buttonWithText(rendered.container, label).click());
      expect(onNavigate).toHaveBeenLastCalledWith(route);
    }

    await act(async () => required(rendered.container.querySelector<HTMLButtonElement>(".brand")).click());
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "session" });
    await act(async () => required(rendered.container.querySelector<HTMLButtonElement>(".new-task-button")).click());
    expect(onNewTask).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledTimes(routes.length + 2);
  });
});

interface SidebarRenderOptions {
  readonly snapshot?: SidebarProps["snapshot"];
  readonly activeSessionId?: string;
  readonly mode?: SidebarProps["mode"];
  readonly sidebarOwnerLayouts?: SidebarProps["sidebarOwnerLayouts"];
  readonly onMoveSessionProject?: SidebarProps["onMoveSessionProject"];
  readonly onNavigate?: SidebarProps["onNavigate"];
  readonly onNewTask?: SidebarProps["onNewTask"];
  readonly onNewTaskInTarget?: SidebarProps["onNewTaskInTarget"];
  readonly onNewDialogue?: SidebarProps["onNewDialogue"];
  readonly onClose?: SidebarProps["onClose"];
  readonly onRename?: SidebarProps["onRename"];
  readonly onPinTarget?: SidebarProps["onPinTarget"];
  readonly onRenameTarget?: SidebarProps["onRenameTarget"];
  readonly onRemoveTarget?: SidebarProps["onRemoveTarget"];
  readonly onSetTargetSessionsArchived?: SidebarProps["onSetTargetSessionsArchived"];
  readonly onCopyTargetLink?: SidebarProps["onCopyTargetLink"];
  readonly onArchive?: SidebarProps["onArchive"];
  readonly onBulkArchive?: SidebarProps["onBulkArchive"];
  readonly onSidebarOwnerLayoutChange?: SidebarProps["onSidebarOwnerLayoutChange"];
  readonly onRunSchedule?: SidebarProps["onRunSchedule"];
  readonly onToggleSchedule?: SidebarProps["onToggleSchedule"];
  readonly onPreviewScheduleDeletion?: SidebarProps["onPreviewScheduleDeletion"];
  readonly onDeleteSchedule?: SidebarProps["onDeleteSchedule"];
  readonly machineControl?: SidebarProps["machineControl"];
}

async function renderSidebar(
  preferences: SidebarDisplayPreferences,
  onPreferencesChange: SidebarProps["onSidebarDisplayPreferencesChange"],
  options: SidebarRenderOptions = {}
): Promise<{
  readonly container: HTMLDivElement;
  readonly rerender: (next: SidebarDisplayPreferences) => Promise<void>;
  readonly rerenderOwnerLayouts: (next: SidebarProps["sidebarOwnerLayouts"]) => Promise<void>;
  readonly rerenderActiveSessionId: (next: string | undefined) => Promise<void>;
}> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const noop = vi.fn();
  const snapshot = options.snapshot ?? {
    ...emptySnapshot(),
    revision: 1n,
    server: { name: "Orchestrator", version: "test", health: "healthy" as const },
    backends: [{ id: "backend", name: "Backend", version: "1", health: "healthy" as const, capabilities: new Map() }],
    targets: [{
      id: "target",
      backendId: "backend",
      name: "Project",
      workspaceId: "workspace",
      workspaceName: "Project",
      trusted: true,
      pinned: false,
      archived: false
    }],
    sessions: [session()]
  };
  let currentPreferences = preferences;
  let currentOwnerLayouts = options.sidebarOwnerLayouts ?? DEFAULT_UI_PREFERENCES.sidebarOwnerLayouts;
  let currentActiveSessionId = options.activeSessionId;
  const render = async (next: SidebarDisplayPreferences, ownerLayouts: SidebarProps["sidebarOwnerLayouts"], nextActiveSessionId: string | undefined): Promise<void> => {
    currentPreferences = next;
    currentOwnerLayouts = ownerLayouts;
    currentActiveSessionId = nextActiveSessionId;
    await act(async () => root.render(<Sidebar
      snapshot={snapshot}
      activeSessionId={nextActiveSessionId}
      route={{ kind: "session" }}
      locale="en"
      messageSearchSort="relevance"
      sidebarOwnerId="owner"
      sidebarDisplayPreferences={next}
      sidebarOwnerLayouts={ownerLayouts}
      open
      mode={options.mode ?? "expanded"}
      width={320}
      searchInputRef={createRef<HTMLInputElement>()}
      t={((key: string) => key) as Translator}
      probeRuntimeActivity={async () => false}
      onNavigate={options.onNavigate ?? noop}
      onNewTask={options.onNewTask ?? noop}
      onNewTaskInTarget={options.onNewTaskInTarget}
      onNewDialogue={options.onNewDialogue}
      onRename={options.onRename ?? noop}
      onPin={noop}
      onPinTarget={options.onPinTarget ?? noop}
      onRenameTarget={options.onRenameTarget}
      onRemoveTarget={options.onRemoveTarget}
      onSetTargetSessionsArchived={options.onSetTargetSessionsArchived}
      onCopyTargetLink={options.onCopyTargetLink}
      onArchive={options.onArchive ?? noop}
      onDelete={noop}
      onBulkArchive={options.onBulkArchive}
      onRunSchedule={options.onRunSchedule}
      onToggleSchedule={options.onToggleSchedule}
      onPreviewScheduleDeletion={options.onPreviewScheduleDeletion}
      onDeleteSchedule={options.onDeleteSchedule}
      onMoveSessionProject={options.onMoveSessionProject}
      onSearchMessages={async () => []}
      onMessageSearchSortChange={noop}
      onSidebarDisplayPreferencesChange={onPreferencesChange}
      onSidebarOwnerLayoutChange={options.onSidebarOwnerLayoutChange ?? noop}
      onOpenMessageMatch={noop}
      onClose={options.onClose ?? noop}
      onHide={noop}
      onCollapse={noop}
      onExpand={noop}
      onResizePointerDown={noop}
      onResizePointerMove={noop}
      onResizePointerUp={noop}
      onResizePointerCancel={noop}
      onResizeKeyDown={noop}
      onResetWidth={noop}
      onDisconnect={noop}
      machineControl={options.machineControl}
    />));
  };
  await render(currentPreferences, currentOwnerLayouts, currentActiveSessionId);
  return {
    container,
    rerender: (next) => render(next, currentOwnerLayouts, currentActiveSessionId),
    rerenderOwnerLayouts: (next) => render(currentPreferences, next, currentActiveSessionId),
    rerenderActiveSessionId: (next) => render(currentPreferences, currentOwnerLayouts, next)
  };
}

async function openOrganizer(container: HTMLElement): Promise<HTMLElement> {
  const trigger = container.querySelector<HTMLButtonElement>(".sidebar-list-settings > button[aria-haspopup='menu']");
  if (trigger === null) throw new Error("Sidebar organizer trigger was not rendered.");
  vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
    x: 220,
    y: 125,
    width: 28,
    height: 28,
    top: 125,
    right: 248,
    bottom: 153,
    left: 220,
    toJSON: () => ({})
  });
  await act(async () => trigger.click());
  const menu = document.body.querySelector<HTMLElement>(".sidebar-list-settings__menu");
  if (menu === null) throw new Error("Sidebar organizer menu was not rendered.");
  return menu;
}

async function openPinnedViewMenu(container: HTMLElement): Promise<HTMLElement> {
  const trigger = container.querySelector<HTMLButtonElement>(".session-section--pinned button[aria-label='nav.pinnedDisplay']");
  if (trigger === null) throw new Error("Pinned display trigger was not rendered.");
  mockRect(trigger, 220, 125, 22, 22);
  await act(async () => trigger.click());
  const menu = document.body.querySelector<HTMLElement>(".sidebar-list-settings__menu--compact");
  if (menu === null) throw new Error("Pinned display menu was not rendered.");
  return menu;
}

function installDragPreviewTokens(): void {
  const style = document.documentElement.style;
  style.setProperty("--surface-raised", "#ffffff");
  style.setProperty("--line", "#d8d8d8");
  style.setProperty("--text", "#0d0d0d");
  style.setProperty("--text-soft", "#5f5f5f");
  style.setProperty("--accent", "#ff9800");
}

function buttonWithText(container: ParentNode, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.includes(text) === true);
  if (button === undefined) throw new Error(`Button ${text} was not rendered.`);
  return button;
}

function buttonWithExactText(container: ParentNode, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.querySelector("span")?.textContent?.trim() === text);
  if (button === undefined) throw new Error(`Button ${text} was not rendered.`);
  return button;
}

function setNativeValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter === undefined) throw new Error("The native input value setter is unavailable.");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function mockRect(element: Element, left: number, top: number, width: number, height: number): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: left,
    y: top,
    width,
    height,
    top,
    right: left + width,
    bottom: top + height,
    left,
    toJSON: () => ({})
  });
}

function session(): SessionView {
  return {
    id: "session",
    backendId: "backend",
    targetId: "target",
    projectId: "target",
    name: "Release task",
    state: "idle",
    pinned: false,
    archived: false,
    generation: 0n,
    model: {
      backendId: "backend",
      providerId: "provider",
      providerName: "Provider",
      modelId: "reasoner",
      name: "Reasoner",
      available: true,
      supportsImages: false,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsFast: false,
      efforts: [],
      contextWindow: 2_000_000,
      maximumOutputTokens: 100_000,
      inputCostMicrosPerMillion: 0,
      outputCostMicrosPerMillion: 0,
      currencyCode: "USD"
    },
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    updatedAt: Date.parse("2026-08-25T11:55:00.000Z"),
    usage: {
      inputTokens: 1_000_000,
      outputTokens: 430_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1_430_000,
      costMicros: 125_000,
      currencyCode: "USD"
    },
    context: {
      usedTokens: 90_000,
      contextWindow: 2_000_000,
      reservedTokens: 1_910_000,
      utilizationRatio: 0.045
    }
  };
}

function schedule(id: string, history: ScheduleView["history"]): ScheduleView {
  return {
    id,
    name: "Daily check",
    backendId: "backend",
    targetId: "target",
    source: "user",
    sessionMode: "fresh",
    enabled: true,
    kind: "cron",
    expression: "0 9 * * *",
    timezone: "UTC",
    inputText: "Check",
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
    history
  };
}

function scheduleSnapshot(sessions: readonly SessionView[]): SidebarProps["snapshot"] {
  return {
    ...emptySnapshot(),
    revision: 1n,
    server: { name: "Orchestrator", version: "test", health: "healthy" },
    backends: [{ id: "backend", name: "Backend", version: "1", health: "healthy", capabilities: new Map() }],
    targets: [{ id: "target", backendId: "backend", name: "Project", workspaceId: "workspace", workspaceName: "Project", trusted: true, pinned: false, archived: false }],
    sessions,
    schedules: [schedule("daily", [])]
  };
}

function attention(kind: NonNullable<SessionView["attention"]>["kind"], sequence: bigint): NonNullable<SessionView["attention"]> {
  return {
    kind,
    unread: true,
    subjectCursor: { opaqueToken: `cursor-${sequence}`, sequence, generation: 0n },
    attentionCursor: { opaqueToken: `cursor-${sequence}`, sequence, generation: 0n },
    readThroughCursor: { opaqueToken: "cursor-0", sequence: 0n, generation: 0n },
    updatedAt: Number(sequence)
  };
}


function required<T>(value: T | null): T {
  if (value === null) throw new Error("Expected element was not rendered.");
  return value;
}
