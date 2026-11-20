/** The shared native notification surface used by the device controller. */
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
