import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ActivityIndicator, AppState, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MobileTaskOptionsSheet } from "./MobileTaskOptionsSheet";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import { mobileRemoteDesktopCopy } from "./remote-desktop-presentation";
import { MobileTaskHeaderButtons } from "./MobileTaskHeaderChrome";
import { MobileTaskHeaderIcon } from "./MobileTaskHeaderIcon";
import { useMobileAdaptiveWindow } from "./MobileAdaptiveWindow";
import { useMobileNavigationHeader, type MobileNavigationButton } from "./mobile-navigation-header";
import { mobileTaskHeaderLayout, mobileTaskHeaderTitleWidth } from "./mobile-task-header-layout";

export interface MobileTaskHeaderAction {
  readonly id: "rename" | "pin" | "archive" | "delete" | "task-sharing" | "search" | "clone" | "side-chat" | "side-chats" | "side-chat-parent" | "branches" | "context" | "collaboration" | "controls" | "remote-desktop" | "copy-link" | "files" | "refresh" | "tags" | "partner-glance" | "reply-quotes" | `tag:${string}`;
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
  readonly destructive?: boolean;
}

export function MobileTaskHeader({ title, subtitle, navigationLabel, navigationRef, quickSwitch, persistentNavigation,
  onNavigate, actions, titleAccessory, menuHeader, identity, disabled, colors, locale, onMenuVisibilityChange,
  pinned = false, syncing = false, notice, detailsOnly = false, primaryActionsReady = true, drawerMounted = false, selection }: {
  readonly title: string;
  readonly subtitle: string;
  readonly navigationLabel: string;
  readonly navigationRef?: RefObject<View | null>;
  readonly quickSwitch?: { readonly label: string; readonly ref?: RefObject<View | null>; readonly onOpen: () => void };
  readonly persistentNavigation?: boolean;
  readonly onNavigate: () => void;
  readonly actions: readonly MobileTaskHeaderAction[];
  readonly titleAccessory?: ReactNode;
  readonly menuHeader?: ReactNode;
  readonly identity?: { readonly mark: ReactNode; readonly label: string; readonly settingsLabel: string;
    readonly disabled: boolean; readonly onOpen: () => void };
  readonly disabled: boolean;
  readonly colors: { readonly background: string; readonly surface: string; readonly ink: string;
    readonly muted: string; readonly border: string; readonly negative: string; readonly dark?: boolean };
  readonly locale: MobileSupportedLocale;
  readonly onMenuVisibilityChange: (visible: boolean) => void;
  readonly pinned?: boolean;
  readonly syncing?: boolean;
  readonly notice?: string;
  readonly detailsOnly?: boolean;
  readonly primaryActionsReady?: boolean;
  readonly drawerMounted?: boolean;
  readonly selection?: { readonly allSelected: boolean; readonly busy: boolean; readonly onToggleAll: () => void };
}) {
  const [menuVisible, setMenuVisible] = useState(false);
  const [menuGeneration, setMenuGeneration] = useState(0);
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const window = useMobileAdaptiveWindow();
  const layout = mobileTaskHeaderLayout({ platform: Platform.OS, barEdge: window.barEdge, persistent: persistentNavigation === true,
    selection: selection !== undefined, partner: identity !== undefined, drawerMounted });
  const mounted = useRef(true);
  const current = useRef({ actions, disabled, detailsOnly, primaryActionsReady, layout, onNavigate, quickSwitch, persistentNavigation, identity, selection });
  current.current = { actions, disabled, detailsOnly, primaryActionsReady, layout, onNavigate, quickSwitch, persistentNavigation, identity, selection };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const available = (): boolean => mounted.current && AppState.currentState === "active"
    && current.current.layout !== "selection" && current.current.layout !== "hidden";
  const activate = (id: MobileTaskHeaderAction["id"]): void => {
    const latest = current.current;
    if (!available() || latest.disabled || ((id === "files" || id === "remote-desktop") && (latest.detailsOnly || !latest.primaryActionsReady))) return;
    if (latest.detailsOnly && !["collaboration", "search", "copy-link", "refresh"].includes(id)) return;
    const action = latest.actions.find(item => item.id === id);
    if (action && !action.disabled) action.onPress();
  };
  const openMenu = (): void => { if (available() && !current.current.disabled) setMenuVisible(true); };
  const back: MobileNavigationButton = { id: "back", label: navigationLabel, symbol: "chevron.backward", disabled: false,
    onPress: () => { if (available()) current.current.onNavigate(); } };
  const list: MobileNavigationButton | undefined = quickSwitch && !persistentNavigation
    ? { id: "list", label: quickSwitch.label, symbol: "line.3.horizontal", disabled: false,
      onPress: () => { if (available() && !current.current.persistentNavigation) current.current.quickSwitch?.onOpen(); } } : undefined;
  const more: MobileNavigationButton = { id: "more", label: mobileMessage(locale, "task.openActions"), symbol: "ellipsis", disabled, expanded: menuVisible, onPress: openMenu };
  const primary = (id: "files" | "remote-desktop", symbol: string, label: string): MobileNavigationButton => ({ id, label, symbol,
    disabled: disabled || !primaryActionsReady || actions.find(action => action.id === id)?.disabled !== false, onPress: () => activate(id) });
  const trailing = identity || detailsOnly ? [more] : [
    primary("remote-desktop", "desktopcomputer", mobileRemoteDesktopCopy(locale).title),
    primary("files", "folder", mobileMessage(locale, "task.files")), more
  ];
  const titleWidth = mobileTaskHeaderTitleWidth(Math.max(0, window.width - window.insets.left - window.insets.right), !!list, detailsOnly);
  const leading = <View style={styles.leading}>
    {list && <MobileTaskHeaderButtons buttons={[list]} colors={colors} focusRef={quickSwitch?.ref} />}
    <MobileTaskHeaderButtons buttons={[back]} colors={colors} focusRef={navigationRef} />
  </View>;
  const heading = <View style={styles.heading}>
    <View style={[styles.titleRow, Platform.OS === "ios" && styles.centered]}>
      {pinned && <View accessible accessibilityLabel={mobileMessage(locale, "common.pinned")} testID="task.header.pinned">
        <MobileTaskHeaderIcon id="pin" size={14} color={colors.muted} />
      </View>}
      <Text accessibilityRole="header" numberOfLines={1} ellipsizeMode="tail"
        style={[styles.title, { color: colors.ink }, Platform.OS === "ios" && styles.centeredText]}>{title}</Text>
      {titleAccessory && !detailsOnly && <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "taskTags.manage")}
        accessibilityState={{ disabled: actions.find(action => action.id === "tags")?.disabled !== false }}
        disabled={actions.find(action => action.id === "tags")?.disabled !== false} onPress={() => activate("tags")}>{titleAccessory}</Pressable>}
      {syncing && <ActivityIndicator size="small" color={colors.muted} accessibilityLabel={mobileMessage(locale, "task.loading")} />}
    </View>
    {!!(notice || (Platform.OS !== "ios" ? subtitle : "")) && <Text numberOfLines={1} testID="task.header.notice"
      style={[styles.subtitle, { color: colors.muted }, Platform.OS === "ios" && styles.centeredText]}>{notice || subtitle}</Text>}
  </View>;
  const nativeTitle = <View style={{ width: titleWidth, height: 44, minWidth: 0, overflow: "hidden", justifyContent: "center" }}>{heading}</View>;
  const right = <MobileTaskHeaderButtons buttons={trailing} colors={colors} />;
  const port = useMobileNavigationHeader({ mode: layout === "horizontal" || layout === "rail" ? layout : "hidden",
    ink: colors.ink, left: leading, title: nativeTitle, right,
    leading: list ? [list, back] : [back], trailing });
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
  useEffect(() => { if (selection || drawerMounted || disabled) { setMenuVisible(false); setMenuGeneration(value => value + 1); } },
    [selection !== undefined, drawerMounted, disabled]);

  return <>
    {selection ? <View style={styles.selection} testID="task.header.selection">
      <Pressable accessibilityRole="checkbox" accessibilityLabel={mobileMessage(locale, selection.allSelected ? "share.restoreSelection" : "share.selectAll")}
        accessibilityState={{ checked: selection.allSelected, disabled: selection.busy }} disabled={selection.busy}
        onPress={() => { if (mounted.current && AppState.currentState === "active" && current.current.layout === "selection"
          && current.current.selection && !current.current.selection.busy) current.current.selection.onToggleAll(); }} style={styles.selectionButton}>
        <Text style={{ color: selection.busy ? colors.muted : colors.ink }}>{selection.allSelected ? "☑ " : "☐ "}
          {mobileMessage(locale, selection.allSelected ? "share.restoreSelection" : "share.selectAll")}</Text>
      </Pressable>
    </View> : layout === "hidden" ? null : layout === "horizontal" && port.native ?
      <View pointerEvents="none" accessibilityElementsHidden testID="task.header.system-spacer"
        style={{ height: Math.max(0, (port.height || insets.top + 44) - insets.top) }} /> :
    <View style={[styles.header, Platform.OS === "ios" && styles.nativeHeader,
      { backgroundColor: colors.background, borderColor: colors.border }]} testID="task.header.inline">
      {(layout !== "rail" || !port.native) && leading}
      {identity ? <Pressable accessibilityRole="button" accessibilityLabel={identity.label}
        accessibilityHint={identity.settingsLabel} accessibilityState={{ disabled: identity.disabled }} disabled={identity.disabled}
        onPress={() => { if (available() && current.current.identity && !current.current.identity.disabled) current.current.identity.onOpen(); }}
        style={[styles.heading, styles.identity]} testID="partner.header.identity">
        {identity.mark}<View style={styles.heading}>
          <Text accessibilityRole="header" numberOfLines={1} style={[styles.identityTitle, { color: colors.ink }]}>{title}</Text>
          <Text numberOfLines={1} style={[styles.subtitle, { color: colors.muted }]}>{subtitle}</Text>
        </View>
      </Pressable> : heading}
      {identity && <Pressable accessibilityRole="button" accessibilityLabel={identity.settingsLabel}
        accessibilityState={{ disabled: identity.disabled }} disabled={identity.disabled}
        onPress={() => { if (available() && current.current.identity && !current.current.identity.disabled) current.current.identity.onOpen(); }}
        style={[styles.iconButton, identity.disabled && styles.disabled]} testID="partner.header.settings">
        <Text style={[styles.menuIcon, { color: colors.ink }]}>⚙</Text>
      </Pressable>}
      {(layout !== "rail" || !port.native) && right}
    </View>
    }
    <MobileTaskOptionsSheet key={menuGeneration} visible={menuVisible && !disabled && !selection} items={actions.filter(action =>
      detailsOnly ? ["collaboration", "search", "copy-link", "refresh"].includes(action.id) : (action.id !== "files" && action.id !== "remote-desktop") || primaryActionsReady)} colors={colors} locale={locale}
      maximumContentHeight={Math.max(54, height - insets.top - insets.bottom - 100)}
      header={menuHeader}
      cancelAccessibilityLabel={mobileMessage(locale, "task.closeActions")} onClose={() => setMenuVisible(false)}
      onAction={(id) => {
        activate(id as MobileTaskHeaderAction["id"]);
      }} />
  </>;
}

const styles = StyleSheet.create({
  header: { minHeight: 60, paddingHorizontal: 8, paddingVertical: 6, flexDirection: "row", alignItems: "center",
    gap: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  nativeHeader: { minHeight: 52, borderBottomWidth: 0, paddingVertical: 4 },
  leading: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 0 },
  centered: { justifyContent: "center" },
  centeredText: { textAlign: "center" },
  selection: { minHeight: 52, paddingHorizontal: 16, justifyContent: "center" },
  selectionButton: { minHeight: 44, justifyContent: "center", alignSelf: "flex-start" },
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
