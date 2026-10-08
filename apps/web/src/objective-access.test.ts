import { describe, expect, it } from "vitest";

import type { BackendView, SessionView } from "./model.js";
import { objectiveSessionAccess } from "./objective-access.js";

const session: SessionView = {
  id: "task-one",
  backendId: "backend-one",
  targetId: "target-one",
  name: "Task one",
  state: "idle",
  pinned: false,
  archived: false,
  generation: 1n,
  fastMode: false,
  permissionMode: "ask",
  planMode: false,
  updatedAt: 1
};
const backend: BackendView = {
  id: "backend-one",
  name: "Backend",
  version: "1",
  health: "healthy",
  capabilities: new Map([["input.text", { name: "input.text", supported: true, options: [] }]])
};

describe("Objective task-surface admission", () => {
  it("writes only on an ordinary live task and keeps archived or closed tasks display-only", () => {
    expect(access()).toBe("write");
    expect(access({ session: { ...session, archived: true } })).toBe("readOnly");
    expect(access({ session: { ...session, state: "closed" } })).toBe("readOnly");
  });

  it("does not admit Objective RPCs on review, embedded, offline, or unsupported surfaces", () => {
    expect(access({ reviewReadOnly: true })).toBe("hidden");
    expect(access({ embeddedInFiles: true })).toBe("hidden");
    expect(access({ connected: false })).toBe("hidden");
    expect(access({ backend: undefined })).toBe("hidden");
    expect(access({ backend: { ...backend, health: "unavailable" } })).toBe("hidden");
    expect(access({ backend: { ...backend, capabilities: new Map() } })).toBe("hidden");
  });
});

function access(overrides: {
  readonly session?: SessionView;
  readonly backend?: BackendView;
  readonly connected?: boolean;
  readonly reviewReadOnly?: boolean;
  readonly embeddedInFiles?: boolean;
} = {}) {
  return objectiveSessionAccess(overrides.session ?? session, "backend" in overrides ? overrides.backend : backend, {
    connected: overrides.connected ?? true,
    reviewReadOnly: overrides.reviewReadOnly ?? false,
    embeddedInFiles: overrides.embeddedInFiles ?? false
  });
}
