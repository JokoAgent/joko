import { create } from "@bufbuild/protobuf";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, AppState, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NightlyLearningCandidateDecisionSchema, NightlyLearningChangeDecisionSchema, NightlyLearningChangeKind, NightlyLearningFrequency,
  NightlyLearningScheduleSchema, nightlyLearningMessages, routineMessages, routineTime, type PartnerNightlyLearningEditor } from "@joko/contracts";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobilePartnersColors } from "./MobilePartnersScreen";

export function MobilePartnerNightlyLearningSheet({ editor, locale, colors, online, onClose }: {
  readonly editor: PartnerNightlyLearningEditor;
  readonly locale: MobileSupportedLocale;
  readonly colors: MobilePartnersColors;
  readonly online: boolean;
  readonly onClose: () => void;
}) {
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const { value, busy, failed } = useSyncExternalStore(editor.subscribe, editor.snapshot);
  const m = nightlyLearningMessages(locale), routine = routineMessages(locale);
  useEffect(() => {
    const listener = AppState.addEventListener("change", next => setForeground(next === "active"));
    return () => listener.remove();
  }, []);
  useEffect(() => {
    if (!online || !foreground) { editor.suspend(); return; }
    void editor.refresh();
    const poll = setInterval(() => { void editor.refresh(); }, 3000);
    return () => { clearInterval(poll); editor.suspend(); };
  }, [editor, foreground, online]);
  const locked = !online || !foreground || busy || failed || !value?.writable;
  const applying = locked || value?.running === true;
  const configure = (enabled: boolean, frequency: NightlyLearningFrequency) => void editor.apply({ case: "schedule",
    value: create(NightlyLearningScheduleSchema, { enabled, frequency }) });
  const action = (label: string, onPress: () => void, disabled = false, selected?: boolean) => <Pressable accessibilityRole="button"
    accessibilityLabel={label} accessibilityState={{ disabled, selected }} disabled={disabled} onPress={onPress}
    style={[styles.button, { backgroundColor: selected ? colors.brandBackground : colors.surface, borderColor: colors.border }, disabled && styles.disabled]}>
    <Text style={{ color: colors.ink }}>{label}</Text>
  </Pressable>;
  const heading = (label: string) => <Text accessibilityRole="header" style={[styles.heading, { color: colors.ink }]}>{label}</Text>;
  const schedule = value?.schedule;
  return <Modal visible animationType="slide" presentationStyle="pageSheet" allowSwipeDismissal={false} onRequestClose={onClose}>
    <SafeAreaView accessibilityViewIsModal style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={styles.toolbar}>{action(routine.close, onClose)}{heading(m.title)}</View>
      <ScrollView contentContainerStyle={styles.content}>
        {busy && <ActivityIndicator color={colors.accent} accessibilityLabel={routine.busy} />}
        {failed && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{m.failed}</Text>}
        {schedule && value && <>
          <View style={styles.toolbar}><Text style={{ color: colors.ink }}>{m.automatic}</Text>
            <Switch accessibilityLabel={m.automatic} value={schedule.enabled} disabled={locked}
              onValueChange={enabled => configure(enabled, schedule.frequency)} /></View>
          <View style={styles.toolbar}>
            {action(m.daily, () => configure(schedule.enabled, NightlyLearningFrequency.DAILY), locked, schedule.frequency === NightlyLearningFrequency.DAILY)}
            {action(m.weekly, () => configure(schedule.enabled, NightlyLearningFrequency.WEEKLY), locked, schedule.frequency === NightlyLearningFrequency.WEEKLY)}
          </View>
          <Text style={{ color: colors.muted }}>{m.time} ({value.timezone})</Text>
          <Text style={{ color: colors.ink }}>{m.pending} · {value.pendingConversations}</Text>
          {!value.memoryEnabled && <Text style={{ color: colors.muted }}>{m.memoryOff}</Text>}
          {value.running && <Text accessibilityLiveRegion="polite" style={{ color: colors.ink }}>{m.busy}</Text>}
          <View style={styles.toolbar}>{action(m.run, () => void editor.run(), applying)}</View>
          {heading(m.observations)}
          {value.candidates.length === 0 && <Text style={{ color: colors.muted }}>{m.emptyObservations}</Text>}
          {value.candidates.map(candidate => <View key={candidate.id} style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surface }]}>
            <Text style={{ color: colors.ink }}>{candidate.title}</Text><Text style={{ color: colors.muted }}>{candidate.summary}</Text>
            <View style={styles.toolbar}>
              {action(m.approve, () => void editor.apply({ case: "candidate", value: create(NightlyLearningCandidateDecisionSchema,
                { candidateId: candidate.id, promote: true }) }), applying)}
              {action(m.dismiss, () => void editor.apply({ case: "candidate", value: create(NightlyLearningCandidateDecisionSchema,
                { candidateId: candidate.id }) }), applying)}
            </View>
          </View>)}
          {heading(m.history)}
          {value.history.length === 0 && <Text style={{ color: colors.muted }}>{m.emptyHistory}</Text>}
          {value.history.map(run => <View key={run.id} style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surface }]}>
            <Text style={{ color: colors.ink }}>{routine.states[run.status] ?? routine.states[0]} · {new Date(routineTime(run.startedAt)).toLocaleString(locale)} · {run.conversationCount}</Text>
            {run.changes.map(change => <View key={change.id} style={styles.change}>
              <Text style={{ color: colors.ink }}>{m.kinds[change.kind]} · {m.actions[change.action]} · {change.title}</Text>
              <Text style={{ color: colors.muted }}>{change.reason}</Text>
              <View style={styles.toolbar}>{action(change.undone ? m.redo : m.undo, () => void editor.apply({ case: "change",
                value: create(NightlyLearningChangeDecisionSchema, { runId: run.id, changeId: change.id, redo: change.undone }) }),
              applying || change.kind === NightlyLearningChangeKind.MEMORY && !value.memoryEnabled)}</View>
            </View>)}
          </View>)}
        </>}
        {failed && <View style={styles.toolbar}>{action(m.refresh, () => void editor.refresh(), !online || !foreground || busy)}</View>}
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 }, content: { padding: 16, gap: 12 }, toolbar: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, paddingHorizontal: 4 },
  heading: { fontSize: 18, fontWeight: "600", flexShrink: 1 }, button: { minHeight: 42, justifyContent: "center", paddingHorizontal: 12, borderWidth: 1, borderRadius: 8 },
  disabled: { opacity: 0.5 }, card: { padding: 12, gap: 8, borderWidth: 1, borderRadius: 8 }, change: { gap: 6 }
});
