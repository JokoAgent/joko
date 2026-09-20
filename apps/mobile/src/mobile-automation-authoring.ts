import { create } from "@bufbuild/protobuf";
import {
  BackendHealth,
  ExtraDirectoryAccess,
  PermissionMode,
  ScheduleExecutionMode,
  ScheduleGeneratedSessionDisposition,
  ScheduleInputSchema,
  ScheduleMisfirePolicy,
  ScheduleOverlapPolicy,
  ScheduleScriptCapability,
  ScheduleSessionMode,
  SessionState,
  TargetState,
  WorkspaceKind,
  type ScheduleDeletionResult,
  type ScheduleInput,
  type Session,
  type Snapshot,
  type Target
} from "@joko/contracts";
import {
  resolveMobileExplicitNewTaskModelAuthority,
  resolveMobileNewTaskDefaultModelAuthority,
  resolveMobileNewTaskExecutionAuthority,
  type MobileModelControlSelection,
  type MobileModelRoute
} from "./mobile-runtime-controls";
import {
  isValidMobileScheduleTimeZone,
  mobileScheduleEpochFromLocalDateTime,
  mobileScheduleLocalDateTimeFromEpoch
} from "./mobile-schedule-time";
import type { MobileAutomationSchedule } from "./mobile-automation";

export type MobileAutomationDisposition = "keep" | "archive" | "delete";

export interface MobileAutomationTargetOption {
  readonly targetId: string;
  readonly backendId: string;
  readonly workspaceId: string;
  readonly displayName: string;
  readonly workspaceKind: "project" | "dialogue";
  readonly projectAutomationEligible: boolean;
}

export interface MobileAutomationSessionOption {
  readonly sessionId: string;
  readonly displayName: string;
  readonly targetId: string;
  readonly backendId: string;
}

export interface MobileAutomationExtraDirectoryOption {
  readonly id: string;
  readonly path: string;
  readonly access: "readOnly" | "readWrite";
}

export interface MobileAutomationWorktreeSource {
  readonly ref: string;
  readonly commit: string;
  readonly displayName: string;
  readonly remote: boolean;
  readonly current: boolean;
}

export interface MobileAutomationWorktreeProof {
  readonly targetId: string;
  readonly eligibility: "eligible" | "notGitRepository" | "alreadyLinked" | "gitNotFound" | "unsafe" | "unavailable";
  readonly canRefreshRemote: boolean;
  readonly sources: readonly MobileAutomationWorktreeSource[];
}

export interface MobileAutomationDraft {
  readonly name: string;
  readonly targetId: string;
  readonly backendId: string;
  readonly sessionMode: "fresh" | "persistent" | "bound";
  readonly sessionId: string;
  readonly enabled: boolean;
  readonly recurrence: "manual" | "once" | "interval" | "cron";
  readonly expression: string;
  readonly intervalAnchorAt?: number;
  readonly timeZone: string;
  readonly inputText: string;
  readonly executionMode: "agent" | "script";
  readonly scriptCommand: string;
  readonly scriptTimeoutSeconds: string;
  readonly scriptDispatchSessions: boolean;
  readonly model?: MobileModelControlSelection;
  readonly permissionMode: "ask" | "auto" | "bypassPermissions";
  readonly planMode: boolean;
  readonly useWorktree: boolean;
  readonly worktreeSourceRef?: string;
  readonly refreshWorktreeRemote: boolean;
  readonly extraDirectoryIds: readonly string[];
  readonly silentWhenIdle: boolean;
  readonly notifyDesktop: boolean;
  readonly expireAtExpression: string;
  readonly preRunHook?: MobileAutomationSchedule["preRunHook"];
  readonly overlapPolicy: "queue" | "skip";
  readonly misfirePolicy: "runOnce" | "skip";
}

export type MobileAutomationTemplateId =
  | "nightly-test-repair"
  | "pull-request-review"
  | "topic-radar"
  | "competitor-radar"
  | "weekly-report-draft"
  | "documentation-freshness";

export interface MobileAutomationTemplate {
  readonly id: MobileAutomationTemplateId;
  readonly category: "Development" | "Radar" | "Office";
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly cronExpression: string;
  readonly useWorktree: boolean;
  readonly parameter?: { readonly key: string; readonly label: string; readonly placeholder: string };
}

export interface MobileAutomationBuild {
  readonly schedule: ScheduleInput;
  readonly target: Target;
  readonly boundSession?: Session;
}

export interface MobileAutomationDeletionPreview {
  readonly scheduleId: string;
  readonly scheduleRevision: string;
  readonly generatedSessionIds: readonly string[];
  readonly inflightCount: number;
}

export interface MobileAutomationDeletionFailure {
  readonly sessionId: string;
  readonly message: string;
}

export interface MobileAutomationDeletionOutcome {
  readonly scheduleId: string;
  readonly disposition: MobileAutomationDisposition;
  readonly generatedSessionIds: readonly string[];
  readonly completedSessionIds: readonly string[];
  readonly failures: readonly MobileAutomationDeletionFailure[];
  readonly inflightCount: number;
}

const templates: readonly MobileAutomationTemplate[] = [
  {
    id: "nightly-test-repair",
    category: "Development",
    name: "Nightly test self-healing",
    description: "Run tests every night and attempt minimal fixes for failures in an isolated worktree",
    prompt: "Run the project's test suite. If there are failures, attempt a minimal fix in an isolated worktree.\nConstraints:\n- Determine the standard test command from the repository documentation or package scripts before running the full suite\n- Only fix issues backed by clear failing evidence; prefer the smallest possible change and avoid unrelated refactoring\n- Re-run the affected tests after fixing to confirm they pass, and review the full diff\n- Deliver fixes through the repository's workflow, such as creating a branch and opening a pull request; never commit directly to the main branch\n- For failures that cannot be fixed safely, report the cause, suspicious files, and suggested next steps",
    cronExpression: "0 2 * * *",
    useWorktree: true
  },
  {
    id: "pull-request-review",
    category: "Development",
    name: "PR gatekeeper",
    description: "Pre-review new changes on open pull requests each weekday and report risks by severity",
    prompt: "Review the repository's open pull requests and pre-screen their new changes.\nConstraints:\n- Go through open pull requests with new commits in the past 24 hours; on Monday, look back over the whole weekend. Cite pull-request numbers, file paths, and concrete diffs\n- Focus on correctness, security, data-loss, and compatibility issues, graded by severity\n- Only report issues backed by evidence and describe the failure scenario; do not nitpick on style preferences\n- Unless explicitly authorized, only output review conclusions; do not comment on pull requests or change code",
    cronExpression: "0 10 * * 1-5",
    useWorktree: false
  },
  {
    id: "topic-radar",
    category: "Radar",
    name: "Domain radar",
    description: "Periodically collect the latest updates in a topic you follow and deliver an opinionated digest",
    prompt: "Collect the latest developments about \"{{topic}}\" from the past 24 hours; on Monday, look back over the whole weekend. Produce an opinionated digest.\nConstraints:\n- Use web search, cross-check multiple sources before trusting a claim, and cite the source link for every item\n- Prefer substantive developments such as releases, research, policy, and notable discussions; filter out marketing material and reposts\n- For each item, add a one-line judgement on why it matters instead of listing links\n- When information is scarce or sources are questionable, say so honestly; never fabricate",
    cronExpression: "0 9 * * 1-5",
    useWorktree: false,
    parameter: { key: "topic", label: "Topic to follow", placeholder: "e.g. AI agents, EV market, frontend frameworks" }
  },
  {
    id: "competitor-radar",
    category: "Radar",
    name: "Competitor watch",
    description: "Weekly roundup of competitors' product and market moves, with impact analysis",
    prompt: "Track the past week's activity of these competitors: {{competitors}}.\nConstraints:\n- Use web search to cover product updates, releases, pricing changes, market moves, and user sentiment, citing sources\n- Distinguish official information from third-party accounts; clearly mark unverified rumors\n- For each significant update, analyze what it means for us and suggest a response\n- If nothing substantive happened, say so honestly instead of padding the report",
    cronExpression: "0 9 * * 1",
    useWorktree: false,
    parameter: { key: "competitors", label: "Competitors", placeholder: "e.g. Notion, Linear, Figma" }
  },
  {
    id: "weekly-report-draft",
    category: "Office",
    name: "Weekly report drafter",
    description: "Compile this week's work from documents in the working directory into a report draft",
    prompt: "Based on this week's changes to documents, notes, and deliverables in the working directory, compile a weekly report draft.\nConstraints:\n- Only use content with actual modification traces in the working directory as evidence, citing the files\n- Organize as \"Done this week / In progress / Next week / Needs coordination\", concise enough to submit directly\n- Separate substantive progress from routine chores and highlight valuable output\n- Leave placeholders with notes where the material is insufficient so the user can fill them in",
    cronExpression: "0 16 * * 5",
    useWorktree: false
  },
  {
    id: "documentation-freshness",
    category: "Office",
    name: "Knowledge base freshness check",
    description: "Monthly health check of working-directory documents for outdated or conflicting content",
    prompt: "Health-check the documents in the working directory and find content that needs updating.\nConstraints:\n- Look for outdated information such as stale dates, dead links, and deprecated processes or tools, as well as contradictions and duplication\n- Cite the file path and location for every issue and explain the reasoning\n- Categorize the findings as update, merge, or delete suggestions and produce a revision checklist\n- Only output the report; do not modify the documents",
    cronExpression: "0 10 1 * *",
    useWorktree: false
  }
];

export function mobileAutomationTemplates(): readonly MobileAutomationTemplate[] {
  return templates;
}

export function mobileAutomationTargetOptions(owner: Snapshot | undefined): readonly MobileAutomationTargetOption[] {
  if (!owner || owner.scope?.kind.case !== "owner" || owner.settings === undefined) return [];
  const options: MobileAutomationTargetOption[] = [];
  for (const target of owner.targets) {
    if (target.state !== TargetState.ACTIVE || !strictIdentity(target.targetId) || !strictIdentity(target.backendId)
      || !strictIdentity(target.workspaceId)) continue;
    const backend = unique(owner.backends, (candidate) => candidate.backendId === target.backendId);
    const workspace = unique(owner.workspaces, (candidate) => candidate.workspaceId === target.workspaceId
      && candidate.targetId === target.targetId);
    const execution = resolveMobileNewTaskExecutionAuthority(owner, target.backendId);
    if (!backend || !workspace || !execution || backend !== execution.backend
      || backend.health === BackendHealth.UNAVAILABLE || backend.health === BackendHealth.STOPPED
      || !strictLabel(target.displayName, 512)) continue;
    if (workspace.kind !== WorkspaceKind.USER_PROJECT && workspace.kind !== WorkspaceKind.MANAGED_DIALOGUE) continue;
    options.push({
      targetId: target.targetId,
      backendId: target.backendId,
      workspaceId: target.workspaceId,
      displayName: target.displayName,
      workspaceKind: workspace.kind === WorkspaceKind.USER_PROJECT ? "project" : "dialogue",
      projectAutomationEligible: workspace.kind === WorkspaceKind.USER_PROJECT && target.remoteWorkspace === undefined
    });
  }
  return options.sort((left, right) => compareText(left.displayName, right.displayName)
    || compareText(left.targetId, right.targetId));
}

export function mobileAutomationSessionOptions(
  owner: Snapshot | undefined,
  targetId: string
): readonly MobileAutomationSessionOption[] {
  if (!owner || !strictIdentity(targetId)) return [];
  return owner.sessions.filter((session) => session.targetId === targetId && activeSession(session))
    .filter((session, index, values) => values.findIndex((candidate) => candidate.sessionId === session.sessionId) === index)
    .map((session) => ({
      sessionId: session.sessionId,
      displayName: strictLabel(session.displayName, 512) ? session.displayName : session.sessionId,
      targetId: session.targetId,
      backendId: session.backendId
    }))
    .sort((left, right) => compareText(left.displayName, right.displayName)
      || compareText(left.sessionId, right.sessionId));
}

export function mobileAutomationModelOptions(
  owner: Snapshot | undefined,
  backendId: string
): readonly MobileModelRoute[] {
  return resolveMobileNewTaskExecutionAuthority(owner, backendId)?.models ?? [];
}

export function mobileAutomationPermissionOptions(
  owner: Snapshot | undefined,
  backendId: string
): readonly MobileAutomationDraft["permissionMode"][] {
  return (resolveMobileNewTaskExecutionAuthority(owner, backendId)?.permissionModes ?? [])
    .flatMap((mode) => mode === PermissionMode.ASK ? ["ask" as const]
      : mode === PermissionMode.AUTO ? ["auto" as const]
        : mode === PermissionMode.BYPASS_PERMISSIONS ? ["bypassPermissions" as const] : []);
}

export function mobileAutomationExtraDirectoryOptions(
  owner: Snapshot | undefined,
  targetId: string
): readonly MobileAutomationExtraDirectoryOption[] {
  const target = owner?.targets.find((candidate) => candidate.targetId === targetId);
  const execution = resolveMobileNewTaskExecutionAuthority(owner, target?.backendId);
  if (!owner || !target || !execution?.supportsExtraDirectories) return [];
  return owner.extraDirectories.filter((directory) => directory.workspaceId === target.workspaceId && directory.trusted)
    .filter((directory, index, values) => strictIdentity(directory.extraDirectoryId)
      && values.findIndex((candidate) => candidate.extraDirectoryId === directory.extraDirectoryId) === index)
    .flatMap<MobileAutomationExtraDirectoryOption>((directory) => directory.access === ExtraDirectoryAccess.READ_ONLY ? [{
      id: directory.extraDirectoryId,
      path: directory.serverPathDisplay,
      access: "readOnly" as const
    }] : directory.access === ExtraDirectoryAccess.READ_WRITE ? [{
      id: directory.extraDirectoryId,
      path: directory.serverPathDisplay,
      access: "readWrite" as const
    }] : [])
    .sort((left, right) => compareText(left.path, right.path) || compareText(left.id, right.id));
}

export function createMobileAutomationDraft(
  owner: Snapshot | undefined,
  schedule?: MobileAutomationSchedule,
  now = Date.now()
): MobileAutomationDraft {
  const targets = mobileAutomationTargetOptions(owner);
  const target = targets.find((candidate) => candidate.targetId === schedule?.targetId) ?? targets[0];
  const backendId = schedule?.backendId ?? target?.backendId ?? "";
  const execution = resolveMobileNewTaskExecutionAuthority(owner, backendId);
  const defaultModel = resolveMobileNewTaskDefaultModelAuthority(owner, backendId)?.selection;
  const backendSettings = owner?.settings?.backends.filter((candidate) => candidate.backendId === backendId) ?? [];
  const defaultPermission = backendSettings.length === 1
    ? permissionFromProto(backendSettings[0]!.defaultPermissionMode) : undefined;
  const permissions = mobileAutomationPermissionOptions(owner, backendId);
  const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timeZone = schedule?.timeZone ?? (isValidMobileScheduleTimeZone(localTimeZone) ? localTimeZone : "UTC");
  if (schedule && schedule.executionMode === "agent" && schedule.editableInputText === undefined) {
    throw new Error("This Automation uses structured scheduled input that the mobile text editor cannot rewrite safely.");
  }
  const expression = schedule === undefined ? ""
    : schedule.recurrence === "once" ? mobileScheduleLocalDateTimeFromEpoch(Date.parse(schedule.recurrenceExpression), timeZone)
      : schedule.recurrenceExpression;
  return {
    name: schedule?.displayName ?? "",
    targetId: schedule?.targetId ?? target?.targetId ?? "",
    backendId,
    sessionMode: schedule?.sessionMode ?? "fresh",
    sessionId: schedule?.sessionId ?? "",
    enabled: schedule === undefined ? true : schedule.state !== "disabled" && schedule.state !== "deleting",
    recurrence: schedule?.recurrence ?? "manual",
    expression,
    ...(schedule?.intervalAnchorAt === undefined ? {} : { intervalAnchorAt: schedule.intervalAnchorAt }),
    timeZone,
    inputText: schedule?.editableInputText ?? "",
    executionMode: schedule?.executionMode ?? "agent",
    scriptCommand: schedule?.script?.command ?? "",
    scriptTimeoutSeconds: schedule?.script?.timeoutMs === undefined ? "" : String(schedule.script.timeoutMs / 1_000),
    scriptDispatchSessions: schedule?.script?.dispatchSessions ?? false,
    ...(schedule?.model !== undefined
      ? { model: { ...schedule.model, ...(schedule.model.effortId === undefined ? {} : { effortId: schedule.model.effortId }) } }
      : defaultModel === undefined ? {} : { model: defaultModel }),
    permissionMode: schedule?.permissionMode ?? (defaultPermission && permissions.includes(defaultPermission)
      ? defaultPermission : permissions[0] ?? "ask"),
    planMode: schedule?.planMode ?? (execution?.canSetPlanMode && backendSettings.length === 1
      ? backendSettings[0]!.defaultPlanMode : false),
    useWorktree: schedule?.useWorktree ?? false,
    ...(schedule?.worktreeSourceRef === undefined ? {} : { worktreeSourceRef: schedule.worktreeSourceRef }),
    refreshWorktreeRemote: schedule?.refreshWorktreeRemote ?? false,
    extraDirectoryIds: [...(schedule?.extraDirectoryIds ?? [])],
    silentWhenIdle: schedule?.silentWhenIdle ?? false,
    notifyDesktop: schedule?.notifyDesktop ?? true,
    expireAtExpression: schedule?.expireAt === undefined
      ? "" : mobileScheduleLocalDateTimeFromEpoch(schedule.expireAt, timeZone),
    ...(schedule?.preRunHook === undefined ? {} : { preRunHook: schedule.preRunHook }),
    overlapPolicy: schedule?.overlapPolicy ?? "queue",
    misfirePolicy: schedule?.misfirePolicy ?? "runOnce"
  };
}

export function applyMobileAutomationTemplate(
  draft: MobileAutomationDraft,
  templateId: MobileAutomationTemplateId,
  parameterValue = ""
): MobileAutomationDraft {
  const template = templates.find((candidate) => candidate.id === templateId);
  if (!template) throw new Error("Choose a current Automation template.");
  const value = parameterValue.trim();
  if (template.parameter && !value) throw new Error(`Enter ${template.parameter.label.toLocaleLowerCase("en-US")}.`);
  const prompt = template.parameter === undefined
    ? template.prompt : template.prompt.replaceAll(`{{${template.parameter.key}}}`, value);
  return {
    ...draft,
    name: template.name,
    recurrence: "cron",
    expression: template.cronExpression,
    intervalAnchorAt: undefined,
    timeZone: "Asia/Shanghai",
    inputText: prompt,
    executionMode: "agent",
    sessionMode: "fresh",
    sessionId: "",
    useWorktree: template.useWorktree,
    worktreeSourceRef: undefined,
    refreshWorktreeRemote: false,
    notifyDesktop: true
  };
}

export function buildMobileAutomationScheduleInput(
  owner: Snapshot | undefined,
  draft: MobileAutomationDraft,
  existing: MobileAutomationSchedule | undefined,
  worktree: MobileAutomationWorktreeProof | undefined,
  now = Date.now()
): MobileAutomationBuild {
  if (!owner || owner.scope?.kind.case !== "owner" || owner.settings === undefined || owner.generation < 1n) {
    throw new Error("Reload Automations from the current Joko node before saving.");
  }
  if (existing?.executionMode === "agent" && existing.editableInputText === undefined) {
    throw new Error("This Automation uses structured scheduled input that the mobile text editor cannot rewrite safely.");
  }
  const targetOptions = mobileAutomationTargetOptions(owner);
  const targetOption = unique(targetOptions, (candidate) => candidate.targetId === draft.targetId);
  const target = unique(owner.targets, (candidate) => candidate.targetId === draft.targetId);
  if (!targetOption || !target || target.state !== TargetState.ACTIVE || !positiveRevision(target.version?.revision)) {
    throw new Error("The selected Automation project is no longer available.");
  }
  if (draft.backendId !== targetOption.backendId || (existing && existing.source === "project"
    && (existing.targetId !== draft.targetId || draft.sessionMode === "bound"))) {
    throw new Error("A project Automation cannot change its project or bind an existing task.");
  }
  const execution = resolveMobileNewTaskExecutionAuthority(owner, targetOption.backendId);
  if (!execution) throw new Error("The selected Backend can no longer run a text Automation.");
  const name = boundedRequired(draft.name.trim(), "Automation name", 512);
  if (!isValidMobileScheduleTimeZone(draft.timeZone)) throw new Error("Enter a valid IANA time zone.");
  const timeZone = draft.timeZone;
  let recurrence: ScheduleInput["recurrence"];
  if (draft.recurrence === "manual") {
    recurrence = { kind: { case: "manual", value: {} } } as ScheduleInput["recurrence"];
  } else if (draft.recurrence === "once") {
    const epoch = mobileScheduleEpochFromLocalDateTime(draft.expression, timeZone);
    if (epoch === undefined) throw new Error("Enter a valid one-shot time in the selected time zone.");
    if (draft.enabled && epoch <= now) throw new Error("An enabled one-shot Automation must run in the future.");
    recurrence = { kind: { case: "oneShot", value: { triggerAt: timestamp(epoch) } } } as ScheduleInput["recurrence"];
  } else if (draft.recurrence === "interval") {
    const seconds = Number(draft.expression);
    if (!Number.isSafeInteger(seconds) || seconds < 1) throw new Error("Interval seconds must be a positive whole number.");
    const milliseconds = seconds * 1_000;
    if (!Number.isSafeInteger(milliseconds)) throw new Error("The Automation interval is too large.");
    const anchorAt = Number.isSafeInteger(draft.intervalAnchorAt) && (draft.intervalAnchorAt ?? 0) >= 0
      ? draft.intervalAnchorAt! : now;
    recurrence = { kind: { case: "interval", value: {
      interval: duration(milliseconds),
      anchorAt: timestamp(anchorAt)
    } } } as ScheduleInput["recurrence"];
  } else {
    const expression = boundedRequired(draft.expression.trim(), "cron expression", 1_024);
    recurrence = { kind: { case: "cron", value: { expression } } } as ScheduleInput["recurrence"];
  }

  const scriptMode = draft.executionMode === "script";
  if (scriptMode && (draft.sessionMode !== "fresh" || draft.sessionId !== "" || draft.useWorktree
    || draft.extraDirectoryIds.length > 0 || draft.planMode || draft.silentWhenIdle || draft.model !== undefined)) {
    throw new Error("Script Automations require a fresh task and cannot use model, Plan, extra-directory, or Worktree options.");
  }
  let boundSession: Session | undefined;
  if (!scriptMode && draft.sessionMode === "bound") {
    boundSession = unique(owner.sessions, (candidate) => candidate.sessionId === draft.sessionId);
    if (!boundSession || !activeSession(boundSession) || boundSession.targetId !== target.targetId
      || boundSession.backendId !== target.backendId || !positiveRevision(boundSession.version?.revision)) {
      throw new Error("Choose a current active task from the selected project.");
    }
  } else if (draft.sessionMode === "fresh" && draft.sessionId !== "") {
    throw new Error("A fresh Automation cannot retain a task binding.");
  } else if (draft.sessionMode === "persistent" && draft.sessionId !== "") {
    boundSession = unique(owner.sessions, (candidate) => candidate.sessionId === draft.sessionId);
    if (!boundSession || boundSession.targetId !== target.targetId || boundSession.backendId !== target.backendId) {
      throw new Error("The persistent Automation task binding is no longer current.");
    }
  }

  const permissionMode = permissionToProto(draft.permissionMode);
  const existingPermission = existing === undefined ? undefined : permissionToProto(existing.permissionMode);
  if (!execution.permissionModes.includes(permissionMode) && existingPermission !== permissionMode) {
    throw new Error("The selected permission mode is no longer advertised by this Backend.");
  }
  if (draft.planMode && !execution.canSetPlanMode && existing?.planMode !== true) {
    throw new Error("Plan Mode is unavailable for this Backend.");
  }
  let model: MobileModelControlSelection | undefined;
  if (!scriptMode && draft.model !== undefined) {
    const routeChanged = existing?.model?.providerId !== draft.model.providerId
      || existing.model.modelId !== draft.model.modelId;
    const effortChanged = existing?.model?.effortId !== draft.model.effortId;
    const fastModeChanged = (existing?.model?.fastMode ?? false) !== draft.model.fastMode;
    const defaultModel = existing === undefined
      ? resolveMobileNewTaskDefaultModelAuthority(owner, target.backendId)?.selection
      : undefined;
    const configuredDefault = defaultModel?.providerId === draft.model.providerId
      && defaultModel.modelId === draft.model.modelId
      && defaultModel.effortId === draft.model.effortId
      && defaultModel.fastMode === draft.model.fastMode;
    if (routeChanged && !execution.canSelectModel && !configuredDefault) {
      throw new Error("This Backend does not allow choosing a model for new work.");
    }
    if (effortChanged && !execution.canSetEffort && !configuredDefault) {
      throw new Error("This Backend does not allow choosing model effort.");
    }
    if (fastModeChanged && !execution.canSetFastMode && !configuredDefault) {
      throw new Error("Fast Mode is unavailable for this Backend.");
    }
    const unchanged = !routeChanged && !effortChanged && !fastModeChanged;
    const authority = resolveMobileExplicitNewTaskModelAuthority(owner, target.backendId, draft.model);
    if (!authority && !unchanged) throw new Error("The selected model route is no longer available.");
    model = authority?.selection ?? draft.model;
  } else if (!scriptMode && existing?.model !== undefined && !execution.canSelectModel) {
    throw new Error("This Backend does not allow clearing the saved model snapshot.");
  }

  const extraDirectoryOptions = mobileAutomationExtraDirectoryOptions(owner, target.targetId);
  const extraDirectoryIds = [...draft.extraDirectoryIds];
  if (new Set(extraDirectoryIds).size !== extraDirectoryIds.length
    || extraDirectoryIds.some((id) => !extraDirectoryOptions.some((option) => option.id === id))) {
    throw new Error("One or more extra directories are no longer trusted for this project.");
  }
  if (draft.useWorktree) {
    if (scriptMode || draft.sessionMode !== "fresh" || targetOption.workspaceKind !== "project"
      || !targetOption.projectAutomationEligible) {
      throw new Error("An isolated Worktree requires agent execution with a fresh project task.");
    }
    if (worktree?.targetId !== target.targetId
      || worktree.eligibility !== "eligible" && (draft.enabled || worktree.eligibility !== "unavailable")) {
      throw new Error("Reload and confirm isolated Worktree support before enabling this Automation.");
    }
    if (worktree.eligibility === "eligible" && draft.refreshWorktreeRemote && worktree.canRefreshRemote !== true) {
      throw new Error("This project cannot refresh remote Worktree sources.");
    }
    if (worktree.eligibility === "eligible" && draft.worktreeSourceRef !== undefined
      && !worktree.sources.some((source) => source.ref === draft.worktreeSourceRef)) {
      throw new Error("The selected Worktree source is no longer available.");
    }
  } else if (draft.worktreeSourceRef !== undefined || draft.refreshWorktreeRemote) {
    throw new Error("Worktree source options require an isolated Worktree.");
  }
  if (existing?.preRunHook !== undefined && !samePreRunHook(existing.preRunHook, draft.preRunHook)) {
    throw new Error("A managed pre-run hook cannot be changed in the Automation editor.");
  }
  if (existing?.preRunHook === undefined && draft.preRunHook !== undefined) {
    throw new Error("A pre-run hook must be installed through its managed workflow.");
  }

  const expireAt = draft.expireAtExpression.trim() === ""
    ? undefined : mobileScheduleEpochFromLocalDateTime(draft.expireAtExpression, timeZone);
  if (draft.expireAtExpression.trim() !== "" && expireAt === undefined) {
    throw new Error("Enter a valid expiration time in the selected IANA time zone.");
  }
  const inputText = scriptMode ? "" : boundedRequired(draft.inputText, "scheduled input", 131_072);
  const scriptCommand = scriptMode ? boundedRequired(draft.scriptCommand, "script command", 32_768) : "";
  const scriptTimeoutSeconds = scriptMode && draft.scriptTimeoutSeconds.trim() !== ""
    ? Number(draft.scriptTimeoutSeconds) : undefined;
  if (scriptTimeoutSeconds !== undefined && (!Number.isSafeInteger(scriptTimeoutSeconds) || scriptTimeoutSeconds <= 0)) {
    throw new Error("Script timeout seconds must be a positive whole number.");
  }
  const scriptTimeoutMs = scriptTimeoutSeconds === undefined ? undefined : scriptTimeoutSeconds * 1_000;
  if (scriptTimeoutMs !== undefined && !Number.isSafeInteger(scriptTimeoutMs)) {
    throw new Error("The script timeout is too large.");
  }
  const sessionMode = scriptMode || draft.sessionMode === "fresh" ? ScheduleSessionMode.FRESH
    : draft.sessionMode === "persistent" ? ScheduleSessionMode.PERSISTENT : ScheduleSessionMode.BOUND;
  const sessionId = scriptMode || draft.sessionMode === "fresh" ? "" : draft.sessionId;
  const schedule = create(ScheduleInputSchema, {
    displayName: name,
    backendId: target.backendId,
    targetId: target.targetId,
    sessionId,
    sessionMode,
    recurrence,
    timeZone,
    input: { parts: inputText.length === 0 ? [] : [{ content: { case: "text", value: inputText } }] },
    execution: {
      ...(model === undefined ? {} : { model: {
        model: { providerId: model.providerId, modelId: model.modelId },
        effortId: model.effortId ?? "",
        fastMode: model.fastMode
      } }),
      permissionMode,
      planMode: !scriptMode && draft.planMode,
      extraDirectoryIds: scriptMode ? [] : extraDirectoryIds,
      executionMode: scriptMode ? ScheduleExecutionMode.SCRIPT : ScheduleExecutionMode.AGENT,
      ...(scriptMode ? { script: {
        command: scriptCommand,
        ...(scriptTimeoutMs === undefined ? {} : { timeout: duration(scriptTimeoutMs) }),
        capabilities: draft.scriptDispatchSessions ? [ScheduleScriptCapability.SESSIONS_DISPATCH] : []
      } } : {}),
      silentWhenIdle: !scriptMode && draft.silentWhenIdle,
      notify: { desktop: draft.notifyDesktop },
      ...(expireAt === undefined ? {} : { expireAt: timestamp(expireAt) }),
      ...(draft.preRunHook === undefined ? {} : { preRunHook: {
        command: draft.preRunHook.command,
        filePath: draft.preRunHook.filePath,
        ...(draft.preRunHook.timeoutMs === undefined ? {} : { timeout: duration(draft.preRunHook.timeoutMs) })
      } }),
      useWorktree: draft.useWorktree,
      ...(draft.useWorktree && draft.worktreeSourceRef !== undefined
        ? { worktreeSourceRef: draft.worktreeSourceRef } : {}),
      refreshWorktreeRemote: draft.useWorktree && draft.refreshWorktreeRemote
    },
    overlapPolicy: draft.overlapPolicy === "skip" ? ScheduleOverlapPolicy.SKIP : ScheduleOverlapPolicy.QUEUE,
    misfirePolicy: draft.misfirePolicy === "skip" ? ScheduleMisfirePolicy.SKIP : ScheduleMisfirePolicy.RUN_ONCE,
    enabled: draft.enabled
  });
  return { schedule, target, ...(boundSession === undefined ? {} : { boundSession }) };
}

export function mobileAutomationDraftKey(draft: MobileAutomationDraft): string {
  return JSON.stringify({ ...draft, extraDirectoryIds: [...draft.extraDirectoryIds] });
}

export function mobileAutomationDispositionProto(value: MobileAutomationDisposition): ScheduleGeneratedSessionDisposition {
  if (value === "keep") return ScheduleGeneratedSessionDisposition.KEEP;
  if (value === "archive") return ScheduleGeneratedSessionDisposition.ARCHIVE;
  return ScheduleGeneratedSessionDisposition.DELETE;
}

export function projectMobileAutomationDeletionResult(
  result: ScheduleDeletionResult,
  expectedScheduleId: string,
  expectedDisposition: MobileAutomationDisposition
): MobileAutomationDeletionOutcome {
  if (result.scheduleId !== expectedScheduleId
    || dispositionFromProto(result.generatedSessionDisposition) !== expectedDisposition) {
    throw new Error("The Joko node returned a deletion result for another Automation operation.");
  }
  const generatedSessionIds = result.generatedSessionIds.map((id) => requiredIdentity(id, "generated task"));
  const completedSessionIds = result.completedSessionIds.map((id) => requiredIdentity(id, "completed task"));
  assertUnique(generatedSessionIds, "generated Automation task");
  assertUnique(completedSessionIds, "completed Automation task");
  const generated = new Set(generatedSessionIds);
  if (completedSessionIds.some((id) => !generated.has(id))) {
    throw new Error("The Joko node completed a task outside the Automation deletion manifest.");
  }
  const failures = result.failures.map((failure) => ({
    sessionId: requiredIdentity(failure.sessionId, "failed task"),
    message: boundedRequired(failure.message, "Automation deletion failure", 16_384)
  }));
  assertUnique(failures.map((failure) => failure.sessionId), "failed Automation task");
  if (failures.some((failure) => !generated.has(failure.sessionId)
    || completedSessionIds.includes(failure.sessionId))) {
    throw new Error("The Joko node returned an inconsistent Automation deletion result.");
  }
  if (!Number.isSafeInteger(result.inflightCount) || result.inflightCount < 0) {
    throw new Error("The Joko node returned an invalid Automation deletion in-flight count.");
  }
  return {
    scheduleId: result.scheduleId,
    disposition: expectedDisposition,
    generatedSessionIds,
    completedSessionIds,
    failures,
    inflightCount: result.inflightCount
  };
}

export function mobileAutomationScheduleRevisionKey(schedule: MobileAutomationSchedule): string {
  return JSON.stringify([
    schedule.scheduleId,
    schedule.generation.toString(10),
    schedule.revision.value.toString(10),
    schedule.revision.etag
  ]);
}

function dispositionFromProto(value: ScheduleGeneratedSessionDisposition): MobileAutomationDisposition {
  if (value === ScheduleGeneratedSessionDisposition.KEEP) return "keep";
  if (value === ScheduleGeneratedSessionDisposition.ARCHIVE) return "archive";
  if (value === ScheduleGeneratedSessionDisposition.DELETE) return "delete";
  throw new Error("The Joko node returned an unknown Automation deletion disposition.");
}

function permissionFromProto(value: PermissionMode): MobileAutomationDraft["permissionMode"] | undefined {
  if (value === PermissionMode.ASK) return "ask";
  if (value === PermissionMode.AUTO) return "auto";
  if (value === PermissionMode.BYPASS_PERMISSIONS) return "bypassPermissions";
  return undefined;
}

function permissionToProto(value: MobileAutomationDraft["permissionMode"]): PermissionMode {
  if (value === "ask") return PermissionMode.ASK;
  if (value === "auto") return PermissionMode.AUTO;
  if (value === "bypassPermissions") return PermissionMode.BYPASS_PERMISSIONS;
  throw new Error("Choose a current Automation permission mode.");
}

function timestamp(milliseconds: number): { readonly seconds: bigint; readonly nanos: number } {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new Error("The Automation time is invalid.");
  return { seconds: BigInt(Math.floor(milliseconds / 1_000)), nanos: milliseconds % 1_000 * 1_000_000 };
}

function duration(milliseconds: number): { readonly seconds: bigint; readonly nanos: number } {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) throw new Error("The Automation duration is invalid.");
  return { seconds: BigInt(Math.floor(milliseconds / 1_000)), nanos: milliseconds % 1_000 * 1_000_000 };
}

function activeSession(session: Session): boolean {
  return strictIdentity(session.sessionId) && !session.archived && [
    SessionState.IDLE,
    SessionState.RUNNING,
    SessionState.WAITING,
    SessionState.DETACHED,
    SessionState.RECOVERING
  ].includes(session.state);
}

function samePreRunHook(
  left: MobileAutomationSchedule["preRunHook"],
  right: MobileAutomationSchedule["preRunHook"]
): boolean {
  return left?.command === right?.command && left?.filePath === right?.filePath
    && left?.timeoutMs === right?.timeoutMs;
}

function positiveRevision(value: { readonly value: bigint } | undefined): boolean {
  return (value?.value ?? 0n) > 0n;
}

function strictIdentity(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && value.length <= 512 && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function requiredIdentity(value: string, label: string): string {
  if (!strictIdentity(value)) throw new Error(`The Joko node returned an invalid ${label} identity.`);
  return value;
}

function strictLabel(value: string | undefined, maximum: number): value is string {
  return value !== undefined && value.trim().length > 0 && value.length <= maximum && !value.includes("\0");
}

function boundedRequired(value: string, label: string, maximum: number): string {
  if (!strictLabel(value, maximum)) throw new Error(`Enter a non-empty ${label} of at most ${maximum} characters.`);
  return value;
}

function unique<T>(values: readonly T[], predicate: (value: T) => boolean): T | undefined {
  const matches = values.filter(predicate);
  return matches.length === 1 ? matches[0] : undefined;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`The Joko node returned duplicate ${label} identities.`);
}

function compareText(left: string, right: string): number {
  const first = left.toLocaleLowerCase("en-US");
  const second = right.toLocaleLowerCase("en-US");
  return first < second ? -1 : first > second ? 1 : left < right ? -1 : left > right ? 1 : 0;
}
