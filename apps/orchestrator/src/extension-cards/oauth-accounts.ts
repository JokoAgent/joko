import { randomUUID } from "node:crypto";
import type { OperationalStore } from "@joko/store";
import type { CredentialManager } from "../credential-manager.js";
import type { CredentialVault } from "../credential-vault.js";
import type { ExtensionCatalogManager, ExtensionCatalogDescriptor } from "../extension-catalog.js";
import { ExtensionOAuthAccountState, EXTENSION_OAUTH_REFERENCE, extensionOAuthCredential, extensionOAuthHash, extensionOAuthScope, type ExtensionOAuthAccountRow, type ExtensionOAuthSaved } from "./oauth-account-state.js";
import { prepareExtensionOAuth, readExtensionOAuthIdentity, refreshExtensionOAuth, type ExtensionOAuthCallback, type ExtensionOAuthClient, type ExtensionOAuthOffer } from "./oauth-flow.js";
import type { ExtensionOAuthDeclaration } from "./oauth-manifest.js";
import type { ExtensionNetworkDeclaration, ExtensionNetworkSecret } from "./network-manifest.js";

export type ExtensionOAuthErrorCode = "INVALID_CONFIG" | "NO_CLIENT_CONFIG" | "NO_ACCOUNT" | "ACCOUNT_LIMIT" | "AUTH_EXPIRED" | "REFRESH_FAILED" | "EXCHANGE_FAILED" | "NETWORK" | "CANCELLED" | "TIMEOUT" | "LISTEN_FAILED";
export class ExtensionOAuthError extends Error { constructor(readonly code: ExtensionOAuthErrorCode) { super(code); } }
export interface ExtensionOAuthCapture { readonly extensionId: string; readonly key: string; readonly revision: bigint; readonly ownerKey: string; readonly clientKey: string }
export type ExtensionOAuthFreshResult = { readonly ok: true; readonly accessToken: string; readonly accountId: string } | { readonly ok: false; readonly error: "NO_CLIENT_CONFIG" | "NO_ACCOUNT" | "AUTH_EXPIRED" | "REFRESH_FAILED" | "NETWORK" };
interface Cache { readonly accessToken: string; readonly expiresAt: number | null }
interface Source { readonly extension: ExtensionCatalogDescriptor; readonly network: ExtensionNetworkDeclaration; readonly secret: ExtensionNetworkSecret;
  readonly declaration: ExtensionOAuthDeclaration; readonly scope: string; readonly ownerKey: string }
interface ConnectOptions { readonly signal: AbortSignal; readonly assertCurrent: () => void; readonly scopes?: readonly string[];
  readonly authorize: (offer: ExtensionOAuthOffer, signal: AbortSignal) => Promise<ExtensionOAuthCallback> }
interface Options {
  readonly store: OperationalStore; readonly vault: CredentialVault; readonly credentials: CredentialManager; readonly catalog: ExtensionCatalogManager;
  readonly fetch: typeof fetch; readonly sleep?: (ms: number) => Promise<void>;
}
const sameScopes = (left: readonly string[], right: readonly string[]) => left.length === right.length && new Set(left).size === new Set(right).size && right.every(scope => left.includes(scope));
function parseClient(value: unknown): { readonly clientId: string; readonly clientSecret?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["clientId", "clientSecret"].includes(key))) throw new ExtensionOAuthError("INVALID_CONFIG");
  const data = value as Record<string, unknown>;
  if (typeof data.clientId !== "string" || !data.clientId || data.clientId.length > 200 || /\s|\0/u.test(data.clientId)
    || data.clientSecret !== undefined && (typeof data.clientSecret !== "string" || !data.clientSecret || data.clientSecret.length > 200 || /\s|\0/u.test(data.clientSecret))) throw new ExtensionOAuthError("INVALID_CONFIG");
  return { clientId: data.clientId, ...(data.clientSecret === undefined ? {} : { clientSecret: data.clientSecret as string }) };
}

/** One service owns the shared account vault. Multiple desktop controllers use
 * that owner; access tokens stay in memory and refresh writes use exact CAS. */
export class ExtensionOAuthAccounts {
  readonly #state: ExtensionOAuthAccountState;
  readonly #captures = new WeakSet<ExtensionOAuthCapture>();
  readonly #references = new Set<string>(); readonly #staged = new Set<string>();
  readonly #cache = new Map<string, Cache>(); readonly #refreshing = new Map<string, Promise<ExtensionOAuthFreshResult>>();
  readonly #locks = new Map<string, Promise<unknown>>(); readonly #connecting = new Set<Promise<unknown>>();
  readonly #abort = new AbortController(); #unsubscribe?: () => void; #cleanup = Promise.resolve(); #ready = false;
  constructor(private readonly options: Options) { this.#state = new ExtensionOAuthAccountState(options); }
  async initialize(): Promise<void> {
    for (const reference of this.#state.references()) this.#reserve(reference);
    for (const record of this.options.credentials.list()) if (EXTENSION_OAUTH_REFERENCE.test(record.credentialReferenceId)) this.#reserve(record.credentialReferenceId);
    this.#ready = true; await this.#reconcile();
    this.#unsubscribe = this.options.catalog.onAuthorityChanged(() => { this.#cleanup = this.#cleanup.then(() => this.#reconcile()).catch(() => undefined); });
  }
  #source(extensionId: string, key: string): Source {
    if (!this.#ready || this.#abort.signal.aborted) throw new ExtensionOAuthError("CANCELLED");
    const extension = this.options.catalog.get(extensionId), network = extension.runtime?.network;
    const secret = network?.secrets?.find(value => value.key === key && value.source === "oauth");
    if (!extension.installed || extension.owner.kind !== "resource" || !network || !secret?.oauth) throw new ExtensionOAuthError("INVALID_CONFIG");
    return { extension, network, secret, declaration: secret.oauth, scope: extensionOAuthScope(extensionId, key), ownerKey: extensionOAuthHash({ owner: extension.owner, runtime: extension.runtime, enabled: extension.enabled }) };
  }
  #clientKey(source: Source): string {
    const reference = this.#state.get(source.scope).clientReference;
    return extensionOAuthHash({ reference, generation: reference ? this.options.credentials.find(reference)?.generation : undefined });
  }
  #client(source: Source): ExtensionOAuthClient | undefined {
    const reference = this.#state.get(source.scope).clientReference;
    if (reference) {
      try {
        if (this.options.credentials.find(reference)?.kind !== "oauth") return;
        const protocol = { ...source.declaration }; delete protocol.clientId; delete protocol.clientSecret;
        return { ...protocol, ...parseClient(JSON.parse(this.options.credentials.resolve(reference))), hosts: source.network.hosts };
      } catch { return; }
    }
    return source.declaration.clientId ? { ...source.declaration, clientId: source.declaration.clientId, hosts: source.network.hosts } : undefined;
  }
  capture(extensionId: string, key: string, revision: bigint): ExtensionOAuthCapture {
    const source = this.#source(extensionId, key);
    if (source.extension.revision !== revision) throw new ExtensionOAuthError("INVALID_CONFIG");
    const capture = { extensionId, key, revision, ownerKey: source.ownerKey, clientKey: this.#clientKey(source) };
    this.#captures.add(capture); return capture;
  }
  #assert(capture: ExtensionOAuthCapture, revision: boolean): Source {
    const source = this.#source(capture.extensionId, capture.key);
    if (!this.#captures.has(capture) || source.ownerKey !== capture.ownerKey || this.#clientKey(source) !== capture.clientKey
      || revision && source.extension.revision !== capture.revision) throw new ExtensionOAuthError("INVALID_CONFIG");
    return source;
  }
  assertCurrent(capture: ExtensionOAuthCapture): void { this.#assert(capture, false); }
  #missing(row: ExtensionOAuthAccountRow, declaration: ExtensionOAuthDeclaration): readonly string[] {
    const evidence = row.insufficientScopes?.filter(scope => declaration.scopes.includes(scope));
    return evidence?.length ? evidence : row.authFace === "full" ? declaration.scopes.filter(scope => !row.authScopes.includes(scope)) : [];
  }
  get(extensionId: string) {
    if (!this.#ready || this.#abort.signal.aborted) throw new ExtensionOAuthError("CANCELLED");
    const extension = this.options.catalog.get(extensionId);
    if (!extension.installed || extension.owner.kind !== "resource") throw new ExtensionOAuthError("INVALID_CONFIG");
    return { extensionId, revision: extension.revision, slots: (extension.runtime?.network?.secrets ?? []).filter(secret => secret.source === "oauth").map(secret => {
      const source = this.#source(extensionId, secret.key), saved = this.#state.get(source.scope), configured = this.#client(source) !== undefined;
      return { key: secret.key, label: secret.label, ...(secret.hint ? { hint: secret.hint } : {}), authorizeOrigin: new URL(source.declaration.authorizeUrl).origin,
        tokenOrigin: new URL(source.declaration.tokenUrl).origin, scopes: [...source.declaration.scopes], clientConfigured: configured, clientCustomized: saved.clientReference !== undefined,
        accounts: saved.accounts.map(row => {
          const changed = !saved.clientReference && row.builtinClientHash !== extensionOAuthHash(source.declaration.clientId ?? null), missingScopes = this.#missing(row, source.declaration), label = row.displayLabel ?? row.label;
          return { id: row.id, ...(label ? { label } : {}), createdAt: row.createdAt, isDefault: row.id === saved.defaultId,
            status: changed || row.status === "expired" ? "expired" as const : "connected" as const, clientChanged: changed || row.expiredReason === "client_changed", scopeStale: missingScopes.length > 0, missingScopes: [...missingScopes] };
        }) };
    }) };
  }
  identity(extensionId: string, key: string): string {
    const source = this.#source(extensionId, key), saved = this.#state.get(source.scope);
    return extensionOAuthHash({ client: this.#clientKey(source), defaultId: saved.defaultId, accounts: saved.accounts.map(row => ({ id: row.id, revision: row.revision, refreshReference: row.refreshReference })) });
  }
  async setClient(capture: ExtensionOAuthCapture, value: unknown, assertCurrent: () => void): Promise<ReturnType<ExtensionOAuthAccounts["get"]>> {
    const input = parseClient(value), source = this.#assert(capture, true);
    return this.#lock(source.scope, async () => {
      assertCurrent(); this.#assert(capture, true); const previous = this.#state.get(source.scope); let reference: string | undefined, installed = false;
      try {
        reference = await this.#newSecret(source.scope, "client", JSON.stringify(input)); assertCurrent(); this.#assert(capture, true);
        this.options.catalog.updateNetworkConfiguration(capture.extensionId, capture.revision, () => this.#state.put(source.scope, { ...previous, clientReference: reference! })); installed = true;
        if (previous.clientReference) await this.#retire(previous.clientReference);
        return this.get(capture.extensionId);
      } finally { if (reference) { this.#staged.delete(reference); if (!installed) await this.#retire(reference); } }
    });
  }
  async clearClient(capture: ExtensionOAuthCapture, assertCurrent: () => void): Promise<ReturnType<ExtensionOAuthAccounts["get"]>> {
    const source = this.#assert(capture, true);
    return this.#lock(source.scope, async () => {
      assertCurrent(); this.#assert(capture, true); const { clientReference, ...saved } = this.#state.get(source.scope);
      this.options.catalog.updateNetworkConfiguration(capture.extensionId, capture.revision, () => this.#state.put(source.scope, saved));
      if (clientReference) await this.#retire(clientReference);
      return this.get(capture.extensionId);
    });
  }
  async change(capture: ExtensionOAuthCapture, accountId: string, action: "default" | "remove", assertCurrent: () => void): Promise<ReturnType<ExtensionOAuthAccounts["get"]>> {
    const source = this.#assert(capture, true);
    return this.#lock(source.scope, async () => {
      assertCurrent(); this.#assert(capture, true); const saved = this.#state.get(source.scope), row = saved.accounts.find(row => row.id === accountId);
      if (!row) { if (action === "default") throw new ExtensionOAuthError("NO_ACCOUNT"); return this.get(capture.extensionId); }
      const accounts = action === "remove" ? saved.accounts.filter(row => row.id !== accountId) : saved.accounts;
      const { defaultId: _default, ...rest } = saved;
      const defaultId = action === "default" ? accountId : saved.defaultId === accountId ? accounts[0]?.id : saved.defaultId;
      this.options.catalog.updateNetworkConfiguration(capture.extensionId, capture.revision, () => this.#state.put(source.scope, { ...rest, accounts, ...(defaultId ? { defaultId } : {}) }));
      this.invalidate(capture.extensionId, capture.key, accountId);
      if (action === "remove" && row.refreshReference) await this.#retire(row.refreshReference);
      return this.get(capture.extensionId);
    });
  }
  connect(capture: ExtensionOAuthCapture, options: ConnectOptions): Promise<ReturnType<ExtensionOAuthAccounts["get"]>> {
    const task = this.#connect(capture, options); this.#connecting.add(task);
    void task.finally(() => this.#connecting.delete(task)).catch(() => undefined); return task;
  }
  async #connect(capture: ExtensionOAuthCapture, options: ConnectOptions): Promise<ReturnType<ExtensionOAuthAccounts["get"]>> {
    const source = this.#assert(capture, true), configured = this.#client(source);
    if (!configured) throw new ExtensionOAuthError("NO_CLIENT_CONFIG");
    const scopes = options.scopes ?? source.declaration.scopes;
    if (options.scopes !== undefined && (!scopes.length || new Set(scopes).size !== scopes.length || scopes.some(scope => !source.declaration.scopes.includes(scope)))) throw new ExtensionOAuthError("INVALID_CONFIG");
    const timeout = AbortSignal.timeout(300_000), signal = AbortSignal.any([options.signal, this.#abort.signal, timeout]);
    const assertCurrent = () => { signal.throwIfAborted(); options.assertCurrent(); this.#assert(capture, false); };
    const client: ExtensionOAuthClient = { ...configured, scopes: [...scopes] };
    try {
      assertCurrent();
      let prepared: Awaited<ReturnType<typeof prepareExtensionOAuth>>;
      try { prepared = await prepareExtensionOAuth(client, { signal, assertCurrent }); } catch { assertCurrent(); throw new ExtensionOAuthError("LISTEN_FAILED"); }
      const callback = await new Promise<ExtensionOAuthCallback>((resolve, reject) => {
        const aborted = () => reject(signal.reason); signal.addEventListener("abort", aborted, { once: true });
        void Promise.resolve().then(() => { assertCurrent(); return options.authorize(prepared.offer, signal); }).then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
      });
      assertCurrent(); const exchanged = await prepared.exchange(callback, this.options.fetch); assertCurrent();
      if (!exchanged.ok) throw new ExtensionOAuthError(exchanged.error === "INVALID_GRANT" ? "EXCHANGE_FAILED" : exchanged.error);
      const { tokens } = exchanged;
      const privateValues = [client.clientSecret, tokens.accessToken, tokens.refreshToken, callback.code].filter((value): value is string => typeof value === "string" && value.length > 0);
      const identity = await readExtensionOAuthIdentity({ client, fetch: this.options.fetch, signal, assertCurrent }, tokens.accessToken, value => {
        let result = this.options.credentials.redactText(value); for (const secret of privateValues) result = result.split(secret).join("[REDACTED]"); return result;
      }); assertCurrent();
      return await this.#lock(source.scope, async () => {
        assertCurrent(); const saved = this.#state.get(source.scope), existing = identity.label ? saved.accounts.find(row => row.label === identity.label) : undefined;
        if (!existing && saved.accounts.length >= 8) throw new ExtensionOAuthError("ACCOUNT_LIMIT");
        let freshReference: string | undefined, installed = false;
        try {
          if (tokens.refreshToken !== null) freshReference = await this.#newSecret(source.scope, "refresh", tokens.refreshToken);
          assertCurrent();
          const reference = freshReference ?? (existing?.expiredReason === "client_changed" ? undefined : existing?.refreshReference);
          const displayLabel = identity.displayLabel ?? existing?.displayLabel;
          const row: ExtensionOAuthAccountRow = { id: existing?.id ?? randomUUID(), revision: randomUUID(), status: "connected", createdAt: existing?.createdAt ?? Date.now(),
            builtinClientHash: extensionOAuthHash(source.declaration.clientId ?? null), authScopes: [...scopes], authFace: sameScopes(source.declaration.scopes, scopes) ? "full" : "subset",
            ...(identity.label ? { label: identity.label } : {}), ...(displayLabel ? { displayLabel } : {}), ...(reference ? { refreshReference: reference } : {}) };
          const current = this.#assert(capture, false);
          this.options.catalog.updateNetworkConfiguration(capture.extensionId, current.extension.revision, () => this.#state.put(source.scope, { ...saved,
            accounts: existing ? saved.accounts.map(value => value.id === row.id ? row : value) : [...saved.accounts, row], defaultId: saved.defaultId ?? row.id })); installed = true;
          this.#cache.set(this.#cacheKey(current, row), { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt });
          if (existing?.refreshReference && existing.refreshReference !== reference) await this.#retire(existing.refreshReference);
          return this.get(capture.extensionId);
        } finally { if (freshReference) { this.#staged.delete(freshReference); if (!installed) await this.#retire(freshReference); } }
      });
    } catch (error) {
      if (signal.aborted) throw new ExtensionOAuthError(timeout.aborted && !options.signal.aborted && !this.#abort.signal.aborted ? "TIMEOUT" : "CANCELLED");
      throw error;
    }
  }
  #cacheKey(source: Source, row: ExtensionOAuthAccountRow): string { return `${source.scope}:${row.id}:${row.revision}:${source.ownerKey}:${this.#clientKey(source)}`; }
  fresh(extensionId: string, key: string, declaration: ExtensionOAuthDeclaration, accountId?: string): Promise<ExtensionOAuthFreshResult> {
    const source = this.#source(extensionId, key);
    if (extensionOAuthHash(source.declaration) !== extensionOAuthHash(declaration)) return Promise.resolve({ ok: false, error: "AUTH_EXPIRED" });
    const saved = this.#state.get(source.scope), row = saved.accounts.find(row => row.id === (accountId ?? saved.defaultId));
    if (!row) return Promise.resolve({ ok: false, error: "NO_ACCOUNT" });
    const configured = this.#client(source); if (!configured) return Promise.resolve({ ok: false, error: "NO_CLIENT_CONFIG" });
    if (row.expiredReason === "client_changed" || !saved.clientReference && row.builtinClientHash !== extensionOAuthHash(source.declaration.clientId ?? null)) return Promise.resolve({ ok: false, error: "AUTH_EXPIRED" });
    const cacheKey = this.#cacheKey(source, row), cached = this.#cache.get(cacheKey);
    if (cached && (cached.expiresAt === null || cached.expiresAt > Date.now())) return Promise.resolve({ ok: true, accessToken: cached.accessToken, accountId: row.id });
    const prior = this.#refreshing.get(cacheKey); if (prior) return prior;
    const task = this.#refresh(source, row, configured, cacheKey).finally(() => { if (this.#refreshing.get(cacheKey) === task) this.#refreshing.delete(cacheKey); });
    this.#refreshing.set(cacheKey, task); return task;
  }
  invalidate(extensionId: string, key: string, accountId: string): void { const prefix = `${extensionOAuthScope(extensionId, key)}:${accountId}:`; for (const cacheKey of this.#cache.keys()) if (cacheKey.startsWith(prefix)) this.#cache.delete(cacheKey); }
  #refreshValue(row: ExtensionOAuthAccountRow): string | undefined { return row.refreshReference && this.options.credentials.find(row.refreshReference)?.kind === "oauth" ? this.options.credentials.resolve(row.refreshReference) : undefined; }
  async #refresh(source: Source, row: ExtensionOAuthAccountRow, client: ExtensionOAuthClient, cacheKey: string): Promise<ExtensionOAuthFreshResult> {
    const capture = this.capture(source.extension.id, source.secret.key, source.extension.revision), signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(30_000)]);
    const assertCurrent = () => {
      signal.throwIfAborted(); this.#assert(capture, false);
      if (!this.#state.get(source.scope).accounts.some(value => value.id === row.id && value.revision === row.revision)) throw new ExtensionOAuthError("AUTH_EXPIRED");
    };
    try {
      let refreshToken = this.#refreshValue(row);
      if (!refreshToken) { await this.#lock(source.scope, () => { assertCurrent(); this.#markExpired(source, row); }); return { ok: false, error: "AUTH_EXPIRED" }; }
      for (let attempt = 0; ; attempt++) {
        assertCurrent(); const used: string = refreshToken;
        const result = await refreshExtensionOAuth({ client, fetch: this.options.fetch, signal, assertCurrent }, used); assertCurrent();
        if (result.ok) return await this.#lock<ExtensionOAuthFreshResult>(source.scope, async () => {
          assertCurrent(); if (this.#refreshValue(row) !== used) return { ok: false, error: "AUTH_EXPIRED" };
          if (result.tokens.refreshToken !== null && result.tokens.refreshToken !== used && !await this.options.credentials.compareAndSetManagedSecret({ credentialReferenceId: row.refreshReference!,
            expectedSecret: used, secret: result.tokens.refreshToken, displayName: source.secret.label, kind: "oauth" })) return { ok: false, error: "AUTH_EXPIRED" };
          assertCurrent(); this.#cache.set(cacheKey, { accessToken: result.tokens.accessToken, expiresAt: result.tokens.expiresAt });
          const saved = this.#state.get(source.scope); this.#state.put(source.scope, { ...saved, accounts: saved.accounts.map(value => value.id === row.id ? { ...value, status: "connected" } : value) });
          this.#backfillIdentity(source, row, client, result.tokens.accessToken, [used, result.tokens.refreshToken]);
          return { ok: true, accessToken: result.tokens.accessToken, accountId: row.id };
        });
        if (result.error !== "INVALID_GRANT") return { ok: false, error: result.error === "NETWORK" ? "NETWORK" : "REFRESH_FAILED" };
        if (attempt === 0) {
          let changed = this.#refreshValue(row);
          if (!changed || changed === used) { await (this.options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms))))(2000); assertCurrent(); changed = this.#refreshValue(row); }
          if (changed && changed !== used) { refreshToken = changed; continue; }
        }
        return await this.#lock<ExtensionOAuthFreshResult>(source.scope, async () => {
          assertCurrent();
          if (this.#refreshValue(row) !== used) return { ok: false, error: "AUTH_EXPIRED" };
          const removed = await this.options.credentials.deleteManagedSecretIfCurrent(row.refreshReference!, used); assertCurrent();
          if (removed) this.#markExpired(source, row);
          this.#cache.delete(cacheKey); return { ok: false, error: "AUTH_EXPIRED" };
        });
      }
    } catch (error) { return { ok: false, error: error instanceof ExtensionOAuthError || signal.aborted ? "AUTH_EXPIRED" : "REFRESH_FAILED" }; }
  }
  #backfillIdentity(source: Source, row: ExtensionOAuthAccountRow, client: ExtensionOAuthClient, accessToken: string, refreshTokens: readonly (string | null)[]): void {
    if (!client.identity || row.label && (!client.identity.displayTemplate || row.displayLabel)) return;
    const task = (async () => {
      const capture = this.capture(source.extension.id, source.secret.key, this.options.catalog.get(source.extension.id).revision);
      const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(30_000)]);
      const assertCurrent = () => { signal.throwIfAborted(); this.#assert(capture, false); };
      const identity = await readExtensionOAuthIdentity({ client, fetch: this.options.fetch, signal, assertCurrent }, accessToken, value => {
        let redacted = this.options.credentials.redactText(value);
        for (const secret of [accessToken, client.clientSecret, ...refreshTokens]) if (secret) redacted = redacted.split(secret).join("[REDACTED]"); return redacted;
      });
      if (!identity.label && !identity.displayLabel) return;
      await this.#lock(source.scope, () => {
        assertCurrent(); const saved = this.#state.get(source.scope);
        this.#state.put(source.scope, { ...saved, accounts: saved.accounts.map(value => value.id === row.id && value.revision === row.revision ? { ...value, ...identity } : value) });
      });
    })().catch(() => undefined);
    this.#connecting.add(task); void task.finally(() => this.#connecting.delete(task));
  }
  #markExpired(source: Source, row: ExtensionOAuthAccountRow): void {
    const saved = this.#state.get(source.scope); this.#state.put(source.scope, { ...saved, accounts: saved.accounts.map(value => value.id === row.id && value.revision === row.revision ? { ...value, status: "expired" } : value) });
  }
  async reportInsufficientScopes(capture: ExtensionOAuthCapture, scopes: readonly string[]): Promise<boolean> {
    const source = this.#assert(capture, false);
    if (!scopes.length || scopes.some(scope => !source.declaration.scopes.includes(scope))) throw new ExtensionOAuthError("INVALID_CONFIG");
    return this.#lock(source.scope, () => {
      this.#assert(capture, false); const saved = this.#state.get(source.scope), row = saved.accounts.find(row => row.id === saved.defaultId);
      if (!row) return false;
      const merged = [...new Set([...(row.insufficientScopes ?? []), ...scopes])].filter(scope => source.declaration.scopes.includes(scope));
      this.#state.put(source.scope, { ...saved, accounts: saved.accounts.map(value => value.id === row.id ? { ...value, insufficientScopes: merged } : value) }); return true;
    });
  }
  #reserve(reference: string): void { this.options.credentials.reserveManagedSecret({ credentialReferenceId: reference, kind: "oauth" }); this.#references.add(reference); }
  async #newSecret(scope: string, role: "client" | "refresh", value: string): Promise<string> {
    const reference = extensionOAuthCredential(scope, role, randomUUID()); this.#reserve(reference); this.#staged.add(reference);
    try {
      if (!await this.options.credentials.compareAndSetManagedSecret({ credentialReferenceId: reference, expectedSecret: undefined, secret: value, displayName: "Extension authorization", kind: "oauth" })) throw new ExtensionOAuthError("INVALID_CONFIG");
      return reference;
    } catch (error) { this.#staged.delete(reference); await this.#retire(reference); throw error; }
  }
  async #retire(reference: string): Promise<void> {
    if (!this.#references.has(reference)) return;
    if (await this.options.credentials.retireManagedCredential(reference, this.options.credentials.find(reference)?.generation)) this.#references.delete(reference);
  }
  #lock<T>(scope: string, action: () => T | Promise<T>): Promise<T> {
    const next = (this.#locks.get(scope) ?? Promise.resolve()).catch(() => undefined).then(action); this.#locks.set(scope, next);
    void next.finally(() => { if (this.#locks.get(scope) === next) this.#locks.delete(scope); }).catch(() => undefined); return next;
  }
  async #reconcile(): Promise<void> {
    if (!this.#ready || this.#abort.signal.aborted) return;
    const active = new Map(this.options.catalog.snapshot().entries.flatMap(extension => extension.installed && extension.owner.kind === "resource"
      ? (extension.runtime?.network?.secrets ?? []).flatMap(secret => secret.source === "oauth" && secret.oauth ? [[extensionOAuthScope(extension.id, secret.key), { extensionId: extension.id, key: secret.key }] as const] : []) : []));
    for (const { scope, saved } of this.#state.entries()) {
      const owner = active.get(scope); if (!owner) { this.#state.remove(scope); continue; }
      const source = this.#source(owner.extensionId, owner.key);
      if (!saved.clientReference && saved.accounts.some(row => row.builtinClientHash !== extensionOAuthHash(source.declaration.clientId ?? null) && row.expiredReason !== "client_changed")) {
        this.#state.put(scope, { ...saved, accounts: saved.accounts.map(row => row.builtinClientHash !== extensionOAuthHash(source.declaration.clientId ?? null) ? { ...row, status: "expired", expiredReason: "client_changed" } : row) });
      }
    }
    for (const key of this.#cache.keys()) { const parts = key.split(":"), owner = active.get(parts[0]!); if (!owner) this.#cache.delete(key);
      else { const source = this.#source(owner.extensionId, owner.key); if (source.ownerKey !== parts[3] || this.#clientKey(source) !== parts[4]) this.#cache.delete(key); } }
    await this.#retireUnused();
  }
  async #retireUnused(): Promise<void> {
    const groups = new Map<string, string[]>();
    for (const reference of this.#references) { const scope = reference.split(":")[1]!; groups.set(scope, [...(groups.get(scope) ?? []), reference]); }
    for (const [scope, references] of groups) await this.#lock(scope, async () => {
      const saved = this.#state.get(scope), retained = new Set([saved.clientReference, ...saved.accounts.map(row => row.refreshReference)]);
      for (const reference of references) if (!retained.has(reference) && !this.#staged.has(reference)) await this.#retire(reference);
    });
  }
  async dispose(): Promise<void> {
    if (this.#abort.signal.aborted) return;
    this.#unsubscribe?.(); this.#abort.abort();
    await Promise.allSettled([...this.#refreshing.values(), ...this.#connecting]);
    await this.#cleanup; await Promise.allSettled([...this.#locks.values()]);
    this.#staged.clear(); await this.#retireUnused(); this.#cache.clear(); this.#ready = false;
  }
}
