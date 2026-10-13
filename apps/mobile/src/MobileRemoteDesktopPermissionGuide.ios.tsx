import { useMemo } from "react";
import { ScrollView, Text as AppText, View } from "react-native";
import { Host } from "@expo/ui";
import { Button, Divider, LabeledContent, Text, VStack } from "@expo/ui/swift-ui";
import { accessibilityAddTraits, accessibilityLabel, background, buttonBorderShape, buttonStyle, controlSize,
  disabled, fixedSize, font, foregroundStyle, frame, multilineTextAlignment, padding, shapes } from "@expo/ui/swift-ui/modifiers";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import type { MobileRemoteDesktopPermissionGuideProps } from "./MobileRemoteDesktopPermissionGuide";

export function MobileRemoteDesktopPermissionGuide(props: MobileRemoteDesktopPermissionGuideProps) {
  const glass = useMemo(() => { try { return isLiquidGlassAvailable(); } catch { return false; } }, []);
  const colors = props.colors, unavailable = props.disabled || props.pending;
  const primary = [buttonStyle(glass ? "glassProminent" : "borderedProminent"), buttonBorderShape("capsule"), controlSize("regular"), frame({ minHeight: 44 })];
  const multiline = [fixedSize({ horizontal: false, vertical: true }), multilineTextAlignment("center"), frame({ maxWidth: Infinity, minHeight: 44 })];
  return <ScrollView testID="remoteDesktop.permissionGuide" style={{ width: "100%", maxWidth: 520, maxHeight: "100%", flexGrow: 0 }}
    contentContainerStyle={{ padding: 16, gap: 16, backgroundColor: colors.surface }}>
    <Host matchContents={{ vertical: true }} colorScheme={colors.dark ? "dark" : "light"} seedColor={colors.accent} ignoreSafeArea="all">
      <VStack alignment="leading" spacing={16} modifiers={[frame({ maxWidth: Infinity, alignment: "leading" })]}>
        <Text modifiers={[font({ textStyle: "title2", weight: "medium" }), foregroundStyle(colors.ink), accessibilityAddTraits(["isHeader"])]}>{props.title}</Text>
        <Text modifiers={[font({ textStyle: "subheadline" }), foregroundStyle(colors.muted), fixedSize({ horizontal: false, vertical: true })]}>{props.intro}</Text>
        <VStack spacing={16} modifiers={[padding({ all: 12 }), background(colors.background, shapes.roundedRectangle({ cornerRadius: 14 }))]}>
          {props.rows.map((row, index) => <VStack key={row.label} spacing={16}>
            {index > 0 && <Divider />}
            <LabeledContent label={<Text modifiers={[foregroundStyle(colors.ink)]}>{row.label}</Text>}>
              <Text modifiers={[foregroundStyle(colors.muted)]}>{row.value}</Text>
            </LabeledContent>
          </VStack>)}
        </VStack>
        {props.guideLabel && <Button onPress={props.onGuide} modifiers={[...primary, disabled(unavailable), accessibilityLabel(props.guideLabel)]}>
          <Text modifiers={multiline}>{props.guideLabel}</Text>
        </Button>}
        <Button onPress={props.onReconnect} modifiers={[...(props.guideLabel ? [buttonStyle("plain"), frame({ minHeight: 44 })] : primary),
          disabled(unavailable), accessibilityLabel(props.reconnectLabel)]}>
          <Text modifiers={multiline}>{props.reconnectLabel}</Text>
        </Button>
      </VStack>
    </Host>
    {props.notice && <View><AppText accessibilityRole="alert" style={{ color: colors.muted, fontSize: 13, lineHeight: 19 }}>{props.notice}</AppText></View>}
  </ScrollView>;
}
