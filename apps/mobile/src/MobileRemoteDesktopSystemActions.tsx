import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import type { RemoteDesktopSystemAction } from "@joko/contracts";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobileRemoteDesktopSnapshot } from "./remote-desktop-controller";
import type { MobileRemoteDesktopColors } from "./MobileRemoteDesktopScreen";
import { mobileRemoteDesktopCopy } from "./remote-desktop-presentation";

export function MobileRemoteDesktopSystemActions({ snapshot, interactive, foreground, routeFocused, online, locale, colors, onAction, onRetry }: {
  readonly snapshot: Pick<MobileRemoteDesktopSnapshot, "capabilities" | "status" | "controlling" | "wantedControl" | "exitStatus" | "displayModeBusy" | "systemActionPending" | "systemActionFailure">;
  readonly interactive: boolean;
  readonly foreground: boolean;
  readonly routeFocused: boolean;
  readonly online: boolean;
  readonly locale: MobileSupportedLocale;
  readonly colors: MobileRemoteDesktopColors;
  readonly onAction: (action: RemoteDesktopSystemAction) => void;
  readonly onRetry: () => void;
}) {
  const copy = mobileRemoteDesktopCopy(locale);
  const actions: RemoteDesktopSystemAction[] = [
    ...(snapshot.capabilities?.workspaceNavigation ? ["workspaceLeft", "workspaceRight"] as const : []),
    ...(snapshot.capabilities?.systemMenu ? ["systemMenu"] as const : [])
  ];
  if (actions.length === 0) return null;
  const disabled = !interactive || !foreground || !routeFocused || !online || snapshot.status !== "live"
    || !snapshot.controlling || !snapshot.wantedControl || snapshot.exitStatus !== "idle" || snapshot.displayModeBusy || snapshot.systemActionPending;
  const button = (label: string, press: () => void) => <Pressable key={label} accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ disabled }} disabled={disabled} onPress={press}
    style={({ pressed }) => [styles.button, { borderColor: colors.border, backgroundColor: colors.surface,
      opacity: disabled ? 0.4 : pressed ? 0.7 : 1 }]}>
    <Text style={[styles.label, { color: colors.ink }]}>{label}</Text>
  </Pressable>;
  return <View>
    <View style={styles.row}>
      {actions.map(action => button(copy[action], () => onAction(action)))}
      {snapshot.systemActionPending && <ActivityIndicator size="small" color={colors.accent} />}
    </View>
    {snapshot.systemActionPending && <Text accessibilityLiveRegion="polite" style={[styles.notice, { color: colors.muted }]}>{copy.systemActionUpdating}</Text>}
    {snapshot.systemActionFailure && <>
      <Text accessibilityRole="alert" style={[styles.notice, { color: colors.negative }]}>{copy[snapshot.systemActionFailure]}: {copy.systemActionFailed}</Text>
      <View style={styles.row}>{button(copy.retry, onRetry)}</View>
    </>}
  </View>;
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: 6 },
  button: { minHeight: 36, minWidth: 52, maxWidth: 160, paddingHorizontal: 11, paddingVertical: 7,
    alignItems: "center", justifyContent: "center", borderWidth: StyleSheet.hairlineWidth, borderRadius: 10 },
  label: { fontSize: 12, lineHeight: 16, textAlign: "center" },
  notice: { fontSize: 12, lineHeight: 17, minHeight: 17, textAlign: "center" }
});
