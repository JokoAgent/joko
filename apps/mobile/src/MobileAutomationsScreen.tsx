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
  readonly client: MobileAutomationsClient;
  readonly onBack: () => void;
  readonly onOpenTask: () => void;
}

export function MobileAutomationsScreen({ colors, state, client, onBack, onOpenTask }: MobileAutomationsScreenProps) {
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
      <Button label="Back" colors={colors} onPress={leave} />
      <View style={styles.headerText}>
        <Text style={[styles.title, { color: colors.ink }]}>Automations</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>
          {automations.schedules.length} schedules · {unreadTotal} unread runs
        </Text>
      </View>
      <Button label="New" colors={colors} disabled={!online || state.busy} onPress={() => openEditor()} />
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
        ? <View style={styles.emptyState}>
          <Centered colors={colors} label={automations.filter === "all" ? "No Automations" : `No ${automations.filter} Automations`} />
          {automations.filter === "all" && <Button label="Create Automation" colors={colors} disabled={!online || state.busy}
            onPress={() => openEditor()} />}
        </View>
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
    onBack={wide ? undefined : () => setNarrowDetail(false)} onOpenTask={onOpenTask}
    onEdit={openEditor} onDelete={setDeleting} />;

  if (editor !== undefined) return <View style={[styles.root, { backgroundColor: colors.background }]}>
    <AutomationEditor colors={colors} state={state} client={client} initialDraft={editor.draft}
      schedule={editor.schedule} onClose={() => setEditor(undefined)} />
  </View>;
  if (deleting !== undefined) return <View style={[styles.root, { backgroundColor: colors.background }]}>
    <AutomationDeletePanel colors={colors} state={state} client={client} schedule={deleting}
      onClose={() => setDeleting(undefined)} />
  </View>;

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

function AutomationDetail({ colors, state, schedule, client, online, localError, setLocalError, onRun, onBack, onOpenTask,
  onEdit, onDelete }: {
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
  readonly onEdit: (schedule: MobileAutomationSchedule) => void;
  readonly onDelete: (schedule: MobileAutomationSchedule) => void;
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
  const promote = (): void => Alert.alert(
    "Promote to project Automation?",
    "This writes the Automation into the project configuration and replaces the personal Schedule.",
    [{ text: "Cancel", style: "cancel" }, { text: "Promote", onPress: () => void onRun(() => client.promoteAutomation(schedule.scheduleId)) }]
  );
  const clone = (): void => {
    void onRun(() => client.cloneProjectAutomation(schedule.scheduleId, `${schedule.displayName} (copy)`));
  };
  const removeProject = (): void => Alert.alert(
    "Remove project Automation?",
    "Remove it from project configuration, with or without keeping a personal copy.",
    [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => void onRun(() => client.removeProjectAutomation(schedule.scheduleId, false)) },
      { text: "Keep personal copy", onPress: () => void onRun(() => client.removeProjectAutomation(schedule.scheduleId, true)) }
    ]
  );
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
      <Button label="Edit" colors={colors} disabled={disabled || detail === undefined} onPress={() => onEdit(detail ?? schedule)} />
      {schedule.source === "dialogue"
        ? <>
          <Button label="Promote to project" colors={colors} disabled={disabled || schedule.sessionMode === "bound"} onPress={promote} />
          <Button label="Delete Automation" danger colors={colors} disabled={disabled} onPress={() => onDelete(schedule)} />
        </>
        : <>
          <Button label="Clone personal copy" colors={colors} disabled={disabled} onPress={clone} />
          <Button label="Reconcile project" colors={colors} disabled={disabled}
            onPress={() => void onRun(() => client.reconcileProjectAutomations(schedule.targetId))} />
          <Button label="Remove from project" danger colors={colors} disabled={disabled} onPress={removeProject} />
        </>}
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

function AutomationEditor({ colors, state, client, schedule, initialDraft, onClose }: {
  readonly colors: MobileAutomationsColors;
  readonly state: MobileState;
  readonly client: MobileAutomationsClient;
  readonly schedule?: MobileAutomationSchedule;
  readonly initialDraft: MobileAutomationDraft;
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
      "Discard Automation draft?",
      "Your unsaved changes will be lost.",
      [{ text: "Keep editing", style: "cancel" }, { text: "Discard", style: "destructive", onPress: onClose }]
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
    try { setDraft((current) => applyMobileAutomationTemplate(current, templateId, templateParameter)); }
    catch (cause) { setError(errorText(cause)); }
  };
  const save = async (): Promise<void> => {
    if (!editable) return;
    setError("");
    setSaving(true);
    try {
      const result = await client.saveAutomation(draft, schedule?.scheduleId);
      if (result === undefined) {
        setError("The durable save result is unknown. The draft was retained and was not resent.");
        return;
      }
      onClose();
    } catch (cause) { setError(errorText(cause)); }
    finally { setSaving(false); }
  };
  const recurrenceLabel = draft.recurrence === "once" ? "Local date and time"
    : draft.recurrence === "interval" ? "Interval seconds"
      : "Cron expression";
  return <ScrollView contentContainerStyle={styles.editor}>
    <View style={styles.headerRow}>
      <Button label="Close editor" colors={colors} disabled={saving} onPress={close} />
      <View style={styles.headerText}>
        <Text style={[styles.title, { color: colors.ink }]}>{schedule ? "Edit Automation" : "New Automation"}</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>{dirty ? "Unsaved changes" : "No unsaved changes"}</Text>
      </View>
      <Button label={saving ? "Saving…" : "Save"} colors={colors} disabled={!editable}
        onPress={() => void save()} />
    </View>
    {!online && <Notice colors={colors} text="The draft is retained read-only while this device is offline or inactive. Reconnect to save." />}
    {authoringPending && <Notice colors={colors} text="A related Automation change still has an unknown durable result. This draft remains read-only until its receipt is reconciled." />}
    {(error || state.error) && <Notice colors={colors} danger text={error || state.error || ""} />}

    <EditorSection title="Templates" colors={colors}>
      <TextInput accessibilityLabel="Template parameter" value={templateParameter} editable={editable}
        onChangeText={setTemplateParameter} placeholder="Topic or competitors, when required"
        placeholderTextColor={colors.muted} style={[styles.input, { color: colors.ink, borderColor: colors.border, backgroundColor: colors.surface }]} />
      <View style={styles.optionRow}>{mobileAutomationTemplates().map((template) =>
        <Choice key={template.id} label={template.name} selected={false} colors={colors} disabled={!editable}
          onPress={() => applyTemplate(template.id)} />)}</View>
    </EditorSection>

    <EditorSection title="Identity and project" colors={colors}>
      <EditorInput label="Automation name" value={draft.name} colors={colors} editable={editable}
        onChange={(value) => set("name", value)} />
      <Text style={[styles.caption, { color: colors.muted }]}>Project</Text>
      <View style={styles.optionRow}>{targets.map((target) => <Choice key={target.targetId} label={target.displayName}
        selected={draft.targetId === target.targetId} colors={colors}
        disabled={!editable || schedule?.source === "project"} onPress={() => chooseTarget(target.targetId)} />)}</View>
      <Info label="Backend" value={draft.backendId || "Unavailable"} colors={colors} />
      <Choice label={draft.enabled ? "Enabled" : "Paused"} selected={draft.enabled} colors={colors} disabled={!editable}
        onPress={() => set("enabled", !draft.enabled)} />
    </EditorSection>

    <EditorSection title="Schedule" colors={colors}>
      <View style={styles.optionRow}>{(["manual", "once", "interval", "cron"] as const).map((value) =>
        <Choice key={value} label={value} selected={draft.recurrence === value} colors={colors} disabled={!editable}
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
      <EditorInput label="IANA time zone" value={draft.timeZone} colors={colors} editable={editable}
        onChange={(value) => set("timeZone", value)} />
      <EditorInput label="Expiration (local, optional)" value={draft.expireAtExpression} colors={colors}
        editable={editable} placeholder="YYYY-MM-DDTHH:mm" onChange={(value) => set("expireAtExpression", value)} />
      <Text style={[styles.caption, { color: colors.muted }]}>Overlap policy</Text>
      <View style={styles.optionRow}>{(["queue", "skip"] as const).map((value) => <Choice key={value} label={value}
        selected={draft.overlapPolicy === value} colors={colors} disabled={!editable} onPress={() => set("overlapPolicy", value)} />)}</View>
      <Text style={[styles.caption, { color: colors.muted }]}>Missed-run policy</Text>
      <View style={styles.optionRow}>{(["runOnce", "skip"] as const).map((value) => <Choice key={value} label={value}
        selected={draft.misfirePolicy === value} colors={colors} disabled={!editable} onPress={() => set("misfirePolicy", value)} />)}</View>
    </EditorSection>

    <EditorSection title="Execution" colors={colors}>
      <View style={styles.optionRow}>{(["agent", "script"] as const).map((value) => <Choice key={value} label={value}
        selected={draft.executionMode === value} colors={colors} disabled={!editable} onPress={() => chooseExecutionMode(value)} />)}</View>
      {draft.executionMode === "agent" ? <>
        <EditorInput label="Scheduled input" value={draft.inputText} colors={colors} editable={editable} multiline
          onChange={(value) => set("inputText", value)} />
        <Text style={[styles.caption, { color: colors.muted }]}>Task mode</Text>
        <View style={styles.optionRow}>{(["fresh", "persistent", "bound"] as const).map((value) => <Choice key={value}
          label={value} selected={draft.sessionMode === value} colors={colors} disabled={!editable || schedule?.source === "project" && value === "bound"}
          onPress={() => chooseSessionMode(value)} />)}</View>
        {draft.sessionMode !== "fresh" && <>
          <Text style={[styles.caption, { color: colors.muted }]}>Task binding</Text>
          <View style={styles.optionRow}>{sessions.map((session) => <Choice key={session.sessionId} label={session.displayName}
            selected={draft.sessionId === session.sessionId} colors={colors} disabled={!editable}
            onPress={() => set("sessionId", session.sessionId)} />)}</View>
        </>}
        <Text style={[styles.caption, { color: colors.muted }]}>Model snapshot</Text>
        <View style={styles.optionRow}>
          <Choice label="Backend default" selected={draft.model === undefined} colors={colors}
            disabled={!editable || execution?.canSelectModel !== true} onPress={() => chooseModel()} />
          {models.map((model) => <Choice key={model.key} label={`${model.providerName} · ${model.displayName}`}
            selected={draft.model?.providerId === model.providerId && draft.model.modelId === model.modelId}
            colors={colors} disabled={!editable || execution?.canSelectModel !== true}
            onPress={() => chooseModel(model.providerId, model.modelId)} />)}
          {draft.model !== undefined && selectedModel === undefined && <Choice
            label={`${draft.model.providerId} · ${draft.model.modelId} (saved)`} selected colors={colors} disabled
            onPress={() => undefined} />}
        </View>
        {selectedModel && selectedModel.efforts.length > 0 && <>
          <Text style={[styles.caption, { color: colors.muted }]}>Model effort</Text>
          <View style={styles.optionRow}>{selectedModel.efforts.map((effort) => <Choice key={effort.id} label={effort.label}
            selected={draft.model?.effortId === effort.id} colors={colors} disabled={!editable || execution?.canSetEffort !== true}
            onPress={() => set("model", { ...draft.model!, effortId: effort.id })} />)}</View>
        </>}
        {selectedModel?.supportsFastMode && <Choice label="Fast Mode" selected={draft.model?.fastMode === true} colors={colors}
          disabled={!editable || execution?.canSetFastMode !== true}
          onPress={() => set("model", { ...draft.model!, fastMode: !draft.model!.fastMode })} />}
        <Text style={[styles.caption, { color: colors.muted }]}>Permission mode</Text>
        <View style={styles.optionRow}>{permissions.map((value) => <Choice key={value} label={value}
          selected={draft.permissionMode === value} colors={colors}
          disabled={!editable || !advertisedPermissions.includes(value)}
          onPress={() => set("permissionMode", value)} />)}</View>
        {(execution?.canSetPlanMode || draft.planMode) && <Choice label="Plan Mode" selected={draft.planMode} colors={colors}
          disabled={!editable || execution?.canSetPlanMode !== true}
          onPress={() => set("planMode", !draft.planMode)} />}
        {(selectedTarget?.workspaceKind === "project" || draft.useWorktree) && <>
          <Choice label="Isolated Worktree" selected={draft.useWorktree} colors={colors}
            disabled={!editable || !draft.useWorktree && !worktreeCompatible}
            onPress={toggleWorktree} />
          {draft.useWorktree && <>
            <Button label={worktreeLoading ? "Loading Worktree…" : "Reload Worktree options"} colors={colors}
              disabled={!editable || worktreeLoading || !worktreeCompatible} onPress={() => void loadWorktree()} />
            {worktree && <Text style={[styles.caption, { color: colors.muted }]}>Eligibility: {worktree.eligibility}</Text>}
            {worktree && <View style={styles.optionRow}>
              <Choice label="Default source" selected={draft.worktreeSourceRef === undefined} colors={colors} disabled={!editable}
                onPress={() => set("worktreeSourceRef", undefined)} />
              {worktree.sources.map((source) => <Choice key={source.ref} label={source.displayName}
                selected={draft.worktreeSourceRef === source.ref} colors={colors} disabled={!editable}
                onPress={() => set("worktreeSourceRef", source.ref)} />)}
            </View>}
            <Choice label="Refresh remote before run" selected={draft.refreshWorktreeRemote} colors={colors}
              disabled={!editable || worktree?.canRefreshRemote !== true}
              onPress={() => set("refreshWorktreeRemote", !draft.refreshWorktreeRemote)} />
          </>}
        </>}
        {extraDirectories.length > 0 && <>
          <Text style={[styles.caption, { color: colors.muted }]}>Extra directories</Text>
          <View style={styles.optionRow}>{extraDirectories.map((directory) => {
            const selected = draft.extraDirectoryIds.includes(directory.id);
            return <Choice key={directory.id} label={`${directory.path} · ${directory.access}`} selected={selected}
              colors={colors} disabled={!editable} onPress={() => set("extraDirectoryIds", selected
                ? draft.extraDirectoryIds.filter((id) => id !== directory.id)
                : [...draft.extraDirectoryIds, directory.id])} />;
          })}</View>
        </>}
        <Choice label="Silent when idle" selected={draft.silentWhenIdle} colors={colors} disabled={!editable}
          onPress={() => set("silentWhenIdle", !draft.silentWhenIdle)} />
      </> : <>
        <EditorInput label="Script command" value={draft.scriptCommand} colors={colors} editable={editable} multiline
          onChange={(value) => set("scriptCommand", value)} />
        <EditorInput label="Timeout seconds (optional)" value={draft.scriptTimeoutSeconds} colors={colors} editable={editable}
          onChange={(value) => set("scriptTimeoutSeconds", value)} />
        <Choice label="Allow task dispatch" selected={draft.scriptDispatchSessions} colors={colors} disabled={!editable}
          onPress={() => set("scriptDispatchSessions", !draft.scriptDispatchSessions)} />
      </>}
      <Choice label="Desktop notification" selected={draft.notifyDesktop} colors={colors} disabled={!editable}
        onPress={() => set("notifyDesktop", !draft.notifyDesktop)} />
      {draft.preRunHook && <View style={[styles.managedBox, { borderColor: colors.border }]}>
        <Text style={[styles.label, { color: colors.ink }]}>Managed pre-run hook</Text>
        <Text style={[styles.mono, { color: colors.ink }]}>{draft.preRunHook.command}</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>{draft.preRunHook.filePath}</Text>
      </View>}
    </EditorSection>
    <Button label={saving ? "Saving…" : schedule ? "Save Automation" : "Create Automation"} colors={colors}
      disabled={!editable} onPress={() => void save()} />
  </ScrollView>;
}

function AutomationDeletePanel({ colors, state, client, schedule, onClose }: {
  readonly colors: MobileAutomationsColors;
  readonly state: MobileState;
  readonly client: MobileAutomationsClient;
  readonly schedule: MobileAutomationSchedule;
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
        setError("The durable deletion result is unknown. It was not resent.");
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
      <Button label="Cancel deletion" colors={colors} disabled={pending} onPress={onClose} />
      <View style={styles.headerText}>
        <Text style={[styles.title, { color: colors.ink }]}>Delete Automation</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>{schedule.displayName}</Text>
      </View>
    </View>
    {!online && <Notice colors={colors} text="Reconnect to refresh the deletion preview and delete this Automation." />}
    {error && <Notice colors={colors} danger text={error} />}
    {outcome && <Notice colors={colors} text={`The Automation was deleted. ${outcome.completedSessionIds.length} generated tasks were processed; ${outcome.failures.length} failed.`} />}
    {loading ? <Centered colors={colors} label="Preparing deletion…" loading /> : preview && <>
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Info label="Generated tasks" value={String(preview.generatedSessionIds.length)} colors={colors} />
        <Info label="In-flight runs" value={String(preview.inflightCount)} colors={colors} />
        {preview.generatedSessionIds.map((sessionId) => <Text key={sessionId} style={[styles.mono, { color: colors.ink }]}>{sessionId}</Text>)}
      </View>
      <Text style={[styles.caption, { color: colors.muted }]}>Generated-task disposition</Text>
      <View style={styles.optionRow}>{(["keep", "archive", "delete"] as const).map((value) => <Choice key={value}
        label={value === "keep" ? "Keep tasks" : value === "archive" ? "Archive tasks" : "Delete tasks"}
        selected={disposition === value} colors={colors} disabled={pending || !online} onPress={() => setDisposition(value)} />)}</View>
      <Button label={pending ? "Deleting…" : "Confirm deletion"} danger colors={colors}
        disabled={pending || !online || preview === undefined} onPress={() => void confirm()} />
    </>}
    {!loading && preview === undefined && outcome === undefined && !receiptUnknown && <Button label="Retry deletion preview" colors={colors}
      disabled={!online || pending} onPress={() => void load()} />}
    {(outcome || receiptUnknown) && <Button label="Close" colors={colors} onPress={onClose} />}
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
