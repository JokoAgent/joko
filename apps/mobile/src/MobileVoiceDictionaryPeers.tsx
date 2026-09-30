import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
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
  const mounted = useRef(false);
  const authorityEpoch = useRef(0);
  const currentOwner = useRef(transport?.ownerKey); currentOwner.current = transport?.ownerKey;
  const t = (key: Parameters<typeof mobileMessage>[1], variables?: Readonly<Record<string, string | number>>) => mobileMessage(locale, key, variables);
  useEffect(() => {
    authorityEpoch.current += 1;
    mounted.current = true; setNotice(undefined); controller.setTransport(transport);
    const timer = transport ? setInterval(() => { void controller.refresh().catch(() => undefined); }, 5_000) : undefined;
    return () => { authorityEpoch.current += 1; mounted.current = false; controller.setTransport(undefined); if (timer !== undefined) clearInterval(timer); };
  }, [controller, transport?.ownerKey]);
  const owned = transport?.isCurrent() && transport.ownerKey === snapshot.ownerKey;
  const value = owned ? snapshot.value : undefined;
  const busy = owned && snapshot.busy;
  const ready = owned && snapshot.status === "ready" && value?.available === true;
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
      <Text style={[styles.heading, { color: colors.ink }]}>{t("settings.voicePeers.authorized")}</Text>
      {value.peers.length === 0 && <Text style={{ color: colors.muted }}>{t("settings.voicePeers.noPeers")}</Text>}
      {value.peers.map((peer) => <View key={peer.peerId} style={[styles.peer, { backgroundColor: colors.surface }]}>
        <Text style={{ color: colors.ink }}>{peer.displayName}</Text>
        <Text style={{ color: colors.muted }}>{t(peer.online ? "settings.voicePeers.online" : "settings.voicePeers.offline")}</Text>
        <Text selectable style={{ color: colors.ink }}>{peer.fingerprint}</Text>
        {peer.lastSyncAt !== undefined && <Text style={{ color: colors.muted }}>{t("settings.voicePeers.lastSync", { time: new Date(peer.lastSyncAt).toLocaleString() })}</Text>}
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
  peer: { padding: 12, borderRadius: 12, gap: 8 } });
