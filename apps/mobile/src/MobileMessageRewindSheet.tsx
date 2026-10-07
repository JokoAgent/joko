import { useEffect, useRef, useState } from "react";
import { AppState, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { FileChangeKind, RewindSafety } from "@joko/contracts";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import { mobileWorkspaceRewindExpiresAt, type MobileMessageRewindControls, type MobileMessageRewindPreview,
  type MobileMessageRewindResult } from "./mobile-message-rewind";

export function MobileMessageRewindSheet({ visible, controls, busy, colors, locale, onClose, onLoad, onCommit, onCheckOperation, onError }: {
  readonly visible: boolean; readonly controls?: MobileMessageRewindControls; readonly busy: boolean;
  readonly colors: MobileInteractionSheetColors; readonly locale: MobileSupportedLocale;
  readonly onClose: () => void;
  readonly onLoad: (key: string, eventId: string, signal: AbortSignal) => Promise<MobileMessageRewindPreview | undefined>;
  readonly onCommit: (preview: MobileMessageRewindPreview, mode: "dialogue" | "files", signal: AbortSignal) => Promise<MobileMessageRewindResult>;
  readonly onCheckOperation: () => Promise<boolean>; readonly onError: (message: string) => void;
}) {
  const [owner, setOwner] = useState<string>();
  const [preview, setPreview] = useState<MobileMessageRewindPreview>();
  const [phase, setPhase] = useState<"loading" | "ready" | "failed" | "committing" | "unknown">("loading");
  const [retry, setRetry] = useState(0);
  const [, setExpirationClock] = useState(0);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const request = useRef<{ controller: AbortController; kind: "load" | "commit" | "check" } | undefined>(undefined);
  const mounted = useRef(true); const closeRef = useRef(onClose); closeRef.current = onClose;
  const active = visible && foreground && owner !== undefined && owner === controls?.surfaceOwnerKey;
  const activeRef = useRef(active); activeRef.current = active;
  const controlsRef = useRef(controls); controlsRef.current = controls;
  const callbacks = useRef({ onLoad, onCommit, onCheckOperation, onError });
  callbacks.current = { onLoad, onCommit, onCheckOperation, onError };
  const cancel = (): void => { request.current?.controller.abort(); request.current = undefined; };
  const close = (): void => { cancel(); closeRef.current(); };
  const current = (controller: AbortController): boolean => mounted.current && activeRef.current
    && !controller.signal.aborted && request.current?.controller === controller;

  useEffect(() => {
    cancel(); setPreview(undefined); setPhase("loading");
    setOwner(visible ? controlsRef.current?.surfaceOwnerKey : undefined);
  }, [visible]);
  useEffect(() => {
    if (visible && owner && owner !== controls?.surfaceOwnerKey) close();
  }, [visible, owner, controls?.surfaceOwnerKey]);
  useEffect(() => {
    mounted.current = true;
    const listener = AppState.addEventListener("change", (state) => {
      setForeground(state === "active");
      if (state !== "active") { cancel(); closeRef.current(); }
    });
    return () => { mounted.current = false; cancel(); listener.remove(); };
  }, []);
  useEffect(() => {
    if (!active || !controls?.canRewind || phase === "committing" || phase === "unknown") return;
    const controller = new AbortController(); request.current = { controller, kind: "load" };
    const key = controls.authorityKey;
    setPreview(undefined); setPhase("loading");
    void callbacks.current.onLoad(key, controls.source.eventId, controller.signal).then((value) => {
      if (!current(controller) || controlsRef.current?.authorityKey !== key) return;
      setPreview(value); setPhase(value ? "ready" : "failed");
    }).catch(() => { if (current(controller)) setPhase("failed"); }).finally(() => {
      if (request.current?.controller === controller) request.current = undefined;
    });
    return () => { controller.abort(); if (request.current?.controller === controller) request.current = undefined; };
  }, [active, controls?.authorityKey, retry]);
  const expires = preview?.files ? mobileWorkspaceRewindExpiresAt(preview.files) : undefined;
  useEffect(() => {
    if (expires === undefined || expires <= Date.now()) return;
    const timer = setTimeout(() => setExpirationClock((value) => value + 1), Math.min(expires - Date.now() + 1, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [expires]);

  const confirm = async (mode: "dialogue" | "files"): Promise<void> => {
    if (!active || !preview || preview.controls.authorityKey !== controls?.authorityKey || busy || request.current
      || phase !== "ready" || (mode === "dialogue" ? !controls.canDialogue
        : !controls.canFiles || !preview.files || preview.files.safety === RewindSafety.BLOCKED || expires! <= Date.now())) return;
    const controller = new AbortController(); request.current = { controller, kind: "commit" }; setPhase("committing");
    try {
      const result = await callbacks.current.onCommit(preview, mode, controller.signal);
      if (!current(controller)) return;
      if (result.kind === "rewound" || result.kind === "retired") close();
      else setPhase(result.kind === "unknown" ? "unknown" : "failed");
    } catch (error) {
      if (current(controller)) {
        setPhase("failed"); callbacks.current.onError(error instanceof Error ? error.message : String(error));
      }
    } finally { if (request.current?.controller === controller) request.current = undefined; }
  };
  const check = async (): Promise<void> => {
    if (!active || request.current || busy || phase !== "unknown") return;
    const controller = new AbortController(); request.current = { controller, kind: "check" };
    try { if (await callbacks.current.onCheckOperation() && current(controller)) close(); }
    catch (error) { if (current(controller)) callbacks.current.onError(error instanceof Error ? error.message : String(error)); }
    finally { if (request.current?.controller === controller) request.current = undefined; }
  };
  const button = (label: string, action: () => void, disabled = false) => <Pressable accessibilityRole="button"
    accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={action}
    style={[styles.button, { backgroundColor: colors.accent }, disabled && styles.disabled]}>
    <Text style={[styles.buttonText, { color: colors.ink }]}>{label}</Text>
  </Pressable>;
  const files = preview?.files; const expired = expires !== undefined && expires <= Date.now();
  const ready = phase === "ready" && !busy && preview?.controls.authorityKey === controls?.authorityKey;
  return <Modal visible={active} animationType="slide" onRequestClose={close}>
    <SafeAreaView style={[styles.fill, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{mobileMessage(locale, "rewind.title")}</Text>
        <Text style={[styles.body, { color: colors.muted }]}>{mobileMessage(locale, "rewind.body")}</Text>
        <Text selectable style={[styles.source, { color: colors.ink, backgroundColor: colors.surface }]}>{controls?.source.draft.text.slice(0, 480)}</Text>
        {controls?.canDialogue && <Text style={[styles.body, { color: colors.muted }]}>{mobileMessage(locale, "rewind.attachments")}</Text>}
        {!controls?.canDialogue && <Text style={[styles.body, { color: colors.muted }]}>{mobileMessage(locale, "rewind.dialogueUnavailable")}</Text>}
        {phase === "loading" && <Text accessibilityLiveRegion="polite" style={{ color: colors.muted }}>{mobileMessage(locale, "rewind.loading")}</Text>}
        {phase === "committing" && <Text accessibilityLiveRegion="polite" style={{ color: colors.muted }}>{mobileMessage(locale, "rewind.working")}</Text>}
        {(phase === "failed" || phase === "unknown") && <Text accessibilityLiveRegion="polite" style={{ color: colors.negative }}>{mobileMessage(locale,
          phase === "unknown" ? "rewind.unknown" : preview ? "rewind.failed" : "rewind.previewFailed")}</Text>}
        {preview?.fileError && <Text accessibilityLiveRegion="polite" style={{ color: colors.negative }}>{mobileMessage(locale, "rewind.previewFailed")}</Text>}
        {phase !== "loading" && !files && !preview?.fileError && <Text style={{ color: colors.muted }}>{mobileMessage(locale, "rewind.filesUnavailable")}</Text>}
        {files && <View style={styles.section}>
          <Text style={[styles.body, { color: files.safety === RewindSafety.SAFE && !expired ? colors.muted : colors.negative }]}>{mobileMessage(locale,
            expired ? "rewind.expired" : files.safety === RewindSafety.BLOCKED ? "rewind.blocked"
              : files.safety === RewindSafety.REQUIRES_CONFIRMATION ? "rewind.confirmation" : "rewind.safe")}</Text>
          <Text style={{ color: colors.muted }}>{mobileMessage(locale, "rewind.expires", { time: new Date(expires!).toLocaleString(locale) })}</Text>
          <Text accessibilityRole="header" style={[styles.heading, { color: colors.ink }]}>{mobileMessage(locale, "rewind.changes", { count: files.inverseChanges.length })}</Text>
          {!files.inverseChanges.length && <Text style={{ color: colors.muted }}>{mobileMessage(locale, "rewind.noChanges")}</Text>}
          {files.inverseChanges.map((change, index) => <Text selectable key={`${change.relativePath}:${index}`} style={[styles.path, { color: colors.ink }]}>{mobileMessage(locale,
            change.kind === FileChangeKind.CREATED ? "rewind.created" : change.kind === FileChangeKind.UPDATED ? "rewind.updated"
              : change.kind === FileChangeKind.DELETED ? "rewind.deleted" : change.kind === FileChangeKind.RENAMED ? "rewind.renamed" : "common.unknown")}
            {" · "}{change.oldRelativePath ? `${change.oldRelativePath} → ` : ""}{change.relativePath}</Text>)}
          {files.gaps.length > 0 && <Text accessibilityRole="header" style={[styles.heading, { color: colors.ink }]}>{mobileMessage(locale, "rewind.gaps", { count: files.gaps.length })}</Text>}
          {files.gaps.map((gap, index) => <Text selectable key={`gap:${index}`} style={[styles.body, { color: colors.negative }]}>{gap.relativePath}{gap.relativePath ? " · " : ""}{gap.explanation}</Text>)}
          {files.conflicts.length > 0 && <Text accessibilityRole="header" style={[styles.heading, { color: colors.ink }]}>{mobileMessage(locale, "rewind.conflicts", { count: files.conflicts.length })}</Text>}
          {files.conflicts.map((conflict, index) => <Text selectable key={`conflict:${index}`} style={[styles.body, { color: colors.negative }]}>{conflict.relativePath}{" · "}{conflict.explanation}</Text>)}
        </View>}
        {button(mobileMessage(locale, "rewind.dialogue"), () => void confirm("dialogue"), !ready || !controls?.canDialogue)}
        {button(mobileMessage(locale, "rewind.files"), () => void confirm("files"), !ready || !controls?.canFiles || !files || files.safety === RewindSafety.BLOCKED || expired)}
        {(phase === "failed" || phase === "ready" && (preview?.fileError || expired)) && button(mobileMessage(locale, "common.refresh"), () => setRetry((value) => value + 1), busy)}
        {phase === "unknown" && button(mobileMessage(locale, "receipt.check"), () => void check(), busy)}
        {button(mobileMessage(locale, "common.close"), close)}
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 }, content: { padding: 20, gap: 16 }, title: { fontSize: 22, fontWeight: "700" },
  heading: { fontSize: 16, fontWeight: "700" }, body: { fontSize: 15, lineHeight: 22 },
  section: { gap: 12 }, source: { padding: 12, borderRadius: 12, fontSize: 14, lineHeight: 20 },
  path: { fontFamily: "monospace", fontSize: 13, lineHeight: 20 },
  button: { minHeight: 48, borderRadius: 12, justifyContent: "center", alignItems: "center", padding: 12 },
  buttonText: { fontSize: 15, fontWeight: "700" }, disabled: { opacity: 0.5 }
});
