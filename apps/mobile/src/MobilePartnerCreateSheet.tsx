import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, ActivityIndicator, Alert, Animated, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { MobileKeyboardAvoidingView, useMobileKeyboardState } from "./MobileKeyboardAvoidingView";
import { MobilePartnerProfileForm } from "./MobilePartnerProfileForm";
import { MobilePartnerCreationRejected, mobilePartnerCreationDraft, mobilePartnerCreationFields, validateMobilePartnerCreationDraft,
  type MobilePartnerCreationDraft, type MobilePartnerCreationSnapshot, type MobilePartnerCreationTransport,
  type MobilePartnerCreationResult } from "./mobile-partner-creation";
import { MobilePartnerProfileValidationError, type MobilePartnerProfileDraft } from "./mobile-partner-profile";
import type { MobilePartnerDirectoryProfile } from "./mobile-partner-directory";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import type { MobilePartnersColors } from "./MobilePartnersScreen";

interface CreationState {
  readonly ownerKey?: string; readonly snapshot?: MobilePartnerCreationSnapshot;
  readonly draft?: MobilePartnerCreationDraft; readonly baseline?: MobilePartnerCreationDraft;
  readonly pending?: string; readonly hydrated: boolean; readonly loading: boolean;
  readonly absent?: boolean; readonly error?: string;
}

export function MobilePartnerCreateSheet({ visible, transport, colors, locale, onClose, onCreated }: {
  readonly visible: boolean; readonly transport?: MobilePartnerCreationTransport; readonly colors: MobilePartnersColors;
  readonly locale: MobileSupportedLocale; readonly onClose: () => void;
  readonly onCreated: (partner: MobilePartnerDirectoryProfile) => void;
}) {
  const props = useRef({ visible, transport, onClose, onCreated }); props.current = { visible, transport, onClose, onCreated };
  const [state, setState] = useState<CreationState>({ hydrated: false, loading: true });
  const [busy, setBusy] = useState(false); const busyRef = useRef(false);
  const [preparing, setPreparing] = useState(false); const preparingRef = useRef(false);
  const request = useRef<AbortController | undefined>(undefined); const sequence = useRef(0);
  const completed = useRef<{ readonly ownerKey: string; readonly partner: MobilePartnerDirectoryProfile } | undefined>(undefined);
  const keyboard = useMobileKeyboardState(); const insets = useSafeAreaInsets();
  const ownerKey = transport?.ownerKey;
  const current = state.ownerKey === ownerKey && ownerKey !== undefined;
  const snapshot = current ? state.snapshot : undefined; const draft = current ? state.draft : undefined;
  const pending = current ? state.pending : undefined;
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(state.baseline);
  const editable = visible && !!draft && !!snapshot && state.hydrated && !pending && !busy && !state.loading;
  const [presented, setPresented] = useState(visible);
  const [reducedMotion, setReducedMotion] = useState<boolean>();
  const progress = useRef(new Animated.Value(visible ? 1 : 0)).current;
  const deliver = (): void => {
    const result = completed.current; completed.current = undefined;
    if (result && !props.current.visible && props.current.transport?.ownerKey === result.ownerKey) props.current.onCreated(result.partner);
  };
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (active) setReducedMotion(value); })
      .catch(() => { if (active) setReducedMotion(true); });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReducedMotion);
    return () => { active = false; subscription.remove(); };
  }, []);
  useEffect(() => {
    if (Platform.OS === "ios") { setPresented(visible); return; }
    if (reducedMotion !== false) { progress.setValue(visible ? 1 : 0); setPresented(visible); return; }
    if (visible) setPresented(true);
    const animation = Animated.timing(progress, { toValue: visible ? 1 : 0, duration: visible ? 180 : 120, useNativeDriver: true });
    animation.start(({ finished }) => { if (finished && !props.current.visible) setPresented(false); });
    return () => animation.stop();
  }, [visible, progress, reducedMotion]);
  useEffect(() => { if (Platform.OS !== "ios" && !presented && !visible) deliver(); }, [presented, visible]);

  const load = (keepDraft = false): void => {
    const active = props.current.transport;
    if (!props.current.visible || !active || busyRef.current) return;
    request.current?.abort(); const abort = new AbortController(); request.current = abort;
    const generation = ++sequence.current;
    const valid = (): boolean => !abort.signal.aborted && props.current.visible && props.current.transport?.ownerKey === active.ownerKey
      && sequence.current === generation;
    setState((previous) => ({ ...(keepDraft && previous.ownerKey === active.ownerKey ? previous : { hydrated: false }),
      ownerKey: active.ownerKey, hydrated: false, loading: true, error: undefined }));
    void (async () => {
      const retained = await active.pending(abort.signal); if (!valid()) return;
      setState((previous) => ({ ...previous, hydrated: true, pending: retained }));
      const next = await active.load(abort.signal); if (!valid()) return;
      if (next.ownerKey !== active.ownerKey) throw new Error("Creation owner mismatch.");
      setState((previous) => {
        const initial = mobilePartnerCreationDraft(next);
        return { ...previous, ownerKey: active.ownerKey, snapshot: next, draft: keepDraft ? previous.draft ?? initial : initial,
          baseline: keepDraft ? previous.baseline ?? initial : initial, hydrated: true, loading: false, pending: retained };
      });
    })().catch(() => {
      if (valid()) setState((previous) => ({ ...previous, loading: false, error: mobileMessage(locale, "partnerCreation.failed") }));
    });
  };
  useEffect(() => {
    busyRef.current = false; setBusy(false); preparingRef.current = false; setPreparing(false);
    if (visible) { completed.current = undefined; load(); }
    return () => { sequence.current += 1; request.current?.abort(); };
  }, [visible, ownerKey]);

  const close = (): void => {
    if (busyRef.current || preparingRef.current) return;
    const expected = ownerKey;
    const discard = (): void => {
      if (props.current.visible && props.current.transport?.ownerKey === expected && !busyRef.current && !preparingRef.current) props.current.onClose();
    };
    if (!dirty) { discard(); return; }
    Alert.alert(mobileMessage(locale, "partnerProfile.discardTitle"), undefined, [
      { text: mobileMessage(locale, "common.cancel"), style: "cancel" },
      { text: mobileMessage(locale, "partnerProfile.discard"), style: "destructive", onPress: discard }
    ]);
  };
  const adopt = (result: MobilePartnerCreationResult): void => {
    if (result.kind === "found" && ownerKey) {
      completed.current = { ownerKey, partner: result.partner }; props.current.onClose();
    } else if (result.kind === "absent") {
      setState((previous) => ({ ...previous, absent: true, error: mobileMessage(locale, "partnerCreation.absent") }));
    } else {
      setState((previous) => ({ ...previous, pending: undefined, absent: false,
        error: result.kind === "inactive" ? mobileMessage(locale, "partnerCreation.inactive") : undefined }));
    }
  };
  const perform = (operation: (active: MobilePartnerCreationTransport, signal: AbortSignal) => Promise<MobilePartnerCreationResult>): void => {
    const active = props.current.transport;
    if (!visible || !active || !current || busyRef.current || preparingRef.current) return;
    busyRef.current = true; setBusy(true); request.current?.abort(); const abort = new AbortController(); request.current = abort;
    const valid = (): boolean => !abort.signal.aborted && props.current.visible && props.current.transport?.ownerKey === active.ownerKey;
    let reload = false;
    void operation(active, abort.signal).then((result) => { if (valid()) { adopt(result); reload = result.kind === "retired"; } }).catch(async (error: unknown) => {
      if (!valid()) return;
      try {
        const retained = await active.pending(abort.signal); if (!valid()) return;
        setState((previous) => ({ ...previous, pending: retained, hydrated: true, absent: false,
          error: mobileMessage(locale, retained ? "partnerCreation.unknown" : "partnerCreation.failed") }));
        reload = error instanceof MobilePartnerCreationRejected;
      } catch {
        if (valid()) setState((previous) => ({ ...previous, hydrated: false, error: mobileMessage(locale, "partnerCreation.failed") }));
      }
    }).finally(() => {
      if (!valid()) return;
      busyRef.current = false; setBusy(false); if (reload) load(true);
    });
  };
  const create = (): void => {
    if (!editable || !draft || !snapshot || preparingRef.current || busyRef.current) return;
    let validated: MobilePartnerCreationDraft;
    try { validated = validateMobilePartnerCreationDraft(snapshot, draft); }
    catch (error) {
      setState((previous) => ({ ...previous, error: error instanceof MobilePartnerProfileValidationError
        ? mobileMessage(locale, `partnerProfile.error.${error.code}`) : mobileMessage(locale, "partnerCreation.failed") })); return;
    }
    const expected = ownerKey;
    const commit = (): void => {
      if (props.current.transport?.ownerKey === expected && props.current.visible) perform((active, signal) => active.create(snapshot, validated, signal));
    };
    if (validated.capabilities.permissionMode === "auto") Alert.alert(mobileMessage(locale, "partnerProfile.permission"),
      mobileMessage(locale, "partnerProfile.autoWarning"), [{ text: mobileMessage(locale, "common.cancel"), style: "cancel" },
        { text: mobileMessage(locale, "partnerCreation.create"), onPress: commit }]);
    else commit();
  };
  const change = (next: MobilePartnerProfileDraft): void => {
    const avatar = next.avatar;
    if (editable && (typeof avatar === "string" || "base64" in avatar)) {
      setState((previous) => ({ ...previous, draft: { ...draft!, ...next, avatar }, error: undefined }));
    }
  };
  const action = (label: string, onPress: () => void, disabled = false, selected = false) => <Pressable
    accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, selected }} disabled={disabled} onPress={onPress}
    style={[styles.action, { borderColor: colors.border, backgroundColor: selected ? colors.brandBackground : colors.surface }, disabled && styles.disabled]}>
    <Text style={[styles.body, { color: colors.ink }]}>{label}</Text>
  </Pressable>;
  const fields = snapshot && draft ? mobilePartnerCreationFields(snapshot, draft) : undefined;
  return <Modal visible={presented} animationType={Platform.OS === "ios" && reducedMotion === false ? "slide" : "none"} presentationStyle="pageSheet"
    allowSwipeDismissal={false} onDismiss={deliver} onRequestClose={close}>
    <Animated.View style={[styles.screen, Platform.OS !== "ios" && { opacity: progress,
      transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }] }]}>
      <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={["top", "bottom"]}>
        <MobileKeyboardAvoidingView style={styles.screen} keyboard={keyboard} consumedBottomInset={insets.bottom}>
          <View style={styles.header}>
            {action(mobileMessage(locale, "common.close"), close, busy || preparing)}
            <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{mobileMessage(locale, "partnerCreation.title")}</Text>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
            {!transport && <Text style={[styles.body, { color: colors.muted }]}>{mobileMessage(locale, "partnerProfile.offline")}</Text>}
            {current && state.error && <Text accessibilityRole="alert" style={[styles.body, { color: colors.negative }]}>{state.error}</Text>}
            {current && pending && <View style={styles.section}>
              <Text style={[styles.body, { color: colors.muted }]}>{mobileMessage(locale, "partnerCreation.unknown")}</Text>
              {action(mobileMessage(locale, "partnerCreation.check"), () => perform((active, signal) => active.lookup(pending, signal)), busy)}
              {state.absent && action(mobileMessage(locale, "partnerCreation.newIntent"), () => perform((active, signal) => active.retire(pending, signal)), busy)}
            </View>}
            {current && state.loading && <ActivityIndicator color={colors.accent} />}
            {snapshot && draft && fields ? <>
              <Text style={[styles.body, { color: colors.ink }]}>{mobileMessage(locale, "partnerCreation.backend")}</Text>
              <View style={styles.choices}>{snapshot.backends.map((backend) => <View key={backend.backendId}>
                {action(backend.displayName, () => {
                  const initial = mobilePartnerCreationDraft(snapshot, backend.backendId);
                  if (initial && editable) setState((previous) => ({ ...previous, draft: { ...draft, capabilities: initial.capabilities,
                    usesDirectoryDefaults: initial.usesDirectoryDefaults }, error: undefined }));
                }, !editable, fields.models[0]?.backendId === backend.backendId)}
              </View>)}</View>
              <Text style={[styles.body, { color: colors.ink }]}>{mobileMessage(locale, "partnerCreation.template")}</Text>
              <View style={styles.choices}>{snapshot.options.templates.map((template) => <View key={template.templateId}>
                {action(template.displayName, () => { if (editable) setState((previous) => ({ ...previous,
                  draft: { ...draft, templateId: template.templateId, identitySource: template.identitySource }, error: undefined })); },
                !editable, draft.templateId === template.templateId)}
              </View>)}</View>
              <MobilePartnerProfileForm key={`${ownerKey}:${fields.models[0]?.backendId}`} fields={fields} draft={draft} disabled={!editable}
                avatarKey={ownerKey!} onChange={change} onPreparing={(value) => { preparingRef.current = value; setPreparing(value); }} colors={colors} locale={locale} />
              {action(mobileMessage(locale, "partnerCreation.create"), create, !editable || preparing || !draft.displayName.trim())}
            </> : snapshot && <Text style={[styles.body, { color: colors.muted }]}>{mobileMessage(locale, "partnerCreation.unavailable")}</Text>}
            {transport && !state.loading && action(mobileMessage(locale, "common.refresh"), () => load(true), busy || preparing)}
            {action(mobileMessage(locale, "common.cancel"), close, busy || preparing)}
            {busy && <ActivityIndicator color={colors.accent} />}
          </ScrollView>
        </MobileKeyboardAvoidingView>
      </SafeAreaView>
    </Animated.View>
  </Modal>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 }, header: { minHeight: 60, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", gap: 12 },
  title: { flex: 1, fontSize: 18, lineHeight: 26, fontWeight: "600" }, content: { gap: 12, padding: 16, paddingBottom: 28 },
  body: { fontSize: 15, lineHeight: 22 }, choices: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  section: { gap: 12, paddingVertical: 12 }, action: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1,
    borderRadius: 12, alignItems: "center", justifyContent: "center" }, disabled: { opacity: 0.45 }
});
