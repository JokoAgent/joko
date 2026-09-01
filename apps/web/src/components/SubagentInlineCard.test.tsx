// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BackgroundTaskView, SubagentRunDetailView, SubagentRunView } from "../model.js";
import { SubagentInlineCard } from "./SubagentInlineCard.js";
import type { Translator } from "./types.js";

const roots: Root[] = [];
const t: Translator = (key, values) => {
  if (key === "timeline.subagent") return "Subagent";
  if (key === "subagents.stateRunning") return "Running";
  if (key === "subagents.tokens") return `${String(values?.["count"])} tokens`;
  if (key === "subagents.toolUses") return `${String(values?.["count"])} tools`;
  if (key === "subagents.readOnly") return "Read-only";
  if (key === "subagents.writeEnabled") return "Write-enabled";
  if (key === "subagents.tool") return "Tool";
  if (key === "subagents.children") return "Children";
  if (key === "subagents.resultTruncated") return "The result was truncated";
  if (key === "timeline.subagentShowFullResult") return "Show full result";
  if (key === "timeline.subagentHideFullResult") return "Hide full result";
  return key;
};

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
});

describe("SubagentInlineCard", () => {
  it("renders status, proven route and usage, then expands durable detail", () => {
    const { container } = mount();
    expect(container.textContent).toContain("Research");
    expect(container.textContent).toContain("Running");
    expect(container.textContent).toContain("1.2k tokens");
    expect(container.textContent).toContain("7 tools");
    expect(container.textContent).toContain("1m 5s");
    expect(container.querySelector("[data-subagent-model]")?.textContent).toBe("provider/model-large · high");
    expect(container.textContent).not.toContain("Reading tests");
    act(() => container.querySelector<HTMLButtonElement>(".subagent-inline-card__toggle")?.click());
    expect(container.textContent).toContain("Inspect the failure");
    expect(container.textContent).toContain("Reading tests");
  });

  it("opens the exact run and gates stop through the projected capability", async () => {
    const onOpen = vi.fn();
    const onStop = vi.fn(async () => undefined);
    const { container } = mount({ onOpen, onStop });
    const actions = container.querySelectorAll<HTMLButtonElement>(".subagent-inline-card__action");
    act(() => actions[0]?.click());
    await act(async () => actions[1]?.click());
    expect(onOpen).toHaveBeenCalledWith("run-one");
    expect(onStop).toHaveBeenCalledWith("run-one");
  });

  it("omits unproved route and usage metadata", () => {
    const { container } = mount({ run: { ...run(), route: undefined, usage: undefined } });
    expect(container.querySelector("[data-subagent-model]")).toBeNull();
    expect(container.textContent).not.toContain("tokens");
    expect(container.textContent).not.toContain("tools");
  });

  it("collapses long output and shows explicit access and cost metadata", () => {
    const id = "long-run";
    const summary = ["one", "two", "three", "four", "five"].join("\n");
    const { container } = mount({
      task: { ...task(), id },
      run: {
        ...run(),
        id,
        summary,
        readOnly: true,
        usage: { ...run().usage, costUsd: 0.005 }
      }
    });
    expect(container.textContent).toContain("Read-only");
    expect(container.textContent).toContain("<$0.01");
    act(() => container.querySelector<HTMLButtonElement>(".subagent-inline-card__toggle")?.click());
    const resultToggle = container.querySelector<HTMLButtonElement>(".subagent-inline-card__result-toggle");
    expect(resultToggle?.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).toContain("Show full result");
    act(() => resultToggle?.click());
    expect(resultToggle?.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Hide full result");
  });

  it("renders the returned result when the list summary is empty and exposes typed last-tool and child-count facts", () => {
    const id = "detail-run";
    const detailRun = { ...run(), id, state: "completed" as const, summary: undefined, revision: 2n };
    const { container } = mount({
      task: { ...task(), id, state: "completed" },
      run: detailRun,
      detail: {
        run: detailRun,
        returnedResult: "Final answer from durable detail",
        activity: [{ sequence: 9, kind: "completed", state: "completed", lastToolName: "verify_build", occurredAt: 3_000 }],
        children: [child("child-one"), child("child-two")],
        childrenObserved: true
      }
    });
    act(() => container.querySelector<HTMLButtonElement>(".subagent-inline-card__toggle")?.click());
    expect(container.querySelector("[data-subagent-result]")?.textContent).toBe("Final answer from durable detail");
    expect(container.querySelector("[data-subagent-last-tool]")?.textContent).toContain("verify_build");
    expect(container.querySelector("[data-subagent-child-count]")?.textContent).toBe("Children: 2");
  });

  it("collapses a long returned result and expands it without falling back to the notification summary", () => {
    const id = "long-detail-run";
    const detailRun = { ...run(), id, state: "completed" as const, summary: "Notification only", revision: 2n };
    const returnedResult = `one\ntwo\nthree\nfour\nfive\n${"tail".repeat(100)}`;
    const { container } = mount({
      task: { ...task(), id, state: "completed" },
      run: detailRun,
      detail: { run: detailRun, returnedResult, activity: [], children: [] }
    });
    act(() => container.querySelector<HTMLButtonElement>(".subagent-inline-card__toggle")?.click());
    expect(container.textContent).not.toContain("Notification only");
    const resultToggle = container.querySelector<HTMLButtonElement>(".subagent-inline-card__result-toggle");
    expect(resultToggle?.getAttribute("aria-expanded")).toBe("false");
    act(() => resultToggle?.click());
    expect(resultToggle?.getAttribute("aria-expanded")).toBe("true");
  });
});

function mount(input: { readonly task?: BackgroundTaskView; readonly run?: SubagentRunView; readonly detail?: SubagentRunDetailView; readonly onOpen?: (runId: string) => void; readonly onStop?: (runId: string) => Promise<void> } = {}): { readonly container: HTMLDivElement } {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<SubagentInlineCard task={input.task ?? task()} run={input.run ?? run()} detail={input.detail} t={t} onOpen={input.onOpen} onStop={input.onStop} />));
  return { container };
}

function task(): BackgroundTaskView {
  return { id: "run-one", title: "Research", state: "running" };
}

function run(): SubagentRunView {
  return {
    id: "run-one",
    sessionId: "session-one",
    identityAliases: [],
    providerRunIds: [],
    state: "running",
    title: "Research",
    description: "Inspect the failure",
    summary: "Reading tests",
    route: { providerId: "provider", modelId: "model-large", thinkingLevel: "high" },
    usage: { totalTokens: 1_234, toolUses: 7, durationMs: 65_400 },
    capabilities: { viewActivity: true, viewReturnedResult: true, viewFullTranscript: true, stop: true, steer: true, followUp: true, resume: false, parentContext: "snapshot" },
    startedAt: 1_000,
    updatedAt: 2_000,
    revision: 1n
  };
}

function child(id: string): SubagentRunDetailView["children"][number] {
  return {
    id,
    identityAliases: [],
    title: id,
    state: "completed",
    startedAt: 1_000
  };
}
