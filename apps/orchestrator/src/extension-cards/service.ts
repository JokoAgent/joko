import { Buffer } from "node:buffer";
import {
  EXTENSION_CARD_HEIGHT_DEFAULT, EXTENSION_CARD_HEIGHT_MAX, EXTENSION_CARD_HEIGHT_MIN,
  EXTENSION_CARD_MIN_INTERVAL_MS, EXTENSION_CARD_REOPEN_WINDOW_MS, EXTENSION_CARD_WORKING_WINDOW_MS,
  EXTENSION_CARD_ID_KEY
} from "./protocol.js";
import { sanitizeExtensionCardHtml } from "./sanitizer.js";
import { MAIL_CARD_MAX_BYTES } from "@joko/contracts";

/** Captured by the host before dispatch, never accepted from a plugin message. */
export interface ExtensionCardScope {
  readonly extensionId: string;
  readonly authorityKey: string;
  readonly sessionId: string;
  readonly sessionCreatedAt: number;
  readonly targetId: string;
  readonly toolUseId: string | null;
}
export interface ExtensionCardRow extends ExtensionCardScope {
  readonly callId: string;
  readonly html: string;
  readonly height: number;
  readonly version: 1;
  readonly updatedAt: number;
}
export interface ExtensionCardPush extends ExtensionCardRow {
  /** Process-local presentation only. History never restores running animation. */
  readonly animatedHtml: string | null;
  readonly state: "working" | "done" | null;
}
interface CallEntry {
  readonly scope: ExtensionCardScope;
  hasCard: boolean;
  lastAcceptedAt: number | null;
  settledAt: number | null;
  reopenedAt: number | null;
  workingSince: number | null;
}
interface Options {
  readonly available: (scope: ExtensionCardScope, hostMail: boolean) => boolean;
  /** Commit durable content before returning. A failure must reject publication. */
  readonly persist: (row: ExtensionCardRow) => Promise<void>;
  readonly broadcast: (card: ExtensionCardPush) => void;
  readonly now?: () => number;
}
const GRACE_MS = 10_000;
const CALL_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u;

/** Each call has a serialized commit order. */
export class ExtensionCardService {
  readonly #calls = new Map<string, CallEntry>();
  readonly #writes = new Map<string, Promise<unknown>>();
  readonly #pending = new Map<string, number>();
  #totalPending = 0;
  constructor(private readonly options: Options) {}
  #now(): number { return (this.options.now ?? Date.now)(); }
  #working(entry: CallEntry, now: number): boolean {
    return entry.workingSince !== null && now - entry.workingSince <= EXTENSION_CARD_WORKING_WINDOW_MS;
  }
  #open(entry: CallEntry, now: number): boolean {
    if (this.#working(entry, now)) return true;
    if (entry.reopenedAt !== null && now - entry.reopenedAt > EXTENSION_CARD_REOPEN_WINDOW_MS) return false;
    return entry.settledAt === null || now - entry.settledAt <= GRACE_MS;
  }
  #sweep(): void {
    const now = this.#now();
    for (const [id, entry] of this.#calls) if (!this.#open(entry, now) && !this.#writes.has(id)) this.#calls.delete(id);
  }
  registerCall(callId: string, scope: ExtensionCardScope): void {
    this.#sweep();
    if (!CALL_ID.test(callId) || this.#calls.has(callId) || this.#calls.size >= 4096 || !scope.sessionId) {
      throw new Error("Extension card call registration unavailable.");
    }
    this.#calls.set(callId, { scope: { ...scope }, hasCard: false, lastAcceptedAt: null, settledAt: null, reopenedAt: null, workingSince: null });
  }
  async finalizeCall(callId: string): Promise<boolean> {
    await this.#writes.get(callId)?.catch(() => undefined);
    const entry = this.#calls.get(callId);
    if (!entry) return false;
    entry.settledAt = this.#now();
    return entry.hasCard;
  }
  callInfoOf(callId: string): ExtensionCardScope | null {
    this.#sweep();
    const entry = this.#calls.get(callId);
    return entry ? { ...entry.scope } : null;
  }
  inFlightCallInfoOf(callId: string): ExtensionCardScope | null {
    const entry = this.#calls.get(callId);
    return entry && entry.settledAt === null && entry.reopenedAt === null ? { ...entry.scope } : null;
  }
  reopenForAction(callId: string, scope: ExtensionCardScope): boolean {
    this.#sweep();
    if (!CALL_ID.test(callId) || !(this.options.available(scope, false) || this.options.available(scope, true))) return false;
    const entry = this.#calls.get(callId);
    if (entry) {
      if (!sameScope(entry.scope, scope)) return false;
      entry.settledAt = null; entry.reopenedAt = this.#now(); entry.lastAcceptedAt = null;
    } else {
      if (this.#calls.size >= 4096) return false;
      this.#calls.set(callId, { scope: { ...scope }, hasCard: true, settledAt: null, reopenedAt: this.#now(),
        lastAcceptedAt: null, workingSince: null });
    }
    return true;
  }
  reopenForTool(extensionId: string, authorityKey: string, callId: string, sourceCallId: string, target: ExtensionCardScope): boolean {
    const source = this.inFlightCallInfoOf(sourceCallId);
    return source !== null && source.extensionId === extensionId && source.authorityKey === authorityKey
      && sameScope(source, target) && this.reopenForAction(callId, target);
  }
  handleCardUpdate(extensionId: string, authorityKey: string, payload: unknown, assertCurrent: () => void): Promise<{ accepted: boolean; reason?: string }> {
    return this.#enqueue(extensionId, authorityKey, payload, assertCurrent, false);
  }
  /** Host-generated mail markup is the only path that retains its identity marker. */
  publishHostMail(extensionId: string, authorityKey: string, payload: { callId: string; html: string; state: "working" | "done" }, assertCurrent: () => void): Promise<{ accepted: boolean; reason?: string }> {
    return this.#enqueue(extensionId, authorityKey, { ...payload, type: "card-update", height: EXTENSION_CARD_HEIGHT_MIN, version: 1 }, assertCurrent, true);
  }
  /** Host-assessed account requirements share trusted static markup publication. */
  publishHostAuthorization(extensionId: string, authorityKey: string, callId: string, html: string, assertCurrent: () => void): Promise<{ accepted: boolean; reason?: string }> {
    return this.#enqueue(extensionId, authorityKey, { type: "card-update", version: 1, callId, html, state: "done", height: EXTENSION_CARD_HEIGHT_MIN }, assertCurrent, true);
  }
  #enqueue(extensionId: string, authorityKey: string, payload: unknown, assertCurrent: () => void, hostMail: boolean): Promise<{ accepted: boolean; reason?: string }> {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return Promise.resolve({ accepted: false, reason: "bad-shape" });
    const p = payload as Record<string, unknown>;
    if (typeof p.callId !== "string" || !CALL_ID.test(p.callId)) return Promise.resolve({ accepted: false, reason: "bad-call-id" });
    const callId = p.callId;
    const count = this.#pending.get(callId) ?? 0;
    if (count >= 8 || this.#totalPending >= 32) return Promise.resolve({ accepted: false, reason: "busy" });
    this.#pending.set(callId, count + 1); this.#totalPending += 1;
    const operation = (this.#writes.get(callId) ?? Promise.resolve()).catch(() => undefined)
      .then(() => this.#update(extensionId, authorityKey, p, assertCurrent, hostMail));
    this.#writes.set(callId, operation);
    void operation.finally(() => {
      if (this.#writes.get(callId) === operation) this.#writes.delete(callId);
      const remaining = this.#pending.get(callId)! - 1;
      if (remaining) this.#pending.set(callId, remaining); else this.#pending.delete(callId);
      this.#totalPending -= 1;
    }).catch(() => undefined);
    return operation;
  }
  async #update(extensionId: string, authorityKey: string, p: Record<string, unknown>, assertCurrent: () => void, hostMail: boolean): Promise<{ accepted: boolean; reason?: string }> {
    const reject = (reason: string) => ({ accepted: false, reason });
    try { assertCurrent(); } catch { return reject("source-changed"); }
    this.#sweep();
    const callId = p.callId as string, entry = this.#calls.get(callId);
    if (p.type !== "card-update" || p.version !== 1 || typeof p.html !== "string") return reject("bad-shape");
    if (!entry || entry.scope.extensionId !== extensionId || entry.scope.authorityKey !== authorityKey) return reject("not-owner");
    if (!this.options.available(entry.scope, hostMail)) return reject("capability-unavailable");
    if (p.state !== undefined && p.state !== "working" && p.state !== "done") return reject("bad-state");
    const now = this.#now();
    if (!this.#open(entry, now)) return reject("too-late");
    if (!hostMail && entry.lastAcceptedAt !== null && now - entry.lastAcceptedAt < EXTENSION_CARD_MIN_INTERVAL_MS) return reject("rate-limited");
    if (hostMail && Buffer.byteLength(p.html) > MAIL_CARD_MAX_BYTES) return reject("too-large");
    const clean = hostMail ? { ok: true as const, html: p.html, animatedHtml: undefined } : sanitizeExtensionCardHtml(p.html);
    if (!clean.ok) return reject(`sanitize:${clean.reason}`);
    const height = typeof p.height === "number" && Number.isFinite(p.height) ? Math.round(p.height) : EXTENSION_CARD_HEIGHT_DEFAULT;
    const row: ExtensionCardRow = { ...entry.scope, callId, html: clean.html, version: 1,
      height: Math.min(EXTENSION_CARD_HEIGHT_MAX, Math.max(EXTENSION_CARD_HEIGHT_MIN, height)), updatedAt: now };
    try { assertCurrent(); await this.options.persist(row); } catch { return reject("commit-failed"); }
    entry.hasCard = true; entry.lastAcceptedAt = now;
    const state = p.state === "working" || p.state === "done" ? p.state : null;
    if (state === "working" && entry.workingSince === null) entry.workingSince = now;
    if (state === "done") entry.workingSince = null;
    try { assertCurrent(); if (this.#calls.get(callId) !== entry || !this.options.available(entry.scope, hostMail)) return reject("source-changed"); } catch { return reject("source-changed"); }
    this.options.broadcast({ ...row, animatedHtml: clean.animatedHtml ?? null, state });
    return { accepted: true };
  }
  async flushWrites(): Promise<void> { await Promise.allSettled([...this.#writes.values()]); }
  revoke(extensionId: string): void {
    for (const [id, entry] of this.#calls) if (entry.scope.extensionId === extensionId) this.#calls.delete(id);
  }
}
function sameScope(left: ExtensionCardScope, right: ExtensionCardScope): boolean {
  return left.extensionId === right.extensionId && left.authorityKey === right.authorityKey
    && left.sessionId === right.sessionId && left.sessionCreatedAt === right.sessionCreatedAt && left.targetId === right.targetId;
}
export function withExtensionCardToken<T extends { readonly ok: boolean; readonly result?: unknown }>(result: T, hasCard: boolean, callId: string): T {
  if (!hasCard || !result.ok || result.result !== undefined && result.result !== null
    && (typeof result.result !== "object" || Array.isArray(result.result))) return result;
  return { ...result, result: { ...result.result as Record<string, unknown> | undefined, [EXTENSION_CARD_ID_KEY]: callId } };
}
