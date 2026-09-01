// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { translate } from "../i18n.js";
import type { TimelineItemView } from "../model.js";
import { BackgroundTasksPanel } from "./BackgroundTasksPanel.js";

const roots: Root[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
});

describe("BackgroundTasksPanel cancellation", () => {
  it("shows a real Stop action only for active tasks when the capability is advertised", async () => {
    const pending = Promise.withResolvers<void>();
    const onCancel = vi.fn(() => pending.promise);
    const onRefresh = vi.fn();
    const container = await renderPanel({ canCancel: true, onCancel, onRefresh });

    const stop = container.querySelector<HTMLButtonElement>('button[aria-label="Stop Active"]');
    expect(stop).not.toBeNull();
    expect(container.querySelector('button[aria-label="Stop Finished"]')).toBeNull();

    await act(async () => stop?.click());
    expect(onCancel).toHaveBeenCalledWith("active");
    expect(stop?.disabled).toBe(true);
    expect(stop?.textContent).toContain("Stopping");

    await act(async () => pending.resolve());
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("hides Stop without the independent capability and reports a confirmed failure", async () => {
    const hidden = await renderPanel({ canCancel: false, onCancel: vi.fn(async () => undefined), onRefresh: vi.fn() });
    expect(hidden.querySelector('button[aria-label="Stop Active"]')).toBeNull();
    await unmountLast();

    const failed = await renderPanel({
      canCancel: true,
      onCancel: vi.fn(async () => { throw new Error("owned runtime rejected the request"); }),
      onRefresh: vi.fn()
    });
    await act(async () => failed.querySelector<HTMLButtonElement>('button[aria-label="Stop Active"]')?.click());
    expect(failed.querySelector('[role="alert"]')?.textContent).toContain("owned runtime rejected the request");
  });
});

async function renderPanel({ canCancel, onCancel, onRefresh }: {
  readonly canCancel: boolean;
  readonly onCancel: (backgroundTaskId: string) => Promise<void>;
  readonly onRefresh: () => void;
}): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<BackgroundTasksPanel
    timeline={[task("active", "Active", "running", 1n), task("finished", "Finished", "completed", 2n)]}
    history={[]}
    historyState="ready"
    onRefresh={onRefresh}
    canCancel={canCancel}
    onCancel={onCancel}
    locale="en"
    t={(key, values) => translate("en", key, values)}
  />));
  return container;
}

async function unmountLast(): Promise<void> {
  const root = roots.pop();
  if (root !== undefined) await act(async () => root.unmount());
  document.body.replaceChildren();
}

function task(id: string, title: string, state: "running" | "completed", sequence: bigint): TimelineItemView {
  return {
    id: `event-${id}`,
    sequence,
    createdAt: Number(sequence) * 1_000,
    kind: "background",
    background: {
      id,
      title,
      state,
      startedAt: Number(sequence) * 1_000,
      ...(state === "completed" ? { endedAt: Number(sequence) * 2_000 } : {})
    }
  };
}
