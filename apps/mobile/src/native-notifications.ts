import * as Notifications from "expo-notifications";

import type { NativeNotificationsApi } from "./native-notifications.types";

/** iOS uses the real native module. Metro resolves the `.android.ts` sibling
 * instead on Android, where the first-release product has no push provider. */
const nativeNotifications: NativeNotificationsApi = Notifications;

export default nativeNotifications;
