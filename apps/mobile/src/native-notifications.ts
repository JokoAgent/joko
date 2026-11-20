import * as Notifications from "expo-notifications";

import type { NativeNotificationsApi } from "./native-notifications.types";

const nativeNotifications: NativeNotificationsApi = Notifications;

export async function prepareAndroidTaskNotificationChannel(name: string): Promise<void> {
  await Notifications.setNotificationChannelAsync("joko-task-attention", {
    name,
    importance: Notifications.AndroidImportance.DEFAULT,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE
  });
}

export default nativeNotifications;
