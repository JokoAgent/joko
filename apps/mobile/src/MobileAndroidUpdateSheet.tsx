import { useSyncExternalStore } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage, type MobileMessageKey } from "./mobile-messages";
import { mobileAndroidInstaller } from "./mobile-android-installer";
import type { MobileUpdateSurfaceColors } from "./MobileUpdateSurface";

/** Shared by optional and forced updates, outside the business navigation tree. */
export function MobileAndroidUpdateSheet({ colors, locale }: {
  readonly colors: MobileUpdateSurfaceColors;
  readonly locale: MobileSupportedLocale;
}) {
  const insets = useSafeAreaInsets();
  const state = useSyncExternalStore(mobileAndroidInstaller.subscribe, mobileAndroidInstaller.getSnapshot);
  const t = (key: MobileMessageKey, values?: Readonly<Record<string, string | number>>): string =>
    mobileMessage(locale, key, values);
  const busy = state.phase === "permission" || state.phase === "downloading" || state.phase === "installing";
  const status = state.phase === "permission" ? t("updates.android.permissionPending")
    : state.phase === "permission-required" ? t("updates.android.permissionRequired")
      : state.phase === "permission-denied" ? t("updates.android.permissionDenied")
        : state.phase === "error" ? t("updates.android.failed")
          : state.phase === "installing" ? t("updates.android.installing")
            : state.phase === "ready" ? t("updates.android.ready")
              : state.progress === null ? t("updates.android.downloading")
                : t("updates.android.downloadProgress", { percent: Math.floor(state.progress * 100) });
  const permissionNeeded = state.phase === "permission-required" || state.phase === "permission-denied";
  const actionLabel = permissionNeeded ? t("updates.android.grantPermission")
    : state.phase === "ready" ? t("updates.android.install") : t("updates.android.retry");
  return <Modal visible={state.phase !== "idle"} transparent animationType="slide" statusBarTranslucent
    onRequestClose={mobileAndroidInstaller.close}>
    <View style={styles.overlay}>
      <View accessibilityViewIsModal style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border,
        paddingBottom: Math.max(24, insets.bottom + 16) }]}>
        <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{t("updates.prompt.title")}</Text>
        <Text accessibilityLiveRegion="polite" style={[styles.status, { color: colors.ink }]}>{status}</Text>
        {busy ? <ActivityIndicator color={colors.accent} /> : <>
          <InstallButton label={actionLabel} colors={colors} onPress={mobileAndroidInstaller.retry} />
          <InstallButton label={t("updates.android.browser")} colors={colors}
            onPress={() => { void mobileAndroidInstaller.browser(); }} />
        </>}
        <InstallButton label={t(busy ? "updates.android.cancel" : "updates.prompt.later")} colors={colors}
          onPress={mobileAndroidInstaller.close} />
      </View>
    </View>
  </Modal>;
}

function InstallButton({ label, colors, onPress }: {
  readonly label: string;
  readonly colors: MobileUpdateSurfaceColors;
  readonly onPress: () => void;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
    style={({ pressed }) => [styles.button, { borderColor: colors.border }, pressed && styles.pressed]}>
    <Text style={[styles.buttonText, { color: colors.ink }]}>{label}</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.48)" },
  sheet: { gap: 16, padding: 24, paddingBottom: 40, borderWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: 20, borderTopRightRadius: 20 },
  title: { fontSize: 20, fontWeight: "600" },
  status: { fontSize: 15, lineHeight: 22 },
  button: { minHeight: 44, padding: 12, alignItems: "center", justifyContent: "center", borderWidth: 1, borderRadius: 10 },
  buttonText: { fontSize: 15, fontWeight: "600" },
  pressed: { opacity: 0.72 }
});
