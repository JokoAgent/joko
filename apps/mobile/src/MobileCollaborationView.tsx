import { CollaborationGoalStatus, CollaborationWorkerStatus, PermissionMode, type CollaborationWorker } from "@joko/contracts";
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import { mobileWorkerRoles, normalizeMobileWorkerForm, type MobileCollaborationView, type MobileWorkerForm, type MobileWorkerTarget } from "./mobile-collaboration";
import { mobileCollaborationCopy } from "./mobile-collaboration-messages";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobilePermissionModeLabel } from "./mobile-runtime-controls";
import { useState } from "react";

export interface MobileCollaborationViewProps {
  readonly colors: MobileInteractionSheetColors;
  readonly locale: MobileSupportedLocale;
  readonly view?: MobileCollaborationView;
  readonly targets: readonly MobileWorkerTarget[];
  readonly form?: MobileWorkerForm;
  readonly showForm: boolean;
  readonly configure: boolean;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly error?: string;
  readonly confirmation?: { readonly title: string; readonly body: string; readonly confirm: () => void };
  readonly onForm: (form: MobileWorkerForm) => void;
  readonly onTarget: (id: string) => void;
  readonly onSubmit: () => void;
  readonly onCreate: () => void;
  readonly onArchive: (worker: CollaborationWorker) => void;
  readonly onOpen: (worker: CollaborationWorker) => void;
  readonly onLead: () => void;
  readonly onEnd: () => void;
  readonly onCancel: () => void;
  readonly onRefresh: () => void;
}
export function mobileWorkerStatus(worker: CollaborationWorker, locale: MobileSupportedLocale): string {
  const copy = mobileCollaborationCopy(locale);
  if (worker.runtimeReleased && worker.status === CollaborationWorkerStatus.COMPLETED) return copy.idle;
  const statuses: Partial<Record<CollaborationWorkerStatus, string>> = { [CollaborationWorkerStatus.PROVISIONING]: copy.provisioning, [CollaborationWorkerStatus.IDLE]: worker.assignment ? copy.idle : copy.waiting,
    [CollaborationWorkerStatus.QUEUED]: copy.queued, [CollaborationWorkerStatus.RUNNING]: copy.running, [CollaborationWorkerStatus.COMPLETED]: copy.completed,
    [CollaborationWorkerStatus.FAILED]: copy.failed, [CollaborationWorkerStatus.STOPPING]: copy.stopping, [CollaborationWorkerStatus.STOPPED]: copy.stopped,
    [CollaborationWorkerStatus.DISPATCH_UNKNOWN]: copy.unknown, [CollaborationWorkerStatus.ARCHIVED]: copy.archived };
  return statuses[worker.status] ?? copy.unknown;
}
export function mobileWorkerFormValid(form: MobileWorkerForm | undefined, targets: readonly MobileWorkerTarget[]): boolean {
  if (!form) return false;
  try { normalizeMobileWorkerForm(form); } catch { return false; }
  const target = targets.find(value => value.id === form.targetId), route = target?.models.find(value => value.providerId === form.model?.providerId && value.modelId === form.model?.modelId);
  const defaultSelection = form.model && target?.defaultModel && form.model.providerId === target.defaultModel.providerId && form.model.modelId === target.defaultModel.modelId
    && form.model.effortId === target.defaultModel.effortId && form.model.fastMode === target.defaultModel.fastMode;
  return !!target && target.permissionModes.includes(form.permissionMode) && (!form.model || defaultSelection || !!route
    && (!form.model.effortId || target.canSetEffort && route.efforts.some(value => value.id === form.model!.effortId))
    && (!form.model.fastMode || target.canSetFastMode && route.supportsFastMode));
}
export function mobileCollaborationCapacity(view: MobileCollaborationView, locale: MobileSupportedLocale): string | undefined {
  if (!view.settings) return undefined;
  const active = view.tree?.workers.filter(value => !value.runtimeReleased && value.status !== CollaborationWorkerStatus.ARCHIVED).length ?? 0;
  return mobileCollaborationCopy(locale).capacity.replace("{count}", String(active)).replace("{soft}", String(view.settings.workerSoftLimit))
    .replace("{hard}", String(view.settings.workerHardLimit)).replace("{minutes}", String(view.settings.workerIdleReleaseMinutes));
}
export function MobileCollaborationViewContent(props: MobileCollaborationViewProps) {
  const { colors, locale, view, form } = props, copy = mobileCollaborationCopy(locale), disabled = props.busy || props.disabled;
  const button = (label: string, onPress: () => void, extra = false) => <Pressable key={label} accessibilityRole="button" accessibilityLabel={label}
    disabled={disabled || extra} onPress={onPress} style={[styles.button, { borderColor: colors.border }, (disabled || extra) && styles.disabled]}>
    <Text style={{ color: colors.ink }}>{label}</Text></Pressable>;
  if (props.confirmation) return <View style={styles.stack}><Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{props.confirmation.title}</Text>
    <Text style={{ color: colors.ink }}>{props.confirmation.body}</Text>{button(copy.confirm, props.confirmation.confirm)}{button(copy.cancel, props.onCancel)}</View>;
  return <View style={styles.stack}>
    {props.loading && <Text style={{ color: colors.muted }}>{copy.loading}</Text>}
    {props.error && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{props.error}</Text>}
    {!props.loading && view?.role === "worker" && <>
      <Text style={{ color: colors.muted }}>{copy.readOnly}</Text>
      {view.self && <Text style={{ color: colors.ink }}>{view.self.label} · {mobileWorkerStatus(view.self, locale)}</Text>}
      {button(copy.lead, props.onLead)}
      {view.self && view.self.status !== CollaborationWorkerStatus.ARCHIVED && button(copy.archive, () => props.onArchive(view.self!))}
    </>}
    {!props.loading && view?.role === "lead" && !props.showForm && <>
      <Text style={[styles.title, { color: colors.ink }]}>{copy.workers}</Text>
      {mobileCollaborationCapacity(view, locale) && <Text style={{ color: colors.muted }}>{mobileCollaborationCapacity(view, locale)}</Text>}
      {view.tree?.workers.filter(worker => worker.status !== CollaborationWorkerStatus.ARCHIVED).map(worker => <View key={worker.workerId}>
        <Pressable accessibilityRole="button" accessibilityLabel={`${worker.label} · ${mobileWorkerStatus(worker, locale)}`}
          accessibilityHint={copy.archive} disabled={disabled || !worker.sessionId}
          onPress={() => props.onOpen(worker)} onLongPress={() => props.onArchive(worker)} style={[styles.worker, { borderColor: colors.border }]}>
          <Text style={{ color: colors.ink }}>{worker.label} · {worker.role}</Text><Text style={{ color: colors.muted }}>{mobileWorkerStatus(worker, locale)}</Text>
          {!!worker.error?.message && <Text style={{ color: colors.negative }}>{worker.error.message}</Text>}
        </Pressable>{button(`${copy.archive} · ${worker.label}`, () => props.onArchive(worker))}
      </View>)}
      {view.tree?.goal?.status === CollaborationGoalStatus.ACTIVE && <>{button(copy.create, props.onCreate, props.targets.length === 0)}{button(copy.end, props.onEnd)}</>}
    </>}
    {!props.loading && props.showForm && (form ? <WorkerForm {...props} form={form} /> : <Text style={{ color: colors.muted }}>{copy.unavailable}</Text>)}
    {!props.configure && button(copy.refresh, props.onRefresh, props.loading)}
  </View>;
}
function WorkerForm(props: MobileCollaborationViewProps & { readonly form: MobileWorkerForm }) {
  const { form, targets, colors, locale } = props, copy = mobileCollaborationCopy(locale), [picker, setPicker] = useState<string>();
  const disabled = props.busy || props.disabled, target = targets.find(value => value.id === form.targetId);
  const model = target?.models.find(value => value.providerId === form.model?.providerId && value.modelId === form.model?.modelId);
  const patch = (value: Partial<MobileWorkerForm>) => props.onForm({ ...form, ...value });
  const choices = (id: string, label: string, options: readonly { readonly id: string; readonly label: string; readonly select: () => void }[]) => <View style={styles.stack}>
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={() => setPicker(picker === id ? undefined : id)} style={styles.button}>
      <Text style={{ color: colors.ink }}>{label} ▾</Text></Pressable>
    {picker === id && options.map(value => <Pressable key={value.id} accessibilityRole="button" accessibilityLabel={value.label} disabled={disabled}
      onPress={() => { value.select(); setPicker(undefined); }} style={styles.button}><Text style={{ color: colors.ink }}>{value.label}</Text></Pressable>)}
  </View>;
  return <View style={styles.stack}>
    <Text style={[styles.label, { color: colors.ink }]}>{copy.role}</Text>
    {choices("role", mobileWorkerRoles.includes(form.role as typeof mobileWorkerRoles[number]) ? copy[form.role as typeof mobileWorkerRoles[number]] : copy.custom,
      [...mobileWorkerRoles.map(role => ({ id: role, label: copy[role], select: () => patch({ role }) })), { id: "custom", label: copy.custom, select: () => patch({ role: "" }) }])}
    {!mobileWorkerRoles.includes(form.role as typeof mobileWorkerRoles[number]) && <TextInput accessibilityLabel={copy.custom} value={form.role} maxLength={32} editable={!disabled}
      onChangeText={role => patch({ role })} style={[styles.input, { color: colors.ink, borderColor: colors.border }]} />}
    <Text style={[styles.label, { color: colors.ink }]}>{copy.target}</Text>
    {choices("target", target ? `${target.backendName} · ${target.name}` : form.targetId, targets.map(value => ({ id: value.id, label: `${value.backendName} · ${value.name}`, select: () => props.onTarget(value.id) })))}
    <Text style={[styles.label, { color: colors.ink }]}>{copy.model}</Text>
    {choices("model", model ? `${model.providerName} · ${model.displayName}` : form.model?.modelId || copy.defaultModel,
      [{ id: "default", label: copy.defaultModel, select: () => patch({ model: undefined }) }, ...(target?.models ?? []).map(value => ({ id: value.key, label: `${value.providerName} · ${value.displayName}`,
        select: () => patch({ model: { providerId: value.providerId, modelId: value.modelId, fastMode: false } }) }))])}
    {model && target?.canSetEffort && model.efforts.length > 0 && choices("effort", `${copy.effort} · ${form.model?.effortId || copy.defaultModel}`,
      [{ id: "default", label: copy.defaultModel, select: () => patch({ model: { ...form.model!, effortId: undefined } }) }, ...model.efforts.map(value => ({ id: value.id, label: value.label || value.id,
        select: () => patch({ model: { ...form.model!, effortId: value.id } }) }))])}
    {model?.supportsFastMode && target?.canSetFastMode && <View style={styles.row}><Text style={{ color: colors.ink }}>{copy.fast}</Text><Switch accessibilityLabel={copy.fast}
      disabled={disabled} value={form.model?.fastMode === true} onValueChange={fastMode => patch({ model: { ...form.model!, fastMode } })} /></View>}
    <Text style={[styles.label, { color: colors.ink }]}>{copy.permission}</Text>
    {choices("permission", mobilePermissionModeLabel(form.permissionMode, locale), (target?.permissionModes ?? []).map(value => ({ id: String(value), label: mobilePermissionModeLabel(value, locale), select: () => patch({ permissionMode: value }) })))}
    <Text style={[styles.label, { color: colors.ink }]}>{copy.initialTask}</Text><TextInput accessibilityLabel={copy.initialTask} value={form.initialTask} multiline maxLength={32_000}
      editable={!disabled} onChangeText={initialTask => patch({ initialTask })} style={[styles.input, styles.taskInput, { color: colors.ink, borderColor: colors.border }]} />
    <Text style={{ color: colors.muted }}>{copy.taskHint}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={props.configure ? copy.confirm : props.view?.role === "lead" ? copy.create : copy.enable}
      disabled={disabled || !mobileWorkerFormValid(form, targets)} onPress={props.onSubmit} style={[styles.button, { backgroundColor: colors.brandBackground }, (disabled || !mobileWorkerFormValid(form, targets)) && styles.disabled]}>
      <Text style={{ color: colors.ink }}>{props.configure ? copy.confirm : props.view?.role === "lead" ? copy.create : copy.enable}</Text></Pressable>
    {props.view?.role === "lead" && <Pressable accessibilityRole="button" accessibilityLabel={copy.cancel} disabled={disabled} onPress={props.onCancel} style={styles.button}><Text style={{ color: colors.ink }}>{copy.cancel}</Text></Pressable>}
  </View>;
}
const styles = StyleSheet.create({ stack: { gap: 12 }, row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { fontSize: 18, fontWeight: "600" }, label: { fontSize: 14, fontWeight: "600" }, button: { minHeight: 44, padding: 12, justifyContent: "center", borderRadius: 12 },
  input: { minHeight: 44, padding: 12, borderWidth: 1, borderRadius: 12, fontSize: 16 }, taskInput: { minHeight: 96, textAlignVertical: "top" }, worker: { minHeight: 64, padding: 12, gap: 4, borderWidth: 1, borderRadius: 12 }, disabled: { opacity: 0.45 } });
