import { createHash } from "node:crypto";
import { HostedAgentRun, HostedAgentCleanupError, type HostedAgentCall, type HostedAgentRunOptions } from "./hosted-agent-run.js";
import { HOSTED_AGENT_UNREAD_LIMIT, type HostedAgentFrame } from "./hosted-agent-exchange.js";
import type { HostedNativeOpen } from "@joko/adapter-hosted";

/** Captured by the authenticated service, never deserialized from a caller's
 * payload. A shared Provider grant is separate from Device or task access. */
export interface HostedAgentPrincipal {
  readonly id: string;
  readonly deviceId: string;
  readonly trust: "owner" | "guest";
  readonly assertCurrent: () => void;
}
export type HostedAgentOpen = HostedNativeOpen;
export interface HostedAgentPollCursor { readonly runId: string; readonly after: number }
export interface HostedAgentPollRun { readonly runId: string; readonly cursor: number; readonly finished: boolean; readonly frames: readonly HostedAgentFrame[] }
type AuthorizedRun = Omit<HostedAgentRunOptions, "runId" | "nativeSessionId" | "start" | "source" | "trust" | "backendId" | "providerId" | "modelId" | "name" | "permissionMode" | "fastMode" | "effort" | "workspace" | "onCreated">;
export interface HostedAgentHostOptions {
  readonly authorize: (principal: HostedAgentPrincipal, input: HostedAgentOpen) => AuthorizedRun | Promise<AuthorizedRun>;
  readonly now?: () => number;
  readonly createRun?: (options: HostedAgentRunOptions) => Promise<HostedAgentRun>;
}
interface Entry {
  readonly principal: HostedAgentPrincipal;
  readonly digest: string;
  readonly opening: Promise<HostedAgentRun>;
  readonly prepared: Promise<HostedAgentRun>;
  run?: HostedAgentRun;
  detach?: () => void;
  touchedAt: number;
  closedAt?: number;
  closing?: Promise<void>;
  assertAccess?: () => void;
  readonly nativeKey: string;
}
export class HostedAgentHostError extends Error {
  constructor(readonly code: "INVALID_REQUEST" | "ACCESS_DENIED" | "CONFLICT" | "UNAVAILABLE" | "RESOURCE_EXHAUSTED") {
    super("The hosted Agent request could not be completed.");
  }
}

/** Provider-computer service owner. All tasks of one authenticated controller
 * share one pending poll. A disconnected controller has three minutes to
 * return; native cleanup owns quota release, including uncertain cleanup. */
export class HostedAgentHost {
  readonly #entries = new Map<string, Entry>();
  readonly #expired = new Set<string>();
  readonly #nativeOwners = new Map<string, Entry>();
  readonly #polling = new Set<string>();
  readonly #wake = new Set<() => void>();
  readonly #options: HostedAgentHostOptions;
  readonly #timer: ReturnType<typeof setInterval>;
  #disposed = false;

  constructor(options: HostedAgentHostOptions) {
    this.#options = options;
    this.#timer = setInterval(() => { void this.sweep().catch(() => {}); }, 5_000); this.#timer.unref();
  }
  open(principal: HostedAgentPrincipal, input: HostedAgentOpen): Promise<HostedAgentRun> {
    this.#assertPrincipal(principal); validateOpen(input);
    const key = this.#key(principal, input.runId), digest = createHash("sha256").update(JSON.stringify(input)).digest("hex"), existing = this.#entries.get(key);
    if (existing) {
      this.#assertEntry(principal, existing);
      if (existing.digest !== digest) throw new HostedAgentHostError("CONFLICT");
      existing.touchedAt = this.#now(); return existing.opening;
    }
    if (this.#expired.has(key)) throw new HostedAgentHostError("UNAVAILABLE");
    const nativeKey = JSON.stringify([principal.id, principal.deviceId, input.sessionId, input.targetId, input.backendId, input.nativeSessionId]);
    if (this.#nativeOwners.has(nativeKey)) throw new HostedAgentHostError("CONFLICT");
    if (this.#entries.size + this.#expired.size >= 65_536) throw new HostedAgentHostError("RESOURCE_EXHAUSTED");
    // Reserve the operation identity before authorization can await credentials
    // or SDK startup. An uncertain open never creates a second process.
    const snapshot = structuredClone(input);
    let preparedResolve!: (run: HostedAgentRun) => void, preparedReject!: (error: unknown) => void;
    const prepared = new Promise<HostedAgentRun>((resolve, reject) => { preparedResolve = resolve; preparedReject = reject; }); void prepared.catch(() => {});
    const captureRun = (run: HostedAgentRun) => {
      if (entry.run && entry.run !== run) throw new HostedAgentHostError("CONFLICT");
      entry.run = run; entry.detach ??= run.exchange.onOutput(() => this.#notify()); preparedResolve(run); this.#notify();
    };
    const entry: Entry = { principal, digest, nativeKey, prepared, touchedAt: this.#now(), opening: Promise.resolve().then(async () => {
      const allowed = await this.#options.authorize(principal, snapshot); this.#assertEntry(principal, entry);
      entry.assertAccess = allowed.assertCurrent;
      const assertCurrent = () => { this.#assertEntry(principal, entry); allowed.assertCurrent(); };
      const run = await (this.#options.createRun ?? HostedAgentRun.create)({ ...allowed, ...snapshot,
        source: { authorityId: principal.id, deviceId: principal.deviceId, sessionId: snapshot.sessionId, targetId: snapshot.targetId, generation: snapshot.generation },
        trust: principal.trust, assertCurrent, onCreated: captureRun });
      captureRun(run);
      try { assertCurrent(); }
      catch (error) { await run.close(); run.disposeExchange(); throw error; }
      this.#notify(); return run;
    }).catch(error => {
      preparedReject(error);
      if (error instanceof HostedAgentCleanupError) entry.run = error.run;
      else { entry.closedAt ??= this.#now(); if (this.#nativeOwners.get(nativeKey) === entry) this.#nativeOwners.delete(nativeKey); }
      this.#notify(); throw error;
    }) };
    this.#entries.set(key, entry); this.#nativeOwners.set(nativeKey, entry); void entry.opening.catch(() => {}); return entry.opening;
  }
  /** Return the authenticated run handle before SDK initialization finishes.
   * Startup native tools can then use the ordinary Source poll/reply path. */
  async begin(principal: HostedAgentPrincipal, input: HostedAgentOpen): Promise<HostedAgentRun> {
    void this.open(principal, input).catch(() => {});
    return this.#entry(principal, input.runId).prepared;
  }
  async call(principal: HostedAgentPrincipal, runId: string, callId: string, command: HostedAgentCall): Promise<unknown> {
    const entry = this.#entry(principal, runId), run = await entry.opening; this.#assertEntry(principal, entry);
    entry.touchedAt = this.#now(); return run.call(callId, command);
  }
  async reply(principal: HostedAgentPrincipal, runId: string, id: string, result: Parameters<HostedAgentRun["exchange"]["reply"]>[1]): Promise<void> {
    const entry = this.#entry(principal, runId), run = entry.run ?? await entry.opening; this.#assertEntry(principal, entry);
    entry.touchedAt = this.#now(); run.exchange.reply(id, result);
  }
  async readArtifact(principal: HostedAgentPrincipal, runId: string, id: string, offset: number, maximum: number): Promise<{ readonly data: string }> {
    const entry = this.#entry(principal, runId), run = entry.run ?? await entry.opening; this.#assertEntry(principal, entry);
    entry.touchedAt = this.#now(); return run.readArtifact(id, offset, maximum);
  }
  async close(principal: HostedAgentPrincipal, runId: string): Promise<void> {
    const entry = this.#entry(principal, runId); await this.#closeEntry(entry);
  }
  /** Internal route owner, usable after that route's captured authority ends. */
  async closePrincipal(principal: HostedAgentPrincipal): Promise<void> {
    const results = await Promise.allSettled([...this.#entries.values()].filter(entry => entry.principal === principal).map(entry => this.#closeEntry(entry)));
    if (results.some(result => result.status === "rejected")) throw new HostedAgentHostError("UNAVAILABLE");
  }
  async poll(principal: HostedAgentPrincipal, cursors: readonly HostedAgentPollCursor[], signal: AbortSignal, waitMs = 30_000): Promise<readonly HostedAgentPollRun[]> {
    this.#assertPrincipal(principal); signal.throwIfAborted();
    if (this.#polling.has(principal.id)) throw new HostedAgentHostError("CONFLICT");
    if (!Array.isArray(cursors) || cursors.length > 1000 || new Set(cursors.map(value => value.runId)).size !== cursors.length
      || !Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30_000) throw new HostedAgentHostError("INVALID_REQUEST");
    const entries = cursors.map(cursor => ({ cursor, entry: this.#entry(principal, cursor.runId) }));
    this.#polling.add(principal.id);
    let wake!: () => void;
    const changed = new Promise<void>(resolve => { wake = resolve; this.#wake.add(wake); });
    const abort = () => wake(); signal.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const collect = async (): Promise<HostedAgentPollRun[]> => {
      let remaining = HOSTED_AGENT_UNREAD_LIMIT;
      const result: HostedAgentPollRun[] = [];
      for (const { cursor, entry } of entries) {
        this.#assertEntry(principal, entry); entry.touchedAt = this.#now();
        const run = entry.run ?? await entry.opening; this.#assertEntry(principal, entry);
        if (remaining < 1) break;
        const batch = await run.exchange.poll(cursor.after, signal, 0, remaining);
        remaining -= Buffer.byteLength(JSON.stringify(batch.frames));
        result.push({ runId: cursor.runId, ...batch });
      }
      return result;
    };
    try {
      let result = await collect();
      if (waitMs > 0 && !result.some(value => value.frames.length > 0 || value.finished)) {
        timer = setTimeout(wake, waitMs); timer.unref();
        await changed; this.#assertPrincipal(principal); signal.throwIfAborted(); result = await collect();
      }
      this.#assertPrincipal(principal); signal.throwIfAborted(); return result;
    } finally { clearTimeout(timer); this.#wake.delete(wake); signal.removeEventListener("abort", abort); this.#polling.delete(principal.id); }
  }
  async sweep(): Promise<void> {
    const now = this.#now();
    await Promise.all([...this.#entries].map(async ([key, entry]) => {
      let revoked = this.#disposed;
      try { entry.principal.assertCurrent(); entry.assertAccess?.(); if (entry.closedAt === undefined) entry.run?.checkAuthority(); } catch { revoked = true; }
      if (revoked || entry.closedAt === undefined && (entry.run && !entry.run.ready && !entry.run.initializing || now - entry.touchedAt >= 180_000)) await this.#closeEntry(entry).catch(() => {});
      if (entry.closedAt !== undefined && now - entry.closedAt >= 60_000) {
        entry.detach?.(); entry.run?.disposeExchange(); this.#entries.delete(key); this.#expired.add(key);
      }
    }));
  }
  async dispose(): Promise<void> {
    if (!this.#disposed) { this.#disposed = true; clearInterval(this.#timer); this.#notify(); }
    const results = await Promise.allSettled([...this.#entries.values()].map(entry => this.#closeEntry(entry)));
    for (const result of results) if (result.status === "rejected") throw new HostedAgentHostError("UNAVAILABLE");
    for (const entry of this.#entries.values()) { entry.detach?.(); entry.run?.disposeExchange(); }
    this.#entries.clear(); this.#expired.clear(); this.#nativeOwners.clear();
  }
  #closeEntry(entry: Entry): Promise<void> {
    return entry.closing ??= (async () => {
      const run = entry.run ?? await entry.opening.catch(() => undefined); await run?.close(); entry.closedAt ??= this.#now();
      if (this.#nativeOwners.get(entry.nativeKey) === entry) this.#nativeOwners.delete(entry.nativeKey); this.#notify();
    })().catch(error => { entry.closing = undefined; throw error; });
  }
  #entry(principal: HostedAgentPrincipal, runId: string): Entry {
    this.#assertPrincipal(principal); const entry = this.#entries.get(this.#key(principal, runId));
    if (!entry) throw new HostedAgentHostError("UNAVAILABLE"); this.#assertEntry(principal, entry); return entry;
  }
  #assertEntry(principal: HostedAgentPrincipal, entry: Entry): void {
    this.#assertPrincipal(principal);
    if (principal.id !== entry.principal.id || principal.deviceId !== entry.principal.deviceId || principal.trust !== entry.principal.trust) throw new HostedAgentHostError("ACCESS_DENIED");
    try { entry.principal.assertCurrent(); } catch { throw new HostedAgentHostError("ACCESS_DENIED"); }
  }
  #assertPrincipal(principal: HostedAgentPrincipal): void {
    if (this.#disposed) throw new HostedAgentHostError("UNAVAILABLE");
    if (!principal || !validId(principal.id) || !validId(principal.deviceId) || !["owner", "guest"].includes(principal.trust)) throw new HostedAgentHostError("ACCESS_DENIED");
    try { principal.assertCurrent(); } catch { throw new HostedAgentHostError("ACCESS_DENIED"); }
  }
  #key(principal: HostedAgentPrincipal, runId: string): string {
    if (!validId(runId)) throw new HostedAgentHostError("INVALID_REQUEST"); return JSON.stringify([principal.id, runId]);
  }
  #now(): number { return (this.#options.now ?? Date.now)(); }
  #notify(): void { for (const wake of [...this.#wake]) wake(); }
}
function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\0\r\n]/u.test(value); }
function validateOpen(value: HostedAgentOpen): void {
  if (!value || ![value.runId, value.nativeSessionId, value.sessionId, value.targetId, value.backendId, value.providerId, value.modelId].every(validId)
    || !["create", "resume"].includes(value.start)
    || !Number.isSafeInteger(value.generation) || value.generation < 0 || typeof value.fastMode !== "boolean"
    || !["ask", "acceptEdits", "auto", "bypassPermissions"].includes(value.permissionMode)
    || value.name !== undefined && (typeof value.name !== "string" || value.name.length > 16_384 || value.name.includes("\0"))
    || value.effort !== undefined && !validId(value.effort) || Buffer.byteLength(JSON.stringify(value)) > 8 * 1024 * 1024) throw new HostedAgentHostError("INVALID_REQUEST");
}
