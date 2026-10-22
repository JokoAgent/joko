import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { PartnerHomeBusyAction, PartnerHomeMovePhase, PermissionMode, partnerHomeMessages,
  type ListPartnerHomeTargetsResponse, type PartnerHomeApi, type PartnerHomeMove, type PartnerHomeModelChoice } from "@joko/contracts";
import type { MobilePartnersColors } from "./MobilePartnersScreen";

export function MobilePartnerHomeSheet({ api, partnerId, revision, inputHandoff = true, locale, colors, newRequestId, onClose, onChanged }: {
  readonly api: PartnerHomeApi; readonly partnerId: string; readonly revision: bigint; readonly locale: string;
  readonly inputHandoff?: boolean;
  readonly colors: MobilePartnersColors; readonly newRequestId: () => string; readonly onClose: () => void; readonly onChanged: (sessionId: string) => void;
}) {
  const text = partnerHomeMessages(locale), [catalog, setCatalog] = useState<ListPartnerHomeTargetsResponse>();
  const [target, setTarget] = useState<number>(), [models, setModels] = useState<readonly PartnerHomeModelChoice[]>([]);
  const [model, setModel] = useState<number>(), [query, setQuery] = useState("");
  const [permission, setPermission] = useState(PermissionMode.ASK), [plan, setPlan] = useState(false);
  const [busyAction, setBusyAction] = useState(PartnerHomeBusyAction.WAIT), [offline, setOffline] = useState(false);
  const [move, setMove] = useState<PartnerHomeMove>(), [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const alive = useRef(true), sent = useRef<string | undefined>(undefined), notified = useRef<string | undefined>(undefined);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = async (signal: AbortSignal) => { const value = await api.list(partnerId, signal); if (!signal.aborted && alive.current) {
    setCatalog(value); if (value.pendingMove) setMove(value.pendingMove); setError(false);
  } };
  useEffect(() => { const request = new AbortController(); void load(request.signal).catch(() => { if (!request.signal.aborted) setError(true); }); return () => request.abort(); }, [api, partnerId]);
  useEffect(() => {
    setModels([]); setModel(undefined); setQuery(""); setPlan(false); setPermission(PermissionMode.ASK);
    if (target === undefined || !catalog?.targets[target]?.destination) return;
    const request = new AbortController(); setBusy(true); setError(false);
    void api.inspect(partnerId, catalog.targets[target]!.destination!, request.signal).then(value => { if (!request.signal.aborted) setModels(value.models); })
      .catch(() => { if (!request.signal.aborted) setError(true); }).finally(() => { if (!request.signal.aborted) setBusy(false); });
    return () => request.abort();
  }, [api, partnerId, target]);
  useEffect(() => {
    if (!move || move.phase === PartnerHomeMovePhase.READY || move.phase === PartnerHomeMovePhase.NEEDS_ATTENTION) return;
    const request = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => { try { const value = await api.status(move.requestId, request.signal); if (!request.signal.aborted) setMove(value.move); }
      catch { if (!request.signal.aborted) setError(true); } if (!request.signal.aborted) timer = setTimeout(() => void poll(), 1500); };
    timer = setTimeout(() => void poll(), 500); return () => { request.abort(); clearTimeout(timer); };
  }, [api, move?.requestId, move?.phase]);
  useEffect(() => { if (move?.phase === PartnerHomeMovePhase.READY && move.canonicalSessionId && notified.current !== move.requestId) {
    notified.current = move.requestId; onChanged(move.canonicalSessionId);
  } }, [move, onChanged]);
  const choice = model === undefined ? undefined : models[model];
  const running = !!move && move.phase !== PartnerHomeMovePhase.READY && move.phase !== PartnerHomeMovePhase.NEEDS_ATTENTION;
  const action = (label: string, onPress: () => void, disabled = false, selected = false) => <Pressable key={label} accessibilityRole="button" accessibilityState={{ disabled, selected }} disabled={disabled} onPress={onPress}
    style={{ minHeight: 44, borderWidth: 1, borderColor: selected ? colors.accent : colors.border, borderRadius: 10, padding: 12, opacity: disabled ? .5 : 1 }}><Text style={{ color: selected ? colors.accent : colors.ink }}>{label}</Text></Pressable>;
  const submit = async () => {
    const destination = target === undefined ? undefined : catalog?.targets[target]?.destination;
    if (!catalog?.home?.identity || !destination || !choice?.route || busy) return;
    setBusy(true); setError(false);
    try { const requestId = sent.current ?? newRequestId(); sent.current = requestId;
      const value = await api.move({ requestId, expectedHome: catalog.home.identity, expectedPartnerRevision: { value: revision }, destination,
        capabilities: { modelChain: [choice.route], permissionMode: permission, planMode: plan, inputHandoff }, busyAction, continueWhenSourceOffline: offline }, new AbortController().signal);
      if (alive.current) { setMove(value.move); if (value.move) sent.current = undefined; }
    } catch { if (alive.current) setError(true); } finally { if (alive.current) setBusy(false); }
  };
  return <Modal visible animationType="slide" onRequestClose={onClose}><SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
    <View style={{ padding: 16, gap: 12 }}>{action(text.close, onClose)}<Text accessibilityRole="header" style={{ color: colors.ink, fontSize: 22, fontWeight: "600" }}>{text.title}</Text></View>
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled">
      <Text style={{ color: colors.muted }}>{text.body}</Text>{catalog?.home && <Text style={{ color: colors.ink }}>{text.current}: {catalog.home.deviceName}</Text>}
      {busy && <ActivityIndicator color={colors.accent} />}
      {move && <><Text accessibilityRole="text" style={{ color: colors.ink }}>{move.phase === PartnerHomeMovePhase.READY ? text.ready : move.phase === PartnerHomeMovePhase.NEEDS_ATTENTION ? text.attention : text.running}</Text><Text style={{ color: colors.muted }}>{move.sourceDeviceName} → {move.targetDeviceName}</Text>
        {move.phase === PartnerHomeMovePhase.NEEDS_ATTENTION && action(text.retry, () => { setBusy(true); setError(false); void api.retry(move.requestId, new AbortController().signal).then(value => { if (alive.current) setMove(value.move); }).catch(() => { if (alive.current) setError(true); }).finally(() => { if (alive.current) setBusy(false); }); }, busy)}</>}
      {!running && !catalog?.home?.changing && move?.phase !== PartnerHomeMovePhase.READY && <>
        <Text style={{ color: colors.ink }}>{text.choose}</Text>{catalog?.targets.map((item, index) => action(`${item.deviceName} · ${item.platform}`, () => { sent.current = undefined; setTarget(index); }, busy || (item.destination?.location.case === "serviceNode" ? catalog.home?.serviceNode === true : item.destination?.location.case === "peer" && item.destination.location.value.targetDeviceId === catalog.home?.deviceId), target === index))}
        {target !== undefined && !busy && !models.length && <Text style={{ color: colors.muted }}>{text.unavailable}</Text>}
        {!!models.length && <><Text style={{ color: colors.muted }}>{text.channel}</Text><Text style={{ color: colors.ink }}>{text.model}</Text>
          <TextInput accessibilityLabel={text.model} value={query} onChangeText={setQuery} style={{ minHeight: 44, color: colors.ink, borderColor: colors.border, borderWidth: 1, borderRadius: 10, padding: 10 }} />
          {models.map((item, index) => ({ item, index })).filter(({ item }) => item.displayName.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0, 100).map(({ item, index }) => action(item.displayName, () => { sent.current = undefined; setModel(index); setPermission(PermissionMode.ASK); setPlan(false); }, busy, model === index))}
          {choice && <><Text style={{ color: colors.ink }}>{text.permissions}</Text>{choice.permissionModes.map(mode => action(mode === PermissionMode.ASK ? text.ask : mode === PermissionMode.ACCEPT_EDITS ? text.edits : mode === PermissionMode.AUTO ? text.auto : text.full, () => { sent.current = undefined; setPermission(mode); }, busy, permission === mode))}
            {choice.canSetPlanMode && action(text.plan, () => { sent.current = undefined; setPlan(!plan); }, busy, plan)}</>}
        </>}
        {action(text.wait, () => { sent.current = undefined; setBusyAction(PartnerHomeBusyAction.WAIT); }, busy, busyAction === PartnerHomeBusyAction.WAIT)}
        {action(text.stop, () => { sent.current = undefined; setBusyAction(PartnerHomeBusyAction.STOP); }, busy, busyAction === PartnerHomeBusyAction.STOP)}
        {action(text.offline, () => { sent.current = undefined; setOffline(!offline); }, busy, offline)}
        {action(text.change, () => void submit(), busy || !choice || !choice.permissionModes.includes(permission))}
      </>}
      {error && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{text.error}</Text>}
      {action(text.refresh, () => { void load(new AbortController().signal).catch(() => setError(true)); }, busy)}
    </ScrollView>
  </SafeAreaView></Modal>;
}
