// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot, type BackendView, type SessionView, type TimelineItemView } from "../model.js";
import { consumeUsageLimitScheduleIntent, type FailedInputModelRead } from "../usage-limit-recovery.js";
import { SessionPane } from "./SessionPane.js";

vi.mock("./Composer.js", () => ({ Composer: () => null }));
vi.mock("./Timeline.js", () => ({ Timeline: () => null }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  consumeUsageLimitScheduleIntent();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const session: SessionView = {
  id: "task-one", backendId: "pi", targetId: "workspace-one", name: "Task one", state: "idle",
  pinned: false, archived: false, generation: 1n, fastMode: false, permissionMode: "ask", planMode: false, updatedAt: 1
};
const backend: BackendView = {
  id: "pi", name: "Pi", version: "1", health: "healthy", authenticationState: "notRequired",
  capabilities: new Map([["input.text", { name: "input.text", supported: true, options: [] }]])
};
const input = {
  backendId: session.backendId, targetId: session.targetId, runId: "run-original",
  queueItemId: "queue-original", operationId: "operation-original"
};
const quotaError: TimelineItemView = {
  id: "original-error", kind: "error", sequence: 37n, createdAt: 1, runId: input.runId,
  title: "Provider limit", text: "Rate limit exceeded", runTerminal: "failed", failedInput: input,
  error: { code: "PI_PROVIDER_RESPONSE_FAILED", message: "Rate limit exceeded; resets at 4100000000", runId: input.runId,
    phase: "stream", severity: "blocked", retryable: false, recovery: [] }
};
const model = { providerId: "original-provider", modelId: "original-model", fastMode: false } as const;
const profile = { id: "profile-one", serverId: "server-one", deviceId: "device-one", name: "Local", origin: "https://localhost" };

it.each([
  { change: "gateway moves before Web commits", earlyReceipt: true, expectedRetry: true },
  { change: "Web moves before the original receipt", earlyReceipt: false, expectedRetry: true },
  { change: "a different failed Operation appears", earlyReceipt: false, replacement: true, expectedRetry: false },
  { change: "the document retires during history reload", earlyReceipt: false, retire: true, expectedRetry: false }
])("revalidates the original quota click when $change", async ({ earlyReceipt, replacement, retire, expectedRetry }) => {
  let finishOriginal!: (result: FailedInputModelRead) => void;
  const originalReceipt = new Promise<FailedInputModelRead>(resolve => { finishOriginal = resolve; });
  const read = vi.fn<NonNullable<AppController["readFailedInputModel"]>>()
    .mockResolvedValue({ kind: "override", model }).mockReturnValueOnce(originalReceipt);
  const navigate = vi.fn();
  const methods = {
    readFailedInputModel: read, navigate, setNavigationOpen: vi.fn(async () => undefined),
    getArtifactUrl: vi.fn(async () => "blob:artifact"), releaseArtifactUrl: vi.fn(),
    getPortableReplacementCleanup: vi.fn(async () => undefined)
  };
  const render = (generation: bigint, timeline: readonly TimelineItemView[], timelineHistoryLoading = false) => {
    const current = { ...session, generation };
    const controller = { ...methods, state: {
      ready: true, connectionState: "connected", connectionGeneration: 3, navigationRevision: 1,
      profiles: [], activeProfile: profile, snapshot: { ...emptySnapshot(), sessions: [current], backends: [backend] },
      route: { kind: "session", sessionId: session.id }, preferences: DEFAULT_UI_PREFERENCES,
      effectiveLocale: "en", extensionNotifications: []
    } } as unknown as AppController;
    return act(async () => root.render(<SessionPane
      controller={controller} session={current} backend={backend} models={[]} timeline={timeline}
      timelineHasEarlier={false} timelineHistoryLoading={timelineHistoryLoading} onLoadEarlierTimeline={async () => undefined}
      extensionWidgets={[]} extensionStatuses={[]} queue={[]} extraDirectories={[]} resources={[]} commandRefreshSignal={[]}
      remainingInteractions={0} navigationOpen={false} inspectorOpen={false} t={key => key}
      runAction={(_key, action) => { void action(); }} onOpenNavigation={() => undefined} onOpenInspector={() => undefined}
      onRename={() => undefined} onArchive={() => undefined} onDelete={() => undefined}
    />));
  };
  await render(1n, [quotaError]);
  const button = [...host.querySelectorAll("button")].find(candidate => candidate.textContent === "errorTail.scheduleAfterReset");
  expect(button).toBeDefined();
  await act(async () => button!.click());
  expect(read.mock.calls).toEqual([[session.id, 1n, input]]);

  if (earlyReceipt) await act(async () => finishOriginal({ kind: "runtimeChanged" }));
  await render(2n, [], true);
  if (!earlyReceipt) await act(async () => finishOriginal({ kind: "override", model: { ...model, modelId: "retired-model" } }));
  expect(read).toHaveBeenCalledTimes(1);
  expect(navigate).not.toHaveBeenCalled();
  expect(consumeUsageLimitScheduleIntent()).toBeUndefined();

  if (retire) await act(async () => window.dispatchEvent(new Event("pagehide")));
  const currentError = replacement ? { ...quotaError, failedInput: { ...input, operationId: "different-operation" } } : quotaError;
  await render(2n, [currentError]);
  if (expectedRetry) {
    expect(read.mock.calls).toEqual([[session.id, 1n, input], [session.id, 2n, input]]);
    expect(navigate).toHaveBeenCalledExactlyOnceWith({ kind: "schedules" });
    expect(consumeUsageLimitScheduleIntent()).toMatchObject({ sessionId: session.id, model, resetAtMs: 4_100_000_000_000 });
  } else {
    expect(read).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    expect(consumeUsageLimitScheduleIntent()).toBeUndefined();
  }
});
