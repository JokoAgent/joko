import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { PartnerRestartResult, PartnerRestartView } from "@joko/contracts";
import type { MobilePartnerRestartTransport } from "./mobile-partner-restart";
import type { MobilePartnerDirectoryProfile } from "./mobile-partner-directory";
import type { MobilePartnersColors } from "./MobilePartnersScreen";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";

export function MobilePartnerRestartPanel({ transport, partner, colors, locale, onChanged, onBusyChange, startConfirming = false, onCancelConfirmation, disabled = false }: {
  readonly transport?: MobilePartnerRestartTransport; readonly partner?: MobilePartnerDirectoryProfile;
  readonly colors: MobilePartnersColors; readonly locale: MobileSupportedLocale;
  readonly onChanged: (restart?: PartnerRestartView) => void; readonly onBusyChange?: (busy: boolean) => void;
  readonly disabled?: boolean; readonly startConfirming?: boolean; readonly onCancelConfirmation?: () => void;
}) {
  const current = useRef({ transport, onChanged, onBusyChange }); current.current = { transport, onChanged, onBusyChange };
  const owner = transport?.ownerKey; const request = useRef<AbortController | undefined>(undefined); const busyRef = useRef(false);
  const readyOwner = useRef<string | undefined>(undefined); const actionGeneration = useRef(0);
  const [busy, setBusy] = useState(false); const [ready, setReady] = useState(false);
  const [confirming, setConfirming] = useState(startConfirming);
  const [available, setAvailable] = useState(false);
  const [reload, setReload] = useState(0);
  const [succeeded, setSucceeded] = useState(false);
  const [error, setError] = useState(false);
  const [records, setRecords] = useState<{ owner?: string; rows: ReadonlyMap<string, PartnerRestartView | undefined> }>({ rows: new Map() });
  const rows = records.owner === owner ? records.rows : new Map<string, PartnerRestartView | undefined>();
  const update = (id: string, restart?: PartnerRestartView, terminal = false): void => setRecords((old) => {
    const next = new Map(old.owner === owner ? old.rows : []); if (terminal) next.delete(id); else next.set(id, restart);
    return { owner, rows: next };
  });
  useEffect(() => { setConfirming(startConfirming); setAvailable(false); }, [owner, partner?.partnerId, partner?.revision, startConfirming]);
  useEffect(() => {
    actionGeneration.current++; busyRef.current = false; setBusy(false); readyOwner.current = undefined;
    current.current.onBusyChange?.(false);
    if (!transport || !owner) { request.current?.abort(); setReady(false); return; }
    const abort = new AbortController(); request.current?.abort(); request.current = abort; setReady(false);
    setError(false);
    const active = (): boolean => !abort.signal.aborted && current.current.transport?.ownerKey === owner;
    void transport.listRequests(abort.signal).then(async (ids) => {
      if (partner) {
        const controls = await transport.controls(partner, abort.signal);
        if (!active()) return;
        setAvailable(controls.available && controls.revision === partner.revision);
      }
      if (!active()) return;
      setRecords({ owner, rows: new Map(ids.map((id) => [id, undefined])) }); readyOwner.current = owner; setReady(true);
      for (const id of ids) {
        if (!active()) return;
        const result = await transport.read(id, abort.signal); if (!active()) return;
        update(id, result.restart, result.retired || result.restart?.phase === "ready");
      }
    }).catch(() => { if (active()) setError(true); });
    return () => abort.abort();
  }, [owner, partner?.partnerId, partner?.revision, reload]);
  useEffect(() => () => request.current?.abort(), []);
  const act = (id: string, action: (signal: AbortSignal) => Promise<PartnerRestartResult>): void => {
    if (disabled || !transport || !ready || readyOwner.current !== owner || busyRef.current || current.current.transport?.ownerKey !== owner) return;
    busyRef.current = true; setBusy(true); setError(false); current.current.onBusyChange?.(true);
    request.current?.abort(); const abort = new AbortController(); request.current = abort;
    const generation = ++actionGeneration.current;
    const active = (): boolean => !abort.signal.aborted && current.current.transport?.ownerKey === owner;
    void action(abort.signal).then((result) => {
      if (!active()) return;
      update(id, result.restart, result.retired || result.restart?.phase === "ready");
      setConfirming(false); if (result.restart?.phase === "ready") setSucceeded(true); current.current.onChanged(result.restart);
    }).catch(() => { if (active()) { update(id); setError(true); } })
      .finally(() => { if (generation === actionGeneration.current) { busyRef.current = false;
        if (current.current.transport?.ownerKey === owner) { setBusy(false); current.current.onBusyChange?.(false); } } });
  };
  const restart = (): void => {
    if (!partner || !transport || !available || rows.size > 0 || disabled) return;
    const id = transport.newRequestId();
    act(id, async (signal) => ({ restart: await transport.restart(id, partner, signal), retired: false }));
  };
  const button = (label: string, onPress: () => void, disabled = false, destructive = false) => <Pressable
    accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={{ minHeight: 44, padding: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 12, opacity: disabled ? .5 : 1 }}>
    <Text style={{ color: destructive ? colors.negative : colors.ink }}>{label}</Text></Pressable>;
  if (!partner && rows.size === 0 && !error) return null;
  return <View style={{ padding: 16, gap: 10 }} testID="partnerRestart.panel">
    {error && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{mobileMessage(locale, !ready ? "partnerRestart.loadFailed" : "partnerRestart.unknown")}</Text>}
    {error && !ready && button(mobileMessage(locale, "common.retry"), () => setReload((value) => value + 1), disabled || busy)}
    {!ready && partner && <Text style={{ color: colors.muted }}>{mobileMessage(locale, "common.loading")}</Text>}
    {ready && partner && !available && <Text style={{ color: colors.muted }}>{mobileMessage(locale, "partnerRestart.unavailable")}</Text>}
    {busy && <ActivityIndicator color={colors.accent} />}
    {[...rows].map(([id, record]) => <View key={id} style={{ gap: 8 }}>
      <Text style={{ color: colors.muted }}>{mobileMessage(locale, !record ? "partnerRestart.unknown"
        : record.runtimeClosePending ? "partnerRestart.runtime_close_pending" : `partnerRestart.${record.phase}`)}</Text>
      {button(mobileMessage(locale, "partnerRestart.check"), () => act(id, (signal) => transport!.read(id, signal)), busy || !ready)}
      {record && record.phase !== "ready" && button(mobileMessage(locale, "partnerRestart.retry"), () => act(id,
        async (signal) => ({ restart: await transport!.retry(id, signal), retired: false })), busy || !ready)}
      {!record && button(mobileMessage(locale, "partnerRestart.retire"), () => act(id, (signal) => transport!.retire(id, signal)), busy || !ready)}
    </View>)}
    {succeeded && <Text accessibilityRole="text" style={{ color: colors.ink }}>{mobileMessage(locale, "partnerRestart.ready")}</Text>}
    {partner && (confirming ? <>
      <Text accessibilityRole="header" style={{ color: colors.ink }}>{mobileMessage(locale, "partnerRestart.title", { name: partner.displayName })}</Text>
      <Text style={{ color: colors.ink }}>{mobileMessage(locale, "partnerRestart.body")}</Text>
      {button(mobileMessage(locale, "common.cancel"), () => { setConfirming(false); onCancelConfirmation?.(); }, busy)}
      {button(mobileMessage(locale, "partnerRestart.action"), restart, disabled || !ready || !available || busy || rows.size > 0)}
    </> : button(mobileMessage(locale, "partnerRestart.action"), () => setConfirming(true), disabled || !ready || !available || busy || rows.size > 0))}
  </View>;
}
