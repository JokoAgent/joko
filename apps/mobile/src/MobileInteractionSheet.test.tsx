// @vitest-environment jsdom
import { act, createElement, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { InteractionKind, InteractionSchema, InteractionState, PermissionDecisionKind, PermissionRisk, PlanReviewDecisionKind,
  QuestionMultipleChoiceInputSchema, QuestionSingleChoiceInputSchema, QuestionTextInputSchema, type QuestionField } from "@joko/contracts";
import { expect, it, vi } from "vitest";
import { mobileMessage } from "./mobile-messages";
import { createMobileInteractionResolution } from "./mobile-interactions";
import type { MobileQuestionTextInput } from "./MobileQuestionTextInput";

const native = vi.hoisted(() => ({
  alert: vi.fn(), textInputs: new Map<string, (text: string) => void>(),
  questionInput: vi.fn<(props: ComponentProps<typeof MobileQuestionTextInput>) => null>(() => null)
}));

vi.mock("react-native", () => {
  const box = ({ children }: { children?: ReactNode }) => createElement("div", {}, children);
  return {
    Alert: { alert: native.alert },
    Platform: { OS: "android" },
    StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
    Modal: ({ children, visible }: { children?: ReactNode; visible: boolean }) => createElement("div", { hidden: !visible }, children),
    Pressable: ({ children, onPress, disabled, accessibilityLabel }: {
      children?: ReactNode; onPress?: () => void; disabled?: boolean; accessibilityLabel?: string;
    }) => createElement("button", { onClick: onPress, disabled, "aria-label": accessibilityLabel }, children),
    ScrollView: box,
    Text: ({ children, selectable, accessibilityRole }: {
      children?: ReactNode; selectable?: boolean; accessibilityRole?: string;
    }) => createElement("span", { role: accessibilityRole, "data-selectable": selectable ? "true" : undefined }, children),
    TextInput: ({ accessibilityLabel, value, onChangeText, editable }: {
      accessibilityLabel?: string; value?: string; editable?: boolean; onChangeText?: (text: string) => void;
    }) => {
      if (accessibilityLabel && onChangeText) native.textInputs.set(accessibilityLabel, onChangeText);
      return createElement("textarea", { "aria-label": accessibilityLabel, value, readOnly: true, disabled: editable === false });
    },
    View: box
  };
});
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => createElement("div", {}, children),
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 })
}));
vi.mock("./MobileKeyboardAvoidingView", () => ({
  MobileKeyboardAvoidingView: ({ children }: { children?: ReactNode }) => createElement("div", {}, children),
  useMobileKeyboardState: () => ({ height: 0, visible: false })
}));
vi.mock("./MobileQuestionTextInput", () => ({ MobileQuestionTextInput: native.questionInput }));
vi.mock("./storage", () => ({ mobileInteractionDrafts: { subscribeErrors: () => () => undefined } }));

import { MobileInteractionSheet } from "./MobileInteractionSheet";

const colors = { background: "#fff", surface: "#fff", ink: "#111", muted: "#666", border: "#ccc", accent: "#f90",
  negative: "#b00", brandBackground: "#eee" };

it.each(["text", "singleChoice", "multipleChoice"] as const)("passes the task voice filter to an allowed %s answer", async kind => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const choices = [{ choiceId: "first", label: "First" }, { choiceId: "second", label: "Second" }];
  const input: QuestionField["input"] = kind === "text"
    ? { case: kind, value: create(QuestionTextInputSchema) }
    : kind === "singleChoice"
      ? { case: kind, value: create(QuestionSingleChoiceInputSchema, { choices, allowOther: true }) }
      : { case: kind, value: create(QuestionMultipleChoiceInputSchema, { choices, allowOther: true }) };
  const question = create(InteractionSchema, {
    interactionId: "voice-question", kind: InteractionKind.QUESTION, state: InteractionState.PENDING,
    backendId: "codex", targetId: "target", sessionId: "task", generation: 2n,
    version: { revision: { value: 3n }, generation: 2n },
    request: { case: "question", value: { fields: [{ fieldId: "answer", label: "Answer", input }] } }
  });
  const render = (interaction = question, visible = true) => act(async () => {
    root.render(<MobileInteractionSheet visible={visible} interactions={[interaction]} busy={false} colors={colors} locale="en"
      speakerFilter onSelect={() => undefined} onMinimize={() => undefined} onResolve={async () => false}
      onDismiss={async () => true} onError={() => undefined} />);
  });
  try {
    await render();
    expect(native.questionInput.mock.lastCall?.[0]).toMatchObject({
      speakerFilter: true, enabled: true, ownerKey: expect.stringMatching(kind === "text" ? /:answer$/u : /:answer:other$/u)
    });
    await render(question, false);
    expect(native.questionInput.mock.lastCall?.[0].enabled).toBe(false);
    native.questionInput.mockClear();
    await render(create(InteractionSchema, { ...question, state: InteractionState.EXPIRED }));
    expect(native.questionInput).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    native.questionInput.mockClear();
    vi.unstubAllGlobals();
  }
});

it("submits the exact changed plan only when approving its original editable request", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const request = (revision: bigint, markdown: string) => create(InteractionSchema, {
    interactionId: "current-plan", kind: InteractionKind.PLAN_REVIEW, state: InteractionState.PENDING,
    backendId: "codex", targetId: "target", sessionId: "task", generation: 2n,
    version: { revision: { value: revision }, generation: 2n },
    request: { case: "planReview", value: { title: "Review plan", markdown, editable: true,
      allowedDecisions: [PlanReviewDecisionKind.EXECUTE, PlanReviewDecisionKind.STAY_IN_PLAN_MODE] } }
  });
  const originalPlan = "1. Preserve the current implementation.";
  const initial = request(3n, originalPlan);
  const revised = request(4n, "1. Check the new request.");
  const onResolve = vi.fn(async () => false);
  const render = (interaction: ReturnType<typeof request>, allowPlanEdit = true) => act(async () => {
    root.render(<MobileInteractionSheet visible interactions={[interaction]} busy={false} colors={colors}
      locale="en" allowPlanEdit={allowPlanEdit} onSelect={() => undefined} onMinimize={() => undefined} onResolve={onResolve}
      onDismiss={async () => true} onError={() => undefined} />);
  });
  const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const press = (label: string) => act(async () => button(label)!.click());
  const change = (text: string) => act(async () => native.textInputs.get("Edited plan")!(text));
  try {
    await render(initial);
    await press("Edit plan");
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edited plan"]')?.value).toBe(originalPlan);
    await change(" ");
    expect(button("Approve edited plan")?.disabled).toBe(true);
    const editedPlan = "  1. Add a verification step.\n2. Record its result.\n";
    await change(editedPlan);
    expect(onResolve).not.toHaveBeenCalled();
    await press("Approve edited plan");
    expect(onResolve).toHaveBeenCalledExactlyOnceWith(initial, { kind: "plan", decision: PlanReviewDecisionKind.EXECUTE, feedback: "", editedPlan });
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edited plan"]')?.value).toBe(editedPlan);
    await render(revised, false);
    expect(button("Edit plan")).toBeNull();
    expect(host.querySelector('textarea[aria-label="Edited plan"]')).toBeNull();
    expect(host.textContent).toContain("1. Check the new request.");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    native.textInputs.clear();
  }
});

function permission(revision: bigint, explanation: string, toolId?: string) {
  return create(InteractionSchema, {
    interactionId: "permission", kind: InteractionKind.PERMISSION, state: InteractionState.PENDING,
    backendId: "claude-code", targetId: "target", sessionId: "task", generation: 2n,
    version: { revision: { value: revision }, generation: 2n },
    request: { case: "permission", value: {
      title: "Approve command execution", explanation, risk: PermissionRisk.CRITICAL,
      ...(toolId === undefined ? {} : { subject: { kind: { case: "customTool" as const, value: { toolId, displayName: toolId } } } }),
      allowedDecisions: [PermissionDecisionKind.ALLOW_ONCE, PermissionDecisionKind.ALLOW_FOR_SESSION, PermissionDecisionKind.DENY_ONCE]
    } }
  });
}

it("keeps the exact permission evidence selectable through confirmation and retires confirmation on a new revision", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const onResolve = vi.fn(async () => true);
  const onError = vi.fn();
  const original = `Run command\nprintf '%s' '${"x".repeat(2_500)}' && cat original.txt`;
  const revised = "Run command\ncat revised.txt";
  const initial = permission(3n, original);
  const replacement = permission(4n, revised);
  const warning = mobileMessage("en", "interaction.highRiskBody");
  const render = (interaction: ReturnType<typeof permission>, visible = true) => act(async () => {
    root.render(<MobileInteractionSheet visible={visible} profileId="profile" interactions={[interaction]} busy={false} colors={colors}
      locale="en" onSelect={() => undefined} onMinimize={() => undefined} onResolve={onResolve}
      onDismiss={async () => true} onError={onError} />);
  });
  const button = (label: string) => Array.from(host.querySelectorAll("button")).find(candidate => candidate.getAttribute("aria-label") === label)!;
  const press = (label: string) => act(async () => button(label).click());
  const evidence = () => host.querySelector("[data-selectable]")?.textContent;
  try {
    await render(initial);
    await press("Allow once");
    expect(evidence()).toBe(original);
    expect(host.textContent).toContain(warning);
    expect(onResolve).not.toHaveBeenCalled();
    expect(native.alert).not.toHaveBeenCalled();

    await press(mobileMessage("en", "common.cancel"));
    expect(host.textContent).not.toContain(warning);
    await press("Allow for this task");
    await render(replacement);
    expect(host.textContent).not.toContain(warning);
    expect(evidence()).toBe(revised);

    await press("Allow once");
    await render(replacement, false);
    await render(replacement);
    expect(host.textContent).not.toContain(warning);

    await press("Allow once");
    expect(onResolve).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(evidence()).toBe(revised);
    await act(async () => {
      const confirm = button("Allow once");
      confirm.click();
      confirm.click();
    });
    expect(onResolve).toHaveBeenCalledExactlyOnceWith(replacement, {
      kind: "permission", decision: PermissionDecisionKind.ALLOW_ONCE
    });
    expect(onError).toHaveBeenCalledExactlyOnceWith("");

    const bash = permission(5n, "Run the confirmed Bash command", "Bash");
    await render(bash);
    expect(button("Allow for this task")).toBeUndefined();
    expect(button("Allow once")).toBeDefined();
    expect(button(mobileMessage("en", "interaction.decision.deny"))).toBeDefined();
    expect(() => createMobileInteractionResolution(bash, {
      kind: "permission", decision: PermissionDecisionKind.ALLOW_FOR_SESSION
    }, "connection")).toThrow(/not currently available/u);
    onResolve.mockClear();
    await press("Allow once");
    expect(host.textContent).toContain(warning);
    expect(onResolve).not.toHaveBeenCalled();
    await press("Allow once");
    expect(onResolve).toHaveBeenCalledExactlyOnceWith(bash, { kind: "permission", decision: PermissionDecisionKind.ALLOW_ONCE });
    const otherBackend = create(InteractionSchema, { ...bash, backendId: "another-backend" });
    await render(otherBackend);
    expect(button("Allow for this task")).toBeDefined();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("shows rejection in the permission sheet and checks a pending response using its original ID", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const initial = permission(3n, "Current permission evidence");
  const failure = new Error("The permission request changed before the response was accepted.");
  const onResolve = vi.fn(async () => { throw failure; });
  const check = vi.fn(async () => false);
  const onError = vi.fn();
  const render = (operationId?: string) => act(async () => {
    root.render(<MobileInteractionSheet visible profileId="profile" interactions={[initial]} busy={false} colors={colors}
      locale="en" onSelect={() => undefined} onMinimize={() => undefined} onResolve={onResolve}
      onDismiss={async () => true} onError={onError}
      responseReceipt={operationId === undefined ? undefined : { operationId, state: "unknown", check }} />);
  });
  const button = (label: string) => Array.from(host.querySelectorAll("button")).find(candidate => candidate.getAttribute("aria-label") === label)!;
  try {
    await render();
    await act(async () => button(mobileMessage("en", "interaction.decision.deny")).click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(failure.message);
    expect(onResolve).toHaveBeenCalledOnce();

    await render("original-permission-response");
    expect(button(mobileMessage("en", "interaction.decision.deny")).disabled).toBe(true);
    await act(async () => button(mobileMessage("en", "receipt.check")).click());
    expect(check).toHaveBeenCalledExactlyOnceWith(initial, "original-permission-response");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(mobileMessage("en", "interaction.responseUnconfirmed"));
    expect(onResolve).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
