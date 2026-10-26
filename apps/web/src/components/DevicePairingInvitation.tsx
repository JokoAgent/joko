import { useEffect, useRef, useState } from 'react';
import { formatTrustedNodeInvitation, type NodePairingInvitation } from '@joko/connection-transport/trust';
import { normalizeOrchestratorOrigin } from '../connection-origin.js';
import type { AppController } from '../controller.js';
import type { Translator } from './types.js';
import { Button, ErrorBanner } from './ui.js';
import { randomUuid } from '../web-crypto.js';

export function DevicePairingInvitation({ controller, t }: { readonly controller: AppController; readonly t: Translator }) {
  const profile = controller.state.activeProfile;
  const owner = `${profile?.id ?? ''}\u0000${profile?.serverId ?? ''}\u0000${profile?.endpointPublicKey ?? ''}\u0000${profile?.origin ?? ''}\u0000${profile?.transportKind ?? 'https'}`;
  const current = useRef({ owner });
  if (current.current.owner !== owner) current.current = { owner };
  const inFlight = useRef<object | undefined>(undefined);
  const [invitation, setInvitation] = useState<NodePairingInvitation>();
  const [recipientOrigin, setRecipientOrigin] = useState('');
  const [recipientEndpointId, setRecipientEndpointId] = useState('');
  const relayRequest = useRef<{ readonly recipientEndpointId: string; readonly requestId: string } | undefined>(undefined);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { inFlight.current = undefined; setInvitation(undefined); setRecipientOrigin(''); setRecipientEndpointId(''); relayRequest.current = undefined; setError(undefined); setBusy(false); }, [owner]);
  useEffect(() => { if (!invitation) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [invitation]);
  const perform = async (cancel: boolean) => {
    if (inFlight.current !== undefined) return;
    const expected = current.current, operation = {};
    inFlight.current = operation;
    setBusy(true); setError(undefined);
    try {
      if (cancel && invitation) {
        if (!controller.cancelDevicePairing) throw new Error('Pairing cancellation is unavailable.');
        await controller.cancelDevicePairing(invitation);
        if (current.current === expected) setInvitation(undefined);
      } else {
        if (!controller.authorizeNewDevice) throw new Error('New-device authorization is unavailable.');
        const recipient = recipientEndpointId.trim();
        if (recipient !== '' && !/^[a-f0-9]{64}$/u.test(recipient)) throw new Error(t('connection.irohRecipientInvalid'));
        if (recipient !== '' && relayRequest.current?.recipientEndpointId !== recipient) relayRequest.current = { recipientEndpointId: recipient, requestId: randomUuid() };
        const result = await controller.authorizeNewDevice(recipient === '' ? undefined : { irohRelay: relayRequest.current! });
        if (current.current === expected) { setNow(Date.now()); setRecipientOrigin(result.origin); setInvitation(result); }
      }
    } catch (failure) { if (current.current === expected) setError(failure instanceof Error ? failure.message : t('error.unexpected')); }
    finally { if (inFlight.current === operation) { inFlight.current = undefined; if (current.current === expected) setBusy(false); } }
  };
  let sharedInvitation: string | undefined;
  if (invitation) {
    try { sharedInvitation = recipientOrigin === invitation.origin ? invitation.trustedInvitation : formatTrustedNodeInvitation({ ...invitation, origin: normalizeOrchestratorOrigin(recipientOrigin) }); }
    catch { /* An address draft never changes the issued secret or its issuer. */ }
  }
  return <article className="settings-card" aria-busy={busy}>
    <strong>{t('connection.authorizeDevice')}</strong>
    <p>{t('connection.invitationHelp')}</p>
    {profile?.transportKind === 'iroh' && <>
      <label><span>{t('connection.irohRecipient')}</span><input value={recipientEndpointId} onChange={event => setRecipientEndpointId(event.target.value)} aria-label={t('connection.irohRecipient')} maxLength={64} autoCapitalize="none" autoComplete="off" spellCheck={false} disabled={busy || invitation !== undefined && invitation.expiresAt > now} /></label>
      <small>{t('connection.irohRecipientHelp')}</small>
    </>}
    {invitation && invitation.expiresAt > now ? <>
      <label><span>{t('connection.invitationAddress')}</span><input type="url" value={recipientOrigin} onChange={event => setRecipientOrigin(event.target.value)} aria-label={t('connection.invitationAddress')} readOnly={invitation.endpointTransport !== undefined} /></label>
      <small>{t(invitation.endpointTransport === undefined ? 'connection.invitationAddressHelp' : 'connection.invitationSdkAddressHelp')}</small>
      <label><span>{t('connection.trustedIdentity')}</span><textarea readOnly rows={4} value={sharedInvitation ?? ''} aria-label={t('connection.trustedIdentity')} /></label>
      <label><span>{t('connection.invitationCode')}</span><input readOnly value={invitation.humanCode} aria-label={t('connection.invitationCode')} autoComplete="off" /></label>
      <p role="status">{t('connection.invitationExpires', { time: new Date(invitation.expiresAt).toLocaleTimeString() })}</p>
      <Button disabled={busy} onClick={() => void perform(true)}>{t('common.cancel')}</Button>
    </> : <Button disabled={busy || !controller.authorizeNewDevice} onClick={() => void perform(false)}>{t('connection.authorizeDevice')}</Button>}
    {error && <ErrorBanner message={error} />}
  </article>;
}
