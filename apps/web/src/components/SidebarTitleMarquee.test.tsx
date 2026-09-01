// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SidebarTitleMarquee, sidebarTitleMarqueeMetrics } from "./Sidebar.js";

const roots: Root[] = [];
let reducedMotion = false;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  reducedMotion = false;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: reducedMotion, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  });
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "matchMedia");
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("SidebarTitleMarquee", () => {
  it("computes proportional one-shot reading metrics only for actual overflow", () => {
    expect(sidebarTitleMarqueeMetrics(100, 101)).toEqual({ overflowing: false, shift: 0, viewportCount: 1 });
    expect(sidebarTitleMarqueeMetrics(100, 220)).toEqual({ overflowing: true, shift: -120, viewportCount: 3 });
  });

  it("starts on row hover, resets immediately on leave, and stays static for reduced motion", async () => {
    const row = await render();
    const title = required(row.querySelector<HTMLElement>(".sidebar-title-marquee"));
    const track = required(row.querySelector<HTMLElement>(".sidebar-title-marquee__track"));
    Object.defineProperty(title, "clientWidth", { configurable: true, value: 100 });
    Object.defineProperty(track, "scrollWidth", { configurable: true, value: 220 });

    await act(async () => row.dispatchEvent(new MouseEvent("mouseenter")));
    expect(title.dataset.titleOverflowing).toBe("true");
    expect(title.style.getPropertyValue("--sidebar-title-marquee-shift")).toBe("-120px");
    expect(title.style.getPropertyValue("--sidebar-title-marquee-duration")).toContain("3");

    await act(async () => row.dispatchEvent(new MouseEvent("mouseleave")));
    expect(title.dataset.titleOverflowing).toBeUndefined();
    expect(title.style.getPropertyValue("--sidebar-title-marquee-shift")).toBe("");

    reducedMotion = true;
    await act(async () => row.dispatchEvent(new MouseEvent("mouseenter")));
    expect(title.dataset.titleOverflowing).toBeUndefined();
  });

  it("starts from keyboard focus, survives focus moves within the row, and avoids a competing native tooltip", async () => {
    const row = await render();
    const title = required(row.querySelector<HTMLElement>(".sidebar-title-marquee"));
    const track = required(row.querySelector<HTMLElement>(".sidebar-title-marquee__track"));
    const task = required(row.querySelector<HTMLButtonElement>("[data-task-trigger]"));
    const menu = required(row.querySelector<HTMLButtonElement>("[data-menu-trigger]"));
    Object.defineProperty(title, "clientWidth", { configurable: true, value: 100 });
    Object.defineProperty(track, "scrollWidth", { configurable: true, value: 220 });

    await act(async () => task.focus());
    expect(title.dataset.titleOverflowing).toBe("true");
    expect(title.hasAttribute("title")).toBe(false);

    await act(async () => menu.focus());
    expect(title.dataset.titleOverflowing).toBe("true");

    await act(async () => menu.blur());
    expect(title.dataset.titleOverflowing).toBeUndefined();

    reducedMotion = true;
    await act(async () => task.focus());
    expect(title.dataset.titleOverflowing).toBeUndefined();
  });
});

async function render(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<div data-sidebar-session-row="true"><button data-task-trigger><SidebarTitleMarquee title="A long title">A long title</SidebarTitleMarquee></button><button data-menu-trigger>Menu</button></div>));
  return required(container.querySelector<HTMLElement>("[data-sidebar-session-row]"));
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected test element");
  return value;
}
