import { memo, useEffect, useState } from "react";
import { AppState, Pressable, StyleSheet, Text, View } from "react-native";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { useMobileExpandedBlock } from "./mobile-expanded-block-memory";
import { mobilePlanMessage } from "./mobile-plan-messages";
import type { MobileInlinePlan } from "./mobile-plan-projection";

export interface MobilePlanCardProps {
  readonly plan: MobileInlinePlan;
  readonly ownerKey: string;
  readonly colors: MobileInteractionSheetColors;
  readonly locale: MobileSupportedLocale;
  readonly enabled: boolean;
}

export const MobilePlanCard = memo(function MobilePlanCard({ plan, ownerKey, colors, locale, enabled }: MobilePlanCardProps) {
  const [expanded, toggle] = useMobileExpandedBlock(ownerKey, plan.identity, true);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const interactive = enabled && foreground;
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => setForeground(state === "active"));
    return () => subscription.remove();
  }, []);
  const title = mobilePlanMessage(locale, "title", { completed: plan.completed, total: plan.total });
  return <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <Pressable accessibilityRole="button" accessibilityLabel={mobilePlanMessage(locale, expanded ? "collapse" : "expand")}
      accessibilityState={{ expanded, disabled: !interactive }} disabled={!interactive} onPress={() => { if (interactive) toggle(); }} style={styles.heading}>
      <Text accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ color: colors.muted }}>☷</Text>
      <View style={styles.fill}><Text style={[styles.title, { color: colors.ink }]}>{title}</Text>
        <Text numberOfLines={2} style={[styles.subtitle, { color: colors.muted }]}>{plan.activeContent}</Text></View>
      <Text accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ color: colors.muted }}>{expanded ? "⌃" : "⌄"}</Text>
    </Pressable>
    {expanded && foreground && <View style={[styles.steps, { borderColor: colors.border }]}>
      {plan.steps.map((step, index) => <View key={JSON.stringify([step.id, index])} style={styles.step}>
        <Text accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
          style={[styles.mark, { color: step.state === "inProgress" ? colors.accent : colors.muted }]}>
          {step.state === "completed" ? "✓" : step.state === "inProgress" ? "◌" : "○"}
        </Text>
        <View style={styles.fill}>
          <Text selectable style={[styles.content, { color: step.state === "pending" ? colors.muted : colors.ink },
            step.state === "completed" && styles.completed]}>{step.content}</Text>
          <Text style={[styles.status, { color: step.state === "inProgress" ? colors.accent : colors.muted }]}>{mobilePlanMessage(locale, step.state)}</Text>
        </View>
      </View>)}
      {plan.outcome && <Text selectable style={[styles.status, { color: plan.outcome === "failed" ? colors.negative : colors.muted }]}>
        {mobilePlanMessage(locale, plan.outcome === "completed" ? "sealed" : plan.outcome)}
      </Text>}
    </View>}
  </View>;
});

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, minWidth: 0 },
  heading: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 12, paddingVertical: 10 },
  fill: { flex: 1, minWidth: 0 }, title: { fontSize: 14, lineHeight: 20, fontWeight: "600" },
  subtitle: { fontSize: 12, lineHeight: 18 }, steps: { borderTopWidth: StyleSheet.hairlineWidth, gap: 12, padding: 12 },
  step: { flexDirection: "row", alignItems: "flex-start", gap: 9, minWidth: 0 },
  mark: { width: 16, fontSize: 15, lineHeight: 21 }, content: { fontSize: 13, lineHeight: 21 },
  completed: { textDecorationLine: "line-through" }, status: { fontSize: 11, lineHeight: 17 }
});
