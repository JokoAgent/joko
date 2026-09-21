import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
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
import {
  applyMobileAutomationTemplate,
  createMobileAutomationDraft,
  mobileAutomationDraftKey,
  mobileAutomationExtraDirectoryOptions,
  mobileAutomationModelOptions,
  mobileAutomationPermissionOptions,
  mobileAutomationSessionOptions,
  mobileAutomationTargetOptions,
  mobileAutomationTemplates,
  type MobileAutomationDeletionOutcome,
  type MobileAutomationDeletionPreview,
  type MobileAutomationDisposition,
  type MobileAutomationDraft,
  type MobileAutomationTemplateId,
  type MobileAutomationWorktreeProof
} from "./mobile-automation-authoring";
import {
  formatMobileAutomationCost,
  formatMobileAutomationDate,
  formatMobileAutomationDuration,
  mobileAutomationDirectoryAccessLabel,
  mobileAutomationExecutionModeLabel,
  mobileAutomationFilterLabel,
  mobileAutomationMisfireLabel,
  mobileAutomationOverlapLabel,
  mobileAutomationPermissionLabel,
  mobileAutomationPreRunDecisionLabel,
  mobileAutomationPreRunStatusLabel,
  mobileAutomationRecurrenceKindLabel,
  mobileAutomationRecurrenceLabel,
  mobileAutomationRunStateLabel,
  mobileAutomationScheduleSourceLabel,
  mobileAutomationScheduleStateLabel,
  mobileAutomationSessionModeLabel,
  mobileAutomationTemplatePresentation,
  mobileAutomationWorktreeEligibilityLabel
} from "./mobile-automation-presentation";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import { resolveMobileNewTaskExecutionAuthority } from "./mobile-runtime-controls";
import { mobileScheduleLocalDateTimeFromEpoch } from "./mobile-schedule-time";

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
  | "markAllAutomationRunsRead" | "deleteAutomationRun" | "openAutomationRunTask"
  | "loadAutomationWorktree" | "saveAutomation" | "prepareAutomationDeletion" | "deleteAutomation"
  | "promoteAutomation" | "cloneProjectAutomation" | "removeProjectAutomation"
  | "reconcileProjectAutomations">;

export interface MobileAutomationsScreenProps {
  readonly colors: MobileAutomationsColors;
  readonly state: MobileState;
  readonly locale: MobileSupportedLocale;
  readonly client: MobileAutomationsClient;
  readonly onBack: () => void;
  readonly onOpenTask: () => void;
}

export function MobileAutomationsScreen({ colors, state, locale, client, onBack, onOpenTask }: MobileAutomationsScreenProps) {
  const { width } = useWindowDimensions();
  const [narrowDetail, setNarrowDetail] = useState(false);
  const [localError, setLocalError] = useState("");
  const [editor, setEditor] = useState<{
    readonly schedule?: MobileAutomationSchedule;
    readonly draft: MobileAutomationDraft;
  }>();
  const [deleting, setDeleting] = useState<MobileAutomationSchedule>();
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

  const openEditor = (schedule?: MobileAutomationSchedule): void => {
    setLocalError("");
    try { setEditor({ ...(schedule === undefined ? {} : { schedule }), draft: createMobileAutomationDraft(state.owner, schedule) }); }
    catch (error) { setLocalError(errorText(error)); }
  };

  const list = <View style={[styles.listPane, wide && styles.wideListPane]}>
    <View style={styles.headerRow}>
      <Button label={mobileMessage(locale, "common.back")} colors={colors} onPress={leave} />
      <View style={styles.headerText}>
        <Text style={[styles.title, { color: colors.ink }]}>{mobileMessage(locale, "automation.title")}</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>
          {mobileMessage(locale, "automation.summary", { schedules: automations.schedules.length, unread: unreadTotal })}
        </Text>
      </View>
      <Button label={mobileMessage(locale, "common.new")} colors={colors} disabled={!online || state.busy} onPress={() => openEditor()} />
      <Button label={mobileMessage(locale, "common.refresh")} colors={colors} disabled={state.status !== "connected" || automations.status === "loading"}
        onPress={() => void run(() => client.refreshAutomations())} />
    </View>
    {automations.status === "offline" && <Notice colors={colors}
      text={mobileMessage(locale, "automation.offlineSummary")} />}
    {(localError || automations.error) && <Notice colors={colors} danger text={localError || automations.error || ""} />}
    <View accessibilityRole="tablist" style={styles.filterRow}>
      {(["all", "active", "paused"] as const).map((filter) => <Pressable key={filter} accessibilityRole="tab"
        accessibilityLabel={mobileMessage(locale, "automation.filter.accessibility", {
          filter: mobileAutomationFilterLabel(locale, filter)
        })}
        accessibilityState={{ selected: automations.filter === filter }}
        onPress={() => client.setAutomationFilter(filter)}
        style={[styles.filter, { borderColor: automations.filter === filter ? colors.accent : colors.border,
          backgroundColor: automations.filter === filter ? colors.brandBackground : colors.surface }]}>
        <Text style={[styles.buttonText, { color: colors.ink }]}>{mobileAutomationFilterLabel(locale, filter)}</Text>
      </Pressable>)}
    </View>
    {online && unreadTotal > 0 && <Button label={mobileMessage(locale, "automation.markAllRead")} colors={colors} disabled={state.busy}
      onPress={() => void run(() => client.markAllAutomationRunsRead())} />}
    {automations.status === "loading" && automations.schedules.length === 0
      ? <Centered colors={colors} label={mobileMessage(locale, "automation.loading")} loading />
      : groups.length === 0
        ? <View style={styles.emptyState}>
          <Centered colors={colors} label={automations.filter === "all"
            ? mobileMessage(locale, "automation.empty.all")
            : automations.filter === "active"
              ? mobileMessage(locale, "automation.empty.active")
              : mobileMessage(locale, "automation.empty.paused")} />
          {automations.filter === "all" && <Button label={mobileMessage(locale, "automation.create")} colors={colors} disabled={!online || state.busy}
            onPress={() => openEditor()} />}
        </View>
        : <ScrollView contentContainerStyle={styles.scheduleList}>
          {groups.map((group) => <View key={group.kind}>
            <Text style={[styles.section, { color: colors.muted }]}>{mobileMessage(locale,
              group.kind === "project" ? "common.project" : "common.dialogue")}</Text>
            {group.schedules.map((schedule) => <ScheduleRow key={schedule.scheduleId} schedule={schedule}
              selected={schedule.scheduleId === automations.selectedScheduleId} colors={colors} locale={locale}
              onPress={() => select(schedule)} />)}
          </View>)}
        </ScrollView>}
  </View>;

  const detail = <AutomationDetail colors={colors} state={state} schedule={selected} client={client} locale={locale}
    online={online} localError={localError} setLocalError={setLocalError} onRun={run}
    onBack={wide ? undefined : () => setNarrowDetail(false)} onOpenTask={onOpenTask}
    onEdit={openEditor} onDelete={setDeleting} />;

  if (editor !== undefined) return <View style={[styles.root, { backgroundColor: colors.background }]}>
    <AutomationEditor colors={colors} state={state} client={client} initialDraft={editor.draft} locale={locale}
      schedule={editor.schedule} onClose={() => setEditor(undefined)} />
  </View>;
  if (deleting !== undefined) return <View style={[styles.root, { backgroundColor: colors.background }]}>
    <AutomationDeletePanel colors={colors} state={state} client={client} schedule={deleting} locale={locale}
      onClose={() => setDeleting(undefined)} />
  </View>;

  if (!wide && narrowDetail && selected) return <View style={[styles.root, { backgroundColor: colors.background }]}>{detail}</View>;
  return <View style={[styles.root, wide && styles.wide, { backgroundColor: colors.background }]}>
    {list}
    {wide && <View style={[styles.detailPane, { borderColor: colors.border }]}>{detail}</View>}
  </View>;
}

function ScheduleRow({ schedule, selected, colors, locale, onPress }: {
  readonly schedule: MobileAutomationSchedule;
  readonly selected: boolean;
  readonly colors: MobileAutomationsColors;
  readonly locale: MobileSupportedLocale;
  readonly onPress: () => void;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "automation.schedule.open", {
    name: schedule.displayName
  })}
    accessibilityState={{ selected }} onPress={onPress}
    style={[styles.card, { backgroundColor: selected ? colors.brandBackground : colors.surface,
      borderColor: selected ? colors.accent : colors.border }]}>
    <View style={styles.rowBetween}>
      <Text style={[styles.label, styles.flex, { color: colors.ink }]} numberOfLines={1}>{schedule.displayName}</Text>
      {schedule.unreadRunCount > 0 && <Text accessibilityLabel={mobileMessage(locale, "automation.schedule.unread", {
        count: schedule.unreadRunCount
      })}
        style={[styles.badge, { color: colors.ink, backgroundColor: colors.brandBackground }]}>{schedule.unreadRunCount}</Text>}
    </View>
    <Text style={[styles.caption, { color: colors.muted }]}>{mobileAutomationScheduleStateLabel(locale, schedule.state)} · {mobileAutomationRecurrenceLabel(locale, schedule)}</Text>
    <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={1}>{schedule.inputText || mobileMessage(locale, "automation.schedule.noInput")}</Text>
  </Pressable>;
}

function AutomationDetail({ colors, state, schedule, client, online, localError, setLocalError, onRun, onBack, onOpenTask,
  onEdit, onDelete, locale }: {
  readonly colors: MobileAutomationsColors;
  readonly state: MobileState;
  readonly locale: MobileSupportedLocale;
  readonly schedule?: MobileAutomationSchedule;
  readonly client: MobileAutomationsClient;
  readonly online: boolean;
  readonly localError: string;
  readonly setLocalError: (value: string) => void;
  readonly onRun: (action: () => Promise<unknown>) => Promise<void>;
  readonly onBack?: () => void;
  readonly onOpenTask: () => void;
  readonly onEdit: (schedule: MobileAutomationSchedule) => void;
  readonly onDelete: (schedule: MobileAutomationSchedule) => void;
}) {
  const automations = state.automations;
  if (!schedule) return <Centered colors={colors} label={mobileMessage(locale, "automation.select")} />;
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
        mobileMessage(locale, "automation.pause.title", { name: schedule.displayName }),
        inFlight === 1 ? mobileMessage(locale, "automation.pause.body.one")
          : mobileMessage(locale, "automation.pause.body.many", { count: inFlight }),
        [{ text: mobileMessage(locale, "automation.pause.keepRunning"), style: "cancel" },
          { text: mobileMessage(locale, "automation.action.pause"), style: "destructive", onPress: apply }]
      );
    } else apply();
  };
  const markScheduleRead = (): void => {
    void onRun(() => client.markAutomationRunsRead(schedule.scheduleId));
  };
  const promote = (): void => Alert.alert(
    mobileMessage(locale, "automation.promote.title"),
    mobileMessage(locale, "automation.promote.body"),
    [{ text: mobileMessage(locale, "common.cancel"), style: "cancel" },
      { text: mobileMessage(locale, "automation.promote.confirm"), onPress: () => void onRun(() => client.promoteAutomation(schedule.scheduleId)) }]
  );
  const clone = (): void => {
    void onRun(() => client.cloneProjectAutomation(schedule.scheduleId,
      mobileMessage(locale, "automation.copyName", { name: schedule.displayName })));
  };
  const removeProject = (): void => Alert.alert(
    mobileMessage(locale, "automation.removeProject.title"),
    mobileMessage(locale, "automation.removeProject.body"),
    [
      { text: mobileMessage(locale, "common.cancel"), style: "cancel" },
      { text: mobileMessage(locale, "automation.removeProject.confirm"), style: "destructive", onPress: () => void onRun(() => client.removeProjectAutomation(schedule.scheduleId, false)) },
      { text: mobileMessage(locale, "automation.removeProject.keepCopy"), onPress: () => void onRun(() => client.removeProjectAutomation(schedule.scheduleId, true)) }
    ]
  );
  return <ScrollView contentContainerStyle={styles.detail}>
    {onBack && <Button label={mobileMessage(locale, "automation.list")} colors={colors} onPress={onBack} />}
    <View style={styles.rowBetween}>
      <View style={styles.flex}>
        <Text style={[styles.title, { color: colors.ink }]}>{schedule.displayName}</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>{mobileAutomationScheduleSourceLabel(locale, schedule.source)}</Text>
      </View>
      <Text style={[styles.badge, { color: colors.ink, backgroundColor: colors.brandBackground }]}>{mobileAutomationScheduleStateLabel(locale, schedule.state)}</Text>
    </View>
    {!online && <Notice colors={colors} text={mobileMessage(locale, "automation.detail.offline")} />}
    {(localError || automations.error) && <Notice colors={colors} danger text={localError || automations.error || ""} />}
    <View style={styles.actionRow}>
      <Button label={mobileMessage(locale, "automation.action.runNow")} colors={colors} disabled={disabled}
        onPress={() => void onRun(() => client.runAutomation(schedule.scheduleId))} />
      <Button label={schedule.state === "disabled" ? mobileMessage(locale, "automation.action.resume")
        : mobileMessage(locale, "automation.action.pause")} colors={colors} disabled={disabled}
        onPress={toggle} />
      <Button label={mobileMessage(locale, "common.refresh")} colors={colors} disabled={state.status !== "connected" || automations.status === "loading"}
        onPress={() => void onRun(() => client.refreshAutomations(schedule.scheduleId))} />
      <Button label={mobileMessage(locale, "common.edit")} colors={colors} disabled={disabled || detail === undefined} onPress={() => onEdit(detail ?? schedule)} />
      {schedule.source === "dialogue"
        ? <>
          <Button label={mobileMessage(locale, "automation.action.promote")} colors={colors} disabled={disabled || schedule.sessionMode === "bound"} onPress={promote} />
          <Button label={mobileMessage(locale, "automation.action.delete")} danger colors={colors} disabled={disabled} onPress={() => onDelete(schedule)} />
        </>
        : <>
          <Button label={mobileMessage(locale, "automation.action.clone")} colors={colors} disabled={disabled} onPress={clone} />
          <Button label={mobileMessage(locale, "automation.action.reconcile")} colors={colors} disabled={disabled}
            onPress={() => void onRun(() => client.reconcileProjectAutomations(schedule.targetId))} />
          <Button label={mobileMessage(locale, "automation.action.removeProject")} danger colors={colors} disabled={disabled} onPress={removeProject} />
        </>}
    </View>
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Info label={mobileMessage(locale, "automation.info.timing")} value={mobileAutomationRecurrenceLabel(locale, schedule)} colors={colors} />
      <Info label={mobileMessage(locale, "automation.info.taskMode")} value={mobileAutomationSessionModeLabel(locale, schedule.sessionMode)} colors={colors} />
      <Info label={mobileMessage(locale, "automation.info.execution")} value={mobileAutomationExecutionModeLabel(locale, schedule.executionMode)} colors={colors} />
      <Info label={mobileMessage(locale, "automation.info.timeZone")} value={schedule.timeZone} colors={colors} />
      <Info label={mobileMessage(locale, "automation.info.overlap")} value={mobileAutomationOverlapLabel(locale, schedule.overlapPolicy)} colors={colors} />
      <Info label={mobileMessage(locale, "automation.info.missedRun")} value={mobileAutomationMisfireLabel(locale, schedule.misfirePolicy)} colors={colors} />
      {schedule.nextTriggerAt !== undefined && <Info label={mobileMessage(locale, "automation.info.nextRun")}
        value={formatMobileAutomationDate(schedule.nextTriggerAt, locale, schedule.timeZone)} colors={colors} />}
      {schedule.lastTriggeredAt !== undefined && <Info label={mobileMessage(locale, "automation.info.lastRun")}
        value={formatMobileAutomationDate(schedule.lastTriggeredAt, locale, schedule.timeZone)} colors={colors} />}
      {schedule.projectConfigPath && <Info label={mobileMessage(locale, "automation.info.projectSource")} value={schedule.projectConfigPath} colors={colors} />}
      {detail && <Text style={[styles.body, { color: colors.ink }]}>{detail.inputText || mobileMessage(locale, "automation.schedule.noInput")}</Text>}
    </View>
    <View style={styles.rowBetween}>
      <Text style={[styles.section, { color: colors.muted }]}>{mobileMessage(locale, "automation.history.title", {
        loaded: automations.history.length, total: automations.historyTotalSize
      })}</Text>
      {schedule.unreadRunCount > 0 && <Button label={mobileMessage(locale, "automation.history.markScheduleRead")} colors={colors} compact disabled={disabled}
        onPress={markScheduleRead} />}
    </View>
    {automations.historyStatus === "loading" && automations.history.length === 0
      ? <Centered colors={colors} label={mobileMessage(locale, "automation.history.loading")} loading />
      : automations.history.length === 0
        ? <Centered colors={colors} label={online ? mobileMessage(locale, "automation.history.empty")
          : mobileMessage(locale, "automation.history.uncached")} />
        : automations.history.map((run) => <RunCard key={run.triggerId} run={run} schedule={schedule}
          colors={colors} client={client} disabled={disabled} onRun={onRun} onOpenTask={onOpenTask} locale={locale}
          setLocalError={setLocalError} sessionAvailable={run.sessionId !== undefined
            && state.owner?.sessions.filter((session) => session.sessionId === run.sessionId).length === 1} />)}
    {automations.historyNextPageToken && <Button label={automations.historyStatus === "loading-more"
      ? mobileMessage(locale, "automation.history.loadingMore") : mobileMessage(locale, "automation.history.loadMore")}
      colors={colors} disabled={!online || automations.historyStatus !== "ready"}
      onPress={() => void onRun(() => client.loadMoreAutomationHistory())} />}
  </ScrollView>;
}

function AutomationEditor({ colors, state, client, schedule, initialDraft, locale, onClose }: {
  readonly colors: MobileAutomationsColors;
  readonly state: MobileState;
  readonly client: MobileAutomationsClient;
  readonly schedule?: MobileAutomationSchedule;
  readonly initialDraft: MobileAutomationDraft;
  readonly locale: MobileSupportedLocale;
  readonly onClose: () => void;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [templateParameter, setTemplateParameter] = useState("");
  const [worktree, setWorktree] = useState<MobileAutomationWorktreeProof>();
  const [worktreeLoading, setWorktreeLoading] = useState(false);
  const worktreeLoadSequence = useRef(0);
  useEffect(() => () => { worktreeLoadSequence.current += 1; }, []);
  const online = state.status === "connected" && state.automations.status === "ready";
  const authoringPending = state.pending.some((pending) => [
    "schedule-create", "schedule-update", "schedule-delete", "schedule-promote", "schedule-clone",
    "schedule-project-remove", "schedule-project-reconcile"
  ].includes(pending.kind) && (schedule !== undefined && pending.scheduleId === schedule.scheduleId
    || pending.targetId !== undefined && pending.targetId === draft.targetId));
  const editable = online && !state.busy && !saving && !authoringPending;
  const dirty = mobileAutomationDraftKey(draft) !== mobileAutomationDraftKey(initialDraft);
  const targets = useMemo(() => mobileAutomationTargetOptions(state.owner), [state.owner]);
  const sessions = useMemo(
    () => mobileAutomationSessionOptions(state.owner, draft.targetId),
    [draft.targetId, state.owner]
  );
  const models = useMemo(
    () => mobileAutomationModelOptions(state.owner, draft.backendId),
    [draft.backendId, state.owner]
  );
  const advertisedPermissions = useMemo(
    () => mobileAutomationPermissionOptions(state.owner, draft.backendId),
    [draft.backendId, state.owner]
  );
  const permissions = advertisedPermissions.includes(draft.permissionMode)
    ? advertisedPermissions : [draft.permissionMode, ...advertisedPermissions];
  const extraDirectories = useMemo(
    () => mobileAutomationExtraDirectoryOptions(state.owner, draft.targetId),
    [draft.targetId, state.owner]
  );
  const execution = resolveMobileNewTaskExecutionAuthority(state.owner, draft.backendId);
  const selectedTarget = targets.find((target) => target.targetId === draft.targetId);
  const selectedModel = draft.model === undefined ? undefined : models.find((model) =>
    model.providerId === draft.model?.providerId && model.modelId === draft.model.modelId);
  const worktreeCompatible = draft.executionMode === "agent" && draft.sessionMode === "fresh"
    && selectedTarget?.workspaceKind === "project" && selectedTarget.projectAutomationEligible;
  const set = <K extends keyof MobileAutomationDraft>(key: K, value: MobileAutomationDraft[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const close = (): void => {
    if (!dirty) { onClose(); return; }
    Alert.alert(
      mobileMessage(locale, "automation.editor.discardTitle"),
      mobileMessage(locale, "automation.editor.discardBody"),
      [{ text: mobileMessage(locale, "automation.editor.keepEditing"), style: "cancel" },
        { text: mobileMessage(locale, "common.discard"), style: "destructive", onPress: onClose }]
    );
  };
  const chooseTarget = (targetId: string): void => {
    const target = targets.find((candidate) => candidate.targetId === targetId);
    if (!target) return;
    const nextPermissions = mobileAutomationPermissionOptions(state.owner, target.backendId);
    worktreeLoadSequence.current += 1;
    setWorktree(undefined);
    setWorktreeLoading(false);
    setDraft((current) => ({
      ...current,
      targetId: target.targetId,
      backendId: target.backendId,
      sessionMode: "fresh",
      sessionId: "",
      model: undefined,
      permissionMode: nextPermissions[0] ?? "ask",
      planMode: false,
      useWorktree: false,
      worktreeSourceRef: undefined,
      refreshWorktreeRemote: false,
      extraDirectoryIds: []
    }));
  };
  const chooseExecutionMode = (mode: MobileAutomationDraft["executionMode"]): void => {
    setDraft((current) => mode === "agent" ? { ...current, executionMode: mode } : {
      ...current,
      executionMode: mode,
      sessionMode: "fresh",
      sessionId: "",
      model: undefined,
      planMode: false,
      useWorktree: false,
      worktreeSourceRef: undefined,
      refreshWorktreeRemote: false,
      extraDirectoryIds: [],
      silentWhenIdle: false
    });
    if (mode === "script") {
      worktreeLoadSequence.current += 1;
      setWorktree(undefined);
      setWorktreeLoading(false);
    }
  };
  const chooseSessionMode = (mode: MobileAutomationDraft["sessionMode"]): void => {
    setDraft((current) => ({
      ...current,
      sessionMode: mode,
      sessionId: mode === "fresh" ? "" : mode === "bound" ? current.sessionId || sessions[0]?.sessionId || "" : current.sessionId,
      ...(mode === "fresh" ? {} : {
        useWorktree: false,
        worktreeSourceRef: undefined,
        refreshWorktreeRemote: false
      })
    }));
    if (mode !== "fresh") {
      worktreeLoadSequence.current += 1;
      setWorktree(undefined);
      setWorktreeLoading(false);
    }
  };
  const chooseModel = (providerId?: string, modelId?: string): void => {
    if (!providerId || !modelId) { set("model", undefined); return; }
    const route = models.find((candidate) => candidate.providerId === providerId && candidate.modelId === modelId);
    if (!route) return;
    const effortId = route.efforts.find((effort) => effort.default)?.id;
    set("model", { providerId, modelId, ...(effortId === undefined ? {} : { effortId }), fastMode: false });
  };
  const loadWorktree = async (): Promise<void> => {
    const sequence = ++worktreeLoadSequence.current;
    setError("");
    setWorktreeLoading(true);
    try {
      const proof = await client.loadAutomationWorktree(draft.targetId);
      if (sequence !== worktreeLoadSequence.current) return;
      setWorktree(proof);
      if (draft.worktreeSourceRef !== undefined
        && !proof.sources.some((source) => source.ref === draft.worktreeSourceRef)) {
        set("worktreeSourceRef", undefined);
      }
    } catch (cause) {
      if (sequence === worktreeLoadSequence.current) setError(errorText(cause));
    } finally {
      if (sequence === worktreeLoadSequence.current) setWorktreeLoading(false);
    }
  };
  const toggleWorktree = (): void => {
    const enabled = !draft.useWorktree;
    if (enabled && !worktreeCompatible) return;
    setDraft((current) => ({
      ...current,
      useWorktree: enabled,
      ...(enabled ? {} : { worktreeSourceRef: undefined, refreshWorktreeRemote: false })
    }));
    if (enabled) void loadWorktree();
    else {
      worktreeLoadSequence.current += 1;
      setWorktree(undefined);
      setWorktreeLoading(false);
    }
  };
  const applyTemplate = (templateId: MobileAutomationTemplateId): void => {
    setError("");
    const value = templateParameter.trim();
    const presentation = mobileAutomationTemplatePresentation(locale, templateId, value);
    if (presentation.parameter !== undefined && value === "") {
      setError(mobileMessage(locale, "automation.editor.templateParameterRequired", {
        label: presentation.parameter.label
      }));
      return;
    }
    try {
      setDraft((current) => ({
        ...applyMobileAutomationTemplate(current, templateId, value),
        name: presentation.name,
        inputText: presentation.prompt
      }));
    }
    catch (cause) { setError(errorText(cause)); }
  };
  const save = async (): Promise<void> => {
    if (!editable) return;
    setError("");
    setSaving(true);
    try {
      const result = await client.saveAutomation(draft, schedule?.scheduleId);
      if (result === undefined) {
        setError(mobileMessage(locale, "automation.editor.saveUnknown"));
        return;
      }
      onClose();
    } catch (cause) { setError(errorText(cause)); }
    finally { setSaving(false); }
  };
  const recurrenceLabel = draft.recurrence === "once" ? mobileMessage(locale, "automation.recurrence.field.once")
    : draft.recurrence === "interval" ? mobileMessage(locale, "automation.recurrence.field.interval")
      : mobileMessage(locale, "automation.recurrence.field.cron");
  return <ScrollView contentContainerStyle={styles.editor}>
    <View style={styles.headerRow}>
      <Button label={mobileMessage(locale, "automation.editor.close")} colors={colors} disabled={saving} onPress={close} />
      <View style={styles.headerText}>
        <Text style={[styles.title, { color: colors.ink }]}>{schedule ? mobileMessage(locale, "automation.editor.title.edit")
          : mobileMessage(locale, "automation.editor.title.new")}</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>{dirty ? mobileMessage(locale, "automation.editor.dirty")
          : mobileMessage(locale, "automation.editor.clean")}</Text>
      </View>
      <Button label={saving ? mobileMessage(locale, "common.saving") : mobileMessage(locale, "common.save")} colors={colors} disabled={!editable}
        onPress={() => void save()} />
    </View>
    {!online && <Notice colors={colors} text={mobileMessage(locale, "automation.editor.offline")} />}
    {authoringPending && <Notice colors={colors} text={mobileMessage(locale, "automation.editor.pending")} />}
    {(error || state.error) && <Notice colors={colors} danger text={error || state.error || ""} />}

    <EditorSection title={mobileMessage(locale, "automation.editor.templates")} colors={colors}>
      <TextInput accessibilityLabel={mobileMessage(locale, "automation.editor.templateParameter")} value={templateParameter} editable={editable}
        onChangeText={setTemplateParameter} placeholder={mobileMessage(locale, "automation.editor.templatePlaceholder")}
        placeholderTextColor={colors.muted} style={[styles.input, { color: colors.ink, borderColor: colors.border, backgroundColor: colors.surface }]} />
      <View style={styles.optionRow}>{mobileAutomationTemplates().map((template) => {
        const presentation = mobileAutomationTemplatePresentation(locale, template.id);
        return <Choice key={template.id} label={presentation.name} selected={false} colors={colors} disabled={!editable}
          onPress={() => applyTemplate(template.id)} />;
      })}</View>
    </EditorSection>

    <EditorSection title={mobileMessage(locale, "automation.editor.identity")} colors={colors}>
      <EditorInput label={mobileMessage(locale, "automation.editor.name")} value={draft.name} colors={colors} editable={editable}
        onChange={(value) => set("name", value)} />
      <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "automation.editor.project")}</Text>
      <View style={styles.optionRow}>{targets.map((target) => <Choice key={target.targetId} label={target.displayName}
        selected={draft.targetId === target.targetId} colors={colors}
        disabled={!editable || schedule?.source === "project"} onPress={() => chooseTarget(target.targetId)} />)}</View>
      <Info label={mobileMessage(locale, "automation.editor.backend")} value={draft.backendId || mobileMessage(locale, "common.unavailable")} colors={colors} />
      <Choice label={draft.enabled ? mobileMessage(locale, "automation.schedule.state.enabled")
        : mobileMessage(locale, "automation.schedule.state.disabled")} selected={draft.enabled} colors={colors} disabled={!editable}
        onPress={() => set("enabled", !draft.enabled)} />
    </EditorSection>

    <EditorSection title={mobileMessage(locale, "automation.editor.schedule")} colors={colors}>
      <View style={styles.optionRow}>{(["manual", "once", "interval", "cron"] as const).map((value) =>
        <Choice key={value} label={mobileAutomationRecurrenceKindLabel(locale, value)} selected={draft.recurrence === value} colors={colors} disabled={!editable}
          onPress={() => setDraft((current) => current.recurrence === value ? current : {
            ...current,
            recurrence: value,
            expression: value === "manual" || value === "cron" ? ""
              : value === "interval" ? "3600"
                : mobileScheduleLocalDateTimeFromEpoch(Date.now() + 3_600_000, current.timeZone),
            intervalAnchorAt: undefined
          })} />)}</View>
      {draft.recurrence !== "manual" && <EditorInput label={recurrenceLabel} value={draft.expression} colors={colors}
        editable={editable} onChange={(value) => set("expression", value)} />}
      <EditorInput label={mobileMessage(locale, "automation.editor.timeZone")} value={draft.timeZone} colors={colors} editable={editable}
        onChange={(value) => set("timeZone", value)} />
      <EditorInput label={mobileMessage(locale, "automation.editor.expiration")} value={draft.expireAtExpression} colors={colors}
        editable={editable} placeholder="YYYY-MM-DDTHH:mm" onChange={(value) => set("expireAtExpression", value)} />
      <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "automation.editor.overlapPolicy")}</Text>
      <View style={styles.optionRow}>{(["queue", "skip"] as const).map((value) => <Choice key={value}
        label={mobileAutomationOverlapLabel(locale, value)}
        selected={draft.overlapPolicy === value} colors={colors} disabled={!editable} onPress={() => set("overlapPolicy", value)} />)}</View>
      <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "automation.editor.misfirePolicy")}</Text>
      <View style={styles.optionRow}>{(["runOnce", "skip"] as const).map((value) => <Choice key={value}
        label={mobileAutomationMisfireLabel(locale, value)}
        selected={draft.misfirePolicy === value} colors={colors} disabled={!editable} onPress={() => set("misfirePolicy", value)} />)}</View>
    </EditorSection>

    <EditorSection title={mobileMessage(locale, "automation.editor.execution")} colors={colors}>
      <View style={styles.optionRow}>{(["agent", "script"] as const).map((value) => <Choice key={value}
        label={mobileAutomationExecutionModeLabel(locale, value)}
        selected={draft.executionMode === value} colors={colors} disabled={!editable} onPress={() => chooseExecutionMode(value)} />)}</View>
      {draft.executionMode === "agent" ? <>
        <EditorInput label={mobileMessage(locale, "automation.editor.scheduledInput")} value={draft.inputText} colors={colors} editable={editable} multiline
          onChange={(value) => set("inputText", value)} />
        <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "automation.editor.taskMode")}</Text>
        <View style={styles.optionRow}>{(["fresh", "persistent", "bound"] as const).map((value) => <Choice key={value}
          label={mobileAutomationSessionModeLabel(locale, value)} selected={draft.sessionMode === value} colors={colors}
          disabled={!editable || schedule?.source === "project" && value === "bound"}
          onPress={() => chooseSessionMode(value)} />)}</View>
        {draft.sessionMode !== "fresh" && <>
          <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "automation.editor.taskBinding")}</Text>
          <View style={styles.optionRow}>{sessions.map((session) => <Choice key={session.sessionId} label={session.displayName}
            selected={draft.sessionId === session.sessionId} colors={colors} disabled={!editable}
            onPress={() => set("sessionId", session.sessionId)} />)}</View>
        </>}
        <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "automation.editor.modelSnapshot")}</Text>
        <View style={styles.optionRow}>
          <Choice label={mobileMessage(locale, "automation.editor.backendDefault")} selected={draft.model === undefined} colors={colors}
            disabled={!editable || execution?.canSelectModel !== true} onPress={() => chooseModel()} />
          {models.map((model) => <Choice key={model.key} label={`${model.providerName} · ${model.displayName}`}
            selected={draft.model?.providerId === model.providerId && draft.model.modelId === model.modelId}
            colors={colors} disabled={!editable || execution?.canSelectModel !== true}
            onPress={() => chooseModel(model.providerId, model.modelId)} />)}
          {draft.model !== undefined && selectedModel === undefined && <Choice
            label={mobileMessage(locale, "automation.editor.savedModel", {
              provider: draft.model.providerId, model: draft.model.modelId
            })} selected colors={colors} disabled
            onPress={() => undefined} />}
        </View>
        {selectedModel && selectedModel.efforts.length > 0 && <>
          <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "automation.editor.modelEffort")}</Text>
          <View style={styles.optionRow}>{selectedModel.efforts.map((effort) => <Choice key={effort.id} label={effort.label}
            selected={draft.model?.effortId === effort.id} colors={colors} disabled={!editable || execution?.canSetEffort !== true}
            onPress={() => set("model", { ...draft.model!, effortId: effort.id })} />)}</View>
        </>}
        {selectedModel?.supportsFastMode && <Choice label={mobileMessage(locale, "controls.fastMode")} selected={draft.model?.fastMode === true} colors={colors}
          disabled={!editable || execution?.canSetFastMode !== true}
          onPress={() => set("model", { ...draft.model!, fastMode: !draft.model!.fastMode })} />}
        <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "controls.permissionMode")}</Text>
        <View style={styles.optionRow}>{permissions.map((value) => <Choice key={value} label={mobileAutomationPermissionLabel(locale, value)}
          selected={draft.permissionMode === value} colors={colors}
          disabled={!editable || !advertisedPermissions.includes(value)}
          onPress={() => set("permissionMode", value)} />)}</View>
        {(execution?.canSetPlanMode || draft.planMode) && <Choice label={mobileMessage(locale, "controls.planMode")} selected={draft.planMode} colors={colors}
          disabled={!editable || execution?.canSetPlanMode !== true}
          onPress={() => set("planMode", !draft.planMode)} />}
        {(selectedTarget?.workspaceKind === "project" || draft.useWorktree) && <>
          <Choice label={mobileMessage(locale, "automation.editor.worktree")} selected={draft.useWorktree} colors={colors}
            disabled={!editable || !draft.useWorktree && !worktreeCompatible}
            onPress={toggleWorktree} />
          {draft.useWorktree && <>
            <Button label={worktreeLoading ? mobileMessage(locale, "automation.editor.worktreeLoading")
              : mobileMessage(locale, "automation.editor.worktreeReload")} colors={colors}
              disabled={!editable || worktreeLoading || !worktreeCompatible} onPress={() => void loadWorktree()} />
            {worktree && <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale,
              "automation.editor.worktreeEligibility", { state: mobileAutomationWorktreeEligibilityLabel(locale, worktree.eligibility) })}</Text>}
            {worktree && <View style={styles.optionRow}>
              <Choice label={mobileMessage(locale, "automation.editor.defaultSource")} selected={draft.worktreeSourceRef === undefined} colors={colors} disabled={!editable}
                onPress={() => set("worktreeSourceRef", undefined)} />
              {worktree.sources.map((source) => <Choice key={source.ref} label={source.displayName}
                selected={draft.worktreeSourceRef === source.ref} colors={colors} disabled={!editable}
                onPress={() => set("worktreeSourceRef", source.ref)} />)}
            </View>}
            <Choice label={mobileMessage(locale, "automation.editor.refreshRemote")} selected={draft.refreshWorktreeRemote} colors={colors}
              disabled={!editable || worktree?.canRefreshRemote !== true}
              onPress={() => set("refreshWorktreeRemote", !draft.refreshWorktreeRemote)} />
          </>}
        </>}
        {extraDirectories.length > 0 && <>
          <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "automation.editor.extraDirectories")}</Text>
          <View style={styles.optionRow}>{extraDirectories.map((directory) => {
            const selected = draft.extraDirectoryIds.includes(directory.id);
            return <Choice key={directory.id} label={`${directory.path} · ${mobileAutomationDirectoryAccessLabel(locale, directory.access)}`} selected={selected}
              colors={colors} disabled={!editable} onPress={() => set("extraDirectoryIds", selected
                ? draft.extraDirectoryIds.filter((id) => id !== directory.id)
                : [...draft.extraDirectoryIds, directory.id])} />;
          })}</View>
        </>}
        <Choice label={mobileMessage(locale, "automation.editor.silent")} selected={draft.silentWhenIdle} colors={colors} disabled={!editable}
          onPress={() => set("silentWhenIdle", !draft.silentWhenIdle)} />
      </> : <>
        <EditorInput label={mobileMessage(locale, "automation.editor.scriptCommand")} value={draft.scriptCommand} colors={colors} editable={editable} multiline
          onChange={(value) => set("scriptCommand", value)} />
        <EditorInput label={mobileMessage(locale, "automation.editor.timeout")} value={draft.scriptTimeoutSeconds} colors={colors} editable={editable}
          onChange={(value) => set("scriptTimeoutSeconds", value)} />
        <Choice label={mobileMessage(locale, "automation.editor.allowDispatch")} selected={draft.scriptDispatchSessions} colors={colors} disabled={!editable}
          onPress={() => set("scriptDispatchSessions", !draft.scriptDispatchSessions)} />
      </>}
      <Choice label={mobileMessage(locale, "automation.editor.desktopNotification")} selected={draft.notifyDesktop} colors={colors} disabled={!editable}
        onPress={() => set("notifyDesktop", !draft.notifyDesktop)} />
      {draft.preRunHook && <View style={[styles.managedBox, { borderColor: colors.border }]}>
        <Text style={[styles.label, { color: colors.ink }]}>{mobileMessage(locale, "automation.editor.managedPreRun")}</Text>
        <Text style={[styles.mono, { color: colors.ink }]}>{draft.preRunHook.command}</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>{draft.preRunHook.filePath}</Text>
      </View>}
    </EditorSection>
    <Button label={saving ? mobileMessage(locale, "common.saving") : schedule ? mobileMessage(locale, "automation.editor.save")
      : mobileMessage(locale, "automation.create")} colors={colors}
      disabled={!editable} onPress={() => void save()} />
  </ScrollView>;
}

function AutomationDeletePanel({ colors, state, client, schedule, locale, onClose }: {
  readonly colors: MobileAutomationsColors;
  readonly state: MobileState;
  readonly client: MobileAutomationsClient;
  readonly schedule: MobileAutomationSchedule;
  readonly locale: MobileSupportedLocale;
  readonly onClose: () => void;
}) {
  const [preview, setPreview] = useState<MobileAutomationDeletionPreview>();
  const [outcome, setOutcome] = useState<MobileAutomationDeletionOutcome>();
  const [receiptUnknown, setReceiptUnknown] = useState(false);
  const [disposition, setDisposition] = useState<MobileAutomationDisposition>("keep");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const online = state.status === "connected" && state.automations.status === "ready";
  const load = async (): Promise<void> => {
    setLoading(true);
    setError("");
    setOutcome(undefined);
    setReceiptUnknown(false);
    try { setPreview(await client.prepareAutomationDeletion(schedule.scheduleId)); }
    catch (cause) { setPreview(undefined); setError(errorText(cause)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [client, schedule.scheduleId]);
  const confirm = async (): Promise<void> => {
    if (!preview || pending || !online) return;
    setPending(true);
    setError("");
    try {
      const result = await client.deleteAutomation(schedule.scheduleId, disposition, preview);
      if (result === undefined) {
        setPreview(undefined);
        setReceiptUnknown(true);
        setError(mobileMessage(locale, "automation.delete.unknown"));
      } else if (result.failures.length > 0) {
        setPreview(undefined);
        setOutcome(result);
        setError(result.failures.map((failure) => `${failure.sessionId}: ${failure.message}`).join("\n"));
      } else onClose();
    } catch (cause) { setError(errorText(cause)); }
    finally { setPending(false); }
  };
  return <ScrollView contentContainerStyle={styles.editor}>
    <View style={styles.headerRow}>
      <Button label={mobileMessage(locale, "automation.delete.cancel")} colors={colors} disabled={pending} onPress={onClose} />
      <View style={styles.headerText}>
        <Text style={[styles.title, { color: colors.ink }]}>{mobileMessage(locale, "automation.delete.title")}</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>{schedule.displayName}</Text>
      </View>
    </View>
    {!online && <Notice colors={colors} text={mobileMessage(locale, "automation.delete.offline")} />}
    {error && <Notice colors={colors} danger text={error} />}
    {outcome && <Notice colors={colors} text={mobileMessage(locale, "automation.delete.outcome", {
      processed: outcome.completedSessionIds.length, failed: outcome.failures.length
    })} />}
    {loading ? <Centered colors={colors} label={mobileMessage(locale, "automation.delete.preparing")} loading /> : preview && <>
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Info label={mobileMessage(locale, "automation.delete.generatedTasks")} value={String(preview.generatedSessionIds.length)} colors={colors} />
        <Info label={mobileMessage(locale, "automation.delete.inflight")} value={String(preview.inflightCount)} colors={colors} />
        {preview.generatedSessionIds.map((sessionId) => <Text key={sessionId} style={[styles.mono, { color: colors.ink }]}>{sessionId}</Text>)}
      </View>
      <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "automation.delete.disposition")}</Text>
      <View style={styles.optionRow}>{(["keep", "archive", "delete"] as const).map((value) => <Choice key={value}
        label={value === "keep" ? mobileMessage(locale, "automation.delete.keep")
          : value === "archive" ? mobileMessage(locale, "automation.delete.archive")
            : mobileMessage(locale, "automation.delete.delete")}
        selected={disposition === value} colors={colors} disabled={pending || !online} onPress={() => setDisposition(value)} />)}</View>
      <Button label={pending ? mobileMessage(locale, "automation.delete.deleting")
        : mobileMessage(locale, "automation.delete.confirm")} danger colors={colors}
        disabled={pending || !online || preview === undefined} onPress={() => void confirm()} />
    </>}
    {!loading && preview === undefined && outcome === undefined && !receiptUnknown && <Button label={mobileMessage(locale, "automation.delete.retry")} colors={colors}
      disabled={!online || pending} onPress={() => void load()} />}
    {(outcome || receiptUnknown) && <Button label={mobileMessage(locale, "common.close")} colors={colors} onPress={onClose} />}
  </ScrollView>;
}

function EditorSection({ title, colors, children }: {
  readonly title: string;
  readonly colors: MobileAutomationsColors;
  readonly children: React.ReactNode;
}) {
  return <View style={[styles.editorSection, { borderColor: colors.border, backgroundColor: colors.surface }]}>
    <Text style={[styles.section, { color: colors.muted }]}>{title}</Text>
    {children}
  </View>;
}

function EditorInput({ label, value, colors, editable, onChange, placeholder, multiline = false }: {
  readonly label: string;
  readonly value: string;
  readonly colors: MobileAutomationsColors;
  readonly editable: boolean;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly multiline?: boolean;
}) {
  return <View style={styles.field}>
    <Text style={[styles.caption, { color: colors.muted }]}>{label}</Text>
    <TextInput accessibilityLabel={label} value={value} editable={editable} multiline={multiline}
      onChangeText={onChange} placeholder={placeholder} placeholderTextColor={colors.muted}
      style={[styles.input, multiline && styles.multilineInput,
        { color: colors.ink, borderColor: colors.border, backgroundColor: colors.surface }]} />
  </View>;
}

function Choice({ label, selected, colors, disabled, onPress }: {
  readonly label: string;
  readonly selected: boolean;
  readonly colors: MobileAutomationsColors;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress}
    style={[styles.choice, { borderColor: selected ? colors.accent : colors.border,
      backgroundColor: selected ? colors.brandBackground : colors.surface, opacity: disabled ? 0.45 : 1 }]}>
    <Text style={[styles.buttonText, { color: colors.ink }]}>{label}</Text>
  </Pressable>;
}

function RunCard({ run, schedule, colors, client, disabled, onRun, onOpenTask, setLocalError, sessionAvailable, locale }: {
  readonly run: MobileAutomationRun;
  readonly schedule: MobileAutomationSchedule;
  readonly colors: MobileAutomationsColors;
  readonly locale: MobileSupportedLocale;
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
    mobileMessage(locale, "automation.run.deleteTitle"),
    mobileMessage(locale, "automation.run.deleteBody"),
    [{ text: mobileMessage(locale, "common.keep"), style: "cancel" }, { text: mobileMessage(locale, "common.delete"), style: "destructive",
      onPress: () => void onRun(() => client.deleteAutomationRun(schedule.scheduleId, run.triggerId)) }]
  );
  const openTask = (): void => {
    setLocalError("");
    void client.openAutomationRunTask(schedule.scheduleId, run.triggerId).then(onOpenTask)
      .catch((error) => setLocalError(errorText(error)));
  };
  const stateLabel = mobileAutomationRunStateLabel(locale, run.state);
  return <View accessibilityLabel={mobileMessage(locale, "automation.run.accessibility", { state: stateLabel })}
    style={[styles.card, unread && { borderColor: colors.accent }, { backgroundColor: colors.surface, borderColor: unread ? colors.accent : colors.border }]}>
    <View style={styles.rowBetween}>
      <View style={styles.flex}>
        <Text style={[styles.label, { color: colors.ink }]}>{stateLabel}</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>{formatMobileAutomationDate(run.triggeredAt, locale)} · {formatMobileAutomationDuration(run.durationMs, locale)}</Text>
      </View>
      {unread && <Text style={[styles.badge, { color: colors.ink, backgroundColor: colors.brandBackground }]}>{mobileMessage(locale, "automation.run.unread")}</Text>}
    </View>
    <Text style={[styles.caption, { color: colors.muted }]}>{formatMobileAutomationCost(run, locale)}</Text>
    {run.resultText && <Text style={[styles.body, { color: colors.ink }]}>{run.resultText}</Text>}
    {run.error && <Text accessibilityRole="alert" style={[styles.body, { color: colors.negative }]}>{run.error}</Text>}
    {run.preRun && <View style={[styles.preRun, { borderColor: colors.border }]}>
      <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "automation.preRun.summary", {
        status: mobileAutomationPreRunStatusLabel(locale, run.preRun.status),
        decision: mobileAutomationPreRunDecisionLabel(locale, run.preRun.decision),
        duration: formatMobileAutomationDuration(run.preRun.durationMs, locale)
      })}</Text>
      {run.preRun.stdout && <Text style={[styles.mono, { color: colors.ink }]}>{run.preRun.stdout}</Text>}
      {run.preRun.stderr && <Text style={[styles.mono, { color: colors.negative }]}>{run.preRun.stderr}</Text>}
    </View>}
    <View style={styles.actionRow}>
      {unread && <Button label={mobileMessage(locale, "automation.run.markRead")} compact colors={colors} disabled={disabled}
        onPress={() => void onRun(() => client.markAutomationRunRead(schedule.scheduleId, run.triggerId))} />}
      {run.sessionId && <Button label={sessionAvailable ? mobileMessage(locale, "automation.run.openTask")
        : mobileMessage(locale, "automation.run.taskUnavailable")} compact colors={colors}
        disabled={!sessionAvailable} onPress={openTask} />}
      {restartable && <Button label={mobileMessage(locale, "automation.run.restart")} compact colors={colors} disabled={disabled}
        onPress={() => void onRun(() => client.restartAutomationRun(schedule.scheduleId, run.triggerId))} />}
      {terminal && <Button label={mobileMessage(locale, "automation.run.deleteHistory")} compact danger colors={colors} disabled={disabled} onPress={deleteRun} />}
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  wide: { flexDirection: "row" },
  listPane: { flex: 1, padding: 12, gap: 10 },
  emptyState: { flex: 1, gap: 12, paddingBottom: 24 },
  wideListPane: { maxWidth: 420 },
  detailPane: { flex: 1, borderLeftWidth: 1 },
  detail: { padding: 16, gap: 12 },
  editor: { padding: 16, gap: 14, paddingBottom: 40 },
  editorSection: { borderWidth: 1, borderRadius: 16, padding: 12, gap: 10 },
  field: { gap: 5 },
  input: { minHeight: 44, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, fontSize: 14 },
  multilineInput: { minHeight: 112, textAlignVertical: "top" },
  optionRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  choice: { minHeight: 40, borderWidth: 1, borderRadius: 12, justifyContent: "center", paddingHorizontal: 10, paddingVertical: 7 },
  managedBox: { borderWidth: 1, borderRadius: 12, padding: 10, gap: 4 },
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
