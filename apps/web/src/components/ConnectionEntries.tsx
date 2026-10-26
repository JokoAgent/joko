import type { ConnectionScreenController, ConnectionScreenProfile } from '../connection-contract.js';
import type { Translator } from './types.js';
import { ArrowUp, ArrowDown, Cloud, Network, ShieldCheck } from 'lucide-react';
import { Button, CheckboxControl, Pill } from './ui.js';
import './connection-entries.css';

export function ConnectionEntries({ profile, controller, t, disabled, run }: {
  readonly profile: ConnectionScreenProfile; readonly controller: ConnectionScreenController; readonly t: Translator;
  readonly disabled: boolean; readonly run: (name: string, action: () => Promise<void>) => void;
}) {
  if (!profile.endpointPublicKey || !controller.refreshConnectionEntries) return null;
  const directory = controller.state.connectionEntries?.profileId === profile.id ? controller.state.connectionEntries : undefined;
  const connected = controller.state.activeProfile?.id === profile.id && controller.state.connectionState === 'connected';
  const backups = directory?.entries.filter(e => e.backup).sort((a, b) => (a.backupOrder ?? 0) - (b.backupOrder ?? 0)).map(e => e.id) ?? [];
  const policy = (ids: readonly string[], restore: boolean) => controller.setConnectionEntryPolicy!(profile.id, ids, restore);
  const move = (id: string, direction: number) => {
    const index = backups.indexOf(id), next = [...backups];
    [next[index], next[index + direction]] = [next[index + direction]!, next[index]!];
    return policy(next, directory!.returnToPreferred);
  };
  return <details className="connection-entry-panel" onToggle={event => {
    if (event.currentTarget.open && !directory && !disabled) run('entries-load', () => controller.refreshConnectionEntries!(profile.id));
  }}>
    <summary>{t('entries.title')}</summary>
    <div className="connection-entry-panel__content">
      <p>{t('entries.description')}</p>
      <div className="connection-entry-panel__list">
        {directory?.entries.map(entry => <section className="connection-entry-choice" key={entry.id} data-entry-id={entry.id}>
          <div className="connection-entry-choice__heading">
            {entry.provider === 'direct' ? <Network aria-hidden="true" /> : <Cloud aria-hidden="true" />}
            <div><strong>{entry.provider === 'direct' ? t(entry.id === 'saved' ? 'entries.saved' : 'entries.direct') : entry.name}</strong><small>{t(`entries.${entry.state === 'ready' && entry.verification ? entry.verification : entry.state}`)}</small></div>
            {entry.preferred && <Pill>{t('entries.preferred')}</Pill>}
            {entry.current && connected && <Pill tone="success">{t('entries.current')}</Pill>}
          </div>
          <div className="connection-entry-choice__actions">
            {entry.state === 'unprepared' || entry.state === 'expired' || entry.state === 'identity-conflict'
              ? <Button disabled={disabled || !connected} onClick={() => run(`entry-prepare:${entry.id}`, () => controller.prepareConnectionEntry!(profile.id, entry.id))}>{t('entries.prepare')}</Button>
              : entry.state === 'ready' && (!entry.preferred || !entry.current) && <Button disabled={disabled} onClick={() => run(`entry-use:${entry.id}`, () => controller.selectConnectionEntry!(profile.id, entry.id))}>{t('entries.use')}</Button>}
            {!entry.preferred && <label><CheckboxControl checked={entry.backup} disabled={disabled || !entry.backup && (entry.state !== 'ready' || backups.length >= 8)}
              onChange={event => run(`entry-backup:${entry.id}`, () => policy(event.target.checked ? [...backups, entry.id] : backups.filter(id => id !== entry.id), directory!.returnToPreferred))} />{t('entries.backup')}</label>}
          </div>
          {entry.backup && backups.length > 1 && <div className="connection-entry-choice__order">
            <small>{t('entries.backupOrder', { order: backups.indexOf(entry.id) + 1 })}</small>
            <Button aria-label={t('entries.earlier', { name: entry.name })} disabled={disabled || backups[0] === entry.id}
              onClick={() => run('entry-order', () => move(entry.id, -1))}><ArrowUp aria-hidden="true" /></Button>
            <Button aria-label={t('entries.later', { name: entry.name })} disabled={disabled || backups.at(-1) === entry.id}
              onClick={() => run('entry-order', () => move(entry.id, 1))}><ArrowDown aria-hidden="true" /></Button>
          </div>}
        </section>)}
      </div>
      {directory && <label className="connection-entry-panel__return"><CheckboxControl checked={directory.returnToPreferred} disabled={disabled}
        onChange={event => run('entry-return', () => policy(backups, event.target.checked))} /><span>{t('entries.return')}<small>{t('entries.returnHelp')}</small></span></label>}
      <Button tone="ghost" disabled={disabled || !connected} onClick={() => run('entries-refresh', () => controller.refreshConnectionEntries!(profile.id))}>{t('entries.refresh')}</Button>
      <small className="connection-entry-panel__trust"><ShieldCheck aria-hidden="true" />{t('entries.sameNode')}</small>
      {directory?.notice && <p role="status">{directory.notice}</p>}
    </div>
  </details>;
}
