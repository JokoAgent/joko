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

export function mobileQuestionFieldError(field: QuestionField, answer: MobileQuestionAnswerDraft | undefined): string | undefined {
  validateQuestionFieldDeclaration(field);
  const label = field.label || field.fieldId;
  if (answer === undefined) return field.required ? `${label} is required.` : undefined;
  if (field.input.case === "text") {
    if (answer.kind !== "text") return `${label} requires text.`;
    return field.required && answer.value.trim() === "" ? `${label} is required.` : undefined;
  }
  if (field.input.case === "boolean") return answer.kind === "boolean" ? undefined : `${label} requires yes or no.`;
  if (field.input.case === "singleChoice") {
    if (answer.kind !== "single") return `${label} requires one choice.`;
    if (answer.selection.kind === "choice") {
      const choiceId = answer.selection.choiceId;
      return field.input.value.choices.some((choice) => choice.choiceId === choiceId)
        ? undefined
        : `${label} contains a choice that is no longer available.`;
    }
    return field.input.value.allowOther && answer.selection.text.trim() !== ""
      ? undefined
      : `${label} requires allowed free text.`;
  }
  if (field.input.case !== "multipleChoice" || answer.kind !== "multiple") return `${label} requires a list of choices.`;
  const ids = new Set(field.input.value.choices.map((choice) => choice.choiceId));
  if (new Set(answer.choiceIds).size !== answer.choiceIds.length || answer.choiceIds.some((choiceId) => !ids.has(choiceId))) {
    return `${label} contains a choice that is no longer available.`;
  }
  if (answer.otherText !== undefined && (!field.input.value.allowOther || answer.otherText.trim() === "")) {
    return `${label} contains free text that is not allowed.`;
  }
  const count = answer.choiceIds.length + (answer.otherText === undefined ? 0 : 1);
  const minimum = Math.max(field.required ? 1 : 0, field.input.value.minimumSelections);
  const maximum = field.input.value.maximumSelections === 0 ? undefined : field.input.value.maximumSelections;
  if (count < minimum) return `${label} requires at least ${minimum} selection${minimum === 1 ? "" : "s"}.`;
  if (maximum !== undefined && count > maximum) return `${label} allows at most ${maximum} selection${maximum === 1 ? "" : "s"}.`;
  return undefined;
}

export function mobileQuestionCanSubmit(interaction: Interaction, answers: MobileQuestionAnswers): boolean {
  if (interaction.request.case !== "question") return false;
  try {
    validateQuestionDeclaration(interaction.request.value.fields);
    const fieldIds = new Set(interaction.request.value.fields.map((field) => field.fieldId));
    if (Object.keys(answers).some((fieldId) => !fieldIds.has(fieldId))) return false;
    return interaction.request.value.fields.every((field) => mobileQuestionFieldError(field, answers[field.fieldId]) === undefined);
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
    const invalid = mobileQuestionFieldError(field, draft);
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

export function mobileInteractionTitle(interaction: Interaction): string {
  if (interaction.request.case === "permission") return interaction.request.value.title || "Permission required";
  if (interaction.request.case === "question") return interaction.request.value.title || interaction.request.value.fields[0]?.label || "Question";
  if (interaction.request.case === "planReview") return interaction.request.value.title || "Review plan";
  return "Request";
}

export function mobileInteractionKindLabel(interaction: Interaction): string {
  if (interaction.request.case === "permission") return "Permission";
  if (interaction.request.case === "question") return "Question";
  if (interaction.request.case === "planReview") return "Plan review";
  return "Request";
}

export function mobilePermissionRiskLabel(risk: PermissionRisk): string {
  if (risk === PermissionRisk.READ_ONLY) return "Read only";
  if (risk === PermissionRisk.LOW) return "Low risk";
  if (risk === PermissionRisk.MEDIUM) return "Medium risk";
  if (risk === PermissionRisk.HIGH) return "High risk";
  if (risk === PermissionRisk.CRITICAL) return "Critical risk";
  return "Unspecified risk";
}

export function mobilePermissionDecisionLabel(decision: PermissionDecisionKind): string {
  if (decision === PermissionDecisionKind.ALLOW_ONCE) return "Allow once";
  if (decision === PermissionDecisionKind.ALLOW_FOR_TURN) return "Allow for this turn";
  if (decision === PermissionDecisionKind.ALLOW_FOR_SESSION) return "Allow for this task";
  if (decision === PermissionDecisionKind.DENY_ONCE) return "Deny";
  if (decision === PermissionDecisionKind.DENY_FOR_SESSION) return "Deny for this task";
  if (decision === PermissionDecisionKind.ABORT_RUN) return "Stop task";
  return "Unavailable decision";
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

export function mobilePlanDecisionLabel(decision: PlanReviewDecisionKind): string {
  if (decision === PlanReviewDecisionKind.EXECUTE) return "Execute plan";
  if (decision === PlanReviewDecisionKind.STAY_IN_PLAN_MODE) return "Stay in plan mode";
  if (decision === PlanReviewDecisionKind.REFINE) return "Refine plan";
  return "Unavailable decision";
}

export function mobilePlanStepStateLabel(state: PlanStepState): string {
  if (state === PlanStepState.IN_PROGRESS) return "In progress";
  if (state === PlanStepState.COMPLETED) return "Completed";
  if (state === PlanStepState.SKIPPED) return "Skipped";
  return "Pending";
}

export function mobilePermissionDetails(subject: PermissionSubject | undefined): readonly MobilePermissionDetail[] {
  if (!subject) return [];
  const kind = subject.kind;
  if (kind.case === "file") return [
    { label: "Action", value: fileActionLabel(kind.value.action) },
    { label: "Workspace", value: kind.value.workspaceId || "Current workspace" },
    { label: "Paths", value: kind.value.relativePaths.length > 0 ? kind.value.relativePaths.join("\n") : "No path supplied" },
    ...(kind.value.outsidePrimaryWorkspace ? [{ label: "Boundary", value: "Outside the primary workspace" }] : [])
  ];
  if (kind.case === "command") return [
    { label: "Command", value: [kind.value.executable, ...kind.value.arguments].join(" ").trim() || "No command supplied" },
    { label: "Working directory", value: kind.value.workingDirectoryDisplay || "Not supplied" },
    { label: "Network", value: kind.value.networkAccess ? "Requested" : "Not requested" },
    { label: "Outside workspace", value: kind.value.writesOutsideWorkspace ? "May write outside" : "No" },
    { label: "Shell", value: kind.value.usesShell ? "Uses a shell" : "Direct execution" }
  ];
  if (kind.case === "mcp") return [
    { label: "MCP server", value: kind.value.serverId || "Not supplied" },
    { label: "Tool", value: kind.value.toolName || "Not supplied" },
    ...kind.value.arguments.map(argumentDetail)
  ];
  if (kind.case === "browser") return [
    { label: "Action", value: browserActionLabel(kind.value.action) },
    { label: "Origin", value: kind.value.origin || "Not supplied" },
    { label: "Browser", value: kind.value.browserProviderId || "Not supplied" },
    { label: "Page", value: kind.value.pageId || "Not supplied" }
  ];
  if (kind.case === "customTool") return [
    { label: "Tool", value: kind.value.displayName || kind.value.toolId || "Not supplied" },
    ...kind.value.arguments.map(argumentDetail)
  ];
  if (kind.case === "resource") return [
    { label: "Action", value: resourceActionLabel(kind.value.action) },
    { label: "Resource", value: kind.value.resourceId || "Not supplied" },
    { label: "Source", value: kind.value.sourcePathDisplay || "Not supplied" }
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

function argumentDetail(argument: DisplayArgument): MobilePermissionDetail {
  const label = argument.fieldPath || "Argument";
  if (argument.redacted) return { label, value: argument.redactedPlaceholder || "Redacted", redacted: true };
  const value = argument.value;
  if (value.case === "text") return { label, value: value.value };
  if (value.case === "number") return { label, value: String(value.value) };
  if (value.case === "integer") return { label, value: value.value.toString(10) };
  if (value.case === "boolean") return { label, value: value.value ? "true" : "false" };
  if (value.case === "blob") return { label, value: value.value.fileName || `${value.value.mediaType || "Blob"} (${value.value.byteSize.toString(10)} bytes)` };
  if (value.case === "null") return { label, value: "null" };
  if (value.case === "composite") return {
    label,
    value: `${value.value.kind === CompositeArgumentKind.ARRAY ? "Array" : "Object"} (${value.value.childCount} item${value.value.childCount === 1 ? "" : "s"})`
  };
  return { label, value: "Not supplied" };
}

function fileActionLabel(value: FilePermissionAction): string {
  if (value === FilePermissionAction.READ) return "Read";
  if (value === FilePermissionAction.CREATE) return "Create";
  if (value === FilePermissionAction.UPDATE) return "Update";
  if (value === FilePermissionAction.DELETE) return "Delete";
  if (value === FilePermissionAction.MOVE) return "Move";
  return "Unspecified";
}

function browserActionLabel(value: BrowserPermissionAction): string {
  if (value === BrowserPermissionAction.READ_PAGE) return "Read page";
  if (value === BrowserPermissionAction.NAVIGATE) return "Navigate";
  if (value === BrowserPermissionAction.INTERACT) return "Interact";
  if (value === BrowserPermissionAction.UPLOAD) return "Upload";
  if (value === BrowserPermissionAction.DOWNLOAD) return "Download";
  if (value === BrowserPermissionAction.TAKE_OVER) return "Take over";
  return "Unspecified";
}

function resourceActionLabel(value: ResourcePermissionAction): string {
  if (value === ResourcePermissionAction.APPROVE) return "Approve";
  if (value === ResourcePermissionAction.INSTALL) return "Install";
  if (value === ResourcePermissionAction.UPDATE) return "Update";
  if (value === ResourcePermissionAction.ENABLE) return "Enable";
  return "Unspecified";
}
