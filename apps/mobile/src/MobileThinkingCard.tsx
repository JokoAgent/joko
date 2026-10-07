import { memo, useEffect, useMemo, useState } from "react";
import { AppState, Pressable, StyleSheet, Text, View } from "react-native";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { useMobileExpandedBlock } from "./mobile-expanded-block-memory";
import { mobileThinkingMessage } from "./mobile-thinking-messages";
import type { MobileThinkingView } from "./mobile-thinking-projection";
import { tokenizeMobileThinkingText } from "./mobile-thinking-text";

export interface MobileThinkingCardProps {
  readonly thinking: MobileThinkingView;
  readonly ownerKey: string;
  readonly colors: MobileInteractionSheetColors;
  readonly locale: MobileSupportedLocale;
  readonly enabled: boolean;
  readonly compact?: boolean;
}

export const MobileThinkingCard = memo(function MobileThinkingCard({ thinking, ownerKey, colors, locale, enabled,
  compact = false }: MobileThinkingCardProps) {
  const [expanded, toggle] = useMobileExpandedBlock(ownerKey, thinking.key);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [clock, setClock] = useState<{ readonly ownerKey: string; readonly blockKey: string; readonly start: number; readonly seconds: number }>();
  const interactive = enabled && foreground;
  const start = thinking.startedAtMs;
  const running = interactive && thinking.streaming && !thinking.completed && !thinking.redacted
    && start !== undefined && Number.isSafeInteger(start) && start >= 0;
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => setForeground(state === "active"));
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!running || start === undefined) { setClock(undefined); return; }
    let retired = false;
    const tick = (): void => {
      if (!retired) setClock({ ownerKey, blockKey: thinking.key, start, seconds: Math.floor(Math.max(0, Date.now() - start) / 1_000) });
    };
    tick();
    const timer = setInterval(tick, 1_000);
    return () => { retired = true; clearInterval(timer); };
  }, [ownerKey, thinking.key, start, running]);
  const t = (key: Parameters<typeof mobileThinkingMessage>[1], seconds?: number): string => mobileThinkingMessage(locale, key, seconds);
  const elapsed = running && clock?.ownerKey === ownerKey && clock.blockKey === thinking.key && clock.start === start
    ? clock.seconds : undefined;
  const title = thinking.redacted ? t("hidden") : thinking.completed ? t("completed")
    : elapsed === undefined ? t("title") : t("active", elapsed);
  const tokens = useMemo(() => thinking.redacted ? [] : tokenizeMobileThinkingText(thinking.text), [thinking.redacted, thinking.text]);
  const content = thinking.redacted ? t("hiddenBody") : tokens.length === 0 ? t("empty") : tokens.map((token, index) =>
    <Text key={index} style={token.kind === "strong" ? styles.strong : token.kind === "code" ? styles.code : undefined}>{token.value}</Text>);
  return <View style={[styles.card, { borderColor: colors.border }]}>
    <Pressable accessibilityRole="button" accessibilityLabel={expanded ? t("collapse") : t("expand")}
      accessibilityState={{ expanded, disabled: !interactive }} disabled={!interactive} onPress={() => { if (interactive) toggle(); }}
      style={styles.toggle}>
      <Text numberOfLines={1} style={[styles.title, { color: colors.muted }]}>{title}</Text>
      <Text accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.chevron, { color: colors.muted }]}>{expanded ? "⌃" : "⌄"}</Text>
    </Pressable>
    {(expanded || compact) && <Text selectable={expanded} numberOfLines={expanded ? undefined : 1}
      style={[styles.body, expanded ? styles.expanded : styles.preview, { color: colors.muted }]}>{content}</Text>}
  </View>;
});

const styles = StyleSheet.create({
  card: { minWidth: 0, borderLeftWidth: 1, marginVertical: 4 },
  toggle: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 8 },
  title: { flex: 1, minWidth: 0, fontSize: 13, lineHeight: 20 },
  chevron: { width: 16, fontSize: 16, textAlign: "center" },
  body: { fontSize: 13, lineHeight: 20, fontStyle: "italic", paddingHorizontal: 12 },
  expanded: { paddingBottom: 12 },
  preview: { paddingBottom: 6 },
  strong: { fontWeight: "700" },
  code: { fontFamily: "monospace", fontStyle: "normal" }
});
