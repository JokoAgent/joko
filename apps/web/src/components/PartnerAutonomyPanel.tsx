import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX } from "react";
import { PartnerGlancePhase, partnerAutonomyMessages, type GetPartnerGlanceResponse, type PartnerAutonomyApi,
  type PartnerAutonomySettings, type PartnerAutonomySettingChoice, PartnerGlanceTodos, partnerTodoDue, partnerMutationWasRejected } from "@joko/contracts";
import { Button, Modal } from "./ui.js";
import { PartnerGlanceContents } from "./PartnerGlanceContents.js";

/** Opening an invitation reads settings only. Reading task facts starts at the explicit glance entry. */
export function PartnerAutonomyPanel({ api, partnerId, name, locale, engaged, onOpenTask }: {
  readonly api: PartnerAutonomyApi; readonly partnerId: string; readonly name: string; readonly locale?: string;
  readonly engaged: boolean; readonly onOpenTask: (sessionId: string) => void;
}): JSX.Element {
  const m = partnerAutonomyMessages(locale), element = useRef<HTMLDetailsElement>(null), alive = useRef(true);
  const todos = useMemo(() => new PartnerGlanceTodos(api, partnerId), [api, partnerId]);
  const todoState = useSyncExternalStore(todos.subscribe, todos.snapshot), seenDue = useRef(new Set<string>());
  const [settings, setSettings] = useState<PartnerAutonomySettings>(), [page, setPage] = useState<GetPartnerGlanceResponse>();
  const [open, setOpen] = useState(false), [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  const flights = useRef(new Set<AbortController>()), pageEpoch = useRef(0), settingsEpoch = useRef(0);
  const attempt = useRef<{ operationId: string; revision: bigint; choice: PartnerAutonomySettingChoice } | undefined>(undefined);
  const invoke = async <T,>(action: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> => {
    const abort = new AbortController(); flights.current.add(abort);
    try { const value = await action(abort.signal); return alive.current && !abort.signal.aborted ? value : undefined; }
    finally { flights.current.delete(abort); }
  };
  const refreshSettings = async () => {
    const epoch = ++settingsEpoch.current;
    try { const value = await invoke(signal => api.settings(signal)); if (value && epoch === settingsEpoch.current) { setSettings(value); setFailed(false); } }
    catch { if (alive.current && epoch === settingsEpoch.current) setFailed(true); }
  };
  const refresh = async (more = false) => {
    const epoch = ++pageEpoch.current, before = page;
    try {
      const value = await invoke(signal => api.glance(partnerId, signal, more && before?.nextOffset !== undefined ? { token: before.snapshotToken, offset: before.nextOffset } : undefined));
      if (value && epoch === pageEpoch.current) { setPage(more && before ? { ...value, rows: [...before.rows, ...value.rows] } : value); setFailed(false); }
    } catch { if (alive.current && epoch === pageEpoch.current) setFailed(true); }
  };
  useEffect(() => {
    const owner = element.current?.ownerDocument ?? document;
    const foreground = () => { if (owner.visibilityState === "visible") todos.activate(); else todos.suspend(); };
    foreground(); owner.addEventListener("visibilitychange", foreground);
    return () => { owner.removeEventListener("visibilitychange", foreground); todos.dispose(); };
  }, [todos]);
  useEffect(() => {
    alive.current = true; void refreshSettings(); const owner = element.current?.ownerDocument ?? document;
    const hide = () => { setConsent(false); for (const abort of flights.current) abort.abort(); };
    owner.defaultView?.addEventListener("pagehide", hide);
    return () => { alive.current = false; for (const abort of flights.current) abort.abort(); owner.defaultView?.removeEventListener("pagehide", hide); };
  }, [api]);
  useEffect(() => {
    if (!open) return; const owner = element.current?.ownerDocument ?? document;
    const update = () => { if (owner.visibilityState === "visible") void refresh(); };
    update(); const timer = owner.defaultView?.setInterval(update, 30_000); owner.addEventListener("visibilitychange", update);
    return () => { if (timer !== undefined) owner.defaultView?.clearInterval(timer); owner.removeEventListener("visibilitychange", update); pageEpoch.current++; };
  }, [open, api, partnerId]);
  const save = async (choice?: PartnerAutonomySettingChoice) => {
    if (busy || !settings?.revision) return;
    if (!attempt.current) { if (!choice) return; attempt.current = { operationId: api.newOperationId(), revision: settings.revision.value, choice }; }
    setBusy(true); setFailed(false); const pending = attempt.current;
    try {
      const value = await invoke(signal => api.save(pending.operationId, pending.revision, pending.choice, signal)); if (!value) return;
      if (attempt.current === pending) attempt.current = undefined;
      setSettings(value); await refreshSettings(); if (open) await refresh();
    } catch (error) { if (alive.current) { if (partnerMutationWasRejected(error)) attempt.current = undefined; setFailed(true); } } finally { if (alive.current) setBusy(false); }
  };
  const configured = settings?.schedulerPartnerId === partnerId;
  const list = (working: boolean) => <section><h3>{working ? m.working : m.waiting} ({working ? page?.workingCount : page?.waitingCount})</h3><ul>
    {page?.rows.filter(row => (row.phase === PartnerGlancePhase.RUNNING || row.phase === PartnerGlancePhase.USAGE_LIMIT) === working).map(row => <li key={row.sessionId}>
      <button type="button" onClick={() => onOpenTask(row.sessionId)} disabled={!row.online}><span>{row.title}</span>
        <small>{row.question || (row.phase === PartnerGlancePhase.WAITING_PERMISSION ? m.permission : row.phase === PartnerGlancePhase.USAGE_LIMIT ? m.limit : m.task)}
          {row.deviceName ? ` · ${row.deviceName}` : ""} · {Math.max(0, Math.floor((Date.now() - Number(row.phaseSince!.seconds * 1000n)) / 60_000))} {m.minutes}</small></button>
    </li>)}</ul></section>;
  return <>
    {engaged && settings && !settings.customized && !settings.schedulerPartnerId && <section className="partner-follow-up-invitation" aria-label={m.invite}>
      <span>{m.invite}</span><Button disabled={busy || !!attempt.current} onClick={() => setConsent(true)}>{m.start}</Button>
      <Button disabled={busy || !!attempt.current} onClick={() => void save({ case: "disabled", value: true })}>{m.notNow}</Button>
    </section>}
    <details ref={element} className="partner-glance" onToggle={event => { setOpen(event.currentTarget.open); if (event.currentTarget.open)
      for (const todo of todoState.open) if (partnerTodoDue(todo, todoState.now)) seenDue.current.add(`${todo.id}:${todo.deadline?.at ?? todo.deadline?.date}`); }}><summary>{m.glance}
      {todoState.open.some(todo => partnerTodoDue(todo, todoState.now) && !seenDue.current.has(`${todo.id}:${todo.deadline?.at ?? todo.deadline?.date}`)) && <span className="partner-todo-due" />}</summary>
      <div className="partner-glance__content" aria-label={m.glance}><Button onClick={() => { void refreshSettings(); void refresh(); }}>{m.refresh}</Button>
        <PartnerGlanceContents api={api} partnerId={partnerId} editor={todos} locale={locale} enabled={open}
          close={() => { if (element.current) element.current.open = false; setOpen(false); }} />
        {failed && <p role="alert">{attempt.current ? m.saveUnknown : m.failed}</p>}{attempt.current && <Button disabled={busy} onClick={() => void save()}>{m.retrySave}</Button>}
        <details><summary>{m.task}</summary>{page ? <><p>{page.allTasks ? m.all : m.own} · {m.done.replace("{count}", String(page.doneToday))}</p>{list(false)}{list(true)}
          {page.rows.length === 0 && <p>{m.empty}</p>}{page.nextOffset !== undefined && <Button onClick={() => void refresh(true)}>{m.more}</Button>}</> : <p>{failed ? m.failed : m.loading}</p>}</details>
        <section><h3>{m.follow}</h3><p>{configured ? m.enabled : m.disabled}</p>
          <Button disabled={busy || !settings || !!attempt.current} onClick={() => configured ? void save({ case: "disabled", value: true }) : setConsent(true)}>{configured ? m.stop : m.start}</Button>
          <Button disabled={busy || !settings || !!attempt.current} onClick={() => void save({ case: "reset", value: true })}>{m.reset}</Button>
          <label><input type="checkbox" checked={!!settings?.schedulerFallbackPartnerIds.includes(partnerId)} disabled={busy || !settings || !!attempt.current}
            onChange={event => void save({ case: "fallback", value: { partnerId, allow: event.target.checked } })} />{m.fallback}</label>
        </section>
      </div>
    </details>
    {consent && <Modal open ownerDocument={element.current?.ownerDocument} title={m.invite} description={m.consent.replace("{name}", name)} size="small" dialogRole="alertdialog"
      onClose={() => setConsent(false)} showClose closeLabel={m.cancel}><Button disabled={busy || !!attempt.current} onClick={() => { setConsent(false); void save({ case: "schedulerPartnerId", value: partnerId }); }}>{m.start}</Button>
      <Button onClick={() => setConsent(false)}>{m.cancel}</Button></Modal>}
  </>;
}
