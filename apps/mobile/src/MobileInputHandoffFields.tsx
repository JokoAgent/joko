import { useRef } from "react";
import { Platform, Text, TextInput, View, type TextInputProps } from "react-native";
import type { InputHandoffContentType, InputHandoffSnapshot, InputHandoffValues } from "@joko/contracts";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileInputHandoffText } from "./mobile-input-handoff-text";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";

export interface MobileInputHandoffFieldsProps {
  readonly snapshot: InputHandoffSnapshot;
  readonly draft: InputHandoffValues;
  readonly disabled: boolean;
  readonly colors: MobileInteractionSheetColors & { readonly dark?: boolean };
  readonly locale: MobileSupportedLocale;
  readonly onChange: (id: string, value: string) => void;
  readonly onSubmit: () => void;
}
/** Standard system secure fields and platform AutoFill traits from the fixed native contract. */
export function mobileInputHandoffFieldTraits(type: InputHandoffContentType): Pick<TextInputProps, "secureTextEntry" | "textContentType" | "autoComplete" | "keyboardType"> {
  const numeric = Platform.OS === "ios" ? "numbers-and-punctuation" : "number-pad";
  switch (type) {
    case "password": return { secureTextEntry: true, textContentType: "password", autoComplete: "password" };
    case "one-time-code": return { textContentType: "oneTimeCode", autoComplete: "sms-otp", keyboardType: numeric };
    case "username": return { textContentType: "username", autoComplete: "username" };
    case "email": return { textContentType: "emailAddress", autoComplete: "email", keyboardType: "email-address" };
    case "tel": return { textContentType: "telephoneNumber", autoComplete: "tel", keyboardType: Platform.OS === "ios" ? "numbers-and-punctuation" : "phone-pad" };
    case "url": return { textContentType: "URL", autoComplete: "url", keyboardType: "url" };
    case "number": return { textContentType: "none", autoComplete: "off", keyboardType: numeric };
    default: return { textContentType: "none", autoComplete: "off" };
  }
}
export function MobileInputHandoffFields(props: MobileInputHandoffFieldsProps) {
  const fields = props.snapshot.controls.filter(control => control.kind === "text"), inputs = useRef(new Map<string, TextInput>());
  return <View style={{ gap: 14 }}>{props.snapshot.controls.map(control => {
    if (control.kind === "note") return <Text key={control.id} accessibilityRole="alert" style={{ color: props.colors.negative }}>{control.text}</Text>;
    const label = control.label || mobileInputHandoffText(props.locale, control.contentType === "password" ? "password" : control.contentType === "one-time-code" ? "code" : "field");
    const next = fields[fields.findIndex(field => field.id === control.id) + 1];
    return <View key={control.id} style={{ gap: 6 }}>
      <Text style={{ color: props.colors.ink }}>{label}</Text>
      <TextInput ref={input => { if (input) inputs.current.set(control.id, input); else inputs.current.delete(control.id); }}
        accessibilityLabel={label} value={props.draft[control.id] ?? ""} onChangeText={value => props.onChange(control.id, value)}
        placeholder={control.placeholder} placeholderTextColor={props.colors.muted} autoCapitalize="none" autoCorrect={false} spellCheck={false}
        editable={!props.disabled} maxLength={4096} multiline={control.multiline === true && control.contentType !== "password"}
        returnKeyType={next ? "next" : "go"} submitBehavior={next ? "submit" : "blurAndSubmit"}
        onSubmitEditing={() => { if (!props.disabled) { if (next) inputs.current.get(next.id)?.focus(); else props.onSubmit(); } }}
        style={{ minHeight: 48, borderWidth: 1, borderRadius: 12, padding: 12, color: props.colors.ink, backgroundColor: props.colors.surface, borderColor: props.colors.border }}
        {...mobileInputHandoffFieldTraits(control.contentType)} />
      {control.filled && <Text style={{ color: props.colors.muted }}>{mobileInputHandoffText(props.locale, "filled")}</Text>}
      {control.suggestions?.slice(0, 12).map(option => <Text key={option.id} accessibilityRole="button" accessibilityState={{ disabled: props.disabled }}
        style={{ color: props.colors.accent, paddingVertical: 8 }} onPress={() => { if (!props.disabled) props.onChange(control.id, option.label); }}>{option.label}</Text>)}
    </View>;
  })}</View>;
}
