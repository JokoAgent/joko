import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View
} from "react-native";
import type { MobileClient, MobileState } from "./mobile-client";
import {
  canRestartMobileAutomationRun,
  groupMobileAutomationSchedules,
  isMobileAutomationRunTerminal,
  isMobileAutomationRunUnread,
  type MobileAutomationRun,
  type MobileAutomationSchedule
} from "./mobile-automation";

export interface MobileAutomationsColors {
  readonly background: string;
  readonly surface: string;
  readonly ink: string;
  readonly muted: string;
  readonly border: string;
  readonly accent: string;
  readonly negative: string;
  readonly brandBackground: string;
}

export type MobileAutomationsClient = Pick<MobileClient,
  "openAutomations" | "closeAutomations" | "setAutomationFilter" | "selectAutomation"
  | "refreshAutomations" | "loadMoreAutomationHistory" | "runAutomation" | "setAutomationEnabled"
  | "restartAutomationRun" | "markAutomationRunRead" | "markAutomationRunsRead"
  | "markAllAutomationRunsRead" | "deleteAutomationRun" | "openAutomationRunTask">;

export interface MobileAutomationsScreenProps {
  readonly colors: MobileAutomationsColors;
  readonly state: MobileState;
  readonly client: MobileAutomationsClient;
  readonly onBack: () => void;
  readonly onOpenTask: () => void;
}

export function MobileAutomationsScreen({ colors, state, client, onBack, onOpenTask }: MobileAutomationsScreenProps) {
  const { width } = useWindowDimensions();
  const [narrowDetail, setNarrowDetail] = useState(false);
  const [localError, setLocalError] = useState("");
  const automations = state.automations;
  const wide = width >= 700;
  const online = state.status === "connected" && automations.status === "ready";
  const groups = useMemo(
    () => groupMobileAutomationSchedules(automations.schedules, automations.filter),
    [automations.filter, automations.schedules]
  );
  const selected = automations.schedules.find((schedule) => schedule.scheduleId === automations.selectedScheduleId);
  const unreadTotal = automations.schedules.reduce((total, schedule) => total + schedule.unreadRunCount, 0);

  useEffect(() => {
    if (!automations.open) void client.openAutomations().catch((error) => setLocalError(errorText(error)));
    return () => client.closeAutomations();
  }, [client]);

  useEffect(() => {
    if (!selected) setNarrowDetail(false);
  }, [selected]);

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setLocalError("");
    try { await action(); }
    catch (error) { setLocalError(errorText(error)); }
  };

  const select = (schedule: MobileAutomationSchedule): void => {
    setNarrowDetail(true);
    void run(() => client.selectAutomation(schedule.scheduleId));
  };

  const leave = (): void => {
    client.closeAutomations();
    onBack();
  };

  const list = <View style={[styles.listPane, wide && styles.wideListPane]}>
    <View style={styles.headerRow}>
      <Button label="Back" colors={colors} onPress={leave} />
      <View style={styles.headerText}>
        <Text style={[styles.title, { color: colors.ink }]}>Automations</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>
          {automations.schedules.length} schedules · {unreadTotal} unread runs
        </Text>
      </View>
      <Button label="Refresh" colors={colors} disabled={state.status !== "connected" || automations.status === "loading"}
        onPress={() => void run(() => client.refreshAutomations())} />
    </View>
    {automations.status === "offline" && <Notice colors={colors}
      text="Showing verified saved Schedule summaries. Details, run history, and Automation actions require a live Joko connection." />}
    {(localError || automations.error) && <Notice colors={colors} danger text={localError || automations.error || ""} />}
    <View accessibilityRole="tablist" style={styles.filterRow}>
      {(["all", "active", "paused"] as const).map((filter) => <Pressable key={filter} accessibilityRole="tab"
        accessibilityLabel={`${filter[0]!.toUpperCase() + filter.slice(1)} Automations`}
        accessibilityState={{ selected: automations.filter === filter }}
        onPress={() => client.setAutomationFilter(filter)}
        style={[styles.filter, { borderColor: automations.filter === filter ? colors.accent : colors.border,
          backgroundColor: automations.filter === filter ? colors.brandBackground : colors.surface }]}>
        <Text style={[styles.buttonText, { color: colors.ink }]}>{filter[0]!.toUpperCase() + filter.slice(1)}</Text>
      </Pressable>)}
    </View>
    {online && unreadTotal > 0 && <Button label="Mark all runs read" colors={colors} disabled={state.busy}
      onPress={() => void run(() => client.markAllAutomationRunsRead())} />}
    {automations.status === "loading" && automations.schedules.length === 0
      ? <Centered colors={colors} label="Loading Automations…" loading />
      : groups.length === 0
        ? <Centered colors={colors} label={automations.filter === "all" ? "No Automations" : `No ${automations.filter} Automations`} />
        : <ScrollView contentContainerStyle={styles.scheduleList}>
          {groups.map((group) => <View key={group.kind}>
            <Text style={[styles.section, { color: colors.muted }]}>{group.kind === "project" ? "Project" : "Dialogue"}</Text>
            {group.schedules.map((schedule) => <ScheduleRow key={schedule.scheduleId} schedule={schedule}
              selected={schedule.scheduleId === automations.selectedScheduleId} colors={colors}
              onPress={() => select(schedule)} />)}
          </View>)}
        </ScrollView>}
  </View>;

  const detail = <AutomationDetail colors={colors} state={state} schedule={selected} client={client}
    online={online} localError={localError} setLocalError={setLocalError} onRun={run}
    onBack={wide ? undefined : () => setNarrowDetail(false)} onOpenTask={onOpenTask} />;

  if (!wide && narrowDetail && selected) return <View style={[styles.root, { backgroundColor: colors.background }]}>{detail}</View>;
  return <View style={[styles.root, wide && styles.wide, { backgroundColor: colors.background }]}>
    {list}
    {wide && <View style={[styles.detailPane, { borderColor: colors.border }]}>{detail}</View>}
  </View>;
}

function ScheduleRow({ schedule, selected, colors, onPress }: {
  readonly schedule: MobileAutomationSchedule;
  readonly selected: boolean;
  readonly colors: MobileAutomationsColors;
  readonly onPress: () => void;
}) {
  const state = schedule.state === "disabled" ? "Paused" : schedule.state === "running" ? "Running"
    : schedule.state === "enabled" ? "Active" : schedule.state === "error" ? "Error" : "Deleting";
  return <Pressable accessibilityRole="button" accessibilityLabel={`Open Automation ${schedule.displayName}`}
    accessibilityState={{ selected }} onPress={onPress}
    style={[styles.card, { backgroundColor: selected ? colors.brandBackground : colors.surface,
      borderColor: selected ? colors.accent : colors.border }]}>
    <View style={styles.rowBetween}>
      <Text style={[styles.label, styles.flex, { color: colors.ink }]} numberOfLines={1}>{schedule.displayName}</Text>
      {schedule.unreadRunCount > 0 && <Text accessibilityLabel={`${schedule.unreadRunCount} unread runs`}
        style={[styles.badge, { color: colors.ink, backgroundColor: colors.brandBackground }]}>{schedule.unreadRunCount}</Text>}
    </View>
    <Text style={[styles.caption, { color: colors.muted }]}>{state} · {schedule.recurrenceLabel}</Text>
    <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={1}>{schedule.inputText || "No scheduled input"}</Text>
  </Pressable>;
}

function AutomationDetail({ colors, state, schedule, client, online, localError, setLocalError, onRun, onBack, onOpenTask }: {
  readonly colors: MobileAutomationsColors;
  readonly state: MobileState;
  readonly schedule?: MobileAutomationSchedule;
  readonly client: MobileAutomationsClient;
  readonly online: boolean;
  readonly localError: string;
  readonly setLocalError: (value: string) => void;
  readonly onRun: (action: () => Promise<unknown>) => Promise<void>;
  readonly onBack?: () => void;
  readonly onOpenTask: () => void;
}) {
  const automations = state.automations;
  if (!schedule) return <Centered colors={colors} label="Select an Automation" />;
  const detail = automations.detail?.scheduleId === schedule.scheduleId ? automations.detail : undefined;
  const pending = state.pending.some((item) => item.scheduleId === schedule.scheduleId
    && item.kind.startsWith("schedule-"));
  const disabled = !online || state.busy || pending || schedule.state === "deleting";
  const inFlight = automations.runtime?.inFlightBySchedule[schedule.scheduleId] ?? 0;
  const toggle = (): void => {
    const enabled = schedule.state === "disabled";
    const apply = () => void onRun(() => client.setAutomationEnabled(schedule.scheduleId, enabled));
    if (!enabled && inFlight > 0) {
      Alert.alert(
        `Pause ${schedule.displayName}?`,
        `${inFlight} run${inFlight === 1 ? " is" : "s are"} currently in flight. Pausing blocks future triggers and stops in-flight work.`,
        [{ text: "Keep running", style: "cancel" }, { text: "Pause", style: "destructive", onPress: apply }]
      );
    } else apply();
  };
  const markScheduleRead = (): void => {
    void onRun(() => client.markAutomationRunsRead(schedule.scheduleId));
  };
  return <ScrollView contentContainerStyle={styles.detail}>
    {onBack && <Button label="Automation list" colors={colors} onPress={onBack} />}
    <View style={styles.rowBetween}>
      <View style={styles.flex}>
        <Text style={[styles.title, { color: colors.ink }]}>{schedule.displayName}</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>{schedule.source === "project" ? "Project Automation" : "Dialogue Automation"}</Text>
      </View>
      <Text style={[styles.badge, { color: colors.ink, backgroundColor: colors.brandBackground }]}>{schedule.state}</Text>
    </View>
    {!online && <Notice colors={colors} text="Reconnect to load exact details and run history. Automation controls are read-only." />}
    {(localError || automations.error) && <Notice colors={colors} danger text={localError || automations.error || ""} />}
    <View style={styles.actionRow}>
      <Button label="Run now" colors={colors} disabled={disabled}
        onPress={() => void onRun(() => client.runAutomation(schedule.scheduleId))} />
      <Button label={schedule.state === "disabled" ? "Resume" : "Pause"} colors={colors} disabled={disabled}
        onPress={toggle} />
      <Button label="Refresh" colors={colors} disabled={state.status !== "connected" || automations.status === "loading"}
        onPress={() => void onRun(() => client.refreshAutomations(schedule.scheduleId))} />
    </View>
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Info label="Timing" value={schedule.recurrenceLabel} colors={colors} />
      <Info label="Task mode" value={schedule.sessionMode} colors={colors} />
      <Info label="Execution" value={schedule.executionMode} colors={colors} />
      <Info label="Time zone" value={schedule.timeZone} colors={colors} />
      <Info label="Overlap" value={schedule.overlapPolicy} colors={colors} />
      <Info label="Missed run" value={schedule.misfirePolicy} colors={colors} />
      {schedule.nextTriggerAt !== undefined && <Info label="Next run" value={formatDate(schedule.nextTriggerAt)} colors={colors} />}
      {schedule.lastTriggeredAt !== undefined && <Info label="Last run" value={formatDate(schedule.lastTriggeredAt)} colors={colors} />}
      {schedule.projectConfigPath && <Info label="Project source" value={schedule.projectConfigPath} colors={colors} />}
      {detail && <Text style={[styles.body, { color: colors.ink }]}>{detail.inputText || "No scheduled input"}</Text>}
    </View>
    <View style={styles.rowBetween}>
      <Text style={[styles.section, { color: colors.muted }]}>Run history ({automations.history.length}/{automations.historyTotalSize})</Text>
      {schedule.unreadRunCount > 0 && <Button label="Mark schedule read" colors={colors} compact disabled={disabled}
        onPress={markScheduleRead} />}
    </View>
    {automations.historyStatus === "loading" && automations.history.length === 0
      ? <Centered colors={colors} label="Loading run history…" loading />
      : automations.history.length === 0
        ? <Centered colors={colors} label={online ? "No runs yet" : "Run history is not cached"} />
        : automations.history.map((run) => <RunCard key={run.triggerId} run={run} schedule={schedule}
          colors={colors} client={client} disabled={disabled} onRun={onRun} onOpenTask={onOpenTask}
          setLocalError={setLocalError} sessionAvailable={run.sessionId !== undefined
            && state.owner?.sessions.filter((session) => session.sessionId === run.sessionId).length === 1} />)}
    {automations.historyNextPageToken && <Button label={automations.historyStatus === "loading-more" ? "Loading more…" : "Load more runs"}
      colors={colors} disabled={!online || automations.historyStatus !== "ready"}
      onPress={() => void onRun(() => client.loadMoreAutomationHistory())} />}
  </ScrollView>;
}

function RunCard({ run, schedule, colors, client, disabled, onRun, onOpenTask, setLocalError, sessionAvailable }: {
  readonly run: MobileAutomationRun;
  readonly schedule: MobileAutomationSchedule;
  readonly colors: MobileAutomationsColors;
  readonly client: MobileAutomationsClient;
  readonly disabled: boolean;
  readonly onRun: (action: () => Promise<unknown>) => Promise<void>;
  readonly onOpenTask: () => void;
  readonly setLocalError: (value: string) => void;
  readonly sessionAvailable: boolean;
}) {
  const unread = isMobileAutomationRunUnread(run);
  const terminal = isMobileAutomationRunTerminal(run);
  const restartable = canRestartMobileAutomationRun(run);
  const deleteRun = (): void => Alert.alert(
    "Delete run history?",
    "This removes only this terminal run record. Any task created by the run is kept.",
    [{ text: "Keep", style: "cancel" }, { text: "Delete", style: "destructive",
      onPress: () => void onRun(() => client.deleteAutomationRun(schedule.scheduleId, run.triggerId)) }]
  );
  const openTask = (): void => {
    setLocalError("");
    void client.openAutomationRunTask(schedule.scheduleId, run.triggerId).then(onOpenTask)
      .catch((error) => setLocalError(errorText(error)));
  };
  return <View accessibilityLabel={`Automation run ${run.state}`}
    style={[styles.card, unread && { borderColor: colors.accent }, { backgroundColor: colors.surface, borderColor: unread ? colors.accent : colors.border }]}>
    <View style={styles.rowBetween}>
      <View style={styles.flex}>
        <Text style={[styles.label, { color: colors.ink }]}>{runStateLabel(run.state)}</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>{formatDate(run.triggeredAt)} · {formatDuration(run.durationMs)}</Text>
      </View>
      {unread && <Text style={[styles.badge, { color: colors.ink, backgroundColor: colors.brandBackground }]}>Unread</Text>}
    </View>
    <Text style={[styles.caption, { color: colors.muted }]}>{runCost(run)}</Text>
    {run.resultText && <Text style={[styles.body, { color: colors.ink }]}>{run.resultText}</Text>}
    {run.error && <Text accessibilityRole="alert" style={[styles.body, { color: colors.negative }]}>{run.error}</Text>}
    {run.preRun && <View style={[styles.preRun, { borderColor: colors.border }]}>
      <Text style={[styles.caption, { color: colors.muted }]}>Pre-run: {run.preRun.status} · {run.preRun.decision} · {formatDuration(run.preRun.durationMs)}</Text>
      {run.preRun.stdout && <Text style={[styles.mono, { color: colors.ink }]}>{run.preRun.stdout}</Text>}
      {run.preRun.stderr && <Text style={[styles.mono, { color: colors.negative }]}>{run.preRun.stderr}</Text>}
    </View>}
    <View style={styles.actionRow}>
      {unread && <Button label="Mark read" compact colors={colors} disabled={disabled}
        onPress={() => void onRun(() => client.markAutomationRunRead(schedule.scheduleId, run.triggerId))} />}
      {run.sessionId && <Button label={sessionAvailable ? "Open task" : "Task unavailable"} compact colors={colors}
        disabled={!sessionAvailable} onPress={openTask} />}
      {restartable && <Button label="Restart" compact colors={colors} disabled={disabled}
        onPress={() => void onRun(() => client.restartAutomationRun(schedule.scheduleId, run.triggerId))} />}
      {terminal && <Button label="Delete history" compact danger colors={colors} disabled={disabled} onPress={deleteRun} />}
    </View>
  </View>;
}

function Info({ label, value, colors }: { readonly label: string; readonly value: string; readonly colors: MobileAutomationsColors }) {
  return <View style={styles.infoRow}>
    <Text style={[styles.caption, { color: colors.muted }]}>{label}</Text>
    <Text style={[styles.body, styles.infoValue, { color: colors.ink }]}>{value}</Text>
  </View>;
}

function Button({ label, onPress, colors, disabled = false, compact = false, danger = false }: {
  readonly label: string;
  readonly onPress: () => void;
  readonly colors: MobileAutomationsColors;
  readonly disabled?: boolean;
  readonly compact?: boolean;
  readonly danger?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}
    disabled={disabled} onPress={onPress}
    style={[styles.button, compact && styles.compactButton, { borderColor: colors.border,
      backgroundColor: colors.surface, opacity: disabled ? 0.45 : 1 }]}>
    <Text style={[styles.buttonText, { color: danger ? colors.negative : colors.ink }]}>{label}</Text>
  </Pressable>;
}

function Notice({ text, colors, danger = false }: {
  readonly text: string;
  readonly colors: MobileAutomationsColors;
  readonly danger?: boolean;
}) {
  return <View accessibilityRole="alert" style={[styles.notice, { backgroundColor: colors.surface, borderColor: danger ? colors.negative : colors.border }]}>
    <Text style={[styles.caption, { color: danger ? colors.negative : colors.muted }]}>{text}</Text>
  </View>;
}

function Centered({ label, colors, loading = false }: {
  readonly label: string;
  readonly colors: MobileAutomationsColors;
  readonly loading?: boolean;
}) {
  return <View style={styles.centered}>{loading && <ActivityIndicator color={colors.accent} />}
    <Text style={[styles.body, { color: colors.muted }]}>{label}</Text></View>;
}

function runStateLabel(state: MobileAutomationRun["state"]): string {
  if (state === "completed") return "Completed";
  if (state === "failed") return "Failed";
  if (state === "skipped") return "Skipped";
  if (state === "aborted") return "Aborted";
  if (state === "interrupted") return "Interrupted";
  if (state === "queued") return "Queued";
  return "Running";
}

function formatDate(value: number): string {
  return new Date(value).toLocaleString();
}

function formatDuration(value: number | undefined): string {
  if (value === undefined) return "duration unavailable";
  if (value < 1_000) return `${value} ms`;
  const seconds = Math.round(value / 100) / 10;
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

function runCost(run: MobileAutomationRun): string {
  const cost = run.cost ?? run.estimatedValue;
  if (cost) {
    const sign = cost.amountMicros < 0n ? "-" : "";
    const absolute = cost.amountMicros < 0n ? -cost.amountMicros : cost.amountMicros;
    const whole = absolute / 1_000_000n;
    const fraction = (absolute % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "") || "0";
    return `${cost.approximate ? "≈" : ""}${sign}${whole.toString()}.${fraction} ${cost.currencyCode} · ${run.costAttribution}`;
  }
  if (run.zeroCost || run.costAttribution === "zero") return "Zero token cost";
  return `Cost ${run.costAttribution}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  wide: { flexDirection: "row" },
  listPane: { flex: 1, padding: 12, gap: 10 },
  wideListPane: { maxWidth: 420 },
  detailPane: { flex: 1, borderLeftWidth: 1 },
  detail: { padding: 16, gap: 12 },
  headerRow: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: 10 },
  headerText: { flex: 1 },
  title: { fontSize: 24, lineHeight: 30, fontWeight: "700" },
  section: { marginTop: 10, marginBottom: 6, fontSize: 12, lineHeight: 17, fontWeight: "700", textTransform: "uppercase" },
  label: { fontSize: 16, lineHeight: 22, fontWeight: "600" },
  body: { fontSize: 14, lineHeight: 20 },
  caption: { fontSize: 12, lineHeight: 17 },
  mono: { fontSize: 12, lineHeight: 17, fontFamily: "monospace" },
  flex: { flex: 1 },
  filterRow: { flexDirection: "row", gap: 8 },
  filter: { minHeight: 44, minWidth: 72, borderWidth: 1, borderRadius: 12, alignItems: "center", justifyContent: "center", paddingHorizontal: 12 },
  scheduleList: { gap: 8, paddingBottom: 24 },
  card: { borderWidth: 1, borderRadius: 14, padding: 12, gap: 6, marginBottom: 8 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  button: { minHeight: 44, borderWidth: 1, borderRadius: 12, alignItems: "center", justifyContent: "center", paddingHorizontal: 12, paddingVertical: 8 },
  compactButton: { minHeight: 40, paddingHorizontal: 10, paddingVertical: 6 },
  buttonText: { fontSize: 13, lineHeight: 18, fontWeight: "600" },
  badge: { borderRadius: 999, overflow: "hidden", paddingHorizontal: 8, paddingVertical: 3, fontSize: 11, lineHeight: 15 },
  notice: { minHeight: 44, borderWidth: 1, borderRadius: 12, justifyContent: "center", paddingHorizontal: 12, paddingVertical: 8 },
  centered: { flex: 1, minHeight: 160, alignItems: "center", justifyContent: "center", gap: 10, padding: 20 },
  infoRow: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  infoValue: { flex: 1, textAlign: "right" },
  preRun: { borderTopWidth: 1, paddingTop: 8, gap: 4 }
});
