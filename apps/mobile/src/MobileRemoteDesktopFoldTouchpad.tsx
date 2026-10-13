import { useEffect, useMemo, useRef } from "react";
import { StyleSheet, Text, View, type GestureResponderEvent } from "react-native";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobileRemoteDesktopColors } from "./MobileRemoteDesktopScreen";
import type { MobileRemoteDesktopTouchpadGrant } from "./remote-desktop-controller";
import { mobileRemoteDesktopCopy } from "./remote-desktop-presentation";

export interface MobileRemoteDesktopTouchpadController {
  beginTouchpad(): MobileRemoteDesktopTouchpadGrant | undefined;
  moveTouchpad(grant: MobileRemoteDesktopTouchpadGrant, dx: number, dy: number): void;
  endTouchpad(grant: MobileRemoteDesktopTouchpadGrant, tap?: boolean, cancelled?: boolean): void;
}
export interface MobileRemoteDesktopFoldTouchpadProps {
  readonly controller: MobileRemoteDesktopTouchpadController;
  readonly enabled: boolean;
  readonly colors: MobileRemoteDesktopColors;
  readonly locale: MobileSupportedLocale;
}

/** Lower-pane touch coordinates remain relative; the viewer owns the remote cursor transform. */
export function MobileRemoteDesktopFoldTouchpad({ controller, enabled, colors, locale }: MobileRemoteDesktopFoldTouchpadProps) {
  const copy = mobileRemoteDesktopCopy(locale);
  const owner = useMemo(() => ({ controller, enabled }), [controller, enabled]);
  const currentOwner = useRef<typeof owner | undefined>(owner); currentOwner.current = owner;
  const touch = useRef<{ readonly controller: MobileRemoteDesktopTouchpadController; readonly grant: MobileRemoteDesktopTouchpadGrant;
    readonly owner: typeof owner;
    readonly identifier: GestureResponderEvent["nativeEvent"]["identifier"]; x: number; y: number; distance: number; readonly time: number } | undefined>(undefined);
  useEffect(() => {
    currentOwner.current = owner;
    return () => {
      if (currentOwner.current === owner) currentOwner.current = undefined;
      const original = touch.current; touch.current = undefined;
      if (original) original.controller.endTouchpad(original.grant, false, true);
    };
  }, [owner]);
  const grant = (event: GestureResponderEvent): void => {
    if (currentOwner.current !== owner || !enabled || touch.current) return;
    const { pageX, pageY, identifier } = event.nativeEvent;
    if (!Number.isFinite(pageX) || !Number.isFinite(pageY)) return;
    const captured = controller.beginTouchpad();
    if (captured) touch.current = { controller, grant: captured, owner, identifier, x: pageX, y: pageY, distance: 0, time: Date.now() };
  };
  const move = (event: GestureResponderEvent): void => {
    const original = touch.current, { pageX, pageY, identifier } = event.nativeEvent;
    if (currentOwner.current !== owner || !original || original.owner !== owner || !enabled || original.identifier !== identifier || !Number.isFinite(pageX) || !Number.isFinite(pageY)) return;
    const dx = pageX - original.x, dy = pageY - original.y;
    original.x = pageX; original.y = pageY; original.distance += Math.abs(dx) + Math.abs(dy);
    original.controller.moveTouchpad(original.grant, dx, dy);
  };
  const end = (event: GestureResponderEvent, cancelled: boolean): void => {
    const original = touch.current;
    if (currentOwner.current !== owner || !original || original.owner !== owner || original.identifier !== event.nativeEvent.identifier) return;
    touch.current = undefined;
    original.controller.endTouchpad(original.grant,
      enabled && !cancelled && original.distance < 8 && Date.now() - original.time < 400, cancelled);
  };
  return <View testID="remoteDesktop.foldTouchpad" accessible
    accessibilityLabel={copy.pointer} accessibilityHint={copy.pointerHint} accessibilityState={{ disabled: !enabled }}
    onStartShouldSetResponder={() => enabled} onResponderGrant={grant} onResponderMove={move}
    onResponderRelease={event => end(event, false)} onResponderTerminate={event => end(event, true)}
    style={[styles.pad, { borderColor: colors.border, backgroundColor: colors.surface }]}>
    <Text style={{ color: colors.muted }}>{copy.pointer}</Text>
  </View>;
}

const styles = StyleSheet.create({ pad: { flex: 1, minHeight: 44, margin: 8,
  overflow: "hidden", borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, alignItems: "center", justifyContent: "center" } });
