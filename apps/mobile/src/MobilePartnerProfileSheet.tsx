import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { MobileKeyboardAvoidingView, useMobileKeyboardState } from "./MobileKeyboardAvoidingView";
import { MobilePartnerProfileForm } from "./MobilePartnerProfileForm";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import type { MobilePartnerDirectoryProfile } from "./mobile-partner-directory";
import { MobilePartnerProfileValidationError, mobilePartnerProfileDraft, validateMobilePartnerProfileDraft,
  type MobilePartnerProfileDraft, type MobilePartnerProfileSnapshot, type MobilePartnerProfileTransport } from "./mobile-partner-profile";
import type { MobilePartnersColors } from "./MobilePartnersScreen";

export function MobilePartnerProfileSheet({ visible, partner, transport, colors, locale, onClose, onSaved }: {
  readonly visible: boolean;
  readonly partner?: MobilePartnerDirectoryProfile;
  readonly transport?: MobilePartnerProfileTransport;
  readonly colors: MobilePartnersColors;
  readonly locale: MobileSupportedLocale;
  readonly onClose: () => void;
  readonly onSaved: (partner: MobilePartnerDirectoryProfile) => void;
}) {
  const binding = visible && partner && transport ? `${transport.ownerKey}\u001f${partner.partnerId}` : undefined;
  const bindingRef = useRef(binding); bindingRef.current = binding;
  const propsRef = useRef({ partner, transport }); propsRef.current = { partner, transport };
  const [state, setState] = useState<{ readonly binding?: string; readonly snapshot?: MobilePartnerProfileSnapshot;
    readonly draft?: MobilePartnerProfileDraft; readonly phase: "loading" | "ready" | "error"; readonly error?: string;
    readonly requiresRefresh?: boolean }>({ phase: "loading" });
  const [busy, setBusy] = useState(false);
  const [avatarPreparing, setAvatarPreparing] = useState(false);
  const avatarPreparingRef = useRef(false);
  const preparingAvatar = (value: boolean): void => { avatarPreparingRef.current = value; setAvatarPreparing(value); };
  const busyRef = useRef(false);
  const requestRef = useRef<AbortController | undefined>(undefined);
  const generationRef = useRef(0);
  const keyboard = useMobileKeyboardState();
  const insets = useSafeAreaInsets();
  const snapshot = state.binding === binding && binding !== undefined ? state.snapshot : undefined;
  const draft = snapshot ? state.draft : undefined;
  const dirty = !!snapshot && !!draft && JSON.stringify(mobilePartnerProfileDraft(snapshot.partner)) !== JSON.stringify(draft);
  const editable = !!snapshot && !!draft && !busy && !state.requiresRefresh;

  const load = (): void => {
    const selected = propsRef.current.partner; const current = propsRef.current.transport;
    const expected = bindingRef.current;
    if (!expected || !selected || !current || busyRef.current) return;
    requestRef.current?.abort();
    const controller = new AbortController(); requestRef.current = controller;
    const generation = ++generationRef.current;
    setState({ binding: expected, phase: "loading" });
    void current.load(selected, controller.signal).then((next) => {
      if (controller.signal.aborted || generationRef.current !== generation || bindingRef.current !== expected) return;
      if (next.ownerKey !== current.ownerKey || next.partner.partnerId !== selected.partnerId) throw new Error("Profile owner mismatch.");
      setState({ binding: expected, phase: "ready", snapshot: next, draft: mobilePartnerProfileDraft(next.partner) });
    }).catch(() => {
      if (!controller.signal.aborted && generationRef.current === generation && bindingRef.current === expected) {
        setState({ binding: expected, phase: "error", error: mobileMessage(locale, "partnerProfile.failed") });
      }
    });
  };
  useEffect(() => {
    busyRef.current = false; setBusy(false);
    setState({ binding, phase: "loading" }); load();
    return () => { generationRef.current += 1; requestRef.current?.abort(); };
  }, [binding]);

  const close = (): void => {
    if (busyRef.current || avatarPreparingRef.current) return;
    if (!dirty) { onClose(); return; }
    Alert.alert(mobileMessage(locale, "partnerProfile.discardTitle"), undefined, [
      { text: mobileMessage(locale, "common.cancel"), style: "cancel" },
      { text: mobileMessage(locale, "partnerProfile.discard"), style: "destructive", onPress: onClose }
    ]);
  };
  const change = (next: MobilePartnerProfileDraft): void => {
    if (editable) setState((previous) => ({ ...previous, draft: next, error: undefined }));
  };
  const save = (): void => {
    const current = propsRef.current.transport; const expected = bindingRef.current;
    if (!editable || !snapshot || !draft || !current || !expected || busyRef.current || avatarPreparingRef.current) return;
    let validated: MobilePartnerProfileDraft;
    try { validated = validateMobilePartnerProfileDraft(snapshot, draft); }
    catch (error) {
      const message = error instanceof MobilePartnerProfileValidationError
        ? mobileMessage(locale, `partnerProfile.error.${error.code}`) : mobileMessage(locale, "partnerProfile.failed");
      setState((previous) => ({ ...previous, error: message })); return;
    }
    const commit = (): void => {
      if (bindingRef.current !== expected || busyRef.current) return;
      busyRef.current = true; setBusy(true);
      requestRef.current?.abort();
      const controller = new AbortController(); requestRef.current = controller;
      void current.save(snapshot, validated, controller.signal).then((saved) => {
        if (!controller.signal.aborted && bindingRef.current === expected) { onSaved(saved); onClose(); }
      }).catch(() => {
        if (!controller.signal.aborted && bindingRef.current === expected) setState((previous) => ({ ...previous,
          error: mobileMessage(locale, "partnerProfile.failed"), requiresRefresh: true }));
      }).finally(() => {
        if (bindingRef.current === expected) { busyRef.current = false; setBusy(false); }
      });
    };
    if (validated.capabilities.permissionMode === "auto" && snapshot.partner.capabilities.permissionMode !== "auto") {
      Alert.alert(mobileMessage(locale, "partnerProfile.permission"), mobileMessage(locale, "partnerProfile.autoWarning"), [
        { text: mobileMessage(locale, "common.cancel"), style: "cancel" },
        { text: mobileMessage(locale, "partnerProfile.save"), onPress: commit }
      ]);
    } else commit();
  };
  const action = (label: string, onPress: () => void, disabled = false, selected = false) => <Pressable
    accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, selected }}
    disabled={disabled} onPress={onPress} style={[styles.action, { borderColor: colors.border,
      backgroundColor: selected ? colors.brandBackground : colors.surface }, disabled && styles.disabled]}>
    <Text style={[styles.body, { color: colors.ink }]}>{label}</Text>
  </Pressable>;
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={["top", "bottom"]}>
      <MobileKeyboardAvoidingView style={styles.screen} keyboard={keyboard} consumedBottomInset={insets.bottom}>
        <View style={styles.header}>
          {action(mobileMessage(locale, "common.close"), close, busy || avatarPreparing)}
          <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{mobileMessage(locale, "partnerProfile.title")}</Text>
        </View>
        {!binding ? <Text style={[styles.notice, { color: colors.muted }]}>{mobileMessage(locale, "partnerProfile.offline")}</Text>
          : !snapshot ? <View style={styles.center}>
            {state.phase !== "error" ? <><ActivityIndicator color={colors.accent} /><Text style={{ color: colors.muted }}>
              {mobileMessage(locale, "partnerProfile.loading")}</Text></> : <>
              <Text style={{ color: colors.negative }}>{mobileMessage(locale, "partnerProfile.failed")}</Text>
              {action(mobileMessage(locale, "common.retry"), load)}</>}
          </View> : draft && <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
            {state.error && <View accessibilityRole="alert" style={styles.section}>
              <Text style={[styles.body, { color: colors.negative }]}>{state.error}</Text>
              {state.requiresRefresh && action(mobileMessage(locale, "partnerProfile.reload"), load, busy)}
            </View>}
            <MobilePartnerProfileForm fields={snapshot} original={snapshot.partner} draft={draft} disabled={!editable}
              avatarKey={binding!} onChange={change} onPreparing={preparingAvatar} colors={colors} locale={locale} />
            {busy && <ActivityIndicator color={colors.accent} />}
            {action(mobileMessage(locale, "partnerProfile.save"), save, !editable || !dirty || avatarPreparing)}
          </ScrollView>}
      </MobileKeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 }, grow: { flex: 1, minWidth: 0 },
  header: { minHeight: 60, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", gap: 12 },
  title: { flex: 1, fontSize: 18, lineHeight: 26, fontWeight: "600" },
  content: { gap: 12, padding: 16, paddingBottom: 28 },
  section: { gap: 10, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  label: { fontSize: 14, lineHeight: 20, fontWeight: "600" }, body: { fontSize: 15, lineHeight: 22 },
  action: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderRadius: 12,
    alignItems: "center", justifyContent: "center" },
  input: { minHeight: 44, padding: 12, borderWidth: 1, borderRadius: 12, fontSize: 16, lineHeight: 23 },
  identity: { minHeight: 170, textAlignVertical: "top" },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  avatar: { padding: 4, borderWidth: 2, borderRadius: 18 },
  toggle: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44 },
  center: { flex: 1, padding: 24, gap: 16, alignItems: "center", justifyContent: "center" },
  notice: { padding: 24, fontSize: 15, lineHeight: 22 }, disabled: { opacity: 0.45 }
});
