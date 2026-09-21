import { describe, expect, it } from "vitest";
import { MOBILE_SUPPORTED_LOCALES } from "./mobile-locale-preference";
import type { MobileAutomationRun, MobileAutomationSchedule } from "./mobile-automation";
import {
  formatMobileAutomationCost,
  formatMobileAutomationDate,
  formatMobileAutomationDuration,
  mobileAutomationDirectoryAccessLabel,
  mobileAutomationMisfireLabel,
  mobileAutomationOverlapLabel,
  mobileAutomationPermissionLabel,
  mobileAutomationPreRunDecisionLabel,
  mobileAutomationPreRunStatusLabel,
  mobileAutomationRecurrenceLabel,
  mobileAutomationRunStateLabel,
  mobileAutomationScheduleStateLabel,
  mobileAutomationSessionModeLabel,
  mobileAutomationTemplatePresentation,
  mobileAutomationWorktreeEligibilityLabel
} from "./mobile-automation-presentation";

const schedule: MobileAutomationSchedule = {
  scheduleId: "schedule",
  displayName: "Server-owned name",
  state: "enabled",
  source: "project",
  backendId: "backend-id",
  targetId: "target-id",
  sessionMode: "fresh",
  recurrence: "cron",
  recurrenceLabel: "cron 0 9 * * *",
  recurrenceExpression: "0 9 * * *",
  timeZone: "Asia/Shanghai",
  inputText: "Server-owned input",
  editableInputText: "Server-owned input",
  executionMode: "agent",
  permissionMode: "ask",
  planMode: false,
  useWorktree: false,
  refreshWorktreeRemote: false,
  extraDirectoryIds: [],
  silentWhenIdle: false,
  notifyDesktop: true,
  overlapPolicy: "queue",
  misfirePolicy: "runOnce",
  unreadRunCount: 0,
  recentRuns: [],
  revision: { value: 1n, etag: "etag" },
  generation: 1n
};

const run: MobileAutomationRun = {
  triggerId: "trigger",
  runId: "run",
  state: "completed",
  scheduledFor: 0,
  triggeredAt: 0,
  durationMs: 65_400,
  zeroCost: false,
  costAttribution: "mixed",
  cost: {
    amountMicros: 1_250_000n,
    currencyCode: "USD",
    approximate: true,
    kind: "actual-cost",
    estimateReasons: []
  }
};

describe("mobile Automation presentation", () => {
  it("localizes closed enums without changing raw schedule identities", () => {
    expect(mobileAutomationScheduleStateLabel("zh-CN", "disabled")).toBe("已暂停");
    expect(mobileAutomationRunStateLabel("ja", "interrupted")).toBe("中断");
    expect(mobileAutomationSessionModeLabel("ko", "persistent")).toBe("지속 작업");
    expect(mobileAutomationOverlapLabel("zh-TW", "queue")).toBe("排入佇列");
    expect(mobileAutomationMisfireLabel("ja", "runOnce")).toBe("1 回実行");
    expect(mobileAutomationPermissionLabel("ko", "bypassPermissions")).toBe("전체 접근");
    expect(mobileAutomationWorktreeEligibilityLabel("zh-CN", "notGitRepository")).toBe("不是 Git 仓库");
    expect(mobileAutomationDirectoryAccessLabel("ja", "readWrite")).toBe("読み書き");
    expect(mobileAutomationPreRunStatusLabel("zh-TW", "timed_out")).toBe("逾時");
    expect(mobileAutomationPreRunDecisionLabel("ko", "block")).toBe("차단");
    expect(schedule.backendId).toBe("backend-id");
    expect(schedule.targetId).toBe("target-id");
    expect(schedule.timeZone).toBe("Asia/Shanghai");
  });

  it("derives localized recurrence labels from structured recurrence fields", () => {
    expect(mobileAutomationRecurrenceLabel("zh-CN", schedule)).toBe("Cron · 0 9 * * *");
    expect(mobileAutomationRecurrenceLabel("ko", {
      ...schedule,
      recurrence: "interval",
      recurrenceLabel: "Every 3600000 ms",
      recurrenceExpression: "3600"
    })).toBe("1시간마다");
    const once = { ...schedule, recurrence: "once" as const, recurrenceExpression: "2026-01-02T03:04:05.000Z" };
    expect(mobileAutomationRecurrenceLabel("ja", once)).toContain(
      formatMobileAutomationDate(Date.parse(once.recurrenceExpression), "ja", once.timeZone)
    );
  });

  it("formats dates, durations and costs with the active locale", () => {
    const epoch = Date.UTC(2026, 0, 2, 3, 4, 5);
    expect(formatMobileAutomationDate(epoch, "zh-CN", "UTC"))
      .toBe(new Date(epoch).toLocaleString("zh-CN", { timeZone: "UTC" }));
    expect(formatMobileAutomationDuration(undefined, "zh-CN")).toBe("时长不可用");
    expect(formatMobileAutomationDuration(250, "ja")).toBe("250 ミリ秒");
    expect(formatMobileAutomationDuration(65_400, "ko")).toBe("1분 5초");
    expect(formatMobileAutomationCost(run, "zh-CN")).toBe("≈1.25 USD · 混合");
    expect(formatMobileAutomationCost({ ...run, cost: undefined, zeroCost: true, costAttribution: "zero" }, "ja"))
      .toBe("トークン費用なし");
  });

  it("provides every localized built-in template and substitutes only the explicit parameter", () => {
    const expectedNames = {
      en: "Domain radar",
      "zh-CN": "领域雷达",
      "zh-TW": "領域雷達",
      ja: "分野レーダー",
      ko: "관심 분야 레이더"
    } as const;
    for (const locale of MOBILE_SUPPORTED_LOCALES) {
      const topic = mobileAutomationTemplatePresentation(locale, "topic-radar", "Raw Topic / 原文");
      expect(topic.name).toBe(expectedNames[locale]);
      expect(topic.parameter?.label.trim()).not.toBe("");
      expect(topic.parameter?.placeholder.trim()).not.toBe("");
      expect(topic.prompt).toContain("Raw Topic / 原文");
      expect(topic.prompt).not.toContain("{parameter}");
      for (const id of [
        "nightly-test-repair",
        "pull-request-review",
        "competitor-radar",
        "weekly-report-draft",
        "documentation-freshness"
      ] as const) {
        const presentation = mobileAutomationTemplatePresentation(locale, id, "Raw Value");
        expect(presentation.name.trim()).not.toBe("");
        expect(presentation.prompt.trim()).not.toBe("");
      }
    }
  });
});
