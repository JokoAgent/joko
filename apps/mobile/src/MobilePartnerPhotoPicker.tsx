import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { MobilePartnerAvatar } from "./MobilePartnerAvatar";
import { pickMobilePartnerPhoto, type MobilePartnerAvatarDraft, type MobilePartnerAvatarIdentity } from "./mobile-partner-avatar";
import { mobileMessage } from "./mobile-messages";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobilePartnersColors } from "./MobilePartnersScreen";

export function MobilePartnerPhotoPicker({ value, presets, partner, colors, locale, disabled, onChange, onPreparing }: {
  readonly value: MobilePartnerAvatarDraft; readonly presets: readonly string[]; readonly partner?: MobilePartnerAvatarIdentity;
  readonly colors: MobilePartnersColors; readonly locale: MobileSupportedLocale; readonly disabled: boolean;
  readonly onChange: (avatar: string | { readonly base64: string }) => void; readonly onPreparing: (preparing: boolean) => void;
}) {
  const [busy, setBusy] = useState(false); const [failed, setFailed] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  const latest = useRef({ disabled, onChange, onPreparing }); latest.current = { disabled, onChange, onPreparing };
  useEffect(() => () => { request.current?.abort(); latest.current.onPreparing(false); }, []);
  const pick = (): void => {
    if (latest.current.disabled || request.current) return;
    const abort = new AbortController(); request.current = abort; setBusy(true); setFailed(false); latest.current.onPreparing(true);
    void pickMobilePartnerPhoto(abort.signal).then((photo) => {
      if (photo && !abort.signal.aborted && !latest.current.disabled) latest.current.onChange(photo);
    }).catch(() => { if (!abort.signal.aborted) setFailed(true); }).finally(() => {
      if (request.current === abort) { request.current = undefined; latest.current.onPreparing(false); if (!abort.signal.aborted) setBusy(false); }
    });
  };
  return <View style={styles.container}><View style={styles.choices}>
    {presets.map((preset) => <Pressable key={preset} accessibilityRole="radio" accessibilityLabel={preset}
      accessibilityState={{ checked: value === preset, disabled: disabled || busy }} disabled={disabled || busy}
      onPress={() => onChange(preset)} style={[styles.choice, { borderColor: value === preset ? colors.accent : colors.border }]}>
      <MobilePartnerAvatar preset={preset} colors={colors} />
    </Pressable>)}
    <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "partnerProfile.uploadAvatar")}
      accessibilityState={{ selected: typeof value !== "string", disabled: disabled || busy }} disabled={disabled || busy}
      onPress={pick} style={[styles.choice, { borderColor: typeof value !== "string" ? colors.accent : colors.border }]}>
      {typeof value !== "string" ? <MobilePartnerAvatar preset={value} partner={partner} colors={colors} />
        : <Text style={{ fontSize: 28, color: colors.muted }}>+</Text>}
    </Pressable>
  </View>{busy && <ActivityIndicator color={colors.accent} />}{failed && <Text accessibilityRole="alert" style={{ color: colors.negative }}>
    {mobileMessage(locale, "partnerProfile.avatarFailed")}</Text>}</View>;
}

const styles = StyleSheet.create({ container: { gap: 8 }, choices: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  choice: { borderWidth: 2, borderRadius: 17, padding: 3, minWidth: 54, minHeight: 54, alignItems: "center", justifyContent: "center" } });
