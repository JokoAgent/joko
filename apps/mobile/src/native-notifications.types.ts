/** The exact expo-notifications surface used by Joko. Keeping it type-only
 * lets the Android platform replacement compile without importing the native
 * notification module at runtime. */
export type NativeNotificationsApi = Pick<
  typeof import("expo-notifications"),
  | "setNotificationHandler"
  | "getPermissionsAsync"
  | "requestPermissionsAsync"
  | "getDevicePushTokenAsync"
  | "addPushTokenListener"
  | "addNotificationResponseReceivedListener"
  | "getLastNotificationResponseAsync"
  | "clearLastNotificationResponseAsync"
>;
