import { useEffect, useRef, useState } from "react";
import { AppState, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { PartnerTaskOutputReadiness, SessionAttentionKind, isValidCodeHostPullRequestReference, partnerAutonomyMessages,
  type GetPartnerGlanceResponse, type PartnerAutonomyApi, type PartnerTaskOutput, type Snapshot } from "@joko/contracts";
import { mobileSessionAttention } from "./mobile-session-attention";
import { partnerHomeMessages, type PartnerHomeApi, type ListPartnerHomeTargetsResponse } from "@joko/contracts";
import type { MobilePartnersColors } from "./MobilePartnersScreen";
import type { MobileSupportedLocale } from "./mobile-locale-preference";

export function MobilePartnerGlanceSheet({ api, homeApi, partnerId, name, visible, snapshot, colors, locale, onClose, onOpenTask, onHomeSettings }: {
  readonly api: PartnerAutonomyApi; readonly partnerId: string; readonly name: string; readonly visible: boolean; readonly snapshot?: Snapshot;
  readonly homeApi?: PartnerHomeApi;
  readonly colors: MobilePartnersColors; readonly locale: MobileSupportedLocale; readonly onClose: () => void;
  readonly onOpenTask: (sessionId: string) => void; readonly onHomeSettings: () => void;
}) {
  const m = partnerAutonomyMessages(locale), alive = useRef(true), flights = useRef(new Set<AbortController>());
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [page, setPage] = useState<GetPartnerGlanceResponse>(), [failed, setFailed] = useState(false);
  const [allTasks, setAllTasks] = useState(false), [linkFailed, setLinkFailed] = useState(false);
  const [all, setAll] = useState(false), [outputs, setOutputs] = useState<readonly PartnerTaskOutput[]>([]);
  const [outputFailed, setOutputFailed] = useState(false), [refresh, setRefresh] = useState(0);
  const [home, setHome] = useState<ListPartnerHomeTargetsResponse>(), [homeFailed, setHomeFailed] = useState(false);
  const pending = useRef<(() => void) | undefined>(undefined), current = useRef({ visible, api, onOpenTask, onHomeSettings });
  current.current = { visible, api, onOpenTask, onHomeSettings };
  const deliver = () => { const action = pending.current; pending.current = undefined; if (action && alive.current && !current.current.visible
    && current.current.api === api && AppState.currentState === "active") action(); };
  const afterClose = (action: () => void) => { pending.current = action; onClose(); };
  const invoke = async <T,>(action: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> => {
    const abort = new AbortController(); flights.current.add(abort);
    try { const result = await action(abort.signal); return alive.current && current.current.visible && current.current.api === api && !abort.signal.aborted && AppState.currentState === "active" ? result : undefined; }
    finally { flights.current.delete(abort); }
  };
  useEffect(() => {
    alive.current = true;
    const suspend = () => { pending.current = undefined; for (const request of flights.current) request.abort(); };
    const subscription = AppState.addEventListener("change", value => {
      setForeground(value === "active");
      if (value !== "active") suspend();
    });
    return () => { alive.current = false; suspend(); subscription.remove(); };
  }, [api]);
  useEffect(() => { if (!visible && Platform.OS === "android" && pending.current) { const frame = requestAnimationFrame(deliver); return () => cancelAnimationFrame(frame); } }, [visible]);
  useEffect(() => {
    if (!visible || !foreground) return;
    let active = true; const abort = new AbortController(); flights.current.add(abort);
    void api.glance(partnerId, abort.signal).then(value => { if (!abort.signal.aborted) { setPage(value); setFailed(false); } })
      .catch(() => { if (!abort.signal.aborted) { setPage(undefined); setFailed(true); } });
    void api.outputs(partnerId, abort.signal).then(value => { if (active && !abort.signal.aborted) { setOutputs(value); setOutputFailed(false); } })
      .catch(() => { if (active && !abort.signal.aborted) setOutputFailed(true); });
    return () => { active = false; abort.abort(); flights.current.delete(abort); };
  }, [visible, foreground, api, partnerId, refresh]);
  useEffect(() => {
    if (!visible || !homeApi || !foreground) return;
    const abort = new AbortController(); flights.current.add(abort);
    void homeApi.list(partnerId, abort.signal).then(value => { if (!value.home) throw new Error("The home computer is unavailable."); if (!abort.signal.aborted) { setHome(value); setHomeFailed(false); } })
      .catch(() => { if (!abort.signal.aborted) setHomeFailed(true); });
    return () => { abort.abort(); flights.current.delete(abort); };
  }, [visible, foreground, homeApi, partnerId, refresh]);
  useEffect(() => {
    if (visible && foreground) return;
    setPage(undefined); setHome(undefined); setOutputs([]); setAllTasks(false); setAll(false);
    setFailed(false); setHomeFailed(false); setLinkFailed(false); setOutputFailed(false);
  }, [visible, foreground]);
  const action = (label: string, onPress: () => void, disabled = false) => <Pressable accessibilityRole="button" accessibilityLabel={label}
    disabled={disabled} onPress={onPress} style={[styles.action, { borderColor: colors.border }, disabled && { opacity: .45 }]}><Text style={{ color: colors.ink }}>{label}</Text></Pressable>;
  const rows = page?.rows ?? [];
  const byId = new Map(snapshot?.sessions.map(session => [session.sessionId, session]));
  const references = rows.flatMap(row => {
    const session = byId.get(row.sessionId);
    if (!session || session.nativeBinding?.runtimeGeneration !== row.generation) return [];
    return session.codeHostPullRequests.flatMap(projection => {
      const ref = projection.reference;
      return ref && isValidCodeHostPullRequestReference(ref) ? [{ ref, title: projection.observed ? projection.title : "" }] : [];
    });
  });
  const unique = new Map(references.map(item => [item.ref.referenceKey, item]));
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
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onDismiss={deliver} onRequestClose={onClose}>
      <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]}><View style={styles.header}><Text accessibilityRole="header" style={{ color: colors.ink, fontSize: 20 }}>{name} · {m.glance}</Text>{action(m.close, onClose)}</View>
        <ScrollView contentContainerStyle={styles.content}>
          <Text accessibilityRole="header" style={{ color: colors.muted }}>{m.computers}</Text>
          {home?.home ? <View><Text style={{ color: colors.ink }}>{home.home.deviceName}</Text><Text style={{ color: colors.muted }}>{m.here} · {home.home.available ? m.online : m.offline}</Text></View> : <Text style={{ color: colors.muted }}>{homeApi ? m.loading : m.here}</Text>}
          {homeFailed && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{m.computersFailed}</Text>}{homeFailed && action(m.refresh, () => setRefresh(value => value + 1))}
          {home?.home?.available && action(partnerHomeMessages(locale).change, () => afterClose(() => current.current.onHomeSettings()))}
          {failed && <View><Text accessibilityRole="alert" style={{ color: colors.negative }}>{m.failed}</Text>{action(m.refresh, () => setRefresh(value => value + 1))}</View>}
          {rows.length > 0 && <View style={styles.section}><Text accessibilityRole="header" style={{ color: colors.muted }}>{m.recent}</Text>
            {(allTasks ? rows : rows.slice(0, 5)).map(row => {
              const task = byId.get(row.sessionId);
              const unread = task?.nativeBinding?.runtimeGeneration === row.generation && mobileSessionAttention(snapshot, task)?.kind === SessionAttentionKind.DONE;
              return <View key={row.sessionId}>{action(row.title, () => afterClose(() => current.current.onOpenTask(row.sessionId)), !row.online)}
                {unread && <Text style={{ color: colors.muted }}>{m.unread}</Text>}</View>;
            })}
            {rows.length > 5 && action(allTasks ? m.less : m.more, () => setAllTasks(value => !value))}</View>}
          {unique.size > 0 && <View style={styles.section}><Text accessibilityRole="header" style={{ color: colors.muted }}>{m.requests}</Text>
            {[...unique.values()].map(({ ref, title }) => <View key={ref.referenceKey}>{action(title || `${ref.repositoryOwner}/${ref.repositoryName} ${ref.webUrl.includes("/-/merge_requests/") ? "!" : "#"}${ref.number}`,
              () => { setLinkFailed(false); void Linking.openURL(ref.webUrl).catch(() => { if (alive.current) setLinkFailed(true); }); })}</View>)}
            {linkFailed && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{m.openFailed}</Text>}</View>}
          {(files.length > 0 || outputFailed) && <View style={styles.section}><Text accessibilityRole="header" style={{ color: colors.muted }}>{m.outputs}</Text>
            {outputFailed && action(`${m.failed} ${m.refresh}`, () => setRefresh(value => value + 1))}
            {files.slice(0, all ? 30 : 3).map(({ output, file }) => <View key={`${output.sourceId}:${file.path}`}>{action(`${file.path.split('/').at(-1)} · ${output.title}`, () => void openOutput(output, file.path))}</View>)}
            {files.length > 3 && action(`${all ? m.less : m.more} (${files.length})`, () => setAll(value => !value))}</View>}
        </ScrollView>
      </SafeAreaView>
    </Modal>;
}
const styles = StyleSheet.create({ screen: { flex: 1 }, header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 14, gap: 10 },
  content: { padding: 16, gap: 16, paddingBottom: 30 }, section: { gap: 10 },
  action: { minHeight: 44, justifyContent: "center", borderWidth: 1, borderRadius: 10, padding: 12 } });
