import { useEffect, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Alert, AppState, FlatList, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { partnerMemoryMessages, type PartnerMemoryEditor, type MemorySummary, type PartnerMemoryType } from "@joko/contracts";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobilePartnersColors } from "./MobilePartnersScreen";
import { MobileKeyboardAvoidingView, useMobileKeyboardState } from "./MobileKeyboardAvoidingView";

export function MobilePartnerMemorySheet({ editor, colors, locale, onClose }: {
  readonly editor: PartnerMemoryEditor; readonly colors: MobilePartnersColors; readonly locale: MobileSupportedLocale; readonly onClose: () => void;
}) {
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const m = partnerMemoryMessages(locale); const keyboard = useMobileKeyboardState(); const insets = useSafeAreaInsets();
  useEffect(() => {
    if (AppState.currentState === "active") void editor.refresh(); else editor.suspend();
    const listener = AppState.addEventListener("change", value => { setForeground(value === "active"); if (value === "active") editor.activate(); else editor.suspend(); });
    return () => { listener.remove(); editor.dispose(); };
  }, [editor]);
  const confirmDiscard = (next: () => void) => Alert.alert(m.title, m.discardBody,
    [{ text: m.cancel, style: "cancel" }, { text: m.discard, style: "destructive", onPress: next }]);
  const close = async () => { if (editor.state.busy) return; if (editor.dirty && !await editor.save()) confirmDiscard(onClose); else onClose(); };
  const back = async () => { if (!await editor.back() && editor.dirty) confirmDiscard(() => { editor.discard(); void editor.back(); }); };
  const locked = !foreground || !editor.writable;
  const action = (label: string, onPress: () => void, disabled = false, destructive = false) => <Pressable accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[styles.action, { borderColor: colors.border, backgroundColor: colors.surface }, disabled && styles.disabled]}>
    <Text style={{ color: destructive ? colors.negative : colors.ink }}>{label}</Text></Pressable>;
  const notices = <>
    {state.busy && <ActivityIndicator color={colors.accent} accessibilityLabel={m.loading} />}
    {state.error && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{state.error === "invalid" && state.view === "preferences" ? m.invalidPreferences : m[state.error]}</Text>}
    {state.receipt && <Text accessibilityLiveRegion="polite" style={{ color: colors.ink }}>{m[state.receipt]}</Text>}
  </>;
  const rows: Array<{ key: string; kind: PartnerMemoryType; count: number; entry?: MemorySummary }> = state.catalog?.groups
    .filter(group => group.count > 0).flatMap(group => [{ key: `group:${group.kind}`, kind: group.kind, count: group.count },
      ...group.entries.map(entry => ({ key: `entry:${entry.id}`, kind: group.kind, count: group.count, entry }))]) ?? [];
  const entry = state.detail;
  return <Modal visible animationType="slide" presentationStyle="pageSheet" allowSwipeDismissal={false} onRequestClose={() => { void close(); }}>
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={["top", "bottom"]}>
      <MobileKeyboardAvoidingView style={styles.screen} keyboard={keyboard} consumedBottomInset={insets.bottom}>
        <View style={styles.header}>{action(m.close, () => { void close(); }, state.busy)}<Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{m.title}</Text></View>
        <View style={styles.toolbar}>{state.view !== "list" && action(m.back, () => { void back(); }, state.busy || !!state.pending)}
          {action(m.refresh, () => { void editor.refresh(); }, !foreground || state.busy)}</View>
        {state.view === "list" ? <FlatList data={rows} keyExtractor={row => row.key} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}
          ListHeaderComponent={<View style={styles.section}>{notices}
            <TextInput accessibilityLabel={m.search} placeholder={m.search} placeholderTextColor={colors.muted} maxLength={200} value={state.query}
              editable={foreground} autoCorrect={false} autoCapitalize="none" onChangeText={query => editor.search(query)}
              style={[styles.input, { color: colors.ink, borderColor: colors.border, backgroundColor: colors.surface }]} />
            {state.catalog?.owner.readOnly && <Text style={{ color: colors.muted }}>{m.readonly}</Text>}
            {state.catalog && !state.catalog.owner.memoryEnabled && <Text style={{ color: colors.muted }}>{m.disabled}</Text>}
            {action(m.settings, () => { void editor.openPreferences(); }, !foreground || state.busy || !!state.pending)}
            {state.catalog?.truncated && <Text style={{ color: colors.muted }}>{m.truncated}</Text>}
            {state.catalog && rows.length === 0 && <Text style={{ color: colors.muted }}>{state.query.trim() ? m.noResults : m.empty}</Text>}
          </View>}
          renderItem={({ item: row }) => row.entry ? <Pressable accessibilityRole="button" accessibilityLabel={row.entry.title} disabled={!foreground || state.busy}
            onPress={() => { void editor.open(row.entry!.id); }} style={[styles.row, { borderColor: colors.border, backgroundColor: colors.surface }]}>
            <View style={styles.rowText}><Text numberOfLines={2} style={[styles.body, { color: colors.ink }]}>{row.entry.title}</Text>
              {!!row.entry.preview && <Text numberOfLines={2} style={{ color: colors.muted }}>{row.entry.preview}</Text>}</View>
            <Text style={[styles.date, { color: colors.muted }]}>{new Date(row.entry.updatedAt).toLocaleDateString(locale)}</Text>
          </Pressable> : <Text accessibilityRole="header" style={[styles.group, { color: colors.muted }]}>{m[row.kind]} · {row.count}</Text>} />
          : <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}><View style={styles.section}>{notices}
            {state.view === "preferences" && state.preferencesDraft ? <>
              <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{m.settings}</Text>
              <View style={styles.row}><Text style={[styles.body, { color: colors.ink }]}>{m.enabled}</Text><Switch accessibilityLabel={m.enabled}
                value={state.preferencesDraft.enabled} disabled={locked} onValueChange={enabled => editor.changePreferences({ enabled })} /></View>
              {!state.preferencesDraft.enabled && <Text style={{ color: colors.muted }}>{m.disabled}</Text>}
              {state.latestPreferences && <View accessibilityRole="alert" style={styles.section}><Text selectable style={[styles.body, { color: colors.ink }]}>{state.latestPreferences.userContext}</Text>
                {action(m.useLatest, () => editor.useLatestPreferences(), state.busy)}{action(m.keepMine, () => { void editor.keepPreferences(); }, !foreground || state.busy)}</View>}
              <Text style={{ color: colors.ink }}>{m.userContext}</Text>
              {state.preferencesDraft.userContext.length > 12_000 ? <><Text style={{ color: colors.muted }}>{m.largeContext}</Text>
                <Text selectable style={[styles.body, { color: colors.ink }]}>{state.preferencesDraft.userContext}</Text></>
                : <TextInput accessibilityLabel={m.userContext} value={state.preferencesDraft.userContext} multiline maxLength={12_000} editable={!locked}
                  onChangeText={userContext => editor.changePreferences({ userContext })} style={[styles.input, styles.multiline, { color: colors.ink, borderColor: colors.border, backgroundColor: colors.surface }]} />}
              {action(m.done, () => { void back(); }, locked)}
            </> : state.view === "detail" && entry ? <>
              <Text selectable accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{entry.title}</Text>
              <Text style={{ color: colors.muted }}>{m[entry.kind]} · {new Date(entry.updatedAt).toLocaleString(locale)}</Text>
              <Text selectable style={[styles.body, { color: colors.ink }]}>{entry.body}</Text>
              {entry.owner.readOnly && <Text style={{ color: colors.muted }}>{m.readonly}</Text>}
              {action(m.edit, () => editor.edit(), locked)}
              {action(m.remove, () => Alert.alert(m.title, m.removeBody, [{ text: m.cancel, style: "cancel" }, { text: m.confirm, style: "destructive", onPress: () => { void editor.remove(); } }]), locked, true)}
            </> : state.view === "edit" && state.draft ? <>
              {state.latest && <View accessibilityRole="alert" style={styles.section}><Text selectable style={[styles.body, { color: colors.ink }]}>{state.latest.body}</Text>
                {action(m.useLatest, () => editor.useLatest(), state.busy)}{action(m.keepMine, () => { void editor.keepMine(); }, !foreground || state.busy)}</View>}
              <Text style={{ color: colors.ink }}>{m.titleField}</Text><TextInput accessibilityLabel={m.titleField} maxLength={100} editable={!locked} value={state.draft.title}
                onChangeText={title => editor.change({ title })} style={[styles.input, { color: colors.ink, borderColor: colors.border, backgroundColor: colors.surface }]} />
              <Text style={{ color: colors.ink }}>{m.bodyField}</Text><TextInput accessibilityLabel={m.bodyField} editable={!locked} multiline value={state.draft.body}
                onChangeText={body => editor.change({ body })} style={[styles.input, styles.multiline, { color: colors.ink, borderColor: colors.border, backgroundColor: colors.surface }]} />
              {action(m.done, () => { void back(); }, locked)}
            </> : null}
          </View></ScrollView>}
      </MobileKeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}
const styles = StyleSheet.create({ screen: { flex: 1 }, header: { padding: 16, gap: 12, flexDirection: "row", alignItems: "center" }, toolbar: { paddingHorizontal: 16, gap: 8, flexDirection: "row" },
  content: { padding: 16, gap: 12 }, section: { gap: 12 }, action: { minHeight: 44, padding: 12, borderWidth: 1, borderRadius: 12, justifyContent: "center" },
  disabled: { opacity: 0.45 }, title: { fontSize: 20, fontWeight: "600", flexShrink: 1 }, body: { fontSize: 16, lineHeight: 24 }, group: { fontSize: 14, paddingTop: 16 },
  input: { minHeight: 44, borderWidth: 1, borderRadius: 12, padding: 12, fontSize: 16 }, multiline: { minHeight: 220, textAlignVertical: "top" },
  row: { minHeight: 76, padding: 12, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, flexDirection: "row", gap: 12 }, rowText: { flex: 1, gap: 4 }, date: { fontSize: 12 } });
