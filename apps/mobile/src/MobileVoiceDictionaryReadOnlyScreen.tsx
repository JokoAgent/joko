import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Alert, BackHandler, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import type { MobileSettingsColors } from "./MobileSettingsScreen";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import { mobileReadOnlyDictionaryEntryViews, mobileReadOnlyDictionaryScope } from "./mobile-voice-dictionary-readonly";
import type { MobileVoiceDictionaryReadOnlyController } from "./mobile-voice-dictionary-readonly-controller";

export function MobileVoiceDictionaryReadOnlyScreen(props: {
  readonly colors: MobileSettingsColors; readonly locale: MobileSupportedLocale; readonly foreground: boolean;
  readonly controller: MobileVoiceDictionaryReadOnlyController; readonly onBack: () => void;
  readonly backLabel?: string;
}) {
  const { colors, locale, controller } = props;
  const state = useSyncExternalStore((listener) => controller.subscribe(listener), () => controller.state);
  const [error, setError] = useState(false);
  const lease = useRef(0);
  const t = (key: Parameters<typeof mobileMessage>[1], variables?: Readonly<Record<string, string | number>>) => mobileMessage(locale, key, variables);
  const sources = state.hosts.map((host) => mobileReadOnlyDictionaryScope(host.profile)).join("\u001f");
  useEffect(() => {
    lease.current += 1;
    controller.setVisible(props.foreground);
    return () => { lease.current += 1; controller.setVisible(false); };
  }, [controller, props.foreground]);
  useEffect(() => { lease.current += 1; setError(false); }, [sources]);
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => { props.onBack(); return true; });
    return () => subscription.remove();
  }, [props.onBack]);
  const selected = state.selected;
  const entries = mobileReadOnlyDictionaryEntryViews(selected);
  const run = async (effect: () => Promise<void>): Promise<void> => {
    const occurrence = lease.current; setError(false);
    try { await effect(); } catch { if (lease.current === occurrence) setError(true); }
  };
  const action = (label: string, onPress: () => void, disabled = false) => <Pressable accessibilityRole="button"
    accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={[styles.button, { backgroundColor: colors.surface, borderColor: colors.border }, disabled && styles.disabled]}>
    <Text style={{ color: colors.ink }}>{label}</Text>
  </Pressable>;
  const note = (text: string, failed = false) => <Text accessibilityRole={failed ? "alert" : "text"}
    style={[styles.note, { color: failed ? colors.negative : colors.muted }]}>{text}</Text>;
  return <FlatList contentContainerStyle={[styles.screen, { backgroundColor: colors.background }]}
    data={entries} keyExtractor={(entry) => entry.key}
    ListHeaderComponent={<>
      {action(t("common.backTo", { label: props.backLabel ?? t("settings.title") }), props.onBack)}
      <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{t("settings.voiceReadonly.title")}</Text>
      {note(t("settings.voiceReadonly.description"))}
      {!props.foreground && note(t("settings.voiceReadonly.foreground"))}
      {state.hosts.length === 0 && note(t("settings.voiceReadonly.noNodes"))}
      {state.hosts.map((host) => <View key={mobileReadOnlyDictionaryScope(host.profile)}
        style={[styles.host, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={{ color: colors.ink }}>{host.profile.displayName}</Text>
        {note(t(`settings.voiceReadonly.${host.status}`), host.status === "error")}
        {host.cacheError && <>
          {note(t("settings.voiceReadonly.cacheError"), true)}
          {action(t("settings.voiceReadonly.rebuild", { node: host.profile.displayName }), () => {
            const occurrence = lease.current;
            const scope = mobileReadOnlyDictionaryScope(host.profile);
            Alert.alert(t("settings.voiceReadonly.resetTitle"), t("settings.voiceReadonly.resetBody", { node: host.profile.displayName }), [
              { text: t("common.cancel"), style: "cancel" },
              { text: t("common.clear"), style: "destructive", onPress: () => {
                if (lease.current !== occurrence || !controller.state.visible
                  || !controller.state.hosts.some((source) => mobileReadOnlyDictionaryScope(source.profile) === scope)) return;
                void run(() => controller.rebuildCache(host.profile.profileId));
              } }
            ]);
          }, !props.foreground || state.refreshing)}
        </>}
      </View>)}
      {state.refreshing && note(t("settings.voiceReadonly.refreshing"))}
      {action(t("settings.voiceReadonly.refresh"), () => void run(() => controller.refresh()),
        !props.foreground || state.refreshing || state.hosts.length === 0)}
      {selected && <>
        {note(t("settings.voiceReadonly.source", { node: selected.profile.displayName }))}
        {note(t("settings.voiceReadonly.fetchedAt", { time: new Date(selected.fetchedAt).toLocaleString(locale) }))}
        {!selected.snapshot.syncEnabled && note(t("settings.voiceReadonly.off"))}
      </>}
      {error && note(t("settings.voiceReadonly.failed"), true)}
    </>}
    ListEmptyComponent={note(t("settings.voiceReadonly.empty"))}
    renderItem={({ item }) => <View style={[styles.entry, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.term, { color: colors.ink }]}>{item.text}</Text>
      {note(t("settings.voice.frequency", { count: item.frequency }))}
      {item.aliases.length > 0 && note(`${t("settings.voice.aliases")}: ${item.aliases.join(" · ")}`)}
    </View>} />;
}

const styles = StyleSheet.create({ screen: { padding: 20, paddingBottom: 40, gap: 12 },
  title: { fontSize: 24, fontWeight: "600", marginVertical: 12 }, note: { fontSize: 13, lineHeight: 19, marginVertical: 5 },
  host: { borderWidth: 1, borderRadius: 14, padding: 14, marginVertical: 6 },
  entry: { borderWidth: 1, borderRadius: 14, padding: 16, marginVertical: 5 }, term: { fontSize: 17, fontWeight: "500" },
  button: { borderWidth: 1, borderRadius: 12, minHeight: 44, padding: 12, alignItems: "center", marginVertical: 6 }, disabled: { opacity: 0.45 } });
