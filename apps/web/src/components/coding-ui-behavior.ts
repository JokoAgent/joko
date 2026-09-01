import type {
  ErrorRecoveryActionView,
  ErrorView,
  PermissionMode,
  QuestionAnswerDraft,
  QuestionFieldView
} from "../model.js";

export function nextPermissionMode(current: PermissionMode, options: readonly PermissionMode[]): PermissionMode | null {
  const unique = options.filter((mode, index) => options.indexOf(mode) === index);
  if (unique.length < 2) return null;
  const currentIndex = unique.indexOf(current);
  return unique[currentIndex < 0 ? 0 : (currentIndex + 1) % unique.length] ?? null;
}

export interface FuzzyTextMatch {
  readonly score: number;
  readonly ranges: readonly { readonly start: number; readonly end: number }[];
}

/** A deterministic subsequence matcher with strong exact/prefix/word-boundary bonuses. */
export function fuzzyTextMatch(value: string, rawQuery: string): FuzzyTextMatch | null {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (query === "") return { score: 0, ranges: [] };
  const candidate = value.toLocaleLowerCase();
  const exactIndex = candidate.indexOf(query);
  if (exactIndex >= 0) {
    const boundary = exactIndex === 0 || /[\s/_\-.]/.test(candidate[exactIndex - 1] ?? "");
    return {
      score: 10_000 + (exactIndex === 0 ? 2_000 : boundary ? 1_000 : 0) - exactIndex - Math.max(0, value.length - query.length),
      ranges: [{ start: exactIndex, end: exactIndex + query.length }]
    };
  }

  const indexes: number[] = [];
  let cursor = 0;
  for (const character of query) {
    const index = candidate.indexOf(character, cursor);
    if (index < 0) return null;
    indexes.push(index);
    cursor = index + 1;
  }
  let score = 1_000 - indexes[0]! * 4 - Math.max(0, value.length - query.length);
  for (let index = 0; index < indexes.length; index += 1) {
    const at = indexes[index]!;
    const previous = indexes[index - 1];
    if (at === 0 || /[\s/_\-.]/.test(candidate[at - 1] ?? "")) score += 90;
    if (previous !== undefined) score += at === previous + 1 ? 120 : -Math.min(80, (at - previous - 1) * 8);
  }
  return { score, ranges: contiguousRanges(indexes) };
}

export interface SidebarFuzzyMatch {
  readonly score: number;
  readonly nameRanges: FuzzyTextMatch["ranges"];
  readonly targetRanges: FuzzyTextMatch["ranges"];
}

export function fuzzySidebarMatch(name: string, targetName: string, query: string): SidebarFuzzyMatch | null {
  const nameMatch = fuzzyTextMatch(name, query);
  const targetMatch = fuzzyTextMatch(targetName, query);
  if (nameMatch === null && targetMatch === null) return null;
  return {
    score: Math.max(nameMatch?.score ?? Number.NEGATIVE_INFINITY, (targetMatch?.score ?? Number.NEGATIVE_INFINITY) - 160),
    nameRanges: nameMatch?.ranges ?? [],
    targetRanges: targetMatch?.ranges ?? []
  };
}

function contiguousRanges(indexes: readonly number[]): FuzzyTextMatch["ranges"] {
  const ranges: { start: number; end: number }[] = [];
  for (const index of indexes) {
    const previous = ranges.at(-1);
    if (previous !== undefined && previous.end === index) previous.end += 1;
    else ranges.push({ start: index, end: index + 1 });
  }
  return ranges;
}

export type QuestionAnswerMap = Readonly<Record<string, QuestionAnswerDraft>>;
export type QuestionOtherTextMap = Readonly<Record<string, string>>;

export type QuestionWizardKeyIntent =
  | { readonly kind: "choice"; readonly index: number }
  | { readonly kind: "other" }
  | { readonly kind: "advance" }
  | { readonly kind: "skip" }
  | { readonly kind: "minimize" }
  | null;

export interface QuestionWizardKeyInput {
  readonly key: string;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly editableTarget: boolean;
}

export function resolveQuestionWizardKey(
  input: QuestionWizardKeyInput,
  context: { readonly kind: QuestionFieldView["kind"]; readonly optionCount: number; readonly required: boolean; readonly currentValid: boolean }
): QuestionWizardKeyIntent {
  if (input.repeat || input.isComposing || input.metaKey || input.ctrlKey || input.altKey || input.shiftKey) return null;
  if (input.editableTarget) return null;
  if (input.key === "Escape") return context.required ? { kind: "minimize" } : { kind: "skip" };
  if ((context.kind === "single" || context.kind === "multiple") && /^[1-9]$/.test(input.key)) {
    const index = Number(input.key) - 1;
    if (index < context.optionCount) return { kind: "choice", index };
    if (index === context.optionCount) return { kind: "other" };
  }
  if (input.key === "Enter" && context.currentValid) return { kind: "advance" };
  return null;
}

export interface QuestionWizardDraft {
  readonly answers: QuestionAnswerMap;
  readonly otherText: QuestionOtherTextMap;
  readonly currentIndex: number;
  readonly minimized: boolean;
}

export class QuestionWizardDraftStore {
  readonly #drafts = new Map<string, QuestionWizardDraft>();

  read(sessionId: string, interactionId: string): QuestionWizardDraft | undefined {
    const draft = this.#drafts.get(questionDraftKey(sessionId, interactionId));
    return draft === undefined ? undefined : { ...draft, answers: { ...draft.answers }, otherText: { ...draft.otherText } };
  }

  write(sessionId: string, interactionId: string, draft: QuestionWizardDraft): void {
    this.#drafts.set(questionDraftKey(sessionId, interactionId), { ...draft, answers: { ...draft.answers }, otherText: { ...draft.otherText } });
  }

  delete(sessionId: string, interactionId: string): void {
    this.#drafts.delete(questionDraftKey(sessionId, interactionId));
  }
}

function questionDraftKey(sessionId: string, interactionId: string): string {
  return `${sessionId}\u0000${interactionId}`;
}

export function initialQuestionAnswers(fields: readonly QuestionFieldView[]): QuestionAnswerMap {
  return Object.fromEntries(fields.flatMap((field) => field.defaultValue === undefined ? [] : [[field.id, field.defaultValue]]));
}

export function validQuestionAnswer(field: QuestionFieldView, answer: QuestionAnswerDraft | undefined): boolean {
  if (answer === undefined) return !field.required;
  if (field.kind === "text") return typeof answer === "string" && (!field.required || answer.trim().length > 0);
  if (field.kind === "boolean") return typeof answer === "boolean";
  if (field.kind === "single") return typeof answer === "string" && (!field.required || answer.trim().length > 0);
  if (!Array.isArray(answer) || answer.some((value) => typeof value !== "string" || value.trim().length === 0) || new Set(answer).size !== answer.length) return false;
  const optionIds = new Set(field.options.map((option) => option.id));
  if (answer.filter((value) => !optionIds.has(value)).length > 1) return false;
  const minimum = Math.max(field.required ? 1 : 0, field.minimumSelections);
  return answer.length >= minimum && (field.maximumSelections === undefined || answer.length <= field.maximumSelections);
}

/**
 * True only when the current step contains a meaningful answer. Optionality is
 * handled by the wizard's explicit Skip action, so an empty optional field must
 * not make Next/Submit look enabled.
 */
export function hasQuestionAnswer(field: QuestionFieldView, answer: QuestionAnswerDraft | undefined): boolean {
  return validQuestionAnswer({ ...field, required: true }, answer);
}

export function questionOtherAnswer(field: QuestionFieldView, answer: QuestionAnswerDraft | undefined): string {
  const optionIds = new Set(field.options.map((option) => option.id));
  if (field.kind === "single") return typeof answer === "string" && !optionIds.has(answer) ? answer : "";
  if (field.kind !== "multiple" || !Array.isArray(answer)) return "";
  return answer.find((value) => !optionIds.has(value)) ?? "";
}

export function replaceQuestionOtherAnswer(field: QuestionFieldView, answer: QuestionAnswerDraft | undefined, rawText: string): QuestionAnswerDraft {
  const text = rawText.trim();
  if (field.kind === "single") return text;
  if (field.kind !== "multiple") return answer ?? "";
  const optionIds = new Set(field.options.map((option) => option.id));
  const selected = (Array.isArray(answer) ? answer : []).filter((value) => optionIds.has(value));
  if (text === "" || (field.maximumSelections !== undefined && selected.length >= field.maximumSelections)) return selected;
  return [...selected, text];
}

export function toggleQuestionOptionAnswer(field: QuestionFieldView, answer: QuestionAnswerDraft | undefined, optionId: string): QuestionAnswerDraft {
  if (field.kind === "single") return optionId;
  if (field.kind !== "multiple") return answer ?? "";
  const selected = Array.isArray(answer) ? [...answer] : [];
  const index = selected.indexOf(optionId);
  if (index >= 0) return selected.filter((value) => value !== optionId);
  if (field.maximumSelections !== undefined && selected.length >= field.maximumSelections) return selected;
  return [...selected, optionId];
}

export function clampQuestionStep(step: number, fieldCount: number): number {
  return Math.max(0, Math.min(Math.max(0, fieldCount - 1), Number.isFinite(step) ? Math.trunc(step) : 0));
}

export type ExecutableRecoveryKind = "wait" | "retry" | "resnapshot" | "openSession" | "openDiagnostics" | "reauthenticate" | "contactOwner" | "abort";
export type SettingsRecoveryKind = Extract<ExecutableRecoveryKind, "openDiagnostics" | "reauthenticate" | "contactOwner">;

export function recoverySettingsHash(kind: SettingsRecoveryKind): "#/settings/about/diagnostics" | "#/settings/providers" | "#/settings/connections" {
  if (kind === "openDiagnostics") return "#/settings/about/diagnostics";
  if (kind === "reauthenticate") return "#/settings/providers";
  return "#/settings/connections";
}

export interface RecoveryActionContext {
  readonly retryRunId?: string;
  readonly activeRunId?: string;
  readonly canAbort: boolean;
  readonly canRefresh: boolean;
  readonly canContactOwner: boolean;
  readonly sessionAvailable: boolean;
}

export interface ExecutableRecoveryAction extends ErrorRecoveryActionView {
  readonly kind: ExecutableRecoveryKind;
}

/**
 * Converts typed protocol recovery into buttons the current UI can actually execute.
 * Stable error-code inference only fills a missing retry/resnapshot/open-session action.
 */
export function executableRecoveryActions(error: ErrorView, context: RecoveryActionContext): readonly ExecutableRecoveryAction[] {
  const candidates: ErrorRecoveryActionView[] = error.recovery.map((action) => action.kind === "resolveInteraction" ? { ...action, kind: "openSession" } : action);
  const code = error.code.toLocaleUpperCase();
  if (error.retryable && !candidates.some((action) => action.kind === "retry")) {
    candidates.push({ id: "inferred:retry", kind: "retry", label: "" });
  }
  if (/SNAPSHOT|EVENT_GAP|STALE_(GENERATION|CURSOR)|RESNAPSHOT/.test(code) && !candidates.some((action) => action.kind === "resnapshot")) {
    candidates.push({ id: "inferred:resnapshot", kind: "resnapshot", label: "" });
  }
  if (/SESSION_(NOT_FOUND|MISSING|UNAVAILABLE)|NATIVE_SESSION/.test(code) && !candidates.some((action) => action.kind === "openSession")) {
    candidates.push({ id: "inferred:open-session", kind: "openSession", label: "" });
  }
  return candidates.filter((action): action is ExecutableRecoveryAction => {
    if (action.kind === "wait") return context.canRefresh;
    if (action.kind === "retry") return error.runId !== undefined && error.runId === context.retryRunId;
    if (action.kind === "resnapshot") return context.canRefresh;
    if (action.kind === "openSession") return context.sessionAvailable;
    if (action.kind === "openDiagnostics" || action.kind === "reauthenticate") return true;
    if (action.kind === "contactOwner") return context.canContactOwner;
    if (action.kind === "abort") return context.canAbort && error.runId !== undefined && error.runId === context.activeRunId;
    return false;
  });
}

export const MINIMUM_RECOVERY_WAIT_MS = 250;
export const MAXIMUM_RECOVERY_WAIT_MS = 30_000;
export const DEFAULT_RECOVERY_WAIT_MS = 1_000;

export function boundedRecoveryWaitMs(retryAfterMs: number | undefined): number {
  const value = retryAfterMs === undefined || !Number.isFinite(retryAfterMs) ? DEFAULT_RECOVERY_WAIT_MS : Math.round(retryAfterMs);
  return Math.min(MAXIMUM_RECOVERY_WAIT_MS, Math.max(MINIMUM_RECOVERY_WAIT_MS, value));
}

/** Resolves false on cancellation so unmounts do not surface a synthetic async error. */
export function waitForRecoveryDelay(retryAfterMs: number | undefined, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted === true) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (ready: boolean): void => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(ready);
    };
    const abort = (): void => finish(false);
    const timer = globalThis.setTimeout(() => finish(true), boundedRecoveryWaitMs(retryAfterMs));
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export class RecoveryActionSingleFlight {
  readonly #active = new Set<string>();

  run(key: string, action: () => Promise<void>): Promise<void> | undefined {
    if (this.#active.has(key)) return undefined;
    this.#active.add(key);
    return Promise.resolve().then(action).finally(() => this.#active.delete(key));
  }

  isActive(key: string): boolean {
    return this.#active.has(key);
  }
}
