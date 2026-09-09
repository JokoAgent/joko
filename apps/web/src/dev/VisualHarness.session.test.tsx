// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VisualHarness } from "./VisualHarness.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
});

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected the session fixture control to exist.");
  return value;
}

async function renderHarness(container: HTMLElement): Promise<void> {
  await import("../components/SessionPane.js");
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<VisualHarness />);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}
