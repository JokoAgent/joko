import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { ActivityIndicator, Alert, AppState, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { create } from "@bufbuild/protobuf";
import { RoutineTriggerSchema, RoutineFilterOperator, RoutineSourceStatus, newRoutineTrigger, routineMessages, routineDateInput,
  routineTimestamp, routineMilliseconds, routineTime, validRoutineDraft, type PartnerRoutineEditor, type RoutineTrigger } from "@joko/contracts";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobilePartnersColors } from "./MobilePartnersScreen";
import { MobileKeyboardAvoidingView, useMobileKeyboardState } from "./MobileKeyboardAvoidingView";

export function MobilePartnerRoutineSheet({ editor, colors, locale, onClose }: {
  readonly editor: PartnerRoutineEditor; readonly colors: MobilePartnersColors; readonly locale: MobileSupportedLocale; readonly onClose: () => void;
}) {
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const m = routineMessages(locale); const keyboard = useMobileKeyboardState(); const insets = useSafeAreaInsets();
  useEffect(() => { if (AppState.currentState === "active") void editor.refresh();
    const listener = AppState.addEventListener("change", value => { setForeground(value === "active"); if (value !== "active") editor.suspend(); });
    return () => { listener.remove(); editor.dispose(); };
  }, [editor]);
  useEffect(() => { if (!foreground) return; const timer = setInterval(() => { void editor.observe(); }, 3000); return () => clearInterval(timer); }, [editor, foreground]);
  const confirm = (body: string, action: () => void) => Alert.alert(m.title, body, [{ text: m.back, style: "cancel" }, { text: m.confirm, onPress: action }]);
  const close = () => { if (!state.busy) { if (editor.dirty) confirm(m.discardBody, onClose); else onClose(); } };
  const locked = !foreground || !editor.writable;
  const action = (label: string, onPress: () => void, disabled = false, selected = false) => <Pressable accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ disabled, selected }} disabled={disabled} onPress={onPress} style={[styles.action, { borderColor: colors.border, backgroundColor: selected ? colors.brandBackground : colors.surface }, disabled && styles.disabled]}><Text style={{ color: colors.ink }}>{label}</Text></Pressable>;
  const field = (label: string, value: string, onChangeText: (value: string) => void, multiline = false, numeric = false, maxLength = 100000): ReactNode => <View style={styles.field}>
    <Text style={{ color: colors.ink }}>{label}</Text><TextInput accessibilityLabel={label} value={value} onChangeText={onChangeText} editable={!locked && !state.pendingId}
      multiline={multiline} keyboardType={numeric ? "numeric" : "default"} autoCapitalize="none" autoCorrect={false} maxLength={maxLength}
      style={[styles.input, { color: colors.ink, borderColor: colors.border, backgroundColor: colors.surface }, multiline && styles.multiline]} />
  </View>;
  const draft = state.draft;
  return <Modal visible animationType="slide" presentationStyle="pageSheet" allowSwipeDismissal={false} onRequestClose={close}>
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={["top", "bottom"]}>
      <MobileKeyboardAvoidingView style={styles.screen} keyboard={keyboard} consumedBottomInset={insets.bottom}>
        <View style={styles.header}>{action(m.close, close, state.busy)}<Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{m.title}</Text></View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <Text style={{ color: colors.muted }}>{m.body}</Text>
          <View style={styles.choices}>{action(m.refresh, () => { if (editor.dirty) confirm(m.discardBody, () => { editor.discard(); void editor.refresh(); }); else void editor.refresh(); }, state.busy || !foreground)}
            {action(m.add, () => editor.select(), locked || editor.dirty || !!state.pendingId)}</View>
          {state.busy && <ActivityIndicator color={colors.accent} />}
          {state.error && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{state.error === "pending" ? m.pending : m.failed}</Text>}
          {state.requiresRefresh && <Text style={{ color: colors.muted }}>{m.refreshRequired}</Text>}
          {state.catalog && !state.catalog.writable && <Text style={{ color: colors.muted }}>{m.readonly}</Text>}
          {state.pendingId && <View style={styles.field}><Text style={{ color: colors.ink }}>{m.pending}</Text>
            {action(m.recover, () => void editor.recover(), state.busy || !foreground)}{action(m.retire, () => confirm(m.retireBody, () => void editor.recover(true)), state.busy || !foreground)}</View>}
          {state.catalog?.routines.length === 0 && <Text style={{ color: colors.muted }}>{m.empty}</Text>}
          {state.catalog?.routines.map(routine => <View key={routine.id} style={styles.field}>
            {action(routine.definition?.name ?? "", () => editor.select(routine), state.busy || state.requiresRefresh || editor.dirty, state.selected?.id === routine.id)}
            <View style={styles.choices}><Switch accessibilityLabel={`${routine.definition?.name}: ${m.enabled}`} value={!!routine.definition?.enabled} disabled={locked || editor.dirty} onValueChange={() => void editor.toggle(routine)} />
              <Text style={{ color: colors.ink }}>{m.enabled}{routine.activity !== undefined ? ` · ${m.states[routine.activity] ?? m.states[0]}` : ""}</Text></View>
          </View>)}
          {draft && <View style={styles.field}>
            {field(m.name, draft.name, name => editor.edit({ name }), false, false, 200)}
            {field(m.prompt, draft.prompt, prompt => editor.edit({ prompt }), true)}
            <View style={styles.choices}><Switch accessibilityLabel={m.enabled} value={!!draft.enabled} disabled={locked || !!state.pendingId} onValueChange={enabled => editor.edit({ enabled })} /><Text style={{ color: colors.ink }}>{m.enabled}</Text></View>
            <View style={styles.choices}><Switch accessibilityLabel={m.quiet} value={!!draft.silentWhenIdle} disabled={locked || !!state.pendingId} onValueChange={silentWhenIdle => editor.edit({ silentWhenIdle })} /><Text style={[styles.grow, { color: colors.ink }]}>{m.quiet}</Text></View>
            {field(m.check, draft.preRunHook?.command ?? "", command => editor.edit({ preRunHook: command.trim() ? { $typeName: "joko.v1.RoutinePreRunHook", command, timeoutMs: draft.preRunHook?.timeoutMs } : undefined }), true, false, 32000)}
            <Text style={{ color: colors.muted }}>{m.checkHelp}</Text>
            {draft.preRunHook && field(m.timeout, draft.preRunHook.timeoutMs === undefined ? "" : String(Number(draft.preRunHook.timeoutMs) / 1000), value => editor.edit({ preRunHook: { ...draft.preRunHook!, timeoutMs: value === "" ? undefined : routineMilliseconds(value, 1000) } }), false, true)}
            <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{m.triggers}</Text>
            {draft.triggers.map((trigger, index) => <MobileRoutineTrigger key={`${state.selected?.id ?? "new"}:${trigger.id}`} trigger={trigger} editor={editor} colors={colors} locale={locale} disabled={locked || !!state.pendingId}
              onChange={value => editor.edit({ triggers: draft.triggers.map((item, i) => i === index ? value : item) })} onRemove={() => editor.edit({ triggers: draft.triggers.filter((_, i) => i !== index) })} />)}
            <View style={styles.choices}>{(["cron", "interval", "once", "event"] as const).map(kind => <View key={kind}>{action(`+ ${m[kind]}`, () => editor.edit({ triggers: [...draft.triggers, newRoutineTrigger(kind, editor.api.newRequestId())] }), locked || !!state.pendingId || draft.triggers.length >= 32)}</View>)}</View>
            {action(m.save, () => void editor.save(), locked || !!state.pendingId || !editor.dirty || !validRoutineDraft(draft))}
            {editor.dirty && action(m.discard, () => confirm(m.discardBody, () => editor.discard()), state.busy)}
          </View>}
          {state.selected && <View style={styles.field}>{action(m.run, () => void editor.run(), locked || editor.dirty)}
            {action(m.remove, () => confirm(m.deleteBody, () => void editor.remove()), locked || editor.dirty)}
            {action(m.history, () => void editor.history(), state.busy || state.requiresRefresh || !foreground)}
            {state.runs.length === 0 && <Text style={{ color: colors.muted }}>{m.noHistory}</Text>}
            {state.runs.map(run => <View key={run.id} style={styles.field}><Text style={{ color: colors.ink }}>{m.states[run.status] ?? m.states[0]} · {new Date(routineTime(run.createdAt)).toLocaleString(locale)}</Text>
              {!!(run.error ?? run.resultText) && <Text style={{ color: run.error ? colors.negative : colors.muted }}>{run.error ?? run.resultText}</Text>}</View>)}
            {state.nextOffset !== undefined && action(m.more, () => void editor.history(true), state.busy || state.requiresRefresh || !foreground)}
          </View>}
        </ScrollView>
      </MobileKeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}

function MobileRoutineTrigger({ trigger, editor, colors, locale, disabled, onChange, onRemove }: {
  readonly trigger: RoutineTrigger; readonly editor: PartnerRoutineEditor; readonly colors: MobilePartnersColors; readonly locale: MobileSupportedLocale;
  readonly disabled: boolean; readonly onChange: (trigger: RoutineTrigger) => void; readonly onRemove: () => void;
}) {
  const m = routineMessages(locale); const kind = trigger.kind;
  const [date, setDate] = useState(kind.case === "once" ? routineDateInput(kind.value.at) : "");
  const onceTime = kind.case === "once" ? routineTime(kind.value.at) : NaN;
  useEffect(() => { if (kind.case === "once" && Number.isFinite(onceTime)) setDate(routineDateInput(kind.value.at)); }, [onceTime]);
  const update = (value: RoutineTrigger["kind"]) => onChange(create(RoutineTriggerSchema, { id: trigger.id, kind: value }));
  const source = kind.case === "event" ? editor.state.catalog?.sources.find(item => item.id === kind.value.sourceId) : undefined;
  const action = (label: string, onPress: () => void, selected = false, extraDisabled = false) => <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: disabled || extraDisabled, selected }}
    disabled={disabled || extraDisabled} onPress={onPress} style={[styles.action, { borderColor: colors.border, backgroundColor: selected ? colors.brandBackground : colors.surface }, disabled && styles.disabled]}><Text style={{ color: colors.ink }}>{label}</Text></Pressable>;
  const field = (label: string, value: string, onChangeText: (value: string) => void, numeric = false, maxLength = 128) => <View style={styles.field}><Text style={{ color: colors.ink }}>{label}</Text>
    <TextInput accessibilityLabel={label} value={value} editable={!disabled} onChangeText={onChangeText} keyboardType={numeric ? "numeric" : "default"} autoCapitalize="none" autoCorrect={false} maxLength={maxLength} style={[styles.input, { color: colors.ink, backgroundColor: colors.surface, borderColor: colors.border }]} /></View>;
  return <View style={[styles.trigger, { borderColor: colors.border }]}><Text style={[styles.title, { color: colors.ink }]}>{kind.case && m[kind.case]}</Text>
    {kind.case === "cron" && <>{field(m.expression, kind.value.expression, expression => update({ case: "cron", value: { ...kind.value, expression } }))}{field(m.timezone, kind.value.timezone, timezone => update({ case: "cron", value: { ...kind.value, timezone } }))}</>}
    {kind.case === "interval" && field(m.minutes, String(Number(kind.value.intervalMs) / 60000), value => update({ case: "interval", value: { ...kind.value, intervalMs: routineMilliseconds(value, 60000) } }), true)}
    {kind.case === "once" && field(`${m.at} (YYYY-MM-DDTHH:mm)`, date, value => { setDate(value); update({ case: "once", value: { ...kind.value, at: routineTimestamp(value) } }); })}
    {kind.case === "event" && <><Text style={{ color: colors.ink }}>{m.source}</Text>
      {!source && <Text style={{ color: colors.muted }}>{kind.value.sourceId ? `${kind.value.sourceId} · ${m.sourceOffline}` : m.sourceMissing}</Text>}
      <View style={styles.choices}>{editor.state.catalog?.sources.map(item => <View key={item.id}>{action(`${item.name} · ${item.status === RoutineSourceStatus.LISTENING ? m.listening : m.sourceOffline}`, () => update({ case: "event", value: { ...kind.value, sourceId: item.id, eventType: "", filters: [] } }), item.id === kind.value.sourceId)}</View>)}</View>
      <Text style={{ color: colors.ink }}>{m.eventType}</Text>{kind.value.eventType && !source?.events.some(item => item.type === kind.value.eventType) && <Text style={{ color: colors.muted }}>{kind.value.eventType}</Text>}
      <View style={styles.choices}>{source?.events.map(item => <View key={item.type}>{action(item.name, () => update({ case: "event", value: { ...kind.value, eventType: item.type, filters: [] } }), item.type === kind.value.eventType)}</View>)}</View>
      <Text style={{ color: colors.ink }}>{m.filters}</Text>{kind.value.filters.map((filter, index) => <View key={index} style={styles.field}>
        {field(m.field, filter.field, value => update({ case: "event", value: { ...kind.value, filters: kind.value.filters.map((item, i) => i === index ? { ...item, field: value } : item) } }))}
        <View style={styles.choices}>{["subject", ...source?.events.find(item => item.type === kind.value.eventType)?.fields ?? []].map(name => <View key={name}>{action(name,
          () => update({ case: "event", value: { ...kind.value, filters: kind.value.filters.map((item, i) => i === index ? { ...item, field: name } : item) } }), filter.field === name)}</View>)}</View>
        <View style={styles.choices}>{([RoutineFilterOperator.EQUALS, RoutineFilterOperator.NOT_EQUALS, RoutineFilterOperator.CONTAINS]).map(operator => <View key={operator}>{action(operator === RoutineFilterOperator.CONTAINS ? m.contains : operator === RoutineFilterOperator.NOT_EQUALS ? `≠ ${m.equals}` : m.equals,
          () => update({ case: "event", value: { ...kind.value, filters: kind.value.filters.map((item, i) => i === index ? { ...item, operator } : item) } }), filter.operator === operator)}</View>)}</View>
        {field(m.value, filter.value, value => update({ case: "event", value: { ...kind.value, filters: kind.value.filters.map((item, i) => i === index ? { ...item, value } : item) } }), false, 2000)}
        {action(`× ${m.filters}`, () => update({ case: "event", value: { ...kind.value, filters: kind.value.filters.filter((_, i) => i !== index) } }))}
      </View>)}{action(m.addFilter, () => update({ case: "event", value: { ...kind.value, filters: [...kind.value.filters, { $typeName: "joko.v1.RoutineEventFilter", field: "", operator: RoutineFilterOperator.EQUALS, value: "" }] } }), false, kind.value.filters.length >= 16)}</>}
    {action(m.removeTrigger, onRemove)}
  </View>;
}

const styles = StyleSheet.create({ screen: { flex: 1 }, grow: { flex: 1 }, header: { minHeight: 60, padding: 12, flexDirection: "row", alignItems: "center", gap: 12 },
  title: { fontSize: 18, lineHeight: 26, fontWeight: "600" }, content: { padding: 16, paddingBottom: 28, gap: 16 }, field: { gap: 10 },
  choices: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }, input: { minHeight: 44, borderWidth: 1, borderRadius: 12, padding: 12, fontSize: 16, lineHeight: 23 },
  multiline: { minHeight: 100, textAlignVertical: "top" }, trigger: { gap: 12, padding: 12, borderWidth: 1, borderRadius: 12 },
  action: { minHeight: 44, padding: 12, borderWidth: 1, borderRadius: 12, justifyContent: "center", alignItems: "center" }, disabled: { opacity: .45 } });
