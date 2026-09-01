import { describe, expect, it } from "vitest";

import {
  canOpenExactTurnReview,
  canOpenGeneratedFiles,
  sessionRouteIsCurrent
} from "./SessionPane.js";

describe("task surface capability contract", () => {
  it("fails closed without the exact workspace capability or a writable surface", () => {
    const workspace = { id: "workspace-one" };
    const backend = (name: string, supported: boolean) => ({
      capabilities: new Map([[name, { name, supported, options: [] }]])
    });

    expect(canOpenGeneratedFiles(backend("workspace.generated_files", true), workspace)).toBe(true);
    expect(canOpenGeneratedFiles(backend("workspace.generated_files", false), workspace)).toBe(false);
    expect(canOpenGeneratedFiles({ capabilities: new Map() }, workspace)).toBe(false);
    expect(canOpenGeneratedFiles(backend("workspace.generated_files", true), undefined)).toBe(false);

    expect(canOpenExactTurnReview(backend("workspace.diff.sources", true), workspace, false)).toBe(true);
    expect(canOpenExactTurnReview(backend("workspace.diff.sources", false), workspace, false)).toBe(false);
    expect(canOpenExactTurnReview({ capabilities: new Map() }, workspace, false)).toBe(false);
    expect(canOpenExactTurnReview(backend("workspace.diff.sources", true), undefined, false)).toBe(false);
    expect(canOpenExactTurnReview(backend("workspace.diff.sources", true), workspace, true)).toBe(false);
  });

  it("binds embedded task content to the selected task route", () => {
    expect(sessionRouteIsCurrent({ kind: "files", sessionId: "task-a", file: "README.md" }, "task-a")).toBe(true);
    expect(sessionRouteIsCurrent({ kind: "files", sessionId: "task-b" }, "task-a")).toBe(false);
    expect(sessionRouteIsCurrent({ kind: "session", sessionId: "task-a" }, "task-a")).toBe(true);
    expect(sessionRouteIsCurrent({ kind: "settings" }, "task-a")).toBe(false);
  });
});
