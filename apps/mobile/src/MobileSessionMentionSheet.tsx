import { useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { MobileKeyboardAvoidingView, useMobileKeyboardState } from "./MobileKeyboardAvoidingView";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import {
  filterMobileSessionMentionCandidates,
  type MobileSessionMentionCandidate,
  type MobileSessionMentionControls
} from "./mobile-session-mentions";

export function MobileSessionMentionSheet({
  visible,
  controls,
  busy,
  error,
  colors,
  onClose,
  onSelect
}: {
  readonly visible: boolean;
  readonly controls?: MobileSessionMentionControls;
  readonly busy: boolean;
  readonly error?: string;
  readonly colors: MobileInteractionSheetColors;
  readonly onClose: () => void;
  readonly onSelect: (candidate: MobileSessionMentionCandidate) => void;
}) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<TextInput>(null);
  const keyboard = useMobileKeyboardState();
  const safeArea = useSafeAreaInsets();
  const candidates = useMemo(
    () => filterMobileSessionMentionCandidates(controls?.candidates ?? [], query),
    [controls?.candidates, query]
  );

  useEffect(() => {
    setQuery("");
    if (!visible) return;
    const timer = setTimeout(() => searchRef.current?.focus(), 120);
    return () => clearTimeout(timer);
  }, [controls?.surfaceOwnerKey, visible]);

  if (!controls) return null;

  return <Modal visible={visible} transparent animationType="slide" statusBarTranslucent onRequestClose={onClose}>
    <MobileKeyboardAvoidingView keyboard={keyboard} consumedBottomInset={safeArea.bottom}
      behavior={Platform.OS === "android" ? "height" : undefined} style={styles.modalRoot}>
      <Pressable accessibilityRole="button" accessibilityLabel="Close task references"
        disabled={busy} onPress={onClose} style={styles.backdrop} />
      <SafeAreaView accessibilityViewIsModal edges={["bottom", "left", "right"]}
        style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={[styles.eyebrow, { color: colors.muted }]}>Task context</Text>
            <Text style={[styles.title, { color: colors.ink }]}>Reference another task</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Close task references"
            accessibilityState={{ disabled: busy }} disabled={busy} onPress={onClose} style={styles.closeButton}>
            <Text style={[styles.closeText, { color: colors.ink }]}>×</Text>
          </Pressable>
        </View>
        <TextInput ref={searchRef} accessibilityLabel="Search task references" value={query}
          onChangeText={setQuery} editable={!busy} autoCapitalize="none" autoCorrect={false}
          placeholder="Search tasks" placeholderTextColor={colors.muted}
          style={[styles.search, { color: colors.ink, backgroundColor: colors.background, borderColor: colors.border }]} />
        {error && <Text accessibilityRole="alert" accessibilityLiveRegion="polite"
          style={[styles.error, { color: colors.negative }]}>{error}</Text>}
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          {controls.candidates.length === 0
            ? <Text style={[styles.empty, { color: colors.muted }]}>No other current tasks are available to reference.</Text>
            : candidates.length === 0
              ? <Text style={[styles.empty, { color: colors.muted }]}>No tasks match this search.</Text>
              : candidates.map((candidate) => <Pressable key={candidate.sessionId}
                  accessibilityRole="button" accessibilityLabel={`Reference task ${candidate.displayText}`}
                  accessibilityHint="Inserts an exact task reference at the current message selection"
                  accessibilityState={{ disabled: busy }} disabled={busy}
                  onPress={() => onSelect(candidate)}
                  style={[styles.row, { borderColor: colors.border }, busy && styles.disabled]}>
                  <View style={styles.rowText}>
                    <Text style={[styles.rowLabel, { color: colors.ink }]} numberOfLines={2}>{candidate.displayText}</Text>
                    <Text selectable style={[styles.caption, { color: colors.muted }]} numberOfLines={1}>{candidate.sessionId}</Text>
                  </View>
                  <Text style={[styles.add, { color: colors.accent }]}>Add</Text>
                </Pressable>)}
        </ScrollView>
      </SafeAreaView>
    </MobileKeyboardAvoidingView>
  </Modal>;
}

const styles = StyleSheet.create({
  modalRoot: { flex: 1, justifyContent: "flex-end" },
  backdrop: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "rgba(0,0,0,0.42)" },
  sheet: { maxHeight: "88%", borderTopWidth: 1, borderTopLeftRadius: 24, borderTopRightRadius: 24, overflow: "hidden" },
  header: { minHeight: 76, paddingHorizontal: 16, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 10 },
  headerText: { flex: 1, gap: 3 },
  eyebrow: { fontSize: 12, lineHeight: 17, fontWeight: "700", textTransform: "uppercase" },
  title: { fontSize: 22, lineHeight: 28, fontWeight: "700" },
  closeButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  closeText: { fontSize: 30, lineHeight: 34, fontWeight: "500" },
  search: { minHeight: 48, marginHorizontal: 18, marginBottom: 8, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, fontSize: 16 },
  error: { paddingHorizontal: 18, paddingVertical: 8, fontSize: 14, lineHeight: 20, fontWeight: "600" },
  content: { paddingHorizontal: 18, paddingTop: 6, paddingBottom: 26, gap: 4 },
  row: { minHeight: 60, borderBottomWidth: 1, paddingVertical: 9, flexDirection: "row", alignItems: "center", gap: 12 },
  rowText: { flex: 1, gap: 2 },
  rowLabel: { fontSize: 16, lineHeight: 22, fontWeight: "700" },
  caption: { fontSize: 12, lineHeight: 17 },
  add: { minHeight: 44, lineHeight: 44, fontSize: 14, fontWeight: "800" },
  empty: { paddingVertical: 30, fontSize: 15, lineHeight: 22, textAlign: "center" },
  disabled: { opacity: 0.5 }
});
