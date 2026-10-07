import { describe, expect, it, vi } from "vitest";

import { DesktopOpenWithDocumentAuthority } from "./desktop-open-with-document.js";

const FIRST_CLAIM = "00000000-0000-4000-8000-000000000001";
const SECOND_CLAIM = "00000000-0000-4000-8000-000000000002";

describe("DesktopOpenWithDocumentAuthority", () => {
  it("rotates on a replacement preload but not a repeated capture or navigation attempt", () => {
    const retired = vi.fn();
    const occurrences = [
      "00000000-0000-4000-8000-000000000011",
      "00000000-0000-4000-8000-000000000012"
    ];
    const endpoint = {};
    const authority = new DesktopOpenWithDocumentAuthority<object>(() => occurrences.shift()!, retired);
    const first = authority.capture(endpoint, FIRST_CLAIM);

    expect(authority.capture(endpoint, FIRST_CLAIM)).toEqual({ current: first.current, created: false });
    expect(authority.requireCurrent(endpoint, first.current.occurrence)).toBe(first.current);
    expect(retired).not.toHaveBeenCalled();

    const second = authority.capture(endpoint, SECOND_CLAIM);
    expect(retired).toHaveBeenCalledExactlyOnceWith(first.current);
    expect(authority.requireCurrent(endpoint, second.current.occurrence)).toBe(second.current);
    expect(() => authority.requireCurrent(endpoint, first.current.occurrence)).toThrow(/current application Document/u);
  });

  it("retires the exact endpoint once and rejects malformed claims or occurrences", () => {
    const retired = vi.fn();
    const endpoint = {};
    const authority = new DesktopOpenWithDocumentAuthority<object>(
      () => "00000000-0000-4000-8000-000000000011",
      retired
    );
    expect(() => authority.capture(endpoint, "renderer-choice")).toThrow(/claim/u);
    const owner = authority.capture(endpoint, FIRST_CLAIM).current;

    authority.retire(endpoint);
    authority.retire(endpoint);

    expect(retired).toHaveBeenCalledExactlyOnceWith(owner);
    expect(() => authority.requireCurrent(endpoint, owner.occurrence)).toThrow(/occurrence/u);
  });
});
