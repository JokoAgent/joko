import { useState } from 'react';
import type { DeviceAuthorizationReview as Review } from '@joko/connection-transport/device-authorization';
import type { AppController } from '../controller.js';
import type { Translator } from './types.js';
import { DeviceAuthorizationSettings } from './DeviceAuthorizationSettings.js';
import { Button, ErrorBanner } from './ui.js';

/** An incoming link chooses a saved identity, never a new endpoint or credential. */
export function DeviceAuthorizationReview({ controller, review, t, onClose }: {
  readonly controller: AppController; readonly review: Review; readonly t: Translator; readonly onClose: () => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const profile = controller.state.profiles.find(value => value.serverId === review.serverId && value.endpointPublicKey === review.endpointPublicKey);
  const active = profile && controller.state.activeProfile?.id === profile.id && controller.state.connectionState === 'connected';
  return <main className="device-review-page">
    <Button tone="ghost" onClick={() => {
      if (!busy) { onClose(); return; }
      void controller.disconnect().then(onClose).catch(failure => setError(failure instanceof Error ? failure.message : t('error.unexpected')));
    }}>{t('common.cancel')}</Button>
    <h1>{t('authorization.review')}</h1>
    {active ? <DeviceAuthorizationSettings controller={controller} t={t} reviewRequest={review} /> : <article className="settings-card settings-card--content device-authorization">
      <p>{t(profile ? 'entries.reviewConnect' : 'entries.reviewSavedRequired')}</p>
      {profile && <Button tone="primary" disabled={busy} onClick={() => {
        setBusy(true); setError(''); void controller.connect(profile).catch(failure => setError(failure instanceof Error ? failure.message : t('error.unexpected'))).finally(() => setBusy(false));
      }}>{profile.name} · {t('entries.reviewConnect')}</Button>}
      {error && <ErrorBanner message={error} />}
    </article>}
  </main>;
}
