// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MobileNativeIntentNotice } from "./MobileNativeIntentNotice";
import { MOBILE_SUPPORTED_LOCALES } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ accessibilityLabel, accessibilityRole, accessibilityLiveRegion, onPress,
    ...props }: Record<string, unknown> & {
      readonly children?: React.ReactNode;
      readonly accessibilityLabel?: string;
      readonly accessibilityRole?: string;
      readonly accessibilityLiveRegion?: string;
      readonly onPress?: () => void;
    }) => React.createElement(tag, {
      ...props,
      ...(accessibilityLabel ? { "aria-label": accessibilityLabel } : {}),
      ...(accessibilityRole ? { role: accessibilityRole } : {}),
      ...(accessibilityLiveRegion ? { "aria-live": accessibilityLiveRegion } : {}),
      ...(onPress ? { onClick: onPress } : {}),
      style: undefined
    }, props.children);
  return {
    Pressable: element("button"),
    StyleSheet: { create: <T,>(value: T) => value },
    Text: element("span")
  };
});

vi.mock("react-native-safe-area-context", async () => {
  const React = await import("react");
  return {
    SafeAreaView: ({ children, accessibilityRole, accessibilityLiveRegion }: {
      readonly children?: React.ReactNode;
      readonly accessibilityRole?: string;
      readonly accessibilityLiveRegion?: string;
    }) => React.createElement("section", {
      ...(accessibilityRole ? { role: accessibilityRole } : {}),
      ...(accessibilityLiveRegion ? { "aria-live": accessibilityLiveRegion } : {})
    }, children)
  };
});

const colors = { surface: "#fff", ink: "#111", border: "#ddd", accent: "#f90" };
let container: HTMLElement;
let root: Root | undefined;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container.remove();
  root = undefined;
  vi.restoreAllMocks();
});

describe("MobileNativeIntentNotice", () => {
  it("renders every recovery in all five locales with an assertive accessible dismissal", async () => {
    for (const locale of MOBILE_SUPPORTED_LOCALES) {
      for (const recovery of ["connection-required", "profile-unavailable", "profile-connect-failed",
        "session-unavailable", "message-unavailable"] as const) {
        const onDismiss = vi.fn();
        await act(async () => root!.render(createElement(MobileNativeIntentNotice, {
          colors,
          locale,
          recovery,
          onDismiss
        })));
        const alert = container.querySelector('[role="alert"]');
        expect(alert?.getAttribute("aria-live")).toBe("assertive");
        expect(alert?.textContent).toContain(mobileMessage(locale, `intent.${recovery === "connection-required"
          ? "connectionRequired" : recovery === "profile-unavailable" ? "profileUnavailable"
            : recovery === "profile-connect-failed" ? "profileConnectFailed"
              : recovery === "session-unavailable" ? "sessionUnavailable" : "messageUnavailable"}`));
        const dismiss = container.querySelector(`button[aria-label="${mobileMessage(locale, "common.dismiss")}"]`);
        expect(dismiss).not.toBeNull();
        await act(async () => (dismiss as HTMLButtonElement).click());
        expect(onDismiss).toHaveBeenCalledOnce();
      }
    }
  });
});
