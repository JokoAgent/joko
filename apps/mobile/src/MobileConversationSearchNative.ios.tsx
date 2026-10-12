import { Host } from "@expo/ui";
import { BottomSheet, Button, Group, HStack, Spacer, Text, TextField, VStack, useNativeState } from "@expo/ui/swift-ui";
import { accessibilityLabel, autocorrectionDisabled, background, buttonStyle, contentShape, disabled, font, foregroundStyle,
  frame, glassEffect, labelStyle, padding, presentationDragIndicator, shapes, submitLabel, textInputAutocapitalization } from "@expo/ui/swift-ui/modifiers";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { useEffect, useMemo } from "react";
import type { MobileConversationSearchNativeProps } from "./MobileConversationSearchNative";

export function MobileConversationSearchNative(props: MobileConversationSearchNativeProps) {
  return <Host colorScheme={props.colors.dark ? "dark" : "light"} seedColor={props.colors.ink} pointerEvents="none" style={{ position: "absolute" }}>
    <BottomSheet fitToContents isPresented={props.visible} onIsPresentedChange={(presented) => { if (!presented) props.onClose(); }}>
      <Group modifiers={[presentationDragIndicator("visible")]}><SearchContent {...props} /></Group>
    </BottomSheet>
  </Host>;
}

function SearchContent(props: MobileConversationSearchNativeProps) {
  const { colors, query } = props;
  const text = useNativeState(query);
  useEffect(() => { if (text.get() !== query) text.set(query); }, [query, text]);
  const glass = useMemo(() => { try { return isLiquidGlassAvailable(); } catch { return false; } }, []);
  const button = [buttonStyle("borderless"), font({ size: 20 }), frame({ width: 44, height: 44 }), contentShape(shapes.circle()),
    ...(glass ? [glassEffect({ glass: { variant: "regular", interactive: true }, shape: "circle" })] : [background(colors.surface, shapes.circle())])];
  return <VStack spacing={8} modifiers={[padding({ top: 20, leading: 20, trailing: 20, bottom: 20 }), frame({ maxWidth: Infinity, alignment: "topLeading" })]}>
    <Text modifiers={[font({ textStyle: "headline" }), foregroundStyle(colors.ink)]}>{props.title}</Text>
    <HStack spacing={8} modifiers={[padding({ leading: 12, trailing: 8 }), frame({ minHeight: 48 }), background(colors.surface, shapes.capsule())]}>
      <TextField text={text} autoFocus placeholder={props.placeholder} onTextChange={props.onChangeQuery}
        modifiers={[autocorrectionDisabled(), textInputAutocapitalization("never"), submitLabel("search"), accessibilityLabel(props.placeholder), frame({ maxWidth: Infinity })]} />
      {query !== "" && <Button label={props.clearLabel} systemImage="xmark.circle.fill" onPress={() => { text.set(""); props.onChangeQuery(""); }}
        modifiers={[labelStyle("iconOnly"), buttonStyle("plain"), frame({ width: 44, height: 44 })]} />}
    </HStack>
    <HStack>
      <Text modifiers={[font({ textStyle: "subheadline" }), foregroundStyle(colors.muted)]}>{props.counter}</Text><Spacer />
      <Button label={props.previousLabel} systemImage="chevron.up" onPress={() => props.onMove("previous")}
        modifiers={[labelStyle("iconOnly"), ...button, disabled(!props.hasHits), frame({ width: 44, height: 44 })]} />
      <Button label={props.nextLabel} systemImage="chevron.down" onPress={() => props.onMove("next")}
        modifiers={[labelStyle("iconOnly"), ...button, disabled(!props.hasHits), frame({ width: 44, height: 44 })]} />
    </HStack>
    {props.earlier.visible && <Button label={props.earlier.label} onPress={props.onLoadEarlier}
      modifiers={[buttonStyle("bordered"), disabled(props.earlier.disabled), accessibilityLabel(props.earlier.label)]} />}
    {props.failed !== undefined && <Text modifiers={[foregroundStyle(colors.negative)]}>{props.failed}</Text>}
  </VStack>;
}
