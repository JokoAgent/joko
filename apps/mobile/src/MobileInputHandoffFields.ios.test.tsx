// @vitest-environment jsdom
import { act, createElement, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { InputHandoffValues } from "@joko/contracts";
import { MobileInputHandoffFields } from "./MobileInputHandoffFields.ios";

type Modifier = { key: string; value: unknown };
vi.mock("@expo/ui", async () => { const React = await import("react"); return { Host: ({ children, colorScheme }: { children: ReactNode; colorScheme: string }) => React.createElement("div", { "data-color-scheme": colorScheme }, children) }; });
vi.mock("@expo/ui/swift-ui/modifiers", () => Object.fromEntries(["accessibilityLabel", "autocorrectionDisabled", "buttonStyle", "disabled", "font", "foregroundStyle", "frame", "keyboardType", "lineLimit", "onSubmit", "padding", "submitLabel", "textContentType", "textInputAutocapitalization"]
  .map(key => [key, (value: unknown) => ({ key, value })])));
vi.mock("@expo/ui/swift-ui", async () => {
  const React = await import("react"), box = ({ children }: { children: ReactNode }) => React.createElement("div", {}, children);
  const field = (secure: boolean) => React.forwardRef<HTMLInputElement, { text: { get(): string }; onTextChange(value: string): void; modifiers: Modifier[] }>((props, ref) => React.createElement("input", {
    ref, value: props.text.get(), type: secure ? "password" : "text", "aria-label": props.modifiers.find(item => item.key === "accessibilityLabel")?.value as string,
    "data-content-type": props.modifiers.find(item => item.key === "textContentType")?.value as string,
    disabled: props.modifiers.some(item => item.key === "disabled" && item.value === true), onChange: () => {},
    onInput: (event: React.ChangeEvent<HTMLInputElement>) => props.onTextChange(event.target.value)
  }));
  return { VStack: box, HStack: box, Text: box, SecureField: field(true), TextField: field(false),
    Button: ({ label, onPress, modifiers }: { label?: string; onPress(): void; modifiers: Modifier[] }) => React.createElement("button", { onClick: onPress,
      disabled: modifiers.some(item => item.key === "disabled" && item.value === true), "aria-label": modifiers.find(item => item.key === "accessibilityLabel")?.value as string }, label),
    useNativeState: (initial: string) => { const value = React.useRef(initial), [, refresh] = React.useState(0); return React.useMemo(() => ({ get: () => value.current,
      set: (next: string) => { value.current = next; refresh(previous => previous + 1); } }), []); } };
});

it("uses real SwiftUI SecureField traits and clears native text on the same-step answer without a web field", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.body.appendChild(document.createElement("div")), root = createRoot(host), submitted = vi.fn(); let clear!: () => void;
  function Fixture() {
    const [draft, setDraft] = useState<InputHandoffValues>({}), [disabled, setDisabled] = useState(false); clear = () => { setDraft({}); setDisabled(true); };
    return createElement(MobileInputHandoffFields, { snapshot: { kind: "input_handoff", requestId: "step", revision: 1, phase: "ready", purpose: "Sign in", source: { app: "Browser" }, stepNumber: 1,
      controls: [{ id: "pass", kind: "text", label: "Password", contentType: "password" }, { id: "code", kind: "text", label: "Code", contentType: "one-time-code" }] }, draft, disabled,
      colors: { background: "#111", surface: "#222", ink: "#fff", muted: "#aaa", border: "#333", accent: "#f80", negative: "#f33", brandBackground: "#321", dark: true }, locale: "en",
      onChange: (id, value) => setDraft(previous => ({ ...previous, [id]: value })), onSubmit: submitted });
  }
  try {
    await act(async () => root.render(createElement(Fixture))); expect(host.querySelector('[data-color-scheme="dark"]')).not.toBeNull();
    const password = () => host.querySelector<HTMLInputElement>('input[aria-label="Password"]')!;
    expect(password().type).toBe("password"); expect(password().dataset.contentType).toBe("password");
    expect(host.querySelector('input[aria-label="Code"]')?.getAttribute("data-content-type")).toBe("oneTimeCode");
    await act(async () => { password().value = "synthetic-secret"; password().dispatchEvent(new Event("input", { bubbles: true })); });
    expect(password().value).toBe("synthetic-secret");
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Show password"]')!.click());
    expect(password().type).toBe("text"); expect(password().value).toBe("synthetic-secret");
    await act(async () => clear()); expect(password().value).toBe(""); expect(password().disabled).toBe(true); expect(submitted).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("synthetic-secret");
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
