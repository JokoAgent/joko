import { View } from "react-native";

/** Quota has its own semantic colors, independent from permission/error UI. */
export const mobileQuotaColors = Object.freeze({ warning: "#F3A115", critical: "#D91F37" });

export function MobileModelQuotaBar({ remaining, label, colors }: { readonly remaining: number; readonly label: string;
  readonly colors: { readonly muted: string; readonly border: string } }) {
  if (!Number.isFinite(remaining)) return null;
  const now = Math.max(0, Math.min(100, remaining));
  const color = now <= 10 ? mobileQuotaColors.critical : now < 30 ? mobileQuotaColors.warning : colors.muted;
  return <View accessibilityRole="progressbar" accessibilityLabel={label} accessibilityValue={{ min: 0, max: 100, now }}
    style={{ width: 24, height: 3, borderRadius: 2, overflow: "hidden", backgroundColor: colors.border }}>
    <View style={{ height: "100%", width: `${now}%`, backgroundColor: color }} />
  </View>;
}
