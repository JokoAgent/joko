import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Alert, AppState, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { PartnerGlanceTodos, PartnerTaskOutputReadiness, partnerAutonomyMessages, partnerTodoDate, partnerTodoDue,
  type PartnerAutonomyApi, type PartnerAutonomySettings, type PartnerAutonomySettingChoice, type PartnerTaskOutput, type PartnerTodo, partnerMutationWasRejected } from "@joko/contracts";
import { partnerHomeMessages, type PartnerHomeApi, type ListPartnerHomeTargetsResponse } from "@joko/contracts";
import type { MobilePartnersColors } from "./MobilePartnersScreen";
import type { MobileSupportedLocale } from "./mobile-locale-preference";

/** Native counterpart of the final computer / affairs / outputs glance entry. */
export function MobilePartnerGlanceSheet({ api, homeApi, partnerId, name, visible, engaged, colors, locale, onClose, onQuote, onOpenTask, onHomeSettings }: {
  readonly api: PartnerAutonomyApi; readonly partnerId: string; readonly name: string; readonly visible: boolean; readonly engaged: boolean;
  readonly homeApi?: PartnerHomeApi;
  readonly colors: MobilePartnersColors; readonly locale: MobileSupportedLocale; readonly onClose: () => void;
  readonly onQuote: (todo: PartnerTodo) => void; readonly onOpenTask: (sessionId: string) => void; readonly onHomeSettings: () => void;
}) {
  const m = partnerAutonomyMessages(locale), editor = useMemo(() => new PartnerGlanceTodos(api, partnerId), [api, partnerId]);
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot), alive = useRef(true), flights = useRef(new Set<AbortController>()), askEpoch = useRef(0);
  const [settings, setSettings] = useState<PartnerAutonomySettings>(), [failed, setFailed] = useState(false), [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false), [showDone, setShowDone] = useState(false), [outputs, setOutputs] = useState<readonly PartnerTaskOutput[]>([]);
  const [outputFailed, setOutputFailed] = useState(false), [refresh, setRefresh] = useState(0);
  const [home, setHome] = useState<ListPartnerHomeTargetsResponse>(), [homeFailed, setHomeFailed] = useState(false);
  const attempt = useRef<{ readonly id: string; readonly revision: bigint; readonly choice: PartnerAutonomySettingChoice } | undefined>(undefined);
  const pending = useRef<(() => void) | undefined>(undefined), current = useRef({ visible, api, onQuote, onOpenTask, onHomeSettings });
  current.current = { visible, api, onQuote, onOpenTask, onHomeSettings };
  const deliver = () => { const action = pending.current; pending.current = undefined; if (action && alive.current && !current.current.visible
    && current.current.api === api && AppState.currentState === "active") action(); };
  const afterClose = (action: () => void) => { pending.current = action; onClose(); };
  const invoke = async <T,>(action: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> => {
    const abort = new AbortController(); flights.current.add(abort);
    try { const result = await action(abort.signal); return alive.current && !abort.signal.aborted && AppState.currentState === "active" ? result : undefined; }
    finally { flights.current.delete(abort); }
  };
  const readSettings = async () => {
    try { const value = await invoke(signal => api.settings(signal)); if (value) { setSettings(value); setFailed(false); } }
    catch { if (alive.current) setFailed(true); }
  };
  useEffect(() => {
    alive.current = true; if (AppState.currentState === "active") { editor.activate(); void readSettings(); }
    const subscription = AppState.addEventListener("change", value => {
      askEpoch.current++; pending.current = undefined;
      if (value === "active") { editor.activate(); void readSettings(); }
      else { editor.suspend(); for (const abort of flights.current) abort.abort(); }
    });
    return () => { alive.current = false; askEpoch.current++; pending.current = undefined; subscription.remove(); editor.dispose(); for (const abort of flights.current) abort.abort(); };
  }, [api, editor]);
  useEffect(() => { if (!visible && Platform.OS === "android" && pending.current) { const frame = requestAnimationFrame(deliver); return () => cancelAnimationFrame(frame); } }, [visible]);
  useEffect(() => {
    if (!visible) { askEpoch.current++; return; }
    let active = true; const abort = new AbortController(); flights.current.add(abort);
    void api.outputs(partnerId, abort.signal).then(value => { if (active && !abort.signal.aborted) { setOutputs(value); setOutputFailed(false); } })
      .catch(() => { if (active && !abort.signal.aborted) setOutputFailed(true); });
    return () => { active = false; abort.abort(); flights.current.delete(abort); };
  }, [visible, api, partnerId, refresh]);
  useEffect(() => {
    if (!visible || !homeApi || AppState.currentState !== "active") return;
    const abort = new AbortController(); flights.current.add(abort);
    void homeApi.list(partnerId, abort.signal).then(value => { if (!value.home) throw new Error("The home computer is unavailable."); if (!abort.signal.aborted) { setHome(value); setHomeFailed(false); } })
      .catch(() => { if (!abort.signal.aborted) setHomeFailed(true); });
    return () => { abort.abort(); flights.current.delete(abort); };
  }, [visible, homeApi, partnerId, refresh]);
  const save = async (choice?: PartnerAutonomySettingChoice) => {
    if (busy || !settings?.revision || AppState.currentState !== "active") return;
    if (!attempt.current) { if (!choice) return; attempt.current = { id: api.newOperationId(), revision: settings.revision.value, choice }; }
    const saved = attempt.current; setBusy(true); setFailed(false);
    try {
      const value = await invoke(signal => api.save(saved.id, saved.revision, saved.choice, signal));
      if (!value) return; if (attempt.current === saved) attempt.current = undefined; setSettings(value); await readSettings();
    } catch (error) { if (alive.current) { if (partnerMutationWasRejected(error)) attempt.current = undefined; setFailed(true); } } finally { if (alive.current) setBusy(false); }
  };
  const enable = () => {
    const epoch = ++askEpoch.current, owner = api;
    Alert.alert(m.invite, m.consent.replace("{name}", name), [{ text: m.cancel, style: "cancel" }, { text: m.start, onPress: () => {
      if (alive.current && current.current.api === owner && epoch === askEpoch.current && AppState.currentState === "active") void save({ case: "schedulerPartnerId", value: partnerId });
    } }]);
  };
  const action = (label: string, onPress: () => void, disabled = false) => <Pressable accessibilityRole="button" accessibilityLabel={label}
    disabled={disabled} onPress={onPress} style={[styles.action, { borderColor: colors.border }, disabled && { opacity: .45 }]}><Text style={{ color: colors.ink }}>{label}</Text></Pressable>;
  const remove = (todo: PartnerTodo) => {
    const epoch = ++askEpoch.current;
    Alert.alert(todo.title, undefined, [{ text: m.cancel, style: "cancel" }, { text: m.remove, style: "destructive", onPress: () => {
      if (alive.current && current.current.visible && epoch === askEpoch.current && AppState.currentState === "active") void editor.mutate(todo, "delete");
    } }]);
  };
  const todoRow = (todo: PartnerTodo) => <Pressable key={todo.id} accessibilityRole="button" accessibilityLabel={`${m.quote}: ${todo.title}`}
    onPress={() => afterClose(() => current.current.onQuote(todo))} onLongPress={() => remove(todo)} style={[styles.row, { borderColor: colors.border }]}>
    <Text style={{ color: colors.ink }}>{partnerTodoDue(todo, state.now) ? "● " : ""}{todo.title}</Text>
    <Text style={{ color: colors.muted }}>{[todo.progress, partnerTodoDate(todo, locale), todo.sources[0]?.label].filter(Boolean).join(" · ")}</Text>
  </Pressable>;
  const files = outputs.filter(output => output.readiness === PartnerTaskOutputReadiness.READY).flatMap(output => output.files.map(file => ({ output, file })));
  const openOutput = async (source: PartnerTaskOutput, path: string) => {
    try {
      const value = await invoke(signal => api.outputs(partnerId, signal)); const latest = value?.find(item => item.sourceId === source.sourceId && item.sourceKind === source.sourceKind);
      if (!value) return;
      if (!latest || latest.sessionId !== source.sessionId || latest.execution !== source.execution || latest.sourceRevision?.value !== source.sourceRevision?.value
        || latest.runIds.join("\0") !== source.runIds.join("\0") || !latest.files.some(file => file.path === path)) throw new Error("Output source changed.");
      afterClose(() => current.current.onOpenTask(source.sessionId));
    } catch { if (alive.current) setOutputFailed(true); }
  };
  const configured = settings?.schedulerPartnerId === partnerId;
  return <>
    {engaged && settings && !settings.customized && !settings.schedulerPartnerId && <View style={[styles.invitation, { borderColor: colors.border }]}>
      <Text style={{ color: colors.ink }}>{m.invite}</Text>{action(m.start, enable, busy || !!attempt.current)}{action(m.notNow, () => void save({ case: "disabled", value: true }), busy || !!attempt.current)}
    </View>}
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onDismiss={deliver} onRequestClose={onClose}>
      <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]}><View style={styles.header}><Text accessibilityRole="header" style={{ color: colors.ink, fontSize: 20 }}>{name} · {m.glance}</Text>{action(m.close, onClose)}</View>
        <ScrollView contentContainerStyle={styles.content}>
          <Text accessibilityRole="header" style={{ color: colors.muted }}>{m.computers}</Text>
          {home?.home ? <View><Text style={{ color: colors.ink }}>{home.home.deviceName}</Text><Text style={{ color: colors.muted }}>{m.here} · {home.home.available ? m.online : m.offline}</Text></View> : <Text style={{ color: colors.muted }}>{homeApi ? m.loading : m.here}</Text>}
          {homeFailed && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{m.computersFailed}</Text>}{homeFailed && action(m.refresh, () => setRefresh(value => value + 1))}
          {home?.home?.available && action(partnerHomeMessages(locale).change, () => afterClose(() => current.current.onHomeSettings()))}
          {(state.openTotal > 0 || state.doneTotal > 0 || state.failed || state.deleted || !state.loaded) && <View style={styles.section}>
            <Text accessibilityRole="header" style={{ color: colors.muted }}>{m.todos}</Text>
            {state.failed && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{state.pending ? m.saveUnknown : m.failed}</Text>}
            {state.failed && action(state.pending ? m.retrySave : m.refresh, () => state.pending ? void editor.mutate() : void editor.refresh(), state.saving)}
            {(all ? state.open : state.open.slice(0, 5)).map(todoRow)}{state.open.length > 5 && action(`${m.more} (${state.openTotal})`, () => setAll(value => !value))}
            {state.doneTotal > 0 && <>{action(`${m.completed} (${state.doneTotal})`, () => setShowDone(value => !value))}{showDone && state.done.map(todoRow)}</>}
            {state.deleted && action(`${m.undo}: ${state.deleted.title}`, () => void editor.mutate(state.deleted, "restore"), state.saving || state.pending)}
          </View>}
          {(files.length > 0 || outputFailed) && <View style={styles.section}><Text accessibilityRole="header" style={{ color: colors.muted }}>{m.outputs}</Text>
            {outputFailed && action(`${m.failed} ${m.refresh}`, () => setRefresh(value => value + 1))}
            {files.slice(0, all ? 30 : 3).map(({ output, file }) => <View key={`${output.sourceId}:${file.path}`}>{action(`${file.path.split('/').at(-1)} · ${output.title}`, () => void openOutput(output, file.path))}</View>)}
            {files.length > 3 && action(`${m.more} (${files.length})`, () => setAll(value => !value))}</View>}
          <View style={styles.section}><Text accessibilityRole="header" style={{ color: colors.muted }}>{m.follow}</Text><Text style={{ color: colors.ink }}>{configured ? m.enabled : m.disabled}</Text>
            {failed && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{attempt.current ? m.saveUnknown : m.failed}</Text>}
            {attempt.current ? action(m.retrySave, () => void save(), busy) : action(configured ? m.stop : m.start, () => configured ? void save({ case: "disabled", value: true }) : enable(), busy || !settings)}
            {action(m.reset, () => void save({ case: "reset", value: true }), busy || !settings || !!attempt.current)}
            <View style={styles.invitation}><Switch accessibilityLabel={m.fallback} disabled={busy || !settings || !!attempt.current} value={!!settings?.schedulerFallbackPartnerIds.includes(partnerId)}
              onValueChange={allow => void save({ case: "fallback", value: { partnerId, allow } })} /><Text style={{ color: colors.ink, flex: 1 }}>{m.fallback}</Text></View>
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  </>;
}
const styles = StyleSheet.create({ screen: { flex: 1 }, header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 14, gap: 10 },
  content: { padding: 16, gap: 16, paddingBottom: 30 }, section: { gap: 10 }, invitation: { padding: 10, borderWidth: 1, borderRadius: 12, flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  action: { minHeight: 44, justifyContent: "center", borderWidth: 1, borderRadius: 10, padding: 12 }, row: { minHeight: 50, padding: 12, gap: 4, borderBottomWidth: StyleSheet.hairlineWidth } });
