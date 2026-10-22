// @vitest-environment jsdom
import { act, createElement, forwardRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InputHandoffPicture, InputHandoffSnapshot, InputHandoffSubmission } from "@joko/contracts";
import type { MobileInputHandoffApi } from "./mobile-input-handoff";

const native = vi.hoisted(() => ({ state: "active", listeners: new Set<(value: string) => void>(), copy: vi.fn(async () => true), image: vi.fn(async () => {}), open: vi.fn(async () => {}) }));
vi.mock("expo-clipboard", () => ({ setStringAsync: native.copy, setImageAsync: native.image }));
vi.mock("react-native", () => {
  const box = ({ children }: { children?: ReactNode }) => createElement("div", {}, children);
  return { View: box, ScrollView: box, KeyboardAvoidingView: box,
    Text: ({ children, onPress, accessibilityRole }: { children?: ReactNode; onPress?: () => void; accessibilityRole?: string }) => createElement("span", { onClick: onPress, role: accessibilityRole }, children),
    Modal: ({ visible, children }: { visible?: boolean; children?: ReactNode }) => visible ? createElement("div", { role: "dialog" }, children) : null,
    Pressable: ({ children, onPress, disabled, accessibilityLabel }: { children?: ReactNode; onPress?: () => void; disabled?: boolean; accessibilityLabel?: string }) =>
      createElement("button", { onClick: onPress, disabled, "aria-label": accessibilityLabel }, children),
    Image: ({ source, accessibilityLabel }: { source: { uri: string }; accessibilityLabel: string }) => createElement("img", { src: source.uri, alt: accessibilityLabel }),
    TextInput: forwardRef<HTMLInputElement, { value?: string; onChangeText?: (value: string) => void; accessibilityLabel?: string; secureTextEntry?: boolean;
      autoComplete?: string; textContentType?: string; editable?: boolean; onSubmitEditing?: () => void }>((props, ref) => createElement("input", { ref, value: props.value,
        "aria-label": props.accessibilityLabel, type: props.secureTextEntry ? "password" : "text", autoComplete: props.autoComplete, "data-content-type": props.textContentType,
        disabled: props.editable === false, onChange: (event: React.ChangeEvent<HTMLInputElement>) => props.onChangeText?.(event.target.value), onKeyDown: (event: React.KeyboardEvent) => { if (event.key === "Enter") props.onSubmitEditing?.(); } })),
    Platform: { OS: "android" }, StyleSheet: { create: (value: unknown) => value }, Linking: { openURL: native.open },
    AppState: { get currentState() { return native.state; }, addEventListener: (_event: string, listener: (state: string) => void) => {
      native.listeners.add(listener); return { remove: () => native.listeners.delete(listener) };
    } }
  };
});
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: ({ children }: { children?: ReactNode }) => createElement("div", {}, children) }));
import { MobileInputHandoffPanel } from "./MobileInputHandoffPanel";

const colors = { background: "#fff", surface: "#fafafa", ink: "#111", muted: "#666", border: "#ccc", accent: "#d80", negative: "#c00", brandBackground: "#fff4df" };
const step: InputHandoffSnapshot = { kind: "input_handoff", requestId: "request", revision: 1, phase: "ready", remoteInput: true, purpose: "Sign in", source: { app: "Browser", origin: "https://login.example.test" }, stepNumber: 1,
  controls: [{ id: "username", kind: "text", label: "Account", contentType: "username" }, { id: "password", kind: "text", label: "Password", contentType: "password" },
    { id: "otp", kind: "text", label: "Code", contentType: "one-time-code" }] };
const picture: InputHandoffPicture = { mime: "image/jpeg", width: 200, height: 100, data: "/9j/" };
let root: Root, host: HTMLDivElement;
function api(snapshot = step, ownerKey = "owner-one"): MobileInputHandoffApi {
  return { ownerKey, sessionId: "session", deviceId: "phone", isCurrent: () => true, list: vi.fn(async () => [snapshot]),
    decide: vi.fn(async () => true), submit: vi.fn(async () => true), picture: vi.fn(async () => picture) };
}
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); native.state = "active"; native.copy.mockClear(); native.image.mockClear(); native.open.mockClear();
  host = document.body.appendChild(document.createElement("div")); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); native.listeners.clear(); Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT"); });
async function render(value: MobileInputHandoffApi) { await act(async () => root.render(createElement(MobileInputHandoffPanel, { api: value, colors, locale: "en" }))); }
async function click(label: string) { const target = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`); expect(target, label).not.toBeNull(); await act(async () => target!.click()); }
async function type(label: string, value: string) { const target = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(target, value); target.dispatchEvent(new Event("input", { bubbles: true })); }); }

describe("native mobile input handoff owner surface", () => {
  it("uses system password and SMS AutoFill fields and clears an uncertain submission without replay", async () => {
    const source = api(), submitted: InputHandoffSubmission[] = [];
    vi.mocked(source.submit).mockImplementation(async (_snapshot, value) => { submitted.push(structuredClone(value)); throw new Error("Synthetic uncertain result"); });
    await render(source); await click("Fill on this device");
    expect(host.querySelector('input[aria-label="Password"]')?.getAttribute("type")).toBe("password");
    expect(host.querySelector('input[aria-label="Password"]')?.getAttribute("autocomplete")).toBe("password");
    expect(host.querySelector('input[aria-label="Code"]')?.getAttribute("data-content-type")).toBe("oneTimeCode");
    await type("Password", "synthetic-private-password"); await click("Fill and continue");
    expect(submitted).toMatchObject([{ values: { password: "synthetic-private-password" }, action: { kind: "submit" } }]);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Password"]')!.value).toBe("");
    expect(source.submit).toHaveBeenCalledOnce(); expect(host.textContent).toContain("could not be confirmed");
    expect(host.textContent).not.toContain("synthetic-private-password"); expect(host.textContent).not.toContain("live view");
  });
  it("destroys drafts on background and owner changes, then ignores old private image replies", async () => {
    const first = api(); await render(first); await click("Fill on this device"); await type("Password", "old-secret");
    await act(async () => { native.state = "background"; for (const listener of [...native.listeners]) listener(native.state); });
    expect(host.querySelector("input")).toBeNull(); expect(host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => { native.state = "active"; for (const listener of [...native.listeners]) listener(native.state); });
    await click("Fill on this device"); expect(host.querySelector<HTMLInputElement>('input[aria-label="Password"]')!.value).toBe("");
    let finish!: (value: InputHandoffPicture) => void;
    const old = api({ ...step, picture: true }, "old-owner"); vi.mocked(old.picture).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await render(old); await click("Fill on this device"); const next = api(step, "new-owner"); await render(next);
    await act(async () => finish(picture)); expect(host.querySelector("img")).toBeNull(); expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(old.submit).not.toHaveBeenCalled(); await click("Fill on this device"); expect(host.querySelector<HTMLInputElement>('input[aria-label="Password"]')!.value).toBe("");
  });
  it("keeps held steps read-only until a value-less claim and offers QR and device-code actions only from checked links", async () => {
    const held = api({ ...step, holder: { deviceId: "another-phone" } }); await render(held);
    expect(host.querySelector('button[aria-label="Fill on this device"]')).toBeNull(); await click("Take over on this device");
    expect(held.decide).toHaveBeenCalledWith(expect.objectContaining({ requestId: "request" }), "claim", expect.any(AbortSignal));
    const qr = api({ ...step, picture: true, qr: "scan" }, "qr-owner"); vi.mocked(qr.picture).mockResolvedValue({ ...picture, qr: { text: "https://login.example.test/qr", url: "https://login.example.test/qr" } });
    await render(qr); await click("View sign-in QR code"); expect(host.querySelector("input")).toBeNull(); expect(host.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,/9j/");
    await click("Copy QR image"); expect(native.image).toHaveBeenCalledExactlyOnceWith("/9j/");
    await click("Open on this device · login.example.test"); expect(native.open).toHaveBeenCalledExactlyOnceWith("https://login.example.test/qr");
    const code = api({ ...step, controls: [], deviceCode: { code: "ABCD-EFGH", url: "https://login.example.test/device", origin: "https://login.example.test" } }, "device-owner");
    await render(code); await click("Fill on this device"); expect(host.textContent).toContain("ABCD-EFGH"); expect(host.querySelector("input")).toBeNull();
    await click("Copy code"); expect(native.copy).toHaveBeenCalledExactlyOnceWith("ABCD-EFGH");
  });
});
