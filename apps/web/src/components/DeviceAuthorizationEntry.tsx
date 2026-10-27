/*!
 * Device authorization dependencies
 *
 * qrcode-generator 2.0.4
 * Copyright (c) 2009 Kazuhiko Arase
 * Source: https://github.com/kazuhikoarase/qrcode-generator
 *
 * expo-camera 57.0.4 (Mobile only)
 * Copyright (c) 2015-present 650 Industries, Inc. (aka Expo)
 * Source: https://github.com/expo/expo/tree/main/packages/expo-camera
 *
 * Both dependencies are licensed under the MIT License:
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Clock3, Cloud, Network, Link2, QrCode, ShieldCheck, XCircle } from 'lucide-react';
import { parseDeviceInvitation, parseDeviceTarget, parseDeviceTransportRequest, formatWebDeviceLink, type DeviceAuthorizationProgress, type DeviceInvitationEntry } from '@joko/connection-transport/device-authorization';
import type { ConnectionScreenController } from '../connection-contract.js';
import type { Translator } from './types.js';
import { Button, ErrorBanner, Spinner } from './ui.js';
import { DeviceInvitationQr } from './DeviceInvitationQr.js';
import { SERVER_ACCESS_PROVIDERS } from '@joko/contracts/server-access';
import './server-access.css';

export function DeviceAuthorizationEntry({ controller, t, defaultName, initialInvitation, automatic, onStageChange, discoveredNode, onClearDiscovered }: {
  readonly controller: ConnectionScreenController; readonly t: Translator; readonly defaultName: string; readonly initialInvitation?: string; readonly automatic?: boolean;
  readonly onStageChange?: (stage: 'choice' | 'invite' | 'pending') => void;
  readonly discoveredNode?: { readonly serverId: string; readonly name: string; readonly origin: string };
  readonly onClearDiscovered?: () => void;
}) {
  const [link, setLink] = useState(initialInvitation ?? ''), [name, setName] = useState(defaultName);
  const [stage, setStage] = useState<'choice' | 'invite'>(initialInvitation ? 'invite' : 'choice');
  const [progress, setProgress] = useState<DeviceAuthorizationProgress>();
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [scanError, setScanError] = useState(false);
  const [editLink, setEditLink] = useState(!initialInvitation);
  const [entrances, setEntrances] = useState<readonly DeviceInvitationEntry[]>([]), [entryId, setEntryId] = useState<string>();
  const [entriesLoading, setEntriesLoading] = useState(false), [entriesError, setEntriesError] = useState('');
  const [admission, setAdmission] = useState<'code' | 'knock'>(), [invitationCode, setInvitationCode] = useState(''), [admissionError, setAdmissionError] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const [reviewCopied, setReviewCopied] = useState(false), [copyError, setCopyError] = useState('');
  const [privateMode, setPrivateMode] = useState(false), [transportRequest, setTransportRequest] = useState('');
  const [providerGuide, setProviderGuide] = useState('');
  const [now, setNow] = useState(Date.now()), [entriesRevision, setEntriesRevision] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null), paste = useRef<HTMLTextAreaElement>(null);
  const invitationHint = useId();
  const current = useRef({ controller, t }); current.current = { controller, t };
  const abort = useRef<AbortController | undefined>(undefined), lock = useRef(false), polling = useRef(false), stopped = useRef(false);
  const perform = async (action: 'start' | 'refresh' | 'cancel' | 'finish' | 'discard' | 'forget' | 'scan' | 'resolve' | 'transport' | 'restoreTransport' | 'cancelTransport', background = false, kind?: 'iroh' | 'tailcat') => {
    if (lock.current && (background || !polling.current) || current.current.controller.state.interactive === false) return;
    if (polling.current) abort.current?.abort();
    const api = current.current.controller.deviceAuthorization;
    if (!api) return;
    const request = new AbortController(); abort.current = request; lock.current = true; polling.current = background;
    if (!background) { setBusy(true); setError(''); setScanError(false); setAdmissionError(false); }
    try {
      if (action === 'restoreTransport') { const value = await api.pendingTransportRequest?.(request.signal); request.signal.throwIfAborted(); setTransportRequest(value ?? ''); return; }
      if (action === 'cancelTransport') { await api.cancelTransportRequest!(parseDeviceTransportRequest(transportRequest).requestId, request.signal); request.signal.throwIfAborted(); setTransportRequest(''); return; }
      if (action === 'transport') { const value = await api.transportRequest!(kind!, request.signal); request.signal.throwIfAborted(); setTransportRequest(value); return; }
      if (action === 'scan') { const value = await current.current.controller.scanDeviceInvitation!(); parseDeviceTarget(value); request.signal.throwIfAborted(); setLink(value); setEditLink(false); setStage('invite'); return; }
      if (action === 'resolve') {
        const value = await api.resolveTarget!(link.trim(), admission === 'code' ? invitationCode : undefined, request.signal);
        request.signal.throwIfAborted(); setLink(value); setEditLink(false); return;
      }
      if (action === 'start' && savedNode && current.current.controller.connectSavedInvitation) {
        await current.current.controller.connectSavedInvitation(link.trim(), automatic, entryId); return;
      }
      if (action === 'discard' || action === 'forget') { await api.discard(action === 'forget'); request.signal.throwIfAborted(); setProgress(undefined); setLink(''); setStage('choice'); setConfirmForget(false); stopped.current = false; return; }
      if (action === 'finish') { await api.finish(request.signal, automatic); return; }
      const value = action === 'start' ? await api.start(link.trim(), name, request.signal, entryId)
        : action === 'cancel' ? await api.cancel(request.signal) : await api.refresh(request.signal);
      request.signal.throwIfAborted(); setProgress(value); stopped.current = value === undefined || ['denied', 'cancelled', 'expired'].includes(value.state);
      if (value?.state === 'approved' || value?.state === 'claimed') {
        try { await api.finish(request.signal, automatic); }
        catch (failure) { if (!request.signal.aborted) { stopped.current = true; setError(`${current.current.t('authorization.finishError')} ${failure instanceof Error ? failure.message : ''}`); } }
      }
    } catch (failure) {
      if (!request.signal.aborted) {
        const admissionFailure = ['resolve', 'transport', 'restoreTransport', 'cancelTransport'].includes(action);
        stopped.current = true; setScanError(action === 'scan'); setAdmissionError(admissionFailure);
        setError(admissionFailure ? (failure instanceof Error ? failure.message : current.current.t('error.unexpected')) : action === 'scan' ? current.current.t('authorization.scanStopped')
          : `${current.current.t(action === 'finish' ? 'authorization.finishError' : 'authorization.unknown')} ${failure instanceof Error ? failure.message : ''}`);
      }
    } finally { if (abort.current === request) { lock.current = false; polling.current = false; if (!request.signal.aborted) setBusy(false); } }
  };
  const latestPerform = useRef(perform); latestPerform.current = perform;
  useEffect(() => {
    setEntrances([]); setEntriesError('');
    const api = current.current.controller.deviceAuthorization;
    if (!api?.entries) return;
    let invitation; try { invitation = parseDeviceInvitation(link.trim()); } catch { setEntriesLoading(false); setEntryId(undefined); return; }
    const abort = new AbortController(); setEntriesLoading(true);
    void api.entries(link.trim(), abort.signal).then(values => {
      if (abort.signal.aborted) return;
      setEntrances(values);
      if (!values.length) setEntriesError(current.current.t('entries.noMethods'));
      setEntryId(previous => values.some(entry => entry.id === previous) ? previous : values.find(entry => entry.kind === (invitation.endpointTransport?.kind ?? 'https') && entry.origin === invitation.origin)?.id ?? values[0]?.id);
    }).catch(error => { if (!abort.signal.aborted) setEntriesError(error instanceof Error ? error.message : current.current.t('error.unexpected')); })
      .finally(() => { if (!abort.signal.aborted) setEntriesLoading(false); });
    return () => abort.abort();
  }, [link, entriesRevision]);
  useEffect(() => { if (initialInvitation) { setLink(initialInvitation); setEditLink(false); setStage('invite'); } }, [initialInvitation]);
  useEffect(() => { onStageChange?.(progress ? 'pending' : stage); }, [stage, progress?.state, onStageChange]);
  useEffect(() => { if (stage === 'invite' && !progress) { if (!link) paste.current?.focus(); else heading.current?.focus(); } }, [stage]);
  useEffect(() => {
    lock.current = false; stopped.current = false;
    void latestPerform.current('refresh', true);
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (document.visibilityState === 'visible' && !stopped.current) void latestPerform.current('refresh', true);
    }, 3000);
    return () => { clearInterval(timer); abort.current?.abort(); };
  }, []);
  let node = '', expired = false, savedNode = false, targetOnly = false;
  try { const invitation = parseDeviceInvitation(link.trim()); node = invitation.origin; expired = invitation.expiresAt <= Date.now();
    savedNode = controller.state.profiles.some(profile => profile.serverId === invitation.serverId && profile.endpointPublicKey === invitation.endpointPublicKey);
  } catch { try { node = parseDeviceTarget(link.trim()).origin; targetOnly = true; } catch { /* Incomplete paste remains editable. */ } }
  const invalidInvitation = link.trim() !== '' && !node;
  const differentNode = !!discoveredNode && !!node && parseDeviceTarget(link.trim()).serverId !== discoveredNode.serverId;
  const privateRequest = transportRequest ? parseDeviceTransportRequest(transportRequest) : undefined;
  const privateExpired = !!privateRequest && privateRequest.expiresAt <= now;
  const unconfirmed = error !== '' && !scanError && !admissionError;
  const terminal = progress && ['denied', 'cancelled', 'expired'].includes(progress.state);
  const connected = progress?.state === 'approved' || progress?.state === 'claimed';
  return <section className="device-authorization device-authorization--entry" aria-busy={busy} aria-label={t('authorization.add')}>
    {discoveredNode && !progress && <div className="device-authorization__node"><Network aria-hidden="true" /><span><small>{t('entries.discoveredTarget')}</small><strong>{discoveredNode.name}</strong><small>{t('entries.discoveryUnverified')}</small></span></div>}
    {differentNode && <><ErrorBanner message={t('entries.differentTarget')} /><Button tone="ghost" disabled={busy} onClick={onClearDiscovered}>{t('entries.useInvitationTarget')}</Button></>}
    {!progress && privateMode ? <>
      <button type="button" className="connection-onboarding__back" disabled={busy} onClick={() => setPrivateMode(false)}><ArrowLeft aria-hidden="true" />{t('authorization.chooseAnother')}</button>
      <header className="connection-onboarding__heading"><h2>{t('entries.privateRequest')}</h2><p>{t('entries.privateRequestHelp')}</p></header>
      {privateRequest ? <>
        <p role="status">{privateRequest.kind} · {privateExpired ? t('entries.requestExpired') : `${t('entries.requestExpires')} ${new Date(privateRequest.expiresAt).toLocaleTimeString()}`}</p>
        {!privateExpired && <><DeviceInvitationQr value={transportRequest} label={t('entries.privateRequest')} />
          <label><span>{t('entries.requestLink')}</span><textarea readOnly rows={2} value={transportRequest} onFocus={event => event.target.select()} /></label>
          <Button tone="primary" disabled={busy} onClick={() => { setPrivateMode(false); setStage('invite'); }}>{t('entries.openReply')}</Button></>}
        {privateExpired && <Button tone="primary" disabled={busy} onClick={() => void perform('transport', false, privateRequest.kind)}>{t('entries.renewRequest')}</Button>}
        <Button tone="ghost" disabled={busy || !controller.deviceAuthorization?.cancelTransportRequest} onClick={() => void perform('cancelTransport')}>{t('entries.cancelPrivateRequest')}</Button></>
        : <div className="connection-methods">{(['iroh', 'tailcat'] as const).filter(kind => kind === 'tailcat' ? controller.state.capabilities?.tailcatRelayAvailable !== false
          : controller.state.capabilities?.irohNativeAvailable !== false || controller.state.capabilities?.irohRelayAvailable !== false).map(kind =>
          <button type="button" key={kind} className="connection-method" disabled={busy} onClick={() => void perform('transport', false, kind)}><Cloud aria-hidden="true" /><span><strong>{kind}</strong><small>{t('entries.privateHelp')}</small></span><ArrowRight aria-hidden="true" /></button>)}</div>}
    </> : !progress && stage === 'choice' ? <>
      <header className="connection-onboarding__heading"><h2>{t('authorization.startTitle')}</h2><p>{t('authorization.startHelp')}</p></header>
      <div className="connection-methods">
        {controller.scanDeviceInvitation && <button type="button" className="connection-method connection-method--recommended" disabled={busy || unconfirmed}
          aria-label={t('authorization.scan')} aria-description={t('authorization.scanHelp')} onClick={() => void perform('scan')}><span className="connection-method__icon"><QrCode aria-hidden="true" /></span>
          <span><strong>{t('authorization.scan')}</strong><small>{t('authorization.scanHelp')}</small></span><ArrowRight aria-hidden="true" /></button>}
        <button type="button" className={`connection-method${controller.scanDeviceInvitation ? '' : ' connection-method--recommended'}`} disabled={busy || unconfirmed}
          aria-label={t('authorization.useLink')} aria-description={t('authorization.linkHelp')} onClick={() => { setStage('invite'); setError(''); setScanError(false); }}><span className="connection-method__icon"><Link2 aria-hidden="true" /></span>
          <span><strong>{t('authorization.useLink')}</strong><small>{t('authorization.linkHelp')}</small></span><ArrowRight aria-hidden="true" /></button>
      </div>
      {controller.deviceAuthorization?.transportRequest && <Button tone="ghost" disabled={busy || unconfirmed} onClick={() => { setPrivateMode(true); setError(''); void perform('restoreTransport'); }}>{t('entries.privateRequest')}</Button>}
      <details className="connection-provider-guide"><summary>{t('access.browse')}</summary><div className="connection-provider-guide__body">
        {providerGuide ? <><strong>{t('access.receiverTitle', { provider: SERVER_ACCESS_PROVIDERS.find(provider => provider.id === providerGuide)?.name ?? providerGuide })}</strong>
          <p>{t('access.receiverHelp')}</p><Button tone="primary" disabled={busy || unconfirmed} onClick={() => { setStage('invite'); setError(''); }}>{t('access.getInvitation')}</Button>
          {['iroh', 'tailcat'].includes(providerGuide) && controller.deviceAuthorization?.transportRequest && <Button disabled={busy || unconfirmed} onClick={() => { setPrivateMode(true); setError(''); void perform('restoreTransport'); }}>{t('entries.privateRequest')}</Button>}
          <Button tone="ghost" disabled={busy} onClick={() => setProviderGuide('')}>{t('access.back')}</Button>
        </> : SERVER_ACCESS_PROVIDERS.filter(provider => provider.modes.some(mode => mode.purpose !== 'media')).map(provider => <button key={provider.id} type="button" className="connection-method" disabled={busy || unconfirmed} onClick={() => setProviderGuide(provider.id)}>
          <span className="connection-method__icon"><Cloud aria-hidden="true" /></span><span><strong>{provider.name}</strong><small>{t(['iroh', 'tailcat'].includes(provider.id) ? 'entries.privateHelp' : 'entries.publicHelp')}</small></span><ArrowRight aria-hidden="true" /></button>)}
      </div></details>
      <details className="connection-onboarding__help"><summary>{t('authorization.needInvitation')}</summary><p>{t('authorization.help')}</p></details>
    </> : !progress ? <>
      <button type="button" className="connection-onboarding__back" disabled={busy || unconfirmed} onClick={() => { setStage('choice'); setError(''); }}><ArrowLeft aria-hidden="true" />{t('authorization.chooseAnother')}</button>
      <header className="connection-onboarding__heading"><h2 ref={heading} tabIndex={-1}>{t('authorization.inviteTitle')}</h2><p>{t('authorization.inviteHelp')}</p></header>
      {(!node || editLink) && <label><span>{t('authorization.paste')}</span><textarea ref={paste} rows={2} value={link} maxLength={65536} aria-label={t('authorization.paste')} placeholder="joko://pair#…" autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={busy || unconfirmed} aria-invalid={invalidInvitation || expired || undefined} aria-describedby={invitationHint} onChange={event => { setLink(event.target.value); try { parseDeviceTarget(event.target.value.trim()); setEditLink(false); } catch { /* Keep incomplete input. */ } }} /></label>}
      <small id={invitationHint} className="device-authorization__validation">{expired ? t('authorization.invitationExpired') : invalidInvitation ? t('authorization.invalidInvitation') : ''}</small>
      {node && <div className="device-authorization__node"><ShieldCheck aria-hidden="true" /><span><small>{t('authorization.node')}</small><strong>{node}</strong></span></div>}
      {node && !editLink && <Button tone="ghost" disabled={busy} onClick={() => setEditLink(true)}>{t('entries.editInvitation')}</Button>}
      {targetOnly && <>
        <div className="connection-methods" role="group" aria-label={t('entries.confirmMethod')}>
          {(['code', 'knock'] as const).map(method => <button key={method} type="button" className={`connection-method${admission === method ? ' connection-method--recommended' : ''}`}
            aria-pressed={admission === method} disabled={busy} onClick={() => { setAdmission(method); setError(''); }}>
            <span className="connection-method__icon"><ShieldCheck aria-hidden="true" /></span><span><strong>{t(`entries.${method}`)}</strong><small>{t(`entries.${method}Help`)}</small></span><ArrowRight aria-hidden="true" />
          </button>)}
        </div>
        {admission === 'code' && <label><span>{t('entries.code')}</span><input value={invitationCode} maxLength={16} autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false}
          onChange={event => setInvitationCode(event.target.value.toUpperCase())} /></label>}
        <Button tone="primary" disabled={busy || differentNode || !admission || admission === 'code' && invitationCode.replace(/[\s-]/gu, '').length !== 8 || !controller.deviceAuthorization?.resolveTarget}
          onClick={() => void perform('resolve')}>{busy ? <Spinner label={t('connection.connecting')} /> : <ArrowRight aria-hidden="true" />}{t('entries.continue')}</Button>
      </>}
      {node && entrances.length > 1 && <div className="connection-methods" role="group" aria-label={t('entries.chooseMethod')}>
        <strong>{t('entries.chooseMethod')}</strong>
        {entrances.map(entry => <button key={entry.id} type="button" className={`connection-method${entry.id === entryId ? ' connection-method--recommended' : ''}`}
          aria-pressed={entry.id === entryId} disabled={busy || unconfirmed} onClick={() => setEntryId(entry.id)}>
          <span className="connection-method__icon">{entry.provider === 'direct' ? <Network aria-hidden="true" /> : <Cloud aria-hidden="true" />}</span>
          <span><strong>{entry.provider === 'direct' ? t('entries.direct') : entry.name}</strong><small>{t(entry.kind === 'https' ? 'entries.publicHelp' : 'entries.privateHelp')}</small></span>
          {entry.id === entryId ? <Check aria-hidden="true" /> : <ArrowRight aria-hidden="true" />}
        </button>)}
      </div>}
      {entriesLoading && <small role="status">{t('entries.checkingMethods')}</small>}
      {entriesError && <><ErrorBanner message={entriesError} /><Button tone="ghost" disabled={busy || entriesLoading} onClick={() => setEntriesRevision(value => value + 1)}>{t('entries.retryMethods')}</Button><p className="device-authorization__note">{t('entries.reachableInvitation')}</p></>}
      {!savedNode && !targetOnly && <details className="device-authorization__name"><summary><span>{t('authorization.device')}: <strong>{name}</strong></span><span>{t('authorization.editName')}</span></summary>
        <label><span>{t('authorization.device')}</span><input value={name} maxLength={128} disabled={busy} onChange={event => setName(event.target.value)} /></label>
      </details>}
      {!targetOnly && <Button className="device-authorization__primary" tone="primary" disabled={busy || differentNode || unconfirmed || entriesLoading || !!entriesError || !!controller.deviceAuthorization?.entries && !entryId || !node || expired || !name.trim()} onClick={() => void perform('start')}>
        {busy ? <Spinner label={t('connection.connecting')} /> : <ArrowRight aria-hidden="true" />}{t(savedNode && controller.connectSavedInvitation ? 'entries.connectSaved' : 'authorization.request')}</Button>}
      <p className="device-authorization__note">{t(savedNode ? 'entries.sameNode' : 'authorization.beforeRequest')}</p>
    </> : <>
      <ol className="device-authorization__steps" aria-label={t('authorization.steps')}>
        {[t('authorization.stepInvite'), t('authorization.stepApprove'), t('authorization.stepConnect')].map((label, index) => <li key={label} data-current={index === (connected ? 2 : 1)} data-complete={index < (connected ? 2 : 1)}><span>{index < (connected ? 2 : 1) ? <Check aria-hidden="true" /> : index + 1}</span>{label}</li>)}
      </ol>
      <div className={`device-authorization__status${terminal ? ' is-terminal' : ''}`}>
        <span className="device-authorization__status-icon">{terminal ? <XCircle aria-hidden="true" /> : connected ? <ShieldCheck aria-hidden="true" /> : <Clock3 aria-hidden="true" />}</span>
        <h2 role="status">{t(`authorization.${progress.state}`)}</h2>
        <p>{progress.deviceName} · {progress.origin}</p>
      </div>
      {progress.userCode && !terminal && <div className="device-authorization__matching"><small>{t('authorization.match')}</small><strong className="device-authorization__code">{progress.userCode}</strong></div>}
      {progress.state === 'pending' && <p>{t('authorization.wait')}</p>}
      {!terminal && <small className="device-authorization__note">{t('connection.invitationExpires', { time: new Date(progress.expiresAt).toLocaleTimeString() })}</small>}
      <div className="device-authorization__actions">
        {terminal ? <Button disabled={busy} onClick={() => void perform('discard')}>{t('authorization.reset')}</Button>
          : connected ? <Button disabled={busy} onClick={() => void perform('finish')}>{busy && <Spinner label={t('connection.connecting')} />}{t('authorization.finish')}</Button>
            : <Button tone="ghost" disabled={busy} onClick={() => void perform('cancel')}>{t('authorization.cancel')}</Button>}
      </div>
      {progress.state === 'pending' && progress.reviewLink && <details className="device-authorization__details"><summary>{t('entries.reviewLink')}</summary><div>
        <p>{t('entries.reviewHelp')}</p>
        <Button disabled={busy} onClick={() => {
          const value = progress.reviewLink!; setCopyError('');
          void (controller.copyDeviceApprovalLink ? controller.copyDeviceApprovalLink(value) : navigator.clipboard.writeText(formatWebDeviceLink(value, window.location.origin)))
            .then(() => setReviewCopied(true)).catch(failure => setCopyError(failure instanceof Error ? failure.message : t('error.unexpected')));
        }}>{t('entries.copyReview')}</Button>
        {reviewCopied && <small role="status">{t('entries.reviewCopied')}</small>}{copyError && <ErrorBanner message={copyError} />}
      </div></details>}
    </>}
    {error && <>{scanError ? <p role="status" className="device-authorization__note">{error}</p> : <ErrorBanner message={error} />}{!scanError && !admissionError && <><Button disabled={busy} onClick={() => void perform('refresh')}>{t('authorization.retry')}</Button>
      {!confirmForget && <Button disabled={busy} onClick={() => setConfirmForget(true)}>{t('authorization.forget')}</Button>}
    </>}</>}
    {confirmForget && <div role="alert" className="device-authorization">
      <p>{t('authorization.forgetWarning')}</p>
      <div className="device-authorization__actions"><Button disabled={busy} onClick={() => setConfirmForget(false)}>{t('common.cancel')}</Button>
        <Button disabled={busy} onClick={() => void perform('forget')}>{t('authorization.forget')}</Button></div>
    </div>}
  </section>;
}
