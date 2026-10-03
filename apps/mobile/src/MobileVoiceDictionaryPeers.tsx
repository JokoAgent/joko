import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { readVoiceDictionaryPeerInvitation, readVoiceDictionaryPeerListener } from "@joko/contracts";
import type { MobileSettingsColors } from "./MobileSettingsScreen";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import { MobileVoiceDictionaryPeerController } from "./mobile-voice-dictionary-peer-controller";
import type { MobileVoiceDictionaryTransport } from "./mobile-voice-dictionary-service";

export function MobileVoiceDictionaryPeers({ transport, colors, locale }: {
  readonly transport?: MobileVoiceDictionaryTransport;
  readonly colors: MobileSettingsColors;
  readonly locale: MobileSupportedLocale;
}) {
  const controller = useMemo(() => new MobileVoiceDictionaryPeerController(), []);
  const snapshot = useSyncExternalStore((listener) => controller.subscribe(listener), () => controller.snapshot);
  const [notice, setNotice] = useState<"error" | "saved">();
  const [listenerDraft, setListenerDraft] = useState<{ readonly ownerKey: string; readonly revision: bigint; readonly listenPort: string; readonly host: string; readonly port: string }>();
  const [inviteDraft, setInviteDraft] = useState("");
  const inviteCurrent = useRef(inviteDraft); inviteCurrent.current = inviteDraft;
  const inviteInput = useRef<TextInput>(null);
  const [invitation, setInvitation] = useState<{ readonly ownerKey: string; readonly revision: bigint; readonly text: string }>();
  const [invalidRoute, setInvalidRoute] = useState(false);
  const mounted = useRef(false);
  const authorityEpoch = useRef(0);
  const currentOwner = useRef(transport?.ownerKey); currentOwner.current = transport?.ownerKey;
  const t = (key: Parameters<typeof mobileMessage>[1], variables?: Readonly<Record<string, string | number>>) => mobileMessage(locale, key, variables);
  useEffect(() => {
    authorityEpoch.current += 1;
    mounted.current = true; setNotice(undefined); controller.setTransport(transport);
    setListenerDraft(undefined); setInviteDraft(""); setInvitation(undefined); setInvalidRoute(false);
    return () => { authorityEpoch.current += 1; mounted.current = false; controller.setTransport(undefined); };
  }, [controller, transport?.ownerKey]);
  const owned = transport?.isCurrent() && transport.ownerKey === snapshot.ownerKey;
  const value = owned ? snapshot.value : undefined;
  const busy = owned && snapshot.busy;
  const ready = owned && snapshot.status === "ready" && value?.available === true;
  const resetListenerDraft = (): void => {
    if (value && snapshot.ownerKey) setListenerDraft({ ownerKey: snapshot.ownerKey, revision: value.configurationRevision,
      listenPort: value.listener?.listenPort.toString() ?? "", host: value.listener?.host ?? "", port: value.listener?.port.toString() ?? "" });
  };
  useEffect(() => { if (value && listenerDraft?.ownerKey !== snapshot.ownerKey) resetListenerDraft(); }, [value, snapshot.ownerKey, listenerDraft?.ownerKey]);
  const run = async (ownerKey: string, effect: () => Promise<void>, lease = authorityEpoch.current): Promise<void> => {
    if (!mounted.current || currentOwner.current !== ownerKey || lease !== authorityEpoch.current) return;
    setNotice(undefined);
    try { await effect(); if (mounted.current && currentOwner.current === ownerKey && lease === authorityEpoch.current) setNotice("saved"); }
    catch { if (mounted.current && currentOwner.current === ownerKey && lease === authorityEpoch.current) setNotice("error"); }
  };
  const button = (label: string, effect: () => void, disabled = false, destructive = false) => <Pressable
    accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled}
    onPress={effect} style={[styles.button, { borderColor: colors.border, opacity: disabled ? 0.45 : 1 }]}>
    <Text style={{ color: destructive ? colors.negative : colors.ink }}>{label}</Text>
  </Pressable>;
  const phaseKey = value && ({ off: "settings.voicePeers.off", waiting: "settings.voicePeers.waiting", syncing: "settings.voicePeers.syncing",
    up_to_date: "settings.voicePeers.upToDate", error: "settings.voicePeers.failed" } as const)[value.phase];
  return <View style={[styles.section, { borderColor: colors.border }]}>
    <Text accessibilityRole="header" style={[styles.heading, { color: colors.ink }]}>{t("settings.voicePeers.title")}</Text>
    <Text style={{ color: colors.muted }}>{t("settings.voicePeers.hint")}</Text>
    <Text accessibilityLiveRegion="polite" style={{ color: colors.muted }}>{!owned ? t("settings.voicePeers.unavailable")
      : snapshot.status === "loading" ? t("settings.voicePeers.loading") : value && !value.available ? t("settings.voicePeers.unavailable")
        : phaseKey ? t(phaseKey) : t("settings.voicePeers.failed")}</Text>
    {(notice === "error" || (owned && snapshot.status === "error")) && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{t("settings.voicePeers.failed")}</Text>}
    {value && <>
      <Text style={{ color: colors.muted }}>{t("settings.voicePeers.identity")}</Text>
      <Text selectable style={{ color: colors.ink }}>{value.fingerprint || "—"}</Text>
    </>}
    <View style={styles.actions}>
      {button(t("settings.voicePeers.refresh"), () => { void controller.refresh().catch(() => undefined); }, busy || !transport?.isCurrent())}
      {button(t("settings.voicePeers.syncNow"), () => { const ownerKey = snapshot.ownerKey!; void run(ownerKey, () => controller.syncNow(ownerKey, value!.configurationRevision)); }, busy || !ready || !value?.enabled)}
    </View>
    {value && <>
      <Text accessibilityRole="header" style={[styles.heading, { color: colors.ink }]}>{t("settings.voicePeers.directTitle")}</Text>
      <Text style={{ color: colors.muted }}>{t("settings.voicePeers.directHint")}</Text>
      {listenerDraft && listenerDraft.ownerKey === snapshot.ownerKey && <>
        <Text style={{ color: colors.muted }}>{t("settings.voicePeers.listenPort")}</Text>
        <TextInput accessibilityLabel={t("settings.voicePeers.listenPort")} keyboardType="number-pad" value={listenerDraft.listenPort}
          editable={ready && !busy} onChangeText={(listenPort) => setListenerDraft({ ...listenerDraft, listenPort })}
          style={[styles.input, { color: colors.ink, borderColor: colors.border }]} />
        <Text style={{ color: colors.muted }}>{t("settings.voicePeers.publicHost")}</Text>
        <TextInput accessibilityLabel={t("settings.voicePeers.publicHost")} autoCapitalize="none" autoCorrect={false} value={listenerDraft.host}
          editable={ready && !busy} onChangeText={(host) => setListenerDraft({ ...listenerDraft, host })}
          style={[styles.input, { color: colors.ink, borderColor: colors.border }]} />
        <Text style={{ color: colors.muted }}>{t("settings.voicePeers.publicPort")}</Text>
        <TextInput accessibilityLabel={t("settings.voicePeers.publicPort")} keyboardType="number-pad" value={listenerDraft.port}
          editable={ready && !busy} onChangeText={(port) => setListenerDraft({ ...listenerDraft, port })}
          style={[styles.input, { color: colors.ink, borderColor: colors.border }]} />
        {listenerDraft.revision !== value.configurationRevision && <Text accessibilityLiveRegion="polite" style={{ color: colors.muted }}>{t("settings.voicePeers.changed")}</Text>}
        <View style={styles.actions}>
          {button(t("settings.voicePeers.saveListener"), () => {
            try {
              const listener = readVoiceDictionaryPeerListener({ listenPort: Number(listenerDraft.listenPort), host: listenerDraft.host, port: Number(listenerDraft.port) });
              setInvalidRoute(false); void run(snapshot.ownerKey!, () => controller.configureListener(snapshot.ownerKey!, listenerDraft.revision, listener));
            } catch { setInvalidRoute(true); }
          }, busy || !ready || listenerDraft.revision !== value.configurationRevision)}
          {button(t("settings.voicePeers.reviewListener"), resetListenerDraft, busy || !ready)}
          {button(t("settings.voicePeers.clearListener"), () => { const owner = snapshot.ownerKey!;
            void run(owner, () => controller.configureListener(owner, value.configurationRevision, undefined)); }, busy || !ready || !value.listener)}
        </View>
      </>}
      {button(t("settings.voicePeers.exportInvitation"), () => {
        const owner = snapshot.ownerKey!; const lease = authorityEpoch.current; const revision = value.configurationRevision;
        void run(owner, async () => {
          const text = await controller.invitation(owner, revision);
          if (mounted.current && currentOwner.current === owner && lease === authorityEpoch.current) setInvitation({ ownerKey: owner, revision, text });
        }, lease);
      }, busy || !ready || !value.listener)}
      {invitation && invitation.ownerKey === snapshot.ownerKey && invitation.revision === value.configurationRevision && <>
        <Text style={{ color: colors.muted }}>{t("settings.voicePeers.invitation")}</Text>
        <Text selectable accessibilityLabel={t("settings.voicePeers.invitation")} style={{ color: colors.ink }}>{invitation.text}</Text>
      </>}
      <Text style={{ color: colors.muted }}>{t("settings.voicePeers.pasteInvitation")}</Text>
      <TextInput ref={inviteInput} accessibilityLabel={t("settings.voicePeers.pasteInvitation")} multiline autoCapitalize="none" autoCorrect={false}
        value={inviteDraft} editable={ready && !busy} onChangeText={(text) => { setInviteDraft(text); setInvalidRoute(false); }}
        style={[styles.input, { color: colors.ink, borderColor: colors.border }]} />
      {button(t("settings.voicePeers.previewInvitation"), () => {
        try {
          const preview = readVoiceDictionaryPeerInvitation(inviteDraft);
          if (preview.nodeId === value.nodeId || value.peers.some((peer) => peer.peerId === preview.nodeId && peer.fingerprint !== preview.fingerprint)) throw new Error("Dictionary peer identity changed.");
          setInvalidRoute(false);
          const owner = snapshot.ownerKey!; const lease = authorityEpoch.current; const revision = value.configurationRevision; const text = inviteDraft;
          Alert.alert(t("settings.voicePeers.allowTitle", { name: preview.displayName }),
            `${t("settings.voicePeers.allowBody")}\n\n${t("settings.voicePeers.configuredRoute", { host: preview.host, port: preview.port })}\n\n${preview.fingerprint}`, [
              { text: t("common.cancel"), style: "cancel", onPress: () => inviteInput.current?.focus() },
              { text: t("settings.voicePeers.confirm"), onPress: () => {
                if (inviteCurrent.current === text) void run(owner, () => controller.grantDirect(owner, revision, text, preview.fingerprint), lease);
              } }
            ]);
        } catch { setInvalidRoute(true); }
      }, busy || !ready || !inviteDraft)}
      {invalidRoute && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{t("settings.voicePeers.invalidRoute")}</Text>}
      <Text style={[styles.heading, { color: colors.ink }]}>{t("settings.voicePeers.authorized")}</Text>
      {value.peers.length === 0 && <Text style={{ color: colors.muted }}>{t("settings.voicePeers.noPeers")}</Text>}
      {value.peers.map((peer) => <View key={peer.peerId} style={[styles.peer, { backgroundColor: colors.surface }]}>
        <Text style={{ color: colors.ink }}>{peer.displayName}</Text>
        <Text style={{ color: colors.muted }}>{t(peer.online ? "settings.voicePeers.online" : "settings.voicePeers.offline")}</Text>
        <Text selectable style={{ color: colors.ink }}>{peer.fingerprint}</Text>
        {peer.route && <Text style={{ color: colors.muted }}>{t("settings.voicePeers.configuredRoute", { host: peer.route.host, port: peer.route.port })}</Text>}
        {peer.lastSyncAt !== undefined && <Text style={{ color: colors.muted }}>{t("settings.voicePeers.lastSync", { time: new Date(peer.lastSyncAt).toLocaleString() })}</Text>}
        {peer.route && button(t("settings.voicePeers.clearRoute"), () => { const owner = snapshot.ownerKey!;
          void run(owner, () => controller.clearRoute(owner, value.configurationRevision, peer.peerId)); }, busy || !ready)}
        {button(t("settings.voicePeers.revoke"), () => {
          const ownerKey = snapshot.ownerKey!;
          const lease = authorityEpoch.current;
          Alert.alert(t("settings.voicePeers.revokeTitle", { name: peer.displayName }), `${t("settings.voicePeers.revokeBody")}\n\n${peer.fingerprint}`, [
            { text: t("common.cancel"), style: "cancel" }, { text: t("settings.voicePeers.confirm"), style: "destructive",
              onPress: () => { void run(ownerKey, () => controller.revoke(ownerKey, peer.peerId, peer.revision), lease); } }
          ]);
        }, busy || !ready, true)}
      </View>)}
      <Text style={[styles.heading, { color: colors.ink }]}>{t("settings.voicePeers.candidates")}</Text>
      {!value.enabled && <Text style={{ color: colors.muted }}>{t("settings.voicePeers.offHint")}</Text>}
      {value.enabled && value.candidates.filter((peer) => !peer.granted).length === 0 && <Text style={{ color: colors.muted }}>{t("settings.voicePeers.noCandidates")}</Text>}
      {value.candidates.filter((peer) => !peer.granted).map((peer) => <View key={peer.nodeId} style={[styles.peer, { backgroundColor: colors.surface }]}>
        <Text style={{ color: colors.ink }}>{peer.displayName}</Text>
        <Text selectable style={{ color: colors.ink }}>{peer.fingerprint}</Text>
        {peer.keyChanged && <Text style={{ color: colors.negative }}>{t("settings.voicePeers.keyChanged")}</Text>}
        {button(t("settings.voicePeers.allow"), () => {
          const ownerKey = snapshot.ownerKey!;
          const lease = authorityEpoch.current;
          const revision = value.configurationRevision;
          Alert.alert(t("settings.voicePeers.allowTitle", { name: peer.displayName }), `${t("settings.voicePeers.allowBody")}\n\n${peer.fingerprint}`, [
            { text: t("common.cancel"), style: "cancel" }, { text: t("settings.voicePeers.confirm"),
              onPress: () => { void run(ownerKey, () => controller.grant(ownerKey, revision, peer.nodeId, peer.fingerprint), lease); } }
          ]);
        }, busy || !ready || !value.enabled || peer.keyChanged)}
      </View>)}
    </>}
    {owned && notice === "saved" && <Text accessibilityLiveRegion="polite" style={{ color: colors.muted }}>{t("settings.voicePeers.saved")}</Text>}
  </View>;
}
const styles = StyleSheet.create({ section: { gap: 10, paddingTop: 16, borderTopWidth: 1 }, heading: { fontSize: 16, fontWeight: "600" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 }, button: { paddingHorizontal: 12, paddingVertical: 12, borderWidth: 1, borderRadius: 10 },
  input: { borderWidth: 1, borderRadius: 10, padding: 12, minHeight: 44 }, peer: { padding: 12, borderRadius: 12, gap: 8 } });
