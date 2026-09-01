// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VisualHarness } from "./VisualHarness.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  setViewport(1_440, 960);
  window.history.replaceState(null, "", "/__visual-harness__?scenario=subagents&theme=light");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query.includes("max-width") ? window.innerWidth <= Number(query.match(/\d+/u)?.[0] ?? 0) : false,
      media: query,
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
  vi.restoreAllMocks();
});

describe("Managed subagent visual harness", () => {
  it("mounts the real wide Inspector surface with complete paged fixture states", async () => {
    const container = await renderHarness();

    expect(document.documentElement.dataset.visualHarness).toBe("subagents");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(container.querySelector(".inspector.is-open")).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>("#inspector-tab-subagents")?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelectorAll(".subagents-run-row")).toHaveLength(2);
    expect(container.querySelector(".subagents-panel__header")?.textContent).toContain("2 of 7");
    await loadEveryRunPage(container);
    expect(container.querySelectorAll(".subagents-run-row")).toHaveLength(7);
    expect(container.querySelector(".subagents-panel__header")?.textContent).toContain("7 of 7");
    expect(container.textContent).toContain("Capture narrow layout");
    expect(container.textContent).toContain("Probe provider recovery");
    await openRootDetail(container);
    expect(container.textContent).toContain("Needs approval");
    expect(container.textContent).toContain("Read-only");
    expect(container.textContent).toContain("Write-enabled");
    expect(container.textContent).toContain("Acceptance tail marker");
    expect(container.querySelectorAll(".subagent-tool")).toHaveLength(1);
    expect(container.querySelector(".subagent-tool")?.textContent).toContain("Run focused delegated-run tests");
    await act(async () => container.querySelector<HTMLElement>(".subagent-technical > summary")?.click());
    expect(container.querySelector(".subagent-technical")?.textContent).toContain("A control request was sent from the parent task.");
  }, 10_000);

  it("mounts the narrow dark fixture and resolves a resumed child through its prior identity", async () => {
    setViewport(720, 900);
    window.history.replaceState(null, "", "/__visual-harness__?scenario=subagents&theme=dark");
    const container = await renderHarness();

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(container.querySelector(".subagents-panel")).not.toBeNull();
    await openRootDetail(container);
    const resumed = [...container.querySelectorAll<HTMLButtonElement>(".subagent-child-tabs button")]
      .find((button) => button.textContent?.includes("Runtime coverage · resumed"));
    await act(async () => required(resumed).click());

    expect(container.querySelector(".subagent-detail-bar strong")?.textContent).toBe("Runtime coverage · resumed");
    expect(container.textContent).toContain("Generation 1 mapped the native runtime commands");
    expect(container.querySelector(".subagent-message--durable")?.textContent).toContain("Durable analysis checkpoint");

    const approval = [...container.querySelectorAll<HTMLButtonElement>(".subagent-child-tabs button")]
      .find((button) => button.textContent?.includes("Browser evidence"));
    await act(async () => required(approval).click());
    expect(container.textContent).toContain("This child is waiting for an approval decision.");
  });

  it("appends a tail page and routes inline follow-up through the memory controller", async () => {
    const container = await renderHarness();
    await openRootDetail(container);

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 2_100));
    });
    expect(container.textContent).toContain("Live tail checkpoint");

    const composer = required(container.querySelector<HTMLTextAreaElement>('[aria-label="Send a direction to this subagent"]'));
    await act(async () => {
      setNativeValue(composer, "Recheck the restart-visible approval state.");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const send = required(container.querySelector<HTMLButtonElement>('.subagent-composer button[type="submit"]'));
    expect(send.disabled).toBe(false);
    await act(async () => {
      send.click();
      await new Promise((resolve) => window.setTimeout(resolve, 40));
    });

    expect(document.documentElement.dataset.harnessLastAction)
      .toBe("subagent-control:followUp:visual-subagent-orchestrator:all");
    expect(container.textContent).toContain("Recheck the restart-visible approval state.");
    expect(composer.value).toBe("");
  });
});

async function loadEveryRunPage(container: HTMLElement): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    const loadMore = container.querySelector<HTMLButtonElement>(".subagents-run-list__more");
    if (loadMore === null) return;
    await act(async () => {
      loadMore.click();
      await new Promise((resolve) => window.setTimeout(resolve, 24));
    });
  }
  throw new Error("The managed subagent fixture retained a cyclic list page token.");
}

async function openRootDetail(container: HTMLElement): Promise<void> {
  const root = [...container.querySelectorAll<HTMLButtonElement>(".subagents-run-row")]
    .find((button) => button.textContent?.includes("Coordinate complete product coverage"));
  await act(async () => {
    required(root).click();
    await new Promise((resolve) => window.setTimeout(resolve, 80));
  });
}

async function renderHarness(): Promise<HTMLElement> {
  await import("../components/Inspector.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<VisualHarness />);
    await new Promise((resolve) => window.setTimeout(resolve, 80));
  });
  return container;
}

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: width });
  Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: height });
}

function setNativeValue(element: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (setter === undefined) throw new Error("Expected the visual composer value setter.");
  setter.call(element, value);
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected the managed subagent visual fixture element.");
  return value;
}
