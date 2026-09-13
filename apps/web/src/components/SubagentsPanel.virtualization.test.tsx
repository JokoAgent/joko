// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import type { SubagentChildRunView, SubagentRunDetailView, SubagentRunView, SubagentTranscriptEntryView } from "../model.js";
import { SubagentsPanel } from "./SubagentsPanel.js";

const roots: Root[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
});

describe("SubagentsPanel virtual interaction", () => {
  it("uses keyboard-selectable tabs, focuses detail entry, and restores an offscreen run row on return", async () => {
    const runs = Array.from({ length: 220 }, (_, index) => run(`run-${index}`, `Run ${index}`, "completed", index));
    const selected = runs[0]!;
    const children = [child("alpha", "Alpha"), child("beta", "Beta"), child("gamma", "Gamma")];
    const controller = {
      listSubagentRuns: vi.fn(async () => ({ runs, totalSize: runs.length })),
      getSubagentRun: vi.fn(async () => detail(selected, children, { viewFullTranscript: false })),
      listSubagentTranscript: vi.fn()
    } as unknown as AppController;
    const container = await mount(controller, { focusRunId: selected.id, focusRequestId: 1 });
    await waitForFrame();

    const back = container.querySelector<HTMLButtonElement>(".subagent-detail-bar > .icon-button")!;
    expect(document.activeElement).toBe(back);
    const tablist = container.querySelector<HTMLElement>('[role="tablist"]');
    expect(tablist).not.toBeNull();
    const overview = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((tab) => tab.textContent === "Overview")!;
    overview.focus();
    await act(async () => overview.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
    await waitForFrame();

    const alpha = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((tab) => tab.textContent?.includes("Alpha"));
    expect(alpha?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(alpha);
    expect(container.querySelector<HTMLElement>('[role="tabpanel"]')?.getAttribute("aria-labelledby")).toBe(alpha?.id);

    await act(async () => back.click());
    await waitForFrame(4);
    const focusedRun = document.activeElement as HTMLButtonElement;
    expect(focusedRun.tagName).toBe("BUTTON");
    expect(focusedRun.textContent).toContain("Run 0");
  });

  it("detaches on upward intent, preserves focus and anchor on tail append, and jumps instantly under reduced motion", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", vi.fn(() => mediaQuery(true)));
    let transcriptRead = 0;
    const active = run("active", "Active", "running", 1);
    const controller = {
      listSubagentRuns: vi.fn(async () => ({ runs: [active], totalSize: 1 })),
      getSubagentRun: vi.fn(async () => detail(active, [child("child", "Child")], { viewFullTranscript: true })),
      listSubagentTranscript: vi.fn(async (_sessionId: string, _runId: string, _childId: unknown, token: string) => {
        transcriptRead += 1;
        return token === "tail-1"
          ? { entries: [entry("latest", 2, "subagent", "new durable tail")], tailPageToken: "tail-2", totalSize: 2 }
          : { entries: [entry("initial", 1, "parent", "existing history")], tailPageToken: "tail-1", totalSize: 1 };
      })
    } as unknown as AppController;
    const container = await mount(controller, { focusRunId: active.id, focusRequestId: 1 });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    const viewport = container.querySelector<HTMLElement>(".subagent-conversation")!;
    let scrollTop = 9_150;
    const scrollTo = vi.fn((options: ScrollToOptions) => { if (typeof options.top === "number") scrollTop = options.top; });
    Object.defineProperties(viewport, {
      scrollTop: { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } },
      scrollHeight: { configurable: true, value: 10_000 },
      clientHeight: { configurable: true, value: 800 },
      scrollTo: { configurable: true, value: scrollTo }
    });

    await act(async () => viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -40, bubbles: true, cancelable: true })));
    scrollTop -= 1;
    await act(async () => viewport.dispatchEvent(new Event("scroll", { bubbles: true })));
    const composer = container.querySelector<HTMLTextAreaElement>(".subagent-composer textarea")!;
    composer.focus();
    const detachedScrollTop = scrollTop;
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    await settle(16);

    expect(transcriptRead).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toContain("new durable tail");
    expect(container.querySelector(".subagent-conversation__jump")?.getAttribute("aria-label")).toContain("(1)");
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain("New agent activity");
    expect(document.activeElement).toBe(composer);
    expect(scrollTop).toBe(detachedScrollTop);

    await act(async () => container.querySelector<HTMLButtonElement>(".subagent-conversation__jump")?.click());
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(scrollTo.mock.calls.some(([options]) => options.behavior === "smooth")).toBe(false);
    expect(scrollTo.mock.calls.some(([options]) => options.behavior === "auto")).toBe(true);
  });

  it("retains tool expansion through a durable update and keeps verified content when a later read fails", async () => {
    vi.useFakeTimers();
    let transcriptRead = 0;
    const active = run("tool-run", "Tool run", "running", 1);
    const controller = {
      listSubagentRuns: vi.fn(async () => ({ runs: [active], totalSize: 1 })),
      getSubagentRun: vi.fn(async () => detail(active, [child("child", "Child")], { viewFullTranscript: true })),
      listSubagentTranscript: vi.fn(async (_sessionId: string, _runId: string, _childId: unknown, token: string) => {
        transcriptRead += 1;
        if (transcriptRead === 1) return {
          entries: [entry("tool-start", 1, "tool", "read source", { toolName: "read", toolCallId: "call", toolPhase: "start" })],
          tailPageToken: "tail-1",
          totalSize: 1
        };
        if (transcriptRead === 2 && token === "tail-1") return {
          entries: [entry("tool-end", 2, "tool", "verified result", { toolName: "read", toolCallId: "call", toolPhase: "end" })],
          tailPageToken: "tail-2",
          totalSize: 2
        };
        throw new Error("temporary transcript read failure");
      })
    } as unknown as AppController;
    const container = await mount(controller, { focusRunId: active.id, focusRequestId: 1 });
    const summary = container.querySelector<HTMLElement>(".subagent-tool > summary")!;
    await act(async () => summary.click());
    expect(container.querySelector(".subagent-tool")?.hasAttribute("open")).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    await settle(16);
    expect(container.textContent).toContain("verified result");
    expect(container.querySelector(".subagent-tool")?.hasAttribute("open")).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    await settle(16);
    expect(container.textContent).toContain("temporary transcript read failure");
    expect(container.textContent).toContain("verified result");
    expect(container.querySelector(".subagent-tool")?.hasAttribute("open")).toBe(true);
  });
});

function run(id: string, title: string, state: SubagentRunView["state"], updatedAt: number): SubagentRunView {
  return {
    id,
    sessionId: "session-one",
    identityAliases: [],
    providerRunIds: [],
    state,
    title,
    capabilities: {
      viewActivity: true,
      viewReturnedResult: true,
      viewFullTranscript: true,
      stop: state === "running",
      steer: state === "running",
      followUp: state === "running",
      resume: false,
      parentContext: "live"
    },
    startedAt: updatedAt,
    updatedAt,
    revision: 1n
  };
}

function child(id: string, title: string): SubagentChildRunView {
  return { id, identityAliases: [], title, state: "running", startedAt: 1 };
}

function detail(
  selectedRun: SubagentRunView,
  children: readonly SubagentChildRunView[],
  capabilities: Partial<SubagentRunView["capabilities"]>
): SubagentRunDetailView {
  return { run: { ...selectedRun, capabilities: { ...selectedRun.capabilities, ...capabilities } }, children, childrenObserved: true, activity: [] };
}

function entry(
  id: string,
  sequence: number,
  role: SubagentTranscriptEntryView["role"],
  content: string,
  patch: Partial<SubagentTranscriptEntryView> = {}
): SubagentTranscriptEntryView {
  return { id, sequence, role, content, occurredAt: sequence, ...patch };
}

async function mount(controller: AppController, focus: { readonly focusRunId: string; readonly focusRequestId: number }): Promise<HTMLDivElement> {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<SubagentsPanel
    controller={controller}
    sessionId="session-one"
    {...focus}
    locale="en"
    t={(key, values) => translate("en", key, values)}
    runAction={(_key, action) => { void action(); }}
  />));
  await settle(24);
  return container;
}

function mediaQuery(matches: boolean): MediaQueryList {
  return {
    matches,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true)
  };
}

async function waitForFrame(count = 1): Promise<void> {
  await act(async () => {
    for (let index = 0; index < count; index += 1) await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));
  });
}

async function settle(rounds = 8): Promise<void> {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}
