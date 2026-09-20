import { useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import { mobileSelectionQuoteMaximumCharacters, type MobileComposerSelection } from "./mobile-composer-document";
import type { MobileQuoteSelectionLease } from "./mobile-composer-quote";

export function MobileQuoteSelectionSheet({
  lease,
  colors,
  busy,
  onClose,
  onAdd
}: {
  readonly lease?: MobileQuoteSelectionLease;
  readonly colors: MobileInteractionSheetColors;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onAdd: (selection: MobileComposerSelection) => void;
}) {
  const [selection, setSelection] = useState<MobileComposerSelection>({ start: 0, end: 0 });
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    setSelection({ start: 0, end: 0 });
    if (!lease) return;
    const timer = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, [lease]);

  if (!lease) return null;
  const selectedCharacters = Math.abs(selection.end - selection.start);
  const canAdd = selectedCharacters > 0 && selectedCharacters <= mobileSelectionQuoteMaximumCharacters && !busy;

  return <Modal visible transparent animationType="slide" statusBarTranslucent onRequestClose={onClose}>
    <View style={styles.root}>
      <Pressable accessibilityRole="button" accessibilityLabel="Close quote selection"
        disabled={busy} onPress={onClose} style={styles.backdrop} />
      <SafeAreaView accessibilityViewIsModal importantForAccessibility="yes" edges={["bottom", "left", "right"]}
        style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={[styles.eyebrow, { color: colors.muted }]}>Assistant message</Text>
            <Text style={[styles.title, { color: colors.ink }]}>Select text to quote</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Close quote selection"
            disabled={busy} onPress={onClose} style={styles.close}>
            <Text style={[styles.closeText, { color: colors.ink }]}>×</Text>
          </Pressable>
        </View>
        <Text style={[styles.help, { color: colors.muted }]}>Select up to {mobileSelectionQuoteMaximumCharacters.toLocaleString("en-US")} characters. The source message is frozen while this sheet is open.</Text>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <TextInput ref={inputRef} accessibilityLabel="Assistant text to quote" multiline readOnly
            showSoftInputOnFocus={false} value={lease.text} selection={selection}
            onSelectionChange={(event) => setSelection(event.nativeEvent.selection)}
            style={[styles.text, { color: colors.ink, backgroundColor: colors.background, borderColor: colors.border }]} />
        </ScrollView>
        <Text accessibilityLiveRegion="polite" style={[styles.count, {
          color: selectedCharacters > mobileSelectionQuoteMaximumCharacters ? colors.negative : colors.muted
        }]}>{selectedCharacters.toLocaleString("en-US")} selected</Text>
        <View style={styles.actions}>
          <Pressable accessibilityRole="button" accessibilityLabel="Select all assistant text"
            disabled={busy} onPress={() => setSelection({ start: 0, end: lease.text.length })}
            style={[styles.button, { borderColor: colors.border }, busy && styles.disabled]}>
            <Text style={[styles.buttonText, { color: colors.ink }]}>Select all</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Add selected text as quote"
            accessibilityState={{ disabled: !canAdd }} disabled={!canAdd} onPress={() => onAdd(selection)}
            style={[styles.button, { backgroundColor: colors.accent, borderColor: colors.accent }, !canAdd && styles.disabled]}>
            <Text style={[styles.buttonText, { color: colors.surface }]}>Add quote</Text>
          </Pressable>
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
  text: { minHeight: 180, maxHeight: 420, borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, padding: 14, fontSize: 15, lineHeight: 22, textAlignVertical: "top" },
  count: { fontSize: 12, fontWeight: "600" },
  actions: { flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", gap: 10 },
  button: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 16, alignItems: "center", justifyContent: "center" },
  buttonText: { fontSize: 14, fontWeight: "800" },
  disabled: { opacity: 0.45 }
});
