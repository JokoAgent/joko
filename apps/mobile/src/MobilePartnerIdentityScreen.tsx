import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { randomUUID } from "expo-crypto";
import { partnerIdentityMessages, type JoinedTaskShare, type PartnerIdentityGrant, type PartnerIdentityLink } from "@joko/contracts";
import type { MobilePartnerIdentityApi } from "./mobile-partner-identity";
import type { MobilePartnerDirectoryProfile, MobilePartnerDirectoryTransport } from "./mobile-partner-directory";
import type { MobilePartnersColors } from "./MobilePartnersScreen";
import type { MobileSupportedLocale } from "./mobile-locale-preference";

export function MobilePartnerIdentityScreen({ api, directory, colors, locale, onBack, onOpen }: {
  api?: MobilePartnerIdentityApi; directory?: MobilePartnerDirectoryTransport; colors: MobilePartnersColors; locale: MobileSupportedLocale;
  onBack(): void; onOpen(joined: JoinedTaskShare): Promise<void>;
}) {
  const m = partnerIdentityMessages(locale), current = useRef(api), lifetime = useRef(new AbortController()), active = useRef(false);
  current.current = api;
  const [links, setLinks] = useState<PartnerIdentityLink[]>([]), [grants, setGrants] = useState<PartnerIdentityGrant[]>([]), [partners, setPartners] = useState<readonly MobilePartnerDirectoryProfile[]>([]);
  const [invitation, setInvitation] = useState(""), [alias, setAlias] = useState(""), [issued, setIssued] = useState(""), [name, setName] = useState("Joko");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [reload, setReload] = useState(0);
  const [aliases, setAliases] = useState<Record<string, string>>({});
  useEffect(() => {
    lifetime.current = new AbortController(); const signal = lifetime.current.signal;
    if (api) void Promise.all([api.listPartnerIdentities({}, { signal }), directory?.list(signal)]).then(([result, catalog]) => {
      if (!signal.aborted) { setLinks(result.links); setGrants(result.grants); setPartners(catalog?.partners.filter(partner => partner.lifecycle === "active" && !!partner.canonicalSessionId) ?? []); }
    }, () => { if (!signal.aborted) setError(m.failed); });
    return () => lifetime.current.abort();
  }, [api?.ownerKey, directory?.ownerKey, reload]);
  useEffect(() => { setIssued(""); setInvitation(""); }, [api?.ownerKey]);
  const run = async (work: (value: MobilePartnerIdentityApi, signal: AbortSignal) => Promise<void>) => {
    const value = current.current, signal = lifetime.current.signal;
    if (!value || signal.aborted || active.current) return;
    active.current = true; setBusy(true); setError("");
    try { await work(value, signal); if (!signal.aborted) setReload(number => number + 1); }
    catch { if (!signal.aborted) setError(m.failed); }
    finally { active.current = false; if (!signal.aborted) setBusy(false); }
  };
  const action = (label: string, work: () => void, disabled = busy) => <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={work} style={[styles.button, { borderColor: colors.border }]}><Text style={{ color: disabled ? colors.muted : colors.accent }}>{label}</Text></Pressable>;
  const field = { color: colors.ink, backgroundColor: colors.surface, borderColor: colors.border };
  return <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    <View style={styles.row}>{action(m.close, onBack, false)}<Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{m.title}</Text>{action(m.refresh, () => setReload(value => value + 1))}</View>
    <Text style={{ color: colors.muted }}>{m.description}</Text>
    <TextInput accessibilityLabel={m.invitation} placeholder={m.invitation} placeholderTextColor={colors.muted} secureTextEntry autoCapitalize="none" autoCorrect={false} value={invitation} onChangeText={setInvitation} style={[styles.field, field]} />
    <TextInput accessibilityLabel={m.alias} placeholder={m.alias} placeholderTextColor={colors.muted} value={alias} onChangeText={setAlias} style={[styles.field, field]} />
    {action(m.add, () => void run(async (value, signal) => { await value.importPartnerIdentity({ invitation, alias }, { signal }); if (!signal.aborted) { setInvitation(""); setAlias(""); } }), busy || !api || !invitation.trim())}
    <TextInput accessibilityLabel={m.name} placeholder={m.name} placeholderTextColor={colors.muted} value={name} onChangeText={setName} style={[styles.field, field]} />
    {!links.length && <Text style={{ color: colors.muted }}>{m.empty}</Text>}
    {links.map(link => <View key={link.linkId} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={{ color: colors.ink }}>{link.alias}</Text><Text style={{ color: colors.muted }}>{link.identity?.displayName} · {link.identity?.authorityServerId}</Text>
      <TextInput accessibilityLabel={`${m.alias}: ${link.alias}`} value={aliases[link.linkId] ?? link.alias} style={[styles.field, field]} onChangeText={next => setAliases(previous => ({ ...previous, [link.linkId]: next }))} />
      {action(m.save, () => void run(async (value, signal) => { await value.renamePartnerIdentity({ linkId: link.linkId, alias: aliases[link.linkId]! }, { signal }); }), busy || !aliases[link.linkId]?.trim() || aliases[link.linkId] === link.alias)}
      <View style={styles.row}>{action(m.open, () => void run(async (value, signal) => {
        const response = await value.openPartnerIdentity({ operationId: randomUUID(), linkId: link.linkId, displayName: name }, { signal });
        if (signal.aborted || current.current?.ownerKey !== value.ownerKey) return;
        if (!response.joined || response.joined.status !== "active") { setError(m.unknown); return; }
        await onOpen(response.joined);
      }), busy || !name.trim())}{action(m.forget, () => void run(async (value, signal) => { await value.forgetPartnerIdentity({ operationId: randomUUID(), linkId: link.linkId }, { signal }); }))}</View>
    </View>)}
    {partners.map(partner => action(`${m.issue}: ${partner.displayName}`, () => void run(async (value, signal) => {
      const response = await value.issuePartnerIdentity({ operationId: randomUUID(), partnerId: partner.partnerId, expectedRevision: partner.revision }, { signal });
      if (!signal.aborted) setIssued(response.invitation);
    })))}
    {issued && <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}><Text style={{ color: colors.muted }}>{m.copy}</Text><Text selectable style={{ color: colors.ink }}>{issued}</Text>{action(m.close, () => setIssued(""), false)}</View>}
    {!!grants.length && <Text style={{ color: colors.ink }}>{m.grants}</Text>}
    {grants.map(grant => <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]} key={grant.grantId}><Text style={{ color: colors.ink }}>{grant.identity?.displayName} · {grant.grantId}</Text>{action(m.revoke, () => void run(async (value, signal) => { await value.revokePartnerIdentity({ operationId: randomUUID(), grantId: grant.grantId }, { signal }); }), busy || grant.status !== "active")}</View>)}
    {!!error && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{error}</Text>}
  </ScrollView>;
}
const styles = StyleSheet.create({ content: { padding: 20, gap: 12 }, row: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }, title: { fontSize: 20, fontWeight: "600", flex: 1 },
  button: { borderWidth: 1, borderRadius: 10, padding: 10 }, field: { borderWidth: 1, borderRadius: 10, padding: 10 }, card: { borderWidth: 1, borderRadius: 14, padding: 12, gap: 8 } });
