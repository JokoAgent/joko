import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
  const tags = catalog?.taskTags ?? [];
  const palette = colors.dark ? DARK_COLOR_VALUE : LIGHT_COLOR_VALUE;
  const editing = tags.find((tag) => tag.taskTagId === editingId);
  const attached = new Set(session?.taskTags.map((tag) => tag.taskTagId) ?? []);

  useEffect(() => {
    setBusy(false);
    setError("");
    setCreateName("");
    setCreateColor(TaskTagColor.BLUE);
    setEditingId(undefined);
  }, [session?.sessionId, visible]);
  useEffect(() => {
    if (!editing) return;
    setEditName(editing.name);
    setEditColor(editing.color);
  }, [editing?.taskTagId, editing?.revision?.value]);

  const run = async (action: () => Promise<boolean>, success?: () => void): Promise<void> => {
    if (busy || !session) return;
    setBusy(true);
    setError("");
    try {
      if (!await action()) throw new Error("Task-tag operation was not confirmed.");
      success?.();
    } catch {
      setError(mobileMessage(locale, "taskTags.changeFailed"));
    } finally { setBusy(false); }
  };
  const reorder = (tagId: string, direction: -1 | 1): void => {
    if (!session) return;
    const index = tags.findIndex((tag) => tag.taskTagId === tagId);
    const other = index + direction;
    if (index < 0 || other < 0 || other >= tags.length) return;
    const ids = tags.map((tag) => tag.taskTagId);
    [ids[index], ids[other]] = [ids[other] as string, ids[index] as string];
    void run(() => client.reorderTaskTags(session.sessionId, ids, catalog?.revision?.value ?? 0n));
  };
  const previewDelete = async (tag: TaskTag): Promise<void> => {
    if (busy || !session) return;
    setBusy(true);
    setError("");
    try {
      const preview = await client.previewTaskTagDeletion(tag.taskTagId);
      Alert.alert(
        mobileMessage(locale, "taskTags.delete"),
        `${mobileMessage(locale, "taskTags.affected", { count: Number(preview.affectedSessionCount) })}\n\n${mobileMessage(locale, "taskTags.deleteBody")}`,
        [
          { text: mobileMessage(locale, "common.cancel"), style: "cancel" },
          { text: mobileMessage(locale, "taskTags.delete"), style: "destructive", onPress: () => {
            void run(() => client.deleteTaskTag(session.sessionId, preview), () => setEditingId(undefined));
          } }
        ]
      );
    } catch {
      setError(mobileMessage(locale, "taskTags.previewFailed"));
    } finally { setBusy(false); }
  };

  return <>
    <Modal visible={visible && session !== undefined} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => { if (!busy) onClose(); }}>
      <SafeAreaView style={[styles.root, { backgroundColor: colors.background }]} edges={["top", "bottom", "left", "right"]}>
        <View style={[styles.header, { borderColor: colors.border, backgroundColor: colors.surface }]}>
          <View style={styles.fill}><Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{mobileMessage(locale, "taskTags.title")}</Text>
            <Text numberOfLines={1} style={[styles.caption, { color: colors.muted }]}>{session?.displayName}</Text></View>
          <SheetButton label={mobileMessage(locale, "common.cancel")} colors={colors} disabled={busy} onPress={onClose} />
        </View>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={[styles.help, { color: colors.muted }]}>{mobileMessage(locale, "taskTags.help")}</Text>
          {tags.map((tag, index) => {
            const isAttached = attached.has(tag.taskTagId);
            return <View key={tag.taskTagId} style={[styles.row, { borderColor: colors.border, backgroundColor: colors.surface }]}>
              <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: isAttached, disabled: busy }} disabled={busy}
                accessibilityLabel={`${isAttached ? mobileMessage(locale, "taskTags.detach") : mobileMessage(locale, "taskTags.attach")} ${mobileTaskTagName(tag, locale)}`}
                onPress={() => session && void run(() => client.setSessionTaskTag(session.sessionId, tag.taskTagId, !isAttached))}
                style={[styles.check, { borderColor: isAttached ? colors.accent : colors.border, backgroundColor: isAttached ? colors.brandBackground : colors.background }]}>
                <Text style={{ color: colors.ink }}>{isAttached ? "✓" : ""}</Text>
              </Pressable>
              <View style={[styles.dot, { backgroundColor: palette[tag.color] ?? palette[TaskTagColor.GRAY] }]} />
              <Text numberOfLines={1} style={[styles.rowName, { color: colors.ink }]}>{mobileTaskTagName(tag, locale)}</Text>
              <SheetButton compact symbol="↑" label={mobileMessage(locale, "taskTags.moveUp")} colors={colors} disabled={busy || index === 0} onPress={() => reorder(tag.taskTagId, -1)} />
              <SheetButton compact symbol="↓" label={mobileMessage(locale, "taskTags.moveDown")} colors={colors} disabled={busy || index === tags.length - 1} onPress={() => reorder(tag.taskTagId, 1)} />
              <SheetButton compact symbol="•••" label={mobileMessage(locale, "taskTags.manage")} colors={colors} disabled={busy} onPress={() => setEditingId(tag.taskTagId)} />
            </View>;
          })}
          {tags.length === 0 && <Text style={[styles.empty, { color: colors.muted }]}>{mobileMessage(locale, "taskTags.empty")}</Text>}
          <View style={[styles.create, { borderColor: colors.border, backgroundColor: colors.surface }]}>
            <Text style={[styles.label, { color: colors.ink }]}>{mobileMessage(locale, "taskTags.create")}</Text>
            <TextInput accessibilityLabel={mobileMessage(locale, "taskTags.name")} value={createName} maxLength={80} editable={!busy && tags.length < 256}
              onChangeText={setCreateName} placeholder={mobileMessage(locale, "taskTags.name")} placeholderTextColor={colors.muted}
              style={[styles.input, { borderColor: colors.border, backgroundColor: colors.background, color: colors.ink }]} />
            <ColorPicker value={createColor} colors={colors} locale={locale} disabled={busy || tags.length >= 256} onChange={setCreateColor} />
            <SheetButton label={mobileMessage(locale, "taskTags.create")} colors={colors} disabled={busy || !createName.trim() || tags.length >= 256} onPress={() => {
              if (!session) return;
              void run(() => client.createTaskTag(session.sessionId, createName, createColor, catalog?.revision?.value ?? 0n), () => {
                setCreateName(""); setCreateColor(TaskTagColor.BLUE);
              });
            }} />
          </View>
          {tags.length >= 256 && <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "taskTags.catalogLimit")}</Text>}
          {error !== "" && <Text accessibilityRole="alert" style={[styles.error, { color: colors.negative }]}>{error}</Text>}
        </ScrollView>
        {busy && <ActivityIndicator accessibilityLabel={mobileMessage(locale, "common.refreshing")} color={colors.accent} style={styles.busy} />}
      </SafeAreaView>
    </Modal>
    <Modal visible={visible && editing !== undefined} transparent animationType="fade" onRequestClose={() => { if (!busy) setEditingId(undefined); }}>
      <View style={styles.dialogRoot}>
        <View style={[styles.dialog, { borderColor: colors.border, backgroundColor: colors.surface }]}>
          <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{mobileMessage(locale, "taskTags.manage")}</Text>
          <TextInput accessibilityLabel={mobileMessage(locale, "taskTags.name")} value={editName} maxLength={80} editable={!busy} onChangeText={setEditName}
            style={[styles.input, { borderColor: colors.border, backgroundColor: colors.background, color: colors.ink }]} />
          <ColorPicker value={editColor} colors={colors} locale={locale} disabled={busy} onChange={setEditColor} />
          {error !== "" && <Text accessibilityRole="alert" style={[styles.error, { color: colors.negative }]}>{error}</Text>}
          <View style={styles.actions}>
            <SheetButton label={mobileMessage(locale, "taskTags.delete")} destructive colors={colors} disabled={busy} onPress={() => { if (editing) void previewDelete(editing); }} />
            <View style={styles.fill} />
            <SheetButton label={mobileMessage(locale, "common.cancel")} colors={colors} disabled={busy} onPress={() => setEditingId(undefined)} />
            <SheetButton label={mobileMessage(locale, "taskTags.save")} colors={colors} disabled={busy || !editName.trim() || editing === undefined || editName.trim() === editing.name && editColor === editing.color} onPress={() => {
              if (!session || !editing) return;
              const name = editName.trim();
              void run(() => client.updateTaskTag(session.sessionId, editing.taskTagId, editing.revision?.value ?? 0n, {
                ...(name === editing.name ? {} : { name }), ...(editColor === editing.color ? {} : { color: editColor })
              }), () => setEditingId(undefined));
            }} />
          </View>
        </View>
      </View>
    </Modal>
  </>;
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
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.palette}>
      {COLORS.map((color) => <Pressable key={color} accessibilityRole="radio" accessibilityState={{ selected: color === value, disabled }}
        accessibilityLabel={mobileMessage(locale, colorMessageKey(color))} disabled={disabled} onPress={() => onChange(color)}
        style={[styles.swatchShell, { borderColor: color === value ? colors.accent : colors.border }]}>
        <View style={[styles.swatch, { backgroundColor: palette[color] }]} />
      </Pressable>)}
    </ScrollView>
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
  palette: { gap: 8, paddingVertical: 7 }, swatchShell: { width: 34, height: 34, alignItems: "center", justifyContent: "center", borderWidth: 2, borderRadius: 17 }, swatch: { width: 22, height: 22, borderRadius: 11, borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(0,0,0,.2)" },
  button: { minHeight: 40, alignItems: "center", justifyContent: "center", borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12 }, buttonCompact: { width: 34, minHeight: 34, paddingHorizontal: 0 }, buttonText: { fontSize: 13, fontWeight: "600" }, buttonCompactText: { fontSize: 15, fontWeight: "700" },
  actions: { flexDirection: "row", alignItems: "center", gap: 8 }, dialogRoot: { flex: 1, alignItems: "center", justifyContent: "center", padding: 20, backgroundColor: "rgba(0,0,0,.46)" }, dialog: { width: "100%", maxWidth: 520, gap: 12, borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, padding: 16 },
  error: { fontSize: 12, lineHeight: 18 }, busy: { position: "absolute", top: 18, right: 100 }, disabled: { opacity: .45 }, pressed: { opacity: .68 }
});
