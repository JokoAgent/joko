import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { Host } from "@expo/ui";
import { BottomSheet, Button, Circle, Form, Group, HStack, RNHostView, Section, Text, ZStack } from "@expo/ui/swift-ui";
import { accessibilityAddTraits, accessibilityLabel, buttonStyle, disabled, foregroundStyle, frame, presentationDragIndicator, strokeBorder } from "@expo/ui/swift-ui/modifiers";
import { DeferredSheetAction } from "./task-actions";
import { mobileMessage } from "./mobile-messages";
import type { MobileTaskOptionsSheetProps } from "./MobileTaskOptionsSheet";

export function MobileTaskOptionsSheet<Action extends string>(props: MobileTaskOptionsSheetProps<Action>) {
  const lifecycle = useRef(new DeferredSheetAction<Action>()).current;
  const closing = useRef<number | undefined>(undefined), wasVisible = useRef(false), live = useRef(true);
  const presentation = useRef(0);
  const latest = useRef(props); latest.current = props;
  if (props.visible && !wasVisible.current) { lifecycle.open(); closing.current = undefined; presentation.current++; }
  const occurrence = presentation.current;
  wasVisible.current = props.visible;
  useEffect(() => {
    live.current = true;
    const subscription = AppState.addEventListener("change", state => {
      if (state !== "active") { closing.current = lifecycle.cancel(); latest.current.onClose(); }
    });
    return () => { live.current = false; lifecycle.cancel(); subscription.remove(); };
  }, [lifecycle]);
  const cancel = () => { closing.current = lifecycle.cancel(); latest.current.onClose(); };
  const select = (id: Action) => {
    const selected = latest.current.items.find(value => value.id === id);
    if (!live.current || presentation.current !== occurrence || !latest.current.visible || AppState.currentState !== "active"
      || !selected || selected.disabled) return;
    closing.current = lifecycle.select(id); latest.current.onClose();
  };
  const sections: Array<typeof props.items[number][]> = [[]];
  for (const item of props.items) {
    if ((item.separatorBefore || item.destructive && !sections.at(-1)!.at(-1)?.destructive) && sections.at(-1)!.length) sections.push([]);
    sections.at(-1)!.push(item);
  }
  return <Host pointerEvents="none" style={{ position: "absolute" }} seedColor={props.colors.ink}>
    <BottomSheet key={occurrence} isPresented={props.visible} onIsPresentedChange={value => { if (presentation.current === occurrence && !value && closing.current === undefined) cancel(); }}
      onDismiss={() => {
        if (presentation.current !== occurrence) return;
        const generation = closing.current; closing.current = undefined;
        if (generation === undefined || !live.current || latest.current.visible || AppState.currentState !== "active") return;
        const action = lifecycle.closed(generation), item = latest.current.items.find(item => item.id === action);
        if (action && item && !item.disabled) latest.current.onAction(action);
      }}>
      <Group modifiers={[presentationDragIndicator("visible")]}><Form>
        {props.header && <Section><RNHostView><>{props.header}</></RNHostView></Section>}
        {sections.filter(section => section.length).map((section, index) => <Section key={index}>
          {section.map((item, itemIndex) => item.swatch ? itemIndex === section.findIndex(item => item.swatch !== undefined) ? <HStack key={item.id} spacing={0}>
            {section.filter(item => item.swatch !== undefined).map(item => <Button key={item.id} onPress={() => select(item.id)}
              modifiers={[buttonStyle("plain"), disabled(item.disabled === true), frame({ maxWidth: Infinity, minHeight: 44 }),
                accessibilityLabel(item.label), accessibilityAddTraits(item.swatch!.selected ? ["isSelected"] : [])]}>
              <ZStack><Circle modifiers={[foregroundStyle(item.swatch!.color), frame({ width: 24, height: 24 }),
                strokeBorder({ color: props.colors.border, shape: "circle", style: { lineWidth: 1 } })]} />
                {item.swatch!.selected && <Text modifiers={[foregroundStyle(props.colors.ink)]}>✓</Text>}
              </ZStack>
            </Button>)}
          </HStack> : null : <Button key={item.id} label={item.label} role={item.destructive ? "destructive" : undefined}
            onPress={() => select(item.id)} modifiers={[buttonStyle("plain"), disabled(item.disabled === true), frame({ minHeight: 44 }),
              foregroundStyle(item.destructive ? props.colors.negative : props.colors.ink), accessibilityLabel(item.label)]} />)}
        </Section>)}
        <Section><Button label={mobileMessage(props.locale, "common.cancel")} onPress={cancel}
          modifiers={[accessibilityLabel(props.cancelAccessibilityLabel ?? mobileMessage(props.locale, "common.cancel"))]} /></Section>
      </Form></Group>
    </BottomSheet>
  </Host>;
}
