import { describe, expect, it, vi } from "vitest";

vi.mock("expo", () => ({ requireOptionalNativeModule: vi.fn(() => null) }));

import {
  parseMobileResourcePressureEvent,
  subscribeMobileResourcePressure
} from "./mobile-resource-pressure";

describe("mobile resource pressure bridge", () => {
  it("accepts only the bounded native event shape", () => {
    expect(parseMobileResourcePressureEvent({ sequence: 1, severity: "warning", platform: "android" }))
      .toEqual({ sequence: 1, severity: "warning", platform: "android" });
    expect(parseMobileResourcePressureEvent({ sequence: 2, severity: "critical", platform: "ios" }))
      .toEqual({ sequence: 2, severity: "critical", platform: "ios" });
    expect(parseMobileResourcePressureEvent({ sequence: 0, severity: "warning", platform: "android" }))
      .toBeUndefined();
    expect(parseMobileResourcePressureEvent({ sequence: 1, severity: "low", platform: "android" }))
      .toBeUndefined();
    expect(parseMobileResourcePressureEvent({ sequence: 1, severity: "warning", platform: "android", memory: 1 }))
      .toBeUndefined();
  });

  it("deduplicates stale native events per subscription and removes the exact listener", () => {
    let nativeListener: ((event: unknown) => void) | undefined;
    const remove = vi.fn();
    const listener = vi.fn();
    const subscription = subscribeMobileResourcePressure(listener, {
      addListener(eventName, next) {
        expect(eventName).toBe("onResourcePressure");
        nativeListener = next;
        return { remove };
      }
    });
    nativeListener?.({ sequence: 2, severity: "critical", platform: "ios" });
    nativeListener?.({ sequence: 2, severity: "critical", platform: "ios" });
    nativeListener?.({ sequence: 1, severity: "warning", platform: "android" });
    nativeListener?.({ sequence: 3, severity: "warning", platform: "android" });
    expect(listener).toHaveBeenCalledTimes(2);
    subscription?.remove();
    expect(remove).toHaveBeenCalledOnce();
  });

  it("fails closed when the native source is unavailable", () => {
    expect(subscribeMobileResourcePressure(() => undefined, null)).toBeUndefined();
  });
});
