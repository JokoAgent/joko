import { describe, expect, it, vi } from "vitest";
import type { ErrorView, QuestionFieldView } from "../model.js";
import {
  QuestionWizardDraftStore,
  RecoveryActionSingleFlight,
  boundedRecoveryWaitMs,
  clampQuestionStep,
  executableRecoveryActions,
  fuzzySidebarMatch,
  fuzzyTextMatch,
  hasQuestionAnswer,
  initialQuestionAnswers,
  nextPermissionMode,
  questionOtherAnswer,
  recoverySettingsHash,
  replaceQuestionOtherAnswer,
  resolveQuestionWizardKey,
  toggleQuestionOptionAnswer,
  validQuestionAnswer,
  waitForRecoveryDelay
} from "./coding-ui-behavior.js";

describe("permission mode cycle", () => {
  it("cycles a missing current permission to the first unique option", () => {
    expect(nextPermissionMode("bypassPermissions", ["ask", "auto", "ask"])).toBe("ask");
    expect(nextPermissionMode("ask", ["ask"])).toBeNull();
  });
});

describe("fuzzy sidebar search", () => {
  it("scores exact and prefix matches above sparse subsequences", () => {
    const prefix = fuzzyTextMatch("Context cleanup", "con");
    const sparse = fuzzyTextMatch("Coding session", "con");
    expect(prefix).not.toBeNull();
    expect(sparse).not.toBeNull();
    expect(prefix!.score).toBeGreaterThan(sparse!.score);
  });

  it("returns contiguous highlight ranges without highlighting unmatched gaps", () => {
    expect(fuzzyTextMatch("Context", "ct")?.ranges).toEqual([{ start: 0, end: 1 }, { start: 3, end: 4 }]);
    expect(fuzzyTextMatch("Context", "zz")).toBeNull();
  });

  it("matches project names but gives task names a ranking bonus", () => {
    const inName = fuzzySidebarMatch("Payments", "Backend", "pay");
    const inTarget = fuzzySidebarMatch("Refactor", "Payments", "pay");
    expect(inName).not.toBeNull();
    expect(inTarget).not.toBeNull();
    expect(inName!.score).toBeGreaterThan(inTarget!.score);
    expect(inTarget!.targetRanges).toEqual([{ start: 0, end: 3 }]);
  });
});

const textField = field({ id: "text", kind: "text", required: true });
const singleField = field({ id: "single", kind: "single", required: true, allowOther: true, options: [{ id: "one", label: "One" }] });
const multipleField = field({ id: "multiple", kind: "multiple", required: true, allowOther: true, options: [{ id: "one", label: "One" }, { id: "two", label: "Two" }, { id: "three", label: "Three" }], minimumSelections: 2, maximumSelections: 2 });
const booleanField = field({ id: "boolean", kind: "boolean", required: true });
const textAnswer = (value: string) => ({ kind: "text", value } as const);
const choiceAnswer = (choiceId: string) => ({ kind: "single", selection: { kind: "choice", choiceId } } as const);
const otherAnswer = (text: string) => ({ kind: "single", selection: { kind: "other", text } } as const);
const multipleAnswer = (choiceIds: readonly string[], otherText?: string) => ({
  kind: "multiple",
  choiceIds,
  ...(otherText === undefined ? {} : { otherText })
} as const);
const booleanAnswer = (value: boolean) => ({ kind: "boolean", value } as const);

describe("typed question wizard", () => {
  it("validates text, single, multiple min/max, and boolean answers", () => {
    expect(validQuestionAnswer(textField, textAnswer("  "))).toBe(false);
    expect(validQuestionAnswer(textField, textAnswer("answer"))).toBe(true);
    expect(validQuestionAnswer(singleField, otherAnswer(" "))).toBe(false);
    expect(validQuestionAnswer(singleField, otherAnswer("custom answer"))).toBe(true);
    expect(validQuestionAnswer(singleField, choiceAnswer("one"))).toBe(true);
    expect(validQuestionAnswer(multipleField, multipleAnswer(["one"]))).toBe(false);
    expect(validQuestionAnswer(multipleField, multipleAnswer(["one", "two"]))).toBe(true);
    expect(validQuestionAnswer(multipleField, multipleAnswer(["one", "two", "three"]))).toBe(false);
    expect(validQuestionAnswer(booleanField, undefined)).toBe(false);
    expect(validQuestionAnswer(booleanField, booleanAnswer(false))).toBe(true);
  });

  it("keeps empty optional answers behind the explicit Skip action", () => {
    const optionalText = field({ id: "optional-text", kind: "text", required: false });
    const optionalMultiple = field({ id: "optional-multiple", kind: "multiple", required: false, allowOther: true });
    expect(validQuestionAnswer(optionalText, undefined)).toBe(true);
    expect(hasQuestionAnswer(optionalText, undefined)).toBe(false);
    expect(hasQuestionAnswer(optionalText, textAnswer("   "))).toBe(false);
    expect(hasQuestionAnswer(optionalText, textAnswer("answer"))).toBe(true);
    expect(hasQuestionAnswer(optionalMultiple, multipleAnswer([]))).toBe(false);
    expect(hasQuestionAnswer(optionalMultiple, multipleAnswer([], "custom answer"))).toBe(true);
  });

  it("hydrates defaults and clamps restored steps", () => {
    const fields = [field({ id: "default", kind: "text", defaultValue: "saved" }), booleanField];
    expect(initialQuestionAnswers(fields)).toEqual({ default: textAnswer("saved") });
    expect(clampQuestionStep(99, fields.length)).toBe(1);
    expect(clampQuestionStep(-2, fields.length)).toBe(0);
    expect(clampQuestionStep(4, 0)).toBe(0);
  });

  it("keeps drafts isolated by both session and interaction", () => {
    const store = new QuestionWizardDraftStore();
    store.write("session-a", "question-1", { answers: { single: otherAnswer("Custom A") }, otherText: { single: "Custom A in progress" }, currentIndex: 2, minimized: true });
    store.write("session-b", "question-1", { answers: { single: otherAnswer("Custom B") }, otherText: { single: "Custom B in progress" }, currentIndex: 0, minimized: false });
    expect(store.read("session-a", "question-1")).toEqual({ answers: { single: otherAnswer("Custom A") }, otherText: { single: "Custom A in progress" }, currentIndex: 2, minimized: true });
    expect(store.read("session-b", "question-1")?.answers).toEqual({ single: otherAnswer("Custom B") });
    expect(store.read("session-b", "question-1")?.otherText).toEqual({ single: "Custom B in progress" });
    expect(store.read("session-a", "question-2")).toBeUndefined();
    store.delete("session-a", "question-1");
    expect(store.read("session-a", "question-1")).toBeUndefined();
    expect(store.read("session-b", "question-1")).toBeDefined();
  });

  it("keeps raw Other text typed for single and multiple answers without inventing an option id", () => {
    expect(replaceQuestionOtherAnswer(singleField, choiceAnswer("one"), "  handmade  ")).toEqual(otherAnswer("handmade"));
    expect(questionOtherAnswer(singleField, otherAnswer("handmade"))).toBe("handmade");
    expect(questionOtherAnswer(singleField, choiceAnswer("one"))).toBe("");

    const withOther = replaceQuestionOtherAnswer(multipleField, multipleAnswer(["one"]), "handmade");
    expect(withOther).toEqual(multipleAnswer(["one"], "handmade"));
    expect(questionOtherAnswer(multipleField, withOther)).toBe("handmade");
    expect(validQuestionAnswer(multipleField, withOther)).toBe(true);
    expect(toggleQuestionOptionAnswer(multipleField, withOther, "one")).toEqual(multipleAnswer([], "handmade"));
    expect(replaceQuestionOtherAnswer(multipleField, withOther, "")).toEqual(multipleAnswer(["one"]));
  });

  it("maps 1–N and Other while fencing repeats, IME composition, and editable targets", () => {
    const key = { key: "1", repeat: false, isComposing: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, editableTarget: false };
    const context = { kind: "single" as const, optionCount: 2, allowOther: true, required: true, currentValid: false };
    expect(resolveQuestionWizardKey(key, context)).toEqual({ kind: "choice", index: 0 });
    expect(resolveQuestionWizardKey({ ...key, key: "3" }, context)).toEqual({ kind: "other" });
    expect(resolveQuestionWizardKey({ ...key, key: "3" }, { ...context, allowOther: false })).toBeNull();
    expect(resolveQuestionWizardKey({ ...key, key: "2" }, { ...context, kind: "multiple" })).toEqual({ kind: "choice", index: 1 });
    expect(resolveQuestionWizardKey({ ...key, repeat: true }, context)).toBeNull();
    expect(resolveQuestionWizardKey({ ...key, isComposing: true }, context)).toBeNull();
    expect(resolveQuestionWizardKey({ ...key, editableTarget: true }, context)).toBeNull();
    expect(resolveQuestionWizardKey({ ...key, key: "Escape" }, { ...context, required: false, currentValid: true })).toEqual({ kind: "skip" });
    expect(resolveQuestionWizardKey({ ...key, key: "Escape" }, { ...context, currentValid: true })).toEqual({ kind: "minimize" });
  });
});

describe("typed error recovery", () => {
  it("keeps only actions executable in the current run/capability context", () => {
    const error = errorView({
      runId: "run-1",
      retryable: true,
      recovery: [
        { id: "retry", kind: "retry", label: "Try again" },
        { id: "abort", kind: "abort", label: "Stop" },
        { id: "wait", kind: "wait", label: "Wait" },
        { id: "diagnostics", kind: "openDiagnostics", label: "Diagnostics" }
      ]
    });
    expect(executableRecoveryActions(error, { retryRunId: "run-1", activeRunId: "run-1", canAbort: false, canRefresh: true, canContactOwner: false, sessionAvailable: true }).map((action) => action.kind)).toEqual(["retry", "wait", "openDiagnostics"]);
    expect(executableRecoveryActions(error, { retryRunId: "other", activeRunId: "run-1", canAbort: true, canRefresh: true, canContactOwner: false, sessionAvailable: true }).map((action) => action.kind)).toEqual(["abort", "wait", "openDiagnostics"]);
  });

  it("infers resnapshot/open-session only from stable error-code families", () => {
    const stale = errorView({ code: "STALE_CURSOR", recovery: [] });
    const missing = errorView({ code: "NATIVE_SESSION_MISSING", recovery: [] });
    expect(executableRecoveryActions(stale, { canAbort: false, canRefresh: true, canContactOwner: false, sessionAvailable: true }).map((action) => action.kind)).toEqual(["resnapshot"]);
    expect(executableRecoveryActions(stale, { canAbort: false, canRefresh: false, canContactOwner: false, sessionAvailable: true })).toEqual([]);
    expect(executableRecoveryActions(missing, { canAbort: false, canRefresh: true, canContactOwner: false, sessionAvailable: true }).map((action) => action.kind)).toEqual(["openSession"]);
  });

  it("turns resolve-interaction recovery into an open-session action", () => {
    const error = errorView({ recovery: [{ id: "resolve", kind: "resolveInteraction", label: "Answer question" }] });
    expect(executableRecoveryActions(error, { canAbort: false, canRefresh: true, canContactOwner: false, sessionAvailable: true })).toEqual([{ id: "resolve", kind: "openSession", label: "Answer question" }]);
  });

  it("keeps WAIT and CONTACT_OWNER only when their current snapshot paths are executable", () => {
    const error = errorView({ recovery: [
      { id: "wait", kind: "wait", label: "Wait", retryAfterMs: 2_000 },
      { id: "owner", kind: "contactOwner", label: "Contact owner" }
    ] });
    expect(executableRecoveryActions(error, { canAbort: false, canRefresh: false, canContactOwner: false, sessionAvailable: true })).toEqual([]);
    expect(executableRecoveryActions(error, { canAbort: false, canRefresh: true, canContactOwner: true, sessionAvailable: true }).map((action) => action.kind)).toEqual(["wait", "contactOwner"]);
  });

  it("deep-links recovery actions to the settings panel that can execute them", () => {
    expect(recoverySettingsHash("openDiagnostics")).toBe("#/settings/about/diagnostics");
    expect(recoverySettingsHash("reauthenticate")).toBe("#/settings/providers");
    expect(recoverySettingsHash("contactOwner")).toBe("#/settings/connections");
  });

  it("bounds WAIT delay and single-flights repeated recovery activation", async () => {
    vi.useFakeTimers();
    try {
      expect(boundedRecoveryWaitMs(undefined)).toBe(1_000);
      expect(boundedRecoveryWaitMs(-5)).toBe(250);
      expect(boundedRecoveryWaitMs(90_000)).toBe(30_000);
      const refresh = vi.fn(async () => undefined);
      const flights = new RecoveryActionSingleFlight();
      const first = flights.run("wait:one", async () => { if (await waitForRecoveryDelay(0)) await refresh(); });
      const repeated = flights.run("wait:one", refresh);
      expect(first).toBeDefined();
      expect(repeated).toBeUndefined();
      await vi.advanceTimersByTimeAsync(249);
      expect(refresh).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await first;
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

function field(overrides: Partial<QuestionFieldView> & Pick<QuestionFieldView, "id" | "kind">): QuestionFieldView {
  return {
    id: overrides.id,
    label: overrides.id,
    required: overrides.required ?? false,
    kind: overrides.kind,
    options: overrides.options ?? [],
    multiline: overrides.multiline ?? false,
    minimumSelections: overrides.minimumSelections ?? 0,
    allowOther: overrides.allowOther ?? false,
    ...(overrides.description === undefined ? {} : { description: overrides.description }),
    ...(overrides.placeholder === undefined ? {} : { placeholder: overrides.placeholder }),
    ...(overrides.defaultValue === undefined ? {} : { defaultValue: overrides.defaultValue }),
    ...(overrides.maximumSelections === undefined ? {} : { maximumSelections: overrides.maximumSelections })
  };
}

function errorView(overrides: Partial<ErrorView>): ErrorView {
  return {
    code: overrides.code ?? "ERROR",
    message: overrides.message ?? "Failed",
    phase: overrides.phase ?? "run",
    severity: overrides.severity ?? "retryable",
    retryable: overrides.retryable ?? false,
    recovery: overrides.recovery ?? [],
    ...(overrides.runId === undefined ? {} : { runId: overrides.runId })
  };
}
