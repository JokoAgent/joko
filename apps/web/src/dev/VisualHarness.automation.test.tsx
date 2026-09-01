// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VisualHarness } from "./VisualHarness.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState(null, "", "/__visual-harness__?scenario=automation&theme=light#/settings/automation");
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
  delete document.documentElement.dataset.harnessLastAction;
  delete document.documentElement.dataset.visualHarness;
  Reflect.deleteProperty(window, "matchMedia");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("Automation visual harness", () => {
  it("mounts the real Settings page with external browser and missing Windows driver states", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    await renderHarness(container);

    expect(document.documentElement.dataset.visualHarness).toBe("automation");
    expect(container.querySelector("#settings-panel-automation")).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>("#settings-tab-automation")?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('[data-automation-card="browser"]')).not.toBeNull();
    expect(container.querySelector('[data-automation-card="computer"]')).not.toBeNull();
    expect(container.querySelector('[data-automation-card="android"]')).not.toBeNull();
    expect([...container.querySelectorAll<HTMLElement>("[data-automation-card]")].map((card) => card.dataset.automationCard))
      .toEqual(["browser", "computer", "android"]);
    expect(required(container.querySelector<HTMLButtonElement>('[data-automation-target="external"]')).getAttribute("aria-selected")).toBe("true");
    expect(container.textContent).toContain("Detected Google Chrome");
    expect(container.textContent).toContain("cua-driver was not detected.");
    expect(container.textContent).toContain("1 ready device connected");
    expect(container.textContent).toContain("Current source: Prepared");
    expect(buttonWithText(container, "Open agent browser").disabled).toBe(false);
    expect(container.querySelector(".error-banner")).toBeNull();
  });

  it("runs browser and computer fixture controls without operation errors", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    await renderHarness(container);

    await act(async () => buttonWithText(container, "Open agent browser").click());
    await flushFrame();
    expect(document.documentElement.dataset.harnessLastAction).toBe("automation-browser:show:visual-browser");

    await act(async () => required(container.querySelector<HTMLButtonElement>('[data-automation-target="sidebar"]')).click());
    await flushFrame();
    expect(required(container.querySelector<HTMLButtonElement>('[data-automation-target="sidebar"]')).getAttribute("aria-selected")).toBe("true");
    expect(document.documentElement.dataset.harnessLastAction).toBe("automation-browser:update:visual-browser");

    const computerToggle = required(container.querySelector<HTMLButtonElement>('[data-automation-toggle="computer"]'));
    expect(computerToggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => computerToggle.click());
    await flushFrame();
    expect(required(container.querySelector<HTMLButtonElement>('[data-automation-toggle="computer"]')).getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain("CUA Driver 1.0.0");
    expect(document.documentElement.dataset.harnessLastAction).toBe("automation-computer:on");

    const deviceTrigger = required(container.querySelector<HTMLButtonElement>('[aria-label="Select default Android device"]'));
    await act(async () => deviceTrigger.click());
    await flushFrame();
    const deviceOption = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find((candidate) => candidate.textContent?.includes("emulator-5554"));
    await act(async () => required(deviceOption ?? null).click());
    await flushFrame();
    expect(document.documentElement.dataset.harnessLastAction).toBe("automation-android:device:emulator-5554");

    await act(async () => buttonWithText(container, "Recheck").click());
    await flushFrame();
    expect(document.documentElement.dataset.harnessLastAction).toBe("automation-android:probe");

    const androidToggle = required(container.querySelector<HTMLButtonElement>('[data-automation-toggle="android"]'));
    expect(androidToggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => androidToggle.click());
    await flushFrame();
    expect(required(container.querySelector<HTMLButtonElement>('[data-automation-toggle="android"]')).getAttribute("aria-checked")).toBe("false");
    expect(document.documentElement.dataset.harnessLastAction).toBe("automation-android:off");
    expect(container.querySelector(".error-banner")).toBeNull();
  });

});

function required<T>(value: T | null): T {
  if (value === null) throw new Error("Expected the automation fixture control to exist.");
  return value;
}

function buttonWithText(container: ParentNode, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === text);
  if (button === undefined) throw new Error(`Expected a button labelled ${text}.`);
  return button;
}

async function renderHarness(container: HTMLElement): Promise<void> {
  await import("../components/SettingsPage.js");
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
