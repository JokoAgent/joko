import { useEffect, useMemo, useState, useSyncExternalStore, type JSX } from "react";
import { create } from "@bufbuild/protobuf";
import { PartnerRoutineEditor, RoutineCreationReceipts, RoutineTriggerSchema, RoutineFilterOperator, RoutineSourceStatus,
  newRoutineTrigger, routineMessages, routineDateInput, routineTimestamp, routineMilliseconds, routineTime, validRoutineDraft,
  type RoutineTrigger, type RoutineMessages } from "@joko/contracts";
import type { AppController } from "../controller.js";
import { usePartnerDocumentForeground } from "./use-partner-working-status.js";
import { Button, Modal, CheckboxControl } from "./ui.js";

export function PartnerRoutineDialog({ controller, partnerId, ownerKey, onClose, ownerDocument = document }: {
  readonly controller: AppController; readonly partnerId: string; readonly ownerKey: string; readonly onClose: () => void;
  readonly ownerDocument?: Document;
}): JSX.Element {
  const [editor, setEditor] = useState<PartnerRoutineEditor>();
  const [failed, setFailed] = useState(false);
  const m = routineMessages(controller.state.effectiveLocale);
  useEffect(() => {
    let current: PartnerRoutineEditor | undefined;
    try {
      const profile = controller.state.activeProfile;
      if (!profile?.serverId || !profile.deviceId || !profile.id) throw new Error("Routine owner unavailable.");
      const ownerWindow = ownerDocument.defaultView;
      if (ownerWindow === null || ownerWindow.closed) throw new Error("Routine document unavailable.");
      current = new PartnerRoutineEditor(controller.partnerRoutineApi(partnerId, ownerKey),
        new RoutineCreationReceipts(ownerWindow.localStorage, JSON.stringify([profile.serverId, profile.id, profile.deviceId, new URL(profile.origin).href])), partnerId);
      setEditor(current); setFailed(false);
    } catch { setFailed(true); }
    return () => current?.dispose();
  }, [controller, partnerId, ownerKey, ownerDocument]);
  return editor ? <RoutineContent editor={editor} connected={controller.state.connectionState === "connected"} m={m} onClose={onClose} ownerDocument={ownerDocument} />
    : <Modal open ownerDocument={ownerDocument} title={m.title} size="large" onClose={onClose} showClose closeLabel={m.close}><p role="alert">{failed ? m.failed : m.busy}</p></Modal>;
}

function RoutineContent({ editor, connected, m, onClose, ownerDocument }: { readonly editor: PartnerRoutineEditor; readonly connected: boolean; readonly m: RoutineMessages; readonly onClose: () => void; readonly ownerDocument: Document }): JSX.Element {
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot);
  const foreground = usePartnerDocumentForeground(ownerDocument);
  const [confirm, setConfirm] = useState<{ readonly body: string; readonly action: () => void }>();
  useEffect(() => { if (!foreground || !connected) editor.suspend(); else if (!editor.state.catalog) void editor.refresh(); }, [editor, foreground, connected]);
  useEffect(() => { const ownerWindow = ownerDocument.defaultView; if (!foreground || !connected || ownerWindow === null) return; const timer = ownerWindow.setInterval(() => { void editor.observe(); }, 3000); return () => ownerWindow.clearInterval(timer); }, [editor, foreground, connected, ownerDocument]);
  const close = () => { if (state.busy) return; if (editor.dirty) setConfirm({ body: m.discardBody, action: onClose }); else onClose(); };
  const refresh = () => { if (editor.dirty) setConfirm({ body: m.discardBody, action: () => { editor.discard(); void editor.refresh(); } }); else void editor.refresh(); };
  const locked = !foreground || !connected || !editor.writable;
  const draft = state.draft;
  return <Modal open ownerDocument={ownerDocument} title={m.title} description={m.body} size="large" onClose={close} showClose closeLabel={m.close}>
    <div className="partner-editor">
      <div className="toolbar-actions"><Button disabled={state.busy || !foreground || !connected} onClick={refresh}>{m.refresh}</Button>
        <Button disabled={locked || editor.dirty || !!state.pendingId} onClick={() => editor.select()}>{m.add}</Button>{state.busy && <span role="status">{m.busy}</span>}</div>
      {state.error && <p role="alert">{state.error === "pending" ? m.pending : m.failed}</p>}
      {state.requiresRefresh && <p role="status">{m.refreshRequired}</p>}
      {state.catalog && !state.catalog.writable && <p>{m.readonly}</p>}
      {state.pendingId && <div role="status"><p>{m.pending}</p><Button disabled={state.busy || !foreground || !connected} onClick={() => void editor.recover()}>{m.recover}</Button>
        <Button disabled={state.busy || !foreground || !connected} onClick={() => setConfirm({ body: m.retireBody, action: () => void editor.recover(true) })}>{m.retire}</Button></div>}
      {state.catalog?.routines.length === 0 && <p>{m.empty}</p>}
      <ul className="resource-list" aria-label={m.title}>{state.catalog?.routines.map(routine => <li key={routine.id}>
        <Button disabled={state.busy || state.requiresRefresh || editor.dirty} aria-pressed={state.selected?.id === routine.id} onClick={() => editor.select(routine)}>{routine.definition?.name}</Button>
        <label className="check-row"><CheckboxControl checked={!!routine.definition?.enabled} disabled={locked || editor.dirty} onChange={() => void editor.toggle(routine)} /><span>{m.enabled}</span></label>
        {routine.activity !== undefined && <small>{m.states[routine.activity] ?? m.states[0]}</small>}
      </li>)}</ul>
      {draft && !state.selected?.builtin && <fieldset disabled={locked || !!state.pendingId} style={{ border: 0, padding: 0, minWidth: 0 }}>
        <label className="field"><span>{m.name}</span><input value={draft.name} maxLength={200} required onChange={e => editor.edit({ name: e.target.value })} /></label>
        <label className="field"><span>{m.prompt}</span><textarea rows={7} value={draft.prompt} maxLength={100000} required onChange={e => editor.edit({ prompt: e.target.value })} /></label>
        <label className="check-row"><CheckboxControl checked={!!draft.enabled} onChange={e => editor.edit({ enabled: e.target.checked })} /><span>{m.enabled}</span></label>
        <label className="check-row"><CheckboxControl checked={!!draft.silentWhenIdle} onChange={e => editor.edit({ silentWhenIdle: e.target.checked })} /><span>{m.quiet}</span></label>
        <label className="field"><span>{m.check}</span><textarea rows={2} value={draft.preRunHook?.command ?? ""} maxLength={32000} onChange={e => editor.edit({ preRunHook: e.target.value.trim() ? { $typeName: "joko.v1.RoutinePreRunHook", command: e.target.value, timeoutMs: draft.preRunHook?.timeoutMs } : undefined })} /><small>{m.checkHelp}</small></label>
        {draft.preRunHook && <label className="field"><span>{m.timeout}</span><input type="number" min={1} value={draft.preRunHook.timeoutMs === undefined ? "" : Number(draft.preRunHook.timeoutMs) / 1000} onChange={e => editor.edit({ preRunHook: { ...draft.preRunHook!, timeoutMs: e.target.value === "" ? undefined : routineMilliseconds(e.target.value, 1000) } })} /></label>}
        <h3>{m.triggers}</h3>{draft.triggers.map((trigger, index) => <RoutineTriggerFields key={trigger.id} trigger={trigger} editor={editor} m={m}
          onChange={value => editor.edit({ triggers: draft.triggers.map((item, i) => i === index ? value : item) })}
          onRemove={() => editor.edit({ triggers: draft.triggers.filter((_, i) => i !== index) })} />)}
        <div className="toolbar-actions">{(["cron", "interval", "once", "event"] as const).map(kind => <Button key={kind} disabled={draft.triggers.length >= 32} onClick={() => editor.edit({ triggers: [...draft.triggers, newRoutineTrigger(kind, editor.api.newRequestId())] })}>+ {m[kind]}</Button>)}</div>
        <Button disabled={!editor.dirty || !validRoutineDraft(draft)} onClick={() => void editor.save()}>{m.save}</Button>
        {editor.dirty && <Button onClick={() => setConfirm({ body: m.discardBody, action: () => editor.discard() })}>{m.discard}</Button>}
      </fieldset>}
      {state.selected?.builtin && <p>{state.selected.definition?.prompt}</p>}
      {state.selected && <><div className="toolbar-actions">{!state.selected.builtin && <><Button disabled={locked || editor.dirty} onClick={() => void editor.run()}>{m.run}</Button>
        <Button disabled={locked || editor.dirty} onClick={() => setConfirm({ body: m.deleteBody, action: () => void editor.remove() })}>{m.remove}</Button></>}
        <Button disabled={state.busy || state.requiresRefresh || !foreground || !connected} onClick={() => void editor.history()}>{m.history}</Button></div>
        <ul aria-label={m.history}>{state.runs.map(run => <li key={run.id}><strong>{m.states[run.status] ?? m.states[0]}</strong> · {new Date(routineTime(run.createdAt)).toLocaleString()}<p>{run.error ?? run.resultText}</p></li>)}</ul>
        {state.runs.length === 0 && <p>{m.noHistory}</p>}{state.nextOffset !== undefined && <Button disabled={state.busy || state.requiresRefresh} onClick={() => void editor.history(true)}>{m.more}</Button>}</>}
    </div>
    {confirm && <Modal open ownerDocument={ownerDocument} title={m.title} description={confirm.body} size="small" dialogRole="alertdialog" onClose={() => setConfirm(undefined)} showClose closeLabel={m.close}>
      <Button onClick={() => { const action = confirm.action; setConfirm(undefined); action(); }}>{m.confirm}</Button><Button onClick={() => setConfirm(undefined)}>{m.back}</Button>
    </Modal>}
  </Modal>;
}

function RoutineTriggerFields({ trigger, editor, m, onChange, onRemove }: { readonly trigger: RoutineTrigger; readonly editor: PartnerRoutineEditor;
  readonly m: RoutineMessages; readonly onChange: (trigger: RoutineTrigger) => void; readonly onRemove: () => void }): JSX.Element {
  const update = (kind: RoutineTrigger["kind"]) => onChange(create(RoutineTriggerSchema, { id: trigger.id, kind }));
  const kind = trigger.kind;
  const source = kind.case === "event" ? editor.state.catalog?.sources.find(item => item.id === kind.value.sourceId) : undefined;
  const fields = useMemo(() => kind.case === "event" ? ["subject", ...source?.events.find(item => item.type === kind.value.eventType)?.fields ?? []] : [], [kind, source]);
  return <div className="partner-editor" style={{ padding: "12px 0", borderBottom: "1px solid var(--border)" }}>
    <strong>{kind.case && m[kind.case]}</strong>
    {kind.case === "cron" && <><label className="field"><span>{m.expression}</span><input value={kind.value.expression} maxLength={128} onChange={e => update({ case: "cron", value: { ...kind.value, expression: e.target.value } })} /></label><label className="field"><span>{m.timezone}</span><input value={kind.value.timezone} maxLength={128} onChange={e => update({ case: "cron", value: { ...kind.value, timezone: e.target.value } })} /></label></>}
    {kind.case === "interval" && <label className="field"><span>{m.minutes}</span><input type="number" min={1} value={Number(kind.value.intervalMs) / 60000} onChange={e => update({ case: "interval", value: { ...kind.value, intervalMs: routineMilliseconds(e.target.value, 60000) } })} /></label>}
    {kind.case === "once" && <label className="field"><span>{m.at}</span><input type="datetime-local" value={routineDateInput(kind.value.at)} onChange={e => update({ case: "once", value: { ...kind.value, at: routineTimestamp(e.target.value) } })} /></label>}
    {kind.case === "event" && <><label className="field"><span>{m.source}</span><select value={kind.value.sourceId} onChange={e => update({ case: "event", value: { ...kind.value, sourceId: e.target.value, eventType: "", filters: [] } })}><option value="">{m.sourceMissing}</option>{!source && kind.value.sourceId && <option value={kind.value.sourceId}>{kind.value.sourceId} · {m.sourceOffline}</option>}{editor.state.catalog?.sources.map(item => <option key={item.id} value={item.id}>{item.name} · {item.status === RoutineSourceStatus.LISTENING ? m.listening : m.sourceOffline}</option>)}</select></label>
      <label className="field"><span>{m.eventType}</span><select value={kind.value.eventType} onChange={e => update({ case: "event", value: { ...kind.value, eventType: e.target.value, filters: [] } })}><option value="">—</option>{kind.value.eventType && !source?.events.some(item => item.type === kind.value.eventType) && <option>{kind.value.eventType}</option>}{source?.events.map(item => <option key={item.type} value={item.type}>{item.name}</option>)}</select></label>
      <strong>{m.filters}</strong>{kind.value.filters.map((filter, index) => <div className="toolbar-actions" key={index}>
        <label className="field"><span>{m.field}</span><input list={`fields-${trigger.id}`} maxLength={128} value={filter.field} onChange={e => update({ case: "event", value: { ...kind.value, filters: kind.value.filters.map((item, i) => i === index ? { ...item, field: e.target.value } : item) } })} /><datalist id={`fields-${trigger.id}`}>{fields.map(field => <option key={field}>{field}</option>)}</datalist></label>
        <select aria-label={m.filters} value={filter.operator} onChange={e => update({ case: "event", value: { ...kind.value, filters: kind.value.filters.map((item, i) => i === index ? { ...item, operator: Number(e.target.value) } : item) } })}><option value={RoutineFilterOperator.EQUALS}>{m.equals}</option><option value={RoutineFilterOperator.NOT_EQUALS}>≠ {m.equals}</option><option value={RoutineFilterOperator.CONTAINS}>{m.contains}</option></select>
        <label className="field"><span>{m.value}</span><input value={filter.value} maxLength={2000} onChange={e => update({ case: "event", value: { ...kind.value, filters: kind.value.filters.map((item, i) => i === index ? { ...item, value: e.target.value } : item) } })} /></label>
        <Button aria-label={m.removeTrigger} onClick={() => update({ case: "event", value: { ...kind.value, filters: kind.value.filters.filter((_, i) => i !== index) } })}>×</Button>
      </div>)}<Button disabled={kind.value.filters.length >= 16} onClick={() => update({ case: "event", value: { ...kind.value, filters: [...kind.value.filters, { $typeName: "joko.v1.RoutineEventFilter", field: "", operator: RoutineFilterOperator.EQUALS, value: "" }] } })}>{m.addFilter}</Button></>}
    <Button onClick={onRemove}>{m.removeTrigger}</Button>
  </div>;
}
