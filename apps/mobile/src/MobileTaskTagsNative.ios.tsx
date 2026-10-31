import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, AppState } from "react-native";
import { Host } from "@expo/ui";
import { BottomSheet, Button, Circle, Form, Group, HStack, List, ProgressView, Section, Text, TextField, VStack, useNativeState } from "@expo/ui/swift-ui";
import { accessibilityAddTraits, accessibilityLabel, buttonStyle, deleteDisabled, disabled, environment, foregroundStyle, frame, interactiveDismissDisabled, moveDisabled, presentationDragIndicator, strokeBorder } from "@expo/ui/swift-ui/modifiers";
import { mobileMessage } from "./mobile-messages";
import type { MobileTaskTagNativeForm, MobileTaskTagsNativeProps } from "./MobileTaskTagsNative";

export const mobileTaskTagsNativeAvailable = true;
export function MobileTaskTagsNative(props: MobileTaskTagsNativeProps) {
  const [sorting, setSorting] = useState(false);
  const latest = useRef({ props, sorting }); latest.current = { props, sorting };
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setSorting(false); }, [props.visible, props.revision, props.adding, props.edit !== undefined]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", state => { if (state !== "active") setSorting(false); });
    return () => subscription.remove();
  }, []);
  const activate = (action: () => void) => {
    if (alive.current && latest.current.props === props && props.visible && !props.busy && AppState.currentState === "active") action();
  };
  useEffect(() => { if (props.error && props.visible) AccessibilityInfo.announceForAccessibility(props.error); }, [props.error, props.visible]);
  const t = (key: Parameters<typeof mobileMessage>[1]) => mobileMessage(props.locale, key);
  const form = props.edit ?? (props.adding ? props.create : undefined);
  return <Host colorScheme={props.colors.dark ? "dark" : "light"} seedColor={props.colors.ink} pointerEvents="none" style={{ position: "absolute" }}>
    <BottomSheet isPresented={props.visible} onIsPresentedChange={value => { if (!value) activate(props.onClose); }}>
      <Group modifiers={[presentationDragIndicator("visible"), interactiveDismissDisabled(props.busy || sorting)]}>
        <Form modifiers={[environment("editMode", sorting ? "active" : "inactive")]}>
          <Section title={t(props.edit ? "taskTags.manage" : props.adding ? "taskTags.create" : "taskTags.title")}>
            {props.subtitle && <Text>{props.subtitle}</Text>}
            <Button label={t(form ? "common.back" : "common.cancel")} onPress={() => activate(form ? props.onBack : props.onClose)}
              modifiers={[disabled(props.busy || sorting)]} />
            {props.busy && <ProgressView />}
          </Section>
          {form ? <TagForm key={props.edit ? "edit" : "create"} form={form} props={props} activate={activate} /> : <>
            <Section><Text modifiers={[foregroundStyle(props.colors.muted)]}>{t("taskTags.help")}</Text></Section>
            {props.items.length > 1 && <Section>
              <Button label={t(sorting ? "taskTags.reorderDone" : "taskTags.reorder")} onPress={() => activate(() => setSorting(value => !value))}
                modifiers={[disabled(props.busy)]} />
            </Section>}
            <Section title={t("taskTags.title")}>
              <List.ForEach key={props.revision.toString()} onMove={(sources, destination) => {
                const from = sources[0], to = from === undefined ? -1 : destination > from ? destination - 1 : destination;
                if (sources.length !== 1 || from === undefined || to < 0 || to >= props.items.length || from === to || !latest.current.sorting) return;
                activate(() => props.onMove(from, to));
              }}>
                {props.items.map(item => <HStack key={item.id} spacing={12}
                  modifiers={[deleteDisabled(true), moveDisabled(props.busy || !sorting)]}>
                  <Circle modifiers={[foregroundStyle(item.color), frame({ width: 18, height: 18 })]} />
                  <Button label={(item.attached ? "✓ " : "") + item.name} onPress={() => { if (!latest.current.sorting) activate(item.onToggle); }}
                    modifiers={[buttonStyle("plain"), disabled(props.busy || sorting), frame({ maxWidth: Infinity, minHeight: 44 }),
                      accessibilityLabel(t(item.attached ? "taskTags.detach" : "taskTags.attach") + " " + item.name)]} />
                  {!sorting && <Button label={t("taskTags.manage")} systemImage="pencil" onPress={() => activate(item.onEdit)}
                    modifiers={[disabled(props.busy), frame({ minWidth: 44, minHeight: 44 })]} />}
                </HStack>)}
              </List.ForEach>
              {!props.items.length && <Text>{t("taskTags.empty")}</Text>}
            </Section>
            {!sorting && <Section><Button label={t("taskTags.create")} systemImage="plus" onPress={() => activate(props.onAdd)}
              modifiers={[disabled(props.busy || props.items.length >= 256)]} /></Section>}
          </>}
          {!!props.error && <Section><Text modifiers={[foregroundStyle(props.colors.negative)]}>{props.error}</Text></Section>}
          {props.edit && <Section><Button label={t("taskTags.delete")} role="destructive" onPress={() => activate(props.onDelete)} modifiers={[disabled(props.busy)]} /></Section>}
        </Form>
      </Group>
    </BottomSheet>
  </Host>;
}

function TagForm({ form, props, activate }: { readonly form: MobileTaskTagNativeForm; readonly props: MobileTaskTagsNativeProps;
  readonly activate: (action: () => void) => void }) {
  const text = useNativeState(form.name);
  useEffect(() => { if (text.get() !== form.name) text.set(form.name); }, [form.name, text]);
  const t = (key: Parameters<typeof mobileMessage>[1]) => mobileMessage(props.locale, key);
  return <Section title={t(props.edit ? "taskTags.manage" : "taskTags.create")}>
    <TextField text={text} onTextChange={name => activate(() => form.onName(name))} maxLength={80} autoFocus placeholder={t("taskTags.name")}
      modifiers={[disabled(props.busy), accessibilityLabel(t("taskTags.name"))]} />
    <VStack spacing={0}>{[props.palette.slice(0, 6), props.palette.slice(6)].map((row, index) => <HStack key={index} spacing={0}>
      {row.map(color => <Button key={color.value} onPress={() => activate(() => form.onColor(color.value))}
        modifiers={[buttonStyle("plain"), disabled(props.busy), accessibilityLabel(color.name),
          accessibilityAddTraits(form.color === color.value ? ["isSelected"] : []), frame({ maxWidth: Infinity, minHeight: 48 })]}>
        <VStack spacing={2}><Circle modifiers={[foregroundStyle(color.hex), frame({ width: 24, height: 24 }), strokeBorder({ color: props.colors.border, shape: "circle", style: { lineWidth: 1 } })]} />
          <Text modifiers={[foregroundStyle(form.color === color.value ? props.colors.accent : props.colors.muted)]}>{form.color === color.value ? "✓" : " "}</Text>
        </VStack>
      </Button>)}
    </HStack>)}</VStack>
    <Button label={t("taskTags.save")} onPress={() => activate(form.onSave)} modifiers={[disabled(props.busy || !form.canSave)]} />
  </Section>;
}
