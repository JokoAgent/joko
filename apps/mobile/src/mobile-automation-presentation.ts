import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import type {
  MobileAutomationFilter,
  MobileAutomationPreRun,
  MobileAutomationRun,
  MobileAutomationRunState,
  MobileAutomationSchedule,
  MobileAutomationScheduleState
} from "./mobile-automation";
import type {
  MobileAutomationDraft,
  MobileAutomationTemplateId,
  MobileAutomationWorktreeProof
} from "./mobile-automation-authoring";

export interface MobileAutomationTemplatePresentation {
  readonly name: string;
  readonly prompt: string;
  readonly parameter?: {
    readonly label: string;
    readonly placeholder: string;
  };
}

export function mobileAutomationFilterLabel(locale: MobileSupportedLocale, filter: MobileAutomationFilter): string {
  if (filter === "all") return mobileMessage(locale, "automation.filter.all");
  if (filter === "active") return mobileMessage(locale, "automation.filter.active");
  return mobileMessage(locale, "automation.filter.paused");
}

export function mobileAutomationScheduleStateLabel(
  locale: MobileSupportedLocale,
  state: MobileAutomationScheduleState
): string {
  if (state === "enabled") return mobileMessage(locale, "automation.schedule.state.enabled");
  if (state === "disabled") return mobileMessage(locale, "automation.schedule.state.disabled");
  if (state === "running") return mobileMessage(locale, "automation.schedule.state.running");
  if (state === "error") return mobileMessage(locale, "automation.schedule.state.error");
  return mobileMessage(locale, "automation.schedule.state.deleting");
}

export function mobileAutomationScheduleSourceLabel(
  locale: MobileSupportedLocale,
  source: MobileAutomationSchedule["source"]
): string {
  return source === "project"
    ? mobileMessage(locale, "automation.schedule.source.project")
    : mobileMessage(locale, "automation.schedule.source.dialogue");
}

export function mobileAutomationRecurrenceLabel(
  locale: MobileSupportedLocale,
  schedule: MobileAutomationSchedule
): string {
  if (schedule.recurrence === "manual") return mobileMessage(locale, "automation.recurrence.manual");
  if (schedule.recurrence === "once") {
    const value = Date.parse(schedule.recurrenceExpression);
    return mobileMessage(locale, "automation.recurrence.onceValue", {
      value: Number.isFinite(value)
        ? formatMobileAutomationDate(value, locale, schedule.timeZone)
        : schedule.recurrenceExpression
    });
  }
  if (schedule.recurrence === "cron") {
    return mobileMessage(locale, "automation.recurrence.cronValue", { expression: schedule.recurrenceExpression });
  }
  const seconds = Number(schedule.recurrenceExpression);
  return mobileMessage(locale, "automation.recurrence.intervalValue", {
    duration: Number.isSafeInteger(seconds) && seconds > 0
      ? formatMobileAutomationDuration(seconds * 1_000, locale)
      : schedule.recurrenceLabel
  });
}

export function mobileAutomationSessionModeLabel(
  locale: MobileSupportedLocale,
  mode: MobileAutomationDraft["sessionMode"]
): string {
  if (mode === "fresh") return mobileMessage(locale, "automation.session.fresh");
  if (mode === "persistent") return mobileMessage(locale, "automation.session.persistent");
  return mobileMessage(locale, "automation.session.bound");
}

export function mobileAutomationExecutionModeLabel(
  locale: MobileSupportedLocale,
  mode: MobileAutomationDraft["executionMode"]
): string {
  return mode === "agent"
    ? mobileMessage(locale, "automation.execution.agent")
    : mobileMessage(locale, "automation.execution.script");
}

export function mobileAutomationRecurrenceKindLabel(
  locale: MobileSupportedLocale,
  recurrence: MobileAutomationDraft["recurrence"]
): string {
  if (recurrence === "manual") return mobileMessage(locale, "automation.recurrence.manual");
  if (recurrence === "once") return mobileMessage(locale, "automation.recurrence.once");
  if (recurrence === "interval") return mobileMessage(locale, "automation.recurrence.interval");
  return mobileMessage(locale, "automation.recurrence.cron");
}

export function mobileAutomationOverlapLabel(
  locale: MobileSupportedLocale,
  value: MobileAutomationDraft["overlapPolicy"]
): string {
  return value === "queue"
    ? mobileMessage(locale, "automation.overlap.queue")
    : mobileMessage(locale, "automation.overlap.skip");
}

export function mobileAutomationMisfireLabel(
  locale: MobileSupportedLocale,
  value: MobileAutomationDraft["misfirePolicy"]
): string {
  return value === "runOnce"
    ? mobileMessage(locale, "automation.misfire.runOnce")
    : mobileMessage(locale, "automation.misfire.skip");
}

export function mobileAutomationPermissionLabel(
  locale: MobileSupportedLocale,
  value: MobileAutomationDraft["permissionMode"]
): string {
  if (value === "ask") return mobileMessage(locale, "controls.permission.ask");
  if (value === "auto") return mobileMessage(locale, "controls.permission.auto");
  return mobileMessage(locale, "controls.permission.full");
}

export function mobileAutomationWorktreeEligibilityLabel(
  locale: MobileSupportedLocale,
  value: MobileAutomationWorktreeProof["eligibility"]
): string {
  if (value === "eligible") return mobileMessage(locale, "automation.worktree.eligible");
  if (value === "notGitRepository") return mobileMessage(locale, "automation.worktree.notGitRepository");
  if (value === "alreadyLinked") return mobileMessage(locale, "automation.worktree.alreadyLinked");
  if (value === "gitNotFound") return mobileMessage(locale, "automation.worktree.gitNotFound");
  if (value === "unsafe") return mobileMessage(locale, "automation.worktree.unsafe");
  return mobileMessage(locale, "automation.worktree.unavailable");
}

export function mobileAutomationDirectoryAccessLabel(
  locale: MobileSupportedLocale,
  value: "readOnly" | "readWrite"
): string {
  return value === "readOnly"
    ? mobileMessage(locale, "automation.directory.readOnly")
    : mobileMessage(locale, "automation.directory.readWrite");
}

export function mobileAutomationRunStateLabel(
  locale: MobileSupportedLocale,
  state: MobileAutomationRunState
): string {
  if (state === "completed") return mobileMessage(locale, "automation.run.state.completed");
  if (state === "failed") return mobileMessage(locale, "automation.run.state.failed");
  if (state === "skipped") return mobileMessage(locale, "automation.run.state.skipped");
  if (state === "aborted") return mobileMessage(locale, "automation.run.state.aborted");
  if (state === "interrupted") return mobileMessage(locale, "automation.run.state.interrupted");
  if (state === "queued") return mobileMessage(locale, "automation.run.state.queued");
  return mobileMessage(locale, "automation.run.state.running");
}

export function mobileAutomationPreRunStatusLabel(
  locale: MobileSupportedLocale,
  status: MobileAutomationPreRun["status"]
): string {
  if (status === "passed") return mobileMessage(locale, "automation.preRun.status.passed");
  if (status === "skipped") return mobileMessage(locale, "automation.preRun.status.skipped");
  if (status === "failed") return mobileMessage(locale, "automation.preRun.status.failed");
  if (status === "timed_out") return mobileMessage(locale, "automation.preRun.status.timedOut");
  return mobileMessage(locale, "automation.preRun.status.aborted");
}

export function mobileAutomationPreRunDecisionLabel(
  locale: MobileSupportedLocale,
  decision: MobileAutomationPreRun["decision"]
): string {
  if (decision === "run") return mobileMessage(locale, "automation.preRun.decision.run");
  if (decision === "skip") return mobileMessage(locale, "automation.preRun.decision.skip");
  return mobileMessage(locale, "automation.preRun.decision.block");
}

export function formatMobileAutomationDate(
  value: number,
  locale: MobileSupportedLocale,
  timeZone?: string
): string {
  return new Date(value).toLocaleString(locale, timeZone === undefined ? undefined : { timeZone });
}

export function formatMobileAutomationDuration(value: number | undefined, locale: MobileSupportedLocale): string {
  if (value === undefined) return mobileMessage(locale, "automation.duration.unavailable");
  if (value < 1_000) {
    return mobileMessage(locale, "automation.duration.milliseconds", {
      count: new Intl.NumberFormat(locale).format(value)
    });
  }
  const seconds = Math.round(value / 100) / 10;
  if (seconds < 60) {
    return mobileMessage(locale, "automation.duration.seconds", {
      count: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(seconds)
    });
  }
  if (seconds % 86_400 === 0) {
    return mobileMessage(locale, "automation.duration.days", {
      count: new Intl.NumberFormat(locale).format(seconds / 86_400)
    });
  }
  if (seconds % 3_600 === 0) {
    return mobileMessage(locale, "automation.duration.hours", {
      count: new Intl.NumberFormat(locale).format(seconds / 3_600)
    });
  }
  if (seconds % 60 === 0) {
    return mobileMessage(locale, "automation.duration.minutes", {
      count: new Intl.NumberFormat(locale).format(seconds / 60)
    });
  }
  return mobileMessage(locale, "automation.duration.minutesSeconds", {
    minutes: new Intl.NumberFormat(locale).format(Math.floor(seconds / 60)),
    seconds: new Intl.NumberFormat(locale).format(Math.round(seconds % 60))
  });
}

export function formatMobileAutomationCost(run: MobileAutomationRun, locale: MobileSupportedLocale): string {
  const attribution = mobileAutomationCostAttributionLabel(locale, run.costAttribution);
  const cost = run.cost ?? run.estimatedValue;
  if (cost) {
    const sign = cost.amountMicros < 0n ? "-" : "";
    const absolute = cost.amountMicros < 0n ? -cost.amountMicros : cost.amountMicros;
    const whole = absolute / 1_000_000n;
    const fraction = (absolute % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "") || "0";
    return mobileMessage(locale, "automation.cost.value", {
      value: `${cost.approximate ? "≈" : ""}${sign}${whole.toString()}.${fraction} ${cost.currencyCode}`,
      attribution
    });
  }
  if (run.zeroCost || run.costAttribution === "zero") return mobileMessage(locale, "automation.cost.zero");
  return mobileMessage(locale, "automation.cost.label", { attribution });
}

export function mobileAutomationTemplatePresentation(
  locale: MobileSupportedLocale,
  templateId: MobileAutomationTemplateId,
  parameterValue = ""
): MobileAutomationTemplatePresentation {
  if (templateId === "nightly-test-repair") return {
    name: mobileMessage(locale, "automation.template.nightlyTestRepair.name"),
    prompt: mobileMessage(locale, "automation.template.nightlyTestRepair.prompt")
  };
  if (templateId === "pull-request-review") return {
    name: mobileMessage(locale, "automation.template.pullRequestReview.name"),
    prompt: mobileMessage(locale, "automation.template.pullRequestReview.prompt")
  };
  if (templateId === "topic-radar") return {
    name: mobileMessage(locale, "automation.template.topicRadar.name"),
    prompt: mobileMessage(locale, "automation.template.topicRadar.prompt", { parameter: parameterValue }),
    parameter: {
      label: mobileMessage(locale, "automation.template.topicRadar.parameter"),
      placeholder: mobileMessage(locale, "automation.template.topicRadar.placeholder")
    }
  };
  if (templateId === "competitor-radar") return {
    name: mobileMessage(locale, "automation.template.competitorRadar.name"),
    prompt: mobileMessage(locale, "automation.template.competitorRadar.prompt", { parameter: parameterValue }),
    parameter: {
      label: mobileMessage(locale, "automation.template.competitorRadar.parameter"),
      placeholder: mobileMessage(locale, "automation.template.competitorRadar.placeholder")
    }
  };
  if (templateId === "weekly-report-draft") return {
    name: mobileMessage(locale, "automation.template.weeklyReportDraft.name"),
    prompt: mobileMessage(locale, "automation.template.weeklyReportDraft.prompt")
  };
  return {
    name: mobileMessage(locale, "automation.template.documentationFreshness.name"),
    prompt: mobileMessage(locale, "automation.template.documentationFreshness.prompt")
  };
}

function mobileAutomationCostAttributionLabel(
  locale: MobileSupportedLocale,
  value: MobileAutomationRun["costAttribution"]
): string {
  if (value === "exact") return mobileMessage(locale, "automation.cost.attribution.exact");
  if (value === "direct") return mobileMessage(locale, "automation.cost.attribution.direct");
  if (value === "mixed") return mobileMessage(locale, "automation.cost.attribution.mixed");
  if (value === "zero") return mobileMessage(locale, "automation.cost.attribution.zero");
  return mobileMessage(locale, "automation.cost.attribution.unavailable");
}
