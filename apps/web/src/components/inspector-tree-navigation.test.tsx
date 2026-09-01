// @vitest-environment jsdom

import { useState, type JSX } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { inspectorTreeItems, useInspectorTreeNavigation } from "./inspector-tree-navigation.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("Inspector tree navigation", () => {
  it("uses one roving tree stop and supports expansion, hierarchy, range, and activation keys", async () => {
    const activated = vi.fn();
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    roots.push(root);
    await act(async () => root.render(<NestedTree activated={activated} />));

    const tree = required(host.querySelector<HTMLDivElement>('[role="tree"]'));
    let items = inspectorTreeItems(tree);
    expect(items.map((item) => item.tabIndex)).toEqual([0, -1]);
    expect(tree.querySelector<HTMLElement>("[data-inspector-tree-toggle]")?.tabIndex).toBe(-1);
    expect(tree.querySelector<HTMLElement>("[data-inspector-tree-primary]")?.tabIndex).toBe(-1);
    expect(tree.querySelector<HTMLElement>("[data-inspector-tree-secondary-action]")?.tabIndex).toBe(0);

    items[0]?.focus();
    await press(items[0], "ArrowRight");
    items = inspectorTreeItems(tree);
    expect(items).toHaveLength(3);
    expect(items[0]?.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(items[0]);

    await press(items[0], "ArrowRight");
    expect(document.activeElement).toBe(items[1]);
    await press(items[1], "ArrowDown");
    expect(document.activeElement).toBe(items[2]);
    await press(items[2], "Home");
    expect(document.activeElement).toBe(items[0]);
    await press(items[0], "End");
    expect(document.activeElement).toBe(items[2]);
    await press(items[2], "ArrowUp");
    expect(document.activeElement).toBe(items[1]);
    await press(items[1], "ArrowLeft");
    expect(document.activeElement).toBe(items[0]);

    await press(items[0], "ArrowLeft");
    items = inspectorTreeItems(tree);
    expect(items).toHaveLength(2);
    expect(items[0]?.getAttribute("aria-expanded")).toBe("false");
    await press(items[1], "Enter");
    await press(items[1], " ");
    expect(activated).toHaveBeenNthCalledWith(1, "sibling");
    expect(activated).toHaveBeenNthCalledWith(2, "sibling");
  });

  it("requests unmounted virtual rows for Arrow and End navigation", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    roots.push(root);
    await act(async () => root.render(<VirtualTree />));

    const tree = required(host.querySelector<HTMLDivElement>('[role="tree"]'));
    let active = required(tree.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]'));
    active.focus();
    await press(active, "ArrowDown", true);
    active = required(tree.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]'));
    expect(active.dataset.inspectorTreeIndex).toBe("1");

    await press(active, "End", true);
    active = required(tree.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]'));
    expect(active.dataset.inspectorTreeIndex).toBe("3");
    expect(document.activeElement).toBe(active);
  });
});

function NestedTree({ activated }: { readonly activated: (id: string) => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const navigation = useInspectorTreeNavigation();
  return <div ref={navigation.ref} role="tree" aria-label="Example tree" onFocusCapture={navigation.onFocusCapture} onKeyDown={navigation.onKeyDown}>
    <div role="treeitem" tabIndex={-1} aria-level={1} aria-expanded={open} data-inspector-tree-key="folder">
      <button type="button" data-inspector-tree-toggle="" onClick={() => setOpen((value) => !value)}>Toggle</button>
      <button type="button" data-inspector-tree-primary="" onClick={() => activated("folder")}>Folder</button>
      <button type="button" data-inspector-tree-secondary-action="">Fork</button>
      {open && <div role="group"><button type="button" role="treeitem" tabIndex={-1} aria-level={2} data-inspector-tree-key="child" onClick={() => activated("child")}>Child</button></div>}
    </div>
    <button type="button" role="treeitem" tabIndex={-1} aria-level={1} data-inspector-tree-key="sibling" onClick={() => activated("sibling")}>Sibling</button>
  </div>;
}

function VirtualTree(): JSX.Element {
  const [indices, setIndices] = useState<readonly number[]>([0, 1]);
  const navigation = useInspectorTreeNavigation({
    itemCount: 4,
    onRequestItem: (index) => setIndices([index])
  });
  return <div ref={navigation.ref} role="tree" aria-label="Virtual tree" onFocusCapture={navigation.onFocusCapture} onKeyDown={navigation.onKeyDown}>
    {indices.map((index) => <button key={index} type="button" role="treeitem" tabIndex={-1} aria-level={1} data-inspector-tree-key={`item-${index}`} data-inspector-tree-index={index}>Item {index}</button>)}
  </div>;
}

async function press(target: Element | undefined, key: string, waitForFrame = false): Promise<void> {
  await act(async () => {
    target?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    if (waitForFrame) await new Promise((resolve) => window.setTimeout(resolve, 20));
  });
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected the tree control to exist.");
  return value;
}
