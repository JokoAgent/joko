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
