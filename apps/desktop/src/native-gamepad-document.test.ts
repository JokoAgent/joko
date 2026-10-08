import { describe, expect, it, vi } from "vitest";

import { DesktopNativeGamepadDocumentAuthority } from "./native-gamepad-document.js";

const FIRST_CLAIM = "00000000-0000-4000-8000-000000000001";
const SECOND_CLAIM = "00000000-0000-4000-8000-000000000002";

describe("DesktopNativeGamepadDocumentAuthority", () => {
  it("retires the previous runtime owner when a new preload captures the same window", () => {
    const retired = vi.fn();
    const occurrences = ["occurrence-one", "occurrence-two"];
    const authority = new DesktopNativeGamepadDocumentAuthority<object>(() => occurrences.shift()!, retired);
    const endpoint = {};
    const first = authority.capture(endpoint, FIRST_CLAIM).current;

    const second = authority.capture(endpoint, SECOND_CLAIM).current;

    expect(second.occurrence).toBe("occurrence-two");
    expect(retired).toHaveBeenCalledExactlyOnceWith(first);
    expect(() => authority.requireCurrent(endpoint, first.occurrence)).toThrow(/current application Document occurrence/u);
    expect(authority.requireCurrent(endpoint, second.occurrence)).toBe(second);
  });

  it("keeps the surviving Document authoritative until another preload actually captures", () => {
    const retired = vi.fn();
    const authority = new DesktopNativeGamepadDocumentAuthority<object>(() => "occurrence-one", retired);
    const endpoint = {};
    const first = authority.capture(endpoint, FIRST_CLAIM);

    const repeated = authority.capture(endpoint, FIRST_CLAIM);

    expect(repeated).toEqual({ current: first.current, created: false });
    expect(authority.requireCurrent(endpoint, first.current.occurrence)).toBe(first.current);
    expect(retired).not.toHaveBeenCalled();
  });

  it("retires the exact current occurrence when its endpoint is gone or a replacement preload is rejected", () => {
    const retired = vi.fn();
    const authority = new DesktopNativeGamepadDocumentAuthority<object>(() => "occurrence-one", retired);
    const endpoint = {};
    const owner = authority.capture(endpoint, FIRST_CLAIM).current;

    authority.retire(endpoint);
    authority.retire(endpoint);

    expect(retired).toHaveBeenCalledExactlyOnceWith(owner);
    expect(() => authority.requireCurrent(endpoint, owner.occurrence)).toThrow(/current application Document occurrence/u);
  });

  it("rejects malformed claims and occurrences", () => {
    const authority = new DesktopNativeGamepadDocumentAuthority<object>(() => "occurrence", vi.fn());
    const endpoint = {};
    expect(() => authority.capture(endpoint, "not-a-v4-claim")).toThrow(/claim/u);
    authority.capture(endpoint, FIRST_CLAIM);
    expect(() => authority.requireCurrent(endpoint, " occurrence")).toThrow(/occurrence/u);
  });
});
