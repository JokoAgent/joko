// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot, type ScheduleView, type SessionView, type TargetView, type TimelineHistoryCursorView } from "../model.js";
import { stageUsageLimitScheduleIntent } from "../usage-limit-recovery.js";
import { SchedulesPage } from "./SchedulesPage.js";
import type { Translator } from "./types.js";

const roots: Root[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  window.localStorage.clear();
});

describe("SchedulesPage empty states", () => {
  it("renders one onboarding state and one create action when the schedule database is empty", async () => {
    const container = await renderSchedules([]);

    expect(container.querySelector(".schedule-master")).toBeNull();
    expect(container.querySelectorAll(".schedule-onboarding-empty")).toHaveLength(1);
    expect(container.textContent).toContain("scheduler.empty");
    expect(container.textContent).not.toContain("scheduler.filterEmpty");
    expect(buttonsWithText(container, "scheduler.new")).toHaveLength(1);
  });

  it("keeps the list-level no-match state without showing onboarding when a filter hides existing schedules", async () => {
    window.localStorage.setItem("joko.scheduler.statusFilter", "active");
    const container = await renderSchedules([pausedSchedule()]);

    expect(container.querySelector(".schedule-master")).not.toBeNull();
    expect(container.querySelector(".schedule-master__empty")?.textContent).toBe("scheduler.filterEmpty");
    expect(container.querySelector(".schedule-onboarding-empty")).toBeNull();
    expect(container.textContent).not.toContain("scheduler.emptyBody");
    expect(buttonsWithText(container, "scheduler.new")).toHaveLength(1);
  });

  it("consumes a usage-reset intent by opening a prefilled one-shot editor", async () => {
    stageUsageLimitScheduleIntent("session-missing", { resetAtMs: Date.now() + 3_600_000 });
    await renderSchedules([]);

    const form = document.querySelector<HTMLFormElement>(".schedule-editor");
    expect(form).not.toBeNull();
    expect(form?.querySelector<HTMLInputElement>('input[value="scheduler.usageLimitRecoveryName"]')).not.toBeNull();
    expect(form?.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("scheduler.usageLimitRecoveryPrompt");
    expect(form?.querySelector<HTMLSelectElement>('select')?.value).not.toBeUndefined();
    expect([...form?.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]') ?? []]
      .some((input) => input.value.length > 0)).toBe(true);
  });

  it("can save the later repeated recovery time after the first occurrence has passed", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2027-11-07T06:00:00Z"));
    const zoneOptions = Intl.DateTimeFormat().resolvedOptions();
    const zone = vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ ...zoneOptions, timeZone: "America/New_York" });
    const task: SessionView = {
      id: "quota-task", backendId: "backend", targetId: "target", name: "Quota task", state: "idle",
      pinned: false, archived: false, generation: 1n, fastMode: false, permissionMode: "ask", planMode: false, updatedAt: 1
    };
    const target: TargetView = {
      id: "target", backendId: task.backendId, workspaceId: "workspace", workspaceName: "Project", name: "Project",
      revision: 1n, trusted: true, pinned: false, archived: false
    };
    const resetAt = Date.parse("2027-11-07T06:30:00Z");
    const saveSchedule = vi.fn<AppController["saveSchedule"]>(async () => undefined);
    try {
      stageUsageLimitScheduleIntent(task.id, { resetAtMs: resetAt });
      await renderSchedules([], [task], undefined, { targets: [target], saveSchedule });
      const form = document.querySelector<HTMLFormElement>(".schedule-editor")!;
      expect(form.querySelector<HTMLInputElement>('input[type="datetime-local"]')?.value).toBe("2027-11-07T01:31");
      const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      expect(submit.disabled).toBe(false);
      await act(async () => submit.click());
      expect(saveSchedule).toHaveBeenCalledExactlyOnceWith(undefined, expect.objectContaining({
        kind: "once", onceTriggerAt: resetAt + 60_000, sessionId: task.id
      }));
    } finally {
      zone.mockRestore();
      now.mockRestore();
    }
  });
});

describe("SchedulesPage unread history", () => {
  it("acknowledges scheduled task attention using its current receipt before marking history read", async () => {
    const subjectCursor = { sequence: 10n, generation: 1n, opaqueToken: "subject" };
    const errorCursor = { ...subjectCursor, sequence: 13n, opaqueToken: "error-acknowledgement" };
    const completionSubject = { ...subjectCursor, sequence: 14n, opaqueToken: "completion-subject" };
    const completionCursor = { ...subjectCursor, sequence: 17n, opaqueToken: "completion-acknowledgement" };
    const schedule = { ...pausedSchedule(), unreadRunCount: 2 };
    const task: SessionView = {
      id: "scheduled-error", backendId: schedule.backendId, targetId: schedule.targetId, name: "Failed scheduled task",
      state: "idle", pinned: false, archived: false, generation: 1n, fastMode: false, permissionMode: "ask", planMode: false,
      updatedAt: 1, automationOrigin: { kind: "scheduler", scheduleId: schedule.id },
      attention: { kind: "error", unread: true, subjectCursor, attentionCursor: errorCursor, readThroughCursor: subjectCursor, updatedAt: 1 }
    };
    const done: SessionView = { ...task, id: "scheduled-completion", name: "Completed scheduled task",
      attention: { kind: "done", unread: true, subjectCursor: completionSubject, attentionCursor: completionCursor,
        readThroughCursor: completionSubject, updatedAt: 1 } };
    const acknowledgeSessionError = vi.fn(async (_id: string, cursor: TimelineHistoryCursorView) => {
      if (cursor !== errorCursor) throw new Error("Stale error cursor");
    });
    const acknowledgeSessionAttention = vi.fn(async (_id: string, cursor: TimelineHistoryCursorView) => {
      if (cursor !== completionCursor) throw new Error("Stale completion cursor");
    });
    const markAllScheduleRunsRead = vi.fn(async () => 2);
    const refresh = vi.fn(async () => undefined);
    const container = await renderSchedules([schedule], [task, done, { ...task, id: "ordinary-task", automationOrigin: undefined }], {
      acknowledgeSessionError, acknowledgeSessionAttention, markAllScheduleRunsRead, refresh
    });

    await act(async () => { buttonsWithText(container, "scheduler.markAllRunsRead")[0]!.click(); });

    expect(acknowledgeSessionError).toHaveBeenCalledExactlyOnceWith(task.id, errorCursor);
    expect(acknowledgeSessionAttention).toHaveBeenCalledExactlyOnceWith(done.id, completionCursor);
    expect(markAllScheduleRunsRead).toHaveBeenCalledOnce();
    expect(acknowledgeSessionError).toHaveBeenCalledBefore(markAllScheduleRunsRead);
    expect(acknowledgeSessionAttention).toHaveBeenCalledBefore(markAllScheduleRunsRead);
    expect(refresh).toHaveBeenCalledOnce();
    expect(container.querySelector(".schedule-project-notice")?.textContent).toBe("scheduler.markedRunsRead");
  });
});

async function renderSchedules(schedules: readonly ScheduleView[], sessions: readonly SessionView[] = [],
  historyActions?: Pick<AppController, "acknowledgeSessionError" | "acknowledgeSessionAttention" | "markAllScheduleRunsRead" | "refresh">,
  editor?: { readonly targets: readonly TargetView[]; readonly saveSchedule: AppController["saveSchedule"] }
): Promise<HTMLDivElement> {
  const targets = editor?.targets ?? [];
  const snapshot = { ...emptySnapshot(), revision: 1n, schedules, sessions, targets };
  const controller = {
    state: {
      snapshot,
      preferences: { ...DEFAULT_UI_PREFERENCES, navigationOpen: true },
      route: { kind: "schedules" }
    },
    navigate: vi.fn(),
    getSchedulerRuntime: vi.fn(() => new Promise<never>(() => undefined)),
    listScheduleRunHistory: vi.fn(async () => ({ history: [], totalSize: 0 })),
    refreshProviderModels: vi.fn(async () => undefined),
    ...historyActions,
    ...(editor === undefined ? {} : { saveSchedule: editor.saveSchedule })
  } as unknown as AppController;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<SchedulesPage
    controller={controller}
    schedules={schedules}
    sessions={sessions}
    targets={targets}
    models={[]}
    backends={[]}
    extraDirectories={[]}
    locale="en"
    t={t}
    runAction={(_key, action) => { void action(); }}
    onOpenNavigation={vi.fn()}
    prepareSessionRemoval={async (sessions) => ({ clean: sessions.length, dirty: 0, unknown: 0 })}
  />));
  return container;
}

function pausedSchedule(): ScheduleView {
  return {
    id: "paused",
    name: "Paused schedule",
    source: "user",
    backendId: "backend",
    targetId: "target",
    sessionMode: "fresh",
    enabled: false,
    kind: "manual",
    expression: "",
    timezone: "UTC",
    inputText: "",
    executionMode: "script",
    script: { command: "node automation.mjs", capabilities: [] },
    useWorktree: false,
    refreshWorktreeRemote: false,
    permissionMode: "ask",
    planMode: false,
    extraDirectoryIds: [],
    silentWhenIdle: false,
    notifyDesktop: true,
    overlapPolicy: "queue",
    misfirePolicy: "runOnce",
    unreadRunCount: 0,
    history: []
  };
}

const t: Translator = (key) => String(key);

function buttonsWithText(container: ParentNode, text: string): readonly HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>("button")]
    .filter((button) => button.textContent?.trim() === text);
}
