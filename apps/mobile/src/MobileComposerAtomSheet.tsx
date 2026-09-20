import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import {
  mobileComposerAtomLabel,
  mobileLongPasteMaximumCharacters,
  type MobileComposerAtom
} from "./mobile-composer-document";

export function MobileComposerAtomSheet({
  atom,
  colors,
  busy,
  onClose,
  onSavePaste,
  onRemove
}: {
  readonly atom?: MobileComposerAtom;
  readonly colors: MobileInteractionSheetColors;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onSavePaste: (atomId: string, text: string) => void;
  readonly onRemove: (atomId: string) => void;
}) {
  const [pasteText, setPasteText] = useState("");
  useEffect(() => setPasteText(atom?.kind === "pasted-text" ? atom.text : ""), [atom?.atomId]);
  if (!atom) return null;
  const changed = atom.kind === "pasted-text" && pasteText !== atom.text;
  const canSave = changed && pasteText.length > 0 && pasteText.length <= mobileLongPasteMaximumCharacters && !busy;

  return <Modal visible transparent animationType="slide" statusBarTranslucent onRequestClose={onClose}>
    <View style={styles.root}>
      <Pressable accessibilityRole="button" accessibilityLabel="Close structured message item"
        disabled={busy} onPress={onClose} style={styles.backdrop} />
      <SafeAreaView accessibilityViewIsModal importantForAccessibility="yes" edges={["bottom", "left", "right"]}
        style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={[styles.eyebrow, { color: colors.muted }]}>Structured message item</Text>
            <Text style={[styles.title, { color: colors.ink }]}>{mobileComposerAtomLabel(atom)}</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Close structured message item"
            disabled={busy} onPress={onClose} style={styles.close}>
            <Text style={[styles.closeText, { color: colors.ink }]}>×</Text>
          </Pressable>
        </View>
        {atom.kind === "quote" && <Text style={[styles.help, { color: colors.muted }]}>Quoted from the exact assistant message in task {atom.sourceSessionId}.</Text>}
        {atom.kind === "route-reference" && <Text style={[styles.help, { color: colors.muted }]}>
          {atom.messageId || atom.eventId ? "Message link" : "Task link"} · task {atom.sessionId}. This link does not grant task access or navigate automatically.
        </Text>}
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          {atom.kind === "quote"
            ? <Text selectable accessibilityLabel="Quoted assistant text"
                style={[styles.readText, { color: colors.ink, backgroundColor: colors.background, borderColor: colors.border }]}>{atom.text}</Text>
            : atom.kind === "pasted-text"
              ? <TextInput accessibilityLabel="Pasted text" multiline value={pasteText} editable={!busy}
                maxLength={mobileLongPasteMaximumCharacters} onChangeText={setPasteText}
                style={[styles.input, { color: colors.ink, backgroundColor: colors.background, borderColor: colors.border }]} />
              : <View accessibilityLabel="Task link details"
                  style={[styles.readText, { backgroundColor: colors.background, borderColor: colors.border }]}>
                  <Text selectable accessibilityLabel="Task link label" style={[styles.routeLabel, { color: colors.ink }]}>{atom.displayText}</Text>
                  <Text selectable accessibilityLabel="Task link address" style={[styles.routeHref, { color: colors.muted }]}>{atom.href}</Text>
                </View>}
        </ScrollView>
        {atom.kind === "pasted-text" && <Text accessibilityLiveRegion="polite"
          style={[styles.count, { color: colors.muted }]}>{pasteText.length.toLocaleString("en-US")} characters</Text>}
        <View style={styles.actions}>
          <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${mobileComposerAtomLabel(atom)}`}
            disabled={busy} onPress={() => onRemove(atom.atomId)}
            style={[styles.button, { borderColor: colors.negative }, busy && styles.disabled]}>
            <Text style={[styles.buttonText, { color: colors.negative }]}>Remove</Text>
          </Pressable>
          {atom.kind === "pasted-text" && <Pressable accessibilityRole="button" accessibilityLabel="Save pasted text changes"
            accessibilityState={{ disabled: !canSave }} disabled={!canSave}
            onPress={() => onSavePaste(atom.atomId, pasteText)}
            style={[styles.button, { backgroundColor: colors.accent, borderColor: colors.accent }, !canSave && styles.disabled]}>
            <Text style={[styles.buttonText, { color: colors.surface }]}>Save</Text>
          </Pressable>}
        </View>
      </SafeAreaView>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(0,0,0,0.42)" },
  sheet: { maxHeight: "88%", borderTopWidth: StyleSheet.hairlineWidth, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 18, gap: 12 },
  header: { flexDirection: "row", alignItems: "center", gap: 12 },
  headerText: { flex: 1, gap: 2 },
  eyebrow: { fontSize: 12, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.7 },
  title: { fontSize: 20, fontWeight: "800" },
  close: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  closeText: { fontSize: 28, lineHeight: 30 },
  help: { fontSize: 13, lineHeight: 19 },
  content: { flexGrow: 1 },
  readText: { minHeight: 160, borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, padding: 14, fontSize: 15, lineHeight: 22 },
  routeLabel: { fontSize: 15, lineHeight: 22, fontWeight: "700" },
  routeHref: { marginTop: 10, fontSize: 13, lineHeight: 20 },
  input: { minHeight: 180, maxHeight: 440, borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, padding: 14, fontSize: 15, lineHeight: 22, textAlignVertical: "top" },
  count: { fontSize: 12, fontWeight: "600" },
  actions: { flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", gap: 10 },
  button: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 16, alignItems: "center", justifyContent: "center" },
  buttonText: { fontSize: 14, fontWeight: "800" },
  disabled: { opacity: 0.45 }
});
