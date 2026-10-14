import { useEffect, useRef, useState } from "react";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { PermissionMode, type CollaborationWorker } from "@joko/contracts";
import { MobileCollaborationViewContent, mobileWorkerFormValid, type MobileCollaborationViewProps } from "./MobileCollaborationView";
import { MobileCollaborationNativeSheet } from "./MobileCollaborationNativeSheet";
import { normalizeMobileWorkerForm, type MobileCollaborationApi, type MobileCollaborationView, type MobileWorkerForm, type MobileWorkerTarget } from "./mobile-collaboration";
import { mobileCollaborationCopy } from "./mobile-collaboration-messages";
import type { MobileWorkerStorage } from "./mobile-worker-storage";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { MobileKeyboardAvoidingView, useMobileKeyboardState } from "./MobileKeyboardAvoidingView";

export function MobileCollaborationSheet(props: {
  readonly visible: boolean;
  readonly api?: MobileCollaborationApi;
  readonly storage?: MobileWorkerStorage;
  readonly configure?: { readonly ownerKey: string; readonly profileId: string; readonly targets: readonly MobileWorkerTarget[];
    readonly initialTargetId: string; readonly initial?: MobileWorkerForm; readonly submit: (form: MobileWorkerForm) => Promise<void> };
  readonly disabled: boolean;
  readonly colors: MobileInteractionSheetColors;
  readonly locale: MobileSupportedLocale;
  readonly dark?: boolean;
  readonly onClose: () => void;
  readonly onCheck?: () => Promise<void>;
}) {
  const owner = props.api?.ownerKey ?? props.configure?.ownerKey, copy = mobileCollaborationCopy(props.locale);
  const [view, setView] = useState<MobileCollaborationView>(), [form, setForm] = useState<MobileWorkerForm>();
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const [showForm, setShowForm] = useState(false), [confirmation, setConfirmation] = useState<MobileCollaborationViewProps["confirmation"]>();
  const [refresh, setRefresh] = useState(0), flight = useRef(false), readEpoch = useRef(0), context = useRef({ owner, props }); context.current = { owner, props };
  const request = useRef<AbortController | undefined>(undefined), mounted = useRef(true);
  const keyboard = useMobileKeyboardState();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort(); }; }, []);
  useEffect(() => {
    const controller = new AbortController(); request.current = controller; readEpoch.current += 1; let readActive = true;
    setView(undefined); setForm(undefined); setLoading(true); setBusy(false); setError(undefined); setConfirmation(undefined); flight.current = false;
    if (!props.visible || !owner) return () => controller.abort();
    const current = () => mounted.current && !controller.signal.aborted && context.current.owner === owner && context.current.props.visible;
    void (async () => {
      const api = context.current.props.api, configure = context.current.props.configure;
      const loaded = api ? await api.load(controller.signal) : undefined;
      const restored = api ? await api.restore(controller.signal) : configure?.initial;
      const targets = api?.targets ?? configure?.targets ?? [], initialTargetId = api?.initialTargetId ?? configure?.initialTargetId ?? "";
      const profileId = api?.profileId ?? configure?.profileId;
      const target = targets.find(value => value.id === initialTargetId) ?? targets[0];
      const initial = restored ?? (profileId ? await context.current.props.storage?.defaults(profileId, targets, initialTargetId) : undefined)
        ?? (target ? defaultForm(target) : undefined);
      if (!current()) return;
      setView(loaded); setForm(initial); setShowForm(!!configure || loaded?.role === "ordinary" || restored !== undefined && loaded?.role === "lead"); setLoading(false);
    })().catch(failure => { if (current()) { setError(errorText(failure, props.locale)); setLoading(false); } }).finally(() => { readActive = false; });
    const timer = props.api ? setInterval(() => {
      if (flight.current || readActive || !current()) return;
      readActive = true; const originalReadEpoch = readEpoch.current;
      void context.current.props.api?.load(controller.signal).then(value => { if (value && current() && originalReadEpoch === readEpoch.current) setView(value); })
        .catch(failure => { if (current() && originalReadEpoch === readEpoch.current) setError(errorText(failure, props.locale)); }).finally(() => { readActive = false; });
    }, 5_000) : undefined;
    return () => { controller.abort(); if (timer) clearInterval(timer); };
  }, [owner, props.visible, refresh]);
  const act = async (effect: (api: MobileCollaborationApi | undefined, signal: AbortSignal) => Promise<MobileCollaborationView | void>, close = false): Promise<void> => {
    const original = owner, signal = request.current?.signal;
    if (!original || !signal || signal.aborted || !props.visible || flight.current || props.disabled || loading) return;
    const current = () => mounted.current && !signal.aborted && context.current.owner === original && context.current.props.visible;
    flight.current = true; readEpoch.current += 1; setBusy(true); setError(undefined); setConfirmation(undefined);
    try {
      const result = await effect(context.current.props.api, signal);
      if (!current()) return;
      if (result) { setView(result); setShowForm(false); }
      if (close) context.current.props.onClose();
    } catch (failure) {
      if (current()) { setError(errorText(failure, props.locale));
        // Partial enable can have a confirmed Goal even if creating its first worker failed.
        try { const fresh = await context.current.props.api?.load(signal); if (fresh && current()) { setView(fresh); setShowForm(fresh.role !== "worker"); } } catch { /* Keep the displayed form and error. */ }
      }
    } finally { if (current()) { flight.current = false; setBusy(false); } }
  };
  const submit = (): void => {
    const targets = props.api?.targets ?? props.configure?.targets ?? [];
    if (!mobileWorkerFormValid(form, targets) || props.disabled || busy || loading) return;
    const exact = normalizeMobileWorkerForm(form!);
    const execute = () => void act(async (api, signal) => {
      if (props.configure) { await props.storage?.remember(props.configure.profileId, targets.find(value => value.id === exact.targetId)!, exact);
        signal.throwIfAborted(); await props.configure.submit(exact); return; }
      if (!api || !view) throw new Error(copy.error);
      return view.role === "lead" ? api.create(view, exact, signal) : api.enable(exact, signal);
    }, props.configure !== undefined);
    if (exact.permissionMode === PermissionMode.BYPASS_PERMISSIONS) setConfirmation({ title: copy.full, body: copy.fullBody, confirm: execute });
    else execute();
  };
  const archive = (worker: CollaborationWorker): void => {
    if (!view || props.disabled || busy || loading) return;
    const shown = view;
    setConfirmation({ title: copy.archive, body: copy.archiveBody.replace("{name}", worker.label), confirm: () => void act(async (api, signal) => {
      if (!api) throw new Error(copy.error); const result = await api.archive(shown, worker, signal);
      if (result.role === "worker") await api.openLead(result, signal); return result;
    }, shown.role === "worker") });
  };
  const onTarget = (id: string): void => {
    const targets = context.current.props.api?.targets ?? context.current.props.configure?.targets ?? [], target = targets.find(value => value.id === id);
    if (!target || !form || props.disabled || busy) return;
    const original = owner, profileId = props.api?.profileId ?? props.configure?.profileId, before = form;
    const pendingForm = { ...form, ...defaultForm(target), role: form.role, initialTask: form.initialTask }; setForm(pendingForm);
    if (profileId) void props.storage?.defaults(profileId, [target], id).then(value => {
      if (value && mounted.current && context.current.owner === original && context.current.props.visible) setForm(current => current === pendingForm
        ? { ...value, role: current.role, initialTask: current.initialTask } : current);
    }).catch(failure => { if (mounted.current && context.current.owner === original && context.current.props.visible) setError(errorText(failure, props.locale)); });
  };
  const content: MobileCollaborationViewProps = { colors: props.colors, locale: props.locale, view, targets: props.api?.targets ?? props.configure?.targets ?? [], form,
    showForm, configure: !!props.configure, loading, busy, disabled: props.disabled || props.api?.writable === false || error !== undefined && view === undefined && !props.configure,
    error, confirmation, onForm: setForm, onTarget, onSubmit: submit, onCreate: () => setShowForm(true), onArchive: archive,
    onOpen: worker => { if (view) void act((api, signal) => api!.openWorker(view, worker, signal), true); },
    onLead: () => { if (view) void act((api, signal) => api!.openLead(view, signal), true); },
    onEnd: () => { if (view && !props.disabled && !busy) setConfirmation({ title: copy.end, body: copy.endBody, confirm: () => void act((api, signal) => api!.end(view, signal)) }); },
    onCancel: () => { if (!busy) { setConfirmation(undefined); if (!confirmation) setShowForm(false); } },
    onRefresh: () => { if (!busy && !flight.current) void props.onCheck?.().then(() => setRefresh(value => value + 1)).catch(failure => setError(errorText(failure, props.locale)));
      if (!props.onCheck && !busy) setRefresh(value => value + 1); } };
  const close = () => { if (!busy) props.onClose(); };
  if (Platform.OS === "ios") return <MobileCollaborationNativeSheet key={`${owner}-${props.visible}-${loading}`} {...content} visible={props.visible} dark={props.dark} onClose={close} />;
  return <Modal visible={props.visible} transparent animationType="slide" onRequestClose={close}><MobileKeyboardAvoidingView style={styles.root} keyboard={keyboard}>
    <Pressable accessibilityRole="button" accessibilityLabel={copy.close} disabled={busy} onPress={close} style={styles.backdrop} />
    <SafeAreaView accessibilityViewIsModal edges={["bottom", "left", "right"]} style={[styles.sheet, { backgroundColor: props.colors.surface, borderColor: props.colors.border }]}>
      <View style={styles.header}><Text accessibilityRole="header" style={[styles.title, { color: props.colors.ink }]}>{copy.title}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={copy.close} disabled={busy} onPress={close} style={styles.close}><Text style={{ color: props.colors.ink }}>×</Text></Pressable></View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}><MobileCollaborationViewContent {...content} /></ScrollView>
    </SafeAreaView></MobileKeyboardAvoidingView></Modal>;
}
function defaultForm(target: MobileWorkerTarget): MobileWorkerForm {
  return { role: "developer", targetId: target.id, initialTask: "", permissionMode: target.permissionModes.includes(PermissionMode.AUTO) ? PermissionMode.AUTO : target.permissionModes[0]!,
    ...(target.defaultModel ? { model: target.defaultModel } : {}) };
}
function errorText(value: unknown, locale: MobileSupportedLocale): string { return value instanceof Error ? value.message : mobileCollaborationCopy(locale).error; }
const styles = StyleSheet.create({ root: { flex: 1, justifyContent: "flex-end" }, backdrop: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.3)" },
  sheet: { maxHeight: "92%", borderTopWidth: 1, borderTopLeftRadius: 22, borderTopRightRadius: 22 }, header: { flexDirection: "row", alignItems: "center", paddingLeft: 18 },
  title: { fontSize: 20, fontWeight: "600", flex: 1 }, close: { minHeight: 52, minWidth: 52, alignItems: "center", justifyContent: "center" }, content: { padding: 18 } });
