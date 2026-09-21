import { describe, expect, it, vi } from "vitest";
import { observeMobileAttachmentAuthority, waitForMobileAttachmentAuthority } from "./mobile-attachment-authority";
import type { MobileAttachmentControls } from "./mobile-attachments";

const expected = {
  profileId: "profile",
  surfaceOwnerKey: "owner"
};

const controls = {
  ...expected,
  policy: {
    images: true,
    files: false,
    maximumItems: 1,
    maximumBytes: 10,
    imageMediaTypes: ["image/jpeg"],
    fileMediaTypes: []
  }
} satisfies MobileAttachmentControls;

function authorityFixture(initial?: MobileAttachmentControls) {
  let current = initial;
  const listeners = new Set<() => void>();
  const read = vi.fn(() => current);
  const subscribe = vi.fn((listener: () => void) => {
    listeners.add(listener);
    listener();
    return () => { listeners.delete(listener); };
  });
  return {
    read,
    subscribe,
    listeners,
    set(next?: MobileAttachmentControls) {
      current = next;
      for (const listener of listeners) listener();
    }
  };
}

describe("mobile native attachment authority", () => {
  it("preserves an owner only across the transient undefined state of its own native activity", () => {
    expect(observeMobileAttachmentAuthority("owner", undefined, true)).toEqual({
      surfaceOwnerKey: "owner", retired: false
    });
    expect(observeMobileAttachmentAuthority("owner", "owner", true)).toEqual({
      surfaceOwnerKey: "owner", retired: false
    });
    expect(observeMobileAttachmentAuthority("owner", "new-owner", true)).toEqual({
      surfaceOwnerKey: "new-owner", retired: true
    });
    expect(observeMobileAttachmentAuthority("owner", undefined, false)).toEqual({
      surfaceOwnerKey: undefined, retired: true
    });
  });

  it("returns immediately when the exact authority is already current", async () => {
    const fixture = authorityFixture(controls);

    await expect(waitForMobileAttachmentAuthority(expected, fixture.read, fixture.subscribe))
      .resolves.toBe(controls);

    expect(fixture.subscribe).not.toHaveBeenCalled();
  });

  it("waits through a transient foreground gap and releases its subscription on exact recovery", async () => {
    const fixture = authorityFixture();
    const result = waitForMobileAttachmentAuthority(expected, fixture.read, fixture.subscribe);

    expect(fixture.listeners.size).toBe(1);
    fixture.set(controls);

    await expect(result).resolves.toBe(controls);
    expect(fixture.listeners.size).toBe(0);
  });

  it("rejects a restored but different profile or surface owner", async () => {
    const fixture = authorityFixture();
    const result = waitForMobileAttachmentAuthority(expected, fixture.read, fixture.subscribe);

    fixture.set({ ...controls, surfaceOwnerKey: "new-owner" });

    await expect(result).rejects.toThrow(/authority changed/u);
    expect(fixture.listeners.size).toBe(0);
  });

  it("rejects a definitively retired authority without waiting for the timeout", async () => {
    const fixture = authorityFixture();
    let retired = false;
    const result = waitForMobileAttachmentAuthority(expected, fixture.read, fixture.subscribe, {
      retired: () => retired
    });

    retired = true;
    fixture.set(undefined);

    await expect(result).rejects.toThrow(/authority retired/u);
    expect(fixture.listeners.size).toBe(0);
  });

  it("bounds missing recovery and honors explicit cancellation", async () => {
    vi.useFakeTimers();
    try {
      const timed = authorityFixture();
      const timeout = waitForMobileAttachmentAuthority(expected, timed.read, timed.subscribe, { timeoutMs: 25 });
      const timeoutExpectation = expect(timeout).rejects.toThrow(/did not recover/u);
      await vi.advanceTimersByTimeAsync(25);
      await timeoutExpectation;
      expect(timed.listeners.size).toBe(0);

      const canceled = authorityFixture();
      const controller = new AbortController();
      const result = waitForMobileAttachmentAuthority(expected, canceled.read, canceled.subscribe, {
        signal: controller.signal
      });
      controller.abort();
      await expect(result).rejects.toMatchObject({ name: "AbortError" });
      expect(canceled.listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
