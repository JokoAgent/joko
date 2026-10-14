import { Pressable, StyleSheet, Text, View } from "react-native";
import { MobilePartnerAvatar } from "./MobilePartnerAvatar";
import type { MobilePartnersColors } from "./MobilePartnersScreen";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import type { MobilePartnerAvatarIdentity } from "./mobile-partner-avatar";
import type { TimelineRow } from "./timeline";

export type MobilePartnerPrivateTracePeer = MobilePartnerAvatarIdentity & { readonly displayName: string };

export interface MobilePartnerPrivateTraceProps {
  readonly preview: NonNullable<TimelineRow["partnerPrivatePreview"]>;
  readonly direction: "sent" | "received";
  readonly peer?: MobilePartnerPrivateTracePeer;
  readonly colors: MobilePartnersColors;
  readonly locale: MobileSupportedLocale;
  readonly disabled?: boolean;
  readonly onOpen: (preview: NonNullable<TimelineRow["partnerPrivatePreview"]>) => void;
}

export function MobilePartnerPrivateTrace({ preview, direction, peer, colors, locale, disabled = false,
  onOpen }: MobilePartnerPrivateTraceProps) {
  const currentPeer = peer?.partnerId === preview.targetPartnerId ? peer : undefined;
  const name = currentPeer?.displayName || preview.targetName || preview.targetPartnerId;
  const label = mobileMessage(locale, direction === "sent" ? "partner.sentTo" : "partner.receivedFrom", { name });
  return <View style={styles.trace} testID="partner.privateTrace">
    <Pressable accessibilityRole="button" accessibilityLabel={label}
      accessibilityHint={mobileMessage(locale, "partner.readOnly")} accessibilityState={{ disabled }}
      disabled={disabled} hitSlop={{ top: 6, bottom: 6 }} onPress={() => onOpen(preview)}
      style={styles.touchTarget}>
      {({ pressed }) => <View style={[styles.action,
        { borderColor: colors.border, backgroundColor: colors.surface },
        (disabled || pressed) && styles.dimmed]}>
        {currentPeer && <MobilePartnerAvatar preset={currentPeer.avatar} partner={currentPeer} size={20} colors={colors} />}
        <Text numberOfLines={1} style={[styles.label, { color: colors.muted }]}>{label}</Text>
        <Text accessible={false} style={[styles.arrow, { color: colors.muted }]}>›</Text>
      </View>}
    </Pressable>
  </View>;
}

const styles = StyleSheet.create({
  trace: { flexDirection: "row", alignItems: "center" },
  touchTarget: { maxWidth: "100%", flexShrink: 1 },
  action: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 32,
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 999, paddingLeft: 6, paddingRight: 10 },
  label: { flexShrink: 1, fontSize: 12, lineHeight: 18, fontWeight: "400" },
  arrow: { fontSize: 20, lineHeight: 24 },
  dimmed: { opacity: 0.5 }
});
