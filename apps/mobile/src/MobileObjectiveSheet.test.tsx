// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileObjectiveApi, MobileObjective } from "./mobile-objective";

vi.mock("react-native", () => ({
  Platform: { OS: "android" }, StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
  Modal: ({ visible, children }: { visible: boolean; children: ReactNode }) => visible ? createElement("div", null, children) : null,
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  ScrollView: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Text: ({ children, accessibilityRole }: { children: ReactNode; accessibilityRole?: string }) => createElement("span", { role: accessibilityRole }, children),
  ActivityIndicator: () => createElement("span", null, "Busy"),
  TextInput: ({ value, onChangeText, editable, accessibilityLabel }: { value: string; onChangeText: (text: string) => void; editable: boolean; accessibilityLabel: string }) =>
    createElement("textarea", { value, disabled: !editable, "aria-label": accessibilityLabel, onChange: (event: { target: { value: string } }) => onChangeText(event.target.value) }),
  Pressable: ({ children, accessibilityLabel, accessibilityRole, onPress, disabled }: { children: ReactNode; accessibilityLabel?: string; accessibilityRole?: string; onPress: () => void; disabled: boolean }) =>
    createElement("button", { "aria-label": accessibilityLabel, role: accessibilityRole, disabled, onClick: onPress }, children)
}));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: ({ children }: { children: ReactNode }) => createElement("div", null, children) }));
vi.mock("./MobileKeyboardAvoidingView", () => ({ MobileKeyboardAvoidingView: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  useMobileKeyboardState: () => ({ height: 0, visible: false }) }));
import { MobileObjectiveSheet } from "./MobileObjectiveSheet";

const colors = { background: "#fff", surface: "#fff", ink: "#111", muted: "#666", border: "#ccc", accent: "#ff9800", negative: "#b00", brandBackground: "#eee" };
const objective: MobileObjective = { sessionId: "task", text: "Reach the result", status: "active", turnsUsed: 0, tokensUsed: 0, lastReason: "",
  revision: 1n, ownerGeneration: 1n, sessionGeneration: 7n, maximumTurns: 20, tokenBudget: null, noProgressTurnLimit: null };
let root: Root, host: HTMLDivElement;
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.body.appendChild(document.createElement("div")); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
function api(ownerKey = "owner"): MobileObjectiveApi {
  return { ownerKey, sessionId: "task", generation: 7n, writable: true, get: vi.fn(async () => undefined),
    watch: async function* () {}, restore: vi.fn(async () => undefined), set: vi.fn(async () => objective),
    pause: vi.fn(async (): Promise<MobileObjective> => ({ ...objective, status: "paused", revision: 2n })), resume: vi.fn(async () => objective), clear: vi.fn(async () => {}) };
}
async function render(value: MobileObjectiveApi, options: Record<string, unknown> = {}) {
  await act(async () => root.render(createElement(MobileObjectiveSheet, { visible: true, api: value, colors, locale: "en", disabled: false,
    initialText: "Reach the result", onClose() {}, ...options })));
}
async function press(label: string) {
  const button = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(value => value.getAttribute("aria-label") === label);
  expect(button, label).toBeDefined(); await act(async () => button!.click());
}
describe("mobile objective form and source ownership", () => {
  it("keeps edited limits and text after failure and starts once with explicit unlimited no-progress turns", async () => {
    const value = api(), closed = vi.fn(), saved = vi.fn();
    vi.mocked(value.set).mockRejectedValueOnce(new Error("Connection lost"));
    await render(value, { onClose: closed, onSaved: saved });
    await press("Advanced settings"); await press("Maximum turns, Unlimited"); await press("20");
    await press("Turns without progress, 3"); await press("Unlimited"); await press("Start objective");
    expect(host.textContent).toContain("Connection lost"); expect(host.querySelector("textarea")?.value).toBe("Reach the result"); expect(closed).not.toHaveBeenCalled();
    await press("Start objective");
    expect(value.set).toHaveBeenLastCalledWith({ text: "Reach the result", limits: { maximumTurns: 20, tokenBudget: null, noProgressTurnLimit: null } }, expect.any(AbortSignal));
    expect(saved).toHaveBeenCalledTimes(1); expect(closed).toHaveBeenCalledTimes(1);
  });
  it("retires an in-flight submit when the task changes without closing or editing its replacement", async () => {
    const first = api(), second = api("replacement"), saved = vi.fn(), closed = vi.fn();
    let settle: (value: MobileObjective) => void = () => {};
    vi.mocked(first.set).mockImplementation(() => new Promise(resolve => { settle = resolve; }));
    await render(first, { onSaved: saved, onClose: closed });
    await press("Start objective"); await press("Start objective"); expect(first.set).toHaveBeenCalledTimes(1);
    await render(second, { initialText: "New task content", onSaved: saved, onClose: closed });
    await act(async () => settle(objective));
    expect(host.querySelector("textarea")?.value).toBe("New task content"); expect(saved).not.toHaveBeenCalled(); expect(closed).not.toHaveBeenCalled();
    expect(second.set).not.toHaveBeenCalled();
  });
  it("does not treat a failed initial query as absence and restores a form with nonpreset limits on explicit retry", async () => {
    const value = api(); vi.mocked(value.get).mockRejectedValueOnce(new Error("Cannot read objective"));
    vi.mocked(value.restore).mockResolvedValue({ text: "Recovered result", limits: { maximumTurns: 7, tokenBudget: null, noProgressTurnLimit: 2 } });
    await render(value); expect(host.textContent).toContain("Cannot read objective");
    expect(Array.from(host.querySelectorAll("button")).some(button => button.textContent === "Start objective")).toBe(false);
    await press("Check objective status"); expect(host.querySelector("textarea")?.value).toBe("Recovered result");
    await press("Advanced settings"); await press("Maximum turns, 7");
    expect(Array.from(host.querySelectorAll("button")).some(button => button.getAttribute("aria-label") === "7")).toBe(true);
    expect(value.set).not.toHaveBeenCalled();
  });
  it("shows status, progress and pause/resume/clear while read-only tasks cannot mutate", async () => {
    const value = api(); vi.mocked(value.get).mockResolvedValue({ ...objective, turnsUsed: 4, tokensUsed: 123_000 });
    await render(value); expect(host.textContent).toContain("4 / 20 turns · 123K tokens");
    await press("Pause"); expect(value.pause).toHaveBeenCalledTimes(1); await press("Resume"); expect(value.resume).toHaveBeenCalledTimes(1);
    await press("End objective"); expect(value.clear).toHaveBeenCalledTimes(1);
    await render({ ...value, ownerKey: "read-only", writable: false });
    await press("Pause"); expect(value.pause).toHaveBeenCalledTimes(1);
  });
});
