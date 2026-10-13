import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Host } from "@expo/ui";
import { BottomSheet, Button, Group, HStack, Menu, Popover, RNHostView, Spacer, Toggle, VStack } from "@expo/ui/swift-ui";
import { accessibilityAddTraits, accessibilityElement, accessibilityLabel, background, buttonStyle, contentShape,
  disabled, frame, glassEffect, presentationDetents, presentationDragIndicator, shapes } from "@expo/ui/swift-ui/modifiers";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import type { MobileRemoteDesktopDisplaySelectorProps, MobileRemoteDesktopPanelProps, MobileRemoteDesktopToolbarProps } from "./MobileRemoteDesktopChrome";

export function MobileRemoteDesktopDisplaySelector(props: MobileRemoteDesktopDisplaySelectorProps) {
  const current = props.displays.find(display => display.displayId === props.selectedDisplayId);
  const trigger = <Pressable accessibilityRole="button" accessibilityLabel={props.label}
    accessibilityState={{ disabled: props.disabled || props.displays.length < 2 }} disabled={props.disabled || props.displays.length < 2}
    style={{ minHeight: 52, padding: 8, flexDirection: "row", alignItems: "center", gap: 8 }}>
    <View style={{ flex: 1 }}><Text style={{ color: props.colors.ink }}>{current?.name ?? props.label}</Text>
      {current && <Text style={{ color: props.colors.muted, fontSize: 12 }}>{current.width} × {current.height}</Text>}</View>
    {props.displays.length > 1 && <Text style={{ color: props.colors.muted }}>›</Text>}
  </Pressable>;
  if (props.disabled || props.displays.length < 2) return trigger;
  return <Host matchContents colorScheme={props.colors.dark ? "dark" : "light"} seedColor={props.colors.ink} testID="remoteDesktop.displayMenu">
    <Menu label={<RNHostView matchContents>{trigger}</RNHostView>}>
      {props.displays.map(display => <Toggle key={display.displayId} label={`${display.name} · ${display.width} × ${display.height}`}
        isOn={display.displayId === props.selectedDisplayId} onIsOnChange={() => {
          if (display.displayId !== props.selectedDisplayId) props.onSelect(display.displayId);
        }} />)}
    </Menu>
  </Host>;
}

export function MobileRemoteDesktopToolbar({ actions, landscape, colors }: MobileRemoteDesktopToolbarProps) {
  const glass = useMemo(() => { try { return isLiquidGlassAvailable(); } catch { return false; } }, []);
  const Stack = landscape ? VStack : HStack;
  return <Host colorScheme={colors.dark ? "dark" : "light"} seedColor={colors.ink} ignoreSafeArea="all" testID="remoteDesktop.toolbar"
    style={{ width: landscape ? 44 : 44 * actions.length, height: landscape ? 44 * actions.length : 44 }}>
    <Stack spacing={0} modifiers={glass
      ? [glassEffect({ glass: { variant: "clear" }, shape: "capsule" })]
      : [background(colors.surface, shapes.capsule())]}>
      {(landscape ? [...actions].reverse() : actions).map(action => <Button key={action.id} onPress={action.onPress}
        testID={`remoteDesktop.toolbar.${action.id}`} modifiers={[buttonStyle("borderless"), disabled(action.disabled === true),
          frame({ width: 44, height: 44 }), ...(action.selected ? [background(`${colors.accent}22`, shapes.circle())] : []),
          accessibilityElement("ignore"), accessibilityLabel(action.label),
          accessibilityAddTraits(action.selected ? ["isButton", "isSelected"] : ["isButton"])]}>
        <VStack modifiers={[frame({ width: 44, height: 44 }), contentShape(shapes.rectangle())]}>
          <RNHostView><View pointerEvents="none" style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>{action.icon}</View></RNHostView>
        </VStack>
      </Button>)}
    </Stack>
  </Host>;
}

export function MobileRemoteDesktopPanel(props: MobileRemoteDesktopPanelProps) {
  const content = <RNHostView><View collapsable={false} style={{ flex: 1 }} testID="remoteDesktop.panelSurface">
    {props.header}
    <ScrollView key={props.page} testID="remoteDesktop.operations" style={{ flex: 1, minHeight: 0 }}
      removeClippedSubviews={false} keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingBottom: props.landscape ? 8 : props.bottom }}>
      {props.children}
    </ScrollView>
  </View></RNHostView>;
  const onPresented = (presented: boolean): void => { if (!presented) props.onClose(); };
  if (props.landscape) {
    const preferredHeight = Math.max(44, props.height - props.top - props.bottom - 16);
    return <Host key="popover" colorScheme={props.colors.dark ? "dark" : "light"} seedColor={props.colors.ink} ignoreSafeArea="all" pointerEvents="none"
      style={{ position: "absolute", right: props.right + 12, top: props.top + Math.max(0, (props.height - props.top - props.bottom - props.toolbarLength) / 2), width: 44, height: 44 }}>
      <Popover isPresented onIsPresentedChange={onPresented} attachmentAnchor="leading" arrowEdge="trailing">
        <Popover.Trigger><Spacer modifiers={[frame({ width: 44, height: 44 })]} /></Popover.Trigger>
        <Popover.Content><Group modifiers={[frame({ width: Math.min(360, props.width - props.left - props.right - 60) }),
          frame({ minHeight: 44, idealHeight: preferredHeight, maxHeight: preferredHeight })]}>{content}</Group></Popover.Content>
      </Popover>
    </Host>;
  }
  return <Host key="sheet" colorScheme={props.colors.dark ? "dark" : "light"} seedColor={props.colors.ink} pointerEvents="none" style={{ position: "absolute" }}>
    <BottomSheet isPresented onIsPresentedChange={onPresented}>
      <Group modifiers={[presentationDetents(["medium", "large"]), presentationDragIndicator("visible")]}>{content}</Group>
    </BottomSheet>
  </Host>;
}
