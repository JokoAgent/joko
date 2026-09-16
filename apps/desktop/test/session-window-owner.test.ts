import { describe, expect, it } from "vitest";

import {
  MAXIMUM_SESSION_WINDOWS,
  sessionWindowOwnerKey,
  sessionWindowOwnerMayRequest
} from "../src/session-window-owner.js";

describe("task application-window owner", () => {
  it("keys the inseparable profile and task identity without delimiter collisions", () => {
    expect(sessionWindowOwnerKey({ profileId: "profile-a", sessionId: "task-one" }))
      .not.toBe(sessionWindowOwnerKey({ profileId: "profile-b", sessionId: "task-one" }));
    expect(sessionWindowOwnerKey({ profileId: "a:b", sessionId: "c" }))
      .not.toBe(sessionWindowOwnerKey({ profileId: "a", sessionId: "b:c" }));
  });

  it("allows a primary owner to select a profile but fences child windows to their bound profile", () => {
    const requested = { profileId: "profile-a", sessionId: "task-two" } as const;
    expect(sessionWindowOwnerMayRequest(undefined, requested)).toBe(true);
    expect(sessionWindowOwnerMayRequest({ profileId: "profile-a", sessionId: "task-one" }, requested)).toBe(true);
    expect(sessionWindowOwnerMayRequest({ profileId: "profile-b", sessionId: "task-one" }, requested)).toBe(false);
    expect(MAXIMUM_SESSION_WINDOWS).toBe(32);
  });

  it("rejects malformed owner components before creating a private key", () => {
    expect(() => sessionWindowOwnerKey({ profileId: " profile", sessionId: "task" }))
      .toThrow("Task window owner is invalid.");
    expect(sessionWindowOwnerMayRequest(undefined, { profileId: "profile", sessionId: "" })).toBe(false);
  });
});
