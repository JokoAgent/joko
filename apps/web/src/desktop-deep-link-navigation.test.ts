import { describe, expect, it } from "vitest";

import { desktopDeepLinkRouteHash } from "./desktop-deep-link-navigation.js";

describe("Desktop deep-link navigation", () => {
  it("maps a task and its message anchor onto the existing bounded hash route", () => {
    expect(desktopDeepLinkRouteHash({
      kind: "session",
      sessionId: "task / one",
      profileId: "machine-one",
      messageId: "message / one",
      messageEventId: "event / one"
    })).toBe("#/tasks/task%20%2F%20one?event=event+%2F+one&message=message+%2F+one&profile=machine-one");
  });

  it("maps only whitelisted settings sections", () => {
    expect(desktopDeepLinkRouteHash({ kind: "settings", section: "providers" }))
      .toBe("#/settings/providers");
  });
});
