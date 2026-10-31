import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { TaskTagColor, type Session, type TaskTag, type TaskTagCatalog } from "@joko/contracts";
import type { MobileClient } from "./mobile-client";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import { MobileTaskTagsNative, mobileTaskTagsNativeAvailable } from "./MobileTaskTagsNative";
import { MobileTaskTagReorderList } from "./MobileTaskTagReorderList";

export interface MobileTaskTagColors {
  readonly background: string;
  readonly surface: string;
  readonly ink: string;
  readonly muted: string;
  readonly border: string;
  readonly accent: string;
  readonly brandBackground: string;
  readonly negative: string;
  readonly dark?: boolean;
}

const COLORS: readonly TaskTagColor[] = [
  TaskTagColor.RED, TaskTagColor.ORANGE, TaskTagColor.YELLOW, TaskTagColor.GREEN,
  TaskTagColor.BLUE, TaskTagColor.PURPLE, TaskTagColor.GRAY, TaskTagColor.PINK,
  TaskTagColor.CORAL, TaskTagColor.TEAL, TaskTagColor.INDIGO, TaskTagColor.WHITE
];

const LIGHT_COLOR_VALUE: Readonly<Record<number, string>> = {
  [TaskTagColor.RED]: "#df4b4b", [TaskTagColor.ORANGE]: "#e87924", [TaskTagColor.YELLOW]: "#d7a700",
  [TaskTagColor.GREEN]: "#2f9d62", [TaskTagColor.BLUE]: "#3e7bdc", [TaskTagColor.PURPLE]: "#8a62c6",
  [TaskTagColor.GRAY]: "#9297a0", [TaskTagColor.PINK]: "#d85c99", [TaskTagColor.CORAL]: "#e36b5d",
  [TaskTagColor.TEAL]: "#269d94", [TaskTagColor.INDIGO]: "#6366c7", [TaskTagColor.WHITE]: "#ffffff"
};
const DARK_COLOR_VALUE: Readonly<Record<number, string>> = {
  [TaskTagColor.RED]: "#f06f68", [TaskTagColor.ORANGE]: "#f09a55", [TaskTagColor.YELLOW]: "#e5bd49",
  [TaskTagColor.GREEN]: "#64bc8d", [TaskTagColor.BLUE]: "#76a0ee", [TaskTagColor.PURPLE]: "#aa8bdf",
  [TaskTagColor.GRAY]: "#a9afb7", [TaskTagColor.PINK]: "#e883b4", [TaskTagColor.CORAL]: "#f18476",
  [TaskTagColor.TEAL]: "#5bbdb4", [TaskTagColor.INDIGO]: "#8d92ee", [TaskTagColor.WHITE]: "#ffffff"
};

export function mobileTaskTagColor(color: TaskTagColor, dark = false): string {
  return (dark ? DARK_COLOR_VALUE : LIGHT_COLOR_VALUE)[color] ?? LIGHT_COLOR_VALUE[TaskTagColor.GRAY]!;
}

export function MobileTaskTagQuickChoices({ tags, selected, locale, colors, disabled, onSelect }: {
  readonly tags: readonly TaskTag[]; readonly selected: readonly TaskTag[]; readonly locale: MobileSupportedLocale;
  readonly colors: { readonly ink: string; readonly border: string; readonly dark?: boolean };
  readonly disabled: boolean; readonly onSelect: (id: string) => void;
}) {
  return <View style={{ flexDirection: "row", justifyContent: "space-evenly" }}>
    {tags.slice(0, 7).map(tag => {
      const checked = selected.some(value => value.taskTagId === tag.taskTagId);
      return <Pressable key={tag.taskTagId} accessibilityRole="checkbox" accessibilityLabel={mobileTaskTagName(tag, locale)}
        accessibilityState={{ checked, disabled }} disabled={disabled} onPress={() => onSelect(tag.taskTagId)}
        style={{ minWidth: 36, minHeight: 44, alignItems: "center", justifyContent: "center" }}>
        <View style={{ width: 24, height: 24, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
          backgroundColor: mobileTaskTagColor(tag.color, colors.dark), alignItems: "center", justifyContent: "center" }}>
          <Text style={{ color: colors.ink }}>{checked ? "✓" : ""}</Text>
        </View>
      </Pressable>;
    })}
  </View>;
}

export function mobileTaskTagName(tag: TaskTag, locale: MobileSupportedLocale): string {
  if (tag.nameCustomized || tag.presetKey === undefined) return tag.name;
  switch (tag.presetKey) {
    case "red": return mobileMessage(locale, "taskTags.preset.red");
    case "orange": return mobileMessage(locale, "taskTags.preset.orange");
    case "yellow": return mobileMessage(locale, "taskTags.preset.yellow");
    case "green": return mobileMessage(locale, "taskTags.preset.green");
    case "blue": return mobileMessage(locale, "taskTags.preset.blue");
    case "purple": return mobileMessage(locale, "taskTags.preset.purple");
    case "important": return mobileMessage(locale, "taskTags.preset.important");
    case "follow-up": return mobileMessage(locale, "taskTags.preset.followUp");
    case "work": return mobileMessage(locale, "taskTags.preset.work");
    case "life": return mobileMessage(locale, "taskTags.preset.life");
    case "ideas": return mobileMessage(locale, "taskTags.preset.ideas");
    case "reference": return mobileMessage(locale, "taskTags.preset.reference");
    default: return tag.name;
  }
}

export function MobileTaskTagDots({ tags, locale, maximum = 32, dark = false }: {
  readonly tags?: readonly TaskTag[];
  readonly locale: MobileSupportedLocale;
  readonly maximum?: number;
  readonly dark?: boolean;
}) {
  if (!tags || tags.length === 0) return null;
  const visible = tags.slice(0, maximum);
  const palette = dark ? DARK_COLOR_VALUE : LIGHT_COLOR_VALUE;
  return <View accessible accessibilityLabel={tags.map((tag) => mobileTaskTagName(tag, locale)).join(", ")} style={styles.dots}>
    {visible.map((tag, index) => <View key={tag.taskTagId} style={[styles.dot, index > 0 && styles.overlappingDot, { backgroundColor: palette[tag.color] ?? palette[TaskTagColor.GRAY] }]} />)}
    {tags.length > visible.length && <Text style={styles.more}>+{tags.length - visible.length}</Text>}
  </View>;
}

export function MobileTaskTagsSheet({ visible, session, catalog, client, colors, locale, onClose }: {
  readonly visible: boolean;
  readonly session?: Session;
  readonly catalog?: TaskTagCatalog;
  readonly client: MobileClient;
  readonly colors: MobileTaskTagColors;
  readonly locale: MobileSupportedLocale;
  readonly onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [createName, setCreateName] = useState("");
  const [createColor, setCreateColor] = useState(TaskTagColor.BLUE);
  const [editingId, setEditingId] = useState<string>();
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState(TaskTagColor.BLUE);
  const [adding, setAdding] = useState(false);
  const [sorting, setSorting] = useState(false);
  const tags = catalog?.taskTags ?? [];
  const palette = colors.dark ? DARK_COLOR_VALUE : LIGHT_COLOR_VALUE;
  const editing = tags.find((tag) => tag.taskTagId === editingId);
  const attached = new Set(session?.taskTags.map((tag) => tag.taskTagId) ?? []);
  const sourceOwner = client.taskHeaderSourceKey();
  const scope = JSON.stringify([sourceOwner, client.state.activeProfileId, client.state.node?.serverId, client.state.origin,
    session?.sessionId, session?.nativeBinding?.runtimeGeneration.toString()]);
  const live = useRef({ scope, visible }); live.current = { scope, visible };
  const mounted = useRef(true), confirmationEpoch = useRef(0);
  const operation = useRef<symbol | undefined>(undefined);
  const current = () => mounted.current && live.current.visible && live.current.scope === scope && AppState.currentState === "active"
    && client.state.status === "connected" && client.state.selectedId === session?.sessionId && client.taskHeaderSourceKey() === sourceOwner;
  useEffect(() => {
    mounted.current = true;
    const listener = AppState.addEventListener("change", value => { if (value !== "active") confirmationEpoch.current++; });
    return () => { mounted.current = false; confirmationEpoch.current++; listener.remove(); };
  }, []);

  useEffect(() => {
    setBusy(false);
    setError("");
    setCreateName("");
    setCreateColor(TaskTagColor.BLUE);
    setEditingId(undefined);
    setAdding(false);
    setSorting(false);
    operation.current = undefined;
    confirmationEpoch.current++;
    return () => { operation.current = undefined; };
  }, [scope, visible]);
  useEffect(() => {
    if (!editing) return;
    setEditName(editing.name);
    setEditColor(editing.color);
  }, [editing?.taskTagId, editing?.revision?.value]);

  const run = async (action: () => Promise<boolean>, success?: () => void): Promise<void> => {
    if (operation.current || !session || !current()) return;
    const actionOwner = Symbol("task-tags-mutation"); operation.current = actionOwner;
    setBusy(true);
    setError("");
    try {
      if (!await action()) throw new Error("Task-tag operation was not confirmed.");
      if (current() && operation.current === actionOwner) success?.();
    } catch {
      if (current() && operation.current === actionOwner) setError(mobileMessage(locale, "taskTags.changeFailed"));
    } finally { if (operation.current === actionOwner) { operation.current = undefined; setBusy(false); } }
  };
  const reorder = (tagId: string, to: number, ids = tags.map(tag => tag.taskTagId), revision = catalog?.revision?.value ?? 0n): void => {
    if (!session) return;
    const from = ids.indexOf(tagId);
    if (from < 0 || to < 0 || to >= ids.length || from === to) return;
    const next = [...ids]; next.splice(from, 1); next.splice(to, 0, tagId);
    void run(() => client.reorderTaskTags(session.sessionId, next, revision));
  };
  const previewDelete = async (tag: TaskTag): Promise<void> => {
    if (operation.current || !session || !current()) return;
    const actionOwner = Symbol("task-tags-delete-preview"); operation.current = actionOwner;
    const promptEpoch = confirmationEpoch.current;
    setBusy(true);
    setError("");
    try {
      const preview = await client.previewTaskTagDeletion(tag.taskTagId);
      if (!current() || operation.current !== actionOwner || confirmationEpoch.current !== promptEpoch) return;
      const expiresAt = Date.now() + 60_000;
      let answered = false;
      Alert.alert(
        mobileMessage(locale, "taskTags.delete"),
        `${mobileMessage(locale, "taskTags.affected", { count: Number(preview.affectedSessionCount) })}\n\n${mobileMessage(locale, "taskTags.deleteBody")}`,
        [
          { text: mobileMessage(locale, "common.cancel"), style: "cancel", onPress: () => { answered = true; } },
          { text: mobileMessage(locale, "taskTags.delete"), style: "destructive", onPress: () => {
            if (answered || !current() || Date.now() >= expiresAt || confirmationEpoch.current !== promptEpoch) return;
            answered = true;
            void run(() => client.deleteTaskTag(session.sessionId, preview), () => setEditingId(undefined));
          } }
        ]
      );
    } catch {
      if (current() && operation.current === actionOwner) setError(mobileMessage(locale, "taskTags.previewFailed"));
    } finally { if (operation.current === actionOwner) { operation.current = undefined; setBusy(false); } }
  };

  if (mobileTaskTagsNativeAvailable) return <MobileTaskTagsNative key={scope} visible={visible && session !== undefined} busy={busy} error={error}
    colors={colors} locale={locale} subtitle={session?.displayName} onClose={onClose} onBack={() => { setEditingId(undefined); setAdding(false); }}
    adding={adding} revision={catalog?.revision?.value ?? 0n} onAdd={() => setAdding(true)} onMove={(from, to) => { const tag = tags[from]; if (tag) reorder(tag.taskTagId, to); }}
    items={tags.map((tag) => ({ id: tag.taskTagId, name: mobileTaskTagName(tag, locale), color: palette[tag.color] ?? palette[TaskTagColor.GRAY]!,
      attached: attached.has(tag.taskTagId), onToggle: () => { if (session) void run(() => client.setSessionTaskTag(session.sessionId, tag.taskTagId, !attached.has(tag.taskTagId))); },
      onEdit: () => setEditingId(tag.taskTagId) }))}
    palette={COLORS.map(value => ({ value, name: mobileMessage(locale, colorMessageKey(value)), hex: palette[value]! }))}
    create={{ name: createName, color: createColor, canSave: !!createName.trim() && tags.length < 256, onName: setCreateName, onColor: setCreateColor,
      onSave: () => { if (session) void run(() => client.createTaskTag(session.sessionId, createName, createColor, catalog?.revision?.value ?? 0n), () => { setCreateName(""); setCreateColor(TaskTagColor.BLUE); setAdding(false); }); } }}
    {...(editing ? { edit: { name: editName, color: editColor, canSave: !!editName.trim() && (editName.trim() !== editing.name || editColor !== editing.color),
      onName: setEditName, onColor: setEditColor, onSave: () => { if (session) void run(() => client.updateTaskTag(session.sessionId, editing.taskTagId, editing.revision?.value ?? 0n,
        { ...(editName.trim() === editing.name ? {} : { name: editName.trim() }), ...(editColor === editing.color ? {} : { color: editColor }) }), () => setEditingId(undefined)); } } } : {})}
    onDelete={() => { if (editing) void previewDelete(editing); }} />;

  const form = adding || editing !== undefined;
  return <Modal visible={visible && session !== undefined} animationType="slide" presentationStyle="pageSheet"
    onRequestClose={() => { if (!busy && !sorting) { if (form) { setAdding(false); setEditingId(undefined); } else onClose(); } }}>
    <SafeAreaView style={[styles.root, { backgroundColor: colors.background }]} edges={["top", "bottom", "left", "right"]}>
      <View style={[styles.header, { borderColor: colors.border, backgroundColor: colors.surface }]}>
        <View style={styles.fill}><Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{mobileMessage(locale, editing ? "taskTags.manage" : adding ? "taskTags.create" : "taskTags.title")}</Text>
          <Text numberOfLines={1} style={[styles.caption, { color: colors.muted }]}>{session?.displayName}</Text></View>
        <SheetButton label={mobileMessage(locale, form ? "common.back" : "common.cancel")} colors={colors} disabled={busy || sorting}
          onPress={() => { if (form) { setAdding(false); setEditingId(undefined); setError(""); } else onClose(); }} />
      </View>
      {form ? <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={[styles.create, { borderColor: colors.border, backgroundColor: colors.surface }]}>
          <Text style={[styles.label, { color: colors.ink }]}>{mobileMessage(locale, "taskTags.name")}</Text>
          <TextInput autoFocus accessibilityLabel={mobileMessage(locale, "taskTags.name")} value={editing ? editName : createName}
            maxLength={80} editable={!busy} onChangeText={editing ? setEditName : setCreateName}
            placeholder={mobileMessage(locale, "taskTags.name")} placeholderTextColor={colors.muted}
            style={[styles.input, { borderColor: colors.border, backgroundColor: colors.background, color: colors.ink }]} />
          <ColorPicker value={editing ? editColor : createColor} colors={colors} locale={locale} disabled={busy}
            onChange={editing ? setEditColor : setCreateColor} />
          {editing && <SheetButton label={mobileMessage(locale, "taskTags.delete")} destructive colors={colors} disabled={busy}
            onPress={() => void previewDelete(editing)} />}
          <SheetButton label={mobileMessage(locale, "taskTags.save")} colors={colors}
            disabled={busy || (editing ? !editName.trim() || editName.trim() === editing.name && editColor === editing.color : !createName.trim() || tags.length >= 256)}
            onPress={() => {
              if (!session) return;
              if (editing) {
                void run(() => client.updateTaskTag(session.sessionId, editing.taskTagId, editing.revision?.value ?? 0n, {
                  ...(editName.trim() === editing.name ? {} : { name: editName.trim() }), ...(editColor === editing.color ? {} : { color: editColor })
                }), () => setEditingId(undefined));
              } else {
                void run(() => client.createTaskTag(session.sessionId, createName, createColor, catalog?.revision?.value ?? 0n),
                  () => { setCreateName(""); setCreateColor(TaskTagColor.BLUE); setAdding(false); });
              }
            }} />
        </View>
      </ScrollView> : <>
        <Text style={[styles.help, { color: colors.muted, padding: 16 }]}>{mobileMessage(locale, "taskTags.help")}</Text>
        <MobileTaskTagReorderList key={scope} tags={tags} revision={catalog?.revision?.value ?? 0n} attached={attached} busy={busy}
          visible={visible} colors={colors} locale={locale} name={tag => mobileTaskTagName(tag, locale)} palette={palette}
          onToggle={tag => { if (session) void run(() => client.setSessionTaskTag(session.sessionId, tag.taskTagId, !attached.has(tag.taskTagId))); }}
          onEdit={tag => setEditingId(tag.taskTagId)} onReorder={reorder} onSortingChange={setSorting} />
        <View style={styles.content}><SheetButton label={mobileMessage(locale, "taskTags.create")} colors={colors}
          disabled={busy || sorting || tags.length >= 256} onPress={() => setAdding(true)} /></View>
      </>}
      {!!error && <Text accessibilityRole="alert" style={[styles.error, { color: colors.negative, padding: 16 }]}>{error}</Text>}
      {busy && <ActivityIndicator accessibilityLabel={mobileMessage(locale, "common.refreshing")} color={colors.accent} style={styles.busy} />}
    </SafeAreaView>
  </Modal>;
}

function ColorPicker({ value, colors, locale, disabled, onChange }: {
  readonly value: TaskTagColor;
  readonly colors: MobileTaskTagColors;
  readonly locale: MobileSupportedLocale;
  readonly disabled: boolean;
  readonly onChange: (color: TaskTagColor) => void;
}) {
  const palette = colors.dark ? DARK_COLOR_VALUE : LIGHT_COLOR_VALUE;
  return <View><Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "taskTags.color")}</Text>
    <View style={styles.palette}>
      {COLORS.map((color) => <Pressable key={color} accessibilityRole="radio" accessibilityState={{ selected: color === value, disabled }}
        accessibilityLabel={mobileMessage(locale, colorMessageKey(color))} disabled={disabled} onPress={() => onChange(color)}
        style={[styles.swatchShell, { borderColor: color === value ? colors.accent : colors.border }]}>
        <View style={[styles.swatch, { backgroundColor: palette[color] }]} />
      </Pressable>)}
    </View>
  </View>;
}

function colorMessageKey(color: TaskTagColor): "taskTags.color.red" | "taskTags.color.orange" | "taskTags.color.yellow" | "taskTags.color.green" | "taskTags.color.blue" | "taskTags.color.purple" | "taskTags.color.gray" | "taskTags.color.pink" | "taskTags.color.coral" | "taskTags.color.teal" | "taskTags.color.indigo" | "taskTags.color.white" {
  switch (color) {
    case TaskTagColor.RED: return "taskTags.color.red"; case TaskTagColor.ORANGE: return "taskTags.color.orange";
    case TaskTagColor.YELLOW: return "taskTags.color.yellow"; case TaskTagColor.GREEN: return "taskTags.color.green";
    case TaskTagColor.BLUE: return "taskTags.color.blue"; case TaskTagColor.PURPLE: return "taskTags.color.purple";
    case TaskTagColor.GRAY: return "taskTags.color.gray"; case TaskTagColor.PINK: return "taskTags.color.pink";
    case TaskTagColor.CORAL: return "taskTags.color.coral"; case TaskTagColor.TEAL: return "taskTags.color.teal";
    case TaskTagColor.INDIGO: return "taskTags.color.indigo"; default: return "taskTags.color.white";
  }
}

function SheetButton({ label, colors, disabled = false, compact = false, symbol, destructive = false, onPress }: {
  readonly label: string;
  readonly colors: MobileTaskTagColors;
  readonly disabled?: boolean;
  readonly compact?: boolean;
  readonly symbol?: string;
  readonly destructive?: boolean;
  readonly onPress: () => void;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.button, compact && styles.buttonCompact, { borderColor: colors.border, backgroundColor: colors.background }, disabled && styles.disabled, pressed && !disabled && styles.pressed]}>
    <Text numberOfLines={1} style={[compact ? styles.buttonCompactText : styles.buttonText, { color: destructive ? colors.negative : colors.ink }]}>{compact ? symbol : label}</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  root: { flex: 1 }, fill: { flex: 1, minWidth: 0 }, header: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingVertical: 8 },
  title: { fontSize: 18, lineHeight: 24, fontWeight: "700" }, caption: { fontSize: 12, lineHeight: 17 }, help: { fontSize: 13, lineHeight: 19 }, content: { padding: 16, gap: 10, paddingBottom: 32 },
  dots: { flexDirection: "row", alignItems: "center" }, dot: { width: 9, height: 9, borderRadius: 5, borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(0,0,0,.18)" }, overlappingDot: { marginLeft: -3 }, more: { fontSize: 10, color: "#777" },
  row: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 8 }, rowName: { flex: 1, minWidth: 0, fontSize: 14, fontWeight: "600" },
  check: { width: 30, height: 30, alignItems: "center", justifyContent: "center", borderWidth: 1, borderRadius: 8 }, empty: { paddingVertical: 24, textAlign: "center", fontSize: 13 },
  create: { gap: 9, borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, padding: 12, marginTop: 4 }, label: { fontSize: 14, fontWeight: "700" }, input: { minHeight: 44, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, fontSize: 15 },
  palette: { flexDirection: "row", flexWrap: "wrap", paddingVertical: 7 }, swatchShell: { width: "16.666%", height: 48, alignItems: "center", justifyContent: "center", borderWidth: 2, borderRadius: 10 }, swatch: { width: 24, height: 24, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(0,0,0,.2)" },
  button: { minHeight: 40, alignItems: "center", justifyContent: "center", borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12 }, buttonCompact: { width: 34, minHeight: 34, paddingHorizontal: 0 }, buttonText: { fontSize: 13, fontWeight: "600" }, buttonCompactText: { fontSize: 15, fontWeight: "700" },
  actions: { flexDirection: "row", alignItems: "center", gap: 8 }, dialogRoot: { flex: 1, alignItems: "center", justifyContent: "center", padding: 20, backgroundColor: "rgba(0,0,0,.46)" }, dialog: { width: "100%", maxWidth: 520, gap: 12, borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, padding: 16 },
  error: { fontSize: 12, lineHeight: 18 }, busy: { position: "absolute", top: 18, right: 100 }, disabled: { opacity: .45 }, pressed: { opacity: .68 }
});
