// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { translate } from "../i18n.js";
import type { TimelineItemView } from "../model.js";
import { create } from "@bufbuild/protobuf";
import { BackgroundTaskOutputSchema, BackgroundTaskOutputState, type BackgroundTaskOutput } from "@joko/contracts";
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
  it("shows bounded recent-output states and cancels late reads when another task is selected", async () => {
    let resolve!: (value: BackgroundTaskOutput) => void, signal!: AbortSignal;
    const read = vi.fn((_id: string, owned: AbortSignal) => { signal = owned; return new Promise<BackgroundTaskOutput>(value => { resolve = value; }); });
    const container = await renderPanel({ canCancel: false, onCancel: vi.fn(), onRefresh: vi.fn(), onReadOutput: read });
    await act(async () => container.querySelector<HTMLButtonElement>(".background-task-row__select")!.click());
    expect(container.querySelector(".background-task-output")?.textContent).toContain("Loading");
    await act(async () => resolve(create(BackgroundTaskOutputSchema, { sessionId: "session", backgroundTaskId: "active", state: BackgroundTaskOutputState.AVAILABLE,
      text: "Recent output", totalBytes: 32n, truncated: true, capturedAtMs: BigInt(Date.now()) })));
    expect(container.querySelector(".background-task-output pre")?.textContent).toBe("Recent output");
    expect(container.querySelector(".background-task-output")?.textContent).toContain("most recent");
    await act(async () => container.querySelector<HTMLButtonElement>(".background-task-output button")!.click());
    const pendingSignal = signal, late = resolve;
    await act(async () => container.querySelector<HTMLButtonElement>(".background-task-detail__back")!.click());
    expect(pendingSignal.aborted).toBe(true);
    await act(async () => late(create(BackgroundTaskOutputSchema, { state: BackgroundTaskOutputState.AVAILABLE, text: "Retired output", capturedAtMs: BigInt(Date.now()) })));
    expect(container.textContent).not.toContain("Retired output");
    read.mockImplementation(async () => create(BackgroundTaskOutputSchema, { state: BackgroundTaskOutputState.UNAVAILABLE, capturedAtMs: BigInt(Date.now()) }));
    await act(async () => container.querySelector<HTMLButtonElement>(".background-task-row__select")!.click());
    expect(container.querySelector(".background-task-output")?.textContent).toContain("unavailable");
    read.mockImplementation(async () => create(BackgroundTaskOutputSchema, { state: BackgroundTaskOutputState.FAILED, capturedAtMs: BigInt(Date.now()) }));
    await act(async () => container.querySelector<HTMLButtonElement>(".background-task-output button")!.click());
    expect(container.querySelector(".background-task-output [role='alert']")?.textContent).toContain("could not be read");
    read.mockImplementation(async () => create(BackgroundTaskOutputSchema, { state: BackgroundTaskOutputState.AVAILABLE, capturedAtMs: BigInt(Date.now()) }));
    await act(async () => container.querySelector<HTMLButtonElement>(".background-task-output button")!.click());
    expect(container.querySelector(".background-task-output")?.textContent).toContain("No output yet");
  });
  it("shows a real Stop action only for active tasks when the capability is advertised", async () => {
    let resolvePending!: () => void;
    const pending = new Promise<void>((resolve) => { resolvePending = resolve; });
    const onCancel = vi.fn(() => pending);
    const onRefresh = vi.fn();
    const container = await renderPanel({ canCancel: true, onCancel, onRefresh });

    const stop = container.querySelector<HTMLButtonElement>('button[aria-label="Stop Active"]');
    expect(stop).not.toBeNull();
    expect(container.querySelector('button[aria-label="Stop Finished"]')).toBeNull();

    await act(async () => stop?.click());
    expect(onCancel).toHaveBeenCalledWith("active");
    expect(stop?.disabled).toBe(true);
    expect(stop?.textContent).toContain("Stopping");

    await act(async () => resolvePending());
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

async function renderPanel({ canCancel, onCancel, onRefresh, onReadOutput }: {
  readonly canCancel: boolean;
  readonly onCancel: (backgroundTaskId: string) => Promise<void>;
  readonly onRefresh: () => void;
  readonly onReadOutput?: (id: string, signal: AbortSignal) => Promise<BackgroundTaskOutput>;
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
    onReadOutput={onReadOutput}
    outputOwner="source"
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
