import { sessionRouteHash, type AppRoute } from "./controller.js";

type RouteDesktopDeepLinkNavigation = Exclude<JokoDesktopDeepLinkNavigation, { readonly kind: "portable" }>;

/** Drops a slower pull response after a newer live delivery was already applied. */
export class DesktopDeepLinkDeliveryOrder {
  #latestOccurrence = 0;

  accept(delivery: JokoDesktopDeepLinkDelivery): JokoDesktopDeepLinkNavigation | undefined {
    if (delivery.deliveryOccurrence <= this.#latestOccurrence) return undefined;
    this.#latestOccurrence = delivery.deliveryOccurrence;
    return delivery.navigation;
  }
}

export function desktopDeepLinkRouteHash(
  navigation: RouteDesktopDeepLinkNavigation
): string {
  if (navigation.kind === "settings") return `#/settings/${navigation.section}`;
  return sessionRouteHash({
    kind: "session",
    sessionId: navigation.sessionId,
    ...(navigation.profileId === undefined ? {} : { profileId: navigation.profileId }),
    ...(navigation.messageId === undefined ? {} : { messageId: navigation.messageId }),
    ...(navigation.messageEventId === undefined ? {} : { messageEventId: navigation.messageEventId })
  });
}

export function desktopDeepLinkAppRoute(navigation: RouteDesktopDeepLinkNavigation): AppRoute {
  if (navigation.kind === "settings") return { kind: "settings" };
  return {
    kind: "session",
    sessionId: navigation.sessionId,
    ...(navigation.profileId === undefined ? {} : { profileId: navigation.profileId }),
    ...(navigation.messageId === undefined ? {} : { messageId: navigation.messageId }),
    ...(navigation.messageEventId === undefined ? {} : { messageEventId: navigation.messageEventId })
  };
}

export function desktopDeepLinkNavigationMatchesRoute(
  navigation: RouteDesktopDeepLinkNavigation,
  route: AppRoute
): boolean {
  if (navigation.kind === "settings") return route.kind === "settings";
  return route.kind === "session"
    && route.sessionId === navigation.sessionId
    && (navigation.profileId === undefined || route.profileId === navigation.profileId)
    && route.messageId === navigation.messageId
    && route.messageEventId === navigation.messageEventId;
}
