import { describe, expect, it } from "vitest";
import { workspaceRouteLeaveRequest } from "./workspace-document-lifecycle.js";

describe("workspace document route lifecycle", () => {
  it("guards only changes that leave the active document identity", () => {
    const from = { kind: "files", sessionId: "s1", file: "src/a.ts" } as const;
    expect(workspaceRouteLeaveRequest(from, { kind: "files", sessionId: "s1", file: "src/a.ts" })).toBeUndefined();
    expect(workspaceRouteLeaveRequest(from, { kind: "files", sessionId: "s1", file: "src/b.ts" })?.reason).toBe("switch-file");
    expect(workspaceRouteLeaveRequest(from, { kind: "files", sessionId: "s2", file: "src/a.ts" })?.reason).toBe("switch-session");
    expect(workspaceRouteLeaveRequest(from, { kind: "session", sessionId: "s1" })?.reason).toBe("route-change");
    expect(workspaceRouteLeaveRequest({ kind: "session", sessionId: "s1" }, from)).toBeUndefined();
  });

  it("scopes a leave request to the session whose editor is being left", () => {
    const request = workspaceRouteLeaveRequest(
      { kind: "files", sessionId: "s1", file: "a.ts" },
      { kind: "files", sessionId: "s2", file: "a.ts" }
    );
    expect(request?.matches?.({ sessionId: "s1", workspaceId: "w", path: "a.ts" })).toBe(true);
    expect(request?.matches?.({ sessionId: "s2", workspaceId: "w", path: "a.ts" })).toBe(false);
  });
});
