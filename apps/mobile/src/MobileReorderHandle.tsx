import { useEffect, useMemo, useRef } from "react";
import { AppState, PanResponder, Text, View, type StyleProp, type ViewStyle } from "react-native";

export function MobileReorderHandle(props: {
  readonly label: string;
  readonly hint: string;
  readonly disabled: boolean;
  readonly color: string;
  readonly style: StyleProp<ViewStyle>;
  readonly holdMs: number;
  readonly onStart: (y: number) => void;
  readonly onMove: (y: number) => void;
  readonly onFinish: (commit: boolean) => void;
  readonly onStep: (delta: -1 | 1) => void;
}) {
  const latest = useRef(props);
  latest.current = props;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const started = useRef(false);
  const alive = useRef(true);
  const stop = (commit: boolean) => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
    if (started.current && alive.current) latest.current.onFinish(commit);
    started.current = false;
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current !== undefined) clearTimeout(timer.current);
    };
  }, []);
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => alive.current && !latest.current.disabled,
    onPanResponderGrant: (_event, { y0 }) => {
      stop(false);
      timer.current = setTimeout(() => {
        timer.current = undefined;
        if (alive.current && !latest.current.disabled && AppState.currentState === "active") {
          started.current = true;
          latest.current.onStart(y0);
        }
      }, latest.current.holdMs);
    },
    onPanResponderMove: (_event, state) => {
      if (started.current) latest.current.onMove(state.moveY);
      else if (Math.abs(state.dy) > 8) stop(false);
    },
    onPanResponderRelease: () => stop(true),
    onPanResponderTerminate: () => stop(false),
    onPanResponderTerminationRequest: () => !started.current
  }), []);
  return <View {...responder.panHandlers} accessible accessibilityRole="adjustable" accessibilityLabel={props.label}
    accessibilityHint={props.hint} accessibilityState={{ disabled: props.disabled }}
    accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
    onAccessibilityAction={event => {
      if (alive.current && !latest.current.disabled) latest.current.onStep(event.nativeEvent.actionName === "increment" ? 1 : -1);
    }} style={props.style}>
    <Text style={{ color: props.color }}>⠿</Text>
  </View>;
}
