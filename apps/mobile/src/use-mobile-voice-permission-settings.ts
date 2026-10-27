import { useEffect } from "react";
import { Alert, Linking } from "react-native";
import type { MobileVoiceRunError } from "./mobile-voice-input";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";

export function useMobileVoicePermissionSettings(error: MobileVoiceRunError | undefined, locale: MobileSupportedLocale): void {
  useEffect(() => {
    if (error?.code !== "permissionBlocked") return;
    Alert.alert(mobileMessage(locale, "voice.permissionTitle"), mobileMessage(locale, "voice.permissionBody"), [
      { text: mobileMessage(locale, "voice.notNow"), style: "cancel" },
      { text: mobileMessage(locale, "voice.openSettings"), onPress: () => {
        void Linking.openSettings().catch(() => {
          Alert.alert(mobileMessage(locale, "voice.settingsUnavailableTitle"), mobileMessage(locale, "voice.settingsUnavailableBody"));
        });
      } }
    ]);
  }, [error, locale]);
}
