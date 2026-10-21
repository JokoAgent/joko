import { parseMailCard, readMailCard, mailCardStatus, mailSendRemainingFraction, MAIL_CARD_MAX_BYTES, type MailCardData } from '@joko/contracts';
import type { ExtensionCardService, ExtensionCardPush, ExtensionCardRow } from './service.js';

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Only the host creates this marker. Plugin HTML cannot retain data-joko-mail. */
export function renderMailCard(mail: MailCardData): string {
  const active = !mail.supersededBy && ['draft', 'syncing', 'error'].includes(mail.state);
  const button = (action: string, label: string, submit = false) =>
    `<button data-joko-action="mail:${action}:${escape(mail.key)}"${submit ? ' data-joko-submit="true"' : ''} style="position:relative;overflow:hidden;min-height:36px;padding:7px 16px;border:1px solid var(--line);border-radius:999px;font:inherit;cursor:pointer;background:${action === 'cancel' || action === 'delete' ? 'transparent' : action === 'now' ? 'var(--surface)' : 'var(--accent)'};color:${action === 'cancel' || action === 'delete' || action === 'now' ? 'var(--text)' : 'var(--accent-ink)'}">` +
    (action === 'now' ? `<span data-mail-progress="true" aria-hidden="true" style="position:absolute;inset:0;pointer-events:none"><span style="display:block;height:100%;background:var(--text);opacity:0.14;transform-origin:left;transform:scaleX(${1 - mailSendRemainingFraction(mail)})"></span></span>` : '') +
    `<span style="position:relative">${escape(label)}</span></button>`;
  return `<div data-joko-mail="${escape(JSON.stringify(mail))}"></div>` +
    `<div data-joko-form="${escape(JSON.stringify(mail.fields))}"${active ? ` data-joko-change="mail:change:${escape(mail.key)}"` : ''}>` +
    mail.fields.filter(f => (f.kind !== 'hidden' || f.name === 'body') && f.kind !== 'mail-html' && f.kind !== 'mail-attachments').map(f => `<p style="white-space:pre-wrap"><b>${escape(f.label)}</b><br>${escape(f.value)}</p>`).join('') + '</div>' +
    '<div style="padding:10px 12px;font-size:12px;line-height:1.5;color:var(--text-soft);overflow-wrap:anywhere">' +
    `<div>${escape(mail.fromLabel)}: ${escape(mail.from)}</div>` +
    (mail.attachments.length && !mail.fields.some(f => f.kind === 'mail-attachments') ? `<div style="margin-top:4px">${mail.attachments.map(escape).join(' · ')}</div>` : '') +
    '<div style="display:flex;align-items:center;gap:12px;justify-content:space-between;margin-top:8px">' +
    `<span>${escape(mailCardStatus(mail))}</span><div style="display:flex;align-items:flex-end;gap:8px;flex-shrink:0;font-size:14px;color:var(--text)">` +
    (active && mail.deleteLabel ? button('delete', mail.deleteLabel) : '') +
    (active ? button('send', mail.sendLabel, true) : '') +
    (!mail.supersededBy && mail.pendingSend ? button('cancel', mail.pendingSend.cancelLabel) + button('now', mail.pendingSend.sendNowLabel) : '') +
    (!mail.supersededBy && mail.state === 'sent' && mail.continueLabel ? button('continue', mail.continueLabel) : '') + '</div></div></div>';
}

export class MailCardService {
  // Publication is ordered; autosaves update one call, subsequent reads create a
  // new view. Reuse card persistence, ownership and transport, no parallel DB.
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: {
    cards: ExtensionCardService;
    read(callId: string): Promise<ExtensionCardRow | null>;
    list(sessionId: string): Promise<ExtensionCardRow[]>;
    persist(row: ExtensionCardRow): Promise<void>;
    broadcast(payload: ExtensionCardPush): void;
  }) {}

  handle(sender: string, authorityKey: string, payload: unknown, current: () => boolean): Promise<{ ok: boolean }> {
    const task = this.pending.catch(() => {}).then(() => this.publish(sender, authorityKey, payload, current));
    this.pending = task;
    return task;
  }
  /** Recovery reads the existing host-owned row, under the same call/owner scope
   * as updates. No mailbox bodies are copied into the plugin's small routing KV. */
  async restore(sender: string, authorityKey: string, payload: unknown, current: () => boolean): Promise<{ ok: boolean; draft?: MailCardData }> {
    if (!payload || typeof payload !== 'object') return { ok: false };
    const p = payload as Record<string, unknown>;
    if (typeof p.callId !== 'string' || p.callId.length > 128) return { ok: false };
    await this.pending.catch(() => {});
    const row = await this.deps.read(p.callId);
    const mail = row && readMailCard(row.html);
    if (!row || row.extensionId !== sender || row.authorityKey !== authorityKey || !mail || mail.supersededBy || !current()) return { ok: false };
    if (p.sourceCallId !== undefined && (typeof p.sourceCallId !== 'string' ||
        !this.deps.cards.reopenForTool(sender, authorityKey, p.callId, p.sourceCallId, row))) return { ok: false };
    const info = this.deps.cards.callInfoOf(p.callId);
    if (!info || info.extensionId !== sender || info.authorityKey !== authorityKey || !info.sessionId || info.sessionId !== row.sessionId ||
        !['draft', 'syncing', 'error', 'sending'].includes(mail.state) || !current()) return { ok: false };
    return { ok: true, draft: mail };
  }
  private async publish(sender: string, authorityKey: string, payload: unknown, current: () => boolean): Promise<{ ok: boolean }> {
    if (!payload || typeof payload !== 'object') return { ok: false };
    const p = payload as Record<string, unknown>;
    if (typeof p.callId !== 'string' || p.callId.length > 128) return { ok: false };
    const previous = await this.deps.read(p.callId);
    const priorMail = previous && readMailCard(previous.html);
    if (priorMail?.supersededBy || (previous && (previous.extensionId !== sender || previous.authorityKey !== authorityKey))) return { ok: false };
    if (p.sourceCallId !== undefined) {
      if (typeof p.sourceCallId !== 'string' || !previous || !this.deps.cards.reopenForTool(sender, authorityKey, p.callId, p.sourceCallId, previous)) return { ok: false };
    }
    const info = this.deps.cards.callInfoOf(p.callId);
    if (!info || info.extensionId !== sender || info.authorityKey !== authorityKey || !info.sessionId || !current()) return { ok: false };
    let mail = parseMailCard(p.draft);
    if (!mail && priorMail && p.statusOnly && typeof p.statusOnly === 'object') {
      const status = p.statusOnly as Record<string, unknown>;
      mail = parseMailCard({ ...priorMail, status: status.status, state: status.state,
        continueLabel: status.continueLabel, pendingSend: status.pendingSend });
    }
    if (!mail || mail.supersededBy || (priorMail && (priorMail.accountId !== mail.accountId || priorMail.draftId !== mail.draftId))) return { ok: false };
    if (priorMail && ['sent', 'deleted'].includes(priorMail.state) && mail.state !== priorMail.state) return { ok: false };
    const rows = await this.deps.list(info.sessionId);
    if (!current()) return { ok: false };
    const html = renderMailCard(mail);
    if (Buffer.byteLength(html) > MAIL_CARD_MAX_BYTES) return { ok: false };
    const result = await this.deps.cards.publishHostMail(sender, authorityKey, {
      callId: p.callId, html,
      state: ['syncing', 'sending', 'deleting'].includes(mail.state) ? 'working' : 'done',
    }, () => { if (!current()) throw new Error('Mail provider changed.'); });
    if (!result.accepted) return { ok: false };
    await this.deps.cards.flushWrites();
    for (const row of rows) {
      if (!current()) return { ok: false };
      if (row.callId === p.callId || row.extensionId !== sender || row.authorityKey !== authorityKey) continue;
      const old = readMailCard(row.html);
      if (!old || old.accountId !== mail.accountId || old.draftId !== mail.draftId) continue;
      // Snapshot stays intact, but can no longer submit. Always point at newest.
      const html = renderMailCard({ ...old, supersededBy: p.callId });
      await this.deps.persist({ ...row, html, updatedAt: Date.now() });
      if (current()) this.deps.broadcast({ ...row, html, animatedHtml: null, state: 'done' });
    }
    return { ok: current() };
  }
}
