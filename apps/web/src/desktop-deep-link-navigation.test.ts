import { describe, expect, it } from "vitest";

import {
  DesktopDeepLinkDeliveryOrder,
  desktopDeepLinkAppRoute,
  desktopDeepLinkNavigationMatchesRoute,
  desktopDeepLinkRouteHash
} from "./desktop-deep-link-navigation.js";

describe("Desktop deep-link navigation", () => {
  it("keeps a copied public source in the route and does not acknowledge the same task on another node", () => {
    const link = { kind: "session", sessionId: "task", serverId: "node-A", messageId: "message" } as const;
    const route = desktopDeepLinkAppRoute(link);
    expect(desktopDeepLinkRouteHash(link)).toBe("#/tasks/task?message=message&server=node-A");
    expect(desktopDeepLinkNavigationMatchesRoute(link, route)).toBe(true);
    expect(desktopDeepLinkNavigationMatchesRoute(link, { ...route, kind: "session", serverId: "node-B" })).toBe(false);
  });

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

  it("binds route acknowledgement to the exact committed task owner", () => {
    const navigation = {
      kind: "session",
      sessionId: "task-one",
      profileId: "machine-one",
      messageId: "message-one",
      messageEventId: "event-one"
    } as const;
    expect(desktopDeepLinkAppRoute(navigation)).toEqual({
      kind: "session",
      sessionId: "task-one",
      profileId: "machine-one",
      messageId: "message-one",
      messageEventId: "event-one"
    });
    expect(desktopDeepLinkNavigationMatchesRoute(navigation, desktopDeepLinkAppRoute(navigation))).toBe(true);
    expect(desktopDeepLinkNavigationMatchesRoute(navigation, {
      kind: "session",
      sessionId: "task-one",
      profileId: "machine-one",
      messageId: "message-one",
      messageEventId: "other-event"
    })).toBe(false);
    expect(desktopDeepLinkNavigationMatchesRoute({ kind: "settings", section: "providers" }, { kind: "settings" })).toBe(true);
  });

  it("does not let a slower pending pull overwrite a newer live delivery", () => {
    const order = new DesktopDeepLinkDeliveryOrder();
    const newer = {
      documentOccurrence: "document-one",
      deliveryOccurrence: 2,
      navigation: { kind: "settings", section: "providers" }
    } as const;
    const older = {
      documentOccurrence: "document-one",
      deliveryOccurrence: 1,
      navigation: { kind: "settings", section: "general" }
    } as const;
    expect(order.accept(newer)).toEqual(newer.navigation);
    expect(order.accept(older)).toBeUndefined();
    expect(order.accept(newer)).toBeUndefined();
  });
});
