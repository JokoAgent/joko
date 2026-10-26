import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Cloud, Network } from 'lucide-react';
import { authorizationView, formatDeviceInvitation, formatDeviceTarget, formatWebDeviceLink, type DeviceInvitation, type DeviceAuthorizationView, type DeviceAuthorizationReview } from '@joko/connection-transport/device-authorization';
import type { AppController } from '../controller.js';
import { randomUuid, sha256Hex } from '../web-crypto.js';
import type { Translator } from './types.js';
import { Button, ErrorBanner, SegmentedControl, CheckboxControl, SelectControl } from './ui.js';
import { DeviceInvitationQr } from './DeviceInvitationQr.js';

export function DeviceAuthorizationSettings({ controller, t, reviewRequest }: { readonly controller: AppController; readonly t: Translator; readonly reviewRequest?: DeviceAuthorizationReview }) {
  const owner = `${controller.state.activeProfile?.id}:${controller.state.connectionGeneration}`;
  return <DeviceAuthorizationSettingsBody key={`${owner}:${reviewRequest?.requestId ?? ''}`} controller={controller} t={t} reviewRequest={reviewRequest} />;
}
function DeviceAuthorizationSettingsBody({ controller, t, reviewRequest }: { readonly controller: AppController; readonly t: Translator; readonly reviewRequest?: DeviceAuthorizationReview }) {
  const api = useRef<import('@joko/connection-transport/device-authorization').DeviceAuthorizationOwner | undefined>(undefined);
  const [invitation, setInvitation] = useState<DeviceInvitation>(), [origin, setOrigin] = useState('');
  const [requests, setRequests] = useState<readonly DeviceAuthorizationView[]>([]), [selected, setSelected] = useState<string>();
  const [code, setCode] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [copied, setCopied] = useState(false);
  const prepared = useRef<{ invitationId: string; invitationSecret: string; shortCode: string; allowKnock: boolean; entryIds: string[] } | undefined>(undefined);
  const [scope, setScope] = useState<'all' | 'current' | 'selected'>('all'), [allowedIds, setAllowedIds] = useState<string[]>([]);
  const [available, setAvailable] = useState<import('@joko/contracts').NodeConnectionEntry[]>([]), directoryLoaded = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const [shareMode, setShareMode] = useState<'qr' | 'code'>('qr');
  const [entrances, setEntrances] = useState<import('@joko/contracts').NodeConnectionEntry[]>([]), [entryId, setEntryId] = useState('');
  const [requestLink, setRequestLink] = useState(''), [entranceReady, setEntranceReady] = useState(true);
  const alive = useRef(true), lock = useRef(false), polling = useRef(false), revision = useRef(0), [now, setNow] = useState(Date.now());
  const refresh = async () => {
    if (reviewRequest && (controller.state.activeProfile?.serverId !== reviewRequest.serverId || controller.state.activeProfile.endpointPublicKey !== reviewRequest.endpointPublicKey)) throw new Error(t('entries.reviewUnavailable'));
    const started = revision.current, result = await api.current!.list();
    if (alive.current && started === revision.current) { setRequests(result); setLoaded(true); }
    if (!reviewRequest && !directoryLoaded.current && api.current!.entries) {
      const entries = await api.current!.entries();
      if (alive.current && started === revision.current) { setAvailable(entries); directoryLoaded.current = true; }
    }
  };
  const run = async (action: () => Promise<void>, background = false) => {
    if (lock.current || background && polling.current) return;
    if (background) polling.current = true;
    else { lock.current = true; revision.current++; setBusy(true); setError(''); }
    const started = revision.current;
    try { api.current ??= controller.deviceAuthorizationOwner?.(); if (!api.current) throw new Error('Device approval is unavailable.'); await action(); } catch (failure) { if (alive.current && started === revision.current) setError(failure instanceof Error ? failure.message : t('error.unexpected')); }
    finally { if (background) polling.current = false; else { lock.current = false; if (alive.current) setBusy(false); } }
  };
  useEffect(() => {
    alive.current = true;
    void run(refresh, true);
    const timer = window.setInterval(() => { setNow(Date.now()); if (document.visibilityState === 'visible') void run(refresh, true); }, 3000);
    return () => { alive.current = false; clearInterval(timer); };
  }, []);
  const create = async (allowKnock = false) => {
    if (prepared.current && prepared.current.allowKnock !== allowKnock) throw new Error(t('authorization.retry'));
    const current = available.find(entry => entry.origin === controller.state.activeProfile?.origin && entry.transportKind === (controller.state.activeProfile?.transportKind ?? 'https'));
    const entryIds = scope === 'all' ? [] : scope === 'current' ? current ? [current.entryId] : [] : allowedIds;
    if (!prepared.current && scope !== 'all' && (!entryIds.length || entryIds.some(id => !available.some(entry => entry.entryId === id)))) throw new Error(t('entries.scopeRequired'));
    prepared.current ??= { invitationId: randomUuid(), invitationSecret: [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join(''),
      shortCode: [...crypto.getRandomValues(new Uint8Array(8))].map(byte => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[byte % 32]).join(''), allowKnock, entryIds: [...entryIds] };
    const seed = prepared.current;
    const result = await api.current!.create({ invitationId: seed.invitationId, invitationSecretDigest: await sha256Hex(new TextEncoder().encode(seed.invitationSecret).buffer),
      invitationCodeDigest: await sha256Hex(new TextEncoder().encode(seed.shortCode).buffer), allowKnock: seed.allowKnock, entryIds: seed.entryIds });
    const row = authorizationView(result.authorization);
    if (!alive.current) return;
    setEntrances(result.entries ?? []); setRequestLink('');
    const currentEntry = result.entries?.find(entry => !entry.requiresServerSetup && entry.origin === controller.state.activeProfile?.origin && entry.transportKind === (controller.state.activeProfile?.transportKind ?? 'https'))
      ?? result.entries?.find(entry => !entry.requiresServerSetup);
    setEntryId(currentEntry?.entryId ?? 'direct'); setEntranceReady(!currentEntry || currentEntry.transportKind === 'https');
    const invitationOrigin = currentEntry?.origin ?? result.origin;
    setInvitation({ invitationId: seed.invitationId, invitationSecret: seed.invitationSecret, origin: invitationOrigin, serverId: result.serverId, endpointPublicKey: result.endpointPublicKey, expiresAt: row.expiresAt });
    setOrigin(invitationOrigin); setCopied(false); await refresh();
  };
  const selectedEntry = entrances.find(entry => entry.entryId === entryId);
  const prepareInvitation = async () => {
    if (!invitation || !api.current?.invitationEntry) return;
    const result = await api.current.invitationEntry(invitation, entryId, selectedEntry?.requiresClientIdentity ? requestLink.trim() : undefined);
    if (alive.current) { setInvitation(result); setOrigin(result.origin); setEntranceReady(true); setCopied(false); }
  };
  const current = requests.find(row => reviewRequest ? row.invitationId === reviewRequest.invitationId && row.requestId === reviewRequest.requestId : row.invitationId === selected);
  const row = requests.find(value => value.invitationId === invitation?.invitationId);
  const shareable = invitation && invitation.expiresAt > now && (row === undefined || row.state === 'invited');
  let link: string | undefined;
  if (shareable && entranceReady) { try { link = formatDeviceInvitation({ ...invitation, origin }); } catch { /* A loopback node requires a reachable secure address. */ } }
  const target = link && invitation ? formatDeviceTarget({ ...invitation, origin }) : undefined;
  const nativeLink = shareMode === 'code' || prepared.current?.allowKnock ? target : link;
  const displayedLink = nativeLink ? formatWebDeviceLink(nativeLink, window.location.origin) : undefined;
  const visible = requests.filter(value => (value.requestId || value.state === 'invited' && value.invitationId !== invitation?.invitationId)
    && (!code.trim() || value.userCode.replaceAll('-', '') === code.toUpperCase().replace(/[\s-]/gu, '')));
  if (reviewRequest && !current) return <article className="settings-card settings-card--content device-authorization" aria-busy={busy}>
    <p role="status">{error || t(loaded ? 'entries.reviewUnavailable' : 'common.loading')}</p>
    <Button disabled={busy} onClick={() => void run(refresh)}>{t('authorization.retry')}</Button></article>;
  return <article className="settings-card settings-card--content device-authorization device-authorization--settings" aria-busy={busy}>
    <header className="device-authorization__copy"><strong>{t('authorization.add')}</strong>
      <p>{controller.state.activeProfile?.name} · {controller.state.activeProfile?.origin}</p></header>
    {current ? <section className="device-authorization__section device-authorization__review" aria-label={t('authorization.confirm')}>
      <header className="device-authorization__copy"><h3>{t('authorization.confirm')}</h3><strong>{current.deviceName} · {current.platform}</strong>
        <small>{t('authorization.unverified')}</small></header>
      <div className="device-authorization__matching"><small>{t('authorization.match')}</small><strong className="device-authorization__code">{current.userCode}</strong></div>
      <p>{t('authorization.permission')}</p><p role="status">{t(`authorization.${current.state}`)}</p>
      <div className="device-authorization__actions">
        {current.state === 'pending' && <>
          <Button disabled={busy || current.expiresAt <= now} onClick={() => void run(async () => { await api.current!.resolve(current.invitationId, current.requestId, 'denied'); await refresh(); })}>{t('authorization.deny')}</Button>
          <Button tone="primary" disabled={busy || current.expiresAt <= now} onClick={() => void run(async () => { await api.current!.resolve(current.invitationId, current.requestId, 'approved'); await refresh(); })}>{t('authorization.allow')}</Button>
        </>}
        {current.state === 'approved' && <Button disabled={busy} onClick={() => void run(async () => { await api.current!.resolve(current.invitationId, current.requestId, 'cancelled'); await refresh(); })}>{t('authorization.cancel')}</Button>}
        {!reviewRequest && <Button disabled={busy} onClick={() => setSelected(undefined)}>{t('authorization.close')}</Button>}
      </div>
    </section> : <><section className="device-authorization__section device-authorization__invitation">
      <p>{t('authorization.share')}</p>
      {!shareable && available.length > 0 && <details className="device-authorization__details"><summary>{t('entries.invitationOptions')}</summary><div>
        <p className="device-authorization__note">{t('entries.scopeHelp')}</p>
        <label><span>{t('entries.invitationOptions')}</span><SelectControl aria-label={t('entries.invitationOptions')} value={scope} disabled={busy || !!prepared.current} onChange={event => setScope(event.target.value as typeof scope)}>
          <option value="all">{t('entries.allowAll')}</option><option value="current">{t('entries.allowCurrent')}</option><option value="selected">{t('entries.allowSelected')}</option>
        </SelectControl></label>
        {scope === 'selected' && available.map(entry => <label className="device-authorization__scope-choice" key={entry.entryId}><CheckboxControl aria-label={entry.provider === 'direct' ? t('entries.direct') : entry.displayName} checked={allowedIds.includes(entry.entryId)} disabled={busy || !!prepared.current || entry.requiresServerSetup}
          onChange={event => setAllowedIds(ids => event.target.checked ? [...ids, entry.entryId] : ids.filter(id => id !== entry.entryId))} /><span>{entry.provider === 'direct' ? t('entries.direct') : entry.displayName}</span></label>)}
      </div></details>}
      {shareable ? <>
        {(entrances.length > 1 || !entranceReady) && <details className="device-authorization__details" open={!entranceReady || undefined}><summary>{t('entries.invitationCarrier')}</summary><div>
          <div className="connection-methods">{entrances.map(entry => <button key={entry.entryId} type="button" className={`connection-method${entryId === entry.entryId ? ' connection-method--recommended' : ''}`} disabled={busy || entry.requiresServerSetup}
            aria-pressed={entryId === entry.entryId} onClick={() => { setEntryId(entry.entryId); setEntranceReady(false); }}>
            <span className="connection-method__icon">{entry.provider === 'direct' ? <Network aria-hidden="true" /> : <Cloud aria-hidden="true" />}</span>
            <span><strong>{entry.provider === 'direct' ? t('entries.direct') : entry.displayName}</strong><small>{t(entry.requiresServerSetup ? 'entries.requires-setup' : entry.transportKind === 'https' ? 'entries.publicHelp' : 'entries.privateHelp')}</small></span>
            {entryId === entry.entryId ? <Check aria-hidden="true" /> : <ArrowRight aria-hidden="true" />}</button>)}</div>
          {!entranceReady && <>{selectedEntry?.requiresClientIdentity && <label><span>{t('entries.requestLink')}</span><textarea value={requestLink} rows={2} maxLength={512} onChange={event => setRequestLink(event.target.value)} /><small>{t('entries.requestHelp')}</small></label>}
            <Button disabled={busy || selectedEntry?.requiresClientIdentity && !requestLink.trim()} onClick={() => void run(prepareInvitation)}>{t('entries.prepareInvitation')}</Button></>}
        </div></details>}
        {!prepared.current?.allowKnock && <SegmentedControl label={t('entries.confirmMethod')} value={shareMode} onChange={setShareMode}
          options={[{ value: 'qr', label: t('entries.qrLink'), disabled: busy }, { value: 'code', label: t('entries.code'), disabled: busy }]} />}
        {displayedLink && <div className="device-authorization__share">{displayedLink.length <= 1800 ? <DeviceInvitationQr value={displayedLink} label={t('authorization.scan')} /> : <p>{t('entries.linkOnly')}</p>}
          <div className="device-authorization__share-actions">
          {shareMode === 'code' && !prepared.current?.allowKnock && <div className="device-authorization__admission"><small>{t('entries.code')}</small><strong className="device-authorization__code">{prepared.current?.shortCode.replace(/^(.{4})/u, '$1-')}</strong></div>}
          {prepared.current?.allowKnock && <p role="status">{t('entries.knockOpen')}</p>}
          <Button disabled={busy} onClick={() => void run(async () => { await navigator.clipboard.writeText(displayedLink); if (alive.current) setCopied(true); })}>{t('authorization.copy')}</Button>
          {copied && <small role="status">{t('authorization.copied')}</small>}
          </div>
        </div>}
        {entranceReady && <details className="device-authorization__details" open={!link || undefined}><summary>{t('authorization.invitationDetails')}</summary><div>
          <label><span>{t('connection.invitationAddress')}</span><input value={origin} onChange={event => { setOrigin(event.target.value); setCopied(false); }} type="url" /></label>
          <small>{t('authorization.secure')}</small>
          {link && <label><span>{t('authorization.paste')}</span><textarea readOnly value={link} rows={3} /></label>}
        </div></details>}
        <div className="device-authorization__footer"><p className="device-authorization__note" role="status">{t('authorization.invited')} · {t('connection.invitationExpires', { time: new Date(invitation.expiresAt).toLocaleTimeString() })}</p>
        <Button tone="ghost" disabled={busy} onClick={() => void run(async () => {
          const result = await api.current!.resolve(invitation.invitationId, '', 'cancelled');
          if (alive.current && result.state === 'cancelled') { setInvitation(undefined); prepared.current = undefined; }
          await refresh();
        })}>{t('common.cancel')}</Button></div>
      </> : <div className="device-authorization__actions"><Button tone="primary" disabled={busy} onClick={() => void run(async () => { if (invitation) { prepared.current = undefined; setInvitation(undefined); } await create(); })}>{t('authorization.add')}</Button>
        <Button disabled={busy} onClick={() => void run(async () => { if (invitation) { prepared.current = undefined; setInvitation(undefined); } await create(true); })}>{t('entries.openKnock')}</Button></div>}
      </section><section className="device-authorization__section device-authorization__requests"><h3>{t('authorization.requests')}</h3>
      {requests.some(value => value.requestId) && <details className="device-authorization__details"><summary>{t('authorization.lookup')}</summary><div>
        <label><span>{t('authorization.match')}</span><input value={code} onChange={event => setCode(event.target.value)} maxLength={16} autoComplete="off" /></label>
      </div></details>}
      {visible.length === 0 ? <p className="device-authorization__note">{t('authorization.noRequests')}</p> : visible.map(value => <div key={value.invitationId} className="device-authorization__request">
        <span>{value.requestId ? `${value.deviceName} · ${value.userCode}` : t('authorization.unused')}<small>{t(`authorization.${value.state}`)}</small>
          {!value.requestId && <small>{t('connection.invitationExpires', { time: new Date(value.expiresAt).toLocaleTimeString() })}</small>}</span>
        {value.requestId ? <Button disabled={busy} onClick={() => setSelected(value.invitationId)}>{t('authorization.review')}</Button>
          : <Button disabled={busy || value.expiresAt <= now} onClick={() => void run(async () => {
            await api.current!.resolve(value.invitationId, '', 'cancelled'); await refresh();
          })}>{t('authorization.cancelInvitation')}</Button>}
      </div>)}
      </section>
    </>}
    {error && <ErrorBanner message={error} />}
  </article>;
}
