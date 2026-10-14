import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import { formatMobileObjectiveTokens, mobileObjectiveDefaultLimits, mobileObjectivePresets,
  type MobileObjective, type MobileObjectiveInput, type MobileObjectiveLimits } from "./mobile-objective";

export interface MobileObjectiveViewProps {
  readonly objective?: MobileObjective;
  readonly initial?: MobileObjectiveInput;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly error?: string;
  readonly colors: MobileInteractionSheetColors;
  readonly dark?: boolean;
  readonly locale: MobileSupportedLocale;
  readonly onSet: (input: MobileObjectiveInput) => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onClear: () => void;
}

export function MobileObjectiveView(props: MobileObjectiveViewProps) {
  const { colors, locale, objective, busy, disabled, error } = props;
  const button = (key: "objective.pause" | "objective.resume" | "objective.clear", action: () => void) =>
    <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, key)}
      accessibilityState={{ disabled: busy || disabled }} disabled={busy || disabled} onPress={action}
      style={[styles.action, { borderColor: colors.border }, (busy || disabled) && styles.disabled]}>
      <Text style={[styles.text, { color: key === "objective.clear" ? colors.negative : colors.ink }]}>{mobileMessage(locale, key)}</Text>
    </Pressable>;
  if (!objective) return <MobileObjectiveCreateForm {...props} />;
  return <View style={styles.stack}>
    <Text accessibilityRole="header" style={[styles.label, { color: colors.muted }]}>{mobileMessage(locale, `objective.${objective.status}`)}</Text>
    <Text selectable style={[styles.text, { color: colors.ink }]}>{objective.text}</Text>
    <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "objective.progress", {
      turns: `${objective.turnsUsed}${objective.maximumTurns === null ? "" : ` / ${objective.maximumTurns}`}`,
      tokens: `${formatMobileObjectiveTokens(objective.tokensUsed)}${objective.tokenBudget === null ? "" : ` / ${formatMobileObjectiveTokens(objective.tokenBudget)}`}`
    })}</Text>
    {objective.lastReason !== "" && <Text selectable style={[styles.caption, { color: colors.muted }]}>{objective.lastReason}</Text>}
    {error && <Text accessibilityRole="alert" style={[styles.caption, { color: colors.negative }]}>{error}</Text>}
    {objective.status === "active" && button("objective.pause", props.onPause)}
    {["paused", "blocked", "usageLimited"].includes(objective.status) && button("objective.resume", props.onResume)}
    {button("objective.clear", props.onClear)}
  </View>;
}

export function MobileObjectiveCreateForm({ initial, busy, disabled, error, colors, locale, onSet }: MobileObjectiveViewProps) {
  const [text, setText] = useState(initial?.text ?? "");
  const [limits, setLimits] = useState<MobileObjectiveLimits>(initial?.limits ?? mobileObjectiveDefaultLimits);
  const [touched, setTouched] = useState(initial?.limits !== undefined);
  const [advanced, setAdvanced] = useState(false);
  return <View style={styles.stack}>
    <Text style={[styles.label, { color: colors.muted }]}>{mobileMessage(locale, "objective.label")}</Text>
    <TextInput accessibilityLabel={mobileMessage(locale, "objective.label")} value={text} onChangeText={setText}
      editable={!busy} multiline maxLength={64_000} placeholder={mobileMessage(locale, "objective.placeholder")}
      placeholderTextColor={colors.muted} style={[styles.input, { color: colors.ink, backgroundColor: colors.surface, borderColor: colors.border }]} />
    <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "objective.advanced")}
      accessibilityState={{ expanded: advanced, disabled: busy }} disabled={busy} onPress={() => setAdvanced(value => !value)} style={styles.action}>
      <Text style={[styles.text, styles.flex, { color: colors.ink }]}>{mobileMessage(locale, "objective.advanced")}</Text>
      <Text style={{ color: colors.muted }}>{advanced ? "⌄" : "›"}</Text>
    </Pressable>
    {advanced && <>
      <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "objective.hint")}</Text>
      {(["maximumTurns", "tokenBudget", "noProgressTurnLimit"] as const).map(field => <LimitRow key={field} field={field}
        value={limits[field]} busy={busy} colors={colors} locale={locale}
        onChange={value => { setTouched(true); setLimits(current => ({ ...current, [field]: value })); }} />)}
    </>}
    {error && <Text accessibilityRole="alert" style={[styles.caption, { color: colors.negative }]}>{error}</Text>}
    <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "objective.start")}
      accessibilityState={{ disabled: busy || disabled || !text.trim() }} disabled={busy || disabled || !text.trim()}
      onPress={() => { if (!busy && !disabled && text.trim()) onSet({ text: text.trim(), ...(touched ? { limits } : {}) }); }}
      style={[styles.start, { borderColor: colors.accent }, (busy || disabled || !text.trim()) && styles.disabled]}>
      {busy ? <ActivityIndicator color={colors.accent} /> : <Text style={[styles.text, { color: colors.accent }]}>{mobileMessage(locale, "objective.start")}</Text>}
    </Pressable>
  </View>;
}
function LimitRow({ field, value, busy, colors, locale, onChange }: {
  field: keyof MobileObjectiveLimits; value: number | null; busy: boolean; colors: MobileInteractionSheetColors;
  locale: MobileSupportedLocale; onChange: (value: number | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const presets: readonly number[] = mobileObjectivePresets[field];
  const options = value !== null && !presets.includes(value) ? [value, ...presets] : presets;
  const format = (item: number | null) => item === null ? mobileMessage(locale, "objective.unlimited")
    : field === "tokenBudget" ? formatMobileObjectiveTokens(item) : String(item);
  const label = mobileMessage(locale, `objective.${field}`);
  return <View>
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}, ${format(value)}`} accessibilityState={{ expanded, disabled: busy }}
      disabled={busy} onPress={() => setExpanded(open => !open)} style={styles.action}>
      <Text style={[styles.text, styles.flex, { color: colors.ink }]}>{label}</Text><Text style={[styles.caption, { color: colors.muted }]}>{format(value)} ↕</Text>
    </Pressable>
    {expanded && [...options, null].map(item => <Pressable key={String(item)} accessibilityRole="radio" accessibilityLabel={format(item)}
      accessibilityState={{ checked: value === item, disabled: busy }} disabled={busy} style={styles.action}
      onPress={() => { onChange(item); setExpanded(false); }}>
      <Text style={[styles.text, styles.flex, { color: colors.ink }]}>{format(item)}</Text><Text style={{ color: colors.accent }}>{value === item ? "✓" : ""}</Text>
    </Pressable>)}
  </View>;
}
const styles = StyleSheet.create({
  stack: { gap: 12 }, flex: { flex: 1 }, label: { fontSize: 13, fontWeight: "600", lineHeight: 18 },
  text: { fontSize: 16, lineHeight: 24 }, caption: { fontSize: 13, lineHeight: 20 },
  input: { minHeight: 120, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 14, fontSize: 16, lineHeight: 24, textAlignVertical: "top" },
  action: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10 },
  start: { minHeight: 48, borderRadius: 12, borderWidth: 1, alignItems: "center", justifyContent: "center", marginTop: 4 }, disabled: { opacity: 0.5 }
});
