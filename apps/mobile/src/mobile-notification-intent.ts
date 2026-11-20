import { parseMobileNativeIntent } from "./mobile-native-intent";

const RESPONSE_IDENTITY_MAXIMUM_CHARACTERS = 256;

/** Only public portable task or group URLs enter the native-intent pipeline. */
export function parseMobileNotificationResponseIntent(response: unknown): string | undefined {
  if (!plainObject(response)) return undefined;
  const notification = response.notification;
  if (!plainObject(notification) || !plainObject(notification.request)) return undefined;
  const request = notification.request;
  const contentIntent = plainObject(request.content)
    ? notificationPayloadIntent(request.content.data)
    : undefined;
  const trigger = request.trigger;
  if (contentIntent !== undefined || !plainObject(trigger)) return contentIntent;
  const remoteMessage = trigger.type === "push" && plainObject(trigger.remoteMessage) ? trigger.remoteMessage : undefined;
  return notificationPayloadIntent(trigger.payload) ?? notificationPayloadIntent(remoteMessage?.data);
}

export function mobileNotificationResponseKey(response: unknown, intent: string): string {
  if (plainObject(response) && plainObject(response.notification) && plainObject(response.notification.request)) {
    const identifier = response.notification.request.identifier;
    if (typeof identifier === "string" && identifier.length >= 1
      && identifier.length <= RESPONSE_IDENTITY_MAXIMUM_CHARACTERS
      && identifier === identifier.trim() && !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(identifier)) {
      return `id:${identifier}`;
    }
  }
  return `intent:${intent}`;
}

function notificationPayloadIntent(payload: unknown): string | undefined {
  if (!plainObject(payload) || typeof payload.intent !== "string") return undefined;
  const parsed = parseMobileNativeIntent(payload.intent);
  return (parsed?.kind === "session" || parsed?.kind === "group") && parsed.profileId === undefined ? payload.intent : undefined;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
