import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import type { PartnerDeletionResult, PartnerDeletionView } from "@joko/contracts";
import type { MobilePartnerDeletionTransport } from "./mobile-partner-deletion";
import type { MobilePartnerDirectoryProfile } from "./mobile-partner-directory";
import type { MobilePartnersColors } from "./MobilePartnersScreen";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";

export function MobilePartnerDeletionPanel({ transport, partner, colors, locale, onChanged, onBusyChange, startConfirming = false, onCancelConfirmation, disabled: blocked = false }: {
  readonly transport?: MobilePartnerDeletionTransport; readonly partner?: MobilePartnerDirectoryProfile;
  readonly colors: MobilePartnersColors; readonly locale: MobileSupportedLocale;
  readonly onChanged: (deletion?: PartnerDeletionView) => void; readonly onBusyChange?: (busy: boolean) => void;
  readonly startConfirming?: boolean; readonly onCancelConfirmation?: () => void;
  readonly disabled?: boolean;
}) {
  const current = useRef({ transport, onChanged, onBusyChange }); current.current = { transport, onChanged, onBusyChange };
  const owner = transport?.ownerKey; const request = useRef<AbortController | undefined>(undefined); const busyRef = useRef(false);
  const readyOwner = useRef<string | undefined>(undefined); const actionGeneration = useRef(0);
  const [busy, setBusy] = useState(false); const [ready, setReady] = useState(false);
  const [confirming, setConfirming] = useState(startConfirming); const [name, setName] = useState("");
  const [error, setError] = useState(false);
  const [records, setRecords] = useState<{ owner?: string; rows: ReadonlyMap<string, PartnerDeletionView | undefined> }>({ rows: new Map() });
  const rows = records.owner === owner ? records.rows : new Map<string, PartnerDeletionView | undefined>();
  const update = (id: string, deletion?: PartnerDeletionView, terminal = false): void => setRecords((old) => {
    const next = new Map(old.owner === owner ? old.rows : []); if (terminal) next.delete(id); else next.set(id, deletion);
    return { owner, rows: next };
  });
  useEffect(() => { setConfirming(startConfirming); setName(""); }, [owner, partner?.partnerId, partner?.revision, startConfirming]);
  useEffect(() => {
    actionGeneration.current++; busyRef.current = false; setBusy(false); readyOwner.current = undefined;
    current.current.onBusyChange?.(false);
    if (!transport || !owner) { request.current?.abort(); setReady(false); return; }
    const abort = new AbortController(); request.current?.abort(); request.current = abort; setReady(false);
    const active = (): boolean => !abort.signal.aborted && current.current.transport?.ownerKey === owner;
    void transport.listRequests(abort.signal).then(async (ids) => {
      if (!active()) return;
      setRecords({ owner, rows: new Map(ids.map((id) => [id, undefined])) }); readyOwner.current = owner; setReady(true);
      for (const id of ids) {
        if (!active()) return;
        const result = await transport.read(id, abort.signal); if (!active()) return;
        update(id, result.deletion, result.retired || result.deletion?.phase === "completed");
      }
    }).catch(() => { if (active()) setError(true); });
    return () => abort.abort();
  }, [owner]);
  useEffect(() => () => request.current?.abort(), []);
  const act = (id: string, action: (signal: AbortSignal) => Promise<PartnerDeletionResult>): void => {
    if (blocked || !transport || !ready || readyOwner.current !== owner || busyRef.current || current.current.transport?.ownerKey !== owner) return;
    busyRef.current = true; setBusy(true); setError(false); current.current.onBusyChange?.(true);
    request.current?.abort(); const abort = new AbortController(); request.current = abort;
    const generation = ++actionGeneration.current;
    const active = (): boolean => !abort.signal.aborted && current.current.transport?.ownerKey === owner;
    void action(abort.signal).then((result) => {
      if (!active()) return;
      update(id, result.deletion, result.retired || result.deletion?.phase === "completed");
      setName(""); setConfirming(false); current.current.onChanged(result.deletion);
    }).catch(() => { if (active()) { update(id); setError(true); } })
      .finally(() => { if (generation === actionGeneration.current) { busyRef.current = false;
        if (current.current.transport?.ownerKey === owner) { setBusy(false); current.current.onBusyChange?.(false); } } });
  };
  const remove = (): void => {
    if (!partner || !transport || name !== partner.displayName || rows.size > 0) return;
    const id = transport.newRequestId(); const selected = partner; const confirmed = name;
    act(id, async (signal) => { update(id); return { deletion: await transport.delete(id, selected, confirmed, signal), retired: false }; });
  };
  const button = (label: string, onPress: () => void, disabled = false, destructive = false) => <Pressable
    accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: disabled || blocked }} disabled={disabled || blocked} onPress={onPress}
    style={{ minHeight: 44, padding: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 12, opacity: disabled ? .5 : 1 }}>
    <Text style={{ color: destructive ? colors.negative : colors.ink }}>{label}</Text></Pressable>;
  if (!partner && rows.size === 0 && !error) return null;
  return <View style={{ padding: 16, gap: 10 }} testID="partnerDeletion.panel">
    {error && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{mobileMessage(locale, "partnerDeletion.unknown")}</Text>}
    {busy && <ActivityIndicator color={colors.accent} />}
    {[...rows].map(([id, record]) => <View key={id} style={{ gap: 8 }}>
      <Text style={{ color: colors.muted }}>{mobileMessage(locale, !record ? "partnerDeletion.unknown"
        : record.failure ? `partnerDeletion.${record.failure}` : `partnerDeletion.${record.phase}`)}</Text>
      {button(mobileMessage(locale, "partnerDeletion.check"), () => act(id, (signal) => transport!.read(id, signal)), busy || !ready)}
      {record && record.phase !== "completed" && button(mobileMessage(locale, "partnerDeletion.retry"), () => act(id,
        async (signal) => ({ deletion: await transport!.retry(id, signal), retired: false })), busy || !ready)}
      {!record && button(mobileMessage(locale, "partnerDeletion.retire"), () => act(id, (signal) => transport!.retire(id, signal)), busy || !ready)}
    </View>)}
    {partner && (confirming ? <>
      <Text accessibilityRole="header" style={{ color: colors.negative }}>{mobileMessage(locale, "partnerDeletion.title", { name: partner.displayName })}</Text>
      <Text style={{ color: colors.ink }}>{mobileMessage(locale, "partnerDeletion.body")}</Text>
      <Text style={{ color: colors.muted }}>{mobileMessage(locale, "partnerDeletion.typeName", { name: partner.displayName })}</Text>
      <TextInput accessibilityLabel={mobileMessage(locale, "partnerDeletion.typeName", { name: partner.displayName })} value={name}
        onChangeText={setName} editable={!busy && rows.size === 0} autoCorrect={false} autoCapitalize="none"
        style={{ minHeight: 44, padding: 10, borderWidth: 1, borderRadius: 12, borderColor: colors.border, color: colors.ink }} />
      {button(mobileMessage(locale, "common.cancel"), () => { setName(""); setConfirming(false); onCancelConfirmation?.(); }, busy)}
      {button(mobileMessage(locale, "partnerDeletion.delete"), remove, !ready || busy || rows.size > 0 || name !== partner.displayName, true)}
    </> : button(mobileMessage(locale, "partnerDeletion.delete"), () => { setName(""); setConfirming(true); }, !ready || busy || rows.size > 0, true))}
  </View>;
}
