import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { Code, ConnectError } from "@connectrpc/connect";
import { PersonalDevelopmentDirectoryKind, type PersonalDevelopmentState } from "@joko/contracts";
import type { AppController } from "../controller.js";
import type { AppSnapshot } from "../model.js";
import type { PersonalDevelopmentAction, PersonalDevelopmentDoctorDraft, PersonalDevelopmentSnapshot, PersonalDevelopmentTaskDraft } from "../personal-development-api.js";
import { randomUuid } from "../web-crypto.js";
import type { Translator } from "./types.js";
import { Button, CheckboxControl, Modal, Spinner, SwitchControl } from "./ui.js";
import { PersonalDevelopmentReport, PersonalDevelopmentReportActions } from "./PersonalDevelopmentReport.js";
import { PersonalDevelopmentProgress } from "./PersonalDevelopmentProgress.js";
import { PersonalDevelopmentChecks } from "./PersonalDevelopmentChecks.js";
import "./PersonalDevelopmentSettings.css";

type PendingIntent = { readonly id: string } & (
  | { readonly kind: "action"; readonly action: PersonalDevelopmentAction }
  | { readonly kind: "task"; readonly draft: PersonalDevelopmentTaskDraft }
  | { readonly kind: "doctor"; readonly draft: PersonalDevelopmentDoctorDraft }
  | { readonly kind: "control"; readonly taskId: string; readonly action: "continue" | "end" | "start_test" | "stop_test" | "retry_preparation"; readonly message: string }
);

export interface PersonalDevelopmentLaunch {
  readonly request: string; readonly originSessionId?: string; readonly targetId: string;
  readonly providerId: string; readonly modelId: string;
  readonly onCreated: (sessionId?: string) => void;
  readonly onClose: () => void;
}

export function PersonalDevelopmentSettings({ controller, snapshot, t, launch }: {
  readonly controller: AppController; readonly snapshot: AppSnapshot; readonly t: Translator; readonly launch?: PersonalDevelopmentLaunch;
}): JSX.Element {
  const owner = JSON.stringify([controller.state.activeProfile?.id, controller.state.activeProfile?.serverId, controller.state.activeProfile?.origin,
    controller.state.connectionGeneration, snapshot.generation.toString()]);
  const storageOwner = JSON.stringify([controller.state.activeProfile?.deviceId, controller.state.activeProfile?.serverId, controller.state.activeProfile?.origin]);
  return <PersonalDevelopmentOwned key={owner} {...{ controller, snapshot, t, launch }} owner={storageOwner} />;
}

function PersonalDevelopmentOwned({ controller, snapshot, t, owner, launch }: { readonly controller: AppController; readonly snapshot: AppSnapshot; readonly t: Translator; readonly owner: string; readonly launch?: PersonalDevelopmentLaunch }): JSX.Element {
  const [value, setValue] = useState<PersonalDevelopmentSnapshot>(), [loadFailed, setLoadFailed] = useState(false);
  const [intent, setIntent] = useState<PendingIntent | undefined>(() => readIntent(owner)), [busy, setBusy] = useState(false), [actionFailed, setActionFailed] = useState(() => readIntent(owner) !== undefined);
  const [newTask, setNewTask] = useState(launch !== undefined), [request, setRequest] = useState(launch?.request ?? ""), [targetId, setTargetId] = useState(launch?.targetId ?? ""), [modelKey, setModelKey] = useState(launch === undefined ? "" : JSON.stringify([launch.providerId, launch.modelId]));
  const [rejected, setRejected] = useState(false);
  const [selectedHistory, setSelectedHistory] = useState<readonly string[]>([]);
  const [confirmation, setConfirmation] = useState<{ readonly action: "reset" | "update"; readonly commit: string }>();
  const reportActions = useMemo(() => ({ controlPersonalDevelopmentDoctor: controller.controlPersonalDevelopmentDoctor,
    controlPersonalDevelopmentTask: controller.controlPersonalDevelopmentTask, navigate: controller.navigate, openHttpLink: controller.openHttpLink }), [controller.controlPersonalDevelopmentDoctor, controller.controlPersonalDevelopmentTask, controller.navigate, controller.openHttpLink]);
  const checkedOnMount = useRef(false);
  const scope = useRef<AbortController | undefined>(undefined), pending = useRef(false), generation = useRef(-1n), port = useRef(controller);
  port.current = controller;
  useEffect(() => { try { if (intent === undefined) localStorage.removeItem(`joko.personal-action.v1:${owner}`); else localStorage.setItem(`joko.personal-action.v1:${owner}`, JSON.stringify(intent)); } catch { /* Continue in memory if client persistence is unavailable. */ } }, [intent, owner]);
  const connected = controller.state.ready && controller.state.connectionState === "connected";
  const state = value?.state;
  useEffect(() => {
    if (!busy && intent !== undefined && state?.operations.some(operation => operation.id === intent.id)) {
      setIntent(undefined); setActionFailed(false);
    }
  }, [busy, intent, state]);
  const acceptState = useCallback((next: PersonalDevelopmentState | undefined): void => {
    if (next === undefined || next.generation < generation.current) return;
    generation.current = next.generation;
    setValue((old) => old === undefined ? old : { ...old, state: next });
  }, []);
  const accept = useCallback((next: PersonalDevelopmentSnapshot): void => {
    if (next.state !== undefined && next.state.generation < generation.current) return;
    if (next.state !== undefined) generation.current = next.state.generation;
    setValue(next); setLoadFailed(false);
  }, []);
  const refresh = useCallback(async (): Promise<void> => {
    const signal = scope.current?.signal; if (signal === undefined || signal.aborted) return;
    try { const next = await port.current.getPersonalDevelopment(signal); if (!signal.aborted) accept(next); }
    catch { if (!signal.aborted) setLoadFailed(true); }
  }, [accept]);
  useEffect(() => {
    const owner = new AbortController(); scope.current = owner;
    if (connected) {
      void (async () => {
        try {
          const initial = await port.current.getPersonalDevelopment(owner.signal); if (owner.signal.aborted) return; accept(initial);
          if (initial.available) await port.current.watchPersonalDevelopment(initial.state?.generation ?? 0n, (next) => { if (!owner.signal.aborted) accept(next); }, owner.signal);
        } catch { if (!owner.signal.aborted) setLoadFailed(true); }
      })();
    }
    return () => { owner.abort(); if (scope.current === owner) scope.current = undefined; };
  }, [connected, accept]);
  const execute = async (next: PendingIntent): Promise<void> => {
    const signal = scope.current?.signal;
    if (signal === undefined || signal.aborted || pending.current) return;
    pending.current = true; setBusy(true); setIntent(next); setActionFailed(false); setRejected(false);
    try {
      if (next.kind === "action") acceptState(await port.current.runPersonalDevelopmentAction(next.action, next.id, signal));
      else if (next.kind === "control") acceptState(await port.current.controlPersonalDevelopmentTask(next.taskId, next.action, next.message, next.id, signal));
      else {
        const created = next.kind === "doctor"
          ? await port.current.startPersonalDevelopmentDoctor(next.draft, next.id, signal)
          : await port.current.startPersonalDevelopmentTask(next.draft, next.id, signal);
        if (signal.aborted) return;
        if ("state" in created) acceptState(created.state); setNewTask(false); setRequest("");
        const sessionId = created.sessionId || undefined;
        if (launch !== undefined) launch.onCreated(sessionId);
        else if (sessionId !== undefined) port.current.navigate({ kind: "session", sessionId });
      }
      if (!signal.aborted) { setIntent(undefined); await refresh(); }
    } catch (error) {
      if (!signal.aborted) {
        if (error instanceof ConnectError && [Code.InvalidArgument, Code.Aborted, Code.Unimplemented].includes(error.code)) {
          setIntent(undefined); setRejected(true);
        } else setActionFailed(true);
      }
    }
    finally { pending.current = false; if (!signal.aborted) setBusy(false); }
  };
  const action = (action: PersonalDevelopmentAction): void => { void execute({ id: randomUuid(), kind: "action", action }); };
  const control = (taskId: string, action: "continue" | "end" | "start_test" | "stop_test" | "retry_preparation"): void => { void execute({ id: randomUuid(), kind: "control", taskId, action, message: "" }); };
  const available = connected && value?.available === true && state !== undefined;
  const disabled = !available || busy || intent !== undefined || state?.operations.some(operation => operation.status === "running") === true;
  const targets = snapshot.targets.filter((target) => !target.archived && target.remoteWorkspace === undefined);
  const selectedTarget = targets.find((target) => target.id === targetId) ?? targets[0];
  const models = snapshot.models.filter((model) => model.available && model.routingEnabled !== false && model.backendId === selectedTarget?.backendId);
  const modelIdentity = (model: (typeof models)[number]) => JSON.stringify([model.providerId, model.modelId]);
  const selectedModel = models.find((model) => modelIdentity(model) === modelKey) ?? models[0];
  const running = state?.operations.filter((operation) => operation.status === "running") ?? [];
  const currentVersion = state?.versions?.currentId || state?.versions?.selected;
  const closeTask = (): void => { if (!busy) { setNewTask(false); launch?.onClose(); } };
  useEffect(() => {
    if (!available || checkedOnMount.current) return;
    checkedOnMount.current = true;
    if (!disabled) action({ case: "checkEnvironment", value: {} });
  }, [available]);
  return <section className="personal-development" aria-labelledby={launch === undefined ? "personal-development-title" : undefined}>
    <div hidden={launch !== undefined}>
    <header className="settings-heading"><div><h3 id="personal-development-title">{t("personalDevelopment.title")}</h3><p>{t("personalDevelopment.body")}</p></div><Button disabled={busy || !connected} onClick={() => { void refresh(); }}>{t("common.refresh")}</Button></header>
    {!connected ? <p>{t("help.connect")}</p> : loadFailed ? <p role="alert">{t("personalDevelopment.loadFailed")}</p> : value === undefined ? <p role="status"><Spinner />{t("common.loading")}</p>
      : !value.available ? <p role="status">{t("personalDevelopment.localOnly")}</p> : null}
    {actionFailed && <div role="alert"><p>{t("personalDevelopment.actionUnknown")}</p><Button disabled={busy || intent === undefined} onClick={() => { if (intent !== undefined) void execute(intent); }}>{t("personalDevelopment.retryReceipt")}</Button></div>}
    {running.length > 0 && <div className="settings-card personal-development-operations" aria-live="polite">{running.map((operation) => <div key={operation.id}><PersonalDevelopmentProgress operation={operation} t={t} /><Button disabled={!available || busy || intent !== undefined} onClick={() => action({ case: "cancel", value: { operationId: operation.id } })}>{t("common.cancel")}</Button></div>)}</div>}
    {rejected && <p role="alert">{t("personalDevelopment.failed")}</p>}
    {available && state !== undefined && <>
      <div className="settings-card"><h4>{t("personalDevelopment.versions")}</h4><p>{t("personalDevelopment.currentVersion", { version: currentVersion === "personal" ? t("personalDevelopment.personal") : `${t("personalDevelopment.original")} ${state.versions?.originalVersion ?? ""}`.trim() })}</p>
        <div className="personal-development-actions"><Button disabled={disabled || state.versions?.switching === true || currentVersion === "original"} onClick={() => action({ case: "version", value: { action: "switch", id: "original" } })}>{t("personalDevelopment.switchOriginal")}</Button>
          {state.versions?.personal !== undefined && <><Button disabled={disabled || state.versions.switching || currentVersion === "personal"} onClick={() => action({ case: "version", value: { action: "switch", id: "personal" } })}>{t("personalDevelopment.switchPersonal")}</Button><Button disabled={disabled || state.versions.switching || currentVersion !== "original" || state.versions.selected !== "original"} onClick={() => action({ case: "version", value: { action: "remove", id: "personal" } })}>{t("personalDevelopment.removeVersion")}</Button><Button disabled={disabled} onClick={() => action({ case: "revealBuild", value: {} })}>{t("personalDevelopment.reveal")}</Button></>}
        </div>{state.versions?.switching && <p role="status">{t("personalDevelopment.switching")}</p>}
        {state.versions?.personal !== undefined && <p className="personal-development-identity">{state.versions.personal.commit.slice(0, 12)}</p>}
      </div>
      <div className="settings-card"><h4>{t("personalDevelopment.environment")}</h4><p>{statusText(state.environment?.status, t)}{state.environment?.platform ? ` · ${state.environment.platform} ${state.environment.arch}` : ""}</p><PersonalDevelopmentChecks checks={state.environment?.checks ?? []} t={t} openHttpLink={controller.openHttpLink} />
        <div className="personal-development-actions"><Button disabled={disabled} onClick={() => action({ case: "checkEnvironment", value: {} })}>{t("personalDevelopment.checkEnvironment")}</Button><Button disabled={disabled} onClick={() => action({ case: "prepareEnvironment", value: {} })}>{t("personalDevelopment.prepareEnvironment")}</Button><Button disabled={disabled} onClick={() => action({ case: "openDirectory", value: { directory: PersonalDevelopmentDirectoryKind.TOOLS } })}>{t("personalDevelopment.openToolsDirectory")}</Button></div>
        {state.operations.some(operation => operation.status === "unknown") && <div><p>{t("personalDevelopment.recoverProcessesHelp")}</p><Button disabled={disabled} onClick={() => action({ case: "recoverProcesses", value: {} })}>{t("personalDevelopment.recoverProcesses")}</Button></div>}
      </div>
      <div className="settings-card"><h4>{t("personalDevelopment.source")}</h4><p>{statusText(state.source?.status, t)}</p>{state.source?.commit && <p className="personal-development-identity">{state.source.ref} · {state.source.commit.slice(0, 12)}</p>}
        {state.source?.currentBranch && <p>{t("personalDevelopment.branch")}: {state.source.currentBranch}</p>}
        {state.source?.mainAhead !== undefined && state.source.mainBehind !== undefined && <p>{t("personalDevelopment.mainComparison", { ahead: state.source.mainAhead.toString(), behind: state.source.mainBehind.toString() })}</p>}
        {state.source?.personalAhead !== undefined && state.source.personalBehind !== undefined && <p>{t("personalDevelopment.personalComparison", { ahead: state.source.personalAhead.toString(), behind: state.source.personalBehind.toString() })}</p>}
        {state.source?.latestVersion && <p>{t("personalDevelopment.latestSource")}: {state.source.latestVersion.status === "ready" ? `${state.source.latestVersion.ref} · ${state.source.latestVersion.commit.slice(0, 12)}` : t(state.source.latestVersion.status === "checking" ? "personalDevelopment.status.checking" : state.source.latestVersion.status === "missing" ? "personalDevelopment.tagMissing" : "personalDevelopment.latestUnavailable")}{state.source.latestVersion.ahead !== undefined && state.source.latestVersion.behind !== undefined ? ` · ${t("personalDevelopment.latestComparison", { ahead: state.source.latestVersion.ahead.toString(), behind: state.source.latestVersion.behind.toString() })}` : ""}</p>}
        {state.source?.error && <p role="alert">{errorText(state.source.error, t)}</p>}
        <div className="personal-development-actions"><Button disabled={disabled || !state.source?.targetChannel || !state.source.targetVersion} onClick={() => action({ case: "prepareSource", value: { channel: state.source!.targetChannel, version: state.source!.targetVersion } })}>{t("personalDevelopment.prepareSource")}</Button>
          <Button disabled={disabled || state.source?.status !== "ready" || selectedTarget === undefined} onClick={() => setConfirmation({ action: "update", commit: state.source?.commit ?? "" })}>{t("personalDevelopment.updateSource")}</Button><Button disabled={disabled || state.source?.status === "missing"} onClick={() => setConfirmation({ action: "reset", commit: state.source?.commit ?? "" })}>{t("personalDevelopment.resetSource")}</Button>
          <Button disabled={disabled || state.source?.status !== "ready"} onClick={() => action({ case: "refreshSourceStatus", value: {} })}>{t("personalDevelopment.checkSourceUpdates")}</Button><Button disabled={disabled || state.source?.status !== "ready"} onClick={() => action({ case: "openDirectory", value: { directory: PersonalDevelopmentDirectoryKind.SOURCE } })}>{t("personalDevelopment.openSourceDirectory")}</Button></div>
        <div className="setting-row"><span>{t("personalDevelopment.syncLatest")}</span><SwitchControl checked={state.syncLatestBeforeBuild} disabled={disabled} aria-label={t("personalDevelopment.syncLatest")} onChange={(event) => action({ case: "syncLatestBeforeBuild", value: { enabled: event.target.checked } })} /></div>
        {state.merge !== undefined && ["ready", "conflict"].includes(state.merge.status) && <div><p>{statusText(state.merge.status, t)}</p><div className="personal-development-actions">
          {state.merge.sessionId && <Button onClick={() => controller.navigate({ kind: "session", sessionId: state.merge!.sessionId })}>{t("personalDevelopment.openMerge")}</Button>}
          <Button disabled={disabled || selectedTarget === undefined} onClick={() => action({ case: "mergeSource", value: { action: "resolve", targetId: selectedTarget?.id } })}>{t("personalDevelopment.resolveMerge")}</Button>
          <Button disabled={disabled} onClick={() => action({ case: "mergeSource", value: { action: "adopt" } })}>{t("personalDevelopment.adoptMerge")}</Button><Button disabled={disabled} onClick={() => action({ case: "mergeSource", value: { action: "cancel" } })}>{t("common.cancel")}</Button></div></div>}
      </div>
      <div className="settings-card"><div className="personal-development-section-header"><h4>{t("personalDevelopment.tasks")}</h4><Button disabled={disabled || state.source?.status !== "ready"} onClick={() => setNewTask(true)}>{t("personalDevelopment.newTask")}</Button></div>
        {state.tasks.length === 0 && <p>{t("personalDevelopment.noTasks")}</p>}{state.tasks.map((task) => <article key={task.taskId}><strong>{task.title}</strong><p>{statusText(task.status, t)}</p><div className="personal-development-actions">
          {task.sessionId && <Button onClick={() => controller.navigate({ kind: "session", sessionId: task.sessionId })}>{t("personalDevelopment.openTask")}</Button>}
          {task.status === "completed" && <><Button disabled={disabled} onClick={() => control(task.taskId, "continue")}>{t("personalDevelopment.continue")}</Button><Button disabled={disabled} onClick={() => control(task.taskId, "start_test")}>{t("personalDevelopment.test")}</Button><Button disabled={disabled} onClick={() => action({ case: "build", value: { taskId: task.taskId } })}>{t("personalDevelopment.build")}</Button></>}
          {["failed", "cancelled"].includes(task.status) && <Button disabled={disabled} onClick={() => control(task.taskId, "retry_preparation")}>{t("personalDevelopment.retryPreparation")}</Button>}
          {state.tests.some((test) => test.taskId === task.taskId && test.status !== "stopped") && <Button disabled={disabled} onClick={() => control(task.taskId, "stop_test")}>{t("personalDevelopment.stopTest")}</Button>}
          {!["ended", "cancelled"].includes(task.status) && <Button disabled={disabled} onClick={() => control(task.taskId, "end")}>{t("personalDevelopment.endTask")}</Button>}
        </div>{task.operation && <PersonalDevelopmentProgress operation={task.operation} t={t} />}{task.error && <p role="alert">{errorText(task.error, t)}</p>}</article>)}
      </div>
      <div className="settings-card"><h4>{t("personalDevelopment.history")}</h4>{state.history.filter((entry) => !entry.hidden).map((entry) => <article key={entry.id}><label className="personal-development-history-choice"><CheckboxControl aria-label={t("personalDevelopment.selectChange", { title: entry.title })} checked={selectedHistory.includes(entry.id)} disabled={disabled || entry.state === "removed"} onChange={(event) => setSelectedHistory(current => event.target.checked ? [...current, entry.id] : current.filter(id => id !== entry.id))} /><strong>{entry.title}</strong></label><p>{statusText(entry.state, t)} · {entry.commit.slice(0, 12)}</p><div className="personal-development-actions">
        <Button disabled={disabled} onClick={() => action({ case: "history", value: { entryId: entry.id, action: entry.state === "integrated" ? "revert" : entry.state === "removed" ? "reapply" : "integrate" } })}>{t(entry.state === "integrated" ? "personalDevelopment.revert" : entry.state === "removed" ? "personalDevelopment.reapply" : "personalDevelopment.integrate")}</Button>
        <Button disabled={disabled} onClick={() => action({ case: "history", value: { entryId: entry.id, action: "hide" } })}>{t("personalDevelopment.hide")}</Button></div></article>)}
        <div className="personal-development-actions"><Button disabled={disabled || state.source?.status !== "ready"} onClick={() => action({ case: "build", value: {} })}>{t("personalDevelopment.buildBaseline")}</Button><Button disabled={disabled || selectedHistory.length === 0 || selectedHistory.some(id => !state.history.some(entry => entry.id === id && !entry.hidden && entry.state !== "removed"))} onClick={() => action({ case: "build", value: { entryIds: [...selectedHistory] } })}>{t("personalDevelopment.buildSelected")}</Button><Button disabled={disabled} onClick={() => action({ case: "recoverBuild", value: {} })}>{t("personalDevelopment.recoverBuild")}</Button></div>
      </div>
      {state.doctorRuns.length > 0 && <PersonalDevelopmentReportActions.Provider value={available ? reportActions : undefined}><div><h4>{t("personalDevelopment.reports")}</h4>{state.doctorRuns.map(report => <PersonalDevelopmentReport key={report.runId} report={report} task={state.tasks.find(task => task.taskId === report.taskId)} t={t} />)}</div></PersonalDevelopmentReportActions.Provider>}
      {state.operations.some((operation) => operation.status === "failed" || operation.status === "unknown") && <div className="settings-card"><h4>{t("personalDevelopment.recentActions")}</h4>{state.operations.filter((operation) => operation.status === "failed" || operation.status === "unknown").slice(-5).map((operation) => <p key={operation.id}>{errorText(operation.error, t)}</p>)}</div>}
    </>}
    </div>
    <Modal open={confirmation !== undefined} title={t(confirmation?.action === "reset" ? "personalDevelopment.resetSource" : "personalDevelopment.updateSource")} onClose={() => setConfirmation(undefined)} closeLabel={t("common.close")}>
      <p>{t(confirmation?.action === "reset" ? "personalDevelopment.resetConfirm" : "personalDevelopment.updateConfirm")}</p><div className="personal-development-actions"><Button onClick={() => setConfirmation(undefined)}>{t("common.cancel")}</Button><Button tone="primary" disabled={disabled || confirmation?.commit !== (state?.source?.commit ?? "")} onClick={() => {
        if (confirmation === undefined || disabled || confirmation.commit !== (state?.source?.commit ?? "")) return;
        const kind = confirmation.action; setConfirmation(undefined);
        if (kind === "reset") action({ case: "clearSource", value: {} });
        else if (selectedTarget !== undefined) action({ case: "mergeSource", value: { action: "start", targetId: selectedTarget.id } });
      }}>{t(confirmation?.action === "reset" ? "personalDevelopment.confirmReset" : "personalDevelopment.confirmUpdate")}</Button></div>
    </Modal>
    <Modal open={newTask} title={t("personalDevelopment.newTask")} onClose={closeTask} closeLabel={t("common.close")}>
      <form className="personal-development-task-form" onSubmit={(event) => { event.preventDefault(); if (selectedTarget === undefined || selectedModel === undefined || disabled || !request.trim()) return;
        if (launch === undefined && (state?.source?.status !== "ready" || state.environment?.status !== "ready")) return;
        const route = { targetId: selectedTarget.id, request, title: request.trim().slice(0, 80), providerId: selectedModel.providerId, modelId: selectedModel.modelId, permissionMode: "ask", planMode: false, fastMode: false };
        if (launch === undefined) void execute({ id: randomUuid(), kind: "task", draft: route });
        else void execute({ id: randomUuid(), kind: "doctor", draft: { ...route, mode: "prepare", sessionId: launch.originSessionId } }); }}>
        {!available && <p role="status">{loadFailed ? t("personalDevelopment.loadFailed") : t("personalDevelopment.localOnly")}</p>}
        {rejected && <p role="alert">{t("personalDevelopment.failed")}</p>}
        {available && state?.environment?.status !== "ready" && <div><p>{t("personalDevelopment.environment")}: {statusText(state?.environment?.status, t)}</p><Button disabled={disabled} onClick={() => action({ case: "prepareEnvironment", value: {} })}>{t("personalDevelopment.prepareEnvironment")}</Button></div>}
        {available && state?.source?.status !== "ready" && <div><p>{t("personalDevelopment.source")}: {statusText(state?.source?.status, t)}</p><Button disabled={disabled || state?.environment?.status !== "ready" || !state.source?.targetChannel || !state.source.targetVersion} onClick={() => action({ case: "prepareSource", value: { channel: state!.source!.targetChannel, version: state!.source!.targetVersion } })}>{t("personalDevelopment.prepareSource")}</Button></div>}
        {running.map((operation) => <div key={operation.id}><PersonalDevelopmentProgress operation={operation} t={t} /><Button disabled={busy} onClick={() => action({ case: "cancel", value: { operationId: operation.id } })}>{t("common.cancel")}</Button></div>)}
        {actionFailed && <div role="alert"><p>{t("personalDevelopment.actionUnknown")}</p><Button disabled={busy || intent === undefined} onClick={() => { if (intent !== undefined) void execute(intent); }}>{t("personalDevelopment.retryReceipt")}</Button></div>}
        <p>{t("personalDevelopment.taskHint")}</p><label>{t("personalDevelopment.backend")}<select value={selectedTarget?.id ?? ""} disabled={busy} onChange={(event) => { setTargetId(event.target.value); setModelKey(""); }}>{targets.map((target) => <option key={target.id} value={target.id}>{snapshot.backends.find((backend) => backend.id === target.backendId)?.name ?? target.name}</option>)}</select></label>
        <label>{t("personalDevelopment.model")}<select value={selectedModel === undefined ? "" : modelIdentity(selectedModel)} disabled={busy} onChange={(event) => setModelKey(event.target.value)}>{models.map((model) => <option key={modelIdentity(model)} value={modelIdentity(model)}>{model.name}</option>)}</select></label>
        <label>{t("personalDevelopment.request")}<textarea value={request} maxLength={4000} disabled={busy} onChange={(event) => setRequest(event.target.value)} /></label><div className="personal-development-actions"><Button disabled={busy} onClick={closeTask}>{t("common.cancel")}</Button><Button tone="primary" type="submit" disabled={disabled || !request.trim() || selectedModel === undefined || launch === undefined && (state?.source?.status !== "ready" || state?.environment?.status !== "ready")}>{t(launch === undefined ? "personalDevelopment.startTask" : "personalDevelopment.prepareAndCheck")}</Button></div>
      </form>
    </Modal>
  </section>;
}

function statusText(status: string | undefined, t: Translator): string {
  const labels = { unchecked: "unchecked", checking: "checking", preparing: "preparing", ready: "ready", failed: "failed", missing: "missing", cancelled: "cancelled", editing: "editing", completed: "completed", ended: "ended", cleanup: "cleanup", running: "running", stopped: "stopped", unknown: "unknown", available: "ready", integrated: "integrated", removed: "removed", conflict: "conflict", building: "building", unsupported: "unsupported" } as const;
  const key = labels[status as keyof typeof labels] ?? "running";
  return t(`personalDevelopment.status.${key}`);
}

function errorText(error: string | undefined, t: Translator): string {
  if (error === "TAG_NOT_FOUND") return t("personalDevelopment.tagMissing");
  if (error === "PROCESS_UNKNOWN") return t("personalDevelopment.processUnknown");
  if (error === "BUSY") return t("personalDevelopment.busy");
  if (error === "VERSION_INCOMPATIBLE") return t("personalDevelopment.incompatible");
  if (error === "CONFLICT" || error === "SOURCE_CHANGED" || error === "DIRTY") return t("personalDevelopment.sourceChanged");
  return t("personalDevelopment.failed");
}

function readIntent(owner: string): PendingIntent | undefined {
  try {
    const raw = localStorage.getItem(`joko.personal-action.v1:${owner}`);
    if (!raw || raw.length > 32_000) return undefined;
    const value = JSON.parse(raw) as Partial<PendingIntent>;
    if (typeof value.id !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(value.id)) return undefined;
    if (value.kind === "action" && typeof value.action === "object" && value.action !== null) return value as PendingIntent;
    if (value.kind === "task" && typeof value.draft === "object" && value.draft !== null) return value as PendingIntent;
    if (value.kind === "doctor" && typeof value.draft === "object" && value.draft !== null) return value as PendingIntent;
    if (value.kind === "control" && typeof value.taskId === "string" && typeof value.message === "string"
      && ["continue", "end", "start_test", "stop_test", "retry_preparation"].includes(value.action ?? "")) return value as PendingIntent;
  } catch { /* Invalid private client state cannot authorize a service effect. */ }
  return undefined;
}

export function rememberPersonalDevelopmentDoctor(controller: AppController, draft: PersonalDevelopmentDoctorDraft, id: string): () => void {
  const owner = JSON.stringify([controller.state.activeProfile?.deviceId, controller.state.activeProfile?.serverId, controller.state.activeProfile?.origin]);
  const key = `joko.personal-action.v1:${owner}`;
  const previous = readIntent(owner);
  if (previous !== undefined && previous.id !== id) throw new Error("Recover the pending personal development request before starting another action.");
  try { localStorage.setItem(key, JSON.stringify({ id, kind: "doctor", draft })); } catch { /* The initiating view retains this request while alive. */ }
  return () => { try { if (readIntent(owner)?.id === id) localStorage.removeItem(key); } catch { /* A later view can reconcile the durable receipt. */ } };
}
