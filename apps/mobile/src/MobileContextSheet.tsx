import { useEffect, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import {
  formatMobileContextTokens,
  type MobileCompactOutcome,
  type MobileContextControls,
  type MobileContextUsage
} from "./mobile-context-controls";

interface CompactConfirmation {
  readonly authorityKey: string;
  readonly surfaceOwnerKey: string;
  readonly usage: MobileContextUsage;
}

export function MobileContextSheet({
  visible,
  controls,
  busy,
  colors,
  onClose,
  onCompact,
  onError
}: {
  readonly visible: boolean;
  readonly controls?: MobileContextControls;
  readonly busy: boolean;
  readonly colors: MobileInteractionSheetColors;
  readonly onClose: () => void;
  readonly onCompact: (authorityKey: string) => Promise<MobileCompactOutcome | undefined>;
  readonly onError: (message: string) => void;
}) {
  const [confirmation, setConfirmation] = useState<CompactConfirmation>();
  const [settling, setSettling] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const mountedRef = useRef(true);
  const surfaceOwnerRef = useRef(controls?.surfaceOwnerKey);
  surfaceOwnerRef.current = controls?.surfaceOwnerKey;
  const disabled = busy || settling;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    setConfirmation(undefined);
    setSettling(false);
    setFeedback(undefined);
  }, [controls?.surfaceOwnerKey, visible]);

  if (!controls) return null;

  const back = (): void => {
    if (disabled) return;
    if (confirmation) setConfirmation(undefined);
    else onClose();
  };

  const requestCompact = (): void => {
    if (disabled || !controls.canCompact || !controls.usage) return;
    setFeedback(undefined);
    setConfirmation({
      authorityKey: controls.authorityKey,
      surfaceOwnerKey: controls.surfaceOwnerKey,
      usage: controls.usage
    });
  };

  const confirmCompact = async (): Promise<void> => {
    const pending = confirmation;
    if (!pending || disabled) return;
    setSettling(true);
    onError("");
    try {
      const outcome = await onCompact(pending.authorityKey);
      if (!mountedRef.current || surfaceOwnerRef.current !== pending.surfaceOwnerKey) return;
      setConfirmation(undefined);
      setFeedback(outcome === "compacted"
        ? "Context compacted. The task snapshot has been refreshed."
        : outcome === "noop"
          ? "The Backend reported that no context compaction was needed."
          : "The compaction result is not yet confirmed. Check operation status before retrying.");
    } catch (error) {
      if (mountedRef.current && surfaceOwnerRef.current === pending.surfaceOwnerKey) onError(errorText(error));
    } finally {
      if (mountedRef.current) setSettling(false);
    }
  };

  const title = confirmation ? "Compact task context?" : "Task context";
  const subtitle = confirmation ? "Review the observed context before continuing" : controls.backend.displayName || controls.backend.backendId;

  return <Modal visible={visible} transparent animationType="slide" statusBarTranslucent onRequestClose={back}>
    <View style={styles.modalRoot}>
      <Pressable accessibilityRole="button" accessibilityLabel={confirmation ? "Back to task context" : "Close task context"}
        disabled={disabled} onPress={back} style={styles.backdrop} />
      <SafeAreaView accessibilityViewIsModal edges={["bottom", "left", "right"]}
        style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.header}>
          {confirmation && <IconButton label="Back" text="‹" disabled={disabled} colors={colors}
            onPress={() => setConfirmation(undefined)} />}
          <View style={styles.headerText}>
            <Text style={[styles.eyebrow, { color: colors.muted }]} numberOfLines={1}>{subtitle}</Text>
            <Text style={[styles.title, { color: colors.ink }]} numberOfLines={2}>{title}</Text>
          </View>
          <IconButton label="Close task context" text="×" disabled={disabled} colors={colors} onPress={onClose} />
        </View>
        <ScrollView contentContainerStyle={styles.content}>
          {confirmation
            ? <CompactConfirmationView confirmation={confirmation} disabled={disabled} colors={colors}
                onCancel={() => setConfirmation(undefined)} onConfirm={() => void confirmCompact()} />
            : <ContextDetails controls={controls} disabled={disabled} feedback={feedback}
                colors={colors} onCompact={requestCompact} />}
        </ScrollView>
      </SafeAreaView>
    </View>
  </Modal>;
}

function ContextDetails({ controls, disabled, feedback, colors, onCompact }: {
  readonly controls: MobileContextControls;
  readonly disabled: boolean;
  readonly feedback?: string;
  readonly colors: MobileInteractionSheetColors;
  readonly onCompact: () => void;
}) {
  const usage = controls.usage;
  return <View style={styles.stack}>
    {usage ? <>
      <View style={[styles.usageCard, { borderColor: colors.border, backgroundColor: colors.background }]}>
        <View accessibilityLabel={`${usage.percent} percent of task context used`}
          style={[styles.meter, { borderColor: usage.percent >= 90 ? colors.negative : colors.accent }]}>
          <Text style={[styles.meterValue, { color: usage.percent >= 90 ? colors.negative : colors.ink }]}>{usage.percent}%</Text>
          <Text style={[styles.meterLabel, { color: colors.muted }]}>used</Text>
        </View>
        <View style={styles.usageSummary}>
          <Text style={[styles.modelTitle, { color: colors.ink }]}>Current context window</Text>
          <Text style={[styles.body, { color: colors.ink }]}>{formatMobileContextTokens(usage.usedTokens)} used</Text>
          <Text style={[styles.caption, { color: colors.muted }]}>{usage.contextWindowTokens > 0n
            ? `${formatMobileContextTokens(usage.contextWindowTokens)} total · ${formatMobileContextTokens(usage.reservedTokens)} reserved`
            : "Context window boundary unavailable"}</Text>
          <Text style={[styles.caption, { color: colors.muted }]}>{usage.measuredAtMs === undefined
            ? "Measurement time unavailable"
            : `Measured ${new Date(usage.measuredAtMs).toLocaleString()}`}</Text>
        </View>
      </View>
      <SectionTitle label="Cumulative usage" colors={colors} />
      {usage.cumulative ? <View style={[styles.metrics, { borderColor: colors.border }]}>
        <Metric label="Input" value={usage.cumulative.inputTokens} colors={colors} />
        <Metric label="Output" value={usage.cumulative.outputTokens} colors={colors} />
        <Metric label="Cache read" value={usage.cumulative.cacheReadTokens} colors={colors} />
        <Metric label="Cache write" value={usage.cumulative.cacheWriteTokens} colors={colors} />
        <Metric label="Total" value={usage.cumulative.totalTokens} colors={colors} />
      </View> : <Text style={[styles.body, { color: colors.muted }]}>Cumulative token usage is unavailable.</Text>}
    </> : <View style={[styles.noticeCard, { borderColor: colors.border, backgroundColor: colors.background }]}>
      <Text style={[styles.modelTitle, { color: colors.ink }]}>Context usage unavailable</Text>
      <Text style={[styles.body, { color: colors.muted }]}>{controls.usageSupported
        ? "The Backend supports context reporting but has not supplied a trustworthy current measurement."
        : "The Backend does not advertise current context usage reporting."}</Text>
    </View>}

    <SectionTitle label="Runtime" colors={colors} />
    <View style={[styles.settingRow, { borderColor: colors.border }]}>
      <View style={styles.flex}>
        <Text style={[styles.rowLabel, { color: colors.ink }]}>Automatic compaction</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>Backend-neutral observed state; change it from settings when supported.</Text>
      </View>
      <Text style={[styles.value, { color: colors.ink }]}>{controls.session.contextState?.autoCompaction === undefined
        ? "Unknown" : controls.session.contextState.autoCompaction ? "On" : "Off"}</Text>
    </View>
    {controls.activeCompaction && <View accessibilityRole="alert"
      style={[styles.noticeCard, { borderColor: colors.accent, backgroundColor: colors.background }]}>
      <Text style={[styles.rowLabel, { color: colors.ink }]}>Compaction in progress</Text>
      <Text style={[styles.caption, { color: colors.muted }]}>{controls.activeCompaction.automatic ? "Automatic" : "Manual"}
        {controls.activeCompaction.reason ? ` · ${controls.activeCompaction.reason}` : ""}</Text>
    </View>}
    {feedback && <Text accessibilityRole="alert" style={[styles.feedback, { color: colors.accent }]}>{feedback}</Text>}

    {controls.compactSupported && <>
      <SectionTitle label="Manual compaction" colors={colors} />
      <Text style={[styles.body, { color: colors.muted }]}>Ask the Backend to summarize older context while preserving the current task.</Text>
      {controls.compactUnavailableReason && <Text style={[styles.warning, { color: colors.muted }]}>{controls.compactUnavailableReason}</Text>}
      <SheetButton label="Compact context" disabled={disabled || !controls.canCompact}
        colors={colors} onPress={onCompact} />
    </>}
  </View>;
}

function CompactConfirmationView({ confirmation, disabled, colors, onCancel, onConfirm }: {
  readonly confirmation: CompactConfirmation;
  readonly disabled: boolean;
  readonly colors: MobileInteractionSheetColors;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const usage = confirmation.usage;
  return <View style={styles.stack}>
    <View style={[styles.riskCard, { borderColor: colors.accent, backgroundColor: colors.background }]}>
      <Text style={[styles.modelTitle, { color: colors.ink }]}>Older task context may be summarized</Text>
      <Text style={[styles.body, { color: colors.ink }]}>The Backend will decide what can be compacted. Durable messages remain in Joko, but the active native context may change.</Text>
      <Text style={[styles.body, { color: colors.muted }]}>{formatMobileContextTokens(usage.usedTokens)} used
        {usage.contextWindowTokens > 0n ? ` of ${formatMobileContextTokens(usage.contextWindowTokens)}` : ""} at confirmation.</Text>
    </View>
    <View style={styles.actions}>
      <SheetButton label="Cancel" quiet disabled={disabled} colors={colors} onPress={onCancel} />
      <SheetButton label="Compact context" disabled={disabled} colors={colors} onPress={onConfirm} />
    </View>
  </View>;
}

function Metric({ label, value, colors }: {
  readonly label: string;
  readonly value: bigint;
  readonly colors: MobileInteractionSheetColors;
}) {
  return <View style={styles.metric}>
    <Text style={[styles.caption, { color: colors.muted }]}>{label}</Text>
    <Text style={[styles.metricValue, { color: colors.ink }]}>{formatMobileContextTokens(value)}</Text>
  </View>;
}

function SectionTitle({ label, colors }: { readonly label: string; readonly colors: MobileInteractionSheetColors }) {
  return <Text style={[styles.sectionTitle, { color: colors.muted }]}>{label}</Text>;
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

function SheetButton({ label, disabled, quiet, colors, onPress }: {
  readonly label: string;
  readonly disabled: boolean;
  readonly quiet?: boolean;
  readonly colors: MobileInteractionSheetColors;
  readonly onPress: () => void;
}) {
  const backgroundColor = disabled ? colors.border : quiet ? colors.surface : colors.accent;
  const color = disabled ? colors.muted : quiet ? colors.accent : "#2b2316";
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}
    disabled={disabled} onPress={onPress}
    style={[styles.button, quiet && { borderWidth: 1, borderColor: colors.border }, { backgroundColor }]}>
    <Text style={[styles.buttonText, { color }]}>{label}</Text>
  </Pressable>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "The task context could not be compacted.";
}

const styles = StyleSheet.create({
  modalRoot: { flex: 1, justifyContent: "flex-end" },
  backdrop: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "rgba(0,0,0,0.42)" },
  sheet: { maxHeight: "92%", borderTopWidth: 1, borderTopLeftRadius: 24, borderTopRightRadius: 24, overflow: "hidden" },
  header: { minHeight: 76, paddingHorizontal: 14, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 8 },
  headerText: { flex: 1, gap: 3 },
  eyebrow: { fontSize: 12, lineHeight: 17, fontWeight: "700", textTransform: "uppercase" },
  title: { fontSize: 22, lineHeight: 28, fontWeight: "700" },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  iconText: { fontSize: 30, lineHeight: 34, fontWeight: "500" },
  content: { paddingHorizontal: 18, paddingTop: 8, paddingBottom: 26 },
  stack: { gap: 12 },
  flex: { flex: 1 },
  usageCard: { minHeight: 136, borderWidth: 1, borderRadius: 18, padding: 15, flexDirection: "row", alignItems: "center", gap: 16 },
  meter: { width: 92, height: 92, borderWidth: 7, borderRadius: 46, alignItems: "center", justifyContent: "center" },
  meterValue: { fontSize: 23, lineHeight: 28, fontWeight: "800" },
  meterLabel: { fontSize: 12, lineHeight: 16, fontWeight: "700" },
  usageSummary: { flex: 1, gap: 4 },
  modelTitle: { fontSize: 18, lineHeight: 24, fontWeight: "800" },
  body: { fontSize: 15, lineHeight: 22 },
  caption: { fontSize: 13, lineHeight: 18 },
  sectionTitle: { marginTop: 4, fontSize: 12, lineHeight: 17, fontWeight: "800", textTransform: "uppercase" },
  metrics: { borderWidth: 1, borderRadius: 16, padding: 13, flexDirection: "row", flexWrap: "wrap", gap: 10 },
  metric: { minWidth: "45%", flexGrow: 1, gap: 2 },
  metricValue: { fontSize: 17, lineHeight: 23, fontWeight: "800" },
  settingRow: { minHeight: 60, borderWidth: 1, borderRadius: 14, paddingHorizontal: 13, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 12 },
  rowLabel: { fontSize: 16, lineHeight: 22, fontWeight: "700" },
  value: { minHeight: 44, lineHeight: 44, fontSize: 14, fontWeight: "800" },
  noticeCard: { borderWidth: 1, borderRadius: 16, padding: 15, gap: 8 },
  riskCard: { borderWidth: 1, borderRadius: 16, padding: 15, gap: 10 },
  feedback: { fontSize: 14, lineHeight: 20, fontWeight: "700" },
  warning: { fontSize: 13, lineHeight: 18, fontWeight: "600" },
  actions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 9 },
  button: { minHeight: 48, borderRadius: 13, paddingHorizontal: 17, paddingVertical: 11, alignItems: "center", justifyContent: "center" },
  buttonText: { fontSize: 14, lineHeight: 20, fontWeight: "800" },
  disabled: { opacity: 0.5 }
});
