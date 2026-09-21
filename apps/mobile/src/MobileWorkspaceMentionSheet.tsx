import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { MobileKeyboardAvoidingView, useMobileKeyboardState } from "./MobileKeyboardAvoidingView";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import {
  filterMobileWorkspaceMentionCandidates,
  normalizeMobileWorkspaceLineRange,
  type MobileWorkspaceMentionCandidate,
  type MobileWorkspaceMentionControls,
  type MobileWorkspaceMentionDirectory,
  type MobileWorkspaceMentionFileIndex
} from "./mobile-workspace-mentions";
import type { MobileWorkspaceLineRange } from "./mobile-composer-document";
import { workspaceParentPath } from "./workspace-files";

export function MobileWorkspaceMentionSheet({
  visible,
  controls,
  busy,
  colors,
  locale,
  onClose,
  onLoadDirectory,
  onLoadFileIndex,
  onSelect
}: {
  readonly visible: boolean;
  readonly controls?: MobileWorkspaceMentionControls;
  readonly busy: boolean;
  readonly colors: MobileInteractionSheetColors;
  readonly locale: MobileSupportedLocale;
  readonly onClose: () => void;
  readonly onLoadDirectory: (
    surfaceOwnerKey: string,
    parentPath: string,
    signal: AbortSignal
  ) => Promise<MobileWorkspaceMentionDirectory>;
  readonly onLoadFileIndex: (
    surfaceOwnerKey: string,
    signal: AbortSignal
  ) => Promise<MobileWorkspaceMentionFileIndex>;
  readonly onSelect: (
    surfaceOwnerKey: string,
    candidate: MobileWorkspaceMentionCandidate,
    lineRange?: MobileWorkspaceLineRange
  ) => Promise<void>;
}) {
  const [directory, setDirectory] = useState<MobileWorkspaceMentionDirectory>();
  const [fileIndex, setFileIndex] = useState<MobileWorkspaceMentionFileIndex>();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [selectingPath, setSelectingPath] = useState<string>();
  const [lineCandidate, setLineCandidate] = useState<MobileWorkspaceMentionCandidate>();
  const [startLineText, setStartLineText] = useState("");
  const [endLineText, setEndLineText] = useState("");
  const mountedRef = useRef(true);
  const visibleRef = useRef(visible);
  const controlsRef = useRef(controls);
  const loadDirectoryRef = useRef(onLoadDirectory);
  const loadFileIndexRef = useRef(onLoadFileIndex);
  const selectRef = useRef(onSelect);
  const requestRef = useRef(0);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const searchRef = useRef<TextInput>(null);
  const keyboard = useMobileKeyboardState();
  const safeArea = useSafeAreaInsets();
  visibleRef.current = visible;
  controlsRef.current = controls;
  loadDirectoryRef.current = onLoadDirectory;
  loadFileIndexRef.current = onLoadFileIndex;
  selectRef.current = onSelect;
  const disabled = busy || selectingPath !== undefined;
  const results = useMemo(
    () => controls === undefined
      ? { items: [], truncated: false }
      : filterMobileWorkspaceMentionCandidates(controls, directory, fileIndex, query),
    [controls, directory, fileIndex, query]
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const load = (parentPath: string, includeIndex: boolean): void => {
    const current = controlsRef.current;
    if (!visibleRef.current || !current || disabled) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const request = requestRef.current + 1;
    requestRef.current = request;
    const ownerKey = current.surfaceOwnerKey;
    setLoading(true);
    setLoadError(undefined);
    setActionError(undefined);
    setLineCandidate(undefined);
    setStartLineText("");
    setEndLineText("");
    void Promise.all([
      loadDirectoryRef.current(ownerKey, parentPath, controller.signal),
      includeIndex && current.policy.files
        ? loadFileIndexRef.current(ownerKey, controller.signal)
        : Promise.resolve(undefined)
    ]).then(([nextDirectory, nextIndex]) => {
      if (!mountedRef.current || controller.signal.aborted || !visibleRef.current
        || requestRef.current !== request || controlsRef.current?.surfaceOwnerKey !== ownerKey) return;
      setDirectory(nextDirectory);
      if (nextIndex !== undefined) setFileIndex(nextIndex);
      setQuery("");
      setTimeout(() => searchRef.current?.focus(), 80);
    }).catch((error) => {
      if (!mountedRef.current || controller.signal.aborted || requestRef.current !== request
        || controlsRef.current?.surfaceOwnerKey !== ownerKey) return;
      setLoadError(errorText(error, locale));
    }).finally(() => {
      if (mountedRef.current && requestRef.current === request) setLoading(false);
    });
  };

  useEffect(() => {
    abortRef.current?.abort();
    requestRef.current += 1;
    setDirectory(undefined);
    setFileIndex(undefined);
    setQuery("");
    setLoading(false);
    setLoadError(undefined);
    setActionError(undefined);
    setSelectingPath(undefined);
    setLineCandidate(undefined);
    setStartLineText("");
    setEndLineText("");
    if (!visible || !controls) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const request = requestRef.current + 1;
    requestRef.current = request;
    const ownerKey = controls.surfaceOwnerKey;
    setLoading(true);
    void Promise.all([
      loadDirectoryRef.current(ownerKey, "", controller.signal),
      controls.policy.files
        ? loadFileIndexRef.current(ownerKey, controller.signal)
        : Promise.resolve(undefined)
    ]).then(([nextDirectory, nextIndex]) => {
      if (!mountedRef.current || controller.signal.aborted || !visibleRef.current
        || requestRef.current !== request || controlsRef.current?.surfaceOwnerKey !== ownerKey) return;
      setDirectory(nextDirectory);
      if (nextIndex !== undefined) setFileIndex(nextIndex);
      setTimeout(() => searchRef.current?.focus(), 120);
    }).catch((error) => {
      if (!mountedRef.current || controller.signal.aborted || requestRef.current !== request
        || controlsRef.current?.surfaceOwnerKey !== ownerKey) return;
      setLoadError(errorText(error, locale));
    }).finally(() => {
      if (mountedRef.current && requestRef.current === request) setLoading(false);
    });
    return () => controller.abort();
  }, [controls?.surfaceOwnerKey, visible]);

  if (!controls) return null;

  const select = async (
    candidate: MobileWorkspaceMentionCandidate,
    lineRange?: MobileWorkspaceLineRange
  ): Promise<void> => {
    if (disabled || loading) return;
    const ownerKey = controls.surfaceOwnerKey;
    setSelectingPath(candidate.relativePath);
    setActionError(undefined);
    try {
      await selectRef.current(ownerKey, candidate, lineRange);
    } catch (error) {
      if (mountedRef.current && visibleRef.current && controlsRef.current?.surfaceOwnerKey === ownerKey) {
        setActionError(errorText(error, locale));
      }
    } finally {
      if (mountedRef.current && controlsRef.current?.surfaceOwnerKey === ownerKey) setSelectingPath(undefined);
    }
  };

  const closeOrBack = (): void => {
    if (disabled) return;
    const path = directory?.parentPath ?? "";
    if (path) {
      load(workspaceParentPath(path), false);
      return;
    }
    onClose();
  };

  const submitLines = (): void => {
    if (!lineCandidate) return;
    try {
      if (!/^\d+$/u.test(startLineText) || !/^\d+$/u.test(endLineText)) {
        throw new Error(mobileMessage(locale, "mention.workspace.rangeRequired"));
      }
      const range = normalizeMobileWorkspaceLineRange(Number(startLineText), Number(endLineText));
      void select(lineCandidate, range);
    } catch (error) {
      setActionError(errorText(error, locale));
    }
  };

  return <Modal visible={visible} transparent animationType="slide" statusBarTranslucent onRequestClose={closeOrBack}>
    <MobileKeyboardAvoidingView keyboard={keyboard} consumedBottomInset={safeArea.bottom}
      behavior={Platform.OS === "android" ? "height" : undefined} style={styles.modalRoot}>
      <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "mention.workspace.close")}
        disabled={disabled} onPress={onClose} style={styles.backdrop} />
      <SafeAreaView accessibilityViewIsModal edges={["bottom", "left", "right"]}
        style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={[styles.eyebrow, { color: colors.muted }]} numberOfLines={1}>{controls.workspaceDisplayName}</Text>
            <Text style={[styles.title, { color: colors.ink }]}>{mobileMessage(locale, "mention.workspace.title")}</Text>
            <Text style={[styles.path, { color: colors.muted }]} numberOfLines={1}>/{directory?.parentPath ?? ""}</Text>
          </View>
          <IconButton label={mobileMessage(locale, "mention.workspace.refresh")} text="↻" disabled={disabled || loading}
            colors={colors} onPress={() => load(directory?.parentPath ?? "", true)} />
          <IconButton label={mobileMessage(locale, "mention.workspace.close")} text="×" disabled={disabled}
            colors={colors} onPress={onClose} />
        </View>
        <View style={styles.searchRow}>
          {(directory?.parentPath ?? "") !== "" && <IconButton label={mobileMessage(locale, "mention.workspace.parent")} text="‹"
            disabled={disabled || loading} colors={colors}
            onPress={() => load(workspaceParentPath(directory!.parentPath), false)} />}
          <TextInput ref={searchRef} accessibilityLabel={mobileMessage(locale, "mention.workspace.searchLabel")} value={query}
            onChangeText={setQuery} editable={!disabled && !loading} autoCapitalize="none" autoCorrect={false}
            placeholder={mobileMessage(locale, controls.policy.files
              ? "mention.workspace.searchFiles" : "mention.workspace.searchDirectory")}
            placeholderTextColor={colors.muted}
            style={[styles.search, { color: colors.ink, backgroundColor: colors.background, borderColor: colors.border }]} />
        </View>
        {(loadError || actionError) && <View accessibilityRole="alert" style={styles.errorRow}>
          <Text style={[styles.error, { color: colors.negative }]}>{loadError ?? actionError}</Text>
          {loadError && <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "mention.workspace.retry")}
            disabled={disabled || loading} onPress={() => load(directory?.parentPath ?? "", true)}
            style={styles.retryButton}>
            <Text style={[styles.retry, { color: colors.accent }]}>{mobileMessage(locale, "common.retry")}</Text>
          </Pressable>}
        </View>}
        {lineCandidate && <View style={[styles.lineCard, { borderColor: colors.border, backgroundColor: colors.background }]}>
          <Text style={[styles.rowLabel, { color: colors.ink }]} numberOfLines={1}>{mobileMessage(locale, "mention.workspace.linesFrom", { name: lineCandidate.displayText })}</Text>
          <View style={styles.lineInputs}>
            <TextInput accessibilityLabel={mobileMessage(locale, "mention.workspace.startLabel")} value={startLineText}
              onChangeText={setStartLineText} editable={!disabled} keyboardType="number-pad" placeholder={mobileMessage(locale, "mention.workspace.start")}
              placeholderTextColor={colors.muted} maxLength={10}
              style={[styles.lineInput, { color: colors.ink, borderColor: colors.border, backgroundColor: colors.surface }]} />
            <TextInput accessibilityLabel={mobileMessage(locale, "mention.workspace.endLabel")} value={endLineText}
              onChangeText={setEndLineText} editable={!disabled} keyboardType="number-pad" placeholder={mobileMessage(locale, "mention.workspace.end")}
              placeholderTextColor={colors.muted} maxLength={10}
              style={[styles.lineInput, { color: colors.ink, borderColor: colors.border, backgroundColor: colors.surface }]} />
          </View>
          <View style={styles.lineActions}>
            <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "mention.workspace.cancelRange")}
              disabled={disabled} onPress={() => { setLineCandidate(undefined); setStartLineText(""); setEndLineText(""); }}
              style={styles.textButton}>
              <Text style={[styles.actionText, { color: colors.muted }]}>{mobileMessage(locale, "common.cancel")}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "mention.workspace.referenceRange")}
              disabled={disabled} onPress={submitLines} style={styles.textButton}>
              <Text style={[styles.actionText, { color: colors.accent }]}>{mobileMessage(locale, "mention.workspace.referenceLines")}</Text>
            </Pressable>
          </View>
        </View>}
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          {loading && <View accessibilityLabel={mobileMessage(locale, "mention.workspace.loading")} style={styles.loading}>
            <ActivityIndicator color={colors.muted} />
          </View>}
          {!loading && !loadError && results.items.length === 0 && <Text style={[styles.empty, { color: colors.muted }]}>
            {mobileMessage(locale, query.trim() ? "mention.workspace.noMatch" : "mention.workspace.empty")}
          </Text>}
          {!loading && results.items.map((candidate) => <WorkspaceRow key={`${candidate.directory ? "d" : "f"}:${candidate.relativePath}`}
            candidate={candidate} controls={controls} disabled={disabled} locale={locale}
            selecting={selectingPath === candidate.relativePath} colors={colors}
            onOpen={() => load(candidate.relativePath, false)}
            onReference={() => void select(candidate)}
            onLines={() => {
              setActionError(undefined);
              setLineCandidate(candidate);
              setStartLineText("");
              setEndLineText("");
            }} />)}
          {!loading && results.truncated && <Text accessibilityRole="alert" style={[styles.notice, { color: colors.muted }]}>
            {mobileMessage(locale, "mention.workspace.more")}
          </Text>}
        </ScrollView>
      </SafeAreaView>
    </MobileKeyboardAvoidingView>
  </Modal>;
}

function WorkspaceRow({ candidate, controls, disabled, selecting, colors, locale, onOpen, onReference, onLines }: {
  readonly candidate: MobileWorkspaceMentionCandidate;
  readonly controls: MobileWorkspaceMentionControls;
  readonly disabled: boolean;
  readonly selecting: boolean;
  readonly colors: MobileInteractionSheetColors;
  readonly locale: MobileSupportedLocale;
  readonly onOpen: () => void;
  readonly onReference: () => void;
  readonly onLines: () => void;
}) {
  const referenceable = candidate.directory ? controls.policy.directories : controls.policy.files;
  return <View style={[styles.row, { borderColor: colors.border }, disabled && styles.disabled]}>
    <Pressable accessibilityRole="button"
      accessibilityLabel={`${mobileMessage(locale, candidate.directory
        ? "mention.workspace.openDirectory" : "mention.workspace.referenceFile")} ${candidate.displayText}`}
      accessibilityHint={mobileMessage(locale, candidate.directory
        ? "mention.workspace.openHint" : "mention.workspace.fileHint")}
      accessibilityState={{ disabled }} disabled={disabled}
      onPress={candidate.directory ? onOpen : onReference} style={styles.rowMain}>
      <Text style={[styles.glyph, { color: colors.accent }]}>{candidate.directory ? "▰" : "◇"}</Text>
      <View style={styles.rowText}>
        <Text style={[styles.rowLabel, { color: colors.ink }]} numberOfLines={1}>{candidate.displayText}{candidate.directory ? "/" : ""}</Text>
        <Text selectable style={[styles.caption, { color: colors.muted }]} numberOfLines={1}>{candidate.relativePath}</Text>
      </View>
      {selecting && <ActivityIndicator size="small" color={colors.muted} />}
    </Pressable>
    {candidate.directory && referenceable && <Pressable accessibilityRole="button"
      accessibilityLabel={mobileMessage(locale, "mention.workspace.referenceDirectory", { name: candidate.displayText })}
      accessibilityHint={mobileMessage(locale, "mention.workspace.directoryHint")}
      accessibilityState={{ disabled }} disabled={disabled} onPress={onReference} style={styles.rowAction}>
      <Text style={[styles.actionText, { color: colors.accent }]}>{mobileMessage(locale, "mention.workspace.referenceShort")}</Text>
    </Pressable>}
    {!candidate.directory && controls.policy.lineRanges && <Pressable accessibilityRole="button"
      accessibilityLabel={mobileMessage(locale, "mention.workspace.chooseLines", { name: candidate.displayText })}
      accessibilityState={{ disabled }} disabled={disabled} onPress={onLines} style={styles.rowAction}>
      <Text style={[styles.actionText, { color: colors.accent }]}>{mobileMessage(locale, "mention.workspace.lines")}</Text>
    </Pressable>}
  </View>;
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

function errorText(error: unknown, locale: MobileSupportedLocale): string {
  return error instanceof Error ? error.message : mobileMessage(locale, "mention.workspace.loadError");
}

const styles = StyleSheet.create({
  modalRoot: { flex: 1, justifyContent: "flex-end" },
  backdrop: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "rgba(0,0,0,0.42)" },
  sheet: { maxHeight: "94%", borderTopWidth: 1, borderTopLeftRadius: 24, borderTopRightRadius: 24, overflow: "hidden" },
  header: { minHeight: 78, paddingHorizontal: 14, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 6 },
  headerText: { flex: 1, gap: 2 },
  eyebrow: { fontSize: 12, lineHeight: 17, fontWeight: "700", textTransform: "uppercase" },
  title: { fontSize: 22, lineHeight: 28, fontWeight: "700" },
  path: { fontSize: 12, lineHeight: 16 },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  iconText: { fontSize: 28, lineHeight: 33, fontWeight: "500" },
  searchRow: { paddingHorizontal: 14, paddingBottom: 9, flexDirection: "row", alignItems: "center", gap: 6 },
  search: { flex: 1, minHeight: 48, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, fontSize: 16 },
  errorRow: { paddingHorizontal: 18, paddingBottom: 8, flexDirection: "row", alignItems: "center", gap: 10 },
  error: { flex: 1, fontSize: 13, lineHeight: 19, fontWeight: "600" },
  retryButton: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  retry: { fontSize: 14, lineHeight: 20, fontWeight: "800" },
  lineCard: { marginHorizontal: 18, marginBottom: 8, borderWidth: 1, borderRadius: 14, padding: 12, gap: 9 },
  lineInputs: { flexDirection: "row", gap: 8 },
  lineInput: { flex: 1, minHeight: 44, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, fontSize: 15 },
  lineActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  textButton: { minHeight: 44, paddingHorizontal: 10, alignItems: "center", justifyContent: "center" },
  content: { paddingHorizontal: 18, paddingBottom: 28 },
  loading: { minHeight: 130, alignItems: "center", justifyContent: "center" },
  empty: { minHeight: 100, paddingVertical: 32, textAlign: "center", fontSize: 14, lineHeight: 20 },
  row: { minHeight: 62, borderBottomWidth: 1, flexDirection: "row", alignItems: "center", gap: 2 },
  rowMain: { flex: 1, minHeight: 58, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 10 },
  glyph: { width: 22, textAlign: "center", fontSize: 17, lineHeight: 22, fontWeight: "800" },
  rowText: { flex: 1, gap: 2 },
  rowLabel: { fontSize: 15, lineHeight: 21, fontWeight: "700" },
  caption: { fontSize: 12, lineHeight: 17 },
  rowAction: { minHeight: 44, paddingHorizontal: 8, alignItems: "center", justifyContent: "center" },
  actionText: { fontSize: 13, lineHeight: 19, fontWeight: "800" },
  notice: { paddingVertical: 12, fontSize: 12, lineHeight: 18, textAlign: "center" },
  disabled: { opacity: 0.52 }
});
