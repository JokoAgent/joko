import { useEffect, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Alert, AppState, FlatList, Modal, Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { partnerConnectionsMessages, type PartnerConnectionsEditor, type ConnectionEntry, type ConnectionKind } from "@joko/contracts";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobilePartnersColors } from "./MobilePartnersScreen";
import { MobileKeyboardAvoidingView, useMobileKeyboardState } from "./MobileKeyboardAvoidingView";

export function MobilePartnerConnectionsSheet({ editor, colors, locale, onClose }: {
  readonly editor: PartnerConnectionsEditor; readonly colors: MobilePartnersColors; readonly locale: MobileSupportedLocale; readonly onClose: () => void;
}) {
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot), m = partnerConnectionsMessages(locale);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const keyboard = useMobileKeyboardState(), insets = useSafeAreaInsets();
  useEffect(() => {
    if (AppState.currentState === "active") void editor.refresh(); else editor.suspend();
    const listener = AppState.addEventListener("change", value => { setForeground(value === "active"); if (value === "active") editor.activate(); else editor.suspend(); });
    return () => { listener.remove(); editor.dispose(); };
  }, [editor]);
  const close = async () => {
    if (state.busy) return;
    if (editor.dirty && !await editor.save()) Alert.alert(m.title, m.discardBody, [{ text: m.cancel, style: "cancel" }, { text: m.discard, style: "destructive", onPress: onClose }]);
    else onClose();
  };
  const action = (label: string, onPress: () => void, disabled = false) => <Pressable accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[styles.action, { borderColor: colors.border, backgroundColor: colors.surface }, disabled && styles.disabled]}>
    <Text style={{ color: colors.ink }}>{label}</Text></Pressable>;
  const rows: Array<{ key: string; kind: ConnectionKind; entry?: ConnectionEntry }> = (["skills", "mcp", "toolsets"] as const).flatMap(kind => [
    { key: kind, kind }, ...editor.rows(kind).map(entry => ({ key: `${kind}:${entry.id}`, kind, entry }))
  ]);
  return <Modal visible animationType="slide" presentationStyle="pageSheet" allowSwipeDismissal={false} onRequestClose={() => { void close(); }}>
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={["top", "bottom"]}>
      <MobileKeyboardAvoidingView style={styles.screen} keyboard={keyboard} consumedBottomInset={insets.bottom}>
        <View style={styles.header}>{action(m.close, () => { void close(); }, state.busy)}<Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{m.title}</Text></View>
        <FlatList data={rows} keyExtractor={row => row.key} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}
          ListHeaderComponent={<View style={styles.section}>
            {state.busy && <ActivityIndicator color={colors.accent} accessibilityLabel={m.loading} />}
            {state.error && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{m[state.error]}</Text>}
            {state.saved && <Text accessibilityLiveRegion="polite" style={{ color: colors.ink }}>{m.saved}</Text>}
            {state.detail?.owner.readOnly && <Text style={{ color: colors.muted }}>{m.readonly}</Text>}
            {action(m.refresh, () => { void editor.refresh(); }, !foreground || state.busy)}
            {state.latest && <View style={styles.header}>{action(m.useLatest, () => editor.useLatest(), state.busy)}
              {action(m.keepMine, () => editor.keepMine(), !foreground || state.busy || state.latest.owner.readOnly)}</View>}
            <TextInput accessibilityLabel={m.search} placeholder={m.search} placeholderTextColor={colors.muted} maxLength={200} value={state.query}
              editable={foreground} autoCorrect={false} autoCapitalize="none" onChangeText={query => editor.query(query)}
              style={[styles.input, { color: colors.ink, borderColor: colors.border, backgroundColor: colors.surface }]} />
          </View>}
          renderItem={({ item: row }) => row.entry ? <View style={[styles.row, { borderColor: colors.border }]}>
            <View style={styles.rowText}><Text style={{ color: colors.ink }}>{row.entry.name}</Text>{row.entry.description && <Text style={{ color: colors.muted }}>{row.entry.description}</Text>}{row.entry.personal && <Text style={{ color: colors.muted }}>{m.personal}</Text>}{!row.entry.available && <Text style={{ color: colors.muted }}>{m.unavailable}</Text>}</View>
            <Switch accessibilityLabel={row.entry.name} value={editor.selected(row.entry)} disabled={!foreground || !editor.editable || row.entry.personal || !row.entry.available && !editor.selected(row.entry)}
              onValueChange={value => editor.toggle(row.entry!, value)} />
          </View> : <View style={styles.section}><Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{m[row.kind]}</Text>
            {row.kind !== "skills" && state.draft && <View style={styles.row}><Text style={[styles.rowText, { color: colors.ink }]}>{m.inherit}</Text>
              <Switch accessibilityLabel={`${m[row.kind]} · ${m.inherit}`} value={state.draft[row.kind].mode === "inherit"} disabled={!foreground || !editor.editable}
                onValueChange={value => { if (value) editor.inherit(row.kind); else editor.customize(row.kind); }} /></View>}
            {state.detail && editor.rows(row.kind).length === 0 && <Text style={{ color: colors.muted }}>{m.empty}</Text>}
          </View>}
          ListFooterComponent={action(m.save, () => { void editor.save(); }, !foreground || !editor.editable || !editor.dirty)} />
      </MobileKeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}
const styles = StyleSheet.create({ screen: { flex: 1 }, header: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12 }, title: { fontSize: 18, fontWeight: "600", flexShrink: 1 },
  content: { padding: 16, gap: 12 }, section: { gap: 10 }, row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  rowText: { flex: 1 }, input: { borderWidth: 1, borderRadius: 12, padding: 12, fontSize: 16 }, action: { borderWidth: 1, borderRadius: 12, padding: 12, alignItems: "center" }, disabled: { opacity: .45 } });
