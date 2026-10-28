import { useEffect, useRef } from "react";
import { AccessibilityInfo, AppState } from "react-native";
import { Host } from "@expo/ui";
import { BottomSheet, Button, Circle, Form, Group, HStack, Picker, ProgressView, Section, Text, TextField, useNativeState } from "@expo/ui/swift-ui";
import { accessibilityLabel, buttonStyle, disabled, foregroundStyle, frame, interactiveDismissDisabled, pickerStyle, presentationDragIndicator, tag } from "@expo/ui/swift-ui/modifiers";
import { mobileMessage } from "./mobile-messages";
import type { MobileTaskTagNativeForm, MobileTaskTagsNativeProps } from "./MobileTaskTagsNative";

export const mobileTaskTagsNativeAvailable = true;
export function MobileTaskTagsNative(props: MobileTaskTagsNativeProps) {
  const latest = useRef(props); latest.current = props;
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const activate = (action: () => void) => {
    if (alive.current && latest.current === props && latest.current.visible && !latest.current.busy && AppState.currentState === "active") action();
  };
  useEffect(() => { if (props.error && props.visible) AccessibilityInfo.announceForAccessibility(props.error); }, [props.error, props.visible]);
  const t = (key: Parameters<typeof mobileMessage>[1]) => mobileMessage(props.locale, key);
  return <Host colorScheme={props.colors.dark ? "dark" : "light"} seedColor={props.colors.ink} pointerEvents="none" style={{ position: "absolute" }}>
    <BottomSheet isPresented={props.visible} onIsPresentedChange={value => { if (!value) activate(props.onClose); }}>
      <Group modifiers={[presentationDragIndicator("visible"), interactiveDismissDisabled(props.busy)]}><Form>
        <Section title={t(props.edit ? "taskTags.manage" : "taskTags.title")}>
          {props.subtitle && <Text>{props.subtitle}</Text>}
          <Button label={t(props.edit ? "common.back" : "common.cancel")} onPress={() => activate(props.edit ? props.onBack : props.onClose)}
            modifiers={[disabled(props.busy)]} />
          {props.busy && <ProgressView />}
        </Section>
        {props.edit ? <TagForm key="edit" form={props.edit} props={props} activate={activate} /> : <>
          <Section><Text modifiers={[foregroundStyle(props.colors.muted)]}>{t("taskTags.help")}</Text></Section>
          <Section title={t("taskTags.title")}>
            {props.items.map(item => <HStack key={item.id} spacing={12}>
              <Button label={`${item.attached ? "✓ " : ""}${item.name}`} onPress={() => activate(item.onToggle)}
                modifiers={[buttonStyle("plain"), disabled(props.busy), frame({ maxWidth: Infinity, minHeight: 44 }),
                  accessibilityLabel(`${t(item.attached ? "taskTags.detach" : "taskTags.attach")} ${item.name}`)]} />
              <Circle modifiers={[foregroundStyle(item.color), frame({ width: 12, height: 12 })]} />
              <Button label={t("taskTags.moveUp")} systemImage="arrow.up" onPress={() => item.onUp && activate(item.onUp)}
                modifiers={[disabled(props.busy || !item.onUp), frame({ minWidth: 44, minHeight: 44 })]} />
              <Button label={t("taskTags.moveDown")} systemImage="arrow.down" onPress={() => item.onDown && activate(item.onDown)}
                modifiers={[disabled(props.busy || !item.onDown), frame({ minWidth: 44, minHeight: 44 })]} />
              <Button label={t("taskTags.manage")} systemImage="ellipsis" onPress={() => activate(item.onEdit)} modifiers={[disabled(props.busy), frame({ minWidth: 44, minHeight: 44 })]} />
            </HStack>)}
            {!props.items.length && <Text>{t("taskTags.empty")}</Text>}
          </Section>
          <TagForm key="create" form={props.create} props={props} activate={activate} />
        </>}
        {!!props.error && <Section><Text modifiers={[foregroundStyle(props.colors.negative)]}>{props.error}</Text></Section>}
        {props.edit && <Section><Button label={t("taskTags.delete")} role="destructive" onPress={() => activate(props.onDelete)} modifiers={[disabled(props.busy)]} /></Section>}
      </Form></Group>
    </BottomSheet>
  </Host>;
}

function TagForm({ form, props, activate }: { readonly form: MobileTaskTagNativeForm; readonly props: MobileTaskTagsNativeProps;
  readonly activate: (action: () => void) => void }) {
  const text = useNativeState(form.name);
  useEffect(() => { if (text.get() !== form.name) text.set(form.name); }, [form.name, text]);
  const t = (key: Parameters<typeof mobileMessage>[1]) => mobileMessage(props.locale, key);
  return <Section title={t(props.edit ? "taskTags.manage" : "taskTags.create")}>
    <TextField text={text} onTextChange={name => activate(() => form.onName(name))} maxLength={80} placeholder={t("taskTags.name")}
      modifiers={[disabled(props.busy), accessibilityLabel(t("taskTags.name"))]} />
    <Picker label={t("taskTags.color")} selection={form.color} onSelectionChange={(value: string | number) => {
      const color = props.palette.find(color => color.value === value); if (color) activate(() => form.onColor(color.value));
    }}
      modifiers={[pickerStyle("menu"), disabled(props.busy)]}>
      {props.palette.map(color => <Text key={color.value} modifiers={[tag(color.value)]}>{color.name}</Text>)}
    </Picker>
    <Button label={t(props.edit ? "taskTags.save" : "taskTags.create")} onPress={() => activate(form.onSave)} modifiers={[disabled(props.busy || !form.canSave)]} />
  </Section>;
}
