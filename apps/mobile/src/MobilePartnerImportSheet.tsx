import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, AppState, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { PartnerImportCategory, PartnerImportStatus, PartnerImportCheckStatus, partnerImportMessages, importCategoryLabel, importCheckLabel, importReasonLabel,
  type PartnerImportEditor, type PartnerImportResult } from "@joko/contracts";
import { MobileKeyboardAvoidingView, useMobileKeyboardState } from "./MobileKeyboardAvoidingView";
import { MobilePartnerPhotoPicker } from "./MobilePartnerPhotoPicker";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobilePartnersColors } from "./MobilePartnersScreen";

const categories = [PartnerImportCategory.PERSONALITY, PartnerImportCategory.MEMORY, PartnerImportCategory.SKILLS, PartnerImportCategory.CONNECTIONS, PartnerImportCategory.AUTOMATIONS];
export function MobilePartnerImportSheet({ editor, colors, locale, onClose, onOpenTask }: {
  readonly editor: PartnerImportEditor; readonly colors: MobilePartnersColors; readonly locale: MobileSupportedLocale;
  readonly onClose: () => void; readonly onOpenTask: (sessionId: string) => void;
}) {
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot); const m = partnerImportMessages(locale);
  const [visible, setVisible] = useState(true); const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [preparing, setPreparing] = useState(false); const completed = useRef<PartnerImportResult | undefined>(undefined);
  const latest = useRef({ onClose, onOpenTask }); latest.current = { onClose, onOpenTask };
  const keyboard = useMobileKeyboardState(); const insets = useSafeAreaInsets();
  useEffect(() => {
    if (AppState.currentState === "active") void editor.load(); const subscription = AppState.addEventListener("change", value => {
      setForeground(value === "active"); if (value === "active") void editor.load(); else editor.suspend();
    }); return () => { subscription.remove(); editor.dispose(); };
  }, [editor]);
  const dismiss = () => {
    const result = completed.current; completed.current = undefined;
    if (!editor.active) return;
    latest.current.onClose(); if (result?.canonicalSessionId) latest.current.onOpenTask(result.canonicalSessionId);
  };
  useEffect(() => { if (!visible && Platform.OS !== "ios") dismiss(); }, [visible]);
  const result = state.result; const saved = new Set(result?.savedEntryIds); const entries = state.preview?.entries ?? [];
  const incomplete = state.preview ? [...state.selected].some(id => !saved.has(id)) : result?.checks.some(check => check.status === PartnerImportCheckStatus.NEEDS_ATTENTION && !saved.has(check.entryId) && check.entryId !== "import");
  const opened = useRef<string | undefined>(undefined);
  const open = async () => {
    if (!visible || !foreground || preparing || state.busy || !result?.saved || !result.canonicalSessionId || opened.current === result.requestId) return;
    opened.current = result.requestId; await editor.release();
    if (editor.active) { completed.current = result; setVisible(false); }
  };
  useEffect(() => { if (foreground && result?.saved && result.canonicalSessionId && !incomplete && !state.busy && result.status !== PartnerImportStatus.RUNNING) void open(); }, [result, incomplete, state.busy, foreground]);
  const locked = editor.locked || preparing || !foreground;
  const action = (label: string, onPress: () => void, disabled = false) => <Pressable accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[styles.action, { borderColor: colors.border, backgroundColor: colors.surface }, disabled && styles.disabled]}>
    <Text style={[styles.body, { color: colors.ink }]}>{label}</Text></Pressable>;
  const body = (value: string, alert = false) => <Text accessibilityRole={alert ? "alert" : undefined} style={[styles.body, { color: alert ? colors.negative : colors.muted }]}>{value}</Text>;
  const controls = (page: number, count: number, details = false) => count > 20 && <View style={styles.row}>
    {action(m.previous, () => editor.page(page - 1, details), page === 0)}{body(`${page + 1} / ${Math.ceil(count / 20)}`)}
    {action(m.next, () => editor.page(page + 1, details), (page + 1) * 20 >= count)}</View>;
  const checkbox = (ids: string[], checked: boolean, label: string, mixed = false) => <Pressable accessibilityRole="checkbox" accessibilityLabel={label}
    accessibilityState={{ checked: mixed ? "mixed" : checked, disabled: locked }} disabled={locked} onPress={() => editor.select(ids, !checked)}
    style={[styles.action, { borderColor: colors.border, backgroundColor: checked || mixed ? colors.brandBackground : colors.surface }, locked && styles.disabled]}>
    <Text style={[styles.body, { color: colors.ink }]}>{checked ? "✓ " : mixed ? "− " : "○ "}{label}</Text></Pressable>;
  const filtered = entries.filter(entry => entry.category === state.category && `${entry.name} ${entry.description ?? ""}`.toLocaleLowerCase().includes(state.query.toLocaleLowerCase()));
  return <Modal visible={visible} animationType="none" presentationStyle="pageSheet" allowSwipeDismissal={false} onDismiss={dismiss}
    onRequestClose={() => { if (!preparing) setVisible(false); }}>
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={["top", "bottom"]}>
      <MobileKeyboardAvoidingView style={styles.screen} keyboard={keyboard} consumedBottomInset={insets.bottom}>
        <View style={styles.header}>{action(m.close, () => setVisible(false), preparing)}<Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{m.title}</Text></View>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {state.error && body(`${importReasonLabel(state.error, m)} ${state.pendingId ? m.unknown : ""}`, true)}
          {!state.hydrated && <ActivityIndicator color={colors.accent} />}
          {state.pendingId ? <>
            {body(result?.status === PartnerImportStatus.RUNNING ? m.running : result?.saved ? incomplete ? m.partial : m.saved : state.absent ? m.absent : m.unknown)}
            {categories.map(category => {
              const group = entries.filter(entry => entry.category === category); return group.length ? <View key={category}>
                {body(`${importCategoryLabel(category, m)} · ${group.filter(entry => saved.has(entry.id)).length} / ${group.filter(entry => state.selected.has(entry.id)).length}`)}</View> : null;
            })}
            {result?.checks.slice(state.detailPage * 20, (state.detailPage + 1) * 20).map(check => <View key={check.entryId} style={styles.section}>
              {body(check.name ?? entries.find(entry => entry.id === check.entryId)?.name ?? m.details)}
              {body(`${importCheckLabel(check.status, m)}${check.message ? ` · ${importReasonLabel(check.message, m)}` : ""}`)}{check.progress && body(`${check.progress.saved} / ${check.progress.total}`)}</View>)}
            {controls(state.detailPage, result?.checks.length ?? 0, true)}
            {action(m.refresh, () => void editor.refresh(), state.busy || !foreground)}
            {state.absent ? action(m.reset, () => void editor.release(), state.busy || !foreground) : result && result.status !== PartnerImportStatus.COMPLETE && <>
              {action(m.retry, () => void editor.retry(), state.busy || !foreground)}{action(m.continueSetup, () => void editor.retry(true), state.busy || !foreground || !result.saved)}</>}
            {result?.canonicalSessionId && action(m.open, () => void open(), state.busy || preparing || !foreground)}
          </> : !state.preview ? <>
            {state.sources?.map(source => <View key={source.id}>{action(source.name, () => void editor.choose(source.id), state.busy || !foreground)}</View>)}
            {state.sources?.length === 0 && body(m.empty)}{state.error && action(m.refresh, () => void editor.load(), state.busy || !foreground)}
          </> : state.category !== undefined ? <>
            {action(m.back, () => editor.filter())}{body(importCategoryLabel(state.category, m))}
            {checkbox(entries.filter(entry => entry.category === state.category).map(entry => entry.id), entries.filter(entry => entry.category === state.category).every(entry => state.selected.has(entry.id)), m.selectAll)}
            <TextInput accessibilityLabel={m.search} placeholder={m.search} placeholderTextColor={colors.muted} value={state.query} onChangeText={query => editor.filter(state.category, query)}
              style={[styles.input, { borderColor: colors.border, backgroundColor: colors.surface, color: colors.ink }]} />
            {filtered.slice(state.page * 20, (state.page + 1) * 20).map(entry => <View key={entry.id} style={styles.section}>
              {checkbox([entry.id], state.selected.has(entry.id), entry.name)}{entry.description && body(entry.description)}
              {entry.enabled === false && body(m.paused)}{entry.exclusiveWith.length > 0 && body(m.conflict)}
              {state.selected.has(entry.id) && entry.dependsOn.some(id => !state.selected.has(id)) && body(m.dependency, true)}
              {entry.issues.map(issue => <View key={issue}>{body(importReasonLabel(issue, m))}</View>)}
            </View>)}{controls(state.page, filtered.length)}
          </> : <>
            {body(m.name)}<TextInput accessibilityLabel={m.name} value={state.name} editable={!locked} maxLength={200} onChangeText={name => editor.edit({ name })}
              style={[styles.input, { borderColor: colors.border, backgroundColor: colors.surface, color: colors.ink }]} />
            <MobilePartnerPhotoPicker key={state.preview.id} value={state.avatarImageBase64 ? { base64: state.avatarImageBase64 } : "orbit"}
              presets={["orbit"]} disabled={locked} colors={colors} locale={locale} onPreparing={setPreparing}
              onChange={value => editor.edit({ avatarImageBase64: typeof value === "string" ? undefined : value.base64 })} />
            {categories.map(category => {
              const group = entries.filter(entry => entry.category === category); if (!group.length) return null;
              const count = group.filter(entry => state.selected.has(entry.id)).length;
              return <View key={category} style={styles.section}>{checkbox(group.map(entry => entry.id), count === group.length, importCategoryLabel(category, m), count > 0 && count < group.length)}
                {action(`${importCategoryLabel(category, m)} · ${count} / ${group.length} ›`, () => editor.filter(category), locked)}</View>;
            })}
            {entries.some(entry => entry.category === PartnerImportCategory.AUTOMATIONS && state.selected.has(entry.id)) && <View style={styles.row}>
              <View style={styles.grow}>{body(m.takeover)}</View><Switch accessibilityLabel={m.takeover} value={state.takeover} disabled={locked} onValueChange={takeover => editor.edit({ takeover })} /></View>}
            {body(m.deferred)}{action(m.submit, () => void editor.start(), locked || !state.name.trim())}
          </>}
        </ScrollView>
      </MobileKeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}
const styles = StyleSheet.create({ screen: { flex: 1 }, header: { flexDirection: "row", alignItems: "center", gap: 12, padding: 16 },
  content: { padding: 16, gap: 14, paddingBottom: 32 }, title: { flex: 1, fontSize: 20, lineHeight: 27, fontWeight: "600" }, body: { fontSize: 15, lineHeight: 22 },
  input: { minHeight: 44, padding: 12, borderWidth: 1, borderRadius: 12, fontSize: 16 }, section: { gap: 8 }, grow: { flex: 1 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }, disabled: { opacity: 0.45 },
  action: { minHeight: 44, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, justifyContent: "center" } });
