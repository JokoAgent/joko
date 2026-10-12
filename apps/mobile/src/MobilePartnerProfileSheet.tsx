import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, AppState, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { MobileKeyboardAvoidingView, useMobileKeyboardState } from "./MobileKeyboardAvoidingView";
import { MobilePartnerProfileForm } from "./MobilePartnerProfileForm";
import { MobilePartnerDeletionPanel } from "./MobilePartnerDeletionPanel";
import { MobilePartnerRestartPanel } from "./MobilePartnerRestartPanel";
import type { MobilePartnerRestartTransport } from "./mobile-partner-restart";
import type { MobilePartnerDeletionTransport } from "./mobile-partner-deletion";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import { partnerSessionTaskMessages, partnerSessionTaskActive } from "@joko/contracts";
import type { MobilePartnerDirectoryProfile } from "./mobile-partner-directory";
import { MobilePartnerProfileValidationError, mobilePartnerProfileDraft, validateMobilePartnerProfileDraft,
  type MobilePartnerProfileDraft, type MobilePartnerProfileSnapshot, type MobilePartnerProfileTransport } from "./mobile-partner-profile";
import type { MobilePartnersColors } from "./MobilePartnersScreen";
import { partnerResumeMessages, routineMessages, type PartnerRoutineEditor, type PartnerResumeEditor } from "@joko/contracts";
import { MobilePartnerRoutineSheet } from "./MobilePartnerRoutineSheet";
import { MobilePartnerResumeSheet } from "./MobilePartnerResumeSheet";
import { MobilePartnerMemorySheet } from "./MobilePartnerMemorySheet";
import { partnerMemoryMessages, type PartnerMemoryEditor } from "@joko/contracts";
import { partnerConnectionsMessages, type PartnerConnectionsEditor } from "@joko/contracts";
import { MobilePartnerConnectionsSheet } from "./MobilePartnerConnectionsSheet";
import { partnerSkillsMessages, type PartnerSkillsEditor } from "@joko/contracts";
import { MobilePartnerSkillsSheet } from "./MobilePartnerSkillsSheet";

export function MobilePartnerProfileSheet({ visible, partner, transport, deletionTransport, restartTransport, routineFactory, resumeFactory, memoryFactory, connectionsFactory, skillsFactory, colors, locale, onClose, onSaved, onSearch }: {
  readonly visible: boolean;
  readonly partner?: MobilePartnerDirectoryProfile;
  readonly transport?: MobilePartnerProfileTransport;
  readonly deletionTransport?: MobilePartnerDeletionTransport;
  readonly restartTransport?: MobilePartnerRestartTransport;
  readonly routineFactory?: (partnerId: string, ownerKey: string) => PartnerRoutineEditor | undefined;
  readonly resumeFactory?: (partner: MobilePartnerDirectoryProfile) => PartnerResumeEditor | undefined;
  readonly memoryFactory?: (partner: MobilePartnerDirectoryProfile, ownerKey: string) => PartnerMemoryEditor | undefined;
  readonly connectionsFactory?: (partner: MobilePartnerDirectoryProfile, ownerKey: string) => PartnerConnectionsEditor | undefined;
  readonly skillsFactory?: (partner: MobilePartnerDirectoryProfile, ownerKey: string) => PartnerSkillsEditor | undefined;
  readonly colors: MobilePartnersColors;
  readonly locale: MobileSupportedLocale;
  readonly onClose: () => void;
  readonly onSaved: (partner: MobilePartnerDirectoryProfile) => void;
  readonly onSearch?: () => void;
}) {
  const binding = visible && partner && transport ? `${transport.ownerKey}\u001f${partner.partnerId}` : undefined;
  const [routine, setRoutine] = useState<PartnerRoutineEditor>();
  const [resume, setResume] = useState<PartnerResumeEditor>();
  const [memory, setMemory] = useState<PartnerMemoryEditor>();
  const [connections, setConnections] = useState<PartnerConnectionsEditor>();
  const [skills, setSkills] = useState<PartnerSkillsEditor>();
  const [taskBusy, setTaskBusy] = useState<string>();
  const [taskError, setTaskError] = useState(false);
  const taskRequest = useRef<AbortController | undefined>(undefined);
  useEffect(() => { taskRequest.current?.abort(); setTaskBusy(undefined); setTaskError(false); return () => taskRequest.current?.abort(); }, [binding]);
  useEffect(() => { setSkills(undefined); }, [binding]);
  useEffect(() => () => skills?.dispose(), [skills]);
  useEffect(() => { setConnections(undefined); }, [binding]);
  useEffect(() => () => connections?.dispose(), [connections]);
  useEffect(() => { setMemory(undefined); }, [binding]);
  useEffect(() => () => memory?.dispose(), [memory]);
  useEffect(() => { setResume(undefined); }, [binding]);
  useEffect(() => () => resume?.dispose(), [resume]);
  useEffect(() => { setRoutine(undefined); }, [binding]);
  useEffect(() => () => routine?.dispose(), [routine]);
  const [deletionBusy, setDeletionBusy] = useState(false);
  const [restartBusy, setRestartBusy] = useState(false);
  const restartBusyRef = useRef(false); restartBusyRef.current = restartBusy;
  const deletionBusyRef = useRef(false); deletionBusyRef.current = deletionBusy;
  const deletingPartner = useRef<string | undefined>(undefined);
  if (visible && partner) deletingPartner.current = partner.partnerId;
  const bindingRef = useRef(binding); bindingRef.current = binding;
  const propsRef = useRef({ partner, transport }); propsRef.current = { partner, transport };
  const sourceOwner = partner && transport ? `${transport.ownerKey}\u001f${partner.partnerId}` : undefined;
  const sourceOwnerRef = useRef(sourceOwner); sourceOwnerRef.current = sourceOwner;
  const pendingSearch = useRef<string | undefined>(undefined); const onSearchRef = useRef(onSearch); onSearchRef.current = onSearch;
  const mountedRef = useRef(true);
  const deliverSearch = (): void => {
    const expected = pendingSearch.current; pendingSearch.current = undefined;
    if (expected !== undefined && expected === sourceOwnerRef.current && AppState.currentState === "active") onSearchRef.current?.();
  };
  useEffect(() => { mountedRef.current = true; sourceOwnerRef.current = sourceOwner;
    return () => { mountedRef.current = false; pendingSearch.current = undefined; sourceOwnerRef.current = undefined; }; }, []);
  useEffect(() => {
    if (visible || pendingSearch.current === undefined || Platform.OS !== "android") return;
    const frame = requestAnimationFrame(deliverSearch);
    return () => cancelAnimationFrame(frame);
  }, [visible]);
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
  const editable = !!snapshot && !!draft && !busy && !taskBusy && !restartBusy && !routine && !resume && !memory && !connections && !skills && snapshot.partner.pauseCleanupPending !== true && !state.requiresRefresh;

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

  const close = (next?: "search"): void => {
    if (busyRef.current || avatarPreparingRef.current || deletionBusyRef.current || restartBusyRef.current || routine || resume || memory || connections || skills) return;
    const expected = sourceOwner;
    const finish = (): void => {
      if (!mountedRef.current || expected !== sourceOwnerRef.current || next === "search" && expected === undefined) return;
      pendingSearch.current = next === "search" ? expected : undefined; onClose();
    };
    if (!dirty) { finish(); return; }
    Alert.alert(mobileMessage(locale, "partnerProfile.discardTitle"), undefined, [
      { text: mobileMessage(locale, "common.cancel"), style: "cancel" },
      { text: mobileMessage(locale, "partnerProfile.discard"), style: "destructive", onPress: finish }
    ]);
  };
  const change = (next: MobilePartnerProfileDraft): void => {
    if (editable) setState((previous) => ({ ...previous, draft: next, error: undefined }));
  };
  const save = (): void => {
    const current = propsRef.current.transport; const expected = bindingRef.current;
    if (!editable || !snapshot || !draft || !current || !expected || busyRef.current || avatarPreparingRef.current || restartBusyRef.current) return;
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
  return <Modal visible={visible} animationType={pendingSearch.current !== undefined && Platform.OS === "android" ? "none" : "slide"}
    presentationStyle="pageSheet" allowSwipeDismissal={false} onRequestClose={() => close()} onDismiss={deliverSearch}>
    {connections && visible && `${connections.api.ownerKey}\u001f${connections.initial.partnerId}` === binding && <MobilePartnerConnectionsSheet editor={connections} colors={colors} locale={locale} onClose={() => setConnections(undefined)} />}
    {skills && visible && `${skills.api.ownerKey}\u001f${skills.initial.partnerId}` === binding && <MobilePartnerSkillsSheet editor={skills} colors={colors} locale={locale} onClose={() => setSkills(undefined)} />}
    {memory && visible && `${memory.api.ownerKey}\u001f${memory.initial.partnerId}` === binding && <MobilePartnerMemorySheet editor={memory} colors={colors} locale={locale} onClose={() => setMemory(undefined)} />}
    {routine && visible && `${routine.api.ownerKey}\u001f${routine.partnerId}` === binding && <MobilePartnerRoutineSheet editor={routine} colors={colors} locale={locale} onClose={() => setRoutine(undefined)} />}
    {resume && visible && transport && `${resume.api.ownerKey}\u001f${resume.initial.partnerId}` === binding && <MobilePartnerResumeSheet editor={resume} colors={colors} locale={locale}
      onClose={() => setResume(undefined)} onChanged={load} />}
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={["top", "bottom"]}>
      <MobileKeyboardAvoidingView style={styles.screen} keyboard={keyboard} consumedBottomInset={insets.bottom}>
        <View style={styles.header}>
          {action(mobileMessage(locale, "common.close"), close, busy || avatarPreparing || deletionBusy || restartBusy || !!routine || !!resume || !!memory || !!connections || !!skills)}
          <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{mobileMessage(locale, "partnerProfile.title")}</Text>
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        {onSearch && action(mobileMessage(locale, "conversationSearch.title"), () => close("search"), sourceOwner === undefined || busy || avatarPreparing || deletionBusy || restartBusy || !!routine || !!resume || !!memory || !!connections || !!skills)}
        {snapshot && <View>
          <Text accessibilityRole="header" style={{ color: colors.ink }}>{partnerSessionTaskMessages(locale).title}</Text>
          {taskError && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{partnerSessionTaskMessages(locale).failed}</Text>}
          {(snapshot.tasks ?? []).map(task => {
            const copy = partnerSessionTaskMessages(locale);
            const execute = async (selected: "pause" | "resume" | "cancel" | "open") => {
              if (!transport || taskBusy || dirty || !editable) return;
              const current = bindingRef.current, request = new AbortController(); taskRequest.current?.abort(); taskRequest.current = request;
              setTaskBusy(task.id); setTaskError(false);
              try {
                if (selected === "open") { await transport.openTask?.(snapshot, task, request.signal); if (!request.signal.aborted) onClose(); }
                else { await transport.controlTask?.(snapshot, task, selected, request.signal); if (!request.signal.aborted && current === bindingRef.current) load(); }
              } catch { if (!request.signal.aborted && current === bindingRef.current) setTaskError(true); }
              finally { if (current === bindingRef.current) setTaskBusy(undefined); }
            };
            return <View key={task.id} style={{ gap: 6, paddingVertical: 8 }}>
              <Text style={{ color: colors.ink }}>{task.title}</Text>
              <Text accessibilityLiveRegion="polite" style={{ color: colors.muted }}>{copy.states[task.control === "active" ? task.status : task.control]}</Text>
              {task.result && <Text selectable style={{ color: colors.ink }}>{task.result}</Text>}
              {task.error && <Text style={{ color: colors.negative }}>{task.error}</Text>}
              {task.sessionId && action(copy.open, () => void execute("open"), !!taskBusy || dirty || !editable || !transport?.openTask)}
              {task.control === "paused" && action(copy.resume, () => void execute("resume"), !!taskBusy || dirty || !editable || !transport?.controlTask)}
              {partnerSessionTaskActive(task) && task.control === "active" && action(copy.pause, () => void execute("pause"), !!taskBusy || dirty || !editable || !transport?.controlTask)}
              {(partnerSessionTaskActive(task) || task.control !== "active") && task.sessionId && action(copy.cancel, () => void execute("cancel"), !!taskBusy || dirty || !editable || !transport?.controlTask)}
            </View>;
          })}
          {(snapshot.tasks ?? []).length === 0 && <Text style={{ color: colors.muted }}>{partnerSessionTaskMessages(locale).empty}</Text>}
          {action(partnerSessionTaskMessages(locale).refresh, load, !!taskBusy || dirty || !editable)}
        </View>}
        {skillsFactory && snapshot?.partner.initializationState === "ready" && snapshot.partner.canonicalSessionId && action(partnerSkillsMessages(locale).title,
          () => { if (transport) setSkills(skillsFactory(snapshot.partner, transport.ownerKey)); }, !editable || dirty || deletionBusy || avatarPreparing)}
        {connectionsFactory && snapshot?.partner.initializationState === "ready" && snapshot.partner.canonicalSessionId && action(partnerConnectionsMessages(locale).title,
          () => { if (transport) setConnections(connectionsFactory(snapshot.partner, transport.ownerKey)); }, !editable || dirty || deletionBusy || avatarPreparing)}
        {memoryFactory && snapshot?.partner.initializationState === "ready" && snapshot.partner.canonicalSessionId && action(partnerMemoryMessages(locale).title,
          () => { if (transport) setMemory(memoryFactory(snapshot.partner, transport.ownerKey)); }, !editable || dirty || deletionBusy || avatarPreparing)}
        {routineFactory && partner?.initializationState === "ready" && partner.canonicalSessionId && action(routineMessages(locale).title,
          () => { if (transport && snapshot) setRoutine(routineFactory(snapshot.partner.partnerId, transport.ownerKey)); },
          !editable || dirty || deletionBusy || avatarPreparing)}
        {resumeFactory && snapshot?.partner.lifecycle === "paused" && action(partnerResumeMessages(locale).action,
          () => setResume(resumeFactory(snapshot.partner)), busy || dirty || deletionBusy || restartBusy || avatarPreparing || !!routine || !!resume || !!memory || !!connections || !!skills)}
        {visible && deletionTransport && <MobilePartnerDeletionPanel transport={deletionTransport}
          disabled={restartBusy || !!routine || !!resume || !!memory || !!connections || !!skills}
          partner={snapshot?.partner} colors={colors} locale={locale}
          onBusyChange={(value) => { deletionBusyRef.current = value; setDeletionBusy(value); }}
          onChanged={(deletion) => { if (deletion?.phase === "completed" && deletion.partnerId === deletingPartner.current) onClose(); }} />}
        {visible && restartTransport && <MobilePartnerRestartPanel transport={restartTransport} partner={snapshot?.partner}
          colors={colors} locale={locale} disabled={busy || deletionBusy || avatarPreparing || dirty || !!routine || !!resume || !!memory || !!connections || !!skills}
          onBusyChange={(value) => { restartBusyRef.current = value; setRestartBusy(value); }} onChanged={() => undefined} />}
        {!binding ? <Text style={[styles.notice, { color: colors.muted }]}>{mobileMessage(locale, "partnerProfile.offline")}</Text>
          : !snapshot ? <View style={styles.center}>
            {state.phase !== "error" ? <><ActivityIndicator color={colors.accent} /><Text style={{ color: colors.muted }}>
              {mobileMessage(locale, "partnerProfile.loading")}</Text></> : <>
              <Text style={{ color: colors.negative }}>{mobileMessage(locale, "partnerProfile.failed")}</Text>
              {action(mobileMessage(locale, "common.retry"), load)}</>}
          </View> : draft && <View style={styles.section}>
            {state.error && <View accessibilityRole="alert" style={styles.section}>
              <Text style={[styles.body, { color: colors.negative }]}>{state.error}</Text>
              {state.requiresRefresh && action(mobileMessage(locale, "partnerProfile.reload"), load, busy)}
            </View>}
            <MobilePartnerProfileForm fields={snapshot} original={snapshot.partner} draft={draft} disabled={!editable || deletionBusy}
              avatarKey={binding!} onChange={change} onPreparing={preparingAvatar} colors={colors} locale={locale} />
            {busy && <ActivityIndicator color={colors.accent} />}
            {action(mobileMessage(locale, "partnerProfile.save"), save, !editable || !dirty || avatarPreparing || deletionBusy)}
          </View>}
        </ScrollView>
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
