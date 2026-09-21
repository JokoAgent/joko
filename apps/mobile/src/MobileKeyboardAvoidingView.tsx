import { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  View,
  useWindowDimensions,
  type KeyboardAvoidingViewProps,
  type KeyboardEvent,
  type KeyboardMetrics
} from "react-native";
import { mobileKeyboardAvoidancePadding, mobileKeyboardObstructionHeight } from "./keyboard-layout";

export interface MobileKeyboardState {
  readonly height: number;
  readonly visible: boolean;
}

export function useMobileKeyboardState(): MobileKeyboardState {
  const viewport = useWindowDimensions();
  const [snapshot, setSnapshot] = useState(() => initialKeyboardSnapshot());
  const snapshotRef = useRef(snapshot);
  const reducedMotionRef = useRef(false);

  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (active) reducedMotionRef.current = value;
    }).catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (value) => {
      reducedMotionRef.current = value;
    });
    return () => { active = false; subscription.remove(); };
  }, []);

  useEffect(() => {
    let shown = snapshotRef.current.shown;
    const publish = (event: KeyboardEvent, frame: KeyboardMetrics | null): void => {
      const previous = snapshotRef.current;
      if (previous.shown === shown && sameFrame(previous.frame, frame)) return;
      const next = { shown, frame };
      snapshotRef.current = next;
      if (Platform.OS === "ios" && event.duration > 0 && !reducedMotionRef.current) {
        Keyboard.scheduleLayoutAnimation(event);
      }
      setSnapshot(next);
    };
    const show = (event: KeyboardEvent): void => { shown = true; publish(event, event.endCoordinates); };
    const hide = (event: KeyboardEvent): void => { shown = false; publish(event, null); };
    const subscriptions = [
      Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", show),
      Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", hide)
    ];
    if (Platform.OS === "ios") {
      subscriptions.push(
        Keyboard.addListener("keyboardWillChangeFrame", (event) => {
          if (shown) publish(event, event.endCoordinates);
        }),
        Keyboard.addListener("keyboardDidShow", (event) => {
          shown = true;
          publish({ ...event, duration: 0 }, event.endCoordinates);
        }),
        Keyboard.addListener("keyboardDidHide", (event) => {
          shown = false;
          publish({ ...event, duration: 0 }, null);
        }),
        Keyboard.addListener("keyboardDidChangeFrame", (event) => {
          if (shown) publish({ ...event, duration: 0 }, event.endCoordinates);
        })
      );
    }
    return () => subscriptions.forEach((subscription) => subscription.remove());
  }, []);

  const height = mobileKeyboardObstructionHeight({
    platform: Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "other",
    visible: snapshot.shown,
    frame: snapshot.frame,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height
  });
  return { height, visible: height > 0 };
}

export function MobileKeyboardAvoidingView({
  keyboard,
  consumedBottomInset = 0,
  behavior,
  keyboardVerticalOffset = 0,
  enabled = true,
  contentContainerStyle,
  style,
  ...props
}: KeyboardAvoidingViewProps & {
  readonly keyboard: MobileKeyboardState;
  readonly consumedBottomInset?: number;
}) {
  if (Platform.OS === "ios") {
    const paddingBottom = enabled && keyboard.visible
      ? mobileKeyboardAvoidancePadding(keyboard.height, consumedBottomInset, keyboardVerticalOffset)
      : 0;
    return <View {...props} style={[style, { paddingBottom }]} />;
  }
  return <KeyboardAvoidingView {...props} behavior={behavior} contentContainerStyle={contentContainerStyle}
    enabled={enabled} keyboardVerticalOffset={keyboardVerticalOffset} style={style} />;
}

function initialKeyboardSnapshot(): { shown: boolean; frame: KeyboardMetrics | null } {
  if (Platform.OS !== "ios" && Platform.OS !== "android") return { shown: false, frame: null };
  return { shown: Keyboard.isVisible(), frame: Keyboard.metrics() ?? null };
}

function sameFrame(first: KeyboardMetrics | null, second: KeyboardMetrics | null): boolean {
  return first === second || (first !== null && second !== null
    && first.screenX === second.screenX && first.screenY === second.screenY
    && first.width === second.width && first.height === second.height);
}
