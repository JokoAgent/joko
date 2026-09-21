import { PermissionStatus } from "expo-modules-core";

import type { NativeNotificationsApi } from "./native-notifications.types";

const EMPTY_SUBSCRIPTION = { remove: () => undefined };
const DENIED: Awaited<ReturnType<NativeNotificationsApi["getPermissionsAsync"]>> = {
  status: PermissionStatus.DENIED,
  expires: "never",
  granted: false,
  canAskAgain: false
};

/** Android deliberately has no real notification module in v1. This fail-closed
 * adapter keeps shared code import-safe without pretending FCM support exists. */
const nativeNotifications: NativeNotificationsApi = {
  setNotificationHandler: () => undefined,
  getPermissionsAsync: async () => DENIED,
  requestPermissionsAsync: async () => DENIED,
  getDevicePushTokenAsync: async () => {
    throw new Error("Task notifications are not supported on Android.");
  },
  addPushTokenListener: () => EMPTY_SUBSCRIPTION,
  addNotificationResponseReceivedListener: () => EMPTY_SUBSCRIPTION,
  getLastNotificationResponseAsync: async () => null,
  clearLastNotificationResponseAsync: async () => undefined
};

export default nativeNotifications;
