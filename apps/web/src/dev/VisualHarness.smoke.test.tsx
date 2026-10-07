// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VisualHarness } from "./VisualHarness.js";

interface SmokeCase {
  readonly scenario: "question" | "long-question" | "files" | "connections" | "background" | "extensions";
  readonly url: string;
  readonly width: number;
  readonly landmark: string;
  readonly expectedText: string;
  readonly theme: "light" | "dark";
}

const cases: readonly SmokeCase[] = [
  {
    scenario: "question",
    url: "/__visual-harness__?scenario=question&theme=light",
    width: 1_440,
    landmark: ".interaction-takeover--question .question-wizard",
    expectedText: "Audit summary",
    theme: "light"
  },
  {
    scenario: "long-question",
    url: "/__visual-harness__?scenario=long-question&theme=dark",
    width: 960,
    landmark: ".question-wizard__scroll .question-choice-grid",
    expectedText: "Detailed visual choice 14",
    theme: "dark"
  },
  {
    scenario: "files",
    url: "/__visual-harness__?scenario=files&theme=dark",
    width: 760,
    landmark: ".workspace-files-route .workspace-files-route__document",
    expectedText: "App.tsx",
    theme: "dark"
  },
  {
    scenario: "connections",
    url: "/__visual-harness__?scenario=connections&theme=light#/settings/connections",
    width: 1_440,
    landmark: "#settings-panel-connections .settings-list",
    expectedText: "Desktop",
    theme: "light"
  },
  {
    scenario: "background",
    url: "/__visual-harness__?scenario=background&theme=dark",
    width: 1_440,
    landmark: ".session-running-status[data-running-status='true']",
    expectedText: "1 background tasks running",
    theme: "dark"
  },
  {
    scenario: "extensions",
    url: "/__visual-harness__?scenario=extensions&theme=light",
    width: 1_440,
    landmark: ".extension-browser",
    expectedText: "Workspace navigator",
    theme: "light"
  }
];

let root: Root | undefined;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: mediaMatches(query),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true)
    }))
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  window.localStorage.clear();
  delete document.documentElement.dataset.harnessLastAction;
  delete document.documentElement.dataset.visualHarness;
  delete document.documentElement.dataset.theme;
  Reflect.deleteProperty(window, "matchMedia");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  vi.restoreAllMocks();
});

describe("Visual harness smoke matrix", () => {
  it.each(cases)("mounts the $scenario surface", async ({ scenario, url, width, landmark, expectedText, theme }) => {
    setViewport(width, 900);
    window.history.replaceState(null, "", url);
    const container = await renderHarness();

    await vi.waitFor(() => expect(container.querySelector(landmark)).not.toBeNull());
    expect(document.documentElement.dataset.visualHarness).toBe(scenario);
    expect(document.documentElement.dataset.theme).toBe(theme);
    expect(container.textContent).toContain(expectedText);
    expect(container.querySelector(".full-state__error")).toBeNull();
    expect(container.textContent).not.toContain("Cannot read properties of undefined");
  }, 10_000);

  it("keeps delayed task creation alive across the Extension fixture snapshot update", async () => {
    setViewport(1_440, 900);
    window.history.replaceState(null, "", "/__visual-harness__?scenario=extensions&theme=light");
    const container = await renderHarness();
    const newTask = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim().startsWith("New task"));
    expect(newTask).toBeDefined();

    await act(async () => {
      newTask!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await vi.waitFor(() => expect(container.querySelector("[data-testid='home-suggestions']")).not.toBeNull());
    const suggestion = [...container.querySelectorAll<HTMLButtonElement>("[data-home-suggestion-id]")]
      .find((button) => !button.dataset.homeSuggestionId?.startsWith("extension:"));
    expect(suggestion).toBeDefined();

    await act(async () => {
      suggestion!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await vi.waitFor(() => expect(container.querySelector("[data-session-id='session-100']")).not.toBeNull());
    expect(container.querySelector("h1")?.textContent).not.toBe("New task");
    await vi.waitFor(() => expect(document.documentElement.dataset.harnessLastAction).toMatch(/^send:session-100:prompt/u));
    expect(container.querySelector(".full-state__error")).toBeNull();
  }, 10_000);
});

async function renderHarness(): Promise<HTMLElement> {
  await Promise.all([
    import("../components/SessionPane.js"),
    import("../components/SettingsPage.js")
  ]);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<VisualHarness />);
    await new Promise((resolve) => window.setTimeout(resolve, 24));
  });
  return container;
}

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: width });
  Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: height });
}

function mediaMatches(query: string): boolean {
  const maxWidth = /max-width:\s*(\d+)px/u.exec(query)?.[1];
  if (maxWidth !== undefined && window.innerWidth > Number(maxWidth)) return false;
  const minWidth = /min-width:\s*(\d+)px/u.exec(query)?.[1];
  if (minWidth !== undefined && window.innerWidth < Number(minWidth)) return false;
  return maxWidth !== undefined || minWidth !== undefined;
}
