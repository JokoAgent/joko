import { memo, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { setStringAsync } from "expo-clipboard";
import { parseToolFileChangeSet, toolPayloadDiffFiles, type ToolPayloadDiffFile } from "@joko/contracts";
import type { MobileToolCallView } from "./mobile-tool-call";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";

type Section = "input" | "output";

export const MobileToolCallCard = memo(function MobileToolCallCard({ call, ownerKey, enabled, colors, locale }: {
  readonly call: MobileToolCallView;
  readonly ownerKey: string;
  readonly enabled: boolean;
  readonly colors: MobileInteractionSheetColors;
  readonly locale: MobileSupportedLocale;
}) {
  const [expanded, setExpanded] = useState(false);
  const [viewer, setViewer] = useState<{ readonly ownerKey: string; readonly scopeKey: string; readonly section: Section }>();
  const section = viewer?.ownerKey === ownerKey && viewer.scopeKey === call.scopeKey ? viewer.section : undefined;
  const setSection = (next: Section | undefined): void => setViewer(next === undefined ? undefined : { ownerKey, scopeKey: call.scopeKey, section: next });
  const [fileId, setFileId] = useState<string>();
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<"copied" | "failed" | "unknown">();
  const current = useRef({ ownerKey, call, enabled, foreground, section });
  current.current = { ownerKey, call, enabled, foreground, section };
  const mounted = useRef(true);
  const copyPending = useRef(false);
  const copyEpoch = useRef(0);
  const interactive = enabled && foreground;
  const title = call.summary ? mobileMessage(locale, `tool.action.${call.summary.action}`)
    : call.name === "file_change" ? mobileMessage(locale, "tool.diff") : call.name;
  const hasDetails = call.input !== "" || call.output !== "" || call.error !== "";
  const raw = section === "input" ? call.input : call.output;
  const truncated = section === "input" ? call.inputTruncated : call.outputTruncated;
  const files = useMemo(() => {
    if (section === undefined) return [];
    const changes = section === "input" ? parseToolFileChangeSet(call.name, raw) : undefined;
    if (changes) return changes.changes.map((change) => ({ id: change.id,
      path: change.movePath ? `${change.path} → ${change.movePath}` : change.path, text: change.diff }));
    return toolPayloadDiffFiles(raw.startsWith("$: ") ? raw.slice(3) : raw);
  }, [call.name, raw, section]);
  const selectedFile = files.find((file) => file.id === fileId);
  const displayed = selectedFile?.text ?? raw;
  const copySource = useRef({ displayed, fileId });
  copySource.current = { displayed, fileId };

  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener("change", (state) => {
      setForeground(state === "active");
      if (state === "background") { setSection(undefined); setExpanded(false); copyEpoch.current += 1; }
    });
    return () => { mounted.current = false; copyEpoch.current += 1; subscription.remove(); };
  }, []);
  useEffect(() => {
    setExpanded(false); setSection(undefined); setFileId(undefined); setCopyFeedback(undefined);
    copyEpoch.current += 1;
  }, [ownerKey, call.scopeKey]);
  useEffect(() => {
    if (!enabled) { setSection(undefined); copyEpoch.current += 1; }
  }, [enabled]);
  useEffect(() => { setFileId(undefined); setCopyFeedback(undefined); copyEpoch.current += 1; }, [section]);

  const close = (): void => { setSection(undefined); copyEpoch.current += 1; };
  const copy = async (): Promise<void> => {
    if (!interactive || section === undefined || copyPending.current || displayed === "") return;
    const captured = { ownerKey, scopeKey: call.scopeKey, section, text: displayed, fileId, epoch: copyEpoch.current };
    copyPending.current = true; setCopyBusy(true); setCopyFeedback(undefined);
    const stillCurrent = (): boolean => mounted.current && copyEpoch.current === captured.epoch
      && current.current.ownerKey === captured.ownerKey && current.current.call.scopeKey === captured.scopeKey
      && current.current.enabled && current.current.foreground && current.current.section === captured.section
      && copySource.current.displayed === captured.text && copySource.current.fileId === captured.fileId;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; if (stillCurrent()) setCopyFeedback("unknown"); }, 5_000);
    try {
      const result = await setStringAsync(captured.text);
      if (result === false) throw new Error("Clipboard write failed.");
      if (!timedOut && stillCurrent()) setCopyFeedback("copied");
    } catch {
      if (!timedOut && stillCurrent()) setCopyFeedback("failed");
    } finally {
      clearTimeout(timeout);
      copyPending.current = false;
      if (mounted.current) setCopyBusy(false);
    }
  };
  const open = (next: Section): void => { if (interactive) setSection(next); };
  const chooseFile = (file?: ToolPayloadDiffFile): void => {
    if (!interactive) return;
    setFileId(file?.id); setCopyFeedback(undefined); copyEpoch.current += 1;
  };
  const button = (label: string, onPress: () => void, selected = false, disabled = false) =>
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected, disabled }}
      disabled={!interactive || disabled} onPress={onPress} style={[styles.action,
        { borderColor: selected ? colors.accent : colors.border, backgroundColor: selected ? colors.brandBackground : colors.background }]}>
      <Text style={{ color: colors.accent }}>{label}</Text>
    </Pressable>;

  return <View>
    <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, expanded ? "tool.collapse" : "tool.expand", { name: title })}
      accessibilityState={{ expanded, disabled: !interactive || !hasDetails }} disabled={!interactive || !hasDetails}
      onPress={() => setExpanded((value) => !value)} style={styles.heading}>
      <Text style={[styles.glyph, { color: call.state === "failed" || call.state === "aborted" ? colors.negative : colors.muted }]}>
        {call.state === "succeeded" ? "✓" : call.state === "failed" ? "!" : call.state === "aborted" ? "×" : "○"}
      </Text>
      <View style={styles.fill}>
        <Text style={[styles.title, { color: colors.ink }]} numberOfLines={1}>{title}</Text>
        <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={2}>
          {[call.summary?.primary, mobileMessage(locale, `tool.state.${call.state}`)].filter(Boolean).join(" · ")}
        </Text>
      </View>
      {hasDetails && <Text style={{ color: colors.muted }}>{expanded ? "⌄" : "›"}</Text>}
    </Pressable>
    {expanded && <View style={[styles.details, { borderColor: colors.border }]}>
      {call.input !== "" && <View>
        <Text selectable numberOfLines={5} style={[styles.source, { color: colors.muted }]}>{call.input.slice(0, 1_200)}</Text>
        {button(mobileMessage(locale, "tool.viewInput"), () => open("input"))}
      </View>}
      {call.output !== "" && <View>
        <Text selectable numberOfLines={6} style={[styles.source, { color: colors.ink }]}>{call.output.slice(0, 1_200)}</Text>
        {button(mobileMessage(locale, "tool.viewOutput"), () => open("output"))}
      </View>}
      {call.error !== "" && <Text selectable style={[styles.caption, { color: colors.negative }]}>{call.error}</Text>}
      {(call.inputTruncated || call.outputTruncated) && <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "tool.truncated")}</Text>}
    </View>}
    <Modal visible={section !== undefined && interactive} animationType="slide" onRequestClose={close}>
      <SafeAreaView style={[styles.fill, { backgroundColor: colors.background }]}>
        <View style={[styles.toolbar, { borderColor: colors.border }]}>
          <Text style={[styles.title, styles.fill, { color: colors.ink }]} numberOfLines={1}>{title}</Text>
          {button(mobileMessage(locale, "common.close"), close)}
        </View>
        <View style={styles.toolbar}>
          {button(mobileMessage(locale, "common.input"), () => open("input"), section === "input", call.input === "")}
          {button(mobileMessage(locale, "common.output"), () => open("output"), section === "output", call.output === "")}
          {button(mobileMessage(locale, copyBusy ? "tool.copying" : "tool.copy"), () => void copy(), false, copyBusy || displayed === "")}
        </View>
        {files.length > 0 && <ScrollView horizontal style={styles.filePicker} contentContainerStyle={styles.toolbar}>
          {button(mobileMessage(locale, "tool.raw"), () => chooseFile(), selectedFile === undefined)}
          {files.map((file) => <View key={file.id}>{button(file.path, () => chooseFile(file), selectedFile?.id === file.id)}</View>)}
        </ScrollView>}
        {truncated && <Text style={[styles.notice, { color: colors.muted }]}>{mobileMessage(locale, "tool.truncated")}</Text>}
        {copyFeedback && <Text accessibilityLiveRegion="polite" style={[styles.notice,
          { color: copyFeedback === "failed" ? colors.negative : colors.accent }]}>
          {mobileMessage(locale, copyFeedback === "failed" ? "tool.copyFailed" : copyFeedback === "unknown" ? "tool.copyUnknown" : "tool.copied")}
        </Text>}
        <ScrollView style={styles.fill} contentContainerStyle={styles.body}>
          <ScrollView horizontal>
            <Text selectable style={[styles.source, { color: colors.ink }]}>{displayed || mobileMessage(locale, "tool.empty")}</Text>
          </ScrollView>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  </View>;
});

const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 },
  heading: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8 },
  glyph: { fontSize: 18, width: 20, textAlign: "center" },
  title: { fontSize: 14, fontWeight: "600" },
  caption: { fontSize: 12, lineHeight: 18 },
  details: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8, gap: 12 },
  source: { fontFamily: "monospace", fontSize: 12, lineHeight: 18 },
  action: { minHeight: 44, paddingHorizontal: 12, justifyContent: "center", borderWidth: StyleSheet.hairlineWidth, borderRadius: 8 },
  toolbar: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, padding: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  filePicker: { flexGrow: 0, maxHeight: 84 },
  body: { padding: 16 },
  notice: { paddingHorizontal: 12, paddingVertical: 6, fontSize: 12 }
});
