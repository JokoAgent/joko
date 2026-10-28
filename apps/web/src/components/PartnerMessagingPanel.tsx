import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Code, ConnectError } from '@connectrpc/connect';
import { PartnerMessagingLaneKind, PartnerMessagingRestartPhase, partnerMessagingMessages, partnerMutationWasRejected,
  type GetMessagingSettingsResponse, type ListPartnerMessagingLanesResponse,
  type PartnerMessagingBindingRequest, type PartnerMessagingLane, type PartnerMessagingRestartRequest } from '@joko/contracts';
import type { AppController } from '../controller.js';
import type { PartnerProfileView } from '../model.js';
import { Button, Modal, SelectControl, Spinner } from './ui.js';

/** Settings and the Partner profile use this same original channel owner. */
export function PartnerMessagingPanel({ controller, ownerKey, connectionId, partner }: {
  readonly controller: AppController; readonly ownerKey: string; readonly connectionId?: string; readonly partner?: PartnerProfileView;
}): JSX.Element | null {
  const controllerRef = useRef(controller); controllerRef.current = controller;
  const connected = controller.state.ready && controller.state.connectionState === 'connected';
  const [apiRetry, setApiRetry] = useState(0);
  const apiBinding = useMemo(() => {
    if (!connected) return { api: undefined, failed: false };
    try { const api = controllerRef.current.partnerMessagingApi?.(ownerKey); return { api, failed: api === undefined }; }
    catch { return { api: undefined, failed: true }; }
  }, [ownerKey, connected, controller.state.connectionGeneration, apiRetry]);
  const api = apiBinding.api, bindingRef = useRef(apiBinding); bindingRef.current = apiBinding;
  const m = partnerMessagingMessages(controller.state.effectiveLocale), alive = useRef(true), flights = useRef(new Set<AbortController>());
  const [settings, setSettings] = useState<GetMessagingSettingsResponse>(), [partners, setPartners] = useState<readonly PartnerProfileView[]>([]);
  const [failed, setFailed] = useState(false), [busy, setBusy] = useState<string>(), [choices, setChoices] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<string>(), [lanes, setLanes] = useState<ListPartnerMessagingLanesResponse>();
  const [confirmation, setConfirmation] = useState<PartnerMessagingLane>(), [notice, setNotice] = useState<string>();
  const saves = useRef(new Map<string, PartnerMessagingBindingRequest>()), restarts = useRef(new Map<string, PartnerMessagingRestartRequest>());
  const retainedOwner = useRef(ownerKey);
  const isCurrent = () => alive.current && bindingRef.current === apiBinding;
  const invoke = async <T,>(action: (signal: AbortSignal) => Promise<T>) => {
    if (!api || !isCurrent()) return undefined;
    const abort = new AbortController(); flights.current.add(abort);
    try { const value = await action(abort.signal); return isCurrent() && !abort.signal.aborted ? value : undefined; }
    catch (error) { if (!isCurrent() || abort.signal.aborted) return undefined; throw error; }
    finally { flights.current.delete(abort); }
  };
  const refresh = async () => {
    if (!api) return;
    try {
      const result = await invoke(signal => Promise.all([api.settings(signal), controller.listPartners(undefined, signal)]));
      if (result && isCurrent()) { setSettings(result[0]); setPartners(result[1].partners); setFailed(false); }
    } catch { if (isCurrent()) setFailed(true); }
  };
  useEffect(() => {
    alive.current = true; setBusy(undefined); setConfirmation(undefined);
    if (retainedOwner.current !== ownerKey) {
      retainedOwner.current = ownerKey; saves.current.clear(); restarts.current.clear();
      setSettings(undefined); setPartners([]); setChoices({}); setExpanded(undefined); setLanes(undefined); setConfirmation(undefined); setNotice(undefined);
    }
    void refresh();
    return () => { alive.current = false; for (const flight of flights.current) flight.abort(); flights.current.clear(); };
  }, [apiBinding]);
  useEffect(() => {
    if (!api || !expanded) return;
    const abort = new AbortController(); let reading = false;
    const load = async () => {
      if (reading || abort.signal.aborted || document.hidden) return;
      reading = true;
      try { const value = await api.lanes(expanded, abort.signal); if (!abort.signal.aborted && isCurrent()) { setLanes(value); setFailed(false); } }
      catch { if (!abort.signal.aborted && isCurrent()) setFailed(true); } finally { reading = false; }
    };
    void load(); const timer = window.setInterval(() => void load(), 5000);
    document.addEventListener('visibilitychange', load);
    return () => { abort.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', load); };
  }, [apiBinding, expanded]);
  if (!api) return apiBinding.failed ? <section className="partner-messaging-panel" aria-label={m.title}>
    <p role="alert">{m.failed} <Button onClick={() => setApiRetry(value => value + 1)}>{m.refresh}</Button></p>
  </section> : null;
  const save = async (id: string, value: string) => {
    if (busy) return;
    const connection = settings?.connections.find(row => row.connectionId === id), binding = settings?.partnerBindings.find(row => row.connectionId === id);
    const selected = partners.find(row => row.id === value);
    let request = saves.current.get(id);
    if (!request) {
      if (!connection?.revision || value && !selected) return;
      request = { operationId: api.newOperationId(), connectionId: id, expectedConnectionRevision: connection.revision,
        expectedConnectionGeneration: connection.generation, expectedBindingRevision: binding?.revision ?? 0n,
        destination: value ? { case: 'partnerId', value } : { case: 'personal', value: true },
        ...(selected ? { expectedPartnerRevision: { value: selected.revision } } : {}) };
      saves.current.set(id, request);
    }
    setBusy(id); setNotice(undefined);
    try {
      const result = await invoke(signal => api.save(request!, signal));
      if (!result || !isCurrent()) return;
      saves.current.delete(id); setChoices(current => { const next = { ...current }; delete next[id]; return next; });
      await refresh(); if (isCurrent()) setNotice(undefined);
    } catch (error) {
      if (!isCurrent()) return;
      if (partnerMutationWasRejected(error)) { saves.current.delete(id); await refresh(); if (isCurrent()) setNotice(m.failed); }
      else setNotice(m.unknown);
    } finally { if (isCurrent()) setBusy(undefined); }
  };
  const restart = async (lane: PartnerMessagingLane, confirmed = false) => {
    if (busy || !expanded || !lanes?.binding) return;
    let request = restarts.current.get(lane.conversationId);
    if (!request && !confirmed) { setConfirmation(lane); return; }
    if (!request) {
      request = { operationId: api.newOperationId(), connectionId: expanded, conversationId: lane.conversationId,
        expectedBindingRevision: lanes.binding.revision, expectedSessionGeneration: lane.generation };
      restarts.current.set(lane.conversationId, request);
    }
    setBusy(lane.conversationId); setConfirmation(undefined);
    try {
      const value = await invoke(async signal => {
        if (confirmed) return api.restart(request!, signal);
        try {
          const receipt = await api.lookup(request!.operationId!, signal);
          return receipt.phase === PartnerMessagingRestartPhase.READY ? receipt : api.retry(receipt.operationId, signal);
        } catch (error) { if (error instanceof ConnectError && error.code === Code.NotFound) return api.restart(request!, signal); throw error; }
      });
      if (!value || !isCurrent()) return;
      if (value.phase === PartnerMessagingRestartPhase.READY) { restarts.current.delete(lane.conversationId); setNotice(m.ready); }
      else setNotice(m.closing);
      const next = await invoke(signal => api.lanes(expanded, signal)); if (next && isCurrent()) setLanes(next);
    } catch (error) {
      if (!isCurrent()) return;
      if (partnerMutationWasRejected(error)) restarts.current.delete(lane.conversationId);
      setNotice(m.unknown);
    } finally { if (isCurrent()) setBusy(undefined); }
  };
  const connections = settings?.connections.filter(row => {
    if (connectionId && row.connectionId !== connectionId) return false;
    const binding = settings.partnerBindings.find(value => value.connectionId === row.connectionId);
    return !partner || !binding?.partnerId || binding.partnerId === partner.id;
  }) ?? [];
  const ready = partners.filter(row => row.lifecycle === 'active' && row.initializationState === 'ready' && !row.pauseCleanupPending && row.canonicalSessionId);
  return <section className="partner-messaging-panel" aria-label={m.title}>
    <p>{m.scope}</p>
    {failed && <p role="alert">{m.failed} <Button onClick={() => void refresh()}>{m.refresh}</Button></p>}
    {notice && <p role="status">{notice}</p>}
    {!settings && !failed && <Spinner />}
    {settings && connections.length === 0 && <p>{m.empty}</p>}
    {connections.map(connection => {
      const binding = settings!.partnerBindings.find(row => row.connectionId === connection.connectionId), bound = binding?.partnerId ?? '';
      const selected = choices[connection.connectionId] ?? bound, pending = saves.current.has(connection.connectionId);
      return <div className="partner-messaging-panel__connection" key={connection.connectionId}>
        {!connectionId && <strong>{connection.providerUsername ?? connection.providerAccountId ?? connection.connectionId}</strong>}
        <label className="field"><span>{m.destination}</span><SelectControl value={selected} disabled={!!busy || pending} onChange={event => setChoices(current => ({ ...current, [connection.connectionId]: event.target.value }))}>
          <option value="">{m.personal}</option>
          {ready.filter(row => !partner || row.id === partner.id).map(row => <option key={row.id} value={row.id}>{row.displayName}</option>)}
          {bound && !ready.some(row => row.id === bound) && <option value={bound} disabled>{partners.find(row => row.id === bound)?.displayName ?? bound}</option>}
        </SelectControl></label>
        <Button disabled={!!busy || !pending && selected === bound} onClick={() => void save(connection.connectionId, selected)}>{pending ? m.retry : m.save}</Button>
        {bound && <Button tone="ghost" disabled={!!busy} onClick={() => { setLanes(undefined); setExpanded(expanded === connection.connectionId ? undefined : connection.connectionId); }}>{m.lanes}</Button>}
        {expanded === connection.connectionId && <div aria-live="polite">
          {!lanes && !failed && <Spinner />}
          {lanes?.lanes.length === 0 && <p>{m.empty}</p>}
          {lanes?.lanes.map(lane => <div key={lane.conversationId} className="partner-messaging-panel__lane">
            <strong>{lane.kind === PartnerMessagingLaneKind.OWNER_DM ? m.owner_dm : lane.title}</strong>
            <span>{lane.running ? m.run : lane.failed ? m.error : ''} · {lane.contextMessageCount.toString()} {m.messages}</span>
            <Button disabled={!!busy || !lane.canRestart && !restarts.current.has(lane.conversationId)} onClick={() => void restart(lane)}>{restarts.current.has(lane.conversationId) ? m.retry : m.restart}</Button>
          </div>)}
        </div>}
      </div>;
    })}
    {partner && <a href="#/settings/messaging">{m.title}</a>}
    <Modal open={confirmation !== undefined} title={m.restart} description={m.confirm} onClose={() => setConfirmation(undefined)}>
      <Button onClick={() => setConfirmation(undefined)}>{m.close}</Button><Button tone="primary" onClick={() => { if (confirmation) void restart(confirmation, true); }}>{m.restart}</Button>
    </Modal>
  </section>;
}
