import { useMemo } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import type { MobilePartnerOfflineConversation } from "./mobile-partner-offline-conversation";
import type { MobilePartnersColors } from "./MobilePartnersScreen";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import { timelineRows } from "./timeline";
import { MobileMarkdownMessage } from "./MobileMarkdownMessage";

export function MobilePartnerOfflineConversationScreen({ conversation, colors, locale, onBack }: {
  readonly conversation: MobilePartnerOfflineConversation;
  readonly colors: MobilePartnersColors;
  readonly locale: MobileSupportedLocale;
  readonly onBack: () => void;
}) {
  const rows = useMemo(() => timelineRows(conversation.events).filter(row => !row.internalInput && row.text.trim()), [conversation.events]);
  const back = mobileMessage(locale, "common.backTo", { label: mobileMessage(locale, "partnerDirectory.title") });
  return <View style={[styles.screen, { backgroundColor: colors.background }]} testID="partnerOfflineConversation.screen">
    <View style={styles.heading}>
      <Pressable accessibilityRole="button" accessibilityLabel={back} onPress={onBack} style={styles.back}>
        <Text style={{ color: colors.accent }}>{back}</Text>
      </Pressable><Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{conversation.displayName}</Text>
    </View>
    <Text accessibilityLiveRegion="polite" style={[styles.notice, { color: colors.muted }]}>
      {mobileMessage(locale, "offline.taskReadOnly", { age: `${mobileMessage(locale, "offline.saved")} · ${new Date(conversation.savedAt).toLocaleString(locale)}` })}
    </Text>
    <FlatList data={rows} keyExtractor={row => row.id} contentContainerStyle={styles.messages}
      renderItem={({ item }) => <View style={styles.message}>
        <Text style={[styles.label, { color: colors.muted }]}>{item.kind === "assistant" ? conversation.displayName : item.label}</Text>
        <MobileMarkdownMessage text={item.text} colors={colors} locale={locale}
          ownerKey={`${conversation.sourceKey}:${conversation.sessionId}:offline`} />
      </View>} />
  </View>;
}

const styles = StyleSheet.create({ screen: { flex: 1 }, heading: { flexDirection: "row", alignItems: "center", padding: 12, gap: 12 },
  back: { minHeight: 44, minWidth: 44, justifyContent: "center" }, title: { flex: 1, fontSize: 20, fontWeight: "600" },
  notice: { paddingHorizontal: 16, paddingBottom: 12, fontSize: 13 }, messages: { padding: 16, gap: 16 },
  message: { gap: 6 }, label: { fontSize: 12 } });
