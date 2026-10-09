import { StyleSheet, View } from "react-native";
import type { MobilePartnersColors } from "./MobilePartnersScreen";

export function MobilePartnerAvatar({ preset, colors, size = 44 }: {
  readonly preset: string;
  readonly colors: MobilePartnersColors;
  readonly size?: number;
}) {
  const shape = preset === "spark" ? styles.spark : preset === "leaf" ? styles.leaf
    : preset === "wave" ? styles.wave : styles.orbit;
  return <View accessible={false} testID={`partner.avatar.${preset}`}
    style={[styles.avatar, { width: size, height: size, backgroundColor: colors.brandBackground,
      borderColor: colors.border }]}>
    <View style={[styles.shape, { borderColor: colors.accent }, shape]} />
    {(preset === "orbit" || !["spark", "leaf", "wave"].includes(preset))
      && <View style={[styles.satellite, { backgroundColor: colors.accent }]} />}
  </View>;
}

const styles = StyleSheet.create({
  avatar: { borderRadius: 14, borderWidth: 1, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  shape: { width: 17, height: 17, borderWidth: 4 },
  orbit: { borderRadius: 9, transform: [{ rotate: "-12deg" }] },
  satellite: { position: "absolute", width: 7, height: 7, borderRadius: 4, right: 9, bottom: 9 },
  spark: { borderRadius: 4, transform: [{ rotate: "45deg" }] },
  leaf: { borderTopLeftRadius: 13, borderTopRightRadius: 2, borderBottomLeftRadius: 2,
    borderBottomRightRadius: 13, transform: [{ rotate: "-32deg" }] },
  wave: { height: 11, borderWidth: 0, borderBottomWidth: 4, borderRadius: 9, transform: [{ rotate: "-8deg" }] }
});
