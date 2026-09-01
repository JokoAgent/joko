// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderOrderList } from "./ProviderOrderList.js";

const roots: Root[] = [];
const items = [
  { id: "first", name: "First" },
  { id: "second", name: "Second" },
  { id: "third", name: "Third" }
];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("ProviderOrderList", () => {
  it("exposes a drag handle and moves the focused Provider with Arrow keys", async () => {
    const onReorder = vi.fn<(ids: readonly string[]) => void>();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ProviderOrderList
      items={items}
      labels={{
        list: "Provider order",
        reorder: (name) => `Reorder ${name}`,
        moved: (name, position, total) => `${name} moved to ${position} of ${total}`,
        changed: "Provider order changed"
      }}
      onReorder={onReorder}
      renderItem={(item) => <article>{item.name}</article>}
    />));

    const handle = required(container.querySelector<HTMLButtonElement>('[aria-label="Reorder Second"]'));
    handle.focus();
    await act(async () => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));

    expect(onReorder).toHaveBeenCalledWith(["second", "first", "third"]);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Second moved to 1 of 3");
    expect(document.activeElement).toBe(handle);
  });

  it("does not publish an order that crosses a list edge", async () => {
    const onReorder = vi.fn<(ids: readonly string[]) => void>();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ProviderOrderList
      items={items}
      labels={{ list: "Providers", reorder: (name) => name, moved: () => "moved", changed: "changed" }}
      onReorder={onReorder}
      renderItem={(item) => item.name}
    />));

    const first = required(container.querySelector<HTMLButtonElement>('[aria-label="First"]'));
    await act(async () => first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    expect(onReorder).not.toHaveBeenCalled();
  });
});

function required<T>(value: T | null): T {
  if (value === null) throw new Error("Expected element");
  return value;
}
