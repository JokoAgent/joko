import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { MobileKeyboardAvoidingView, useMobileKeyboardState } from "./MobileKeyboardAvoidingView";
import { MobilePartnerAvatar } from "./MobilePartnerAvatar";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import type { MobilePartnerDirectoryProfile, MobilePartnerModelRoute } from "./mobile-partner-directory";
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
  const [modelIndex, setModelIndex] = useState<number>();
  const busyRef = useRef(false);
  const requestRef = useRef<AbortController | undefined>(undefined);
  const generationRef = useRef(0);
  const keyboard = useMobileKeyboardState();
  const insets = useSafeAreaInsets();
  const snapshot = state.binding === binding && binding !== undefined ? state.snapshot : undefined;
  const draft = snapshot ? state.draft : undefined;
  const dirty = !!snapshot && !!draft && JSON.stringify(mobilePartnerProfileDraft(snapshot.partner)) !== JSON.stringify(draft);
  const editable = !!snapshot && !!draft && !busy && !state.requiresRefresh;
  const capabilitiesEditable = editable && !draft?.usesDirectoryDefaults;

  const load = (): void => {
    const selected = propsRef.current.partner; const current = propsRef.current.transport;
    const expected = bindingRef.current;
    if (!expected || !selected || !current || busyRef.current) return;
    requestRef.current?.abort();
    const controller = new AbortController(); requestRef.current = controller;
    const generation = ++generationRef.current;
    setModelIndex(undefined);
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
    busyRef.current = false; setBusy(false); setModelIndex(undefined);
    setState({ binding, phase: "loading" }); load();
    return () => { generationRef.current += 1; requestRef.current?.abort(); };
  }, [binding]);

  const close = (): void => {
    if (busyRef.current) return;
    if (!dirty) { onClose(); return; }
    Alert.alert(mobileMessage(locale, "partnerProfile.discardTitle"), undefined, [
      { text: mobileMessage(locale, "common.cancel"), style: "cancel" },
      { text: mobileMessage(locale, "partnerProfile.discard"), style: "destructive", onPress: onClose }
    ]);
  };
  const change = (next: MobilePartnerProfileDraft): void => {
    if (editable) setState((previous) => ({ ...previous, draft: next, error: undefined }));
  };
  const updateRoute = (index: number, route: MobilePartnerModelRoute): void => {
    if (!draft || !capabilitiesEditable) return;
    change({ ...draft, capabilities: { ...draft.capabilities,
      modelChain: draft.capabilities.modelChain.map((candidate, position) => position === index ? route : candidate) } });
  };
  const save = (): void => {
    const current = propsRef.current.transport; const expected = bindingRef.current;
    if (!editable || !snapshot || !draft || !current || !expected || busyRef.current) return;
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
  const caption = (key: "name" | "avatar" | "identity" | "models" | "permission" | "effort") => <Text
    style={[styles.label, { color: colors.ink }]}>{mobileMessage(locale, `partnerProfile.${key}`)}</Text>;
  const effective = draft?.usesDirectoryDefaults ? snapshot?.options.defaultCapabilities : draft?.capabilities;
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={["top", "bottom"]}>
      <MobileKeyboardAvoidingView style={styles.screen} keyboard={keyboard} consumedBottomInset={insets.bottom}>
        <View style={styles.header}>
          {action(mobileMessage(locale, "common.close"), close, busy)}
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
            {caption("name")}
            <TextInput accessibilityLabel={mobileMessage(locale, "partnerProfile.name")} value={draft.displayName} editable={editable}
              onChangeText={(displayName) => change({ ...draft, displayName })} maxLength={100} autoCorrect={false}
              style={[styles.input, { borderColor: colors.border, color: colors.ink, backgroundColor: colors.surface }]} />
            {caption("avatar")}
            <View style={styles.choices}>
              {snapshot.options.avatarPresets.map((preset) => <Pressable key={preset} accessibilityRole="radio"
                accessibilityLabel={preset} accessibilityState={{ checked: draft.avatar === preset, disabled: !editable }}
                disabled={!editable} onPress={() => change({ ...draft, avatar: preset })}
                style={[styles.avatar, { borderColor: draft.avatar === preset ? colors.accent : colors.border }]}>
                <MobilePartnerAvatar preset={preset} colors={colors} />
              </Pressable>)}
            </View>
            {caption("identity")}
            <TextInput accessibilityLabel={mobileMessage(locale, "partnerProfile.identity")} value={draft.identitySource}
              editable={editable} multiline maxLength={8_000} onChangeText={(identitySource) => change({ ...draft, identitySource })}
              style={[styles.input, styles.identity, { borderColor: colors.border, color: colors.ink, backgroundColor: colors.surface }]} />
            <View style={styles.toggle}>
              <Text style={[styles.body, styles.grow, { color: colors.ink }]}>{mobileMessage(locale, "partnerProfile.defaults")}</Text>
              <Switch accessibilityLabel={mobileMessage(locale, "partnerProfile.defaults")} value={draft.usesDirectoryDefaults}
                disabled={!editable || !snapshot.options.defaultCapabilities && !draft.usesDirectoryDefaults}
                onValueChange={(usesDirectoryDefaults) => change({ ...draft, usesDirectoryDefaults })} />
            </View>
            {caption("models")}
            {effective?.modelChain.map((route, index) => {
              const model = snapshot.models.find((candidate) => candidate.backendId === route.backendId
                && candidate.providerId === route.providerId && candidate.modelId === route.modelId);
              return <View key={index} style={[styles.section, { borderColor: colors.border }]}>
                <Text style={[styles.label, { color: colors.muted }]}>{mobileMessage(locale, "partnerProfile.model", { index: index + 1 })}</Text>
                {action(`${model?.displayName ?? route.modelId} · ${model?.providerName ?? route.providerId}`,
                  () => setModelIndex(modelIndex === index ? undefined : index), !capabilitiesEditable)}
                {modelIndex === index && snapshot.models.map((choice) => {
                  const duplicate = effective.modelChain.some((candidate, position) => position !== index
                    && candidate.providerId === choice.providerId && candidate.modelId === choice.modelId);
                  return <View key={choice.key}>{action(`${choice.displayName} · ${choice.providerName}`, () => {
                    const effort = choice.efforts.find((candidate) => candidate.default)?.id ?? choice.efforts[0]?.id;
                    updateRoute(index, { backendId: choice.backendId, providerId: choice.providerId, modelId: choice.modelId,
                      fastMode: false, ...(effort === undefined ? {} : { effort }) });
                    setModelIndex(undefined);
                  }, !capabilitiesEditable || duplicate, choice.modelId === route.modelId && choice.providerId === route.providerId)}</View>;
                })}
                {caption("effort")}
                <View style={styles.choices}>
                  {(model?.efforts.length ?? 0) === 0 && action(mobileMessage(locale, "partnerProfile.automatic"), () => {
                    const { effort: _effort, ...automatic } = route; updateRoute(index, automatic);
                  }, !capabilitiesEditable, route.effort === undefined)}
                  {model?.efforts.map((effort) => <View key={effort.id}>{action(effort.label,
                    () => updateRoute(index, { ...route, effort: effort.id }), !capabilitiesEditable || !snapshot.canSetEffort, route.effort === effort.id)}</View>)}
                </View>
                <View style={styles.toggle}>
                  <Text style={[styles.body, styles.grow, { color: colors.ink }]}>{mobileMessage(locale, "partnerProfile.fast")}</Text>
                  <Switch accessibilityLabel={`${mobileMessage(locale, "partnerProfile.fast")} ${index + 1}`} value={route.fastMode}
                    disabled={!capabilitiesEditable || (!model?.supportsFastMode || !snapshot.canSetFastMode) && !route.fastMode}
                    onValueChange={(fastMode) => updateRoute(index, { ...route, fastMode })} />
                </View>
                {effective.modelChain.length > 1 && action(mobileMessage(locale, "partnerProfile.removeModel", { index: index + 1 }), () => {
                  change({ ...draft, capabilities: { ...draft.capabilities,
                    modelChain: draft.capabilities.modelChain.filter((_candidate, position) => position !== index) } }); setModelIndex(undefined);
                }, !capabilitiesEditable)}
              </View>;
            })}
            {action(mobileMessage(locale, "partnerProfile.addModel"), () => {
              const available = snapshot.models.find((model) => !draft.capabilities.modelChain.some((route) =>
                route.providerId === model.providerId && route.modelId === model.modelId));
              if (available) {
                const effort = available.efforts.find((candidate) => candidate.default)?.id ?? available.efforts[0]?.id;
                change({ ...draft, capabilities: { ...draft.capabilities, modelChain: [...draft.capabilities.modelChain,
                  { backendId: available.backendId, providerId: available.providerId, modelId: available.modelId,
                    fastMode: false, ...(effort === undefined ? {} : { effort }) }] } });
              }
            }, !capabilitiesEditable || !snapshot.canSwitchModel || (effective?.modelChain.length ?? 0) >= 3 || !snapshot.models.some((model) =>
              !draft.capabilities.modelChain.some((route) => route.providerId === model.providerId && route.modelId === model.modelId)))}
            {caption("permission")}
            <View style={styles.choices}>
              {(["ask", "auto"] as const).map((permissionMode) => <View key={permissionMode}>{action(mobileMessage(locale,
                permissionMode === "ask" ? "partnerProfile.ask" : "partnerProfile.auto"), () => change({ ...draft,
                  capabilities: { ...draft.capabilities, permissionMode } }), !capabilitiesEditable || !snapshot.permissionModes.includes(permissionMode),
              effective?.permissionMode === permissionMode)}</View>)}
            </View>
            <View style={styles.toggle}>
              <Text style={[styles.body, styles.grow, { color: colors.ink }]}>{mobileMessage(locale, "partnerProfile.plan")}</Text>
              <Switch accessibilityLabel={mobileMessage(locale, "partnerProfile.plan")} value={effective?.planMode ?? false}
                disabled={!capabilitiesEditable || !snapshot.canSetPlanMode && !effective?.planMode} onValueChange={(planMode) => change({ ...draft,
                  capabilities: { ...draft.capabilities, planMode } })} />
            </View>
            {busy && <ActivityIndicator color={colors.accent} />}
            {action(mobileMessage(locale, "partnerProfile.save"), save, !editable || !dirty)}
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
