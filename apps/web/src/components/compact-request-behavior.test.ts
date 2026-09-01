import { describe, expect, it } from "vitest";
import { SessionScopedRequestGuard } from "./compact-request-behavior.js";

describe("manual compact guard", () => {
  it("single-flights a session without blocking another session", () => {
    const guard = new SessionScopedRequestGuard();
    guard.setCurrentSession("a");
    const a = guard.tryBegin("a");
    expect(a).toBeDefined();
    expect(guard.tryBegin("a")).toBeUndefined();

    guard.setCurrentSession("b");
    const b = guard.tryBegin("b");
    expect(b).toBeDefined();
    expect(guard.isInFlight("a")).toBe(false);
    b?.release();
    a?.release();
    expect(guard.isInFlight("a")).toBe(false);
  });

  it("invalidates late confirmations after route-away and route-back", () => {
    const guard = new SessionScopedRequestGuard();
    guard.setCurrentSession("a");
    const stale = guard.tryBegin("a");
    expect(stale).toBeDefined();
    expect(guard.isCurrent("a", stale?.epoch)).toBe(true);

    guard.setCurrentSession(null);
    guard.setCurrentSession("a");
    expect(guard.isCurrent("a", stale?.epoch)).toBe(false);
    const current = guard.tryBegin("a");
    expect(current).toBeDefined();
    stale?.release();
    expect(guard.tryBegin("a")).toBeUndefined();
    current?.release();
    expect(guard.tryBegin("a")).toBeDefined();
  });

  it("makes release idempotent", () => {
    const guard = new SessionScopedRequestGuard();
    guard.setCurrentSession("a");
    const request = guard.tryBegin("a");
    request?.release();
    request?.release();
    expect(guard.tryBegin("a")).toBeDefined();
  });
});
