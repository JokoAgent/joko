import { useEffect, useMemo, useRef, useState } from "react";
import { AppState, PanResponder, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { TaskTag } from "@joko/contracts";
import type { MobileTaskTagColors } from "./MobileTaskTags";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";

export function MobileTaskTagReorderList(props: {
  readonly tags: readonly TaskTag[]; readonly revision: bigint; readonly attached: ReadonlySet<string>;
  readonly busy: boolean; readonly visible: boolean; readonly colors: MobileTaskTagColors; readonly locale: MobileSupportedLocale;
  readonly palette: Readonly<Record<number, string>>; readonly name: (tag: TaskTag) => string;
  readonly onToggle: (tag: TaskTag) => void; readonly onEdit: (tag: TaskTag) => void;
  readonly onReorder: (id: string, to: number, ids: string[], revision: bigint) => void;
  readonly onSortingChange: (sorting: boolean) => void;
}) {
  const latest = useRef(props); latest.current = props;
  const scroll = useRef<ScrollView>(null);
  const viewport = useRef({ top: 0, height: 0, offset: 0, contentHeight: 0 });
  const rows = useRef(new Map<string, { y: number; height: number }>());
  const active = useRef<{ id: string; y: number; to: number; ids: string[]; revision: bigint } | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);
  const [dragging, setDragging] = useState<{ id: string; to: number }>();
  const cancel = () => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined; active.current = undefined; setDragging(undefined); latest.current.onSortingChange(false);
  };
  useEffect(() => { cancel(); }, [props.revision, props.visible, props.busy]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", state => { if (state !== "active") cancel(); });
    return () => { subscription.remove(); if (frame.current !== undefined) cancelAnimationFrame(frame.current); active.current = undefined; latest.current.onSortingChange(false); };
  }, []);
  const track = () => {
    const drag = active.current;
    if (!drag) return;
    if (!latest.current.visible || latest.current.busy || drag.revision !== latest.current.revision) { cancel(); return; }
    const view = viewport.current;
    const delta = drag.y < view.top + 44 ? -8 : drag.y > view.top + view.height - 44 ? 8 : 0;
    if (delta) {
      view.offset = Math.max(0, Math.min(view.contentHeight - view.height, view.offset + delta));
      scroll.current?.scrollTo({ y: view.offset, animated: false });
    }
    const position = drag.y - view.top + view.offset;
    let to = 0;
    drag.ids.forEach((id, index) => {
      const row = rows.current.get(id);
      if (row && position >= row.y + row.height / 2) to = index;
    });
    drag.to = to; setDragging({ id: drag.id, to });
    frame.current = requestAnimationFrame(track);
  };
  const start = (id: string, y: number) => {
    if (latest.current.busy || !latest.current.visible || AppState.currentState !== "active") return;
    const ids = latest.current.tags.map(tag => tag.taskTagId);
    active.current = { id, y, ids, revision: latest.current.revision, to: ids.indexOf(id) };
    setDragging({ id, to: ids.indexOf(id) });
    latest.current.onSortingChange(true);
    scroll.current?.getNativeScrollRef()?.measureInWindow((_x, top, _width, height) => { if (active.current?.id === id) Object.assign(viewport.current, { top, height }); });
    frame.current = requestAnimationFrame(track);
  };
  const finish = (commit: boolean) => {
    const drag = active.current; cancel();
    if (commit && drag && latest.current.visible && !latest.current.busy && AppState.currentState === "active"
      && drag.revision === latest.current.revision) latest.current.onReorder(drag.id, drag.to, drag.ids, drag.revision);
  };
  const locked = props.busy || dragging !== undefined;
  return <ScrollView ref={scroll} style={styles.fill} contentContainerStyle={styles.content} scrollEnabled={dragging === undefined}
    onScroll={event => { viewport.current.offset = event.nativeEvent.contentOffset.y; }} scrollEventThrottle={16}
    onContentSizeChange={(_width, height) => { viewport.current.contentHeight = height; }} keyboardShouldPersistTaps="handled">
    {props.tags.map((tag, index) => <View key={tag.taskTagId} onLayout={event => { rows.current.set(tag.taskTagId, event.nativeEvent.layout); }}
      style={[styles.row, { borderColor: dragging?.to === index ? props.colors.accent : props.colors.border, backgroundColor: props.colors.surface },
        dragging?.id === tag.taskTagId && styles.dragging]}>
      <TagDragHandle label={mobileMessage(props.locale, "taskTags.reorderLabel", { name: props.name(tag) })}
        hint={mobileMessage(props.locale, "taskTags.reorderHint")} disabled={props.busy || props.tags.length < 2}
        color={props.colors.muted} onStart={y => start(tag.taskTagId, y)}
        onMove={y => { if (active.current?.id === tag.taskTagId) active.current.y = y; }} onFinish={finish}
        onStep={delta => { if (!locked) props.onReorder(tag.taskTagId, index + delta, props.tags.map(tag => tag.taskTagId), props.revision); }} />
      <Pressable accessibilityRole="checkbox" accessibilityLabel={props.name(tag)} accessibilityState={{ checked: props.attached.has(tag.taskTagId), disabled: locked }}
        disabled={locked} onPress={() => props.onToggle(tag)} style={styles.label}>
        <View style={[styles.swatch, { backgroundColor: props.palette[tag.color], borderColor: props.colors.border }]}>
          <Text style={{ color: props.colors.ink }}>{props.attached.has(tag.taskTagId) ? "✓" : ""}</Text>
        </View>
        <Text numberOfLines={1} style={[styles.name, { color: props.colors.ink }]}>{props.name(tag)}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(props.locale, "taskTags.manage") + " " + props.name(tag)}
        accessibilityState={{ disabled: locked }} disabled={locked} onPress={() => props.onEdit(tag)} style={styles.handle}>
        <Text style={{ color: props.colors.ink }}>•••</Text>
      </Pressable>
    </View>)}
    {!props.tags.length && <Text style={{ color: props.colors.muted }}>{mobileMessage(props.locale, "taskTags.empty")}</Text>}
  </ScrollView>;
}

function TagDragHandle(props: { readonly label: string; readonly hint: string; readonly disabled: boolean; readonly color: string;
  readonly onStart: (y: number) => void; readonly onMove: (y: number) => void; readonly onFinish: (commit: boolean) => void; readonly onStep: (delta: -1 | 1) => void }) {
  const latest = useRef(props); latest.current = props;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const started = useRef(false);
  const alive = useRef(true);
  const stop = (commit: boolean) => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
    if (started.current && alive.current) latest.current.onFinish(commit);
    started.current = false;
  };
  useEffect(() => { alive.current = true; return () => { alive.current = false; if (timer.current !== undefined) clearTimeout(timer.current); }; }, []);
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => alive.current && !latest.current.disabled,
    onPanResponderGrant: (_event, state) => {
      stop(false);
      timer.current = setTimeout(() => {
        timer.current = undefined;
        if (alive.current && !latest.current.disabled && AppState.currentState === "active") { started.current = true; latest.current.onStart(state.y0); }
      }, 250);
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
    onAccessibilityAction={event => { if (alive.current && !latest.current.disabled) latest.current.onStep(event.nativeEvent.actionName === "increment" ? 1 : -1); }}
    style={styles.handle}><Text style={{ color: props.color }}>⠿</Text></View>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 }, content: { paddingHorizontal: 16, gap: 10, paddingBottom: 16 },
  row: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderRadius: 12, paddingHorizontal: 4 },
  label: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 10, minHeight: 48 },
  name: { flex: 1, minWidth: 0, fontSize: 14 }, handle: { minWidth: 44, minHeight: 48, alignItems: "center", justifyContent: "center" },
  swatch: { width: 24, height: 24, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" },
  dragging: { opacity: .6 }
});
