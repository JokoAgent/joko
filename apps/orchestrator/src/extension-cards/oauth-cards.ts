import { ExtensionAuthorizationPhase as Phase, EXTENSION_OAUTH_CARD_ACTION } from "@joko/contracts";
import type { OperationalStore } from "@joko/store";
import type { ExtensionCatalogManager } from "../extension-catalog.js";
import type { ExtensionCardsManager, ExtensionCardAuthority } from "./manager.js";
import type { ExtensionCardScope } from "./service.js";
import type { ExtensionOAuthAccounts } from "./oauth-accounts.js";
import type { ExtensionOAuthSettings, ExtensionOAuthOwner } from "./oauth-settings.js";

export { EXTENSION_OAUTH_CARD_ACTION } from "@joko/contracts";
interface Entry {
  readonly scope: ExtensionCardScope; readonly slotKey: string; readonly installationKey: string; readonly generation: number; readonly expiresAt: number;
  readonly html: string; phase: Phase; flowId?: string; connectionId?: string; continued: boolean;
}
interface Options {
  readonly cards: ExtensionCardsManager; readonly settings: ExtensionOAuthSettings; readonly accounts: Pick<ExtensionOAuthAccounts, "get">;
  readonly catalog: Pick<ExtensionCatalogManager, "get">; readonly store: OperationalStore;
  readonly authority: (id: string) => ExtensionCardAuthority | undefined; readonly locale?: () => string;
  readonly continueTask: (scope: ExtensionCardScope, text: string, guard: (() => Promise<void>) & { readonly signal: AbortSignal }) => Promise<void>;
}
/** Only an actual missing-account assessment can create this process-local
 * host card. Author markup cannot obtain an authorization transaction. */
export class ExtensionOAuthCards {
  readonly #entries = new Map<string, Entry>(); readonly #abort = new AbortController();
  constructor(private readonly options: Options) {}
  missing(extensionId: string): { key: string; label: string; configured: boolean } | undefined {
    const state = this.options.accounts.get(extensionId);
    const slot = state.slots.find(value => !value.accounts.some(account => account.status === "connected" && !account.clientChanged));
    return slot && { key: slot.key, label: slot.label, configured: slot.clientConfigured };
  }
  async require(callId: string, scope: ExtensionCardScope, missing: { key: string; label: string; configured: boolean }, assertCurrent: () => void): Promise<void> {
    this.#purge(); assertCurrent();
    if (this.#entries.size >= 64) throw new Error("Plugin authorization capacity reached.");
    const authority = this.options.authority(scope.extensionId), session = this.options.store.getSession(scope.sessionId).descriptor;
    if (!authority?.installationKey || authority.key !== scope.authorityKey) throw new Error("Plugin installation changed.");
    const zh = this.options.locale?.() === "zh-CN";
    const text = zh ? `连接${missing.label}账户后继续当前任务。` : `Connect ${missing.label} to continue this task.`;
    const html = `<section data-joko-host-authorization="true"><p>${escape(text)}</p>${missing.configured ? `<button data-joko-action="${EXTENSION_OAUTH_CARD_ACTION}">${zh ? "连接账户" : "Connect account"}</button>` : `<p>${zh ? "请先在插件设置中配置 OAuth 客户端。" : "Configure the OAuth client in plugin settings first."}</p>`}</section>`;
    const entry: Entry = { scope: { ...scope }, slotKey: missing.key, installationKey: authority.installationKey, generation: session.binding.generation,
      expiresAt: Date.now() + 600_000, html, phase: Phase.PREPARING, continued: false };
    this.#entries.set(callId, entry);
    try { await this.options.cards.publishHostAuthorization(callId, scope, html, assertCurrent); }
    catch (error) { this.#entries.delete(callId); throw error; }
  }
  #current(callId: string, entry: Entry): void {
    this.#abort.signal.throwIfAborted();
    const authority = this.options.authority(entry.scope.extensionId), task = this.options.store.getSession(entry.scope.sessionId).descriptor;
    this.options.cards.assertScope(entry.scope);
    if (this.#entries.get(callId) !== entry || entry.expiresAt <= Date.now() || authority?.installationKey !== entry.installationKey
      || task.binding.generation !== entry.generation || this.options.store.findSessionRuntimePolicy(task.id)?.policy === "review_read_only"
      || !this.options.cards.matchesOccurrence(entry.scope.sessionId, callId, entry.html)) throw new Error("Plugin authorization card changed.");
  }
  view(callId: string): { readonly phase: Phase; readonly interactive: boolean; readonly clientConfigured: boolean } | undefined {
    this.#purge(); const entry = this.#entries.get(callId); if (!entry) return;
    try {
      this.#current(callId, entry);
      const configured = this.options.accounts.get(entry.scope.extensionId).slots.find(slot => slot.key === entry.slotKey)?.clientConfigured === true;
      return { phase: entry.phase, interactive: configured && (entry.phase === Phase.PREPARING || entry.phase === Phase.FAILED), clientConfigured: configured };
    } catch { return { phase: Phase.FAILED, interactive: false, clientConfigured: false }; }
  }
  start(input: { readonly sessionId: string; readonly cardId: string; readonly actionId: string; readonly change: boolean; readonly prompt: string; readonly formValues: Readonly<Record<string, string>>; readonly uploadId?: string }, owner: ExtensionOAuthOwner): string | undefined {
    this.#purge(); const entry = this.#entries.get(input.cardId);
    if (!entry) return;
    if (input.actionId !== EXTENSION_OAUTH_CARD_ACTION || input.sessionId !== entry.scope.sessionId || input.change || input.prompt || input.uploadId || Object.keys(input.formValues).length
      || ![Phase.PREPARING, Phase.FAILED].includes(entry.phase) || entry.continued) throw new Error("Plugin authorization action is unavailable.");
    owner.assertCurrent(); this.#current(input.cardId, entry);
    const current = () => { owner.assertCurrent(); this.#current(input.cardId, entry); };
    const scoped: ExtensionOAuthOwner = { ...owner, assertCurrent: current };
    const flow = this.options.settings.start(entry.scope.extensionId, entry.slotKey, this.options.catalog.get(entry.scope.extensionId).revision, [], scoped);
    entry.flowId = flow.flowId; entry.connectionId = owner.connectionId; entry.phase = Phase.AUTHORIZING;
    void this.options.settings.waitForFlow(flow.flowId, owner.connectionId).then(async result => {
      if (entry.flowId !== flow.flowId || entry.connectionId !== owner.connectionId) return;
      current();
      if (entry.flowId !== result.flowId || entry.connectionId !== owner.connectionId || result.phase !== Phase.COMPLETE) { entry.phase = Phase.FAILED; return; }
      // The normal account owner has persisted the result. Resume only the
      // original task, once, with no code/token/offer in its user message.
      entry.phase = Phase.COMPLETE;
      if (entry.continued) return;
      entry.continued = true;
      const guard = Object.assign(async () => current(), { signal: this.#abort.signal });
      await this.options.continueTask(entry.scope, this.options.locale?.() === "zh-CN" ? "插件账户已连接。请继续此前等待授权的任务。" : "The plugin account is connected. Continue the task that was waiting for authorization.", guard);
    }).catch(() => { if (entry.flowId === flow.flowId && entry.connectionId === owner.connectionId && entry.phase !== Phase.COMPLETE) entry.phase = Phase.FAILED; });
    return flow.flowId;
  }
  #purge(): void { for (const [id, entry] of this.#entries) if (entry.expiresAt <= Date.now()) this.#entries.delete(id); }
  dispose(): void { this.#abort.abort(); this.#entries.clear(); }
}
function escape(value: string): string { return value.replace(/[&<>"']/gu, item => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[item]!); }
