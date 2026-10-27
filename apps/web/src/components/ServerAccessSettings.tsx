import { useEffect, useRef, useState } from 'react';
import './server-access.css';
import { ArrowRight, Cloud, Plus, Server } from 'lucide-react';
import { SERVER_ACCESS_PROVIDERS, serverAccessDefaults, serverAccessFields, serverAccessGuidance, serverAccessIssue, serverAccessText, serverAccessModes, serverAccessProvider, type ServerAccessField } from '@joko/contracts/server-access';
import type { GetServerAccessSettingsResponse, ServerAccessEntry } from '@joko/contracts';
import type { ServerAccessClient } from '@joko/connection-transport/server-access';
import type { AppController } from '../controller.js';
import { randomUuid } from '../web-crypto.js';
import { Button, CheckboxControl, ErrorBanner, SelectControl } from './ui.js';
import type { Translator } from './types.js';

interface Draft { entryId: string; revision: string; provider: string; mode: string; name: string; fields: Record<string, string>; secrets: readonly string[] }
export function ServerAccessSettings({ controller, t }: { readonly controller: AppController; readonly t: Translator }) {
  if (!controller.serverAccess) return null;
  return <ServerAccessBody key={`${controller.state.activeProfile?.id}:${controller.state.connectionGeneration}`} getApi={() => controller.serverAccess!()} t={t} />;
}
function ServerAccessBody({ getApi, t: translate }: { readonly getApi: () => ServerAccessClient; readonly t: Translator }) {
  const t = (key: string) => serverAccessText(key, translate);
  const api = useRef<ServerAccessClient | undefined>(undefined), alive = useRef(true), lock = useRef(false), request = useRef('');
  const [settings, setSettings] = useState<GetServerAccessSettingsResponse>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft>(), [catalog, setCatalog] = useState<'connection' | 'media'>(), [provider, setProvider] = useState('');
  const [confirm, setConfirm] = useState<{ entry: ServerAccessEntry; action: string }>(), [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false), [notice, setNotice] = useState('');
  const heading = useRef<HTMLHeadingElement>(null), savedDraft = useRef(false);
  const polling = useRef(false), revision = useRef(0);
  const refresh = async (id?: string) => {
    const started = revision.current;
    api.current ??= getApi(); const value = await api.current.read(id ?? request.current);
    if (!alive.current || started !== revision.current) return;
    setSettings(value);
    if (value.operationIssue) setError(serverAccessIssue(value.operationIssue, t));
    if (value.operationState) {
      const waiting = value.operationState === 'pending'; setPending(waiting);
      if (value.operationState === 'outcome_unknown') setError(t('access.issue.query_original_operation'));
      if (!waiting) {
        request.current = '';
        if (savedDraft.current && value.operationState === 'completed' && !value.operationIssue) { setDraft(undefined); savedDraft.current = false; setNotice(t('access.saved')); }
      }
    }
  };
  const run = async (work: () => Promise<void>, background = false) => {
    if (lock.current || background && polling.current) return;
    if (background) polling.current = true;
    else { lock.current = true; revision.current++; setBusy(true); setError(''); setNotice(''); }
    try { await work(); } catch (failure) { if (alive.current && !background) setError(serverAccessIssue(failure instanceof Error ? failure.message : '', t)); }
    finally { if (background) polling.current = false; else { lock.current = false; if (alive.current) setBusy(false); } }
  };
  useEffect(() => {
    alive.current = true; void run(() => refresh());
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void run(() => refresh(), true); }, 3000);
    return () => { alive.current = false; clearInterval(timer); };
  }, []);
  useEffect(() => { if (draft || catalog || confirm) heading.current?.focus(); }, [draft?.entryId, catalog, confirm?.action]);
  const change = async (entry: ServerAccessEntry, action: string, confirmation = false) => {
    const id = randomUuid(); request.current = id; setPending(true);
    api.current ??= getApi();
    try {
      await api.current.change({ requestId: id, entryId: entry.entryId, expectedRevision: entry.revision, action,
        confirmDisconnection: confirmation, confirmResourceId: confirmation ? entry.resourceId : '' });
      if (alive.current) setConfirm(undefined);
    } finally { await refresh(id); }
  };
  const begin = (selectedProvider: string, mode: string) => {
    setDraft({ entryId: selectedProvider === 'cloudflare' && mode === 'quick' ? 'cloudflare-quick' : `access-${randomUuid()}`, revision: '', provider: selectedProvider, mode,
      name: serverAccessProvider(selectedProvider)?.name ?? selectedProvider, fields: { ...serverAccessDefaults(selectedProvider, mode) }, secrets: [] }); setCatalog(undefined); setProvider('');
  };
  const edit = (entry: ServerAccessEntry) => { setDraft({ entryId: entry.entryId, revision: entry.revision, provider: entry.provider, mode: entry.mode, name: entry.name, fields: { ...entry.fields }, secrets: entry.configuredSecrets }); setNotice(''); };
  const ask = (entry: ServerAccessEntry, action: string) => { setConfirm({ entry, action }); setConfirmed(false); };
  const disabled = busy || pending;
  const selectedCapability = settings?.capabilities.find(value => value.provider === draft?.provider && value.mode === draft.mode);
  const field = (definition: ServerAccessField) => {
    if (!draft) return null;
    const label = t(`access.field.${definition.key}`), value = draft.fields[definition.key] ?? '';
    const update = (value: string) => setDraft(current => current ? { ...current, fields: { ...current.fields, [definition.key]: value } } : current);
    const secret = definition.kind === 'secret', configured = draft.secrets.includes(definition.key);
    const changeValue = (value: string) => {
      if (secret && !value && configured) setDraft(current => { if (!current) return current; const fields = { ...current.fields }; delete fields[definition.key]; return { ...current, fields }; });
      else update(value);
    };
    return <label key={definition.key} className={definition.kind === 'toggle' ? 'server-access__toggle' : ''}>
      {definition.kind !== 'toggle' && <span>{label}{definition.required && <small> · {t('access.required')}</small>}</span>}
      {definition.kind === 'choice' ? <SelectControl aria-label={label} value={value} disabled={disabled} onChange={event => update(event.target.value)}>{definition.choices?.map(choice => <option value={choice} key={choice}>{definition.key === 'resourceMode' ? t(`access.resource.${choice}`) : choice}</option>)}</SelectControl>
        : definition.kind === 'toggle' ? <><CheckboxControl aria-label={label} checked={value === 'true'} disabled={disabled} onChange={event => update(String(event.target.checked))} /><span>{label}</span></>
        : definition.kind === 'multiline' || definition.multiline ? <textarea aria-label={label} className={secret ? 'server-access__sensitive' : undefined} rows={4} value={value}
          onChange={event => changeValue(event.target.value)} disabled={disabled} required={definition.required && !configured} placeholder={secret && configured ? t('access.secret') : undefined} maxLength={16384} spellCheck={false} autoComplete="off" />
        : <input aria-label={label} type={secret ? 'password' : definition.kind === 'number' ? 'number' : 'text'} inputMode={definition.kind === 'number' ? 'numeric' : undefined}
          value={value} onChange={event => changeValue(event.target.value)} disabled={disabled}
          required={definition.required && !configured} placeholder={secret && configured ? t('access.secret') : undefined} maxLength={secret ? 16384 : 4096} autoComplete={secret ? 'new-password' : 'off'} spellCheck={false} />}
      {secret && configured && <span className="server-access__secret-clear"><CheckboxControl aria-label={`${t('access.clearSecret')}: ${label}`} checked={draft.fields[definition.key] === ''} disabled={disabled}
        onChange={event => setDraft(current => { if (!current) return current; const fields = { ...current.fields }; if (event.target.checked) fields[definition.key] = ''; else delete fields[definition.key]; return { ...current, fields }; })} />{t('access.clearSecret')}</span>}
    </label>;
  };
  const entries = settings?.entries ?? [];
  return <article className="settings-card settings-card--content server-access" aria-busy={busy}>
    <header className="server-access__header"><div><h3 ref={heading} tabIndex={-1}>{t('access.title')}</h3><p>{t('access.description')}</p></div>
      <Button tone="ghost" disabled={busy} onClick={() => void run(() => refresh())}>{t(pending ? 'access.retry' : 'access.refresh')}</Button></header>
    {error && <ErrorBanner message={error} />}{notice && <p role="status">{notice}</p>}
    {!settings && <p role="status">{t('access.loading')}</p>}
    {confirm ? <section className="server-access__form" aria-label={t(`access.${confirm.action}`)}><h4>{confirm.entry.name} · {t(`access.${confirm.action}`)}</h4>
      <p>{t(confirm.action === 'adopt' ? 'access.adoptWarning' : confirm.action === 'accept_source' ? 'access.sourceWarning' : confirm.action.startsWith('resource_') ? 'access.resourceWarning' : confirm.action === 'delete' && !confirm.entry.enabled ? 'access.deleteWarning' : 'access.stopWarning')}</p>
      {confirm.entry.resourceId && <p className="server-access__address">{t('access.resourceId')}: {confirm.entry.resourceId}</p>}
      {['stop', 'delete'].includes(confirm.action) && confirm.entry.enabled && <label className="server-access__toggle"><CheckboxControl checked={confirmed} disabled={disabled} onChange={event => setConfirmed(event.target.checked)} /><span>{t('access.confirmStop')}</span></label>}
      <div className="server-access__actions"><Button disabled={disabled} onClick={() => setConfirm(undefined)}>{t('access.cancel')}</Button>
        <Button tone="primary" disabled={disabled || ['stop', 'delete'].includes(confirm.action) && confirm.entry.enabled && !confirmed} onClick={() => void run(() => change(confirm.entry, confirm.action, true))}>{t('access.confirm')}</Button></div>
    </section> : draft ? <form className="server-access__form" onSubmit={event => {
      event.preventDefault(); if (disabled) return;
      void run(async () => { const id = randomUuid(); request.current = id; savedDraft.current = true; setPending(true); api.current ??= getApi();
        try { await api.current.save({ requestId: id, entryId: draft.entryId, expectedRevision: draft.revision, provider: draft.provider, mode: draft.mode, name: draft.name, fields: draft.fields }); }
        finally { await refresh(id); }
      });
    }}>
      <h4>{serverAccessProvider(draft.provider)?.name} · {serverAccessModes(draft.provider).find(mode => mode.id === draft.mode)?.label}</h4>
      {serverAccessGuidance(draft.provider, draft.mode).map(key => <p key={key}>{t(key)}</p>)}
      {selectedCapability && selectedCapability.state !== 'ready' && <p role="note">{t(`access.${selectedCapability.state}`)}. {t(selectedCapability.state === 'missing_tls' ? 'access.tlsHelp' : selectedCapability.state === 'external_ice_config' ? 'access.issue.external_ice_config' : 'access.runtimeHelp')} <small>{selectedCapability.issue.startsWith('runtime:') ? selectedCapability.issue.slice(8) : ''}</small></p>}
      <label><span>{t('access.name')}</span><input value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} required maxLength={80} disabled={disabled} /></label>
      {serverAccessFields(draft.provider, draft.mode, draft.fields).filter(value => !value.advanced).map(field)}
      {serverAccessFields(draft.provider, draft.mode, draft.fields).some(value => value.advanced) && <details className="server-access__advanced"><summary>{t('access.advanced')}</summary><div>{serverAccessFields(draft.provider, draft.mode, draft.fields).filter(value => value.advanced).map(field)}</div></details>}
      <p className="server-access__note">{t('access.secretHelp')}</p>
      <div className="server-access__actions"><Button disabled={disabled} onClick={() => { setDraft(undefined); savedDraft.current = false; }}>{t('access.cancel')}</Button><Button type="submit" tone="primary" disabled={disabled}>{t('access.save')}</Button></div>
    </form> : catalog ? <section className="server-access__form"><h4>{t(provider ? 'access.mode' : 'access.choose')}</h4>
      {provider ? serverAccessModes(provider).filter(mode => (mode.purpose === 'media') === (catalog === 'media')).map(mode => {
        const capability = settings?.capabilities.find(value => value.provider === provider && value.mode === mode.id);
        return <button type="button" className="connection-method" key={mode.id} disabled={disabled} onClick={() => begin(provider, mode.id)}><Cloud aria-hidden="true" /><span><strong>{mode.label}</strong><small>{t(`access.${capability?.state ?? 'missing_runtime'}`)}</small></span><ArrowRight aria-hidden="true" /></button>;
      }) : SERVER_ACCESS_PROVIDERS.filter(value => serverAccessModes(value.id).some(mode => (mode.purpose === 'media') === (catalog === 'media'))).map(value => <button type="button" key={value.id} className="connection-method" disabled={disabled} onClick={() => {
        const modes = serverAccessModes(value.id).filter(mode => (mode.purpose === 'media') === (catalog === 'media')); if (modes.length === 1) begin(value.id, modes[0]!.id); else setProvider(value.id);
      }}><Server aria-hidden="true" /><span><strong>{value.name}</strong></span><ArrowRight aria-hidden="true" /></button>)}
      <Button disabled={disabled} onClick={() => provider ? setProvider('') : setCatalog(undefined)}>{t('access.back')}</Button>
    </section> : <>
      {(['connection', 'media'] as const).map(purpose => <section className="server-access__group" key={purpose}>
        {purpose === 'media' && <><h4>{t('access.media')}</h4><p>{t('access.mediaHelp')}</p></>}
        {entries.filter(entry => (serverAccessModes(entry.provider).find(mode => mode.id === entry.mode)?.purpose === 'media') === (purpose === 'media')).map(entry => <div className="server-access__entry" key={entry.entryId}>
          <div><strong>{entry.name}</strong><small>{serverAccessProvider(entry.provider)?.name} · {t(`access.${entry.source}`)}</small></div>
          <p role="status">{t(`access.state.${entry.state}`)}</p>{entry.publicOrigin && <p className="server-access__address">{entry.publicOrigin}</p>}
          {entry.pendingChanges && <p>{t('access.pending')}</p>}{entry.issue && <p>{serverAccessIssue(entry.issue, t)}</p>}
          {entry.resourceId && <p className="server-access__address">{t('access.resourceId')}: {entry.resourceId}</p>}
          {entry.resourceState && <p>{t('access.resourceState')}: {t(`access.resourceState.${entry.resourceState}`)}</p>}
          {entry.resourceRequiresDns && <p>{t('access.dns')}</p>}
          <div className="server-access__actions">
            {entry.source === 'deployment' ? <Button disabled={disabled} onClick={() => ask(entry, 'adopt')}>{t('access.adopt')}</Button> : <>
              <Button disabled={disabled} onClick={() => edit(entry)}>{t('access.edit')}</Button>
              {entry.state === 'source_conflict' ? <Button disabled={disabled} onClick={() => ask(entry, 'accept_source')}>{t('access.accept_source')}</Button>
                : entry.state === 'outcome_unknown' ? <Button disabled={busy} onClick={() => void run(() => change(entry, 'reconcile'))}>{t('access.reconcile')}</Button>
                : entry.state !== 'active' && <Button tone="primary" disabled={disabled || ['starting', 'stopping'].includes(entry.state)} onClick={() => void run(() => change(entry, 'start'))}>{t('access.start')}</Button>}
              {entry.state === 'starting' && <Button disabled={busy} onClick={() => void run(() => change(entry, 'stop', true))}>{t('access.cancel')}</Button>}
              {(entry.enabled || entry.state === 'active') && <Button disabled={disabled} onClick={() => ask(entry, 'stop')}>{t('access.stop')}</Button>}
              <Button tone="ghost" disabled={disabled} onClick={() => ask(entry, 'delete')}>{t('access.delete')}</Button>
            </>}
          </div>
          {entry.source === 'gui' && (entry.fields['resourceMode'] === 'managed' || entry.resourceState) && <div className="server-access__resource"><p>{t('access.resourceHelp')}</p>
            <div className="server-access__actions"><Button disabled={disabled} onClick={() => void run(() => change(entry, 'resource_status'))}>{t('access.resource_status')}</Button>
              {(!entry.resourceState || ['deleted', 'not_created', 'rejected'].includes(entry.resourceState)) && <Button disabled={disabled} onClick={() => ask(entry, 'resource_create')}>{t('access.resource_create')}</Button>}
              {entry.resourceNeedsAdoption && <Button disabled={disabled} onClick={() => ask(entry, 'resource_adopt')}>{t('access.resource_adopt')}</Button>}
              {entry.resourceId && !entry.resourceNeedsAdoption && <Button disabled={disabled || entry.state === 'active'} onClick={() => ask(entry, 'resource_delete')}>{t('access.resource_delete')}</Button>}
            </div></div>}
          {purpose === 'connection' && entry.state === 'active' && <p className="server-access__note">{t('access.shareHelp')}</p>}
        </div>)}
        {purpose === 'connection' && entries.length === 0 && <p>{t('access.empty')}</p>}
        <Button disabled={disabled || !settings} onClick={() => { setCatalog(purpose); setProvider(''); }}><Plus aria-hidden="true" />{t(purpose === 'media' ? 'access.addMedia' : 'access.add')}</Button>
      </section>)}
    </>}
  </article>;
}
