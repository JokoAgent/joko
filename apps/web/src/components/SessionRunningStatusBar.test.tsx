// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView, TimelineItemView } from "../model.js";
import { SessionRunningStatusBar } from "./SessionRunningStatusBar.js";
import type { Translator } from "./types.js";

const roots: Root[] = [];
const t: Translator = (key, values) => {
  if (key === "runningStatus.tokens") return `${String(values?.["tokens"])} tokens`;
  if (key === "runningStatus.rate") return `${String(values?.["rate"])} tokens/s`;
  if (key === "runningStatus.background") return `${String(values?.["count"])} background tasks running`;
  return key;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(70_000));
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now() + 500), 1));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
});

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("session running status bar", () => {
  it("shows the latest status, authoritative elapsed time, and proven rate", () => {
    const mounted = mount({
      session: runningSession(),
      items: [
        { id: "status", sequence: 1n, kind: "status", runId: "run-1", createdAt: 1, title: "Reading files", streaming: true },
        usageItem(true)
      ]
    });
    expect(mounted.host.textContent).toContain("Reading files");
    expect(mounted.host.textContent).toContain("1m 5s");
    expect(mounted.host.textContent).toContain("100 tokens/s");
  });

  it("replaces stale foreground meta with a serial stop-all action for background work", () => {
    const onStop = vi.fn();
    const mounted = mount({ session: { ...runningSession(), state: "idle", activeRunId: undefined }, backgroundTaskIds: ["a", "b"], onStop });
    expect(mounted.host.textContent).toContain("2 background tasks running");
    expect(mounted.host.textContent).not.toContain("tokens/s");
    act(() => mounted.host.querySelector<HTMLButtonElement>("button")?.click());
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("keeps a silent native retry visually in the ordinary running state", () => {
    const mounted = mount({
      session: { ...runningSession(), state: "retrying" },
      items: []
    });
    expect(mounted.host.textContent).toContain("session.running");
    expect(mounted.host.textContent).not.toContain("session.retrying");
  });

  it("lingers for one second, fades for 400ms, then removes the row", () => {
    const mounted = mount({ session: runningSession() });
    act(() => mounted.root.render(node({ session: { ...runningSession(), state: "idle", activeRunId: undefined } })));
    expect(mounted.host.textContent).toContain("runningStatus.done");
    act(() => vi.advanceTimersByTime(999));
    expect(mounted.host.querySelector("[data-running-status]")).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(mounted.host.querySelector("[data-running-status]")).not.toBeNull();
    act(() => vi.advanceTimersByTime(400));
    expect(mounted.host.querySelector("[data-running-status]")).toBeNull();
  });
});

function mount(input: Partial<Parameters<typeof node>[0]> = {}): { readonly host: HTMLDivElement; readonly root: Root } {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node(input)));
  return { host, root };
}

function node(input: {
  readonly session?: SessionView;
  readonly items?: readonly TimelineItemView[];
  readonly backgroundTaskIds?: readonly string[];
  readonly onStop?: () => void;
} = {}) {
  return <SessionRunningStatusBar
    session={input.session ?? runningSession()}
    items={input.items ?? [usageItem(false)]}
    backgroundTaskIds={input.backgroundTaskIds ?? []}
    canStopBackgroundTasks
    backgroundStopping={false}
    t={t}
    onStopBackgroundTasks={input.onStop ?? vi.fn()}
  />;
}

function runningSession(): SessionView {
  return {
    id: "session-1",
    backendId: "backend-1",
    targetId: "target-1",
    name: "Task",
    state: "running",
    pinned: false,
    archived: false,
    generation: 1n,
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    updatedAt: 70_000,
    activeRunId: "run-1",
    activeRunStartedAt: 5_000
  } as SessionView;
}

function usageItem(reliable: boolean): TimelineItemView {
  return {
    id: "usage",
    sequence: 2n,
    kind: "assistant",
    runId: "run-1",
    createdAt: 2,
    text: "done segment",
    usage: {
      inputTokens: 500,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1_000,
      cost: 0,
      currency: "USD",
      generationDurationMs: reliable ? 5_000 : undefined,
      generationReliable: reliable
    } as NonNullable<TimelineItemView["usage"]>
  };
}
