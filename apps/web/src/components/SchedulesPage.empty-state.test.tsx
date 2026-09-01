// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot, type ScheduleView } from "../model.js";
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
});

async function renderSchedules(schedules: readonly ScheduleView[]): Promise<HTMLDivElement> {
  const snapshot = { ...emptySnapshot(), revision: 1n, schedules };
  const controller = {
    state: {
      snapshot,
      preferences: { ...DEFAULT_UI_PREFERENCES, navigationOpen: true },
      route: { kind: "schedules" }
    },
    navigate: vi.fn(),
    getSchedulerRuntime: vi.fn(() => new Promise<never>(() => undefined)),
    refreshProviderModels: vi.fn(async () => undefined)
  } as unknown as AppController;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<SchedulesPage
    controller={controller}
    schedules={schedules}
    sessions={[]}
    targets={[]}
    models={[]}
    backends={[]}
    extraDirectories={[]}
    locale="en"
    t={t}
    runAction={(_key, action) => { void action(); }}
    onOpenNavigation={vi.fn()}
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
