// @vitest-environment jsdom

import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import type { SubagentChildRunView, SubagentRunDetailView, SubagentRunView, SubagentTranscriptEntryView } from "../model.js";
import { SubagentsPanel } from "./SubagentsPanel.js";
import { MAXIMUM_COMPLETE_SUBAGENT_TRANSCRIPT_PAGES } from "./subagent-panel-state.js";

const roots: Root[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
});

describe("SubagentsPanel", () => {
  it("loads run history on demand, eagerly completes the selected transcript, and maps the two Enter intents", async () => {
    vi.useFakeTimers();
    const controlSubagent = vi.fn(async () => undefined);
    const listSubagentRuns = vi.fn(async (_session: string, _state: unknown, token: string) => token === ""
      ? { runs: [run()], nextPageToken: "runs-2", totalSize: 2 }
      : { runs: [{ ...run(), id: "delegated-two", title: "Second run", state: "completed" as const }], totalSize: 2 });
    const listSubagentTranscript = vi.fn(async (_session: string, _run: string, _child: unknown, token: string) => token === ""
      ? {
          entries: [
            transcript("parent", 1, "parent", "Check the failure"),
            transcript("tool-start", 2, "tool", "read(file.ts)", { toolName: "read", toolCallId: "call", toolPhase: "start" })
          ],
          nextPageToken: "transcript-2",
          tailPageToken: "tail-1",
          totalSize: 3
        }
      : {
          entries: [transcript("tool-end", 3, "tool", "evidence", { toolName: "read", toolCallId: "call", toolPhase: "end" })],
          tailPageToken: "tail-2",
          totalSize: 3
        });
    const controller = {
      listSubagentRuns,
      getSubagentRun: vi.fn(async () => detail({ returnedResult: undefined })),
      listSubagentTranscript,
      controlSubagent
    } as unknown as AppController;
    const { container } = await mount(controller);

    expect(container.textContent).not.toContain("Second run");
    expect(container.querySelectorAll(".subagents-run-row")).toHaveLength(1);
    expect(listSubagentRuns.mock.calls.map((call) => call[2])).toEqual([""]);

    await act(async () => container.querySelector<HTMLButtonElement>(".subagents-run-list__more")?.click());
    await settle();
    expect(container.textContent).toContain("Second run");
    expect(container.querySelectorAll(".subagents-run-row")).toHaveLength(2);
    expect(listSubagentRuns.mock.calls.map((call) => call[2])).toEqual(["", "runs-2"]);

    await act(async () => container.querySelector<HTMLButtonElement>(".subagents-run-row")?.click());
    await settle(16);
    expect(container.textContent).toContain("Check the failure");
    expect(container.textContent).toContain("read(file.ts)");
    expect(listSubagentTranscript.mock.calls.slice(0, 2).map((call) => call[3])).toEqual(["", "transcript-2"]);

    const textarea = container.querySelector<HTMLTextAreaElement>(".subagent-composer textarea");
    expect(textarea).not.toBeNull();
    await act(async () => setTextArea(textarea!, "Continue with assertions"));
    await act(async () => dispatchEnter(textarea!));
    await settle();
    expect(controlSubagent).toHaveBeenCalledWith("session-one", "delegated-one", "followUp", "Continue with assertions", "child-one");

    await act(async () => setTextArea(textarea!, "Stop and inspect the fixture"));
    await act(async () => dispatchEnter(textarea!, { ctrlKey: true }));
    await settle();
    expect(controlSubagent).toHaveBeenLastCalledWith("session-one", "delegated-one", "steer", "Stop and inspect the fixture", "child-one");

    await act(async () => container.querySelector<HTMLButtonElement>(".subagent-detail-bar .icon-button")?.click());
    expect(container.textContent).toContain("Second run");
    expect(container.querySelector(".subagent-detail")).toBeNull();
  });

  it("polls list, detail and tail serially through a terminal transition", async () => {
    vi.useFakeTimers();
    let listReads = 0;
    let detailReads = 0;
    let transcriptReads = 0;
    let inFlight = 0;
    let maximumInFlight = 0;
    const serial = async <T,>(value: T): Promise<T> => {
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return value;
    };
    const controller = {
      listSubagentRuns: vi.fn(async () => serial({
        runs: [{ ...run(), state: listReads++ === 0 ? "running" as const : "completed" as const }],
        totalSize: 1
      })),
      getSubagentRun: vi.fn(async () => serial(detailReads++ === 0 ? detail() : detail({
        run: { ...run(), state: "completed", capabilities: { ...run().capabilities, resume: true } },
        children: [{ ...child(), state: "completed", result: "tail answer", endedAt: 4_000 }],
        returnedResult: "tail answer"
      }))),
      listSubagentTranscript: vi.fn(async (_session: string, _run: string, _child: unknown, token: string) => {
        transcriptReads += 1;
        return serial(token === "tail-1"
          ? { entries: [transcript("answer", 2, "subagent", "tail answer", { childId: "child-one" })], tailPageToken: "tail-2", totalSize: 2 }
          : { entries: [transcript("parent", 1, "parent", "work")], tailPageToken: "tail-1", totalSize: 1 });
      })
    } as unknown as AppController;
    const { container } = await mount(controller, focused());
    expect(container.textContent).toContain("Running");
    maximumInFlight = 0;

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    await settle();
    expect(container.textContent).toContain("tail answer");
    expect(container.textContent).toContain("Completed");
    expect(container.querySelector<HTMLTextAreaElement>(".subagent-composer textarea")?.placeholder).toContain("Continue");
    expect(transcriptReads).toBeGreaterThanOrEqual(2);
    expect(maximumInFlight).toBe(1);
  });

  it("falls back to a complete head read immediately when a tail cursor is rejected", async () => {
    vi.useFakeTimers();
    const transcriptTokens: string[] = [];
    let initial = true;
    const controller = {
      listSubagentRuns: vi.fn(async () => ({ runs: [run()], totalSize: 1 })),
      getSubagentRun: vi.fn(async () => detail()),
      listSubagentTranscript: vi.fn(async (_session: string, _run: string, _child: unknown, token: string) => {
        transcriptTokens.push(token);
        if (initial) {
          initial = false;
          return { entries: [transcript("old", 1, "subagent", "old answer", { childId: "child-one" })], tailPageToken: "invalid-tail", totalSize: 1 };
        }
        if (token === "invalid-tail") throw new Error("cursor is no longer valid");
        return { entries: [transcript("new", 2, "subagent", "replacement answer", { childId: "child-one" })], tailPageToken: "new-tail", totalSize: 1 };
      })
    } as unknown as AppController;
    const { container } = await mount(controller, focused());

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    await settle();
    expect(transcriptTokens).toEqual(expect.arrayContaining(["invalid-tail", ""]));
    expect(container.textContent).toContain("replacement answer");
    expect(container.textContent).not.toContain("old answer");
  });

  it("does not publish a transcript prefix at the page bound and recovers on retry", async () => {
    let overLimit = true;
    const listSubagentTranscript = vi.fn(async () => overLimit
      ? {
          entries: [transcript(`partial-${listSubagentTranscript.mock.calls.length}`, listSubagentTranscript.mock.calls.length, "subagent", `partial page ${listSubagentTranscript.mock.calls.length}`)],
          nextPageToken: `unique-${listSubagentTranscript.mock.calls.length}`,
          tailPageToken: `tail-${listSubagentTranscript.mock.calls.length}`,
          totalSize: MAXIMUM_COMPLETE_SUBAGENT_TRANSCRIPT_PAGES + 1
        }
      : {
          entries: [transcript("recovered", 1, "subagent", "complete retry answer", { childId: "child-one" })],
          tailPageToken: "recovered-tail",
          totalSize: 1
        });
    const controller = {
      listSubagentRuns: vi.fn(async () => ({ runs: [run()], totalSize: 1 })),
      getSubagentRun: vi.fn(async () => detail({ returnedResult: "durable final answer" })),
      listSubagentTranscript
    } as unknown as AppController;
    const { container } = await mount(controller, focused());
    await settle(MAXIMUM_COMPLETE_SUBAGENT_TRANSCRIPT_PAGES + 16);

    expect(listSubagentTranscript).toHaveBeenCalledTimes(MAXIMUM_COMPLETE_SUBAGENT_TRANSCRIPT_PAGES);
    expect(container.textContent).toContain("safe page limit");
    expect(container.textContent).toContain("durable final answer");
    expect(container.textContent).not.toContain("partial page");

    overLimit = false;
    await act(async () => container.querySelector<HTMLButtonElement>(".subagents-failure button")?.click());
    await settle(16);
    expect(listSubagentTranscript).toHaveBeenCalledTimes(MAXIMUM_COMPLETE_SUBAGENT_TRANSCRIPT_PAGES + 1);
    expect(container.textContent).toContain("complete retry answer");
    expect(container.textContent).not.toContain("partial page");
    expect(container.querySelector(".subagents-failure")).toBeNull();
  });

  it("re-reads the complete transcript on every active refresh when no tail token is available", async () => {
    vi.useFakeTimers();
    let transcriptRead = 0;
    const tokens: string[] = [];
    const controller = {
      listSubagentRuns: vi.fn(async () => ({ runs: [run()], totalSize: 1 })),
      getSubagentRun: vi.fn(async () => detail()),
      listSubagentTranscript: vi.fn(async (_session: string, _run: string, _child: unknown, token: string) => {
        tokens.push(token);
        transcriptRead += 1;
        return { entries: [transcript(`answer-${transcriptRead}`, transcriptRead, "subagent", `answer ${transcriptRead}`, { childId: "child-one" })], totalSize: 1 };
      })
    } as unknown as AppController;
    const { container } = await mount(controller, focused());

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    await settle();
    expect(tokens.slice(0, 2)).toEqual(["", ""]);
    expect(container.textContent).toContain("answer 2");
    expect(container.textContent).not.toContain("answer 1");
  });

  it("keeps sibling drafts independent and follows the selected child into its resumed generation", async () => {
    vi.useFakeTimers();
    let currentDetail = detail({
      children: [
        child({ id: "alpha-old", title: "Alpha", assignment: "alpha task" }),
        child({ id: "beta", title: "Beta", assignment: "beta task" })
      ]
    });
    const controlSubagent = vi.fn(async () => undefined);
    const controller = {
      listSubagentRuns: vi.fn(async () => ({ runs: [run()], totalSize: 1 })),
      getSubagentRun: vi.fn(async () => currentDetail),
      listSubagentTranscript: vi.fn(async () => ({ entries: [
        transcript("alpha-line", 1, "subagent", "alpha answer", { childId: "alpha-old" }),
        transcript("beta-line", 2, "subagent", "beta answer", { childId: "beta" })
      ], tailPageToken: "tail", totalSize: 2 })),
      controlSubagent
    } as unknown as AppController;
    const { container } = await mount(controller, focused());

    const childButtons = [...container.querySelectorAll<HTMLButtonElement>(".subagent-child-tabs button")];
    await act(async () => childButtons.find((button) => button.textContent?.includes("Alpha"))?.click());
    expect(container.textContent).toContain("alpha answer");
    expect(container.textContent).not.toContain("beta answer");
    let textarea = container.querySelector<HTMLTextAreaElement>(".subagent-composer textarea")!;
    await act(async () => setTextArea(textarea, "alpha draft"));

    await act(async () => childButtons.find((button) => button.textContent?.includes("Beta"))?.click());
    textarea = container.querySelector<HTMLTextAreaElement>(".subagent-composer textarea")!;
    expect(textarea.value).toBe("");
    await act(async () => setTextArea(textarea, "beta draft"));
    await act(async () => childButtons.find((button) => button.textContent?.includes("Alpha"))?.click());
    textarea = container.querySelector<HTMLTextAreaElement>(".subagent-composer textarea")!;
    expect(textarea.value).toBe("alpha draft");

    currentDetail = detail({
      children: [
        child({ id: "alpha-new", parentChildId: "alpha-old", identityAliases: ["alpha-old"], title: "Alpha", assignment: "alpha task" }),
        child({ id: "beta", title: "Beta", assignment: "beta task" })
      ]
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    await settle();
    textarea = container.querySelector<HTMLTextAreaElement>(".subagent-composer textarea")!;
    expect(textarea.value).toBe("alpha draft");
    await act(async () => dispatchEnter(textarea));
    await settle();
    expect(controlSubagent).toHaveBeenCalledWith("session-one", "delegated-one", "followUp", "alpha draft", "alpha-new");

    textarea = container.querySelector<HTMLTextAreaElement>(".subagent-composer textarea")!;
    await act(async () => setTextArea(textarea, "do not retarget this draft"));
    currentDetail = detail({ children: [
      child({ id: "beta", title: "Beta", assignment: "beta task" }),
      child({ id: "gamma", title: "Gamma", assignment: "gamma task" })
    ] });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    await settle(16);
    expect(container.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')).not.toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>(".subagent-composer textarea")?.value).toBe("");
  });

  it("does not duplicate a matching durable result while a valid tail refresh is pending", async () => {
    vi.useFakeTimers();
    const pendingTail = deferred<{ readonly entries: readonly SubagentTranscriptEntryView[]; readonly tailPageToken: string; readonly totalSize: number }>();
    let transcriptReads = 0;
    const controller = {
      listSubagentRuns: vi.fn(async () => ({ runs: [run()], totalSize: 1 })),
      getSubagentRun: vi.fn(async () => detail({ returnedResult: "same answer" })),
      listSubagentTranscript: vi.fn(async () => transcriptReads++ === 0
        ? { entries: [transcript("answer", 1, "subagent", "same answer", { childId: "child-one" })], tailPageToken: "tail-one", totalSize: 1 }
        : pendingTail.promise)
    } as unknown as AppController;
    const { container } = await mount(controller, focused());
    expect(textOccurrences(container, "same answer")).toBe(1);

    await act(async () => { vi.advanceTimersByTime(2_000); });
    await settle();
    expect(textOccurrences(container, "same answer")).toBe(1);

    pendingTail.resolve({ entries: [], tailPageToken: "tail-two", totalSize: 1 });
    await settle(16);
    expect(textOccurrences(container, "same answer")).toBe(1);
  });

  it("does not duplicate a complete result while a no-cursor full refresh is pending", async () => {
    vi.useFakeTimers();
    const pendingHead = deferred<{ readonly entries: readonly SubagentTranscriptEntryView[]; readonly totalSize: number }>();
    let transcriptReads = 0;
    const controller = {
      listSubagentRuns: vi.fn(async () => ({ runs: [run()], totalSize: 1 })),
      getSubagentRun: vi.fn(async () => detail({ returnedResult: "same answer" })),
      listSubagentTranscript: vi.fn(async () => transcriptReads++ === 0
        ? { entries: [transcript("answer", 1, "subagent", "same answer", { childId: "child-one" })], totalSize: 1 }
        : pendingHead.promise)
    } as unknown as AppController;
    const { container } = await mount(controller, focused());
    expect(textOccurrences(container, "same answer")).toBe(1);

    await act(async () => { vi.advanceTimersByTime(2_000); });
    await settle();
    expect(textOccurrences(container, "same answer")).toBe(1);

    pendingHead.resolve({ entries: [transcript("answer", 1, "subagent", "same answer", { childId: "child-one" })], totalSize: 1 });
    await settle(16);
    expect(textOccurrences(container, "same answer")).toBe(1);
  });

  it("honors modifier-enter preference and ignores native, repeated, alternate, and composing Enter events", async () => {
    const accepted = deferred<void>();
    const controlSubagent = vi.fn(() => accepted.promise);
    const controller = {
      state: { preferences: { composerSendShortcut: "modifier-enter" } },
      listSubagentRuns: vi.fn(async () => ({ runs: [run()], totalSize: 1 })),
      getSubagentRun: vi.fn(async () => detail({ returnedResult: undefined })),
      listSubagentTranscript: vi.fn(async () => ({ entries: [transcript("parent", 1, "parent", "work")], tailPageToken: "tail", totalSize: 1 })),
      controlSubagent
    } as unknown as AppController;
    const { container } = await mount(controller, focused());
    const textarea = container.querySelector<HTMLTextAreaElement>(".subagent-composer textarea")!;
    expect(textarea.maxLength).toBe(32_000);
    expect(textarea.title).toContain("Ctrl+Enter");
    await act(async () => setTextArea(textarea, "continue safely"));
    await act(async () => dispatchEnter(textarea));
    await act(async () => dispatchEnter(textarea, { repeat: true }));
    await act(async () => dispatchEnter(textarea, { shiftKey: true }));
    await act(async () => dispatchEnter(textarea, { altKey: true }));
    await act(async () => dispatchEnter(textarea, { isComposing: true }));
    expect(controlSubagent).not.toHaveBeenCalled();
    expect(textarea.value).toBe("continue safely");

    await act(async () => {
      dispatchEnter(textarea, { ctrlKey: true });
      dispatchEnter(textarea, { ctrlKey: true });
    });
    expect(controlSubagent).toHaveBeenCalledTimes(1);
    accepted.resolve(undefined);
    await settle();
    expect(controlSubagent).toHaveBeenCalledWith("session-one", "delegated-one", "followUp", "continue safely", "child-one");
  });

  it("downgrades modifier steering to follow-up after the current generation has a settled reply", async () => {
    const controlSubagent = vi.fn(async () => undefined);
    const controller = {
      listSubagentRuns: vi.fn(async () => ({ runs: [run()], totalSize: 1 })),
      getSubagentRun: vi.fn(async () => detail({
        children: [child({ result: "settled output" })],
        returnedResult: "settled output"
      })),
      listSubagentTranscript: vi.fn(async () => ({ entries: [], tailPageToken: "tail", totalSize: 0 })),
      controlSubagent
    } as unknown as AppController;
    const { container } = await mount(controller, focused());
    const textarea = container.querySelector<HTMLTextAreaElement>(".subagent-composer textarea")!;
    await act(async () => setTextArea(textarea, "next assignment"));
    await act(async () => dispatchEnter(textarea, { ctrlKey: true }));
    await settle();
    expect(controlSubagent).toHaveBeenCalledWith("session-one", "delegated-one", "followUp", "next assignment", "child-one");
    expect(controlSubagent).not.toHaveBeenCalledWith("session-one", "delegated-one", "steer", expect.anything(), expect.anything());
  });

  it("offers direct stop only for running work", async () => {
    const controlSubagent = vi.fn(async () => undefined);
    const controller = {
      listSubagentRuns: vi.fn(async () => ({ runs: [run()], totalSize: 1 })),
      getSubagentRun: vi.fn(async () => detail()),
      listSubagentTranscript: vi.fn(async () => ({ entries: [], tailPageToken: "tail", totalSize: 0 })),
      controlSubagent
    } as unknown as AppController;
    const { container } = await mount(controller, focused());
    await act(async () => container.querySelector<HTMLButtonElement>(".subagent-detail__stop")?.click());
    await settle(16);
    expect(controlSubagent).toHaveBeenCalledWith("session-one", "delegated-one", "stop", "", "child-one");
    expect(container.querySelector("[role=dialog]")).toBeNull();

    const queued = detail({
      run: { ...run(), state: "queued" },
      children: [child({ state: "queued" })]
    });
    const queuedController = {
      listSubagentRuns: vi.fn(async () => ({ runs: [queued.run], totalSize: 1 })),
      getSubagentRun: vi.fn(async () => queued),
      listSubagentTranscript: vi.fn(async () => ({ entries: [], totalSize: 0 })),
      controlSubagent: vi.fn()
    } as unknown as AppController;
    const queuedMount = await mount(queuedController, { focusRunId: "delegated-one", focusRequestId: 2 });
    expect(queuedMount.container.querySelector(".subagent-detail__stop")).toBeNull();
    expect(queuedMount.container.textContent).toContain("queued and has not started replying");
  });

  it("drops a late detail response from the previous session", async () => {
    const oldDetail = deferred<SubagentRunDetailView>();
    const controller = {
      listSubagentRuns: vi.fn(async (session: string) => ({ runs: [{ ...run(), sessionId: session, id: `${session}-run`, title: `${session} row` }], totalSize: 1 })),
      getSubagentRun: vi.fn(async (session: string) => session === "old" ? oldDetail.promise : detail({
        run: { ...run(), sessionId: "new", id: "new-run", title: "new detail" },
        children: []
      })),
      listSubagentTranscript: vi.fn(async () => ({ entries: [], totalSize: 0 }))
    } as unknown as AppController;
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(panel(controller, "old", { focusRunId: "old-run", focusRequestId: 1 })));
    await settle();
    await act(async () => root.render(panel(controller, "new", { focusRunId: "new-run", focusRequestId: 2 })));
    await settle();
    oldDetail.resolve(detail({ run: { ...run(), sessionId: "old", id: "old-run", title: "stale detail" } }));
    await settle(16);
    expect(container.textContent).toContain("new detail");
    expect(container.textContent).not.toContain("stale detail");
  });

  it("serializes transcript reads and drops a late transcript from the previous session", async () => {
    const oldTranscript = deferred<{ readonly entries: readonly SubagentTranscriptEntryView[]; readonly totalSize: number }>();
    const listSubagentTranscript = vi.fn(async (session: string) => session === "old"
      ? oldTranscript.promise
      : { entries: [transcript("new-line", 1, "subagent", "new conversation")], totalSize: 1 });
    const controller = {
      listSubagentRuns: vi.fn(async (session: string) => ({ runs: [{ ...run(), sessionId: session, id: `${session}-run` }], totalSize: 1 })),
      getSubagentRun: vi.fn(async (session: string) => detail({
        run: { ...run(), sessionId: session, id: `${session}-run`, title: `${session} detail` },
        children: [],
        returnedResult: undefined
      })),
      listSubagentTranscript
    } as unknown as AppController;
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(panel(controller, "old", { focusRunId: "old-run", focusRequestId: 1 })));
    await settle(16);
    expect(listSubagentTranscript).toHaveBeenCalledWith("old", "old-run", undefined, "", 200);

    await act(async () => root.render(panel(controller, "new", { focusRunId: "new-run", focusRequestId: 2 })));
    await settle(16);
    expect(listSubagentTranscript.mock.calls.some((call) => call[0] === "new")).toBe(false);
    oldTranscript.resolve({ entries: [transcript("old-line", 1, "subagent", "stale conversation")], totalSize: 1 });
    await settle(32);
    expect(container.textContent).toContain("new conversation");
    expect(container.textContent).not.toContain("stale conversation");
  });

  it("dispatches resume from the terminal composer", async () => {
    const terminalDetail = detail({
      run: { ...run(), state: "completed", capabilities: { ...run().capabilities, resume: true } },
      children: [child({ state: "completed", endedAt: 4_000 })],
      returnedResult: undefined
    });
    const controlSubagent = vi.fn(async () => undefined);
    const controller = {
      listSubagentRuns: vi.fn(async () => ({ runs: [terminalDetail.run], totalSize: 1 })),
      getSubagentRun: vi.fn(async () => terminalDetail),
      listSubagentTranscript: vi.fn(async () => ({ entries: [], totalSize: 0 })),
      controlSubagent
    } as unknown as AppController;
    const { container } = await mount(controller, focused());
    const textarea = container.querySelector<HTMLTextAreaElement>(".subagent-composer textarea")!;
    expect(textarea.placeholder).toContain("Continue");
    await act(async () => setTextArea(textarea, "take another pass"));
    await act(async () => dispatchEnter(textarea));
    await settle(16);
    expect(controlSubagent).toHaveBeenCalledWith("session-one", "delegated-one", "resume", "take another pass", "child-one");
  });

  it("localizes durable status, access, system events and classified errors while retaining raw details", async () => {
    const failed = detail({
      run: {
        ...run(),
        state: "failed",
        readOnly: true,
        capabilities: { ...run().capabilities, viewActivity: false, resume: false },
        error: {
          code: "UPSTREAM",
          message: "HTTP 429 too many requests",
          phase: "dispatch",
          severity: "retryable",
          retryable: true,
          recovery: []
        }
      },
      children: [],
      returnedResult: undefined
    });
    const controller = {
      listSubagentRuns: vi.fn(async () => ({ runs: [failed.run], totalSize: 1 })),
      getSubagentRun: vi.fn(async () => failed),
      listSubagentTranscript: vi.fn(async () => ({ entries: [
        transcript("known", 1, "system", "recorded old ending", { systemEvent: { kind: "turn-ended", params: [] } }),
        transcript("future", 2, "system", "future recorded content", { systemEvent: { kind: "future-event", params: [] } }),
        transcript("runtime", 3, "system", "raw runtime row")
      ], totalSize: 3 }))
    } as unknown as AppController;
    const { container } = await mount(controller, focused());
    expect(container.textContent).toContain("Read-only");
    expect(container.textContent).toContain("rate limiting requests");
    expect(container.textContent).toContain("HTTP 429 too many requests");
    await act(async () => container.querySelector<HTMLElement>(".subagent-technical > summary")?.click());
    await settle();
    expect(container.textContent).toContain("The subagent turn ended.");
    expect(container.textContent).toContain("future recorded content");
    expect(container.textContent).toContain("raw runtime row");
    expect(container.textContent).not.toContain("subagents.systemEvent");
  });

  it("opens a focused run directly even when it is not returned on the first page", async () => {
    const target = { ...run(), capabilities: { ...run().capabilities, viewFullTranscript: false } };
    const controller = {
      listSubagentRuns: vi.fn(async () => ({ runs: [{ ...run(), id: "other", title: "Other" }], totalSize: 1 })),
      getSubagentRun: vi.fn(async () => ({ run: target, activity: [], children: [] })),
      listSubagentTranscript: vi.fn()
    } as unknown as AppController;
    const { container } = await mount(controller, { focusRunId: "delegated-one", focusRequestId: 4 });
    expect(controller.getSubagentRun).toHaveBeenCalledWith("session-one", "delegated-one");
    expect(container.textContent).toContain("Research");
    await act(async () => container.querySelector<HTMLButtonElement>(".subagent-detail-bar .icon-button")?.click());
    expect(container.textContent).toContain("Other");
    expect(container.textContent).not.toContain("Research");
  });

  it("loads focused detail and transcript after the StrictMode effect replay used by the mounted app", async () => {
    const controller = {
      listSubagentRuns: vi.fn(async () => ({ runs: [run()], totalSize: 1 })),
      getSubagentRun: vi.fn(async () => detail()),
      listSubagentTranscript: vi.fn(async () => ({
        entries: [transcript("strict-answer", 1, "subagent", "Strict replay preserved the transcript", { childId: "child-one" })],
        tailPageToken: "strict-tail",
        totalSize: 1
      }))
    } as unknown as AppController;
    const { container } = await mountStrict(controller, focused());

    expect(controller.getSubagentRun).toHaveBeenCalledWith("session-one", "delegated-one");
    expect(container.textContent).toContain("Strict replay preserved the transcript");
    expect(container.querySelector(".subagent-detail")).not.toBeNull();
  });
});

function panel(controller: AppController, sessionId = "session-one", focus?: { readonly focusRunId?: string; readonly focusRequestId?: number }) {
  return <SubagentsPanel
    controller={controller}
    sessionId={sessionId}
    {...focus}
    locale="en"
    t={(key, values) => translate("en", key, values)}
    runAction={(_key, action) => { void action(); }}
  />;
}

function focused(): { readonly focusRunId: string; readonly focusRequestId: number } {
  return { focusRunId: "delegated-one", focusRequestId: 1 };
}

async function mount(controller: AppController, focus?: { readonly focusRunId?: string; readonly focusRequestId?: number }): Promise<{ readonly container: HTMLDivElement }> {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(panel(controller, "session-one", focus)));
  await settle(16);
  return { container };
}

async function mountStrict(controller: AppController, focus?: { readonly focusRunId?: string; readonly focusRequestId?: number }): Promise<{ readonly container: HTMLDivElement }> {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<StrictMode>{panel(controller, "session-one", focus)}</StrictMode>));
  await settle(24);
  return { container };
}

function run(): SubagentRunView {
  return {
    id: "delegated-one",
    sessionId: "session-one",
    identityAliases: [],
    providerRunIds: [],
    state: "running",
    title: "Research",
    description: "Inspect the tests",
    assignment: "Find the regression",
    summary: "Reading evidence",
    route: { providerId: "provider", modelId: "model" },
    usage: { totalTokens: 42, toolUses: 1, durationMs: 2_000 },
    readOnly: false,
    capabilities: { viewActivity: true, viewReturnedResult: true, viewFullTranscript: true, stop: true, steer: true, followUp: true, resume: false, parentContext: "live" },
    startedAt: 1_000,
    updatedAt: 2_000,
    revision: 1n
  };
}

function child(patch: Partial<SubagentChildRunView> = {}): SubagentChildRunView {
  return {
    id: "child-one",
    identityAliases: [],
    title: "Child worker",
    assignment: "Inspect file",
    state: "running",
    readOnly: false,
    startedAt: 1_500,
    ...patch
  };
}

function detail(patch: Partial<SubagentRunDetailView> = {}): SubagentRunDetailView {
  return {
    run: run(),
    activity: [{ sequence: 1, kind: "progress", state: "running", summary: "Reading", occurredAt: 2_000 }],
    children: [child()],
    returnedResult: "Partial evidence",
    returnedResultTruncated: false,
    childrenObserved: true,
    ...patch
  };
}

function transcript(
  id: string,
  sequence: number,
  role: SubagentTranscriptEntryView["role"],
  content: string,
  patch: Partial<SubagentTranscriptEntryView> = {}
): SubagentTranscriptEntryView {
  return { id, sequence, role, content, occurredAt: sequence * 1_000, ...patch };
}

async function settle(rounds = 8): Promise<void> {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

function setTextArea(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function dispatchEnter(textarea: HTMLTextAreaElement, init: KeyboardEventInit = {}): void {
  textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }));
}

function textOccurrences(container: HTMLElement, value: string): number {
  return container.textContent?.split(value).length - 1 || 0;
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}
