// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppController, ControllerState } from "../controller.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot, type BackendView, type BackgroundTaskView, type SessionView, type SubagentRunDetailView, type SubagentRunView, type TimelineItemView } from "../model.js";
import { SessionPane } from "./SessionPane.js";
import type { Translator } from "./types.js";

vi.mock("./Composer.js", () => ({ Composer: () => null }));
vi.mock("./Timeline.js", async () => {
  const React = await import("react");
  const { SubagentInlineCard } = await import("./SubagentInlineCard.js");
  return {
    Timeline: (props: {
      readonly items: readonly TimelineItemView[];
      readonly subagentRuns?: ReadonlyMap<string, SubagentRunView>;
      readonly subagentRunDetails?: ReadonlyMap<string, SubagentRunDetailView>;
      readonly t: Translator;
    }) => React.createElement(React.Fragment, null, ...props.items.flatMap((item) => {
      const task = item.background;
      const run = task === undefined ? undefined : props.subagentRuns?.get(task.id);
      if (task === undefined || run === undefined) return [];
      const detail = props.subagentRunDetails?.get(task.id);
      return [React.createElement(SubagentInlineCard, {
        key: task.id,
        task,
        run,
        ...(detail === undefined ? {} : { detail }),
        t: props.t
      })];
    }))
  };
});

const roots: Root[] = [];
const t: Translator = (key) => {
  if (key === "subagents.children") return "Children";
  if (key === "subagents.tool") return "Tool";
  return key;
};

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
});

describe("SessionPane delegated-run inline detail", () => {
  it("mounts a detail-only final result with latest tool and child count", async () => {
    const sourceRun = run({ summary: undefined, state: "completed", revision: 2n });
    const longResult = `line 1\nline 2\nline 3\nline 4\nline 5\n${"tail".repeat(100)}`;
    const controller = controllerFor({
      listSubagentRuns: vi.fn(async () => ({ runs: [sourceRun], totalSize: 1 })),
      getSubagentRun: vi.fn(async () => detail(sourceRun, {
        returnedResult: longResult,
        activity: [{ sequence: 4, kind: "completed", state: "completed", lastToolName: "verify_build", occurredAt: 4_000 }],
        children: [child("child-one"), child("child-two")],
        childrenObserved: true
      }))
    });
    const mounted = mountPane(controller, session("session-one"), [backgroundItem({ state: "completed", updatedAt: 4_000 })]);

    await flushUntil(() => expect(mounted.container.querySelector<HTMLButtonElement>(".subagent-inline-card__toggle")?.disabled).toBe(false));
    act(() => mounted.container.querySelector<HTMLButtonElement>(".subagent-inline-card__toggle")?.click());
    expect(mounted.container.querySelector("[data-subagent-result]")?.textContent).toBe(longResult);
    expect(mounted.container.querySelector("[data-subagent-last-tool]")?.textContent).toContain("verify_build");
    expect(mounted.container.querySelector("[data-subagent-child-count]")?.textContent).toBe("Children: 2");
  });

  it("keeps a late older-generation detail from replacing the current logical task", async () => {
    const firstDetail = deferred<SubagentRunDetailView>();
    const firstRun = run({ id: "generation-one", logicalAgentId: "task-one", revision: 1n });
    const currentRun = run({ id: "generation-two", logicalAgentId: "task-one", revision: 2n });
    let listCount = 0;
    const controller = controllerFor({
      listSubagentRuns: vi.fn(async () => ({ runs: [listCount++ === 0 ? firstRun : currentRun], totalSize: 1 })),
      getSubagentRun: vi.fn(async (_sessionId: string, runId: string) => runId === firstRun.id
        ? firstDetail.promise
        : detail(currentRun, { returnedResult: "Current generation answer" }))
    });
    const sourceSession = session("session-one");
    const mounted = mountPane(controller, sourceSession, [backgroundItem({ state: "running", updatedAt: 1_000 })]);
    await flushUntil(() => expect(controller.getSubagentRun).toHaveBeenCalledWith("session-one", firstRun.id));

    mounted.render(sourceSession, [backgroundItem({ state: "completed", updatedAt: 2_000 })]);
    await flushUntil(() => expect(mounted.container.querySelector('[data-subagent-inline-card="generation-two"]')).not.toBeNull());
    act(() => mounted.container.querySelector<HTMLButtonElement>(".subagent-inline-card__toggle")?.click());
    expect(mounted.container.textContent).toContain("Current generation answer");

    await act(async () => firstDetail.resolve(detail(firstRun, { returnedResult: "Stale generation answer" })));
    expect(mounted.container.textContent).toContain("Current generation answer");
    expect(mounted.container.textContent).not.toContain("Stale generation answer");
  });
});

function mountPane(controller: AppController, sourceSession: SessionView, timeline: readonly TimelineItemView[]): {
  readonly container: HTMLDivElement;
  readonly render: (nextSession: SessionView, nextTimeline: readonly TimelineItemView[]) => void;
} {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  const render = (nextSession: SessionView, nextTimeline: readonly TimelineItemView[]): void => act(() => root.render(
    <SessionPane
      controller={controller}
      session={nextSession}
      backend={backend()}
      models={[]}
      timeline={nextTimeline}
      timelineHasEarlier={false}
      timelineHistoryLoading={false}
      onLoadEarlierTimeline={async () => undefined}
      extensionWidgets={[]}
      extensionStatuses={[]}
      queue={[]}
      extraDirectories={[]}
      resources={[]}
      commandRefreshSignal={[]}
      remainingInteractions={0}
      navigationOpen
      inspectorOpen
      t={t}
      runAction={(_key, action) => { void action(); }}
      onOpenNavigation={() => undefined}
      onOpenInspector={() => undefined}
      onRename={() => undefined}
      onDelete={() => undefined}
    />
  ));
  render(sourceSession, timeline);
  return { container, render };
}

function controllerFor(methods: {
  readonly listSubagentRuns: AppController["listSubagentRuns"];
  readonly getSubagentRun: AppController["getSubagentRun"];
}): AppController {
  const snapshot = { ...emptySnapshot(), revision: 1n };
  const state: ControllerState = {
    ready: true,
    connectionState: "connected",
    profiles: [],
    machineCaches: [],
    machinePresenceByProfile: {},
    discoveredNodes: [],
    discoveryState: "idle",
    managedOrchestratorStatus: undefined,
    automaticConnectionAvailable: false,
    snapshot,
    route: { kind: "session", sessionId: "session-one" },
    preferences: DEFAULT_UI_PREFERENCES,
    extensionNotifications: []
  };
  return { state, ...methods } as unknown as AppController;
}

function backend(): BackendView {
  return {
    id: "backend-one",
    name: "Backend",
    version: "1",
    health: "healthy",
    capabilities: new Map([
      ["subagents.list", { name: "subagents.list", supported: true, options: [] }],
      ["subagents.detail", { name: "subagents.detail", supported: true, options: [] }]
    ])
  };
}

function session(id: string): SessionView {
  return {
    id,
    backendId: "backend-one",
    targetId: "target-one",
    name: id,
    state: "idle",
    pinned: false,
    archived: false,
    generation: 1n,
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    updatedAt: 1_000
  };
}

function backgroundItem(taskOverrides: Partial<BackgroundTaskView> = {}): TimelineItemView {
  return {
    id: "background-one",
    sequence: 1n,
    kind: "background",
    createdAt: 1_000,
    background: { id: "task-one", title: "Delegated work", state: "running", ...taskOverrides }
  };
}

function run(overrides: Partial<SubagentRunView> = {}): SubagentRunView {
  return {
    id: "task-one",
    sessionId: "session-one",
    identityAliases: [],
    providerRunIds: [],
    state: "running",
    title: "Delegated work",
    summary: "Notification summary",
    capabilities: { viewActivity: true, viewReturnedResult: true, viewFullTranscript: true, stop: false, steer: false, followUp: false, resume: false, parentContext: "snapshot" },
    startedAt: 1_000,
    updatedAt: 2_000,
    revision: 1n,
    ...overrides
  };
}

function detail(sourceRun: SubagentRunView, overrides: Partial<SubagentRunDetailView> = {}): SubagentRunDetailView {
  return { run: sourceRun, activity: [], children: [], ...overrides };
}

function child(id: string): SubagentRunDetailView["children"][number] {
  return { id, identityAliases: [], title: id, state: "completed", startedAt: 1_000 };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

async function flushUntil(assertion: () => void): Promise<void> {
  let lastFailure: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await act(async () => { await Promise.resolve(); });
    try {
      assertion();
      return;
    } catch (error) {
      lastFailure = error;
    }
  }
  throw lastFailure;
}
