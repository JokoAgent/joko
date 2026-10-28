import { useEffect, useRef, useState, useSyncExternalStore, type JSX } from "react";
import { PartnerTaskOutputReadiness, partnerAutonomyMessages, partnerTodoDate, partnerTodoDue,
  type PartnerAutonomyApi, type PartnerGlanceTodos, type PartnerTaskOutput, type PartnerTodo, type PartnerHomeApi, type PartnerHomeDestination, type ListPartnerHomeTargetsResponse } from "@joko/contracts";
import { usePartnerConversation } from "./PartnerConversation.js";
import { Button } from "./ui.js";

/** Final glance entry: home computer, the owner's affairs, and files from actual completed task Runs. */
export function PartnerGlanceContents({ api, partnerId, editor, locale, enabled, close }: { readonly api: PartnerAutonomyApi;
  readonly partnerId: string; readonly editor: PartnerGlanceTodos; readonly locale?: string; readonly enabled: boolean; readonly close: () => void }): JSX.Element {
  const m = partnerAutonomyMessages(locale), conversation = usePartnerConversation(), state = useSyncExternalStore(editor.subscribe, editor.snapshot);
  const [all, setAll] = useState(false), [done, setDone] = useState(false), [menu, setMenu] = useState<PartnerTodo>();
  const [outputs, setOutputs] = useState<readonly PartnerTaskOutput[]>([]), [outputFailed, setOutputFailed] = useState(false), [outputRefresh, setOutputRefresh] = useState(0);
  const alive = useRef(true), outputFlight = useRef<AbortController | undefined>(undefined);
  useEffect(() => { alive.current = true; return () => { alive.current = false; outputFlight.current?.abort(); }; }, []);
  useEffect(() => {
    if (!enabled) return; const abort = new AbortController(); outputFlight.current?.abort(); outputFlight.current = abort;
    void api.outputs(partnerId, abort.signal).then(value => { if (!abort.signal.aborted) { setOutputs(value); setOutputFailed(false); } })
      .catch(() => { if (!abort.signal.aborted) setOutputFailed(true); });
    return () => { abort.abort(); setMenu(undefined); };
  }, [api, partnerId, enabled, outputRefresh]);
  const openOutput = async (source: PartnerTaskOutput, path: string) => {
    const abort = new AbortController(); outputFlight.current?.abort(); outputFlight.current = abort;
    try {
      const latest = (await api.outputs(partnerId, abort.signal)).find(row => row.sourceId === source.sourceId && row.sourceKind === source.sourceKind);
      if (!alive.current || abort.signal.aborted) return;
      if (!latest || latest.sessionId !== source.sessionId || latest.execution !== source.execution || latest.sourceRevision?.value !== source.sourceRevision?.value
        || latest.runIds.join("\0") !== source.runIds.join("\0") || !latest.files.some(file => file.path === path)) throw new Error("The output source changed.");
      close(); conversation?.openOutputFile?.(source.sessionId, path);
    } catch { if (alive.current && !abort.signal.aborted) setOutputFailed(true); }
  };
  const quote = (todo: PartnerTodo) => { conversation?.quoteTodo?.(todo); close(); };
  const row = (todo: PartnerTodo) => <li key={todo.id}><button type="button" aria-label={`${m.quote}: ${todo.title}`} onClick={() => quote(todo)}
    onContextMenu={event => { event.preventDefault(); setMenu(todo); }} onKeyDown={event => {
      if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") { event.preventDefault(); setMenu(todo); }
    }}><span>{partnerTodoDue(todo, state.now) && <span className="partner-todo-due" aria-label={locale === 'zh-CN' ? '已到期' : 'Due'} />}{todo.title}</span>
      <small>{[todo.progress, partnerTodoDate(todo, locale), todo.sources[0]?.label].filter(Boolean).join(" · ")}</small></button>
    {menu?.id === todo.id && <div role="menu" onKeyDown={event => { if (event.key === "Escape") setMenu(undefined); }}>
      <button type="button" role="menuitem" autoFocus disabled={state.saving || state.pending} onClick={() => { setMenu(undefined); void editor.mutate(todo, "delete"); }}>{m.remove}</button>
    </div>}</li>;
  const files = outputs.filter(output => output.readiness === PartnerTaskOutputReadiness.READY).flatMap(output => output.files.map(file => ({ output, file })));
  return <>
    {conversation?.homeApi && conversation.openHomeSettings ? <PartnerGlanceComputers key={`${conversation.homeApi.ownerKey}:${partnerId}`} api={conversation.homeApi} partnerId={partnerId} locale={locale} enabled={enabled}
      onSelect={destination => { close(); conversation.openHomeSettings?.(destination); }} /> : <section><h3>{m.computers}</h3><span>{conversation?.homeLabel || m.here}</span></section>}
    {(state.openTotal > 0 || state.doneTotal > 0 || state.failed || state.deleted || !state.loaded) && <section><h3>{m.todos}</h3>
      {state.failed && <p role="alert">{state.pending ? m.saveUnknown : m.failed}</p>}
      {state.failed && <Button disabled={state.saving} onClick={() => state.pending ? void editor.mutate() : void editor.refresh()}>{state.pending ? m.retrySave : m.refresh}</Button>}
      {!state.loaded && <p>{m.loading}</p>}<ul>{(all ? state.open : state.open.slice(0, 5)).map(row)}</ul>
      {state.open.length > 5 && <Button aria-expanded={all} onClick={() => setAll(value => !value)}>{m.more} ({state.openTotal})</Button>}
      {state.doneTotal > 0 && <><Button aria-expanded={done} onClick={() => setDone(value => !value)}>{m.completed} ({state.doneTotal})</Button>{done && <ul>{state.done.map(row)}</ul>}</>}
      {state.deleted && <Button disabled={state.saving || state.pending} onClick={() => void editor.mutate(state.deleted, "restore")}>{m.undo}: {state.deleted.title}</Button>}
    </section>}
    {(files.length > 0 || outputFailed) && <section><h3>{m.outputs}</h3>{outputFailed && <Button onClick={() => setOutputRefresh(value => value + 1)}>{m.failed} {m.refresh}</Button>}
      <ul>{files.slice(0, all ? 30 : 3).map(({ output, file }) => <li key={`${output.sourceKind}:${output.sourceId}:${file.path}`}>
        <button type="button" onClick={() => void openOutput(output, file.path)}><span>{file.path.split('/').at(-1)}</span><small>{output.title}</small></button>
      </li>)}</ul>{files.length > 3 && <Button aria-expanded={all} onClick={() => setAll(value => !value)}>{m.more} ({files.length})</Button>}
    </section>}
  </>;
}

/** Reads only the existing residence catalog; choosing a row opens its ordinary confirmation. */
export function PartnerGlanceComputers({ api, partnerId, locale, enabled, onSelect }: { readonly api: PartnerHomeApi; readonly partnerId: string; readonly locale?: string;
  readonly enabled: boolean; readonly onSelect: (destination: PartnerHomeDestination) => void }): JSX.Element {
  const m = partnerAutonomyMessages(locale), [catalog, setCatalog] = useState<ListPartnerHomeTargetsResponse>(), [failed, setFailed] = useState(false), [offline, setOffline] = useState(false), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!enabled) return; const scope = new AbortController(); let reading = false;
    const read = async () => { if (reading || scope.signal.aborted || document.hidden) return; reading = true;
      try { const value = await api.list(partnerId, scope.signal); if (!value.home) throw new Error("The home computer is unavailable."); if (!scope.signal.aborted) { setCatalog(value); setFailed(false); } }
      catch { if (!scope.signal.aborted) setFailed(true); } finally { reading = false; } };
    void read(); document.addEventListener("visibilitychange", read);
    return () => { scope.abort(); document.removeEventListener("visibilitychange", read); };
  }, [api, partnerId, enabled, refresh]);
  const others = catalog?.targets.filter(target => target.destination?.location.case === "serviceNode" ? !catalog.home?.serviceNode
    : target.destination?.location.case === "peer" && target.destination.location.value.targetDeviceId !== catalog.home?.deviceId) ?? [];
  const disconnected = others.filter(target => !target.available);
  return <section><h3>{m.computers}</h3>{catalog?.home ? <p><strong>{catalog.home.deviceName}</strong><small> · {m.here} · {catalog.home.available ? m.online : m.offline}</small></p> : !failed && <p>{m.loading}</p>}
    {others.filter(target => target.available).map((target, index) => <button type="button" key={index} disabled={catalog?.home?.changing || !target.destination} onClick={() => target.destination && onSelect(target.destination)}><span>{target.deviceName}</span><small> · {m.online}</small></button>)}
    {disconnected.length > 0 && <Button tone="ghost" aria-expanded={offline} onClick={() => setOffline(value => !value)}>{m.offlineCount.replace("{count}", String(disconnected.length))}</Button>}
    {offline && disconnected.map((target, index) => <p key={index}><span>{target.deviceName}</span><small> · {m.offline}</small></p>)}
    {failed && <p role="alert">{m.computersFailed}<Button onClick={() => setRefresh(value => value + 1)}>{m.refresh}</Button></p>}
  </section>;
}
