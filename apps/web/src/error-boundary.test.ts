import { describe, expect, it } from "vitest";
import { AppErrorBoundary, routeErrorBoundaryKey } from "./components/ErrorBoundary.js";

describe("React error boundary", () => {
  it("enters a failed render state without retaining the thrown value", () => {
    expect(AppErrorBoundary.getDerivedStateFromError(new Error("credential-like detail"))).toEqual({ failed: true });
  });

  it("keys route recovery by route and session identity", () => {
    expect(routeErrorBoundaryKey("session", "session-a")).toBe("session:session-a");
    expect(routeErrorBoundaryKey("session", "session-b")).toBe("session:session-b");
    expect(routeErrorBoundaryKey("settings")).toBe("settings:");
  });
});
