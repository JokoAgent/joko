import { Host } from "@expo/ui";
import { BottomSheet, Button, Form, Group, Picker, ProgressView, Section, Text, TextField, Toggle, useNativeState } from "@expo/ui/swift-ui";
import { accessibilityLabel, buttonStyle, disabled, font, foregroundStyle, frame, lineLimit, onLongPressGesture, pickerStyle, presentationDragIndicator, tag } from "@expo/ui/swift-ui/modifiers";
import { CollaborationWorkerStatus } from "@joko/contracts";
import type { MobileCollaborationNativeSheetProps } from "./MobileCollaborationNativeSheet";
import { mobileWorkerFormValid, mobileCollaborationCapacity, mobileWorkerStatus } from "./MobileCollaborationView";
import { mobileWorkerRoles, type MobileWorkerForm } from "./mobile-collaboration";
import { mobileCollaborationCopy } from "./mobile-collaboration-messages";
import { mobilePermissionModeLabel } from "./mobile-runtime-controls";

export function MobileCollaborationNativeSheet(props: MobileCollaborationNativeSheetProps) {
  return <Host colorScheme={props.dark === undefined ? undefined : props.dark ? "dark" : "light"} seedColor={props.colors.accent}
    pointerEvents="none" style={{ position: "absolute" }}>
    <BottomSheet isPresented={props.visible} onIsPresentedChange={value => { if (!value && !props.busy) props.onClose(); }}>
      <Group modifiers={[presentationDragIndicator("visible")]}><Content {...props} /></Group>
    </BottomSheet>
  </Host>;
}
function Content(props: MobileCollaborationNativeSheetProps) {
  const copy = mobileCollaborationCopy(props.locale), block = props.disabled || props.busy;
  const action = (label: string, onPress: () => void, extra = false) => <Button key={label} label={label} onPress={onPress}
    modifiers={[buttonStyle("plain"), disabled(block || extra), frame({ minHeight: 44 })]} />;
  if (props.confirmation) return <Form><Section title={props.confirmation.title}>
    <Text>{props.confirmation.body}</Text>{action(copy.confirm, props.confirmation.confirm)}{action(copy.cancel, props.onCancel)}
  </Section></Form>;
  const view = props.view, capacity = view && mobileCollaborationCapacity(view, props.locale);
  return <Form>
    <Section title={copy.title}><Button label={copy.close} systemImage="xmark" onPress={props.onClose} modifiers={[disabled(props.busy)]} />
      {props.loading && <><ProgressView /><Text>{copy.loading}</Text></>}
      {props.error && <Text modifiers={[foregroundStyle(props.colors.negative), accessibilityLabel(props.error)]}>{props.error}</Text>}
    </Section>
    {!props.loading && view?.role === "worker" && <Section>
      <Text modifiers={[foregroundStyle(props.colors.muted)]}>{copy.readOnly}</Text>
      {view.self && <Text>{view.self.label} · {mobileWorkerStatus(view.self, props.locale)}</Text>}
      {action(copy.lead, props.onLead)}
      {view.self && view.self.status !== CollaborationWorkerStatus.ARCHIVED && action(copy.archive, () => props.onArchive(view.self!))}
    </Section>}
    {!props.loading && view?.role === "lead" && !props.showForm && <>
      <Section title={copy.workers}>
        {capacity && <Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle(props.colors.muted)]}>{capacity}</Text>}
        {view.tree?.workers.filter(value => value.status !== CollaborationWorkerStatus.ARCHIVED).map(worker => <Group key={worker.workerId}>
          <Button onPress={() => props.onOpen(worker)} modifiers={[buttonStyle("plain"), disabled(block || !worker.sessionId),
            frame({ minHeight: 52 }), onLongPressGesture(() => { if (!block) props.onArchive(worker); })]}>
            <Text>{worker.label} · {worker.role}</Text><Text modifiers={[foregroundStyle(props.colors.muted)]}>{mobileWorkerStatus(worker, props.locale)}</Text>
          </Button>
          {!!worker.error?.message && <Text modifiers={[foregroundStyle(props.colors.negative)]}>{worker.error.message}</Text>}
          {action(`${copy.archive} · ${worker.label}`, () => props.onArchive(worker))}
        </Group>)}
      </Section><Section>{action(copy.create, props.onCreate, props.targets.length === 0)}{action(copy.end, props.onEnd)}</Section>
    </>}
    {!props.loading && props.showForm && (props.form ? <WorkerForm {...props} form={props.form} /> : <Section><Text>{copy.unavailable}</Text></Section>)}
    {!props.configure && <Section>{action(copy.refresh, props.onRefresh, props.loading)}</Section>}
  </Form>;
}
function WorkerForm(props: MobileCollaborationNativeSheetProps & { readonly form: MobileWorkerForm }) {
  const { form, locale } = props, copy = mobileCollaborationCopy(locale), block = props.busy || props.disabled;
  const target = props.targets.find(value => value.id === form.targetId), model = target?.models.find(value => value.providerId === form.model?.providerId && value.modelId === form.model?.modelId);
  const patch = (value: Partial<MobileWorkerForm>) => props.onForm({ ...form, ...value });
  const preset = mobileWorkerRoles.includes(form.role as typeof mobileWorkerRoles[number]);
  return <>
    <Section title={copy.role}><Picker label={copy.role} selection={preset ? form.role : "custom"} onSelectionChange={value => patch({ role: value === "custom" ? "" : value })}
      modifiers={[pickerStyle("menu"), disabled(block)]}>
      {mobileWorkerRoles.map(value => <Text key={value} modifiers={[tag(value)]}>{copy[value]}</Text>)}<Text modifiers={[tag("custom")]}>{copy.custom}</Text>
    </Picker>{!preset && <NativeField key="custom" label={copy.custom} value={form.role} disabled={block} onChange={role => patch({ role: role.slice(0, 32) })} />}</Section>
    <Section title={copy.target}><Picker label={copy.target} selection={form.targetId} onSelectionChange={props.onTarget} modifiers={[pickerStyle("menu"), disabled(block)]}>
      {!target && <Text modifiers={[tag(form.targetId)]}>{form.targetId}</Text>}
      {props.targets.map(value => <Text key={value.id} modifiers={[tag(value.id)]}>{value.backendName} · {value.name}</Text>)}
    </Picker></Section>
    <Section title={copy.model}><Picker label={copy.model} selection={model?.key ?? (form.model ? "retained" : "default")} onSelectionChange={value => {
      const route = target?.models.find(item => item.key === value); patch({ model: route ? { providerId: route.providerId, modelId: route.modelId, fastMode: false } : undefined });
    }} modifiers={[pickerStyle("menu"), disabled(block)]}>
      <Text modifiers={[tag("default")]}>{copy.defaultModel}</Text>
      {form.model && !model && <Text modifiers={[tag("retained")]}>{form.model.providerId} · {form.model.modelId}</Text>}
      {target?.models.map(value => <Text key={value.key} modifiers={[tag(value.key)]}>{value.providerName} · {value.displayName}</Text>)}
    </Picker>
    {model && target?.canSetEffort && model.efforts.length > 0 && <Picker label={copy.effort} selection={form.model?.effortId ?? "default"} onSelectionChange={value => patch({ model: { ...form.model!, effortId: value === "default" ? undefined : value } })}
      modifiers={[pickerStyle("menu"), disabled(block)]}>
      <Text modifiers={[tag("default")]}>{copy.defaultModel}</Text>{model.efforts.map(value => <Text key={value.id} modifiers={[tag(value.id)]}>{value.label || value.id}</Text>)}
    </Picker>}
    {model?.supportsFastMode && target?.canSetFastMode && <Toggle label={copy.fast} isOn={form.model?.fastMode === true} onIsOnChange={fastMode => patch({ model: { ...form.model!, fastMode } })} modifiers={[disabled(block)]} />}
    </Section>
    <Section title={copy.permission}><Picker label={copy.permission} selection={String(form.permissionMode)} onSelectionChange={value => patch({ permissionMode: Number(value) })} modifiers={[pickerStyle("menu"), disabled(block)]}>
      {target?.permissionModes.map(value => <Text key={value} modifiers={[tag(String(value))]}>{mobilePermissionModeLabel(value, locale)}</Text>)}
    </Picker></Section>
    <Section title={copy.initialTask}><NativeField key={`${form.targetId}-task`} label={copy.initialTask} value={form.initialTask} disabled={block}
      onChange={initialTask => patch({ initialTask: initialTask.slice(0, 32_000) })} multiline />
      <Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle(props.colors.muted)]}>{copy.taskHint}</Text>
    </Section>
    <Section><Button label={props.configure ? copy.confirm : props.view?.role === "lead" ? copy.create : copy.enable} onPress={props.onSubmit}
      modifiers={[buttonStyle("borderedProminent"), disabled(block || !mobileWorkerFormValid(form, props.targets)), frame({ minHeight: 44 })]} />
      {props.view?.role === "lead" && <Button label={copy.cancel} onPress={props.onCancel} modifiers={[disabled(block)]} />}
    </Section>
  </>;
}
function NativeField(props: { readonly label: string; readonly value: string; readonly disabled: boolean; readonly multiline?: boolean; readonly onChange: (value: string) => void }) {
  const value = useNativeState(props.value);
  return <TextField text={value} onTextChange={text => {
    const next = text.slice(0, props.multiline ? 32_000 : 32); if (next !== text) value.set(next); props.onChange(next);
  }} placeholder={props.label} axis={props.multiline ? "vertical" : "horizontal"}
    modifiers={[accessibilityLabel(props.label), disabled(props.disabled), ...(props.multiline ? [lineLimit({ min: 3, max: 6 })] : [])]} />;
}
