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
import {
  previewMobileVoiceDictionaryEdit,
  type MobileVoiceDictionaryEntry
} from "./mobile-voice-dictionary";
import type {
  MobileVoiceDictionaryEditOutcome,
  MobileVoiceDictionaryStoreState
} from "./mobile-voice-dictionary-store";
import type { MobileSettingsColors } from "./MobileSettingsScreen";

export interface MobileVoiceDictionaryScreenProps {
  readonly colors: MobileSettingsColors;
  readonly locale: MobileSupportedLocale;
  readonly state: MobileVoiceDictionaryStoreState;
  readonly onBack: () => void;
  readonly onRetry: () => Promise<void>;
  readonly onReset: () => Promise<void>;
  readonly onSetInstructions: (value: string) => Promise<void>;
  readonly onSetAutoLearning: (enabled: boolean) => Promise<void>;
  readonly onAddTerm: (value: string) => Promise<void>;
  readonly onEditEntry: (id: string, text: string, aliases: string) => Promise<MobileVoiceDictionaryEditOutcome>;
  readonly onDeleteEntry: (id: string) => Promise<void>;
}

interface Editor {
  readonly id: string;
  readonly originalTerm: string;
  readonly term: string;
  readonly aliases: string;
}

export function MobileVoiceDictionaryScreen(props: MobileVoiceDictionaryScreenProps) {
  const { colors, locale, state } = props;
  const t = (key: Parameters<typeof mobileMessage>[1], variables?: Readonly<Record<string, string | number>>) =>
    mobileMessage(locale, key, variables);
  const [instructions, setInstructions] = useState(state.document.refinementInstructions);
  const [instructionDirty, setInstructionDirty] = useState(false);
  const [termDraft, setTermDraft] = useState("");
  const [editor, setEditor] = useState<Editor>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [focusAdd, setFocusAdd] = useState(false);
  const addInputRef = useRef<TextInput>(null);
  const editInputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (!instructionDirty) setInstructions(state.document.refinementInstructions);
  }, [instructionDirty, state.document.refinementInstructions]);

  useEffect(() => {
    if (!focusAdd || busy || state.saving || state.status !== "ready") return;
    setFocusAdd(false);
    requestAnimationFrame(() => addInputRef.current?.focus());
  }, [busy, focusAdd, state.saving, state.status]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (busy || state.saving) return true;
      if (editor) setEditor(undefined);
      else props.onBack();
      return true;
    });
    return () => subscription.remove();
  }, [busy, editor, props.onBack, state.saving]);

  const run = async (action: () => Promise<void>, success?: string): Promise<boolean> => {
    if (busy || state.saving) return false;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      if (success) setNotice(success);
      return true;
    } catch {
      setError(t("settings.voice.saveError"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (editor) {
    const source = state.document.dictionary.entries.find((entry) => entry.id === editor.id);
    const preview = previewMobileVoiceDictionaryEdit(state.document.dictionary, editor.id, editor.term);
    const disabled = busy || state.saving || state.status !== "ready" || source === undefined;
    const save = async (): Promise<void> => {
      if (disabled) return;
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const outcome = await props.onEditEntry(editor.id, editor.term, editor.aliases);
        setEditor(undefined);
        setFocusAdd(true);
        setNotice(t(outcome === "deleted" ? "settings.voice.deleted"
          : outcome === "mergedEntry" || outcome === "mergedCandidate" ? "settings.voice.merged"
            : "settings.voice.updated"));
      } catch {
        setError(t("settings.voice.saveError"));
      } finally {
        setBusy(false);
      }
    };
    const requestDelete = (): void => {
      if (!source || disabled) return;
      Alert.alert(t("settings.voice.deleteTitle", { term: source.text }), t("settings.voice.deleteBody"), [
        { text: t("common.cancel"), style: "cancel" },
        { text: t("settings.voice.deleteEntry"), style: "destructive", onPress: () => {
          void run(() => props.onDeleteEntry(source.id)).then((deleted) => {
            if (!deleted) return;
            setEditor(undefined);
            setFocusAdd(true);
            setNotice(t("settings.voice.deleted"));
          });
        } }
      ]);
    };
    return <ScrollView contentContainerStyle={[styles.screen, { backgroundColor: colors.background }]}
      keyboardShouldPersistTaps="handled">
      <BackButton label={t("settings.voice.title")} locale={locale} colors={colors} disabled={busy || state.saving}
        onPress={() => setEditor(undefined)} />
      <Text style={[styles.title, { color: colors.ink }]}>{t("settings.voice.editTitle")}</Text>
      <TextInput ref={editInputRef} accessibilityLabel={t("settings.voice.term")} value={editor.term}
        editable={!disabled} maxLength={120} autoCorrect={false} autoFocus
        onChangeText={(term) => setEditor((current) => current ? { ...current, term } : current)}
        placeholder={t("settings.voice.termPlaceholder")} placeholderTextColor={colors.muted}
        style={[styles.input, { color: colors.ink, backgroundColor: colors.surface, borderColor: colors.border }]} />
      <Text style={[styles.caption, { color: colors.muted }]}>{t("settings.voice.aliasesHint")}</Text>
      <TextInput accessibilityLabel={t("settings.voice.aliases")} value={editor.aliases} editable={!disabled}
        multiline maxLength={968} autoCorrect={false}
        onChangeText={(aliases) => setEditor((current) => current ? { ...current, aliases } : current)}
        style={[styles.input, styles.aliasInput,
          { color: colors.ink, backgroundColor: colors.surface, borderColor: colors.border }]} />
      {preview?.kind === "mergeEntry" && <Notice colors={colors}
        text={t("settings.voice.mergeEntry", { term: preview.targetText })} />}
      {preview?.kind === "mergeCandidate" && <Notice colors={colors}
        text={t("settings.voice.mergeCandidate", { term: preview.targetText, count: preview.evidenceCount })} />}
      {error && <ErrorNotice colors={colors} text={error} />}
      <View style={styles.actionRow}>
        <Button label={t("common.cancel")} colors={colors} disabled={busy || state.saving}
          onPress={() => setEditor(undefined)} />
        <Button label={t("settings.voice.saveEntry")} colors={colors}
          disabled={disabled || editor.term.trim() === ""} onPress={() => void save()} />
        <Button label={t("settings.voice.deleteEntry")} colors={colors} destructive disabled={disabled}
          onPress={requestDelete} />
      </View>
    </ScrollView>;
  }

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
  const entries = document.dictionary.entries.slice().sort((left, right) =>
    Number(left.source === "automatic") - Number(right.source === "automatic")
      || right.frequency - left.frequency || left.text.localeCompare(right.text));
  const candidates = document.dictionary.candidates.slice().sort((left, right) =>
    right.evidenceCount - left.evidenceCount || left.text.localeCompare(right.text));
  return <ScrollView contentContainerStyle={[styles.screen, { backgroundColor: colors.background }]}
    keyboardShouldPersistTaps="handled">
    <BackButton label={t("settings.voice.title")} locale={locale} colors={colors} onPress={props.onBack} />
    <Text style={[styles.title, { color: colors.ink }]}>{t("settings.voice.title")}</Text>
    <Text style={[styles.description, { color: colors.muted }]}>{t("settings.voice.description")}</Text>
    <Notice colors={colors} text={t("settings.voice.privacy")} />

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

    <Text style={[styles.section, { color: colors.muted }]}>{t("settings.voice.entries")}</Text>
    <View style={styles.addRow}>
      <TextInput ref={addInputRef} accessibilityLabel={t("settings.voice.term")} value={termDraft}
        editable={!busy && !state.saving} maxLength={120} autoCorrect={false} onSubmitEditing={() => {
          if (termDraft.trim()) void addTerm();
        }} onChangeText={setTermDraft} placeholder={t("settings.voice.termPlaceholder")}
        placeholderTextColor={colors.muted}
        style={[styles.input, styles.fill, { color: colors.ink, backgroundColor: colors.surface, borderColor: colors.border }]} />
      <Button label={t("settings.voice.addTerm")} colors={colors}
        disabled={busy || state.saving || !termDraft.trim()} onPress={() => void addTerm()} />
    </View>
    {entries.length === 0 ? <Notice colors={colors} text={t("settings.voice.entriesEmpty")} />
      : entries.map((entry) => <DictionaryEntry key={entry.id} entry={entry} colors={colors} locale={locale}
        disabled={busy || state.saving} onPress={() => {
          setError(""); setNotice("");
          setEditor({ id: entry.id, originalTerm: entry.text, term: entry.text,
            aliases: entry.aliases.map((alias) => alias.text).join("\n") });
        }} />)}

    <Text style={[styles.section, { color: colors.muted }]}>{t("settings.voice.candidates")}</Text>
    {candidates.length === 0 ? <Notice colors={colors} text={t("settings.voice.candidatesEmpty")} />
      : candidates.map((candidate) => <View key={candidate.text}
        style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.fill}>
          <Text style={[styles.label, { color: colors.ink }]}>{candidate.text}</Text>
          <Text style={[styles.caption, { color: colors.muted }]}>
            {t("settings.voice.frequency", { count: candidate.evidenceCount })}
          </Text>
        </View>
        <Button label={t("settings.voice.confirmCandidate", { term: candidate.text })} colors={colors}
          disabled={busy || state.saving} onPress={() => void run(
            () => props.onAddTerm(candidate.text), t("settings.voice.added")
          )} />
      </View>)}

    <Text style={[styles.section, { color: colors.muted }]}>{t("settings.voice.localActivity")}</Text>
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Stat label={t("settings.voice.starts")} value={document.usage.voiceStarts} colors={colors} />
      <Stat label={t("settings.voice.corrections")} value={document.usage.correctionObservations} colors={colors} />
      <Stat label={t("settings.voice.history")} value={document.history.length} colors={colors} />
    </View>
    {(error || state.error) && <ErrorNotice colors={colors} text={error || t("settings.voice.saveError")} />}
    {notice && <Text accessibilityLiveRegion="polite" style={[styles.noticeText, { color: colors.ink }]}>{notice}</Text>}
  </ScrollView>;

  async function addTerm(): Promise<void> {
    const value = termDraft;
    if (!value.trim()) return;
    const added = await run(() => props.onAddTerm(value), t("settings.voice.added"));
    if (added) { setTermDraft(""); setFocusAdd(true); }
  }
}

function DictionaryEntry({ entry, colors, locale, disabled, onPress }: {
  readonly entry: MobileVoiceDictionaryEntry;
  readonly colors: MobileSettingsColors;
  readonly locale: MobileSupportedLocale;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "settings.voice.edit", { term: entry.text })}
    disabled={disabled} onPress={onPress}
    style={[styles.card, disabled && styles.disabled, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <View style={styles.fill}>
      <Text style={[styles.label, { color: colors.ink }]}>{entry.text}</Text>
      <Text style={[styles.caption, { color: colors.muted }]}>
        {mobileMessage(locale, entry.source === "manual" ? "settings.voice.manual" : "settings.voice.automatic")}
        {` · ${mobileMessage(locale, "settings.voice.frequency", { count: entry.frequency })}`}
      </Text>
      {entry.aliases.length > 0 && <Text style={[styles.caption, { color: colors.muted }]}>
        {entry.aliases.map((alias) => alias.text).join(" · ")}
      </Text>}
    </View>
    <Text style={[styles.chevron, { color: colors.muted }]}>›</Text>
  </Pressable>;
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
  aliasInput: { minHeight: 150, textAlignVertical: "top" },
  card: { minHeight: 58, borderWidth: 1, borderRadius: 14, padding: 13, flexDirection: "row", alignItems: "center", gap: 12 },
  toggleRow: { minHeight: 76, borderWidth: 1, borderRadius: 14, padding: 13, flexDirection: "row", alignItems: "center", gap: 12 },
  notice: { borderWidth: 1, borderRadius: 12, padding: 12 },
  noticeText: { fontSize: 14, lineHeight: 20, fontWeight: "600" },
  fill: { flex: 1 },
  addRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  inlineEnd: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  statRow: { flex: 1, gap: 2 },
  button: { minHeight: 42, borderWidth: 1, borderRadius: 11, paddingHorizontal: 13, justifyContent: "center" },
  buttonText: { fontSize: 14, fontWeight: "700" },
  chevron: { fontSize: 24 },
  disabled: { opacity: 0.45 }
});
