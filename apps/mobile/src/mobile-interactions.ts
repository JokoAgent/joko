import { create } from "@bufbuild/protobuf";
import {
  BrowserPermissionAction,
  CompositeArgumentKind,
  FilePermissionAction,
  InteractionKind,
  InteractionResolutionSchema,
  InteractionState,
  PermissionDecisionKind,
  PermissionResolutionSchema,
  PermissionRisk,
  PlanReviewDecisionKind,
  PlanReviewResolutionSchema,
  PlanStepState,
  QuestionAnswerSchema,
  QuestionMultipleChoiceAnswerSchema,
  QuestionResolutionSchema,
  QuestionSingleChoiceAnswerSchema,
  ResourcePermissionAction,
  type DisplayArgument,
  type Interaction,
  type InteractionResolution,
  type PermissionSubject,
  type QuestionField,
  type Snapshot
} from "@joko/contracts";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";

export type MobileQuestionAnswerDraft =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "single"; readonly selection: { readonly kind: "choice"; readonly choiceId: string } | { readonly kind: "other"; readonly text: string } }
  | { readonly kind: "multiple"; readonly choiceIds: readonly string[]; readonly otherText?: string }
  | { readonly kind: "boolean"; readonly value: boolean };

export type MobileQuestionAnswers = Readonly<Record<string, MobileQuestionAnswerDraft>>;

export type MobileInteractionDraft =
  | { readonly kind: "question"; readonly fieldIndex: number; readonly answers: MobileQuestionAnswers }
  | { readonly kind: "plan"; readonly feedback: string };

export type MobileInteractionSubmission =
  | { readonly kind: "permission"; readonly decision: PermissionDecisionKind }
  | { readonly kind: "question"; readonly answers: MobileQuestionAnswers }
  | { readonly kind: "plan"; readonly decision: PlanReviewDecisionKind; readonly feedback: string };

export interface MobilePermissionDetail {
  readonly label: string;
  readonly value: string;
  readonly redacted?: boolean;
}

const currentPermissionDecisions = new Set<number>([
  PermissionDecisionKind.ALLOW_ONCE,
  PermissionDecisionKind.ALLOW_FOR_TURN,
  PermissionDecisionKind.ALLOW_FOR_SESSION,
  PermissionDecisionKind.DENY_ONCE,
  PermissionDecisionKind.DENY_FOR_SESSION,
  PermissionDecisionKind.ABORT_RUN
]);

const currentPlanDecisions = new Set<number>([
  PlanReviewDecisionKind.EXECUTE,
  PlanReviewDecisionKind.STAY_IN_PLAN_MODE,
  PlanReviewDecisionKind.REFINE
]);

export function pendingMobileInteractions(snapshot: Snapshot | undefined, sessionId: string | undefined): readonly Interaction[] {
  if (!snapshot || !sessionId) return [];
  const session = snapshot.sessions.find((candidate) => candidate.sessionId === sessionId);
  const runtimeGeneration = session?.nativeBinding?.runtimeGeneration;
  if (!session || !runtimeGeneration || runtimeGeneration < 1n) return [];
  return snapshot.interactions.filter((interaction) =>
    interaction.state === InteractionState.PENDING
    && interaction.sessionId === sessionId
    && interaction.backendId === session.backendId
    && interaction.targetId === session.targetId
    && interaction.generation === runtimeGeneration
    && interaction.version?.generation === interaction.generation
    && (interaction.version?.revision?.value ?? 0n) > 0n
    && supportedRequestCase(interaction)
  ).slice().sort((left, right) =>
    interactionPriority(left) - interactionPriority(right)
    || compareTimestamp(left, right)
    || left.interactionId.localeCompare(right.interactionId)
  );
}

export function mobileInteractionAuthorityKey(interaction: Interaction): string {
  assertCurrentInteraction(interaction);
  return [
    interaction.sessionId,
    interaction.backendId,
    interaction.targetId,
    interaction.interactionId,
    interaction.request.case,
    interaction.generation.toString(10),
    interaction.version!.generation.toString(10),
    interaction.version!.revision!.value.toString(10)
  ].join("\u001f");
}

export function initialMobileInteractionDraft(interaction: Interaction): MobileInteractionDraft | undefined {
  assertCurrentInteraction(interaction);
  if (interaction.request.case === "question") {
    validateQuestionDeclaration(interaction.request.value.fields);
    return {
      kind: "question",
      fieldIndex: 0,
      answers: Object.fromEntries(interaction.request.value.fields.flatMap((field) => {
        const answer = defaultQuestionAnswer(field);
        return answer === undefined ? [] : [[field.fieldId, answer]];
      }))
    };
  }
  if (interaction.request.case === "planReview") {
    validatePlanDeclaration(interaction);
    return { kind: "plan", feedback: "" };
  }
  validatePermissionDeclaration(interaction);
  return undefined;
}

export function mobileQuestionFieldError(
  field: QuestionField,
  answer: MobileQuestionAnswerDraft | undefined,
  locale: MobileSupportedLocale
): string | undefined {
  validateQuestionFieldDeclaration(field);
  const label = field.label || field.fieldId;
  if (answer === undefined) return field.required ? mobileMessage(locale, "interaction.field.required", { label }) : undefined;
  if (field.input.case === "text") {
    if (answer.kind !== "text") return mobileMessage(locale, "interaction.field.text", { label });
    return field.required && answer.value.trim() === ""
      ? mobileMessage(locale, "interaction.field.required", { label }) : undefined;
  }
  if (field.input.case === "boolean") return answer.kind === "boolean" ? undefined
    : mobileMessage(locale, "interaction.field.boolean", { label });
  if (field.input.case === "singleChoice") {
    if (answer.kind !== "single") return mobileMessage(locale, "interaction.field.oneChoice", { label });
    if (answer.selection.kind === "choice") {
      const choiceId = answer.selection.choiceId;
      return field.input.value.choices.some((choice) => choice.choiceId === choiceId)
        ? undefined
        : mobileMessage(locale, "interaction.field.choiceUnavailable", { label });
    }
    return field.input.value.allowOther && answer.selection.text.trim() !== ""
      ? undefined
      : mobileMessage(locale, "interaction.field.freeText", { label });
  }
  if (field.input.case !== "multipleChoice" || answer.kind !== "multiple") {
    return mobileMessage(locale, "interaction.field.choiceList", { label });
  }
  const ids = new Set(field.input.value.choices.map((choice) => choice.choiceId));
  if (new Set(answer.choiceIds).size !== answer.choiceIds.length || answer.choiceIds.some((choiceId) => !ids.has(choiceId))) {
    return mobileMessage(locale, "interaction.field.choiceUnavailable", { label });
  }
  if (answer.otherText !== undefined && (!field.input.value.allowOther || answer.otherText.trim() === "")) {
    return mobileMessage(locale, "interaction.field.freeTextNotAllowed", { label });
  }
  const count = answer.choiceIds.length + (answer.otherText === undefined ? 0 : 1);
  const minimum = Math.max(field.required ? 1 : 0, field.input.value.minimumSelections);
  const maximum = field.input.value.maximumSelections === 0 ? undefined : field.input.value.maximumSelections;
  if (count < minimum) return mobileMessage(locale, "interaction.field.minimum", { label, count: minimum });
  if (maximum !== undefined && count > maximum) {
    return mobileMessage(locale, "interaction.field.maximum", { label, count: maximum });
  }
  return undefined;
}

export function mobileQuestionCanSubmit(interaction: Interaction, answers: MobileQuestionAnswers): boolean {
  if (interaction.request.case !== "question") return false;
  try {
    validateQuestionDeclaration(interaction.request.value.fields);
    const fieldIds = new Set(interaction.request.value.fields.map((field) => field.fieldId));
    if (Object.keys(answers).some((fieldId) => !fieldIds.has(fieldId))) return false;
    return interaction.request.value.fields.every((field) => mobileQuestionFieldError(field, answers[field.fieldId], "en") === undefined);
  } catch {
    return false;
  }
}

export function clampMobileQuestionIndex(index: number, fieldCount: number): number {
  return Math.max(0, Math.min(Math.max(0, fieldCount - 1), Number.isFinite(index) ? Math.trunc(index) : 0));
}

export function toggleMobileQuestionChoice(
  field: QuestionField,
  answer: MobileQuestionAnswerDraft | undefined,
  choiceId: string
): MobileQuestionAnswerDraft {
  validateQuestionFieldDeclaration(field);
  if (field.input.case === "singleChoice") {
    if (!field.input.value.choices.some((choice) => choice.choiceId === choiceId)) throw new Error("This choice is no longer available.");
    return { kind: "single", selection: { kind: "choice", choiceId } };
  }
  if (field.input.case !== "multipleChoice") throw new Error("This question does not accept choices.");
  if (!field.input.value.choices.some((choice) => choice.choiceId === choiceId)) throw new Error("This choice is no longer available.");
  const selected = answer?.kind === "multiple" ? [...answer.choiceIds] : [];
  const otherText = answer?.kind === "multiple" ? answer.otherText : undefined;
  const present = selected.indexOf(choiceId);
  if (present >= 0) return { kind: "multiple", choiceIds: selected.filter((value) => value !== choiceId), ...(otherText === undefined ? {} : { otherText }) };
  const maximum = field.input.value.maximumSelections === 0 ? undefined : field.input.value.maximumSelections;
  const count = selected.length + (otherText === undefined ? 0 : 1);
  if (maximum !== undefined && count >= maximum) return { kind: "multiple", choiceIds: selected, ...(otherText === undefined ? {} : { otherText }) };
  return { kind: "multiple", choiceIds: [...selected, choiceId], ...(otherText === undefined ? {} : { otherText }) };
}

export function setMobileQuestionOther(
  field: QuestionField,
  answer: MobileQuestionAnswerDraft | undefined,
  text: string
): MobileQuestionAnswerDraft {
  validateQuestionFieldDeclaration(field);
  if (field.input.case !== "singleChoice" && field.input.case !== "multipleChoice") throw new Error("This question does not accept free text.");
  if (!field.input.value.allowOther) throw new Error("This question does not allow free text.");
  if (field.input.case === "singleChoice") return { kind: "single", selection: { kind: "other", text } };
  const choiceIds = answer?.kind === "multiple" ? answer.choiceIds : [];
  const maximum = field.input.value.maximumSelections === 0 ? undefined : field.input.value.maximumSelections;
  if (text.trim() === "" || maximum !== undefined && choiceIds.length >= maximum) return { kind: "multiple", choiceIds: [...choiceIds] };
  return { kind: "multiple", choiceIds: [...choiceIds], otherText: text };
}

export function createMobileInteractionResolution(
  interaction: Interaction,
  submission: MobileInteractionSubmission,
  connectionId: string
): InteractionResolution {
  assertCurrentInteraction(interaction);
  if (!connectionId.trim()) throw new Error("A current connection is required to answer this request.");
  if (interaction.request.case === "permission") {
    validatePermissionDeclaration(interaction);
    if (submission.kind !== "permission" || !interaction.request.value.allowedDecisions.includes(submission.decision)
      || !currentPermissionDecisions.has(submission.decision)) {
      throw new Error("This permission decision is not currently available.");
    }
    return create(InteractionResolutionSchema, {
      connectionId,
      decision: { case: "permission", value: create(PermissionResolutionSchema, { decision: submission.decision }) }
    });
  }
  if (interaction.request.case === "planReview") {
    validatePlanDeclaration(interaction);
    if (submission.kind !== "plan" || !interaction.request.value.allowedDecisions.includes(submission.decision)
      || !currentPlanDecisions.has(submission.decision)) {
      throw new Error("This plan decision is not currently available.");
    }
    const feedback = submission.feedback.trim();
    if (submission.decision === PlanReviewDecisionKind.REFINE && feedback === "") {
      throw new Error("Describe what should change before refining the plan.");
    }
    return create(InteractionResolutionSchema, {
      connectionId,
      decision: { case: "planReview", value: create(PlanReviewResolutionSchema, { decision: submission.decision, feedback }) }
    });
  }
  if (interaction.request.case !== "question" || submission.kind !== "question") {
    throw new Error("These answers no longer match the current request.");
  }
  const fields = interaction.request.value.fields;
  validateQuestionDeclaration(fields);
  const declared = new Set(fields.map((field) => field.fieldId));
  if (Object.keys(submission.answers).some((fieldId) => !declared.has(fieldId))) {
    throw new Error("These answers contain a field that is not in the current request.");
  }
  const answers = fields.flatMap((field) => {
    const draft = submission.answers[field.fieldId];
    const invalid = mobileQuestionFieldError(field, draft, "en");
    if (invalid !== undefined) throw new Error(invalid);
    if (draft === undefined) return [];
    if (field.input.case === "text" && draft.kind === "text") {
      return [create(QuestionAnswerSchema, { fieldId: field.fieldId, value: { case: "text", value: draft.value } })];
    }
    if (field.input.case === "boolean" && draft.kind === "boolean") {
      return [create(QuestionAnswerSchema, { fieldId: field.fieldId, value: { case: "boolean", value: draft.value } })];
    }
    if (field.input.case === "singleChoice" && draft.kind === "single") {
      return [create(QuestionAnswerSchema, {
        fieldId: field.fieldId,
        value: { case: "singleChoice", value: create(QuestionSingleChoiceAnswerSchema, {
          selection: draft.selection.kind === "choice"
            ? { case: "choiceId", value: draft.selection.choiceId }
            : { case: "otherText", value: draft.selection.text }
        }) }
      })];
    }
    if (field.input.case === "multipleChoice" && draft.kind === "multiple") {
      return [create(QuestionAnswerSchema, {
        fieldId: field.fieldId,
        value: { case: "multipleChoice", value: create(QuestionMultipleChoiceAnswerSchema, {
          choiceIds: [...draft.choiceIds],
          ...(draft.otherText === undefined ? {} : { otherText: draft.otherText })
        }) }
      })];
    }
    throw new Error(`${field.label || field.fieldId} no longer matches its current field type.`);
  });
  return create(InteractionResolutionSchema, {
    connectionId,
    decision: { case: "question", value: create(QuestionResolutionSchema, { answers }) }
  });
}

export function mobileInteractionTitle(interaction: Interaction, locale: MobileSupportedLocale): string {
  if (interaction.request.case === "permission") return interaction.request.value.title || mobileMessage(locale, "interaction.title.permission");
  if (interaction.request.case === "question") return interaction.request.value.title || interaction.request.value.fields[0]?.label
    || mobileMessage(locale, "interaction.title.question");
  if (interaction.request.case === "planReview") return interaction.request.value.title || mobileMessage(locale, "interaction.title.plan");
  return mobileMessage(locale, "interaction.kind.request");
}

export function mobileInteractionKindLabel(interaction: Interaction, locale: MobileSupportedLocale): string {
  if (interaction.request.case === "permission") return mobileMessage(locale, "interaction.kind.permission");
  if (interaction.request.case === "question") return mobileMessage(locale, "interaction.kind.question");
  if (interaction.request.case === "planReview") return mobileMessage(locale, "interaction.kind.plan");
  return mobileMessage(locale, "interaction.kind.request");
}

export function mobilePermissionRiskLabel(risk: PermissionRisk, locale: MobileSupportedLocale): string {
  if (risk === PermissionRisk.READ_ONLY) return mobileMessage(locale, "interaction.risk.readOnly");
  if (risk === PermissionRisk.LOW) return mobileMessage(locale, "interaction.risk.low");
  if (risk === PermissionRisk.MEDIUM) return mobileMessage(locale, "interaction.risk.medium");
  if (risk === PermissionRisk.HIGH) return mobileMessage(locale, "interaction.risk.high");
  if (risk === PermissionRisk.CRITICAL) return mobileMessage(locale, "interaction.risk.critical");
  return mobileMessage(locale, "interaction.risk.unspecified");
}

export function mobilePermissionDecisionLabel(decision: PermissionDecisionKind, locale: MobileSupportedLocale): string {
  if (decision === PermissionDecisionKind.ALLOW_ONCE) return mobileMessage(locale, "interaction.decision.allowOnce");
  if (decision === PermissionDecisionKind.ALLOW_FOR_TURN) return mobileMessage(locale, "interaction.decision.allowTurn");
  if (decision === PermissionDecisionKind.ALLOW_FOR_SESSION) return mobileMessage(locale, "interaction.decision.allowTask");
  if (decision === PermissionDecisionKind.DENY_ONCE) return mobileMessage(locale, "interaction.decision.deny");
  if (decision === PermissionDecisionKind.DENY_FOR_SESSION) return mobileMessage(locale, "interaction.decision.denyTask");
  if (decision === PermissionDecisionKind.ABORT_RUN) return mobileMessage(locale, "interaction.decision.stop");
  return mobileMessage(locale, "interaction.decision.unavailable");
}

export function mobilePermissionDecisionDanger(decision: PermissionDecisionKind): boolean {
  return decision === PermissionDecisionKind.DENY_FOR_SESSION || decision === PermissionDecisionKind.ABORT_RUN;
}

export function mobilePermissionDecisionNeedsConfirmation(interaction: Interaction, decision: PermissionDecisionKind): boolean {
  if (interaction.request.case !== "permission") return false;
  const allows = decision === PermissionDecisionKind.ALLOW_ONCE
    || decision === PermissionDecisionKind.ALLOW_FOR_TURN
    || decision === PermissionDecisionKind.ALLOW_FOR_SESSION;
  const risk = interaction.request.value.risk;
  return allows && risk !== PermissionRisk.READ_ONLY
    && risk !== PermissionRisk.LOW
    && risk !== PermissionRisk.MEDIUM;
}

export function mobilePlanDecisionLabel(decision: PlanReviewDecisionKind, locale: MobileSupportedLocale): string {
  if (decision === PlanReviewDecisionKind.EXECUTE) return mobileMessage(locale, "interaction.plan.execute");
  if (decision === PlanReviewDecisionKind.STAY_IN_PLAN_MODE) return mobileMessage(locale, "interaction.plan.stay");
  if (decision === PlanReviewDecisionKind.REFINE) return mobileMessage(locale, "interaction.plan.refine");
  return mobileMessage(locale, "interaction.decision.unavailable");
}

export function mobilePlanStepStateLabel(state: PlanStepState, locale: MobileSupportedLocale): string {
  if (state === PlanStepState.IN_PROGRESS) return mobileMessage(locale, "interaction.step.inProgress");
  if (state === PlanStepState.COMPLETED) return mobileMessage(locale, "interaction.step.completed");
  if (state === PlanStepState.SKIPPED) return mobileMessage(locale, "interaction.step.skipped");
  return mobileMessage(locale, "interaction.step.pending");
}

export function mobilePermissionDetails(
  subject: PermissionSubject | undefined,
  locale: MobileSupportedLocale
): readonly MobilePermissionDetail[] {
  if (!subject) return [];
  const kind = subject.kind;
  if (kind.case === "file") return [
    { label: mobileMessage(locale, "interaction.detail.action"), value: fileActionLabel(kind.value.action, locale) },
    { label: mobileMessage(locale, "interaction.detail.workspace"), value: kind.value.workspaceId || mobileMessage(locale, "interaction.detail.currentWorkspace") },
    { label: mobileMessage(locale, "interaction.detail.paths"), value: kind.value.relativePaths.length > 0
      ? kind.value.relativePaths.join("\n") : mobileMessage(locale, "interaction.detail.noPath") },
    ...(kind.value.outsidePrimaryWorkspace ? [{
      label: mobileMessage(locale, "interaction.detail.boundary"),
      value: mobileMessage(locale, "interaction.detail.outsidePrimary")
    }] : [])
  ];
  if (kind.case === "command") return [
    { label: mobileMessage(locale, "interaction.detail.command"), value: [kind.value.executable, ...kind.value.arguments].join(" ").trim()
      || mobileMessage(locale, "interaction.detail.noCommand") },
    { label: mobileMessage(locale, "interaction.detail.workingDirectory"), value: kind.value.workingDirectoryDisplay
      || mobileMessage(locale, "interaction.detail.notSupplied") },
    { label: mobileMessage(locale, "interaction.detail.network"), value: mobileMessage(locale, kind.value.networkAccess
      ? "interaction.detail.requested" : "interaction.detail.notRequested") },
    { label: mobileMessage(locale, "interaction.detail.outsideWorkspace"), value: mobileMessage(locale,
      kind.value.writesOutsideWorkspace ? "interaction.detail.mayWriteOutside" : "common.no") },
    { label: mobileMessage(locale, "interaction.detail.shell"), value: mobileMessage(locale,
      kind.value.usesShell ? "interaction.detail.usesShell" : "interaction.detail.direct") }
  ];
  if (kind.case === "mcp") return [
    { label: mobileMessage(locale, "interaction.detail.mcpServer"), value: kind.value.serverId || mobileMessage(locale, "interaction.detail.notSupplied") },
    { label: mobileMessage(locale, "interaction.detail.tool"), value: kind.value.toolName || mobileMessage(locale, "interaction.detail.notSupplied") },
    ...kind.value.arguments.map((argument) => argumentDetail(argument, locale))
  ];
  if (kind.case === "browser") return [
    { label: mobileMessage(locale, "interaction.detail.action"), value: browserActionLabel(kind.value.action, locale) },
    { label: mobileMessage(locale, "interaction.detail.origin"), value: kind.value.origin || mobileMessage(locale, "interaction.detail.notSupplied") },
    { label: mobileMessage(locale, "interaction.detail.browser"), value: kind.value.browserProviderId || mobileMessage(locale, "interaction.detail.notSupplied") },
    { label: mobileMessage(locale, "interaction.detail.page"), value: kind.value.pageId || mobileMessage(locale, "interaction.detail.notSupplied") }
  ];
  if (kind.case === "customTool") return [
    { label: mobileMessage(locale, "interaction.detail.tool"), value: kind.value.displayName || kind.value.toolId
      || mobileMessage(locale, "interaction.detail.notSupplied") },
    ...kind.value.arguments.map((argument) => argumentDetail(argument, locale))
  ];
  if (kind.case === "resource") return [
    { label: mobileMessage(locale, "interaction.detail.action"), value: resourceActionLabel(kind.value.action, locale) },
    { label: mobileMessage(locale, "interaction.detail.resource"), value: kind.value.resourceId || mobileMessage(locale, "interaction.detail.notSupplied") },
    { label: mobileMessage(locale, "interaction.detail.source"), value: kind.value.sourcePathDisplay || mobileMessage(locale, "interaction.detail.notSupplied") }
  ];
  return [];
}

function supportedRequestCase(interaction: Interaction): boolean {
  return interaction.request.case === "permission" || interaction.request.case === "question" || interaction.request.case === "planReview";
}

function assertCurrentInteraction(interaction: Interaction): void {
  if (interaction.state !== InteractionState.PENDING || !supportedRequestCase(interaction)) {
    throw new Error("This request is no longer pending or does not use a current mobile response type.");
  }
  const revision = interaction.version?.revision?.value ?? 0n;
  if (!interaction.interactionId || !interaction.sessionId || !interaction.backendId || !interaction.targetId
    || interaction.generation < 1n || revision < 1n || interaction.version?.generation !== interaction.generation) {
    throw new Error("This request has no current authority version.");
  }
  if (interaction.request.case === "permission" && interaction.kind !== InteractionKind.PERMISSION
    || interaction.request.case === "question" && interaction.kind !== InteractionKind.QUESTION
    || interaction.request.case === "planReview" && interaction.kind !== InteractionKind.PLAN_REVIEW) {
    throw new Error("This request kind does not match its current payload.");
  }
}

function validatePermissionDeclaration(interaction: Interaction): void {
  assertCurrentInteraction(interaction);
  if (interaction.request.case !== "permission") throw new Error("This is not a permission request.");
  validateAdvertisedDecisions(interaction.request.value.allowedDecisions, currentPermissionDecisions, "permission");
}

function validatePlanDeclaration(interaction: Interaction): void {
  assertCurrentInteraction(interaction);
  if (interaction.request.case !== "planReview") throw new Error("This is not a plan review.");
  validateAdvertisedDecisions(interaction.request.value.allowedDecisions, currentPlanDecisions, "plan");
  const ids = new Set<string>();
  for (const step of interaction.request.value.steps) {
    if (!step.stepId.trim() || ids.has(step.stepId)) throw new Error("This plan contains an invalid or duplicate step.");
    ids.add(step.stepId);
  }
}

function validateAdvertisedDecisions(values: readonly number[], current: ReadonlySet<number>, label: string): void {
  if (values.length === 0 || new Set(values).size !== values.length || values.some((value) => !current.has(value))) {
    throw new Error(`This ${label} request does not advertise a current decision set.`);
  }
}

function validateQuestionDeclaration(fields: readonly QuestionField[]): void {
  if (fields.length === 0) throw new Error("This question has no current fields.");
  const ids = new Set<string>();
  for (const field of fields) {
    if (!field.fieldId.trim() || ids.has(field.fieldId)) throw new Error("This question has an invalid or duplicate field.");
    ids.add(field.fieldId);
    validateQuestionFieldDeclaration(field);
  }
}

function validateQuestionFieldDeclaration(field: QuestionField): void {
  const input = field.input;
  if (input.case === "text" || input.case === "boolean") return;
  if (input.case !== "singleChoice" && input.case !== "multipleChoice") {
    throw new Error("This question has a field without a current input type.");
  }
  if (typeof input.value.allowOther !== "boolean") throw new Error("Question choices require explicit free-text authority.");
  const choices = new Set<string>();
  for (const choice of input.value.choices) {
    if (!choice.choiceId.trim() || choices.has(choice.choiceId)) throw new Error("This question has an invalid or duplicate choice.");
    choices.add(choice.choiceId);
  }
  if (choices.size === 0) throw new Error("This question has no selectable choices.");
  if (input.case === "singleChoice") {
    if (input.value.defaultChoiceId && !choices.has(input.value.defaultChoiceId)) throw new Error("This question has an invalid default choice.");
    return;
  }
  const defaults = input.value.defaultChoiceIds;
  const minimum = Math.max(field.required ? 1 : 0, input.value.minimumSelections);
  const maximum = input.value.maximumSelections === 0 ? undefined : input.value.maximumSelections;
  const capacity = choices.size + (input.value.allowOther ? 1 : 0);
  if (!Number.isSafeInteger(input.value.minimumSelections) || input.value.minimumSelections < 0
    || minimum > capacity || new Set(defaults).size !== defaults.length
    || defaults.some((choiceId) => !choices.has(choiceId))
    || maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum < minimum || maximum > capacity || defaults.length > maximum)) {
    throw new Error("This question has invalid multiple-choice bounds or defaults.");
  }
}

function defaultQuestionAnswer(field: QuestionField): MobileQuestionAnswerDraft | undefined {
  const input = field.input;
  if (input.case === "text") return { kind: "text", value: input.value.defaultValue };
  if (input.case === "boolean") return { kind: "boolean", value: input.value.defaultValue };
  if (input.case === "singleChoice") return input.value.defaultChoiceId
    ? { kind: "single", selection: { kind: "choice", choiceId: input.value.defaultChoiceId } }
    : undefined;
  if (input.case === "multipleChoice") return { kind: "multiple", choiceIds: [...input.value.defaultChoiceIds] };
  return undefined;
}

function interactionPriority(interaction: Interaction): number {
  if (interaction.request.case === "planReview") return 0;
  if (interaction.request.case === "permission") return 1;
  if (interaction.request.case === "question") return 2;
  return 3;
}

function compareTimestamp(left: Interaction, right: Interaction): number {
  const leftSeconds = left.createdAt?.seconds ?? 0n;
  const rightSeconds = right.createdAt?.seconds ?? 0n;
  if (leftSeconds !== rightSeconds) return leftSeconds < rightSeconds ? -1 : 1;
  return (left.createdAt?.nanos ?? 0) - (right.createdAt?.nanos ?? 0);
}

function argumentDetail(argument: DisplayArgument, locale: MobileSupportedLocale): MobilePermissionDetail {
  const label = argument.fieldPath || mobileMessage(locale, "interaction.detail.argument");
  if (argument.redacted) return {
    label,
    value: argument.redactedPlaceholder || mobileMessage(locale, "interaction.detail.redacted"),
    redacted: true
  };
  const value = argument.value;
  if (value.case === "text") return { label, value: value.value };
  if (value.case === "number") return { label, value: String(value.value) };
  if (value.case === "integer") return { label, value: value.value.toString(10) };
  if (value.case === "boolean") return { label, value: value.value ? "true" : "false" };
  if (value.case === "blob") return { label, value: value.value.fileName || mobileMessage(locale, "interaction.detail.blobBytes", {
    name: value.value.mediaType || mobileMessage(locale, "interaction.detail.blob"),
    bytes: value.value.byteSize.toString(10)
  }) };
  if (value.case === "null") return { label, value: "null" };
  if (value.case === "composite") return {
    label,
    value: mobileMessage(locale, "interaction.detail.composite", {
      kind: mobileMessage(locale, value.value.kind === CompositeArgumentKind.ARRAY
        ? "interaction.detail.array" : "interaction.detail.object"),
      count: value.value.childCount
    })
  };
  return { label, value: mobileMessage(locale, "interaction.detail.notSupplied") };
}

function fileActionLabel(value: FilePermissionAction, locale: MobileSupportedLocale): string {
  if (value === FilePermissionAction.READ) return mobileMessage(locale, "interaction.action.read");
  if (value === FilePermissionAction.CREATE) return mobileMessage(locale, "interaction.action.create");
  if (value === FilePermissionAction.UPDATE) return mobileMessage(locale, "interaction.action.update");
  if (value === FilePermissionAction.DELETE) return mobileMessage(locale, "interaction.action.delete");
  if (value === FilePermissionAction.MOVE) return mobileMessage(locale, "interaction.action.move");
  return mobileMessage(locale, "interaction.action.unspecified");
}

function browserActionLabel(value: BrowserPermissionAction, locale: MobileSupportedLocale): string {
  if (value === BrowserPermissionAction.READ_PAGE) return mobileMessage(locale, "interaction.action.readPage");
  if (value === BrowserPermissionAction.NAVIGATE) return mobileMessage(locale, "interaction.action.navigate");
  if (value === BrowserPermissionAction.INTERACT) return mobileMessage(locale, "interaction.action.interact");
  if (value === BrowserPermissionAction.UPLOAD) return mobileMessage(locale, "interaction.action.upload");
  if (value === BrowserPermissionAction.DOWNLOAD) return mobileMessage(locale, "interaction.action.download");
  if (value === BrowserPermissionAction.TAKE_OVER) return mobileMessage(locale, "interaction.action.takeOver");
  return mobileMessage(locale, "interaction.action.unspecified");
}

function resourceActionLabel(value: ResourcePermissionAction, locale: MobileSupportedLocale): string {
  if (value === ResourcePermissionAction.APPROVE) return mobileMessage(locale, "interaction.action.approve");
  if (value === ResourcePermissionAction.INSTALL) return mobileMessage(locale, "interaction.action.install");
  if (value === ResourcePermissionAction.UPDATE) return mobileMessage(locale, "interaction.action.update");
  if (value === ResourcePermissionAction.ENABLE) return mobileMessage(locale, "interaction.action.enable");
  return mobileMessage(locale, "interaction.action.unspecified");
}
