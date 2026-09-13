import { sessionRouteHash } from "./controller.js";

export function desktopDeepLinkRouteHash(
  navigation: Exclude<JokoDesktopDeepLinkNavigation, { readonly kind: "portable" }>
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
