import { Host } from "@expo/ui";
import { Button, HStack, SecureField, Text, TextField, VStack, useNativeState, type SecureFieldRef, type TextFieldRef } from "@expo/ui/swift-ui";
import { accessibilityLabel, autocorrectionDisabled, buttonStyle, disabled, font, foregroundStyle, frame, keyboardType, lineLimit,
  onSubmit, padding, submitLabel, textContentType, textInputAutocapitalization } from "@expo/ui/swift-ui/modifiers";
import { useEffect, useRef, useState } from "react";
import type { InputHandoffContentType } from "@joko/contracts";
import type { MobileInputHandoffFieldsProps } from "./MobileInputHandoffFields";
import { mobileInputHandoffText } from "./mobile-input-handoff-text";

export function MobileInputHandoffFields(props: MobileInputHandoffFieldsProps) {
  const fields = props.snapshot.controls.filter(control => control.kind === "text"), focus = useRef(new Map<string, () => void>());
  return <Host matchContents colorScheme={props.colors.dark ? "dark" : "light"}><VStack spacing={14} modifiers={[frame({ maxWidth: Infinity })]}>{props.snapshot.controls.map(control => {
    if (control.kind === "note") return <Text key={control.id} modifiers={[foregroundStyle(props.colors.negative)]}>{control.text}</Text>;
    const next = fields[fields.findIndex(field => field.id === control.id) + 1];
    return <NativeField key={control.id} {...props} control={control} next={Boolean(next)} register={value => {
      if (value) focus.current.set(control.id, value); else focus.current.delete(control.id);
    }} onReturn={() => { if (!props.disabled) { if (next) focus.current.get(next.id)?.(); else props.onSubmit(); } }} />;
  })}</VStack></Host>;
}
function NativeField(props: MobileInputHandoffFieldsProps & { readonly control: Extract<MobileInputHandoffFieldsProps["snapshot"]["controls"][number], { kind: "text" }>;
  readonly next: boolean; readonly register: (focus: (() => void) | undefined) => void; readonly onReturn: () => void }) {
  const { control } = props, text = useNativeState(props.draft[control.id] ?? ""), [revealed, setRevealed] = useState(false);
  useEffect(() => { const value = props.draft[control.id] ?? ""; if (text.get() !== value) text.set(value); }, [props.draft[control.id], text]);
  const label = control.label || mobileInputHandoffText(props.locale, control.contentType === "password" ? "password" : control.contentType === "one-time-code" ? "code" : "field");
  const traits = swiftTraits(control.contentType), ref = (value: TextFieldRef | SecureFieldRef | null) => props.register(value ? () => { void value.focus(); } : undefined);
  const modifiers = [...(traits.content ? [textContentType(traits.content)] : []), keyboardType(traits.keyboard), textInputAutocapitalization("never"), autocorrectionDisabled(true),
    submitLabel(props.next ? "next" : "go"), onSubmit(props.onReturn), disabled(props.disabled), accessibilityLabel(label), font({ textStyle: "body" }), frame({ maxWidth: Infinity, minHeight: 48 }), padding({ horizontal: 10 })];
  const change = (raw: string) => { const value = raw.slice(0, 4096); if (value !== raw) text.set(value); props.onChange(control.id, value); };
  return <VStack spacing={6} alignment="leading">
    <Text modifiers={[foregroundStyle(props.colors.ink), font({ textStyle: "subheadline" })]}>{label}</Text>
    <HStack>{control.contentType === "password" && !revealed
      ? <SecureField ref={ref} text={text} placeholder={control.placeholder ?? ""} onTextChange={change} modifiers={modifiers} />
      : <TextField ref={ref} text={text} placeholder={control.placeholder ?? ""} onTextChange={change} axis={control.multiline ? "vertical" : "horizontal"}
          modifiers={control.multiline ? [...modifiers, lineLimit(4)] : modifiers} />}
      {control.contentType === "password" && <Button systemImage={revealed ? "eye.slash" : "eye"} onPress={() => setRevealed(value => !value)}
        modifiers={[buttonStyle("plain"), disabled(props.disabled), accessibilityLabel(mobileInputHandoffText(props.locale, revealed ? "hidePassword" : "showPassword")), frame({ minWidth: 44, minHeight: 44 })]} />}
    </HStack>
    {control.filled && <Text modifiers={[foregroundStyle(props.colors.muted), font({ textStyle: "footnote" })]}>{mobileInputHandoffText(props.locale, "filled")}</Text>}
    {control.suggestions?.slice(0, 12).map(option => <Button key={option.id} label={option.label} onPress={() => props.onChange(control.id, option.label)} modifiers={[disabled(props.disabled)]} />)}
  </VStack>;
}
function swiftTraits(type: InputHandoffContentType): { content?: "password" | "oneTimeCode" | "username" | "emailAddress" | "telephoneNumber" | "URL";
  keyboard: "default" | "numbers-and-punctuation" | "email-address" | "url" } {
  switch (type) {
    case "password": return { content: "password", keyboard: "default" };
    case "one-time-code": return { content: "oneTimeCode", keyboard: "numbers-and-punctuation" };
    case "username": return { content: "username", keyboard: "default" };
    case "email": return { content: "emailAddress", keyboard: "email-address" };
    case "tel": return { content: "telephoneNumber", keyboard: "numbers-and-punctuation" };
    case "url": return { content: "URL", keyboard: "url" };
    case "number": return { keyboard: "numbers-and-punctuation" };
    default: return { keyboard: "default" };
  }
}
