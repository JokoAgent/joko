import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { RuntimeCommandSource } from "@joko/contracts";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import {
  isMobileAppCommandCandidate,
  type MobileCommandPaletteCandidate
} from "./mobile-app-commands";

export function MobileCommandHelpSheet({ visible, items, colors, locale, onClose }: {
  readonly visible: boolean;
  readonly items: readonly MobileCommandPaletteCandidate[];
  readonly colors: MobileInteractionSheetColors;
  readonly locale: MobileSupportedLocale;
  readonly onClose: () => void;
}) {
  return <Modal visible={visible} transparent animationType="slide" statusBarTranslucent onRequestClose={onClose}>
    <View style={styles.modalRoot}>
      <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "commands.help.close")}
        onPress={onClose} style={styles.backdrop} />
      <SafeAreaView edges={["bottom", "left", "right"]}
        style={[styles.sheet, { backgroundColor: colors.background, borderColor: colors.border }]}
        accessibilityViewIsModal accessibilityLabel={mobileMessage(locale, "commands.help.title")}>
        <View style={[styles.header, { borderColor: colors.border, backgroundColor: colors.surface }]}>
          <View style={styles.headerText}>
            <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{mobileMessage(locale, "commands.help.title")}</Text>
            <Text style={[styles.subtitle, { color: colors.muted }]}>{mobileMessage(locale, "commands.help.description")}</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "commands.help.close")} onPress={onClose}
            style={[styles.close, { borderColor: colors.border }]}>
            <Text style={[styles.closeText, { color: colors.ink }]}>{mobileMessage(locale, "common.close")}</Text>
          </Pressable>
        </View>
        <ScrollView style={styles.fill} contentContainerStyle={styles.content}>
          {items.map((item) => <View key={item.commandId} accessibilityRole="summary"
            accessibilityLabel={`/${item.name}. ${item.description || sourceLabel(item, locale)}`}
            style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={styles.rowText}>
              <Text selectable style={[styles.command, { color: colors.ink }]}>/{item.name}</Text>
              <Text style={[styles.description, { color: colors.muted }]}>{item.description || sourceLabel(item, locale)}</Text>
            </View>
            <Text style={[styles.source, { color: colors.accent }]}>
              {isMobileAppCommandCandidate(item) ? "Joko" : sourceLabel(item, locale)}
            </Text>
          </View>)}
          {items.length === 0 && <Text accessibilityLiveRegion="polite"
            style={[styles.empty, { color: colors.muted }]}>{mobileMessage(locale, "commands.help.empty")}</Text>}
        </ScrollView>
      </SafeAreaView>
    </View>
  </Modal>;
}

function sourceLabel(candidate: MobileCommandPaletteCandidate, locale: MobileSupportedLocale): string {
  if (isMobileAppCommandCandidate(candidate)) return mobileMessage(locale, "commands.jokoCommand");
  if (candidate.source === RuntimeCommandSource.SKILL) return mobileMessage(locale, "commands.source.skill");
  if (candidate.source === RuntimeCommandSource.PROMPT) return mobileMessage(locale, "commands.source.prompt");
  if (candidate.source === RuntimeCommandSource.EXTENSION) return mobileMessage(locale, "commands.source.extension");
  return mobileMessage(locale, "commands.backendCommand");
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
