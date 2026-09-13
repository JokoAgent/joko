import { describe, expect, it } from "vitest";
import { resolveInteractionShortcut, resolvePlanFeedbackKey, type InteractionShortcutInput, type PlanFeedbackKeyInput } from "./InteractionDialog.js";

const baseInput: InteractionShortcutInput = {
  key: "Enter",
  repeat: false,
  isComposing: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  editableTarget: false,
  buttonTarget: false
};

const permission = {
  kind: "permission" as const,
  options: [
    { id: "1", label: "Allow once" },
    { id: "2", label: "Allow for session" },
    { id: "3", label: "Always allow" },
    { id: "4", label: "Deny once" }
  ]
};

const plan = {
  kind: "plan" as const,
  options: [
    { id: "1", label: "Execute plan" },
    { id: "2", label: "Keep planning" },
    { id: "3", label: "Refine plan" }
  ]
};

const planFeedbackInput: PlanFeedbackKeyInput = {
  key: "Enter",
  repeat: false,
  isComposing: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false
};

describe("interaction takeover shortcuts", () => {
  it("uses Enter for allow-once and the platform-modified Enter for persistent approval", () => {
    expect(resolveInteractionShortcut(baseInput, permission)).toEqual({ kind: "resolve", decisionId: "1" });
    expect(resolveInteractionShortcut({ ...baseInput, metaKey: true }, permission)).toEqual({ kind: "resolve", decisionId: "3" });
    expect(resolveInteractionShortcut({ ...baseInput, ctrlKey: true }, permission)).toEqual({ kind: "resolve", decisionId: "3" });
  });

  it("uses Escape for the explicit permission denial", () => {
    expect(resolveInteractionShortcut({ ...baseInput, key: "Escape" }, permission)).toEqual({ kind: "resolve", decisionId: "4" });
  });

  it("maps plan approval and dismissal only through typed executable semantics", () => {
    expect(resolveInteractionShortcut(baseInput, plan)).toEqual({ kind: "resolve", decisionId: "1" });
    expect(resolveInteractionShortcut({ ...baseInput, key: "Escape" }, plan)).toEqual({ kind: "dismiss" });
    expect(resolveInteractionShortcut(baseInput, { kind: "plan", options: [{ id: "2", label: "Execute plan" }] })).toBeNull();
    expect(resolveInteractionShortcut({ ...baseInput, ctrlKey: true }, plan)).toBeNull();
    expect(resolveInteractionShortcut({ ...baseInput, metaKey: true }, plan)).toBeNull();
  });

  it("supports numeric select/confirm choices and Escape cancellation", () => {
    const select = { kind: "select" as const, options: [{ id: "alpha", label: "Alpha" }, { id: "beta", label: "Beta" }] };
    const confirm = { kind: "confirm" as const, options: [] };
    expect(resolveInteractionShortcut({ ...baseInput, key: "2" }, select)).toEqual({ kind: "extension", value: "beta" });
    expect(resolveInteractionShortcut({ ...baseInput, key: "Escape" }, select)).toEqual({ kind: "dismiss" });
    expect(resolveInteractionShortcut({ ...baseInput, key: "1" }, confirm)).toEqual({ kind: "extension", value: true });
    expect(resolveInteractionShortcut({ ...baseInput, key: "2" }, confirm)).toEqual({ kind: "extension", value: false });
    expect(resolveInteractionShortcut({ ...baseInput, key: "Escape" }, confirm)).toEqual({ kind: "extension", value: false });
  });

  it("does not consume composition, repeat, editable, or focused-button input", () => {
    expect(resolveInteractionShortcut({ ...baseInput, isComposing: true }, permission)).toBeNull();
    expect(resolveInteractionShortcut({ ...baseInput, repeat: true }, permission)).toBeNull();
    expect(resolveInteractionShortcut({ ...baseInput, editableTarget: true }, permission)).toBeNull();
    expect(resolveInteractionShortcut({ ...baseInput, buttonTarget: true }, permission)).toBeNull();
    expect(resolveInteractionShortcut({ ...baseInput, buttonTarget: true }, plan)).toBeNull();
    expect(resolveInteractionShortcut({ ...baseInput, key: "Escape", buttonTarget: true }, plan)).toBeNull();
  });
});

describe("plan feedback editor", () => {
  it("submits trimmed non-empty feedback with plain Enter and leaves Shift+Enter to the textarea", () => {
    expect(resolvePlanFeedbackKey(planFeedbackInput, " revise step two ")).toBe("submit");
    expect(resolvePlanFeedbackKey(planFeedbackInput, "  ")).toBe("blockEmptySubmit");
    expect(resolvePlanFeedbackKey({ ...planFeedbackInput, shiftKey: true }, "revise")).toBeNull();
  });

  it("collapses on Escape without leaking repeat, IME, or modified keys", () => {
    expect(resolvePlanFeedbackKey({ ...planFeedbackInput, key: "Escape" }, "revise")).toBe("collapse");
    expect(resolvePlanFeedbackKey({ ...planFeedbackInput, repeat: true }, "revise")).toBeNull();
    expect(resolvePlanFeedbackKey({ ...planFeedbackInput, isComposing: true }, "revise")).toBeNull();
    expect(resolvePlanFeedbackKey({ ...planFeedbackInput, ctrlKey: true }, "revise")).toBeNull();
    expect(resolvePlanFeedbackKey({ ...planFeedbackInput, metaKey: true }, "revise")).toBeNull();
    expect(resolvePlanFeedbackKey({ ...planFeedbackInput, altKey: true }, "revise")).toBeNull();
  });
});
