import { useRef, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import type { PartnerRestartView } from "@joko/contracts";
import { MobileKeyboardAvoidingView, useMobileKeyboardState } from "./MobileKeyboardAvoidingView";
import { MobilePartnerRestartPanel } from "./MobilePartnerRestartPanel";
import type { MobilePartnerRestartTransport } from "./mobile-partner-restart";
import type { MobilePartnerDirectoryProfile } from "./mobile-partner-directory";
import type { MobilePartnersColors } from "./MobilePartnersScreen";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";

export function MobilePartnerRestartSheet({ partner, transport, colors, locale, onClose, onChanged }: {
  readonly partner: MobilePartnerDirectoryProfile; readonly transport: MobilePartnerRestartTransport;
  readonly colors: MobilePartnersColors; readonly locale: MobileSupportedLocale;
  readonly onClose: () => void; readonly onChanged: (restart?: PartnerRestartView) => void;
}) {
  const [busy, setBusy] = useState(false); const busyRef = useRef(false);
  const keyboard = useMobileKeyboardState(); const insets = useSafeAreaInsets();
  const close = (): void => { if (!busyRef.current) onClose(); };
  return <Modal visible animationType="slide" presentationStyle="pageSheet" allowSwipeDismissal={false} onRequestClose={close}>
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={["top", "bottom"]}>
      <MobileKeyboardAvoidingView style={{ flex: 1 }} keyboard={keyboard} consumedBottomInset={insets.bottom}>
        <View style={{ minHeight: 60, paddingHorizontal: 16, justifyContent: "center" }}>
          <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "common.close")}
            accessibilityState={{ disabled: busy }} disabled={busy} onPress={close}
            style={{ minHeight: 44, justifyContent: "center", opacity: busy ? .5 : 1 }}>
            <Text style={{ color: colors.ink }}>{mobileMessage(locale, "common.close")}</Text>
          </Pressable>
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 28 }}>
          <MobilePartnerRestartPanel transport={transport} partner={partner} colors={colors} locale={locale}
            startConfirming onCancelConfirmation={close} onBusyChange={(value) => { busyRef.current = value; setBusy(value); }}
            onChanged={(restart) => {
              onChanged(restart);
              if (restart?.phase === "ready" && restart.partnerId === partner.partnerId) onClose();
            }} />
        </ScrollView>
      </MobileKeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}
