// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerInlineMentionPanel } from "./composer-inline-mention-panel.js";
import type { ComposerMentionCatalogItem } from "./composer-inline-mention.js";

const mounted: Array<{ container: HTMLDivElement; root: ReturnType<typeof createRoot> }> = [];

afterEach(() => {
  for (const item of mounted.splice(0)) {
    act(() => item.root.unmount());
    item.container.remove();
  }
});

describe("inline mention panel", () => {
  it("exposes an accessible bounded list and supports hover and mouse selection", () => {
    const onActiveIndexChange = vi.fn();
    const onSelect = vi.fn();
    const container = renderPanel({
      state: { kind: "ready", items: ITEMS, truncated: true },
      results: { items: ITEMS, truncated: true },
      onActiveIndexChange,
      onSelect
    });
    const list = container.querySelector('[role="listbox"]');
    expect(list?.getAttribute("aria-activedescendant")).toContain("option-0");
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(container.textContent).toContain("More matches");
    act(() => container.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true })));
    expect(onActiveIndexChange).toHaveBeenCalledWith(1);
    act(() => container.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]?.click());
    expect(onSelect).toHaveBeenCalledWith(ITEMS[1]);
  });

  it("keeps disabled rows visible but unselectable", () => {
    const onSelect = vi.fn();
    const disabled = { ...ITEMS[0]!, disabled: true, disabledReason: "Unavailable" };
    const container = renderPanel({
      state: { kind: "ready", items: [disabled], truncated: false },
      results: { items: [disabled], truncated: false },
      onSelect
    });
    const option = container.querySelector<HTMLButtonElement>('[role="option"]');
    expect(option?.disabled).toBe(true);
    expect(option?.getAttribute("aria-disabled")).toBe("true");
    option?.click();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("renders loading, retained-result error, and empty provider states", () => {
    const loading = renderPanel({ state: { kind: "loading" }, results: { items: [], truncated: false } });
    expect(loading.querySelector('[role="status"]')?.textContent).toBe("Loading");

    const error = renderPanel({
      state: { kind: "error", message: "Directory unavailable", items: ITEMS },
      results: { items: ITEMS, truncated: false }
    });
    expect(error.querySelector('[role="alert"]')?.textContent).toContain("Directory unavailable");

    const empty = renderPanel({ state: { kind: "ready", items: [], truncated: false }, results: { items: [], truncated: false } });
    expect(empty.textContent).toContain("No matches");
  });
});

function renderPanel(overrides: Partial<Parameters<typeof ComposerInlineMentionPanel>[0]>): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  act(() => root.render(<ComposerInlineMentionPanel
    title="References"
    query="src"
    state={{ kind: "ready", items: ITEMS, truncated: false }}
    results={{ items: ITEMS, truncated: false }}
    activeIndex={0}
    labels={{ close: "Close", loading: "Loading", empty: "No matches", more: "More matches", retry: "Retry" }}
    onActiveIndexChange={() => undefined}
    onSelect={() => undefined}
    onClose={() => undefined}
    {...overrides}
  />));
  return container;
}

const ITEMS: readonly ComposerMentionCatalogItem[] = [
  { id: "dir", kind: "directory", name: "src", path: "src/", meta: "src/" },
  { id: "file", kind: "file", name: "main.ts", path: "src/main.ts", meta: "src/main.ts" }
];
