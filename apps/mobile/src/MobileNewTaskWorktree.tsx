import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { MobileAutomationWorktreeProof } from "./mobile-automation-authoring";
import { mobileAutomationWorktreeEligibilityLabel } from "./mobile-automation-presentation";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import type { MobilePartnersColors } from "./MobilePartnersScreen";
import type { MobileNewTaskWorktree as WorktreeSelection } from "./new-task-draft-store";

export function MobileNewTaskWorktree({ ownerKey, value, load, onChange, disabled, colors, locale }: {
  readonly ownerKey: string | undefined;
  readonly value: WorktreeSelection | undefined;
  readonly load: (signal: AbortSignal) => Promise<MobileAutomationWorktreeProof>;
  readonly onChange: (value: WorktreeSelection | undefined) => void;
  readonly disabled: boolean;
  readonly colors: Pick<MobilePartnersColors, "border" | "surface" | "brandBackground" | "ink" | "negative" | "muted">;
  readonly locale: MobileSupportedLocale;
}) {
  const latest = useRef(load); latest.current = load;
  const [proof, setProof] = useState<MobileAutomationWorktreeProof>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setProof(undefined); setError(""); setLoading(ownerKey !== undefined);
    if (ownerKey) void latest.current(controller.signal).then(result => {
      if (!controller.signal.aborted) setProof(result);
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [ownerKey, reload]);
  const locked = disabled || !ownerKey || loading;
  const choice = (label: string, checked: boolean | undefined, onPress: () => void, unavailable = false) =>
    <Pressable accessibilityLabel={label} accessibilityRole={checked === undefined ? "button" : "checkbox"}
      accessibilityState={{ ...(checked === undefined ? {} : { checked }), disabled: locked || unavailable }}
      disabled={locked || unavailable} onPress={onPress}
      style={[styles.choice, { borderColor: colors.border, backgroundColor: checked ? colors.brandBackground : colors.surface },
        (locked || unavailable) && styles.disabled]}>
      <Text style={{ color: colors.ink }}>{checked === undefined ? "" : checked ? "✓ " : "○ "}{label}</Text>
    </Pressable>;
  return <View style={styles.section} testID="newTask.worktree">
    {choice(mobileMessage(locale, "automation.editor.worktree"), value !== undefined,
      () => onChange(value ? undefined : { refreshRemote: false }), !value && proof?.eligibility !== "eligible")}
    {choice(mobileMessage(locale, loading ? "automation.editor.worktreeLoading" : "automation.editor.worktreeReload"),
      undefined, () => setReload(current => current + 1))}
    {error && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{error}</Text>}
    {proof && proof.eligibility !== "eligible" && <Text style={{ color: colors.muted }}>
      {mobileAutomationWorktreeEligibilityLabel(locale, proof.eligibility)}</Text>}
    {value && <>
      {value.sourceRef !== undefined && proof && !proof.sources.some(source => source.ref === value.sourceRef)
        && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{value.sourceRef} · {mobileMessage(locale, "common.unavailable")}</Text>}
      {choice(mobileMessage(locale, "automation.editor.defaultSource"), value.sourceRef === undefined,
        () => onChange({ refreshRemote: value.refreshRemote }), proof?.eligibility !== "eligible")}
      {proof?.sources.map(source => <View key={source.ref}>
        {choice(source.displayName, value.sourceRef === source.ref, () => onChange({ ...value, sourceRef: source.ref }),
          proof?.eligibility !== "eligible")}</View>)}
      {choice(mobileMessage(locale, "automation.editor.refreshRemote"), value.refreshRemote,
        () => onChange({ ...value, refreshRemote: !value.refreshRemote }), proof?.canRefreshRemote !== true)}
    </>}
  </View>;
}

const styles = StyleSheet.create({ section: { gap: 8, paddingHorizontal: 16 },
  choice: { minHeight: 44, borderWidth: 1, borderRadius: 12, padding: 12, justifyContent: "center" }, disabled: { opacity: 0.45 } });
