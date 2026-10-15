import { createContext, useContext, useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { PersonalDevelopmentDoctorRun, PersonalDevelopmentTask } from "@joko/contracts";
import type { AppController } from "../controller.js";
import type { PersonalDevelopmentSnapshot } from "../personal-development-api.js";
import type { TimelineItemView } from "../model.js";
import { randomUuid } from "../web-crypto.js";
import type { Translator } from "./types.js";
import { Button, Pill, Spinner } from "./ui.js";
import { PersonalDevelopmentProgress } from "./PersonalDevelopmentProgress.js";
import { PersonalDevelopmentChecks } from "./PersonalDevelopmentChecks.js";
import "./PersonalDevelopmentSettings.css";

export const PersonalDevelopmentReportActions = createContext<Pick<AppController, "controlPersonalDevelopmentDoctor" | "controlPersonalDevelopmentTask" | "navigate" | "openHttpLink"> | undefined>(undefined);
type PersonalDevelopmentReportView = PersonalDevelopmentDoctorRun & { readonly task?: PersonalDevelopmentTask };

/** Private reports join their owning transcript by creation time, without
 * pretending to be Backend messages or advancing the durable Event cursor. */
export function usePersonalDevelopmentReports(controller: AppController, sessionId: string, enabled: boolean): readonly PersonalDevelopmentReportView[] {
  const key = JSON.stringify([controller.state.activeProfile?.id, controller.state.activeProfile?.serverId, controller.state.activeProfile?.origin, controller.state.connectionGeneration, sessionId]);
  const [value, setValue] = useState<{ readonly key: string; readonly reports: readonly PersonalDevelopmentReportView[] }>();
  useEffect(() => {
    const scope = new AbortController(); let generation = -1n;
    const retire = (): void => { scope.abort(); setValue({ key, reports: [] }); };
    window.addEventListener("pagehide", retire, { once: true });
    if (enabled && controller.state.connectionState === "connected" && typeof controller.getPersonalDevelopment === "function") {
      const accept = (snapshot: PersonalDevelopmentSnapshot): void => {
        if (scope.signal.aborted) return;
        if (!snapshot.available) { scope.abort(); setValue({ key, reports: [] }); return; }
        if (snapshot.state === undefined || snapshot.state.generation < generation) return;
        generation = snapshot.state.generation; setValue({ key, reports: snapshot.state.doctorRuns.filter(report => report.sessionId === sessionId || report.codeSessionId === sessionId)
          .map(report => ({ ...report, task: snapshot.state!.tasks.find(task => task.taskId === report.taskId) })) });
      };
      void (async () => {
        let initial: PersonalDevelopmentSnapshot | undefined;
        try { initial = await controller.getPersonalDevelopment(scope.signal); }
        catch { if (scope.signal.aborted) return; }
        if (scope.signal.aborted) return;
        if (initial !== undefined) accept(initial);
        if (initial?.available !== false) await controller.watchPersonalDevelopment(initial?.state?.generation ?? 0n, accept, scope.signal);
      })().catch(() => undefined);
    }
    return () => { scope.abort(); window.removeEventListener("pagehide", retire); };
  }, [key, enabled, controller.state.connectionState]);
  return enabled && controller.state.connectionState === "connected" && value?.key === key ? value.reports : [];
}

export function mergePersonalDevelopmentReports(items: readonly TimelineItemView[], reports: readonly PersonalDevelopmentReportView[]): readonly TimelineItemView[] {
  if (reports.length === 0) return items;
  const result: TimelineItemView[] = [], pending = [...reports].sort((left, right) => Number(left.createdAtMs - right.createdAtMs));
  let index = 0, previousSequence = 0n;
  const append = (report: PersonalDevelopmentReportView): void => { result.push({ id: `personal-report:${report.runId}`, kind: "status", sequence: previousSequence,
    createdAt: Number(report.createdAtMs), personalDevelopmentReport: report, personalDevelopmentTask: report.task }); };
  for (const item of items) {
    while (index < pending.length && Number(pending[index]!.createdAtMs) <= item.createdAt) append(pending[index++]!);
    result.push(item); previousSequence = item.sequence;
  }
  while (index < pending.length) append(pending[index++]!);
  return result;
}

export function PersonalDevelopmentReport({ report, task, t }: { readonly report: PersonalDevelopmentDoctorRun; readonly task?: PersonalDevelopmentTask; readonly t: Translator }): JSX.Element {
  const actions = useContext(PersonalDevelopmentReportActions), [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  const pending = useRef<{ readonly id: string; readonly action: "cancel" | "retry" | "wait" | "personal" | "retry_preparation" } | undefined>(undefined);
  const inFlight = useRef(false);
  const scope = useRef<AbortController | undefined>(undefined);
  useEffect(() => { const owner = new AbortController(); scope.current = owner; return () => owner.abort(); }, [report.runId, actions]);
  const control = async (action: "cancel" | "retry" | "wait" | "personal" | "retry_preparation"): Promise<void> => {
    if (!actions || inFlight.current || scope.current?.signal.aborted) return;
    const intent = pending.current ?? { id: randomUuid(), action }; if (intent.action !== action) return;
    pending.current = intent; inFlight.current = true; const signal = scope.current?.signal; setBusy(true); setFailed(false);
    try {
      const receipt = action === "retry_preparation" && task !== undefined
        ? (await actions.controlPersonalDevelopmentTask(task.taskId, action, "", intent.id, signal), report)
        : await actions.controlPersonalDevelopmentDoctor(report.runId, action as "cancel" | "retry" | "wait" | "personal", intent.id, signal);
      if (signal?.aborted) return; pending.current = undefined;
      if (receipt.codeSessionId) actions.navigate({ kind: "session", sessionId: receipt.codeSessionId });
    } catch { if (!signal?.aborted) setFailed(true); }
    finally { inFlight.current = false; if (!signal?.aborted) setBusy(false); }
  };
  const choices = report.mode === "prepare" && report.status === "completed" && !report.decision
    && ["found", "notFound"].includes(report.upstream?.status ?? "");
  const canRetry = ["failed", "cancelled"].includes(report.status) || report.status === "completed" && report.decision !== "personal"
    && (report.decision === "wait" || report.upstream?.status === "failed" || report.checks.some(check => check.status !== "ready"));
  const stage = report.stage.includes("upstream") ? "upstream" : report.stage.includes("source") ? "source" : "environment";
  const status = (["running", "completed", "cancelled", "failed", "unknown"] as const).find(value => value === report.status) ?? "unknown";
  const items = useMemo(() => (report.upstream?.items ?? []).filter(item => item.htmlUrl === `https://github.com/JokoAgent/joko/pull/${item.number}` && item.number > 0), [report.upstream]);
  return <article className="personal-development-report settings-card" aria-label={t(report.mode === "check" ? "personalDevelopment.doctorTitle" : "personalDevelopment.title")}>
    <header><strong>{t(report.mode === "check" ? "personalDevelopment.doctorTitle" : "personalDevelopment.title")}</strong><Pill tone={status === "failed" || status === "unknown" ? "warning" : "neutral"}>{t(`personalDevelopment.status.${status}`)}</Pill></header>
    {report.request && <p>{report.request}</p>}
    {status === "running" && <p role="status"><Spinner />{t(`personalDevelopment.${stage}`)}</p>}
    {report.operation && <PersonalDevelopmentProgress operation={report.operation} t={t} />}
    {report.checks.length > 0 && <PersonalDevelopmentChecks checks={report.checks} t={t} openHttpLink={actions?.openHttpLink} />}
    {report.source && <p>{t("personalDevelopment.source")}: {t(report.source.status === "ready" ? "personalDevelopment.status.ready" : report.source.status === "preparing" ? "personalDevelopment.status.preparing" : "personalDevelopment.status.failed")}</p>}
    {report.error && <p role="alert">{t(report.error === "TAG_NOT_FOUND" ? "personalDevelopment.tagMissing" : report.error === "PROCESS_UNKNOWN" ? "personalDevelopment.processUnknown" : "personalDevelopment.failed")}</p>}
    {report.upstream && <div><h4>{t("personalDevelopment.upstream")}</h4>{report.upstream.status === "notFound" && <p>{t("personalDevelopment.noUpstream")}</p>}
      {report.upstream.status === "failed" && <p role="alert">{t("personalDevelopment.upstreamFailed")}</p>}
      {report.upstream.runtime?.confidence !== "exact" && <p>{t("personalDevelopment.runtimeUnknown")}</p>}
      {report.upstream.runtime && <p className="personal-development-identity">{t("personalDevelopment.runningSource")}: {report.upstream.runtime.channel} · {report.upstream.runtime.version}{report.upstream.runtime.commit ? ` · ${report.upstream.runtime.commit.slice(0, 12)}` : ""}</p>}
      {report.upstream.terms.length > 0 && <p>{t("personalDevelopment.searchTerms")}: {report.upstream.terms.join(" · ")}</p>}
      {items.map(item => <div key={item.number}><Button onClick={() => { void actions?.openHttpLink(item.htmlUrl); }}>#{item.number} {item.title}</Button><span>{item.state === "merged" ? t("personalDevelopment.merged") : item.state === "closed" ? t("personalDevelopment.closed") : t("personalDevelopment.open")}{item.draft ? ` · ${t("personalDevelopment.draft")}` : ""}</span>{(item.author || item.updatedAt) && <small>{[item.author, item.updatedAt].filter(Boolean).join(" · ")}</small>}{item.inclusion === "unknown" && <small>{t("personalDevelopment.inclusionUnknown")}</small>}<p>{item.summary}</p></div>)}
      {report.upstream.excludedIncluded > 0 && <p>{t("personalDevelopment.includedOmitted", { count: report.upstream.excludedIncluded })}</p>}
      {report.upstream.hasMore && <p>{t("personalDevelopment.moreUpstream")}</p>}
    </div>}
    {task && <div className="personal-development-task-preparation"><h4>{t("personalDevelopment.taskPreparation")}</h4><p>{t(["failed", "cancelled", "unknown"].includes(task.status) ? "personalDevelopment.status.failed" : task.status === "preparing" ? "personalDevelopment.status.preparing" : "personalDevelopment.status.ready")}</p>{task.operation && <PersonalDevelopmentProgress operation={task.operation} t={t} />}{task.error && <p role="alert">{t(task.error === "PROCESS_UNKNOWN" ? "personalDevelopment.processUnknown" : "personalDevelopment.failed")}</p>}
      {actions && ["failed", "cancelled"].includes(task.status) && <Button disabled={busy} onClick={() => { void control("retry_preparation"); }}>{t("personalDevelopment.retryPreparation")}</Button>}</div>}
    <div className="personal-development-actions">
      {actions && status === "running" && <Button disabled={busy} onClick={() => { void control("cancel"); }}>{t("common.cancel")}</Button>}
      {actions && canRetry && <Button disabled={busy} onClick={() => { void control("retry"); }}>{t("common.retry")}</Button>}
      {actions && choices && <><Button disabled={busy} onClick={() => { void control("wait"); }}>{t("personalDevelopment.waitUpstream")}</Button><Button tone="primary" disabled={busy} onClick={() => { void control("personal"); }}>{t("personalDevelopment.choosePersonal")}</Button></>}
      {actions && report.codeSessionId && <Button onClick={() => actions.navigate({ kind: "session", sessionId: report.codeSessionId })}>{t("personalDevelopment.openTask")}</Button>}
    </div>
    {report.decision === "wait" && <p>{t("personalDevelopment.waitingUpstream")}</p>}
    {failed && <p role="alert">{t("personalDevelopment.actionUnknown")}<Button disabled={busy} onClick={() => { if (pending.current) void control(pending.current.action); }}>{t("personalDevelopment.retryReceipt")}</Button></p>}
  </article>;
}
