// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobilePartnerProfileSheet } from "./MobilePartnerProfileSheet";
import type { MobilePartnerProfileSnapshot, MobilePartnerProfileTransport } from "./mobile-partner-profile";
import { profilePartner, profileSnapshot } from "./test/mobile-partner-profile";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const alerts = vi.hoisted(() => ({ alert: vi.fn() }));
vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ children, accessibilityLabel, accessibilityRole, disabled, onPress }: {
    children?: ReactNode; accessibilityLabel?: string; accessibilityRole?: string; disabled?: boolean; onPress?: () => void;
  }) => React.createElement(tag, { "aria-label": accessibilityLabel, role: accessibilityRole, disabled, onClick: onPress }, children);
  return { Alert: { alert: alerts.alert }, ActivityIndicator: () => null,
    Modal: ({ visible, children }: { visible: boolean; children: ReactNode }) => visible ? children : null,
    Pressable: element("button"), ScrollView: element("div"), Text: element("span"), View: element("div"),
    StyleSheet: { create: <T,>(value: T) => value, hairlineWidth: 1 },
    Switch: ({ value, disabled, accessibilityLabel, onValueChange }: { value: boolean; disabled?: boolean;
      accessibilityLabel: string; onValueChange: (value: boolean) => void }) => React.createElement("input", {
      type: "checkbox", checked: value, disabled, "aria-label": accessibilityLabel, onChange: () => onValueChange(!value)
    }),
    TextInput: ({ value, editable, accessibilityLabel, onChangeText, multiline }: { value: string; editable: boolean;
      accessibilityLabel: string; onChangeText: (value: string) => void; multiline?: boolean }) => React.createElement(multiline ? "textarea" : "input", {
      value, disabled: !editable, "aria-label": accessibilityLabel, onChange: () => undefined,
      onInput: (event: React.ChangeEvent<HTMLInputElement>) => onChangeText(event.target.value)
    }) };
});
vi.mock("react-native-safe-area-context", async () => {
  const React = await import("react");
  return { SafeAreaView: ({ children }: { children: ReactNode }) => React.createElement("div", {}, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});
vi.mock("./MobileKeyboardAvoidingView", async () => {
  const React = await import("react");
  return { MobileKeyboardAvoidingView: ({ children }: { children: ReactNode }) => React.createElement("div", {}, children),
    useMobileKeyboardState: () => ({ height: 0, visible: false }) };
});

const colors = { background: "#fff", surface: "#fff", ink: "#111", muted: "#666", border: "#ddd",
  accent: "#f90", negative: "#b00", brandBackground: "#ffe" };
let root: Root; let container: HTMLDivElement;
const close = vi.fn(); const saved = vi.fn();
const transport = (ownerKey = "owner"): MobilePartnerProfileTransport => ({ ownerKey,
  load: vi.fn(async () => ({ ...profileSnapshot, ownerKey })),
  save: vi.fn(async (_snapshot, draft) => ({ ...profilePartner, ...draft, revision: 3n, profileVersion: 4n })) });
async function render(active?: MobilePartnerProfileTransport) {
  if (!root) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); }
  await act(async () => root.render(createElement(MobilePartnerProfileSheet, { visible: true, partner: profilePartner,
    transport: active, colors, locale: "en", onClose: close, onSaved: saved })));
}
async function press(label: string) {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button, label).toBeTruthy(); await act(async () => button!.click());
}
async function editName(name: string) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
  await act(async () => { input.value = name; input.dispatchEvent(new Event("input", { bubbles: true })); });
}
afterEach(() => { if (root) act(() => root.unmount()); container?.remove(); root = undefined as unknown as Root;
  close.mockReset(); saved.mockReset(); alerts.alert.mockReset(); });

describe("MobilePartnerProfileSheet", () => {
  it("edits a complete profile draft and assigns an advertised effort to a fallback model", async () => {
    const active = transport(); await render(active);
    await editName("Ada Two"); await press("Add fallback model"); await press("Save Partner");
    expect(active.save).toHaveBeenCalledOnce();
    expect(vi.mocked(active.save).mock.calls[0]![1]).toMatchObject({ displayName: "Ada Two", capabilities: {
      modelChain: [{ providerId: "alpha", modelId: "a", effort: "low" }, { providerId: "beta", modelId: "b", effort: "low" }]
    } });
    expect(saved).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  });

  it("preserves an unconfirmed save draft, forbids resending and refreshes only on explicit discard", async () => {
    const active = transport(); vi.mocked(active.save).mockRejectedValueOnce(new Error("transport lost"));
    await render(active); await editName("Ada Two"); await press("Save Partner");
    expect(container.textContent).toContain("your draft is still here");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Name"]')?.value).toBe("Ada Two");
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Save Partner"]')?.disabled).toBe(true);
    await press("Save Partner"); expect(active.save).toHaveBeenCalledOnce();
    await press("Refresh and discard draft");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Name"]')?.value).toBe("Ada");
  });

  it("retires old owner reads and offers a deliberate discard when closing a dirty draft", async () => {
    const old = transport("old"); let finish!: (value: MobilePartnerProfileSnapshot) => void;
    vi.mocked(old.load).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render(old); const active = transport(); await render(active);
    await act(async () => finish({ ...profileSnapshot, ownerKey: "old", partner: { ...profilePartner, displayName: "Old" } }));
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Name"]')?.value).toBe("Ada");
    await editName("Dirty"); await press("Close");
    expect(close).not.toHaveBeenCalled(); expect(alerts.alert).toHaveBeenCalledOnce();
    await render(undefined); expect(container.textContent).toContain("Reconnect to edit this Partner");
    expect(container.querySelector('input[aria-label="Name"]')).toBeNull();
  });
});
