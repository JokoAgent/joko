// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobilePartnerCreateSheet } from "./MobilePartnerCreateSheet";
import type { MobilePartnerCreationTransport, MobilePartnerCreationResult } from "./mobile-partner-creation";
import { profilePartner } from "./test/mobile-partner-profile";
import { creationSnapshot } from "./test/mobile-partner-creation";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const alerts = vi.hoisted(() => ({ alert: vi.fn() }));
const photo = vi.hoisted(() => ({ pick: vi.fn() }));
const native = vi.hoisted(() => ({ os: "ios" as "ios" | "android", reduced: false, timing: vi.fn(),
  dismiss: undefined as undefined | (() => void), systemClose: undefined as undefined | (() => void) }));
vi.mock("./mobile-partner-avatar", async (original) => ({ ...await original<typeof import("./mobile-partner-avatar")>(), pickMobilePartnerPhoto: photo.pick }));
vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ children, accessibilityLabel, accessibilityRole, disabled, onPress }: {
    children?: ReactNode; accessibilityLabel?: string; accessibilityRole?: string; disabled?: boolean; onPress?: () => void;
  }) => React.createElement(tag, { "aria-label": accessibilityLabel, role: accessibilityRole, disabled, onClick: onPress }, children);
  return { Alert: { alert: alerts.alert }, ActivityIndicator: () => null, Image: () => React.createElement("img"),
    Platform: { get OS() { return native.os; } },
    AccessibilityInfo: { isReduceMotionEnabled: async () => native.reduced, addEventListener: () => ({ remove: () => undefined }) },
    Animated: { Value: class { constructor(_value: number) {} interpolate() { return 1; } setValue(_value: number) {} }, View: element("div"),
      timing: (...args: unknown[]) => { native.timing(...args); return { start: (finish: (value: { finished: boolean }) => void) => finish({ finished: true }), stop: () => undefined }; } },
    Modal: ({ visible, children, onDismiss, onRequestClose }: { visible: boolean; children: ReactNode; onDismiss?: () => void; onRequestClose?: () => void }) => {
      native.dismiss = onDismiss; native.systemClose = onRequestClose; return visible ? children : null;
    },
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
const close = vi.fn(); const created = vi.fn();
function transport(ownerKey = "owner"): MobilePartnerCreationTransport {
  return { ownerKey, pending: vi.fn(async () => undefined),
    load: vi.fn(async () => ({ ...creationSnapshot, ownerKey })),
    create: vi.fn(async (): Promise<MobilePartnerCreationResult> => ({ kind: "found", partner: profilePartner })),
    lookup: vi.fn(async (): Promise<MobilePartnerCreationResult> => ({ kind: "found", partner: profilePartner })),
    retire: vi.fn(async (): Promise<MobilePartnerCreationResult> => ({ kind: "retired" })) };
}
async function render(active: MobilePartnerCreationTransport, visible = true) {
  if (!root) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); }
  await act(async () => root.render(createElement(MobilePartnerCreateSheet, { visible, transport: active,
    colors, locale: "en", onClose: close, onCreated: created })));
}
async function press(label: string) {
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="' + label + '"]');
  expect(button, label).toBeTruthy(); await act(async () => button!.click());
}
async function name(value = "Nova") {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
  await act(async () => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); });
}
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); root = undefined as unknown as Root;
  close.mockReset(); created.mockReset(); alerts.alert.mockReset(); photo.pick.mockReset(); native.os = "ios"; native.reduced = false;
  native.dismiss = undefined; native.systemClose = undefined; });

describe("native Partner creation sheet", () => {
  it("does not animate an Android sheet when reduced motion is enabled", async () => {
    native.os = "android"; native.reduced = true; native.timing.mockClear();
    const active = transport(); await render(active); expect(native.timing).not.toHaveBeenCalled();
    await render(active, false); expect(native.timing).not.toHaveBeenCalled(); native.reduced = false;
  });
  it("blocks empty/preparing submission, creates the selected photo and waits for iOS dismissal before navigation", async () => {
    const active = transport(); await render(active); await press("Invite Partner"); expect(active.create).not.toHaveBeenCalled();
    await name(); let finish!: (value: { readonly base64: string }) => void;
    photo.pick.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await press("Choose a photo"); await press("Invite Partner"); expect(active.create).not.toHaveBeenCalled();
    await act(async () => finish({ base64: "/9j/2w==" })); await press("Invite Partner");
    expect(active.create).toHaveBeenCalledOnce(); expect(vi.mocked(active.create).mock.calls[0]?.[1]).toMatchObject({ displayName: "Nova",
      avatar: { base64: "/9j/2w==" }, templateId: "general" });
    expect(close).toHaveBeenCalledOnce(); expect(created).not.toHaveBeenCalled();
    await render(active, false); await act(async () => native.dismiss?.()); expect(created).toHaveBeenCalledExactlyOnceWith(profilePartner);
  });
  it("locks an unknown draft, keeps absence ambiguous and adopts a result that wins atomic retirement", async () => {
    const active = transport(); let pending: string | undefined;
    vi.mocked(active.pending).mockImplementation(async () => pending);
    vi.mocked(active.create).mockImplementation(async () => { pending = "creation-request-ui-unknown"; throw new Error("lost acknowledgement"); });
    vi.mocked(active.lookup).mockResolvedValue({ kind: "absent" }); vi.mocked(active.retire).mockResolvedValue({ kind: "found", partner: profilePartner });
    await render(active); await name(); await press("Invite Partner");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Name"]')?.value).toBe("Nova");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Name"]')?.disabled).toBe(true);
    await press("Check creation result");
    expect(close).not.toHaveBeenCalled(); expect(active.create).toHaveBeenCalledOnce();
    await press("Retire request and start a new invite");
    expect(active.retire).toHaveBeenCalledExactlyOnceWith(pending, expect.any(AbortSignal));
    expect(active.create).toHaveBeenCalledOnce(); await render(active, false); await act(async () => native.dismiss?.());
    expect(created).toHaveBeenCalledExactlyOnceWith(profilePartner);
  });
  it("hydrates a body-free unknown receipt and allows recovery even when no model is currently available", async () => {
    const active = transport(); vi.mocked(active.pending).mockResolvedValue("creation-request-reloaded-ui");
    vi.mocked(active.load).mockResolvedValue({ ...creationSnapshot, backends: [] });
    await render(active); expect(container.textContent).toContain("No current model"); await press("Check creation result");
    expect(active.lookup).toHaveBeenCalledExactlyOnceWith("creation-request-reloaded-ui", expect.any(AbortSignal));
    expect(active.create).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
  });
  it("ignores a late create after node retirement without dismissing or adopting for the new owner", async () => {
    const old = transport("old"); let finish!: (value: MobilePartnerCreationResult) => void;
    vi.mocked(old.create).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render(old); await name(); await press("Invite Partner");
    const signal = vi.mocked(old.create).mock.calls[0]![2];
    const active = transport("next"); await render(active); expect(signal.aborted).toBe(true);
    await act(async () => finish({ kind: "found", partner: profilePartner }));
    expect(close).not.toHaveBeenCalled(); expect(created).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Name"]')?.value).toBe("");
  });
  it("prevents dirty system dismissal and retires the explicit discard callback with its owner", async () => {
    const active = transport(); await render(active); await name();
    await act(async () => native.systemClose?.()); expect(close).not.toHaveBeenCalled(); expect(alerts.alert).toHaveBeenCalledOnce();
    const buttons = alerts.alert.mock.calls.at(-1)![2] as Array<{ onPress?: () => void }>;
    await render(transport("next")); await act(async () => buttons[1]!.onPress?.()); expect(close).not.toHaveBeenCalled();
  });
});
