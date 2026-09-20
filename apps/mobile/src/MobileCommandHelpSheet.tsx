import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { RuntimeCommandSource } from "@joko/contracts";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import {
  isMobileAppCommandCandidate,
  type MobileCommandPaletteCandidate
} from "./mobile-app-commands";

export function MobileCommandHelpSheet({ visible, items, colors, onClose }: {
  readonly visible: boolean;
  readonly items: readonly MobileCommandPaletteCandidate[];
  readonly colors: MobileInteractionSheetColors;
  readonly onClose: () => void;
}) {
  return <Modal visible={visible} transparent animationType="slide" statusBarTranslucent onRequestClose={onClose}>
    <View style={styles.modalRoot}>
      <Pressable accessibilityRole="button" accessibilityLabel="Close command help"
        onPress={onClose} style={styles.backdrop} />
      <SafeAreaView edges={["bottom", "left", "right"]}
        style={[styles.sheet, { backgroundColor: colors.background, borderColor: colors.border }]}
        accessibilityViewIsModal accessibilityLabel="Available commands">
        <View style={[styles.header, { borderColor: colors.border, backgroundColor: colors.surface }]}>
          <View style={styles.headerText}>
            <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>Available commands</Text>
            <Text style={[styles.subtitle, { color: colors.muted }]}>Joko commands run locally or through a typed operation. Runtime commands are inserted for the task runtime.</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Close command help" onPress={onClose}
            style={[styles.close, { borderColor: colors.border }]}>
            <Text style={[styles.closeText, { color: colors.ink }]}>Close</Text>
          </Pressable>
        </View>
        <ScrollView style={styles.fill} contentContainerStyle={styles.content}>
          {items.map((item) => <View key={item.commandId} accessibilityRole="summary"
            accessibilityLabel={`/${item.name}. ${item.description || sourceLabel(item)}`}
            style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={styles.rowText}>
              <Text selectable style={[styles.command, { color: colors.ink }]}>/{item.name}</Text>
              <Text style={[styles.description, { color: colors.muted }]}>{item.description || sourceLabel(item)}</Text>
            </View>
            <Text style={[styles.source, { color: colors.accent }]}>
              {isMobileAppCommandCandidate(item) ? "Joko" : sourceLabel(item)}
            </Text>
          </View>)}
          {items.length === 0 && <Text accessibilityLiveRegion="polite"
            style={[styles.empty, { color: colors.muted }]}>No commands are currently available.</Text>}
        </ScrollView>
      </SafeAreaView>
    </View>
  </Modal>;
}

function sourceLabel(candidate: MobileCommandPaletteCandidate): string {
  if (isMobileAppCommandCandidate(candidate)) return "Joko command";
  if (candidate.source === RuntimeCommandSource.SKILL) return "Skill";
  if (candidate.source === RuntimeCommandSource.PROMPT) return "Prompt";
  if (candidate.source === RuntimeCommandSource.EXTENSION) return "Extension";
  return "Backend command";
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(0,0,0,0.42)" },
  close: { alignItems: "center", borderRadius: 10, borderWidth: 1, justifyContent: "center", minHeight: 44, paddingHorizontal: 14 },
  closeText: { fontSize: 14, fontWeight: "700" },
  command: { fontSize: 15, fontWeight: "700" },
  content: { gap: 8, padding: 16, paddingBottom: 32 },
  description: { fontSize: 13, lineHeight: 18, marginTop: 3 },
  empty: { fontSize: 14, lineHeight: 20, paddingVertical: 24, textAlign: "center" },
  fill: { flex: 1 },
  header: { alignItems: "center", borderBottomWidth: 1, flexDirection: "row", gap: 12, padding: 16 },
  headerText: { flex: 1, minWidth: 0 },
  modalRoot: { flex: 1, justifyContent: "flex-end" },
  row: { alignItems: "center", borderRadius: 12, borderWidth: 1, flexDirection: "row", minHeight: 64, padding: 12 },
  rowText: { flex: 1, minWidth: 0 },
  source: { fontSize: 12, fontWeight: "700", marginLeft: 12 },
  sheet: { borderTopLeftRadius: 22, borderTopRightRadius: 22, borderTopWidth: StyleSheet.hairlineWidth,
    maxHeight: "88%", overflow: "hidden" },
  subtitle: { fontSize: 12, lineHeight: 17, marginTop: 3 },
  title: { fontSize: 19, fontWeight: "800" }
});
