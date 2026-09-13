// @vitest-environment jsdom

import type { Editor } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetWorktreeRemovalPreflightCache } from "../worktree-removal-preflight.js";
import { VisualHarness } from "./VisualHarness.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetWorktreeRemovalPreflightCache();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/__visual-harness__?scenario=session&running=1&queue=1&interaction=0&theme=light");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      media: "",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true)
    }))
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn()
  });
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  window.localStorage.clear();
  delete document.documentElement.dataset.harnessLastAction;
  delete document.documentElement.dataset.visualHarness;
  Reflect.deleteProperty(window, "matchMedia");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("Session visual harness", () => {
  it("keeps queued input compact while exposing keyboard reordering", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    await renderHarness(container);

    const handle = required(container.querySelector<HTMLButtonElement>(".queue-strip__drag-handle"));
    expect(handle.getAttribute("aria-keyshortcuts")).toBe("ArrowUp ArrowDown Home End");

    const actions = [...container.querySelectorAll<HTMLButtonElement>(".queue-strip__actions button")]
      .map((button) => button.getAttribute("aria-label"));
    expect(actions).toEqual(["Edit queued input", "Move first and steer now", "Cancel queued input"]);

    await act(async () => {
      required(container.querySelector<HTMLButtonElement>('[aria-label="Edit queued input"]')).click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(document.documentElement.dataset.harnessLastAction).toBe("queue-edit-lock:visual-queue:true");
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Queued input text"]')?.value)
      .toBe("Queued visual follow-up");
    expect(handle.disabled).toBe(true);
    expect(container.querySelector(".queue-strip__actions")).toBeNull();

    window.history.replaceState(null, "", "/__visual-harness__?scenario=session&running=1&queue=1&queueSource=schedule&interaction=0&theme=light");
    const automationContainer = document.createElement("div");
    document.body.append(automationContainer);
    await renderHarness(automationContainer);
    expect(automationContainer.textContent).toContain("Automation");
    expect([...automationContainer.querySelectorAll<HTMLButtonElement>(".queue-strip__actions button")]
      .map((button) => button.getAttribute("aria-label")))
      .toEqual(["Cancel queued input"]);
    expect(automationContainer.querySelector(".queue-strip__drag-handle")).not.toBeNull();

    window.history.replaceState(null, "", "/__visual-harness__?scenario=session&running=1&queue=1&queueLock=edit&interaction=0&theme=light");
    const editLockedContainer = document.createElement("div");
    document.body.append(editLockedContainer);
    await renderHarness(editLockedContainer);
    expect(editLockedContainer.textContent).toContain("Editing elsewhere");
    expect([...editLockedContainer.querySelectorAll<HTMLButtonElement>(".queue-strip__row button")]
      .every((button) => button.disabled)).toBe(true);

    window.history.replaceState(null, "", "/__visual-harness__?scenario=session&running=1&queue=1&queueLock=interaction&interaction=0&theme=light");
    const interactionLockedContainer = document.createElement("div");
    document.body.append(interactionLockedContainer);
    await renderHarness(interactionLockedContainer);
    expect(interactionLockedContainer.textContent).toContain("Queue in use");
    expect([...interactionLockedContainer.querySelectorAll<HTMLButtonElement>(".queue-strip__row button")]
      .every((button) => button.disabled)).toBe(true);
  }, 10_000);

  it("opens the mounted new-task surface without a missing worktree fixture failure", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    await renderHarness(container);
    const newTask = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim().startsWith("New task"));

    await act(async () => {
      required(newTask).click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(container.querySelector("h1")?.textContent).toBe("New task");
    expect(container.textContent).not.toContain("Cannot read properties of undefined");
  }, 10_000);

  it("hides and restores the same project through the mounted navigation and project manager", async () => {
    window.history.replaceState(null, "", "/__visual-harness__?scenario=session&project=1&interaction=0&theme=light");
    await import("../components/ProjectsPage.js");
    const container = document.createElement("div");
    document.body.append(container);
    await renderHarness(container);
    const projectSelector = ".sidebar-main-view .project-group:not(.project-group--dialogue)";
    const project = required(container.querySelector<HTMLElement>(projectSelector));
    expect(project.textContent).toContain("Joko workspace");
    expect(project.querySelector("[data-session-id='session-2']")).not.toBeNull();
    expect(project.querySelector("[data-session-id='session-3']")).not.toBeNull();
    await act(async () => required(project.querySelector<HTMLButtonElement>("[aria-label='More']")).click());
    const clickButton = async (host: ParentNode, text: string): Promise<void> => {
      const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === text);
      await act(async () => required(button).click());
    };
    await clickButton(required(document.body.querySelector(".sidebar-project-actions-menu")), "Remove from sidebar");
    await clickButton(required(document.body.querySelector("[role='alertdialog']")), "Remove");
    expect(document.documentElement.dataset.harnessLastAction).toBe("project-archive:visual-target:true");
    expect(container.querySelector(projectSelector)).toBeNull();
    const dialogues = required(container.querySelector(".sidebar-main-view .project-group--dialogue"));
    expect(dialogues.querySelector("[data-session-id='session-2']")).not.toBeNull();
    expect(dialogues.querySelector("[data-session-id='session-3']")).not.toBeNull();
    expect(container.querySelector(".sidebar .session-section--pinned [data-session-id='session-1']")).not.toBeNull();

    const projectsNavigation = [...container.querySelectorAll<HTMLButtonElement>(".sidebar button")]
      .find((button) => button.querySelector("span")?.textContent === "Projects");
    await act(async () => required(projectsNavigation).click());
    expect(document.documentElement.dataset.harnessLastAction).toBe("navigate:projects");
    const manager = required(container.querySelector(".projects-page"));
    await clickButton(manager, "Archived");
    expect(container.querySelectorAll(".project-card")).toHaveLength(1);
    expect(container.querySelector(".project-card dl")?.textContent).toContain("Tasks3");
    await clickButton(required(container.querySelector(".project-card")), "Restore");
    expect(document.documentElement.dataset.harnessLastAction).toBe("project-archive:visual-target:false");
    expect(container.querySelector(".project-card")).toBeNull();
    await clickButton(manager, "Active");
    expect(container.querySelectorAll(".project-card")).toHaveLength(1);
    const restored = required(container.querySelector(projectSelector));
    expect(restored.querySelector("[data-session-id='session-2']")).not.toBeNull();
    expect(restored.querySelector("[data-session-id='session-3']")).not.toBeNull();
    expect(container.querySelector(".sidebar-main-view .project-group--dialogue [data-session-id='session-2']")).toBeNull();
    expect(container.querySelector(".sidebar .session-section--pinned [data-session-id='session-1']")).not.toBeNull();
  }, 10_000);

  it("restores and sends the exact same-named Artifacts selected in the mounted editor", async ({ onTestFinished }) => {
    // jsdom omits the Range geometry used by the real editor's focus scrolling.
    const scroll = vi.spyOn(window, "scrollBy").mockImplementation(() => undefined);
    onTestFinished(() => scroll.mockRestore());
    for (const [key, value] of Object.entries({
      getClientRects: () => [new DOMRect(0, 0, 1, 16)],
      getBoundingClientRect: () => new DOMRect(0, 0, 1, 16)
    })) {
      const previous = Object.getOwnPropertyDescriptor(Range.prototype, key);
      Object.defineProperty(Range.prototype, key, { configurable: true, value });
      onTestFinished(() => {
        if (previous === undefined) Reflect.deleteProperty(Range.prototype, key);
        else Object.defineProperty(Range.prototype, key, previous);
      });
    }
    window.history.replaceState(null, "", "/__visual-harness__?scenario=session&running=0&artifact=1&interaction=0&theme=light");
    const container = document.body.appendChild(document.createElement("div"));
    await renderHarness(container);
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 50)); });
    const editor = () => required(container.querySelector<HTMLElement>(".composer-rich-editor__content"));
    const choose = async (description: string): Promise<void> => {
      const input = (editor() as HTMLElement & { editor: Editor }).editor;
      await act(async () => { input.commands.insertContent("@report"); });
      const options = [...document.body.querySelectorAll<HTMLButtonElement>(".composer-palette [role='option']")];
      const option = options
        .find((button) => button.textContent?.includes(description));
      expect(required(option).querySelector("span")?.textContent).toBe("report.txt");
      await act(async () => {
        required(option).click();
        await new Promise((resolve) => window.setTimeout(resolve, 30));
      });
    };
    await choose("Original report");
    await choose("Revised report");
    expect(editor().textContent?.trim()).toBe("@report.txt @report.txt");
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 450)); });
    const switchTask = async (sessionId: string): Promise<void> => {
      await act(async () => {
        required(container.querySelector<HTMLElement>(`.sidebar [data-session-id='${sessionId}']`)).click();
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    };
    await switchTask("session-2");
    expect(editor().textContent?.trim()).toBe("");
    await switchTask("session-1");
    expect(editor().textContent?.trim()).toBe("@report.txt @report.txt");
    const send = required(container.querySelector<HTMLButtonElement>(".send-button"));
    expect(send.disabled).toBe(false);
    await act(async () => send.click());
    expect(document.documentElement.dataset.harnessLastAction)
      .toBe('send:session-1:prompt:artifacts:["visual-artifact-one","visual-artifact-two"]');
    expect(editor().textContent?.trim()).toBe("");
  }, 10_000);

  it("saves and cancels queue edits from the keyboard without consuming composition or steering an edited row", async ({ onTestFinished }) => {
    const container = document.createElement("div");
    document.body.append(container);
    await renderHarness(container);
    const actions: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) if (record.oldValue !== null) actions.push(record.oldValue);
    });
    observer.observe(document.documentElement, { attributes: true, attributeOldValue: true, attributeFilter: ["data-harness-last-action"] });
    onTestFinished(() => observer.disconnect());
    const beginEdit = async () => {
      await act(async () => required(container.querySelector<HTMLButtonElement>('[aria-label="Edit queued input"]')).click());
      return required(container.querySelector<HTMLTextAreaElement>('[aria-label="Queued input text"]'));
    };
    const textarea = await beginEdit();
    expect(document.activeElement).toBe(textarea);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "Updated queued follow-up");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    for (const options of [{ shiftKey: true }, { isComposing: true }, { repeat: true }, { keyCode: 229 }]) {
      await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...options })));
      expect(container.querySelector(".queue-strip__editor")).not.toBeNull();
      expect(document.documentElement.dataset.harnessLastAction).toBe("queue-edit-lock:visual-queue:true");
    }
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })));
    expect(container.querySelector(".queue-strip__editor")).toBeNull();
    expect(document.documentElement.dataset.harnessLastAction).toBe("queue-edit-lock:visual-queue:false");
    expect(actions).toContain("queue-edit:visual-queue");
    expect(actions).not.toContain("queue-steer:visual-queue");
    expect(container.querySelector(".queue-strip__text")?.textContent).toBe("Updated queued follow-up");
    expect(document.activeElement).toBe(container.querySelector('[aria-label="Edit queued input"]'));
    actions.length = 0;
    const cancelTextarea = await beginEdit();
    await act(async () => cancelTextarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector(".queue-strip__editor")).toBeNull();
    expect(document.documentElement.dataset.harnessLastAction).toBe("queue-edit-lock:visual-queue:false");
    expect(actions).not.toContain("queue-edit:visual-queue");
    expect(document.activeElement).toBe(container.querySelector('[aria-label="Edit queued input"]'));
    await beginEdit();
    const save = required(container.querySelector<HTMLButtonElement>('.queue-strip__editor button[type="submit"]'));
    save.focus();
    await act(async () => save.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector(".queue-strip__editor")).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('[aria-label="Edit queued input"]'));
    const savingTextarea = await beginEdit();
    const queueControl = required(container.querySelector<HTMLButtonElement>(".queue-strip__title button"));
    await act(async () => {
      savingTextarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      queueControl.focus();
    });
    expect(container.querySelector(".queue-strip__editor")).toBeNull();
    expect(document.activeElement).toBe(queueControl);
    const row = required(container.querySelector<HTMLElement>('.queue-strip__items article[tabindex="0"]'));
    expect(row.getAttribute("aria-keyshortcuts")).toBe("Meta+Enter Control+Enter");
    await act(async () => row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })));
    expect(document.documentElement.dataset.harnessLastAction).toBe("queue-edit-lock:visual-queue:false");
    expect(actions).toContain("queue-steer:visual-queue");
  }, 10_000);

  it("archives a clean task immediately after checking its exact worktree", async () => {
    window.history.replaceState(null, "", "/__visual-harness__?scenario=session&running=0&worktree=clean&interaction=0&theme=light");
    const container = document.body.appendChild(document.createElement("div"));
    await renderHarness(container);
    const row = required(container.querySelector<HTMLElement>("[data-session-id='session-2']")?.closest(".session-row"));

    await act(async () => {
      required(row.querySelector<HTMLButtonElement>(".session-row__quick-archive")).click();
      await flushUi();
    });

    expect(document.documentElement.dataset.harnessLastAction).toBe("archive:session-2:true");
    expect(document.body.querySelector(".modal[aria-modal='true']")).toBeNull();
  }, 10_000);

  it("warns before preserving a dirty worktree through task archival", async () => {
    window.history.replaceState(null, "", "/__visual-harness__?scenario=session&running=0&worktree=dirty&interaction=0&theme=light");
    const container = document.body.appendChild(document.createElement("div"));
    await renderHarness(container);
    const row = required(container.querySelector<HTMLElement>("[data-session-id='session-2']")?.closest(".session-row"));

    await act(async () => {
      required(row.querySelector<HTMLButtonElement>(".session-row__quick-archive")).click();
      await flushUi();
    });

    const dialog = required(document.body.querySelector<HTMLElement>(".modal[aria-modal='true']"));
    expect(dialog.textContent).toContain("Workspaces with uncommitted changes: 1");
    expect(document.documentElement.dataset.harnessLastAction).toBe("worktree-removal-preview:session-2:dirty");

    await act(async () => {
      required([...dialog.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "Archive task")).click();
      await flushUi();
    });
    expect(document.documentElement.dataset.harnessLastAction).toBe("archive:session-2:true");
  }, 10_000);

  it("fails closed with a warning when a deletion worktree cannot be verified", async () => {
    window.history.replaceState(null, "", "/__visual-harness__?scenario=session&running=0&worktree=unknown&interaction=0&theme=light");
    const container = document.body.appendChild(document.createElement("div"));
    await renderHarness(container);
    const row = required(container.querySelector<HTMLElement>("[data-session-id='session-2']")?.closest(".session-row"));

    await act(async () => {
      required(row.querySelector<HTMLButtonElement>(".session-menu button")).click();
      await flushUi();
    });
    const menu = required(document.body.querySelector<HTMLElement>(".session-menu-popover[role='menu']"));
    await act(async () => {
      required([...menu.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "Delete task")).click();
      await flushUi();
    });

    const dialog = required(document.body.querySelector<HTMLElement>(".modal[aria-modal='true']"));
    expect(dialog.textContent).toContain("Workspace states that could not be verified: 1");
    expect(document.documentElement.dataset.harnessLastAction).toBe("worktree-removal-preview:session-2:unknown");

    await act(async () => {
      required([...dialog.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "Delete")).click();
      await flushUi();
    });
    expect(document.documentElement.dataset.harnessLastAction).toBe("delete:session-2");
  }, 10_000);

  it("routes Files task-tab archival through the same dirty-worktree warning", async () => {
    window.history.replaceState(null, "", "/__visual-harness__?scenario=files&running=0&worktree=dirty&interaction=0&theme=light");
    await import("../components/WorkspaceFilesRoute.js");
    const container = document.body.appendChild(document.createElement("div"));
    await renderHarness(container);
    await act(async () => { await flushUi(30); });

    await act(async () => {
      required(container.querySelector<HTMLButtonElement>('[aria-label="Archive Polish file browser interactions"]')).click();
      await flushUi();
    });

    const dialog = required(document.body.querySelector<HTMLElement>(".modal[aria-modal='true']"));
    expect(dialog.textContent).toContain("Workspaces with uncommitted changes: 1");
    await act(async () => {
      required([...dialog.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "Archive task")).click();
      await flushUi();
    });
    expect(document.documentElement.dataset.harnessLastAction).toBe("archive:session-2:true");
  }, 10_000);
});

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected the session fixture control to exist.");
  return value;
}

async function renderHarness(container: HTMLElement): Promise<void> {
  // Each URL represents a separate application mount with one document input owner.
  for (const previous of roots.splice(0)) await act(async () => previous.unmount());
  await import("../components/SessionPane.js");
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<VisualHarness />);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function flushUi(delay = 0): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, delay));
  await Promise.resolve();
}
