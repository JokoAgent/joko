import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import type { MobileRemoteDesktopColors } from "./MobileRemoteDesktopScreen";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobileRemoteDesktopPipPreferenceState } from "./mobile-remote-desktop-pip-preference";
import { mobileRemoteDesktopCopy } from "./remote-desktop-presentation";

export function MobileRemoteDesktopNativeTools({ colors, locale, preference, disabled, backgroundAvailable, rotation,
  onBackgroundChange, onPreferenceRetry, onRotate }: {
  readonly colors: MobileRemoteDesktopColors;
  readonly locale: MobileSupportedLocale;
  readonly preference: MobileRemoteDesktopPipPreferenceState;
  readonly disabled: boolean;
  readonly backgroundAvailable: boolean;
  readonly rotation: "idle" | "pending" | "failed";
  readonly onBackgroundChange: (enabled: boolean) => void;
  readonly onPreferenceRetry: () => void;
  readonly onRotate: () => void;
}) {
  const copy = mobileRemoteDesktopCopy(locale);
  return <View style={styles.tools}>
    <View style={styles.row}>
      {(backgroundAvailable || preference.enabled) && <Pressable accessibilityRole="switch"
        accessibilityLabel={copy.backgroundViewing} accessibilityState={{ checked: preference.enabled,
          disabled: disabled || preference.saving || preference.status === "loading" }}
        disabled={disabled || preference.saving || preference.status === "loading"}
        onPress={() => onBackgroundChange(!preference.enabled)}
        style={[styles.button, { borderColor: preference.enabled ? colors.accent : colors.border }]}>
        <Text style={{ color: colors.ink }}>{copy.backgroundViewing}</Text>
        {preference.saving && <ActivityIndicator size="small" color={colors.accent} />}
      </Pressable>}
      <Pressable accessibilityRole="button" accessibilityLabel={copy.rotate}
        accessibilityState={{ disabled: disabled || rotation === "pending", busy: rotation === "pending" }}
        disabled={disabled || rotation === "pending"} onPress={onRotate}
        style={[styles.button, { borderColor: colors.border }]}>
        {rotation === "pending" && <ActivityIndicator size="small" color={colors.accent} />}
        <Text style={{ color: colors.ink }}>{rotation === "pending" ? copy.rotating : copy.rotate}</Text>
      </Pressable>
    </View>
    {preference.notice && <View style={styles.row}>
      <Text accessibilityRole="alert" style={[styles.notice, { color: colors.negative }]}>
        {preference.notice === "load-failed" ? copy.backgroundLoadFailed : copy.backgroundSaveFailed}
      </Text>
      {preference.notice === "load-failed" && <Pressable accessibilityRole="button" accessibilityLabel={copy.retry}
        disabled={disabled || preference.saving} onPress={onPreferenceRetry}
        style={[styles.button, { borderColor: colors.border }]}><Text style={{ color: colors.ink }}>{copy.retry}</Text></Pressable>}
    </View>}
    {rotation === "failed" && <Text accessibilityRole="alert" style={[styles.notice, { color: colors.negative }]}>{copy.rotationFailed}</Text>}
  </View>;
}

export interface MobileRemoteDesktopNetworkState {
  readonly transport: "direct" | "relay" | "video" | "screenshot";
  readonly bytesPerSecond: number | null;
  readonly latencyMs: number | null;
}
export function mobileRemoteDesktopNetworkLabel(network: MobileRemoteDesktopNetworkState, locale: MobileSupportedLocale): string {
  const copy = mobileRemoteDesktopCopy(locale);
  const label = network.transport === "direct" ? copy.networkDirect : network.transport === "relay" ? copy.networkRelay
    : network.transport === "screenshot" ? copy.networkScreenshot : copy.networkVideo;
  const rate = network.bytesPerSecond === null ? "" : network.bytesPerSecond >= 1_000_000
    ? `${(network.bytesPerSecond / 1_000_000).toFixed(1)} MB/s` : `${Math.round(network.bytesPerSecond / 1_000)} KB/s`;
  const latency = network.latencyMs === null ? "" : `${Math.round(network.latencyMs)} ms`;
  return [label, rate, latency].filter(Boolean).join(" · ");
}
export function MobileRemoteDesktopNetworkStatus({ network, colors, locale }: {
  readonly network: MobileRemoteDesktopNetworkState;
  readonly colors: MobileRemoteDesktopColors;
  readonly locale: MobileSupportedLocale;
}) {
  const label = mobileRemoteDesktopNetworkLabel(network, locale);
  return <View pointerEvents="none" style={[styles.network, { backgroundColor: `${colors.surface}e8`, borderColor: colors.border }]}>
    <Text accessibilityLabel={label} style={{ color: colors.muted, fontSize: 11 }}>{label}</Text>
  </View>;
}
const styles = StyleSheet.create({
  tools: { gap: 6 }, row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: 6 },
  button: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10,
    paddingHorizontal: 10, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 6 },
  notice: { fontSize: 12, lineHeight: 18, flexShrink: 1 },
  network: { position: "absolute", right: 10, top: 10, maxWidth: "90%", borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8, paddingHorizontal: 7, paddingVertical: 4 }
});
