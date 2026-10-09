import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { AppState, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MobileActionSheet } from "./MobileActionSheet";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";

export interface MobileTaskHeaderAction {
  readonly id: "clone" | "branches" | "context" | "controls" | "remote-desktop" | "copy-link" | "files" | "refresh" | "tags" | `tag:${string}`;
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}

export function MobileTaskHeader({ title, subtitle, navigationLabel, navigationRef, drawerNavigation,
  onNavigate, actions, titleAccessory, identity, disabled, colors, locale, onMenuVisibilityChange }: {
  readonly title: string;
  readonly subtitle: string;
  readonly navigationLabel: string;
  readonly navigationRef?: RefObject<View | null>;
  readonly drawerNavigation: boolean;
  readonly onNavigate: () => void;
  readonly actions: readonly MobileTaskHeaderAction[];
  readonly titleAccessory?: ReactNode;
  readonly identity?: { readonly mark: ReactNode; readonly label: string; readonly settingsLabel: string;
    readonly disabled: boolean; readonly onOpen: () => void };
  readonly disabled: boolean;
  readonly colors: { readonly background: string; readonly surface: string; readonly ink: string;
    readonly muted: string; readonly border: string; readonly negative: string };
  readonly locale: MobileSupportedLocale;
  readonly onMenuVisibilityChange: (visible: boolean) => void;
}) {
  const [menuVisible, setMenuVisible] = useState(false);
  const [menuGeneration, setMenuGeneration] = useState(0);
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") return;
      setMenuVisible(false);
      setMenuGeneration((generation) => generation + 1);
    });
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    onMenuVisibilityChange(menuVisible);
    return () => onMenuVisibilityChange(false);
  }, [menuVisible, onMenuVisibilityChange]);

  return <>
    <View style={[styles.header, { backgroundColor: colors.background, borderColor: colors.border }]}>
      <Pressable ref={navigationRef} accessibilityRole="button" accessibilityLabel={navigationLabel}
        onPress={onNavigate} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
        <Text style={[drawerNavigation ? styles.menuIcon : styles.backIcon, { color: colors.ink }]}>
          {drawerNavigation ? "☰" : "‹"}
        </Text>
      </Pressable>
      {identity ? <Pressable accessibilityRole="button" accessibilityLabel={identity.label}
        accessibilityHint={identity.settingsLabel} accessibilityState={{ disabled: identity.disabled }} disabled={identity.disabled}
        onPress={identity.onOpen} style={[styles.heading, styles.identity]} testID="partner.header.identity">
        {identity.mark}<View style={styles.heading}>
          <Text accessibilityRole="header" numberOfLines={1} style={[styles.identityTitle, { color: colors.ink }]}>{title}</Text>
          <Text numberOfLines={1} style={[styles.subtitle, { color: colors.muted }]}>{subtitle}</Text>
        </View>
      </Pressable> : <View style={styles.heading}>
        <View style={styles.titleRow}><Text accessibilityRole="header" numberOfLines={1} ellipsizeMode="tail"
          style={[styles.title, { color: colors.ink }]}>{title}</Text>{titleAccessory}</View>
        <Text numberOfLines={1} style={[styles.subtitle, { color: colors.muted }]}>{subtitle}</Text>
      </View>}
      {identity && <Pressable accessibilityRole="button" accessibilityLabel={identity.settingsLabel}
        accessibilityState={{ disabled: identity.disabled }} disabled={identity.disabled} onPress={identity.onOpen}
        style={[styles.iconButton, identity.disabled && styles.disabled]} testID="partner.header.settings">
        <Text style={[styles.menuIcon, { color: colors.ink }]}>⚙</Text>
      </Pressable>}
      <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "task.openActions")}
        accessibilityState={{ disabled, expanded: menuVisible }} disabled={disabled}
        onPress={() => { if (AppState.currentState === "active") setMenuVisible(true); }}
        style={({ pressed }) => [styles.iconButton, disabled && styles.disabled, pressed && styles.pressed]}>
        <Text style={[styles.menuIcon, { color: colors.ink }]}>⋯</Text>
      </Pressable>
    </View>
    <MobileActionSheet key={menuGeneration} visible={menuVisible && !disabled} items={actions} colors={colors} locale={locale}
      maximumContentHeight={Math.max(54, height - insets.top - insets.bottom - 100)}
      cancelAccessibilityLabel={mobileMessage(locale, "task.closeActions")} onClose={() => setMenuVisible(false)}
      onAction={(id) => {
        const action = actions.find((item) => item.id === id);
        if (AppState.currentState === "active" && action && !action.disabled) action.onPress();
      }} />
  </>;
}

const styles = StyleSheet.create({
  header: { minHeight: 60, paddingHorizontal: 8, paddingVertical: 6, flexDirection: "row", alignItems: "center",
    gap: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  iconButton: { width: 44, minHeight: 44, flexShrink: 0, alignItems: "center", justifyContent: "center", borderRadius: 22 },
  heading: { flex: 1, minWidth: 0 },
  identity: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44 },
  identityTitle: { fontSize: 16, lineHeight: 22, fontWeight: "600" },
  titleRow: { minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6 },
  title: { minWidth: 0, flexShrink: 1, fontSize: 17, lineHeight: 23, fontWeight: "700" },
  subtitle: { fontSize: 12, lineHeight: 17 },
  backIcon: { fontSize: 32, lineHeight: 36 },
  menuIcon: { fontSize: 25, lineHeight: 30 },
  pressed: { opacity: 0.65 },
  disabled: { opacity: 0.4 }
});
