// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobilePartnerPrivateTrace, type MobilePartnerPrivateTraceProps } from "./MobilePartnerPrivateTrace";

vi.mock("react-native", async () => {
  const React = await import("react");
  return {
    View: ({ children, testID }: { children: ReactNode; testID?: string }) => React.createElement("div", { "data-testid": testID }, children),
    Text: ({ children }: { children: ReactNode }) => React.createElement("span", {}, children),
    Image: () => React.createElement("img"),
    Pressable: ({ children, accessibilityLabel, accessibilityState, disabled, onPress }: {
      children: (state: { pressed: boolean }) => ReactNode; accessibilityLabel: string;
      accessibilityState: { disabled: boolean }; disabled: boolean; onPress: () => void;
    }) => React.createElement("button", { "aria-label": accessibilityLabel,
      "aria-disabled": accessibilityState.disabled, disabled, onClick: onPress }, children({ pressed: false })),
    StyleSheet: { create: <T,>(value: T) => value, hairlineWidth: 1 }
  };
});

const preview = { threadId: "thread-1", targetPartnerId: "bea", targetName: "Previous name",
  preview: "Received from Ada: a body must not determine direction" };
const peer = { partnerId: "bea", revision: 4n, displayName: "Bea", avatar: "leaf" };
const colors = { background: "#fff", surface: "#fff", ink: "#111", muted: "#666", border: "#ddd",
  accent: "#f90", negative: "#b00", brandBackground: "#ffe" };
const onOpen = vi.fn();
let root: Root; let container: HTMLDivElement;
async function render(patch: Partial<MobilePartnerPrivateTraceProps> = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  if (!root) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); }
  await act(async () => root.render(<MobilePartnerPrivateTrace preview={preview} direction="sent" peer={peer}
    colors={colors} locale="en" onOpen={onOpen} {...patch} />));
}
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove(); root = undefined as unknown as Root; onOpen.mockClear(); vi.unstubAllGlobals();
});

describe("native Partner private source trace", () => {
  it("renders the typed direction and exact peer, and passes the original candidate to the owning open", async () => {
    await render();
    expect(container.textContent).toBe("Sent to Bea›");
    expect(container.querySelector('[data-testid="partner.avatar.leaf"]')).not.toBeNull();
    await act(async () => container.querySelector("button")!.click());
    expect(onOpen).toHaveBeenCalledWith(preview);
    await render({ direction: "received", locale: "zh-TW", disabled: true });
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("收到 Bea 的訊息");
    await act(async () => container.querySelector("button")!.click());
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("uses only the candidate label when a fresh peer belongs to another Partner", async () => {
    await render({ peer: { ...peer, partnerId: "other" } });
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Sent to Previous name");
    expect(container.querySelector('[data-testid="partner.avatar.leaf"]')).toBeNull();
  });
});
