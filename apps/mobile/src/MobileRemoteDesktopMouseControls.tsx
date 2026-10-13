import { useEffect, useRef, useState } from "react";
import { Platform, StyleSheet, View, type GestureResponderEvent } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobileRemoteDesktopColors } from "./MobileRemoteDesktopScreen";
import type { MobileRemoteDesktopMouseControl, MobileRemoteDesktopMouseGrant } from "./remote-desktop-controller";
import { mobileRemoteDesktopCopy } from "./remote-desktop-presentation";

export interface MobileRemoteDesktopMouseController {
  beginMouseControl(control: MobileRemoteDesktopMouseControl, y?: number): MobileRemoteDesktopMouseGrant | undefined;
  moveMouseControl(grant: MobileRemoteDesktopMouseGrant, y: number): void;
  endMouseControl(grant: MobileRemoteDesktopMouseGrant, cancelled?: boolean): void;
  clickMouseControl(control: MobileRemoteDesktopMouseControl): void;
}
export interface MobileRemoteDesktopMouseControlsProps {
  readonly controller: MobileRemoteDesktopMouseController;
  readonly colors: MobileRemoteDesktopColors;
  readonly locale: MobileSupportedLocale;
  readonly bottom?: number;
  readonly right?: number;
  readonly compact?: boolean;
}

function IOSMouseControls(props: MobileRemoteDesktopMouseControlsProps) {
  return <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, { bottom: props.bottom ?? 0, right: props.right ?? 0 }]}>
    {(["left", "right", "wheel"] as const).map(control => <MouseControl key={control} {...props} control={control} />)}
  </View>;
}
export const MobileRemoteDesktopMouseControls = Platform.OS === "ios" ? IOSMouseControls : null;

function MouseControl({ control, controller, colors, locale, compact = false }:
MobileRemoteDesktopMouseControlsProps & { readonly control: MobileRemoteDesktopMouseControl }) {
  const copy = mobileRemoteDesktopCopy(locale), wheel = control === "wheel";
  const [pressed, setPressed] = useState(false);
  const captured = useRef<{ controller: MobileRemoteDesktopMouseController; grant: MobileRemoteDesktopMouseGrant;
    identifier: GestureResponderEvent["nativeEvent"]["identifier"] } | undefined>(undefined);
  useEffect(() => {
    setPressed(false);
    return () => {
      const original = captured.current; captured.current = undefined;
      if (original) original.controller.endMouseControl(original.grant, true);
    };
  }, [controller, control]);
  const end = (event: GestureResponderEvent, cancelled: boolean) => {
    const original = captured.current;
    if (!original || original.identifier !== event.nativeEvent.identifier) return;
    captured.current = undefined; setPressed(false);
    if (original) original.controller.endMouseControl(original.grant, cancelled);
  };
  const down = (event: GestureResponderEvent) => {
    if (captured.current) return;
    const grant = controller.beginMouseControl(control, event.nativeEvent.pageY);
    if (grant) { captured.current = { controller, grant, identifier: event.nativeEvent.identifier }; setPressed(true); }
  };
  const move = (event: GestureResponderEvent) => {
    const original = captured.current;
    if (original && original.identifier === event.nativeEvent.identifier) original.controller.moveMouseControl(original.grant, event.nativeEvent.pageY);
  };
  const foreground = pressed ? colors.surface : colors.ink;
  return <View accessibilityRole="button"
    accessibilityLabel={control === "left" ? copy.leftMouseButton : control === "right" ? copy.rightMouseButton : copy.mouseWheel}
    accessibilityState={{ selected: pressed }} accessibilityActions={[{ name: "activate" }]}
    onAccessibilityAction={event => { if (event.nativeEvent.actionName === "activate") controller.clickMouseControl(control); }}
    onTouchStart={down} onTouchMove={move} onTouchEnd={event => end(event, false)} onTouchCancel={event => end(event, true)}
    style={[styles.control, wheel ? { right: 12, bottom: compact ? 12 : 80, height: 120 }
      : { left: "50%", marginLeft: control === "left" ? -96 : 40, bottom: 16 }]}
    testID={`remoteDesktop.mouse-${control}`}>
    <View pointerEvents="none" style={[styles.surface, { borderColor: colors.border, backgroundColor: pressed ? colors.ink : colors.surface }]}>
      <Svg width={28} height={wheel ? 96 : 32} viewBox={wheel ? "0 0 24 96" : "0 0 24 32"} fill="none" stroke={foreground} strokeWidth={2}>
        {wheel ? <>
          <Path d="M10 10l2-3 2 3M10 86l2 3 2-3" />
          <Rect x={3} y={31} width={18} height={34} rx={8} />
          <Path d="M5 41h14M4 48h16M5 55h14" />
        </> : <>
          <Rect x={3} y={2} width={18} height={28} rx={9} />
          <Path d="M12 2v12M3 14h18" />
          <Path d={control === "left" ? "M11 3C6 3 4 6 4 10v3h7Z" : "M13 3c5 0 7 3 7 7v3h-7Z"} fill={foreground} stroke="none" />
        </>}
      </Svg>
    </View>
  </View>;
}
const styles = StyleSheet.create({
  control: { position: "absolute", width: 56, height: 56 },
  surface: { flex: 1, borderRadius: 28, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden", alignItems: "center", justifyContent: "center" }
});
