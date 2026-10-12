import { useEffect, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Alert, AppState, FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { partnerSkillsMessages, type PartnerSkillsEditor } from "@joko/contracts";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobilePartnersColors } from "./MobilePartnersScreen";
import { MobileKeyboardAvoidingView, useMobileKeyboardState } from "./MobileKeyboardAvoidingView";

export function MobilePartnerSkillsSheet({ editor, colors, locale, onClose }: {
  readonly editor: PartnerSkillsEditor; readonly colors: MobilePartnersColors; readonly locale: MobileSupportedLocale; readonly onClose: () => void;
}) {
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot), m = partnerSkillsMessages(locale);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const keyboard = useMobileKeyboardState(), insets = useSafeAreaInsets();
  useEffect(() => {
    if (AppState.currentState === "active") void editor.refresh(); else editor.suspend();
    const listener = AppState.addEventListener("change", value => { setForeground(value === "active");
      if (value === "active") { editor.activate(); void editor.refresh(); } else editor.suspend(); });
    return () => { listener.remove(); editor.dispose(); };
  }, [editor]);
  const close = async (back = false) => {
    if (state.busy) return;
    if (editor.dirty && !await editor.save()) {
      Alert.alert(m.title, m.discardBody, [{ text: m.cancel, style: "cancel" }, { text: m.discard, style: "destructive", onPress: () => {
        if (back) { editor.discard(); if (editor.back()) void editor.refresh(); } else onClose();
      } }]); return;
    }
    if (back) { if (editor.back()) void editor.refresh(); } else onClose();
  };
  const action = (label: string, onPress: () => void, disabled = false, destructive = false) => <Pressable accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[styles.action, { borderColor: colors.border, backgroundColor: colors.surface }, disabled && styles.disabled]}>
    <Text style={{ color: destructive ? colors.negative : colors.ink }}>{label}</Text></Pressable>;
  const notices = <>{state.busy && <ActivityIndicator color={colors.accent} accessibilityLabel={m.loading} />}
    {state.error && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{m[state.error]}</Text>}
    {state.saved && <Text accessibilityLiveRegion="polite" style={{ color: colors.ink }}>{m.saved}</Text>}
    {action(m.refresh, () => { void editor.refresh(); }, !foreground || state.busy)}</>;
  const entry = state.detail, locked = !foreground || !editor.editable;
  return <Modal visible animationType="slide" presentationStyle="pageSheet" allowSwipeDismissal={false} onRequestClose={() => { void close(); }}>
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={["top", "bottom"]}>
      <MobileKeyboardAvoidingView keyboard={keyboard} consumedBottomInset={insets.bottom}>
        <View style={styles.header}>{state.view !== "list" && action(m.back, () => { void close(true); }, state.busy)}
          <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{m.title}</Text>
          {action(m.close, () => { void close(); }, state.busy)}</View>
        {state.view === "list" ? <FlatList data={state.page?.skills ?? []} keyExtractor={item => item.id} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}
          ListHeaderComponent={<View style={styles.section}>{notices}
            <TextInput accessibilityLabel={m.search} placeholder={m.search} placeholderTextColor={colors.muted} maxLength={1_024} value={state.query}
              editable={foreground && !state.busy} autoCorrect={false} autoCapitalize="none" onChangeText={query => editor.query(query)}
              onSubmitEditing={() => { void editor.refresh(); }} style={[styles.input, { color: colors.ink, borderColor: colors.border, backgroundColor: colors.surface }]} />
            {action(m.search, () => { void editor.refresh(); }, !foreground || state.busy)}</View>}
          ListEmptyComponent={!state.busy ? <Text style={{ color: colors.muted }}>{m.empty}</Text> : null}
          ListFooterComponent={state.page?.nextOffset !== undefined ? action(m.more, () => { void editor.refresh(true); }, !foreground || state.busy) : null}
          renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityLabel={item.name} disabled={!foreground || state.busy}
            onPress={() => { void editor.open(item.id); }} style={[styles.row, { borderColor: colors.border }]}>
            <Text style={[styles.name, { color: colors.ink }]}>{item.name}</Text><Text style={{ color: colors.muted }}>{item.description}</Text>
            {!item.enabled && <Text style={{ color: colors.muted }}>{m.disabled}</Text>}
          </Pressable>} /> : <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}><View style={styles.section}>{notices}
            {state.latest && <View accessibilityRole="alert" style={styles.section}><Text selectable style={{ color: colors.ink }}>{state.latest.body}</Text>
              {action(m.useLatest, () => editor.useLatest(), state.busy)}{action(m.keepMine, () => editor.keepMine(), !foreground || state.busy || state.latest.readOnly)}</View>}
            {entry && state.view === "detail" ? <>
              <Text selectable accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{entry.name}</Text>
              <Text selectable style={{ color: colors.muted }}>{entry.description}</Text>
              <Text selectable style={[styles.body, { color: colors.ink }]}>{entry.body}</Text>
              {entry.readOnly ? <Text style={{ color: colors.muted }}>{m.readonly}</Text> : <>
                {action(m.edit, () => editor.edit(), locked)}
                {action(m.remove, () => Alert.alert(m.title, m.removeBody, [{ text: m.cancel, style: "cancel" },
                  { text: m.confirm, style: "destructive", onPress: () => { void editor.remove(); } }]), locked, true)}
              </>}
            </> : state.draft ? <>
              {([ ["name", 64], ["description", 280], ["body", 55_000] ] as const).map(([field, maximum]) => <View key={field} style={styles.section}>
                <Text style={{ color: colors.ink }}>{m[field]}</Text><TextInput accessibilityLabel={m[field]} maxLength={maximum} value={state.draft![field]}
                  multiline={field === "body"} editable={!locked} onChangeText={value => editor.change({ [field]: value })}
                  style={[styles.input, field === "body" && styles.multiline, { color: colors.ink, borderColor: colors.border, backgroundColor: colors.surface }]} />
              </View>)}{action(m.save, () => { void editor.save(); }, locked || !editor.dirty)}
            </> : null}
          </View></ScrollView>}
      </MobileKeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}
const styles = StyleSheet.create({ screen: { flex: 1 }, header: { padding: 16, gap: 12, flexDirection: "row", alignItems: "center" }, content: { padding: 16, gap: 12 },
  section: { gap: 12 }, action: { minHeight: 44, padding: 12, borderWidth: 1, borderRadius: 12, justifyContent: "center" }, disabled: { opacity: 0.45 },
  title: { fontSize: 20, fontWeight: "600", flexShrink: 1 }, name: { fontSize: 16, fontWeight: "600" }, body: { fontSize: 16, lineHeight: 24 },
  input: { minHeight: 44, borderWidth: 1, borderRadius: 12, padding: 12, fontSize: 16 }, multiline: { minHeight: 220, textAlignVertical: "top" },
  row: { minHeight: 76, padding: 12, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, gap: 4 } });
