import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { MobileKeyboardAvoidingView, useMobileKeyboardState } from "./MobileKeyboardAvoidingView";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import type {
  MobileNativeTreeControls,
  MobileNativeTreeRow,
  MobileNativeTreeSnapshot
} from "./mobile-native-tree";

type NavigationOutcome = "navigated" | "rejected" | "unknown";

export function MobileNativeTreeSheet({
  visible,
  controls,
  busy,
  colors,
  onClose,
  onLoad,
  onNavigate,
  onError
}: {
  readonly visible: boolean;
  readonly controls?: MobileNativeTreeControls;
  readonly busy: boolean;
  readonly colors: MobileInteractionSheetColors;
  readonly onClose: () => void;
  readonly onLoad: (authorityKey: string) => Promise<MobileNativeTreeSnapshot>;
  readonly onNavigate: (
    authorityKey: string,
    tree: MobileNativeTreeSnapshot,
    entryId: string,
    summarize: boolean,
    customInstructions: string
  ) => Promise<NavigationOutcome>;
  readonly onError: (message: string) => void;
}) {
  const [tree, setTree] = useState<MobileNativeTreeSnapshot>();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [navigatingId, setNavigatingId] = useState<string>();
  const [summarize, setSummarize] = useState(false);
  const [customInstructions, setCustomInstructions] = useState("");
  const [feedback, setFeedback] = useState<string>();
  const mountedRef = useRef(true);
  const visibleRef = useRef(visible);
  const onLoadRef = useRef(onLoad);
  const authorityRef = useRef(controls?.authorityKey);
  const surfaceOwnerRef = useRef(controls?.surfaceOwnerKey);
  const requestRef = useRef(0);
  const keyboard = useMobileKeyboardState();
  const safeArea = useSafeAreaInsets();
  visibleRef.current = visible;
  onLoadRef.current = onLoad;
  authorityRef.current = controls?.authorityKey;
  surfaceOwnerRef.current = controls?.surfaceOwnerKey;
  const navigating = navigatingId !== undefined;
  const disabled = busy || navigating;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    requestRef.current += 1;
    setTree(undefined);
    setLoading(false);
    setLoadError(undefined);
    setNavigatingId(undefined);
    setSummarize(false);
    setCustomInstructions("");
    setFeedback(undefined);
  }, [controls?.surfaceOwnerKey, visible]);

  const load = (): void => {
    if (!visible || !controls || loading || navigating) return;
    const authorityKey = controls.authorityKey;
    const surfaceOwnerKey = controls.surfaceOwnerKey;
    const request = requestRef.current + 1;
    requestRef.current = request;
    setLoading(true);
    setTree(undefined);
    setLoadError(undefined);
    onError("");
    void onLoadRef.current(authorityKey).then((next) => {
      if (!mountedRef.current || !visibleRef.current || requestRef.current !== request
        || authorityRef.current !== authorityKey || surfaceOwnerRef.current !== surfaceOwnerKey) return;
      setTree(next);
    }).catch((error) => {
      if (!mountedRef.current || !visibleRef.current || requestRef.current !== request
        || authorityRef.current !== authorityKey || surfaceOwnerRef.current !== surfaceOwnerKey) return;
      setLoadError(errorText(error));
    }).finally(() => {
      if (mountedRef.current && requestRef.current === request) setLoading(false);
    });
  };

  useEffect(() => {
    if (!visible || !controls) return;
    const authorityKey = controls.authorityKey;
    const surfaceOwnerKey = controls.surfaceOwnerKey;
    const request = requestRef.current + 1;
    requestRef.current = request;
    setLoading(true);
    setTree(undefined);
    setLoadError(undefined);
    void onLoadRef.current(authorityKey).then((next) => {
      if (!mountedRef.current || !visibleRef.current || requestRef.current !== request
        || authorityRef.current !== authorityKey || surfaceOwnerRef.current !== surfaceOwnerKey) return;
      setTree(next);
    }).catch((error) => {
      if (!mountedRef.current || !visibleRef.current || requestRef.current !== request
        || authorityRef.current !== authorityKey || surfaceOwnerRef.current !== surfaceOwnerKey) return;
      setLoadError(errorText(error));
    }).finally(() => {
      if (mountedRef.current && requestRef.current === request) setLoading(false);
    });
  }, [controls?.authorityKey, controls?.surfaceOwnerKey, visible]);

  if (!controls) return null;

  const navigate = async (row: MobileNativeTreeRow): Promise<void> => {
    const currentTree = tree;
    if (!currentTree || disabled || loading || row.active || !controls.canNavigate) return;
    const authorityKey = controls.authorityKey;
    const surfaceOwnerKey = controls.surfaceOwnerKey;
    setNavigatingId(row.entryId);
    setFeedback(undefined);
    onError("");
    try {
      const outcome = await onNavigate(
        authorityKey,
        currentTree,
        row.entryId,
        summarize,
        customInstructions
      );
      if (!mountedRef.current || !visibleRef.current || surfaceOwnerRef.current !== surfaceOwnerKey) return;
      setFeedback(outcome === "navigated"
        ? "Branch changed. The current task has been refreshed."
        : outcome === "rejected"
          ? "The Backend rejected this branch change. The displayed tree was kept."
          : "The branch result is not yet confirmed. Check operation status before retrying.");
    } catch (error) {
      if (mountedRef.current && visibleRef.current && surfaceOwnerRef.current === surfaceOwnerKey) {
        onError(errorText(error));
      }
    } finally {
      if (mountedRef.current) setNavigatingId(undefined);
    }
  };

  const close = (): void => {
    if (!navigating) onClose();
  };

  return <Modal visible={visible} transparent animationType="slide" statusBarTranslucent onRequestClose={close}>
    <MobileKeyboardAvoidingView keyboard={keyboard} consumedBottomInset={safeArea.bottom}
      behavior={Platform.OS === "android" ? "height" : undefined} style={styles.modalRoot}>
      <Pressable accessibilityRole="button" accessibilityLabel="Close task branches"
        disabled={navigating} onPress={close} style={styles.backdrop} />
      <SafeAreaView accessibilityViewIsModal edges={["bottom", "left", "right"]}
        style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={[styles.eyebrow, { color: colors.muted }]} numberOfLines={1}>
              {controls.backend.displayName || controls.backend.backendId}
            </Text>
            <Text style={[styles.title, { color: colors.ink }]}>Branches</Text>
          </View>
          <IconButton label="Refresh task branches" text="↻" disabled={loading || disabled}
            colors={colors} onPress={load} />
          <IconButton label="Close task branches" text="×" disabled={navigating}
            colors={colors} onPress={close} />
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <View style={[styles.notice, { borderColor: colors.border, backgroundColor: colors.background }]}>
            <Text style={[styles.noticeTitle, { color: colors.ink }]}>Changes native conversation context</Text>
            <Text style={[styles.body, { color: colors.muted }]}>Choosing an earlier entry changes the active Backend branch. Joko messages and workspace files are not rewound or deleted.</Text>
          </View>

          <View style={[styles.summaryCard, { borderColor: colors.border }]}>
            <View style={styles.settingRow}>
              <View style={styles.flex}>
                <Text style={[styles.rowLabel, { color: colors.ink }]}>Summarize abandoned context</Text>
                <Text style={[styles.caption, { color: colors.muted }]}>Off by default. Enable only when you want the Backend to carry a summary into the selected branch.</Text>
              </View>
              <Switch accessibilityLabel="Summarize abandoned branch context"
                accessibilityState={{ disabled }} disabled={disabled}
                value={summarize} onValueChange={setSummarize}
                trackColor={{ false: colors.border, true: colors.accent }} />
            </View>
            {summarize && <TextInput accessibilityLabel="Branch summary focus" multiline maxLength={4000}
              editable={!disabled} value={customInstructions} onChangeText={setCustomInstructions}
              placeholder="Optional focus for the summary" placeholderTextColor={colors.muted}
              style={[styles.instructions, { color: colors.ink, borderColor: colors.border, backgroundColor: colors.background }]} />}
          </View>

          {controls.navigationUnavailableReason && <Text accessibilityRole="alert"
            style={[styles.warning, { color: colors.muted }]}>{controls.navigationUnavailableReason}</Text>}
          {feedback && <Text accessibilityRole="alert" style={[styles.feedback, { color: colors.accent }]}>{feedback}</Text>}
          {loadError && <Pressable accessibilityRole="button" accessibilityLabel="Retry loading task branches"
            disabled={loading || disabled} onPress={load}
            style={[styles.errorCard, { borderColor: colors.negative, backgroundColor: colors.background }]}>
            <Text style={[styles.body, { color: colors.negative }]}>{loadError}</Text>
            <Text style={[styles.retry, { color: colors.accent }]}>Retry</Text>
          </Pressable>}
          {loading && <View accessibilityLabel="Loading task branches" style={styles.loading}>
            <ActivityIndicator color={colors.muted} />
          </View>}
          {!loading && !loadError && tree?.rows.length === 0 && <Text style={[styles.empty, { color: colors.muted }]}>No native branch entries are available.</Text>}
          {!loading && tree && tree.rows.length > 0 && <View style={styles.tree}>
            {tree.rows.map((row) => <TreeRow key={row.entryId} row={row}
              disabled={disabled || !controls.canNavigate} navigating={navigatingId === row.entryId}
              colors={colors} onPress={() => void navigate(row)} />)}
          </View>}
        </ScrollView>
      </SafeAreaView>
    </MobileKeyboardAvoidingView>
  </Modal>;
}

function TreeRow({ row, disabled, navigating, colors, onPress }: {
  readonly row: MobileNativeTreeRow;
  readonly disabled: boolean;
  readonly navigating: boolean;
  readonly colors: MobileInteractionSheetColors;
  readonly onPress: () => void;
}) {
  const label = `${roleLabel(row)}${row.active ? " · Current" : ""}`;
  const indent = 12 + Math.min(row.branchDepth, 8) * 14;
  return <Pressable accessibilityRole="button" accessibilityLabel={`${label}. ${row.label}`}
    accessibilityHint={row.active ? "This is the current native entry" : "Change the active Backend branch to this entry"}
    accessibilityState={{ disabled: disabled || row.active, selected: row.active }}
    disabled={disabled || row.active} onPress={onPress}
    style={({ pressed }) => [styles.node, { paddingLeft: indent, borderColor: row.activePath ? colors.accent : colors.border,
      backgroundColor: row.activePath ? colors.background : colors.surface }, pressed && styles.pressed,
      (disabled || row.active) && styles.disabled]}>
    <View style={[styles.nodeIcon, { borderColor: row.activePath ? colors.accent : colors.border }]}>
      {navigating ? <ActivityIndicator size="small" color={colors.ink} />
        : <Text style={[styles.nodeGlyph, { color: row.activePath ? colors.accent : colors.muted }]}>
          {row.active ? "✓" : row.branching ? "⑂" : "•"}
        </Text>}
    </View>
    <View style={styles.flex}>
      <Text style={[styles.nodeMeta, { color: colors.muted }]} numberOfLines={1}>{label}</Text>
      <Text style={[styles.nodeLabel, { color: colors.ink }]} numberOfLines={3}>{row.label}</Text>
      {row.createdAtMs !== undefined && <Text style={[styles.caption, { color: colors.muted }]}>{new Date(row.createdAtMs).toLocaleString()}</Text>}
    </View>
  </Pressable>;
}

function roleLabel(row: MobileNativeTreeRow): string {
  if (row.role === "user") return "User";
  if (row.role === "assistant") return "Assistant";
  if (row.role === "tool") return "Tool result";
  if (row.kind === "model") return "Model change";
  if (row.kind === "compaction") return "Compaction";
  if (row.kind === "summary") return "Branch summary";
  return "Native entry";
}

function IconButton({ label, text, disabled, colors, onPress }: {
  readonly label: string;
  readonly text: string;
  readonly disabled: boolean;
  readonly colors: MobileInteractionSheetColors;
  readonly onPress: () => void;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}
    disabled={disabled} onPress={onPress} style={[styles.iconButton, disabled && styles.disabled]}>
    <Text style={[styles.iconText, { color: colors.ink }]}>{text}</Text>
  </Pressable>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Task branches could not be loaded.";
}

const styles = StyleSheet.create({
  modalRoot: { flex: 1, justifyContent: "flex-end" },
  backdrop: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "rgba(0,0,0,0.42)" },
  sheet: { maxHeight: "94%", borderTopWidth: 1, borderTopLeftRadius: 24, borderTopRightRadius: 24, overflow: "hidden" },
  header: { minHeight: 76, paddingHorizontal: 14, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 8 },
  headerText: { flex: 1, gap: 3 },
  eyebrow: { fontSize: 12, lineHeight: 17, fontWeight: "700", textTransform: "uppercase" },
  title: { fontSize: 22, lineHeight: 28, fontWeight: "700" },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  iconText: { fontSize: 29, lineHeight: 34, fontWeight: "500" },
  content: { paddingHorizontal: 18, paddingTop: 8, paddingBottom: 28, gap: 12 },
  flex: { flex: 1 },
  notice: { borderWidth: 1, borderRadius: 16, padding: 14, gap: 6 },
  noticeTitle: { fontSize: 16, lineHeight: 22, fontWeight: "800" },
  body: { fontSize: 14, lineHeight: 20 },
  caption: { fontSize: 12, lineHeight: 17 },
  summaryCard: { borderWidth: 1, borderRadius: 16, padding: 13, gap: 10 },
  settingRow: { minHeight: 54, flexDirection: "row", alignItems: "center", gap: 12 },
  rowLabel: { fontSize: 15, lineHeight: 21, fontWeight: "700" },
  instructions: { minHeight: 84, maxHeight: 150, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 14, lineHeight: 20, textAlignVertical: "top" },
  warning: { fontSize: 13, lineHeight: 18, fontWeight: "600" },
  feedback: { fontSize: 14, lineHeight: 20, fontWeight: "700" },
  errorCard: { minHeight: 56, borderWidth: 1, borderRadius: 14, padding: 12, flexDirection: "row", alignItems: "center", gap: 12 },
  retry: { fontSize: 14, lineHeight: 20, fontWeight: "800" },
  loading: { minHeight: 120, alignItems: "center", justifyContent: "center" },
  empty: { minHeight: 90, padding: 20, textAlign: "center", fontSize: 14, lineHeight: 20 },
  tree: { gap: 7 },
  node: { minHeight: 58, borderWidth: 1, borderRadius: 14, paddingRight: 12, paddingVertical: 9,
    flexDirection: "row", alignItems: "flex-start", gap: 10 },
  nodeIcon: { width: 28, height: 28, borderWidth: 1, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  nodeGlyph: { fontSize: 17, lineHeight: 21, fontWeight: "800" },
  nodeMeta: { fontSize: 11, lineHeight: 15, fontWeight: "800", textTransform: "uppercase" },
  nodeLabel: { fontSize: 15, lineHeight: 21 },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.55 }
});
