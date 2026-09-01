// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VisualHarness } from "./VisualHarness.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState(null, "", "/__visual-harness__?scenario=browser&theme=light");
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
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "data:image/png;base64,iVBORw0KGgo=") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  vi.restoreAllMocks();
});

describe("Browser visual harness", () => {
  it("mounts the real Browser workbench with the reference chrome and remote takeover state", async () => {
    const container = await renderHarness();

    expect(document.documentElement.dataset.visualHarness).toBe("browser");
    expect(container.querySelector(".browser-page-rail")?.textContent).toContain("Joko Browser fixture");
    expect(container.querySelector(".browser-chrome")).not.toBeNull();
    expect(container.querySelector('.browser-chrome__omnibox > button')?.textContent).toBe("https://example.test/docs");
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Back"]')?.disabled).toBe(false);
    const unavailableForward = container.querySelector<HTMLElement>('.tip-anchor--disabled[aria-label="No next page: No next page"]');
    expect(unavailableForward?.querySelector<HTMLButtonElement>('button[aria-label="No next page"]')?.disabled).toBe(true);
    expect(container.textContent).toContain("Remote control active");
    expect(container.textContent).toContain("Opened the deterministic Browser fixture");
    expect(container.querySelector(".remote-browser__viewport canvas")).not.toBeNull();
  });

  it("routes chrome navigation and screenshot through the real fixture controller", async () => {
    const container = await renderHarness();
    await act(async () => required(container.querySelector<HTMLButtonElement>('.browser-chrome__omnibox > button')).click());
    const input = required(container.querySelector<HTMLInputElement>('[aria-label="Address and search"]'));
    await act(async () => {
      input.value = "openai";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 24));
    });
    expect(document.documentElement.dataset.harnessLastAction).toBe("browser-action:visual-browser:visual-page:navigate");

    await act(async () => {
      required(container.querySelector<HTMLButtonElement>('[aria-label="Capture"]')).click();
      await new Promise((resolve) => window.setTimeout(resolve, 24));
    });
    expect(document.documentElement.dataset.harnessLastAction).toBe("browser-capture:visual-browser:visual-page");
  });
});

async function renderHarness(): Promise<HTMLElement> {
  await import("../components/ToolsPage.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<VisualHarness />);
    await new Promise((resolve) => window.setTimeout(resolve, 40));
  });
  return container;
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected Browser fixture element");
  return value;
}
