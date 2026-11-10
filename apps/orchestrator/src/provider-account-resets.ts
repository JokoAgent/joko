import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { JokoError, type NativeAccountRateLimitResetOperations, type NativeAccountRateLimitResetOutcome, type NativeAccountRateLimitResetSnapshot } from "@joko/core";
import { DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS, parseProviderAccountResetSettings, type ProviderAccountResetSettingsValue } from "@joko/contracts";
import { operationBodyHash, RevisionConflictError, type OperationalStore } from "@joko/store";

const SCOPE = "provider-account-resets.v1", OFFER_TTL = 600_000;
const id = z.string().min(1).max(512).refine(value => !/[\0\r\n]/u.test(value)), key = z.string().regex(/^[a-f0-9]{64}$/u), millis = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const outcome = z.enum(["reset", "nothingToReset", "noCredit", "alreadyRedeemed"]);
const offerSchema = z.strictObject({ format: z.literal(1), id: z.uuid(), backendId: id, providerId: id, accountKey: key,
  creditId: z.string().min(1).max(1024).refine(value => !/[\0\r\n]/u.test(value)).optional(), creditExpiresAt: millis.optional(),
  createdAt: millis, validUntil: millis, attempted: z.boolean(), settled: z.boolean(), retired: z.boolean(),
  outcome: outcome.optional(), origin: z.strictObject({ kind: z.enum(["manual", "automatic"]), operationId: id, settingsRevision: z.string().regex(/^\d+$/u).optional() }).optional() });
type Offer = z.infer<typeof offerSchema>;
const preferencesSchema = z.strictObject({ format: z.literal(1), backendId: id, providerId: id, accountKey: key,
  overrides: z.record(z.string(), z.unknown()) });

export interface AccountResetOfferView { readonly offerId: string; readonly validUntil: number; readonly expiresAt?: number; readonly retryOnly: boolean }
export interface AccountResetView {
  readonly backendId: string; readonly providerId: string; readonly accountKey: string; readonly accountLabel: string;
  readonly availableCount?: number; readonly detailsAvailable: boolean;
  readonly credits: readonly { readonly title: string; readonly grantedAt: number; readonly expiresAt?: number; readonly offer?: AccountResetOfferView }[];
  readonly defaultOffer?: AccountResetOfferView; readonly automaticSettings: ProviderAccountResetSettingsValue;
  readonly settingsRevision: bigint; readonly customized: boolean; readonly lastAutomaticUse?: number; readonly capturedAt: number;
}
export interface AccountResetResult { readonly backendId: string; readonly providerId: string; readonly accountKey: string; readonly offerId: string; readonly outcome: NativeAccountRateLimitResetOutcome }
export interface AccountResetRequest { readonly backendId: string; readonly providerId: string; readonly accountKey: string; readonly offerId: string }
export class AccountResetError extends Error {
  constructor(readonly reason: "unsupported" | "offer_expired" | "account_changed" | "reset_in_progress" | "settings_changed" | "invalid") { super("The account reset request could not be completed."); }
}
export interface ProviderAccountResetsOptions {
  readonly store: OperationalStore;
  readonly withAccount: <T>(backendId: string, providerId: string, effect: (port: NativeAccountRateLimitResetOperations, assertCurrent: () => void) => Promise<T>) => Promise<T>;
  readonly restored?: (backendId: string, providerId: string, facts: NativeAccountRateLimitResetSnapshot, assertCurrent: () => void, signal: AbortSignal) => Promise<void>;
  readonly redactText?: (value: string) => string;
  readonly now?: () => number;
  readonly warn?: () => void;
}

/** Operational offers and receipts only. The SDK remains the quota/credit owner. */
export class ProviderAccountResets {
  readonly #lifetime = new AbortController();
  readonly #flights = new Map<string, Promise<AccountResetResult>>();
  readonly #automatic = new Map<string, Promise<void>>();
  readonly #cooldown = new Map<string, number>();
  #timer?: NodeJS.Timeout;
  constructor(readonly options: ProviderAccountResetsOptions) {}
  initialize(): void {
    if (this.#timer || this.#lifetime.signal.aborted) return;
    this.#timer = setInterval(() => { void this.checkAutomatic(); }, 60_000); this.#timer.unref();
    void this.checkAutomatic();
  }
  async dispose(): Promise<void> {
    this.#lifetime.abort(); if (this.#timer) clearInterval(this.#timer);
    await Promise.allSettled([...this.#automatic.values(), ...this.#flights.values()]);
  }
  async read(backendId: string, providerId: string, assertCaller: () => void, signal?: AbortSignal): Promise<AccountResetView> {
    return this.options.withAccount(backendId, providerId, async (port, assertBackend) => {
      const assertCurrent = () => { this.#assert(); signal?.throwIfAborted(); assertCaller(); assertBackend(); };
      assertCurrent(); const facts = await port.readAccountRateLimitResets({ providerId, assertCurrent, signal: this.#signal(signal) });
      assertCurrent(); this.#validateFacts(facts, providerId);
      return this.options.store.transaction(() => { assertCurrent(); const result = this.#view(backendId, facts); assertCurrent(); return result; });
    });
  }
  async prepareSettings(input: { readonly backendId: string; readonly providerId: string; readonly accountKey: string; readonly expectedRevision: bigint;
    readonly settings: ProviderAccountResetSettingsValue | null }, assertCaller: () => void): Promise<() => void> {
    const settings = input.settings === null ? null : parseProviderAccountResetSettings(input.settings);
    return this.options.withAccount(input.backendId, input.providerId, async (port, assertBackend) => {
      const assertCurrent = () => { this.#assert(); assertCaller(); assertBackend(); };
      const facts = await port.readAccountRateLimitResets({ providerId: input.providerId, assertCurrent, signal: this.#signal() }); assertCurrent();
      if (facts.accountKey !== input.accountKey) throw new AccountResetError("account_changed");
      return () => {
        assertCurrent(); const current = this.#preferences(input.backendId, input.providerId, input.accountKey);
        if (current.revision !== input.expectedRevision) throw new RevisionConflictError("account reset settings", input.providerId, input.expectedRevision, current.revision);
        this.options.store.setSetting("service", SCOPE, this.#settingsKey(input.backendId, input.providerId), {
          format: 1, backendId: input.backendId, providerId: input.providerId, accountKey: input.accountKey, overrides: settings ?? {}
        });
      };
    });
  }
  validateRequest(input: AccountResetRequest): void {
    if (!/^[a-f0-9]{64}$/u.test(input.accountKey)) throw new AccountResetError("invalid");
    const offer = this.#offer(input.offerId); if (!offer || !this.#matches(offer, input) || offer.retired) throw new AccountResetError("offer_expired");
  }
  preserveFailure(input: AccountResetRequest): boolean {
    const offer = this.#offer(input.offerId);
    return offer === undefined || this.#matches(offer, input) && (offer.attempted || offer.outcome !== undefined);
  }
  hasAttempt(input: AccountResetRequest): boolean {
    const offer = this.#offer(input.offerId); return offer !== undefined && this.#matches(offer, input) && (offer.attempted || offer.outcome !== undefined);
  }
  consume(input: AccountResetRequest, operationId: string, assertCaller: () => void,
    automatic?: { readonly settingsRevision: bigint }): Promise<AccountResetResult> {
    this.#assert(); assertCaller();
    const offer = this.#offer(input.offerId); if (!offer || !this.#matches(offer, input) || offer.retired) throw new AccountResetError("offer_expired");
    const operation = this.options.store.getOperation(operationId);
    if (operation.completionMode !== "external_effect" || operation.status !== "started"
      || operation.kind !== (automatic ? "automaticProviderAccountReset" : "consumeProviderAccountReset")) throw new AccountResetError("invalid");
    if (offer.outcome !== undefined) return Promise.resolve(this.#result(offer));
    const pending = this.#flights.get(offer.id);
    if (pending) return pending.then(result => { assertCaller(); return result; });
    const run = Promise.resolve().then(async () => {
      this.#assert(); assertCaller(); const original = this.#offer(offer.id)!;
      this.options.store.transaction(() => {
        this.#assert(); assertCaller();
        if (!original.attempted && (original.validUntil <= this.#now() || original.creditExpiresAt !== undefined && original.creditExpiresAt <= this.#now())) throw new AccountResetError("offer_expired");
        if (this.#offers().some(other => other.id !== original.id && this.#sameAccount(other, original) && other.attempted && !other.settled && !other.retired)) throw new AccountResetError("reset_in_progress");
        this.#save({ ...original, attempted: true, origin: original.attempted ? original.origin : {
          kind: automatic ? "automatic" : "manual", operationId, ...(automatic ? { settingsRevision: automatic.settingsRevision.toString() } : {}) } });
      });
      let called = false;
      try {
        const result = await this.options.withAccount(input.backendId, input.providerId, async (port, assertBackend) => {
          const assertCurrent = () => {
            this.#assert(); assertCaller(); assertBackend();
            if (automatic) this.#assertAutomatic(input.backendId, input.providerId, input.accountKey, automatic.settingsRevision);
          };
          assertCurrent(); called = true;
          const result = await port.consumeAccountRateLimitReset({ providerId: input.providerId, accountKey: input.accountKey, idempotencyKey: original.id,
            ...(original.creditId === undefined ? {} : { creditId: original.creditId }), assertCurrent, signal: this.#signal() });
          assertCurrent(); const settled = { ...this.#offer(original.id)!, settled: true, outcome: outcome.parse(result) };
          this.#save(settled);
          if ((result === "reset" || result === "alreadyRedeemed") && settled.origin?.kind === "automatic") this.#recordAutomaticUse(settled);
          return this.#result(settled);
        });
        if (result.outcome === "reset" || result.outcome === "alreadyRedeemed") {
          // The SDK receipt is durable before this best-effort refresh. A quota
          // read or a retired waiter cannot turn a successful redemption unknown.
          try {
            await this.options.withAccount(input.backendId, input.providerId, async (port, assertBackend) => {
              const guard = () => { this.#assert(); assertCaller(); assertBackend();
                if (automatic) this.#assertAutomatic(input.backendId, input.providerId, input.accountKey, automatic.settingsRevision); };
              const facts = await port.readAccountRateLimitResets({ providerId: input.providerId, assertCurrent: guard, signal: this.#signal() }); guard();
              if (facts.accountKey === input.accountKey) await this.options.restored?.(input.backendId, input.providerId, facts, guard, this.#signal());
            });
          } catch { if (!this.#lifetime.signal.aborted) this.options.warn?.(); }
        }
        return result;
      } catch (error) {
        const current = this.#offer(original.id);
        if (current && !current.settled && !original.attempted && (!called || error instanceof JokoError && !error.publicError.stateMayHaveChanged)) this.#save({ ...current, retired: true, attempted: false });
        throw error;
      }
    }).finally(() => { if (this.#flights.get(offer.id) === run) this.#flights.delete(offer.id); });
    this.#flights.set(offer.id, run); return run;
  }

  async checkAutomatic(): Promise<void> {
    if (this.#lifetime.signal.aborted) return;
    for (const offer of this.#offers()) {
      if (offer.outcome === undefined || offer.origin?.kind !== "automatic") continue;
      const operation = this.options.store.findOperation(offer.origin.operationId);
      const body = { format: 1, backendId: offer.backendId, providerId: offer.providerId, accountKey: offer.accountKey, offerId: offer.id };
      if (operation?.status === "started" && operation.kind === "automaticProviderAccountReset" && operation.connectionId === undefined
        && operation.bodyHash === operationBodyHash(body)) this.options.store.completeDeferredEffectOperation(operation.id, operation.bodyHash,
          () => ({ accepted: true, resultCase: "providerAccountReset", providerAccountReset: this.#result(offer) }));
    }
    const runs: Promise<void>[] = [];
    for (const row of this.options.store.listSettingsByKeyPrefix("service", SCOPE, "settings:")) {
      let entry: z.infer<typeof preferencesSchema>, settings: ProviderAccountResetSettingsValue;
      try { entry = preferencesSchema.parse(row.value); settings = parseProviderAccountResetSettings({ ...DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS, ...entry.overrides }); }
      catch { this.options.warn?.(); continue; }
      if (!settings.enabled) continue;
      const scope = this.#settingsKey(entry.backendId, entry.providerId), existing = this.#automatic.get(scope);
      if (existing) { runs.push(existing); continue; }
      const run = Promise.resolve().then(async () => {
        if ((this.#cooldown.get(scope) ?? 0) > this.#now()) return; this.#cooldown.set(scope, this.#now() + 30_000);
        const assertCurrent = () => this.#assertAutomatic(entry.backendId, entry.providerId, entry.accountKey, row.revision);
        const view = await this.read(entry.backendId, entry.providerId, assertCurrent); assertCurrent();
        if (view.accountKey !== entry.accountKey) return;
        await this.options.withAccount(entry.backendId, entry.providerId, async (port, assertBackend) => {
          const guard = () => { assertCurrent(); assertBackend(); };
          const facts = await port.readAccountRateLimitResets({ providerId: entry.providerId, assertCurrent: guard, signal: this.#signal() }); guard();
          if (facts.accountKey !== entry.accountKey) return;
          const offered = view.defaultOffer && this.#offer(view.defaultOffer.offerId);
          const retry = offered?.attempted && !offered.settled && offered.origin?.kind === "automatic" && offered.origin.settingsRevision === row.revision.toString();
          if (offered && (retry || !view.defaultOffer?.retryOnly && shouldAutomaticallyResetAccount(facts, settings, offered.creditExpiresAt, this.#now()))) {
            const operationId = offered.origin?.kind === "automatic" && offered.attempted ? offered.origin.operationId : `provider-account-reset:${offered.id}`;
            const body = { format: 1, backendId: entry.backendId, providerId: entry.providerId, accountKey: entry.accountKey, offerId: offered.id };
            let operation = this.options.store.findOperation(operationId);
            if (!operation) operation = this.options.store.claimDeferredEffectOperation({ id: operationId, kind: "automaticProviderAccountReset", body }).operation;
            if (operation.kind !== "automaticProviderAccountReset" || operation.connectionId !== undefined || operation.bodyHash !== operationBodyHash(body)) throw new AccountResetError("invalid");
            if (operation.status === "failed") return;
            if (operation.status === "started") {
              const request = { backendId: entry.backendId, providerId: entry.providerId, accountKey: entry.accountKey, offerId: offered.id };
              try {
                const result = await this.consume(request, operationId, guard, { settingsRevision: row.revision });
                this.options.store.completeDeferredEffectOperation(operation.id, operation.bodyHash, () => ({ accepted: true, resultCase: "providerAccountReset", providerAccountReset: result }));
              } catch (error) {
                if (!this.hasAttempt(request)) this.options.store.failEffectOperation(operation.id, operation.bodyHash, error);
                throw error;
              }
            }
          }
          const refreshed = await port.readAccountRateLimitResets({ providerId: entry.providerId, assertCurrent: guard, signal: this.#signal() }); guard();
          if (refreshed.accountKey === entry.accountKey) await this.options.restored?.(entry.backendId, entry.providerId, refreshed, guard, this.#signal());
        });
      }).catch(() => { if (!this.#lifetime.signal.aborted) this.options.warn?.(); }).finally(() => this.#automatic.delete(scope));
      this.#automatic.set(scope, run); runs.push(run);
    }
    await Promise.allSettled(runs);
  }
  #view(backendId: string, facts: NativeAccountRateLimitResetSnapshot): AccountResetView {
    this.#prune(); const preferences = this.#preferences(backendId, facts.providerId, facts.accountKey);
    const matching = this.#offers().filter(offer => offer.backendId === backendId && offer.providerId === facts.providerId && offer.accountKey === facts.accountKey && !offer.retired);
    const pending = matching.find(offer => offer.attempted && !offer.settled);
    const eligible = facts.credits?.details?.filter(credit => credit.status === "available" && credit.resetType === "codexRateLimits" && (credit.expiresAt === undefined || credit.expiresAt > this.#now()))
      .toSorted((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity) || a.grantedAt - b.grantedAt) ?? [];
    const offerFor = (creditId?: string, expiresAt?: number): AccountResetOfferView | undefined => {
      if (pending || !facts.credits?.availableCount) return undefined;
      const existing = matching.find(offer => !offer.settled && !offer.attempted && offer.validUntil > this.#now() && offer.creditId === creditId && offer.creditExpiresAt === expiresAt);
      const offer = existing ?? { format: 1 as const, id: randomUUID(), backendId, providerId: facts.providerId, accountKey: facts.accountKey,
        ...(creditId === undefined ? {} : { creditId }), ...(expiresAt === undefined ? {} : { creditExpiresAt: expiresAt }),
        createdAt: this.#now(), validUntil: this.#now() + OFFER_TTL, attempted: false, settled: false, retired: false };
      if (!existing) { this.#save(offer); matching.push(offer); } return this.#offerView(offer);
    };
    const selected = eligible[0];
    const defaultOffer = pending ? this.#offerView(pending) : selected ? offerFor(selected.creditId, selected.expiresAt)
      : facts.credits?.details === undefined ? offerFor() : undefined;
    const credits = eligible.map(credit => ({ title: (this.options.redactText?.(credit.title ?? "") ?? credit.title ?? "").slice(0, 512), grantedAt: credit.grantedAt,
      ...(credit.expiresAt === undefined ? {} : { expiresAt: credit.expiresAt }), ...(pending ? {} : { offer: offerFor(credit.creditId, credit.expiresAt) }) }));
    return { backendId, providerId: facts.providerId, accountKey: facts.accountKey, accountLabel: facts.accountLabel,
      ...(facts.credits === undefined ? {} : { availableCount: facts.credits.availableCount }), detailsAvailable: facts.credits?.details !== undefined,
      credits, ...(defaultOffer ? { defaultOffer } : {}), automaticSettings: preferences.settings, settingsRevision: preferences.revision,
      customized: preferences.customized, ...(preferences.lastUsedAt === undefined ? {} : { lastAutomaticUse: preferences.lastUsedAt }), capturedAt: facts.usage.observedAt };
  }
  #preferences(backendId: string, providerId: string, accountKey: string) {
    const row = this.options.store.findSetting("service", SCOPE, this.#settingsKey(backendId, providerId)), entry = row && preferencesSchema.parse(row.value);
    if (entry && (entry.backendId !== backendId || entry.providerId !== providerId)) throw new AccountResetError("invalid");
    const active = entry?.accountKey === accountKey, overrides = active ? entry!.overrides : {};
    const settings = parseProviderAccountResetSettings({ ...DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS, ...overrides });
    const last = active ? this.options.store.findSetting("service", SCOPE, `last-use:${this.#settingsKey(backendId, providerId)}`)?.value : undefined;
    const used = last === undefined ? undefined : z.strictObject({ format: z.literal(1), accountKey: key, at: millis }).parse(last);
    return { revision: row?.revision ?? 0n, settings, customized: Object.keys(overrides).length > 0, ...(used && used.accountKey === accountKey ? { lastUsedAt: used.at } : {}) };
  }
  #assertAutomatic(backendId: string, providerId: string, accountKey: string, revision: bigint): void {
    this.#assert(); const row = this.options.store.findSetting("service", SCOPE, this.#settingsKey(backendId, providerId));
    if (!row || row.revision !== revision) throw new AccountResetError("settings_changed");
    const entry = preferencesSchema.parse(row.value);
    if (entry.accountKey !== accountKey || !this.#preferences(backendId, providerId, accountKey).settings.enabled) throw new AccountResetError("settings_changed");
  }
  #recordAutomaticUse(offer: Offer): void {
    const current = this.options.store.findSetting("service", SCOPE, this.#settingsKey(offer.backendId, offer.providerId));
    if (current && preferencesSchema.parse(current.value).accountKey === offer.accountKey) {
      try { this.options.store.setSetting("service", SCOPE, `last-use:${this.#settingsKey(offer.backendId, offer.providerId)}`, { format: 1, accountKey: offer.accountKey, at: this.#now() }); }
      catch { this.options.warn?.(); }
    }
  }
  #validateFacts(facts: NativeAccountRateLimitResetSnapshot, providerId: string): void {
    if (facts.providerId !== providerId || facts.usage.providerId !== providerId || !/^[a-f0-9]{64}$/u.test(facts.accountKey)
      || !facts.accountLabel || facts.accountLabel.length > 512 || !Number.isSafeInteger(facts.usage.observedAt)) throw new AccountResetError("invalid");
  }
  #offerView(offer: Offer): AccountResetOfferView { return { offerId: offer.id, validUntil: offer.validUntil, retryOnly: offer.attempted && !offer.settled, ...(offer.creditExpiresAt === undefined ? {} : { expiresAt: offer.creditExpiresAt }) }; }
  #result(offer: Offer): AccountResetResult { return { backendId: offer.backendId, providerId: offer.providerId, accountKey: offer.accountKey, offerId: offer.id, outcome: outcome.parse(offer.outcome) }; }
  #matches(offer: Offer, input: AccountResetRequest): boolean { return offer.backendId === input.backendId && offer.providerId === input.providerId && offer.accountKey === input.accountKey && offer.id === input.offerId; }
  #sameAccount(a: Offer, b: Offer): boolean { return a.backendId === b.backendId && a.providerId === b.providerId && a.accountKey === b.accountKey; }
  #offer(value: string): Offer | undefined {
    if (!z.uuid().safeParse(value).success) throw new AccountResetError("invalid"); const row = this.options.store.findSetting("service", SCOPE, `offer:${value}`);
    const offer = row && offerSchema.parse(row.value); if (offer && offer.id !== value) throw new AccountResetError("invalid"); return offer;
  }
  #offers(): Offer[] { return this.options.store.listSettingsByKeyPrefix("service", SCOPE, "offer:").map(row => offerSchema.parse(row.value)); }
  #save(offer: Offer): void { this.options.store.setSetting("service", SCOPE, `offer:${offer.id}`, offerSchema.parse(offer)); }
  #prune(): void {
    const pending = new Set<string>();
    for (let offset = 0;; offset += 500) {
      const operations = this.options.store.listOperations({ status: "started", offset, limit: 500 });
      for (const operation of operations) {
        const body = record(operation.body), payload = record(body["payload"]), value = record(payload["value"]);
        const offerId = operation.kind === "automaticProviderAccountReset" ? body["offerId"]
          : operation.kind === "consumeProviderAccountReset" && payload["case"] === "consumeProviderAccountReset" ? value["offerId"] : undefined;
        if (typeof offerId === "string") pending.add(offerId);
      }
      if (operations.length < 500) break;
    }
    const rows = this.#offers().toSorted((a, b) => a.createdAt - b.createdAt); let count = rows.length;
    for (const offer of rows) if (!offer.attempted || offer.settled || offer.retired) {
      if (!pending.has(offer.id) && (offer.validUntil <= this.#now() || count > 4096 && !offer.attempted)) { this.options.store.deleteSetting("service", SCOPE, `offer:${offer.id}`); count--; }
    }
  }
  #settingsKey(backendId: string, providerId: string): string { return `settings:${createHash("sha256").update(JSON.stringify([backendId, providerId])).digest("hex")}`; }
  #signal(signal?: AbortSignal): AbortSignal { return AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]); }
  #assert(): void { this.#lifetime.signal.throwIfAborted(); }
  #now(): number { return this.options.now?.() ?? Date.now(); }
}

export function shouldAutomaticallyResetAccount(facts: NativeAccountRateLimitResetSnapshot, settings: ProviderAccountResetSettingsValue, expiresAt: number | undefined, now: number): boolean {
  if (!settings.enabled || !facts.credits?.availableCount) return false;
  const windows = accountWindows(facts).filter(window => window.resetAt !== undefined && window.resetAt > now);
  if (!windows.some(window => window.usedPercent > 0)) return false;
  if (settings.expiring && expiresAt !== undefined && expiresAt > now && expiresAt - now <= settings.expiryMinutes * 60_000) return true;
  const ordinary = facts.ordinaryQuota;
  return settings.lowQuota && ordinary !== undefined && !ordinary.creditsDepleted && [ordinary.primaryWindow, ordinary.secondaryWindow].some(window => window
    && window.usedPercent > 99 && (window.windowMinutes ?? 0) >= 10080 && window.resetAt !== undefined && window.resetAt > now && window.resetAt - now >= settings.minimumDays * 86_400_000);
}
export function accountResetQuotaRestored(facts: NativeAccountRateLimitResetSnapshot, modelId?: string): boolean {
  let selected: Pick<NativeAccountRateLimitResetSnapshot["usage"], "primaryWindow" | "secondaryWindow"> | undefined = facts.usage;
  if (facts.usage.buckets?.length) {
    const entries = facts.usage.buckets.filter(bucket => {
      const windows = [bucket.primaryWindow, bucket.secondaryWindow].filter(window => window !== undefined);
      return !windows.length || windows.some(window => window.resetAt === undefined || window.resetAt <= 0)
        || Math.max(...windows.map(window => window.resetAt!)) + 86_400_000 >= facts.usage.observedAt;
    });
    const token = (value?: string) => value?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "", model = token(modelId);
    let longest: { readonly bucket: typeof entries[number]; readonly length: number } | undefined;
    for (const bucket of entries) {
      const name = token(bucket.displayName); if (!name || !model || !model.includes(name)) continue;
      if (name === model) { longest = { bucket, length: name.length }; break; }
      if (!longest || name.length > longest.length) longest = { bucket, length: name.length };
    }
    selected = longest?.bucket ?? entries.find(bucket => bucket.id === "codex") ?? entries.find(bucket => bucket.id === "__default__");
  }
  const windows = [selected?.primaryWindow, selected?.secondaryWindow].filter((window): window is NonNullable<typeof window> => window !== undefined && Number.isFinite(window.usedPercent));
  return windows.length > 0 && !windows.some(window => window.usedPercent >= 100 && (window.resetAt === undefined || window.resetAt <= 0 || window.resetAt > facts.usage.observedAt));
}
function accountWindows(facts: NativeAccountRateLimitResetSnapshot) {
  return [facts.usage.primaryWindow, facts.usage.secondaryWindow, ...(facts.usage.buckets ?? []).flatMap(bucket => [bucket.primaryWindow, bucket.secondaryWindow])]
    .filter((window): window is NonNullable<typeof window> => window !== undefined && Number.isFinite(window.usedPercent));
}
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
