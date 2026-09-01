// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VisualHarness } from "./VisualHarness.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  window.history.replaceState(null, "", "/__visual-harness__?scenario=scheduler&theme=light");
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

describe("Scheduler visual harness", () => {
  it("mounts populated list, detail, grouped history, accounting, pre-run, and deletion states", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    await renderHarness(container);

    expect(document.documentElement.dataset.visualHarness).toBe("scheduler");
    expect(container.querySelector(".scheduler-page")).not.toBeNull();
    expect(container.querySelectorAll(".schedule-master__row")).toHaveLength(2);
    const taskList = required(container.querySelector<HTMLElement>('[role="list"][aria-label="Schedule task list"]'));
    expect(taskList.querySelectorAll('[role="listitem"]')).toHaveLength(2);
    expect(container.querySelector('[role="listbox"][aria-label="Schedule task list"]')).toBeNull();
    expect(taskList.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
    expect(container.querySelector(".schedule-detail__header")?.textContent).toContain("Daily product health");
    expect(container.querySelector(".schedule-history-session-group")?.textContent).toContain("Runs in persistent task");
    expect(container.querySelectorAll(".schedule-history-card")).toHaveLength(4);
    expect(container.querySelectorAll(".schedule-history-card.is-unread")).toHaveLength(2);
    expect(container.textContent).toContain("Cost $0.428");
    expect(container.textContent).toContain("Estimated value ≈$1.25");
    expect(container.textContent).toContain("Pre-run result");
    expect(container.textContent).toContain("Executable was not found in the selected workspace.");
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Restart run"]')).not.toBeNull();

    const taskButtons = [...taskList.querySelectorAll<HTMLButtonElement>(".schedule-master__row-main")];
    const projectButton = required(taskButtons.find((button) => button.textContent?.includes("Project release notes")));
    const dailyButton = required(taskButtons.find((button) => button.textContent?.includes("Daily product health")));
    await act(async () => projectButton.click());
    expect(document.documentElement.dataset.harnessLastAction).toBe("navigate:schedules");
    expect(taskList.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
    await act(async () => dailyButton.click());

    await act(async () => buttonWithText(container, "Delete").click());
    await flushFrame();

    const dialog = required(container.querySelector<HTMLElement>('[role="alertdialog"]'));
    expect(dialog.textContent).toContain("Delete Daily product health?");
    expect(dialog.textContent).toContain("2 generated tasks · 1 runs in progress");
    const dispositions = dialog.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    expect(dispositions).toHaveLength(3);
    expect(dispositions[0]?.getAttribute("aria-checked")).toBe("true");
  });
});

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected the Scheduler visual fixture control to exist.");
  return value;
}

function buttonWithText(container: ParentNode, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === text);
  if (button === undefined) throw new Error(`Expected a button labelled ${text}.`);
  return button;
}

async function renderHarness(container: HTMLElement): Promise<void> {
  await import("../components/SchedulesPage.js");
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<VisualHarness />);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function flushFrame(): Promise<void> {
  await act(async () => new Promise((resolve) => window.setTimeout(resolve, 24)));
}
