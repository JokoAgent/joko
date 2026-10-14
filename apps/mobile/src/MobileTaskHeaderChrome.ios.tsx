import { useMemo } from "react";
import { Host } from "@expo/ui";
import { Button, HStack, RNHostView, VStack } from "@expo/ui/swift-ui";
import { View } from "react-native";
import { accessibilityElement, accessibilityLabel, background, buttonStyle, contentShape, disabled, frame, glassEffect, labelStyle,
  shapes } from "@expo/ui/swift-ui/modifiers";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import type { MobileTaskHeaderButtonsProps } from "./MobileTaskHeaderChrome";
import { MobileTaskHeaderIcon } from "./MobileTaskHeaderIcon";

export function MobileTaskHeaderButtons({ buttons, colors, focusRef }: MobileTaskHeaderButtonsProps) {
  const glass = useMemo(() => { try { return isLiquidGlassAvailable(); } catch { return false; } }, []);
  return <View ref={focusRef} collapsable={false}><Host colorScheme={colors.dark ? "dark" : "light"} seedColor={colors.ink} ignoreSafeArea="all"
    style={{ width: buttons.length * 44, height: 44 }}>
    <HStack spacing={0} modifiers={glass ? [glassEffect({ glass: { variant: "clear" }, shape: "capsule" })]
      : [background(colors.surface, shapes.capsule())]}>
      {buttons.map(button => <Button key={button.id}
        {...(button.id === "remote-desktop" || button.id === "files" || button.id === "list" || button.id === "new"
          ? {} : { systemImage: button.id === "back" ? "chevron.backward" as const : "ellipsis" as const, label: button.label })} onPress={button.onPress}
        testID={`task.header.${button.id}`} modifiers={[labelStyle("iconOnly"), buttonStyle("borderless"), disabled(button.disabled),
          frame({ width: 44, height: 44 }), contentShape(shapes.rectangle()), accessibilityElement("ignore"), accessibilityLabel(button.label)]}>
        {(button.id === "remote-desktop" || button.id === "files" || button.id === "list" || button.id === "new") ?
          <VStack modifiers={[frame({ width: 44, height: 44 }), contentShape(shapes.rectangle())]}>
            <RNHostView><View pointerEvents="none" style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
              <MobileTaskHeaderIcon id={button.id} color={colors.ink} />
            </View></RNHostView>
          </VStack> : undefined}
      </Button>)}
    </HStack>
  </Host></View>;
}
