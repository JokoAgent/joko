import { useRef } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobileRemoteDesktopColors } from "./MobileRemoteDesktopScreen";
import type { MobileRemoteDesktopController, MobileRemoteDesktopKeyPress, MobileRemoteDesktopSnapshot } from "./remote-desktop-controller";
import { mobileRemoteDesktopKeyboardLabel, mobileRemoteDesktopKeyPages, mobileRemoteDesktopModifiers,
  mobileRemoteDesktopShortcuts, type MobileRemoteDesktopKeyCode } from "./remote-desktop-keyboard";
import { mobileRemoteDesktopCopy } from "./remote-desktop-presentation";

export type MobileRemoteDesktopKeyboardController = Pick<MobileRemoteDesktopController, "selectKeyboardMode" | "selectKeyboardPage"
  | "toggleKeyboardCombo" | "toggleKeyboardModifier" | "pressKeyboardKey" | "releaseKeyboardKey" | "closeKeyboard" | "performKeyboardShortcut">;
type Snapshot = Pick<MobileRemoteDesktopSnapshot, "capabilities" | "status" | "controlling" | "wantedControl" | "exitStatus"
  | "displayModeBusy" | "keyboardOpen" | "keyboardMode" | "keyboardPage" | "keyboardCombo" | "keyboardModifiers" | "keyboardOccurrence">;
interface Props {
  readonly snapshot: Snapshot;
  readonly controller: MobileRemoteDesktopKeyboardController;
  readonly locale: MobileSupportedLocale;
  readonly colors: MobileRemoteDesktopColors;
  readonly interactive: boolean;
  readonly foreground: boolean;
  readonly routeFocused: boolean;
  readonly online: boolean;
}
function disabled(props: Props): boolean {
  const snapshot = props.snapshot;
  return !props.interactive || !props.foreground || !props.routeFocused || !props.online || snapshot.status !== "live"
    || !snapshot.controlling || !snapshot.wantedControl || snapshot.exitStatus !== "idle" || snapshot.displayModeBusy;
}

export function MobileRemoteDesktopShortcutTools(props: Props) {
  const copy = mobileRemoteDesktopCopy(props.locale);
  const shortcuts = props.snapshot.capabilities ? mobileRemoteDesktopShortcuts(props.snapshot.capabilities) : [];
  if (!shortcuts.length) return null;
  return <View style={styles.row}>{shortcuts.map(shortcut => <PanelButton key={shortcut.id} label={copy[shortcut.labelKey]}
    colors={props.colors} disabled={disabled(props)} onPress={() => props.controller.performKeyboardShortcut(shortcut.id)} />)}</View>;
}

export function MobileRemoteDesktopKeyboardPanel(props: Props) {
  const { snapshot, controller, colors } = props, copy = mobileRemoteDesktopCopy(props.locale);
  const dimensions = useWindowDimensions();
  if (!snapshot.keyboardOpen) return null;
  const inactive = disabled(props), computer = snapshot.keyboardMode === "computer";
  return <View style={{ maxHeight: dimensions.height * 0.6 }}><ScrollView keyboardShouldPersistTaps="always" contentContainerStyle={styles.panel}>
    <MobileRemoteDesktopShortcutTools {...props} />
    <View style={styles.row}>
      <PanelButton label={copy.inputMethod} colors={colors} disabled={inactive} selected={!computer}
        role="tab" onPress={() => controller.selectKeyboardMode("inputMethod")} />
      <PanelButton label={copy.computerKeyboard} colors={colors} disabled={inactive} selected={computer}
        role="tab" onPress={() => controller.selectKeyboardMode("computer")} />
      <PanelButton label={copy.closeKeyboard} colors={colors} onPress={() => controller.closeKeyboard()} />
    </View>
    {computer && <>
      <View style={styles.row}>
        <PanelButton label={copy.comboMode} colors={colors} disabled={inactive} selected={snapshot.keyboardCombo}
          onPress={() => controller.toggleKeyboardCombo()} />
        {mobileRemoteDesktopModifiers.map(modifier => <KeyboardKey key={`${snapshot.keyboardOccurrence}/${modifier.code}`}
          code={modifier.code} label={mobileRemoteDesktopKeyboardLabel(modifier.code, snapshot.capabilities?.platform)}
          selected={snapshot.keyboardModifiers.includes(modifier.code)} disabled={inactive} colors={colors} controller={controller}
          onTap={snapshot.keyboardCombo ? () => controller.toggleKeyboardModifier(modifier.code) : undefined} />)}
      </View>
      <ScrollView testID="remoteDesktop.keyPageViewport" keyboardShouldPersistTaps="always"
        style={{ maxHeight: dimensions.width > dimensions.height ? 156 : 300 }}>
        <ScrollView horizontal={snapshot.keyboardPage === "abc"} keyboardShouldPersistTaps="always"
          contentContainerStyle={styles.keyRows}>
          <View style={{ width: snapshot.keyboardPage === "abc" ? Math.max(484, dimensions.width - 20) : Math.max(280, dimensions.width - 20), gap: 4 }}>
            {mobileRemoteDesktopKeyPages[snapshot.keyboardPage].map((row, index) => <View key={index} style={styles.keyRow}>
              {row.map((slot, slotIndex) => slot ? <KeyboardKey key={`${snapshot.keyboardOccurrence}/${slot.code}`}
                code={slot.code} label={mobileRemoteDesktopKeyboardLabel(slot.code, snapshot.capabilities?.platform)}
                colors={colors} controller={controller} disabled={inactive} />
                : <View key={`gap-${slotIndex}`} style={styles.emptyKey} pointerEvents="none" />)}
            </View>)}
          </View>
        </ScrollView>
      </ScrollView>
      <View style={styles.row}>
        <PanelButton label="ABC" colors={colors} disabled={inactive} selected={snapshot.keyboardPage === "abc"}
          role="tab" onPress={() => controller.selectKeyboardPage("abc")} />
        <PanelButton label={copy.functionKeys} colors={colors} disabled={inactive} selected={snapshot.keyboardPage === "function"}
          role="tab" onPress={() => controller.selectKeyboardPage("function")} />
      </View>
    </>}
  </ScrollView></View>;
}

function KeyboardKey({ code, label, colors, controller, disabled, selected = false, onTap }: {
  readonly code: MobileRemoteDesktopKeyCode; readonly label: string; readonly colors: MobileRemoteDesktopColors;
  readonly controller: MobileRemoteDesktopKeyboardController; readonly disabled: boolean; readonly selected?: boolean;
  readonly onTap?: () => void;
}) {
  const grant = useRef<MobileRemoteDesktopKeyPress | undefined>(undefined);
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled}
    accessibilityState={{ disabled, selected }} onPress={onTap}
    onPressIn={() => { if (!disabled && !onTap) grant.current = controller.pressKeyboardKey(code); }}
    onPressOut={() => { const captured = grant.current; grant.current = undefined; controller.releaseKeyboardKey(captured); }}
    style={({ pressed }) => [styles.key, { borderColor: selected ? colors.accent : colors.border, backgroundColor: colors.surface,
      opacity: disabled ? 0.4 : pressed ? 0.7 : 1 }]}>
    <Text numberOfLines={1} adjustsFontSizeToFit style={[styles.label, { color: selected ? colors.accent : colors.ink }]}>{label}</Text>
  </Pressable>;
}
function PanelButton({ label, colors, onPress, disabled = false, selected = false, role = "button" }: {
  readonly label: string; readonly colors: MobileRemoteDesktopColors; readonly onPress: () => void;
  readonly disabled?: boolean; readonly selected?: boolean; readonly role?: "button" | "tab";
}) {
  return <Pressable accessibilityRole={role} accessibilityLabel={label} disabled={disabled} accessibilityState={{ disabled, selected }}
    onPress={onPress} style={({ pressed }) => [styles.button, { borderColor: selected ? colors.accent : colors.border,
      backgroundColor: colors.surface, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 }]}>
    <Text style={[styles.label, { color: selected ? colors.accent : colors.ink }]}>{label}</Text>
  </Pressable>;
}
const styles = StyleSheet.create({
  panel: { gap: 6 }, row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: 4 },
  button: { minHeight: 44, paddingHorizontal: 9, paddingVertical: 7, alignItems: "center", justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 10 },
  key: { flex: 1, minWidth: 44, minHeight: 44, paddingHorizontal: 3, alignItems: "center", justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 8 },
  emptyKey: { flex: 1, minWidth: 44, minHeight: 44 }, keyRow: { flexDirection: "row", gap: 4 },
  keyRows: { paddingVertical: 2 }, label: { fontSize: 12, lineHeight: 16, textAlign: "center" }
});
