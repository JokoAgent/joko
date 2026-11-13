// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { InteractionKind, InteractionSchema, InteractionState, PermissionDecisionKind, PermissionRisk } from "@joko/contracts";
import { expect, it, vi } from "vitest";
import { mobileMessage } from "./mobile-messages";
import { createMobileInteractionResolution } from "./mobile-interactions";

const native = vi.hoisted(() => ({ alert: vi.fn() }));

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
    TextInput: box,
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
vi.mock("./MobileQuestionTextInput", () => ({ MobileQuestionTextInput: () => null }));
vi.mock("./storage", () => ({ mobileInteractionDrafts: { subscribeErrors: () => () => undefined } }));

import { MobileInteractionSheet } from "./MobileInteractionSheet";

const colors = { background: "#fff", surface: "#fff", ink: "#111", muted: "#666", border: "#ccc", accent: "#f90",
  negative: "#b00", brandBackground: "#eee" };

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
