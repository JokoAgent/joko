import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { MobileRemoteDesktopColors } from "./MobileRemoteDesktopScreen";

export interface MobileRemoteDesktopToolbarAction {
  readonly id: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly disabled?: boolean;
  readonly selected?: boolean;
  readonly onPress: () => void;
}
export interface MobileRemoteDesktopToolbarProps {
  readonly actions: readonly MobileRemoteDesktopToolbarAction[];
  readonly landscape: boolean;
  readonly colors: MobileRemoteDesktopColors;
}
export interface MobileRemoteDesktopPanelProps {
  readonly landscape: boolean;
  readonly colors: MobileRemoteDesktopColors;
  readonly header: ReactNode;
  readonly children: ReactNode;
  readonly page: string;
  readonly closeLabel: string;
  readonly onClose: () => void;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
  readonly toolbarLength: number;
}
export interface MobileRemoteDesktopDisplaySelectorProps {
  readonly displays: readonly { readonly displayId: string; readonly name: string; readonly width: number; readonly height: number }[];
  readonly selectedDisplayId?: string;
  readonly disabled: boolean;
  readonly label: string;
  readonly colors: MobileRemoteDesktopColors;
  readonly onSelect: (id: string) => void;
}

export function MobileRemoteDesktopDisplaySelector(props: MobileRemoteDesktopDisplaySelectorProps) {
  const [expanded, setExpanded] = useState(false);
  const current = props.displays.find(display => display.displayId === props.selectedDisplayId);
  const selectable = props.displays.length > 1 && !props.disabled;
  return <View>
    <Pressable accessibilityRole="button" accessibilityLabel={props.label}
      accessibilityState={{ disabled: !selectable, expanded }} disabled={!selectable}
      onPress={() => setExpanded(value => !value)} style={[styles.displayRow, { borderColor: props.colors.border }]}>
      <View style={{ flex: 1 }}><Text style={{ color: props.colors.ink }}>{current?.name ?? props.label}</Text>
        {current && <Text style={[styles.label, { color: props.colors.muted, textAlign: "left" }]}>{current.width} × {current.height}</Text>}</View>
      {selectable && <Text style={{ color: props.colors.muted }}>{expanded ? "⌄" : "›"}</Text>}
    </Pressable>
    {expanded && <ScrollView style={{ maxHeight: 220 }} keyboardShouldPersistTaps="handled">
      {props.displays.map(display => <Pressable key={display.displayId} accessibilityRole="radio" accessibilityLabel={display.name}
        accessibilityState={{ checked: display.displayId === props.selectedDisplayId, disabled: props.disabled }} disabled={props.disabled}
        onPress={() => { if (display.displayId !== props.selectedDisplayId) props.onSelect(display.displayId); }}
        style={[styles.displayRow, { borderColor: props.colors.border }]}>
        <View style={{ flex: 1 }}><Text style={{ color: props.colors.ink }}>{display.name}</Text>
          <Text style={[styles.label, { color: props.colors.muted, textAlign: "left" }]}>{display.width} × {display.height}</Text></View>
        {display.displayId === props.selectedDisplayId && <Text style={{ color: props.colors.accent }}>✓</Text>}
      </Pressable>)}
    </ScrollView>}
  </View>;
}

export function MobileRemoteDesktopToolbar({ actions, landscape, colors }: MobileRemoteDesktopToolbarProps) {
  return <View testID="remoteDesktop.toolbar" style={[styles.toolbar, landscape && styles.rail,
    { backgroundColor: colors.surface, borderColor: colors.border }]}>
    {(landscape ? [...actions].reverse() : actions).map(action => <Pressable key={action.id}
      testID={`remoteDesktop.toolbar.${action.id}`} accessibilityRole="button" accessibilityLabel={action.label}
      accessibilityState={{ disabled: action.disabled, selected: action.selected }} disabled={action.disabled}
      onPress={action.onPress} style={({ pressed }) => [styles.tool, action.selected && { backgroundColor: `${colors.accent}22` },
        action.disabled && styles.disabled, pressed && styles.pressed]}>
      {action.icon}<Text numberOfLines={2} style={[styles.label, { color: action.selected ? colors.accent : colors.ink }]}>{action.label}</Text>
    </Pressable>)}
  </View>;
}

export function MobileRemoteDesktopPanel(props: MobileRemoteDesktopPanelProps) {
  return <View testID="remoteDesktop.operationsPanel" style={[StyleSheet.absoluteFill,
    props.landscape ? { right: props.right + 76 } : { bottom: props.bottom + 76 }]}>
    <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel={props.closeLabel} onPress={props.onClose} />
    <View accessibilityViewIsModal testID="remoteDesktop.panelSurface" style={[styles.panel,
      { backgroundColor: props.colors.surface, borderColor: props.colors.border }, props.landscape
        ? { top: props.top, bottom: props.bottom, right: 0, width: Math.min(360, props.width - props.left - props.right - 92) }
        : { left: props.left + 8, right: props.right + 8, bottom: 0, maxHeight: Math.max(144, props.height * .6) }]}>
      {props.header}
      <ScrollView key={props.page} testID="remoteDesktop.operations" keyboardShouldPersistTaps="handled"
        style={styles.scroll} contentContainerStyle={{ paddingBottom: props.landscape ? 8 : props.bottom }}>
        {props.children}
      </ScrollView>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  toolbar: { flexDirection: "row", padding: 4, gap: 4, borderWidth: StyleSheet.hairlineWidth, borderRadius: 18 },
  rail: { flexDirection: "column" }, tool: { minWidth: 44, minHeight: 56, maxWidth: 84, flex: 1,
    alignItems: "center", justifyContent: "center", gap: 3, padding: 4, borderRadius: 14 },
  label: { fontSize: 10, lineHeight: 13, textAlign: "center" },
  panel: { position: "absolute", borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, overflow: "hidden" },
  scroll: { flexGrow: 0, minHeight: 0 }, disabled: { opacity: .42 }, pressed: { opacity: .65 },
  displayRow: { minHeight: 52, padding: 8, flexDirection: "row", alignItems: "center", gap: 8, borderBottomWidth: StyleSheet.hairlineWidth }
});
