import { Pressable, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { mobileMessage } from "./mobile-messages";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobileNativeIntentRecovery } from "./mobile-native-intent";

export interface MobileNativeIntentNoticeProps {
  readonly colors: {
    readonly surface: string;
    readonly ink: string;
    readonly border: string;
    readonly accent: string;
  };
  readonly locale: MobileSupportedLocale;
  readonly recovery: MobileNativeIntentRecovery;
  readonly onDismiss: () => void;
}

export function MobileNativeIntentNotice({ colors, locale, recovery, onDismiss }: MobileNativeIntentNoticeProps) {
  return <SafeAreaView edges={["left", "right", "bottom"]}
    accessibilityRole="alert" accessibilityLiveRegion="assertive"
    style={[styles.notice, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <Text style={[styles.text, { color: colors.ink }]}>{mobileNativeIntentRecoveryText(locale, recovery)}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "common.dismiss")}
      onPress={onDismiss} style={styles.dismiss}>
      <Text style={[styles.dismissText, { color: colors.accent }]}>{mobileMessage(locale, "common.dismiss")}</Text>
    </Pressable>
  </SafeAreaView>;
}

export function mobileNativeIntentRecoveryText(
  locale: MobileSupportedLocale,
  recovery: MobileNativeIntentRecovery
): string {
  switch (recovery) {
    case "connection-required": return mobileMessage(locale, "intent.connectionRequired");
    case "profile-unavailable": return mobileMessage(locale, "intent.profileUnavailable");
    case "profile-connect-failed": return mobileMessage(locale, "intent.profileConnectFailed");
    case "session-unavailable": return mobileMessage(locale, "intent.sessionUnavailable");
    case "message-unavailable": return mobileMessage(locale, "intent.messageUnavailable");
  }
}

const styles = StyleSheet.create({
  notice: {
    marginHorizontal: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 12
  },
  text: { flex: 1, fontSize: 15, lineHeight: 22 },
  dismiss: { minHeight: 44, justifyContent: "center" },
  dismissText: { fontSize: 16, fontWeight: "600" }
});
