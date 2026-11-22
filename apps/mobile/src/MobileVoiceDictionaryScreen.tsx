import { useEffect, useRef, useState } from "react";
import {
  Alert,
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View
} from "react-native";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import type { MobileVoicePreferencesStoreState } from "./mobile-voice-preferences-store";
import type { MobileSettingsColors } from "./MobileSettingsScreen";
import { MobileVoiceServiceSettings, type MobileVoiceServiceDraft } from "./MobileVoiceServiceSettings";
import type { MobileVoiceSettingsTransport } from "./mobile-voice-service-settings";
import type { MutableRefObject } from "react";

export interface MobileVoiceDictionaryScreenProps {
  readonly colors: MobileSettingsColors;
  readonly locale: MobileSupportedLocale;
  readonly state: MobileVoicePreferencesStoreState;
  readonly serviceTransport?: MobileVoiceSettingsTransport;
  readonly serviceDraftCache?: MutableRefObject<MobileVoiceServiceDraft | undefined>;
  readonly onSetRecognitionContext?: (enabled: boolean, contextData: readonly { readonly text: string }[]) => Promise<void>;
  readonly onBack: () => void;
  readonly onRetry: () => Promise<void>;
  readonly onReset: () => Promise<void>;
  readonly onSetInstructions: (value: string) => Promise<void>;
  readonly onSetAutoLearning: (enabled: boolean) => Promise<void>;
  readonly onReadOnlyDictionary?: () => void;
}

export function MobileVoiceDictionaryScreen(props: MobileVoiceDictionaryScreenProps) {
  const { colors, locale, state } = props;
  const t = (key: Parameters<typeof mobileMessage>[1], variables?: Readonly<Record<string, string | number>>) =>
    mobileMessage(locale, key, variables);
  const [instructions, setInstructions] = useState(state.document.refinementInstructions);
  const [instructionDirty, setInstructionDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    if (!instructionDirty) setInstructions(state.document.refinementInstructions);
  }, [instructionDirty, state.document.refinementInstructions]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (busy || state.saving) return true;
      props.onBack();
      return true;
    });
    return () => subscription.remove();
  }, [busy, props.onBack, state.saving]);

  const run = async (action: () => Promise<void>, success?: string): Promise<boolean> => {
    if (busyRef.current || state.saving) return false;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      if (!mounted.current) return false;
      if (success) setNotice(success);
      return true;
    } catch {
      if (mounted.current) setError(t("settings.voice.saveError"));
      return false;
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  if (state.status === "loading") return <ScrollView
    contentContainerStyle={[styles.screen, { backgroundColor: colors.background }]}>
    <BackButton label={t("settings.voice.title")} locale={locale} colors={colors} onPress={props.onBack} />
    <Text style={[styles.title, { color: colors.ink }]}>{t("settings.voice.title")}</Text>
    <Notice colors={colors} text={t("settings.voice.loading")} />
  </ScrollView>;

  if (state.status === "error") return <ScrollView
    contentContainerStyle={[styles.screen, { backgroundColor: colors.background }]}>
    <BackButton label={t("settings.voice.title")} locale={locale} colors={colors} onPress={props.onBack} />
    <Text style={[styles.title, { color: colors.ink }]}>{t("settings.voice.title")}</Text>
    <ErrorNotice colors={colors} text={t("settings.voice.error")} />
    <View style={styles.actionRow}>
      <Button label={t("common.retry")} colors={colors} disabled={busy || state.saving}
        onPress={() => void run(props.onRetry)} />
      <Button label={t("settings.voice.reset")} colors={colors} destructive disabled={busy || state.saving} onPress={() => {
        Alert.alert(t("settings.voice.resetTitle"), t("settings.voice.resetBody"), [
          { text: t("common.cancel"), style: "cancel" },
          { text: t("settings.voice.reset"), style: "destructive", onPress: () => void run(props.onReset) }
        ]);
      }} />
    </View>
  </ScrollView>;

  const document = state.document;
  return <ScrollView contentContainerStyle={[styles.screen, { backgroundColor: colors.background }]}
    keyboardShouldPersistTaps="handled">
    <BackButton label={t("settings.voice.title")} locale={locale} colors={colors} onPress={props.onBack} />
    <Text style={[styles.title, { color: colors.ink }]}>{t("settings.voice.title")}</Text>
    <Text style={[styles.description, { color: colors.muted }]}>{t("settings.voice.description")}</Text>
    <Notice colors={colors} text={t("settings.voice.privacy")} />
    {props.onReadOnlyDictionary && <Button label={t("settings.voiceReadonly.title")} colors={colors}
      onPress={props.onReadOnlyDictionary} />}

    <MobileVoiceServiceSettings colors={colors} locale={locale} transport={props.serviceTransport}
      cache={props.serviceDraftCache} preferences={state} onSetContext={props.onSetRecognitionContext} />

    <Text style={[styles.section, { color: colors.muted }]}>{t("settings.voice.instructions")}</Text>
    <Text style={[styles.caption, { color: colors.muted }]}>{t("settings.voice.instructionsHint")}</Text>
    <TextInput accessibilityLabel={t("settings.voice.instructions")} value={instructions} editable={!busy && !state.saving}
      multiline maxLength={1_000} onChangeText={(value) => { setInstructions(value); setInstructionDirty(true); }}
      placeholder={t("settings.voice.instructionsPlaceholder")} placeholderTextColor={colors.muted}
      style={[styles.input, styles.instructionInput,
        { color: colors.ink, backgroundColor: colors.surface, borderColor: colors.border }]} />
    <View style={styles.inlineEnd}>
      <Text style={[styles.caption, { color: colors.muted }]}>{t("settings.voice.characters", { count: instructions.length })}</Text>
      <Button label={t("settings.voice.saveInstructions")} colors={colors}
        disabled={busy || state.saving || !instructionDirty || instructions.length > 1_000}
        onPress={() => void run(() => props.onSetInstructions(instructions), t("settings.voice.instructionsSaved"))
          .then((saved) => { if (saved) setInstructionDirty(false); })} />
    </View>

    <View style={[styles.toggleRow, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.fill}>
        <Text style={[styles.label, { color: colors.ink }]}>{t("settings.voice.autoLearning")}</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>{t("settings.voice.autoLearningHint")}</Text>
      </View>
      <Switch accessibilityLabel={t("settings.voice.autoLearning")} value={document.autoLearningEnabled}
        disabled={busy || state.saving} trackColor={{ false: colors.border, true: colors.accent }}
        onValueChange={(enabled) => void run(() => props.onSetAutoLearning(enabled))} />
    </View>

    <Text style={[styles.section, { color: colors.muted }]}>{t("settings.voice.localActivity")}</Text>
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Stat label={t("settings.voice.starts")} value={document.usage.voiceStarts} colors={colors} />
      <Stat label={t("settings.voice.corrections")} value={document.usage.correctionObservations} colors={colors} />
      <Stat label={t("settings.voice.history")} value={document.history.length} colors={colors} />
    </View>
    {(error || state.error) && <ErrorNotice colors={colors} text={error || t("settings.voice.localSaveError")} />}
    {notice && <Text accessibilityLiveRegion="polite" style={[styles.noticeText, { color: colors.ink }]}>{notice}</Text>}
  </ScrollView>;

}

function Stat({ label, value, colors }: { readonly label: string; readonly value: number; readonly colors: MobileSettingsColors }) {
  return <View style={styles.statRow}>
    <Text style={[styles.caption, { color: colors.muted }]}>{label}</Text>
    <Text style={[styles.label, { color: colors.ink }]}>{value}</Text>
  </View>;
}

function BackButton({ label, locale, colors, disabled, onPress }: {
  readonly label: string; readonly locale: MobileSupportedLocale; readonly colors: MobileSettingsColors;
  readonly disabled?: boolean; readonly onPress: () => void;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "common.backTo", { label })}
    disabled={disabled} onPress={onPress} style={[styles.back, disabled && styles.disabled]}>
    <Text style={[styles.backText, { color: colors.accent }]}>‹ {label}</Text>
  </Pressable>;
}

function Button({ label, colors, disabled, destructive, onPress }: {
  readonly label: string; readonly colors: MobileSettingsColors; readonly disabled?: boolean;
  readonly destructive?: boolean; readonly onPress: () => void;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress}
    style={[styles.button, disabled && styles.disabled, { borderColor: destructive ? colors.negative : colors.border }]}>
    <Text style={[styles.buttonText, { color: destructive ? colors.negative : colors.ink }]}>{label}</Text>
  </Pressable>;
}

function Notice({ colors, text }: { readonly colors: MobileSettingsColors; readonly text: string }) {
  return <View style={[styles.notice, { backgroundColor: colors.brandBackground, borderColor: colors.border }]}>
    <Text style={[styles.caption, { color: colors.ink }]}>{text}</Text>
  </View>;
}

function ErrorNotice({ colors, text }: { readonly colors: MobileSettingsColors; readonly text: string }) {
  return <View accessibilityRole="alert" style={[styles.notice, { backgroundColor: colors.surface, borderColor: colors.negative }]}>
    <Text style={[styles.caption, { color: colors.negative }]}>{text}</Text>
  </View>;
}

const styles = StyleSheet.create({
  screen: { flexGrow: 1, paddingHorizontal: 20, paddingTop: 14, paddingBottom: 44, gap: 12 },
  back: { alignSelf: "flex-start", minHeight: 44, justifyContent: "center" },
  backText: { fontSize: 16, fontWeight: "700" },
  title: { fontSize: 30, lineHeight: 36, fontWeight: "800" },
  description: { fontSize: 15, lineHeight: 22 },
  section: { marginTop: 10, fontSize: 12, fontWeight: "800", letterSpacing: 0.8, textTransform: "uppercase" },
  label: { fontSize: 15, lineHeight: 21, fontWeight: "700" },
  caption: { fontSize: 13, lineHeight: 19 },
  input: { minHeight: 48, borderWidth: 1, borderRadius: 12, paddingHorizontal: 13, paddingVertical: 11, fontSize: 15 },
  instructionInput: { minHeight: 112, textAlignVertical: "top" },
  card: { minHeight: 58, borderWidth: 1, borderRadius: 14, padding: 13, flexDirection: "row", alignItems: "center", gap: 12 },
  toggleRow: { minHeight: 76, borderWidth: 1, borderRadius: 14, padding: 13, flexDirection: "row", alignItems: "center", gap: 12 },
  notice: { borderWidth: 1, borderRadius: 12, padding: 12 },
  noticeText: { fontSize: 14, lineHeight: 20, fontWeight: "600" },
  fill: { flex: 1 },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  inlineEnd: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  statRow: { flex: 1, gap: 2 },
  button: { minHeight: 42, borderWidth: 1, borderRadius: 11, paddingHorizontal: 13, justifyContent: "center" },
  buttonText: { fontSize: 14, fontWeight: "700" },
  disabled: { opacity: 0.45 }
});
