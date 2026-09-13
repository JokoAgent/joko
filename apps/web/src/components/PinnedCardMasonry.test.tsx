// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sortableMock = vi.hoisted(() => {
  class MockSortable {
    static active: MockSortable | null = null;
    static readonly instances: MockSortable[] = [];
    readonly element: HTMLElement;
    readonly options: Record<string, unknown>;
    readonly destroy = vi.fn();
    readonly option = vi.fn();

    constructor(element: HTMLElement, options: Record<string, unknown>) {
      this.element = element;
      this.options = options;
    }

    static create(element: HTMLElement, options: Record<string, unknown>): MockSortable {
      const instance = new MockSortable(element, options);
      MockSortable.instances.push(instance);
      return instance;
    }
  }
  return { MockSortable };
});

vi.mock("sortablejs", () => ({ default: sortableMock.MockSortable }));

import { visibleSidebarSessionIds } from "./Sidebar.js";
import {
  PinnedCardColumns,
  PinnedCardMasonry,
  pinnedCardColumnCount,
  reorderPinnedCardsAtDrop,
  reorderPinnedCardsByDropSlot
} from "./PinnedCardMasonry.js";

const roots: Root[] = [];
let resizeCallback: ResizeObserverCallback | undefined;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  resizeCallback = undefined;
  vi.stubGlobal("ResizeObserver", class implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) { resizeCallback = callback; }
    readonly observe = vi.fn();
    readonly unobserve = vi.fn();
    readonly disconnect = vi.fn();
  });
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  sortableMock.MockSortable.instances.length = 0;
  sortableMock.MockSortable.active = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("PinnedCardMasonry", () => {
  it("responds to the sidebar width with stable row-major card buckets", async () => {
    const { container } = await render(<PinnedCardMasonry
      items={["a", "b", "c", "d", "e"]}
      getId={(id) => id}
      renderItem={(id) => <span>{id}</span>}
      onReorder={vi.fn()}
      reducedMotion={false}
      ariaLabel="Pinned"
    />);
    const masonry = required(container.querySelector<HTMLElement>(".pinned-card-masonry"));
    Object.defineProperty(masonry, "clientWidth", { configurable: true, value: 260 });
    await act(async () => resizeCallback?.([], {} as ResizeObserver));

    expect(pinnedCardColumnCount(221)).toBe(1);
    expect(pinnedCardColumnCount(222)).toBe(2);
    expect(pinnedCardColumnCount(336)).toBe(3);
    expect(columnIds(container)).toEqual([["a", "c", "e"], ["b", "d"]]);
    expect([...container.querySelectorAll<HTMLElement>("[data-sidebar-row-order]")]
      .map((element) => element.dataset.sidebarRowOrder)).toEqual(["0", "2", "4", "1", "3"]);

    Object.defineProperty(masonry, "clientWidth", { configurable: true, value: 410 });
    await act(async () => resizeCallback?.([], {} as ResizeObserver));
    expect(columnIds(container)).toEqual([["a", "d"], ["b", "e"], ["c"]]);
  });

  it("commits an internal cross-column drop and restores React-owned DOM first", async () => {
    const onReorder = vi.fn();
    const { container } = await render(<PinnedCardColumns
      items={["a", "b", "c", "d"]}
      columns={2}
      getId={(id) => id}
      renderItem={(id) => <span>{id}</span>}
      onReorder={onReorder}
      reducedMotion={false}
    />);
    const columns = [...container.querySelectorAll<HTMLElement>("[data-pinned-card-column]")];
    const first = required(columns[0]);
    const second = required(columns[1]);
    const instance = required(sortableMock.MockSortable.instances[0]);
    const onStart = instance.options.onStart as () => void;
    const onEnd = instance.options.onEnd as (event: SortableEventShape) => void;
    const setData = instance.options.setData as (transfer: DataTransferShape, element: HTMLElement) => void;
    const moved = required(first.children[0] as HTMLElement | undefined);
    const transfer = { setData: vi.fn(), setDragImage: vi.fn() };

    setData(transfer, moved);
    expect(transfer.setData).toHaveBeenCalledWith("Text", "");
    sortableMock.MockSortable.active = instance;
    onStart();
    second.appendChild(moved);
    moved.dispatchEvent(new Event("drop", { bubbles: true }));
    onEnd({ item: moved, from: first, to: second, oldIndex: 0, newIndex: 2, newDraggableIndex: 2 });

    expect(columnIds(container)).toEqual([["a", "c"], ["b", "d"]]);
    expect(onReorder).toHaveBeenCalledOnce();
    expect(onReorder).toHaveBeenCalledWith(["b", "c", "d", "a"]);
    expect(document.body.classList.contains("sidebar-is-sorting")).toBe(false);
  });

  it("rolls back an external native drop without changing the persisted order", async () => {
    const onReorder = vi.fn();
    const { container } = await render(<PinnedCardColumns
      items={["a", "b", "c", "d"]}
      columns={2}
      getId={(id) => id}
      renderItem={(id) => <span>{id}</span>}
      onReorder={onReorder}
      reducedMotion
    />);
    const columns = [...container.querySelectorAll<HTMLElement>("[data-pinned-card-column]")];
    const first = required(columns[0]);
    const second = required(columns[1]);
    const instance = required(sortableMock.MockSortable.instances[0]);
    const onStart = instance.options.onStart as () => void;
    const onEnd = instance.options.onEnd as (event: SortableEventShape) => void;
    const moved = required(first.children[0] as HTMLElement | undefined);

    sortableMock.MockSortable.active = instance;
    onStart();
    second.appendChild(moved);
    document.body.dispatchEvent(new Event("drop", { bubbles: true }));
    onEnd({ item: moved, from: first, to: second, oldIndex: 0, newIndex: 2, newDraggableIndex: 2 });

    expect(columnIds(container)).toEqual([["a", "c"], ["b", "d"]]);
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("keeps project cards full width while preserving cross-boundary drag order", async () => {
    const onReorder = vi.fn();
    const { container } = await render(<PinnedCardColumns
      items={["task-a", "project", "task-b", "task-c"]}
      columns={2}
      getId={(id) => id}
      renderItem={(id) => <span>{id}</span>}
      onReorder={onReorder}
      reducedMotion
      isFullWidth={(id) => id === "project"}
    />);
    const wideLane = required(container.querySelector<HTMLElement>("[data-pinned-card-drop-kind='wide']"));
    const project = required(wideLane.querySelector<HTMLElement>("[data-pinned-card-id='project']"));
    const targetColumn = required(container.querySelectorAll<HTMLElement>("[data-pinned-card-drop-kind='columns']")[3]);
    const instance = required(sortableMock.MockSortable.instances[2]);
    const onStart = instance.options.onStart as () => void;
    const onEnd = instance.options.onEnd as (event: SortableEventShape) => void;

    expect(project.classList.contains("pinned-card-masonry__card--wide")).toBe(true);
    expect(columnIds(container)).toEqual([["task-a"], [], ["task-b"], ["task-c"]]);
    sortableMock.MockSortable.active = instance;
    onStart();
    targetColumn.appendChild(project);
    project.dispatchEvent(new Event("drop", { bubbles: true }));
    onEnd({ item: project, from: wideLane, to: targetColumn, oldIndex: 0, newIndex: 1, newDraggableIndex: 1 });

    expect(wideLane.firstElementChild).toBe(project);
    expect(columnIds(container)).toEqual([["task-a"], [], ["task-b"], ["task-c"]]);
    expect(onReorder).toHaveBeenCalledWith(["task-a", "task-b", "task-c", "project"]);
  });

  it("keeps keyboard selection in the persisted order across visual columns", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <div class="session-row"><button data-session-id="before"></button></div>
      <div data-sidebar-card-order="row-major">
        <div data-pinned-card-column="0">
          <div data-sidebar-row-order="0"><div class="session-row"><button data-session-id="a"></button></div></div>
          <div data-sidebar-row-order="2"><div class="session-row"><button data-session-id="c"></button></div></div>
        </div>
        <div data-pinned-card-column="1">
          <div data-sidebar-row-order="1">
            <div class="session-row"><button data-session-id="b"></button></div>
            <div class="session-row"><button data-session-id="b-child"></button></div>
          </div>
        </div>
      </div>
      <div class="session-row"><button data-session-id="after"></button></div>`;

    expect(visibleSidebarSessionIds(root)).toEqual(["before", "a", "b", "b-child", "c", "after"]);
  });

  it("rejects malformed or foreign drop identities", () => {
    expect(reorderPinnedCardsByDropSlot(["a", "b", "c", "d"], "c", 1, 1, 2))
      .toEqual(["a", "b", "d", "c"]);
    expect(reorderPinnedCardsByDropSlot(["a", "b"], "foreign", 1, 0, 2)).toEqual(["a", "b"]);
    expect(reorderPinnedCardsByDropSlot(["a", "b"], "a", 2, 0, 2)).toEqual(["a", "b"]);
    expect(reorderPinnedCardsAtDrop(["a", "project", "b"], "b", {
      kind: "wide", itemIndex: 1, row: 0
    })).toEqual(["a", "b", "project"]);
  });
});

interface SortableEventShape {
  readonly item: HTMLElement;
  readonly from: HTMLElement;
  readonly to: HTMLElement;
  readonly oldIndex: number;
  readonly newIndex: number;
  readonly newDraggableIndex: number;
}

interface DataTransferShape {
  readonly setData: (format: string, value: string) => void;
  readonly setDragImage: (element: Element, x: number, y: number) => void;
}

async function render(element: React.ReactNode): Promise<{ readonly container: HTMLDivElement }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return { container };
}

function columnIds(container: HTMLElement): readonly (readonly string[])[] {
  return [...container.querySelectorAll<HTMLElement>("[data-pinned-card-column]")]
    .map((column) => [...column.children].map((child) => (child as HTMLElement).dataset.pinnedCardId ?? ""));
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected value to exist.");
  return value;
}
