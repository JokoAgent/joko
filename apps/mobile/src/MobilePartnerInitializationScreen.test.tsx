// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobilePartnerInitializationScreen } from "./MobilePartnerInitializationScreen";
import type { MobilePartnerDirectoryProfile } from "./mobile-partner-directory";
import type { MobilePartnerInitializationTransport } from "./mobile-partner-initialization";
import { profilePartner } from "./test/mobile-partner-profile";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ children, accessibilityLabel, accessibilityRole, disabled, onPress }: {
    children?: ReactNode; accessibilityLabel?: string; accessibilityRole?: string; disabled?: boolean; onPress?: () => void;
  }) => React.createElement(tag, { "aria-label": accessibilityLabel, role: accessibilityRole, disabled, onClick: onPress }, children);
  return { ActivityIndicator: () => React.createElement("span", { role: "progressbar" }),
    Pressable: element("button"), Text: element("span"), View: element("div"),
    StyleSheet: { create: <T,>(value: T) => value, hairlineWidth: 1 } };
});

const colors = { background: "#fff", surface: "#fff", ink: "#111", muted: "#666", border: "#ddd",
  accent: "#f90", negative: "#b00", brandBackground: "#ffe" };
const pending: MobilePartnerDirectoryProfile = { ...profilePartner, initializationState: "pending", invitationStage: "home",
  canonicalSessionId: undefined };
const failed: MobilePartnerDirectoryProfile = { ...pending, initializationState: "error", invitationStage: "failed",
  initializationErrorCode: "sessionUnavailable" };
const prepared = { ...profilePartner, revision: 4n };
const transport = (partner = pending, ownerKey = "owner"): MobilePartnerInitializationTransport => ({ ownerKey,
  load: vi.fn(async () => partner), retry: vi.fn(async () => prepared), open: vi.fn(async () => ({ sessionId: "session" })) });
let root: Root | undefined; let container: HTMLDivElement;
const onBack = vi.fn(); const onOpenTask = vi.fn();
async function render(active?: MobilePartnerInitializationTransport) {
  if (!root) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); }
  await act(async () => root!.render(createElement(MobilePartnerInitializationScreen, { partnerId: "partner-a",
    transport: active, colors, locale: "en", onBack, onOpenTask })));
}
const button = (label: string): HTMLButtonElement => {
  const found = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.getAttribute("aria-label") === label);
  expect(found, label).toBeTruthy(); return found!;
};
async function press(label: string) { await act(async () => button(label).click()); }
afterEach(() => { if (root) act(() => root!.unmount()); container?.remove(); root = undefined;
  onBack.mockReset(); onOpenTask.mockReset(); vi.useRealTimers(); });

describe("MobilePartnerInitializationScreen", () => {
  it("observes pending stages at 2500ms and stops on a read failure while retaining completed progress", async () => {
    vi.useFakeTimers(); const active = transport(); await render(active);
    expect(container.textContent).toContain("Preparing the Partner home");
    vi.mocked(active.load).mockResolvedValueOnce({ ...pending, revision: 3n, invitationStage: "avatar" });
    await act(async () => vi.advanceTimersByTimeAsync(2499)); expect(active.load).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(1)); expect(active.load).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Preparing the avatar");
    vi.mocked(active.load).mockRejectedValueOnce(new Error("offline"));
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(container.textContent).toContain("Preparing the avatar"); expect(container.textContent).toContain("could not be read");
    await act(async () => vi.advanceTimersByTimeAsync(25_000)); expect(active.load).toHaveBeenCalledTimes(3);
    expect(active.retry).not.toHaveBeenCalled(); expect(active.open).not.toHaveBeenCalled();
    await press("Back"); expect(onBack).toHaveBeenCalledOnce();
  });

  it("retries one failed profile once and opens its confirmed conversation once", async () => {
    const active = transport(failed); let finish!: (value: MobilePartnerDirectoryProfile) => void;
    vi.mocked(active.retry).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render(active); expect(container.textContent).toContain("The conversation could not be prepared");
    await act(async () => { button("Retry setup").click(); button("Retry setup").click(); });
    expect(active.retry).toHaveBeenCalledOnce(); expect(active.retry).toHaveBeenCalledWith(failed, expect.any(AbortSignal));
    await act(async () => finish(prepared));
    expect(active.open).toHaveBeenCalledOnce(); expect(active.open).toHaveBeenCalledWith(prepared, expect.any(AbortSignal));
    expect(onOpenTask).toHaveBeenCalledOnce(); expect(onOpenTask).toHaveBeenCalledWith("session");
    await render(active); expect(active.open).toHaveBeenCalledOnce();
  });

  it("keeps an unconfirmed retry visible and requires a deliberate read before any further action", async () => {
    vi.useFakeTimers(); const active = transport(failed);
    vi.mocked(active.retry).mockRejectedValueOnce(new Error("response lost")); await render(active); await press("Retry setup");
    expect(container.textContent).toContain("result is unconfirmed"); expect(button("Retry setup").disabled).toBe(true);
    await press("Retry setup"); await act(async () => vi.advanceTimersByTimeAsync(25_000));
    expect(active.retry).toHaveBeenCalledOnce(); expect(active.load).toHaveBeenCalledOnce();
    vi.mocked(active.load).mockResolvedValueOnce(prepared); await press("Refresh");
    expect(active.retry).toHaveBeenCalledOnce(); expect(active.open).toHaveBeenCalledOnce();
    expect(onOpenTask).toHaveBeenCalledWith("session");
  });

  it("retires old owner retries, hides offline profiles and resumes with a fresh read", async () => {
    const old = transport(failed, "old"); let finish!: (value: MobilePartnerDirectoryProfile) => void;
    vi.mocked(old.retry).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render(old); await press("Retry setup");
    const signal = vi.mocked(old.retry).mock.calls[0]![1];
    await render(undefined); expect(signal.aborted).toBe(true);
    expect(container.textContent).toContain("Reconnect to check"); expect(container.textContent).not.toContain("Getting Ada ready");
    const active = transport({ ...pending, displayName: "New" }, "new"); await render(active);
    await act(async () => finish(prepared)); expect(container.textContent).toContain("Getting New ready");
    expect(active.load).toHaveBeenCalledOnce(); expect(old.open).not.toHaveBeenCalled(); expect(onOpenTask).not.toHaveBeenCalled();
  });

  it("rejects another profile and keeps a failed canonical open retryable without repeated navigation", async () => {
    const active = transport({ ...pending, partnerId: "wrong" }); await render(active);
    expect(container.textContent).toContain("could not be read"); expect(active.open).not.toHaveBeenCalled();
    vi.mocked(active.load).mockResolvedValueOnce(prepared); vi.mocked(active.open).mockRejectedValueOnce(new Error("link changed"));
    await press("Retry"); expect(container.textContent).toContain("prepared task could not be opened");
    await render(active); expect(active.open).toHaveBeenCalledOnce(); expect(onOpenTask).not.toHaveBeenCalled();
    vi.mocked(active.load).mockResolvedValueOnce(prepared); await press("Refresh");
    expect(active.open).toHaveBeenCalledTimes(2); expect(onOpenTask).toHaveBeenCalledOnce();
  });
});
