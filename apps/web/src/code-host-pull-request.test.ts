import { describe, expect, it, vi } from "vitest";

import { openCodeHostPullRequestExternal } from "./code-host-pull-request.js";

describe("code-host pull request external navigation", () => {
  it("uses the controller HTTP-only external-link capability with Session ownership", async () => {
    const openHttpLink = vi.fn(async () => undefined);
    await openCodeHostPullRequestExternal(
      { openHttpLink },
      "session-1",
      "https://code.example/acme/widgets/pull/42"
    );
    expect(openHttpLink).toHaveBeenCalledWith(
      "https://code.example/acme/widgets/pull/42",
      { forceExternal: true, sessionId: "session-1" }
    );
  });
});
