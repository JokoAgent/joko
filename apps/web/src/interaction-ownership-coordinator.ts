import type { QuestionAnswerDraft } from "./model.js";
import type { QuestionWizardDraft } from "./components/coding-ui-behavior.js";

/** Exact current-v1 identity for one interactive decision. */
export interface InteractionOwnerKey {
  readonly serverId: string;
  readonly profileId: string;
  readonly sessionId: string;
  readonly interactionId: string;
  readonly interactionGeneration: bigint;
}

export type InteractionOwnershipStatus = "claiming" | "owner" | "observer" | "handoff" | "settled" | "unavailable";

export interface InteractionOwnershipSnapshot<D> {
  readonly key: InteractionOwnerKey;
  readonly status: InteractionOwnershipStatus;
  readonly draft?: D;
  readonly revision: number;
  readonly ownerId?: string;
  /** Opaque per-lock-term fence echoed by UI actions from their render. */
  readonly ownerToken?: string;
}

export interface InteractionSettleToken { readonly id: string }
export interface InteractionLock { readonly name: string }

export interface InteractionLockManager {
  request<T>(
    name: string,
    options: { readonly mode: "exclusive"; readonly ifAvailable?: boolean; readonly signal?: AbortSignal },
    callback: (lock: InteractionLock | null) => Promise<T> | T
  ): Promise<T>;
}

export interface InteractionChannelMessageEvent { readonly data: unknown }

export interface InteractionChannel {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: InteractionChannelMessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: InteractionChannelMessageEvent) => void): void;
  close(): void;
}

export interface InteractionTerminalStore {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
}

export interface InteractionOwnershipEnvironment {
  readonly locks: InteractionLockManager;
  readonly createChannel: (name: string) => InteractionChannel;
  readonly terminalStore: InteractionTerminalStore;
  readonly createId: () => string;
  readonly createAbortController: () => AbortController;
  readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer: (timer: unknown) => void;
}

export interface InteractionDraftCodec<D> {
  readonly parse: (value: unknown) => D | undefined;
  readonly clone: (value: D) => D;
  readonly freeze: (value: D) => D;
  readonly equal: (left: D, right: D) => boolean;
}

export type InteractionTransfer<D> =
  | { readonly kind: "ownership-only" }
  | { readonly kind: "draft"; readonly initialDraft: D; readonly codec: InteractionDraftCodec<D> };

type DraftValue<D> = D | null;
type WireMessage =
  | { readonly version: 1; readonly type: "state_request"; readonly scope: string; readonly senderId: string }
  | { readonly version: 1; readonly type: "state"; readonly scope: string; readonly senderId: string; readonly ownerId: string; readonly term: string; readonly revision: number; readonly draft: unknown }
  | { readonly version: 1; readonly type: "release"; readonly scope: string; readonly senderId: string; readonly ownerId: string; readonly term: string; readonly revision: number; readonly draft: unknown }
  | { readonly version: 1; readonly type: "settled"; readonly scope: string; readonly senderId: string; readonly ownerId: string; readonly term: string; readonly revision: number; readonly draft: null }
  | { readonly version: 1; readonly type: "takeover_request"; readonly scope: string; readonly senderId: string; readonly requestId: string }
  | { readonly version: 1; readonly type: "takeover_offer"; readonly scope: string; readonly senderId: string; readonly ownerId: string; readonly targetId: string; readonly requestId: string; readonly offerId: string; readonly revision: number; readonly draft: unknown }
  | { readonly version: 1; readonly type: "takeover_ack"; readonly scope: string; readonly senderId: string; readonly targetId: string; readonly requestId: string; readonly offerId: string }
  | { readonly version: 1; readonly type: "takeover_busy"; readonly scope: string; readonly senderId: string; readonly targetId: string; readonly requestId: string };

interface PendingOffer {
  readonly targetId: string;
  readonly requestId: string;
  readonly offerId: string;
  readonly timer: unknown;
}

interface QueuedClaim {
  readonly ifAvailable: boolean;
  readonly takeoverRequestId?: string;
  readonly onQueued?: () => void;
}

const TAKEOVER_OFFER_TTL_MS = 1_500;
const TAKEOVER_REQUEST_TTL_MS = 3_000;
const TERMINAL_MARKER_TYPE = "settled";

/** BroadcastChannel notifies; Web Locks fence the writer and exact local storage fences terminal generations. */
export class InteractionOwnershipCoordinator<D = never> {
  readonly #key: InteractionOwnerKey;
  readonly #scope: string;
  readonly #lockName: string;
  readonly #channelName: string;
  readonly #terminalKey: string;
  readonly #environment?: InteractionOwnershipEnvironment;
  readonly #codec?: InteractionDraftCodec<D>;
  #clientId = "unavailable";
  readonly #listeners = new Set<(snapshot: InteractionOwnershipSnapshot<D>) => void>();
  readonly #messageListener = (event: InteractionChannelMessageEvent): void => this.#receive(event.data);
  #snapshot: InteractionOwnershipSnapshot<D>;
  #channel?: InteractionChannel;
  #participating = false;
  #disposed = false;
  #claimPending = false;
  #claimIncarnation = 0;
  #incarnation = 0;
  #queuedClaim?: QueuedClaim;
  #claimAbort?: AbortController;
  #releaseLock?: () => void;
  #term?: string;
  #pendingRelease?: Extract<WireMessage, { readonly type: "release" }>;
  #settleToken?: InteractionSettleToken;
  #retireAfterSettle = false;
  #resumeAfterSettle = false;
  #settled = false;
  #settlementPersisted = false;
  #requestedTakeoverId?: string;
  #acceptedTakeoverOffer?: { readonly requestId: string; readonly offerId: string; readonly ownerId: string };
  #takeoverTimer?: unknown;
  #takeoverResolvers: Array<(owned: boolean) => void> = [];
  #pendingOffer?: PendingOffer;

  constructor(key: InteractionOwnerKey, transfer: InteractionTransfer<D>, environment?: InteractionOwnershipEnvironment) {
    this.#key = exactOwnerKey(key);
    this.#scope = JSON.stringify([
      this.#key.serverId,
      this.#key.profileId,
      this.#key.sessionId,
      this.#key.interactionId,
      this.#key.interactionGeneration.toString()
    ]);
    this.#lockName = `joko:interaction-owner:v1:lock:${this.#scope}`;
    this.#channelName = `joko:interaction-owner:v1:channel:${this.#scope}`;
    this.#terminalKey = `joko:interaction-owner:v1:terminal:${this.#scope}`;
    this.#environment = environment;
    this.#codec = transfer.kind === "draft" ? transfer.codec : undefined;
    this.#snapshot = this.#freezeSnapshot({
      key: this.#key,
      status: environment === undefined ? "unavailable" : "claiming",
      ...(transfer.kind === "draft" ? { draft: transfer.codec.clone(transfer.initialDraft) } : {}),
      revision: 0
    });
  }

  /** Stable by identity until a real coordinator transition occurs. */
  get snapshot(): InteractionOwnershipSnapshot<D> { return this.#snapshot; }

  subscribe(listener: (snapshot: InteractionOwnershipSnapshot<D>) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#snapshot);
    return () => this.#listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.#disposed || this.#participating || this.#retireAfterSettle || this.#settled || this.#environment === undefined) return;
    try {
      if (this.#readPersistedSettlement()) {
        this.#acceptPersistedSettlement();
        return;
      }
    } catch {
      this.#setSnapshot({ ...this.#snapshot, status: "unavailable", ownerId: undefined, ownerToken: undefined });
      return;
    }
    this.#participating = true;
    this.#incarnation += 1;
    try {
      this.#clientId = this.#environment.createId();
      this.#channel = this.#environment.createChannel(this.#channelName);
      this.#channel.addEventListener("message", this.#messageListener);
    } catch {
      this.#participating = false;
      this.#closeChannel();
      this.#setSnapshot({ ...this.#snapshot, status: "unavailable", ownerId: undefined, ownerToken: undefined });
      return;
    }
    await this.#claim({ ifAvailable: true });
  }

  writeDraft(expectedOwnerToken: string, draft: D): boolean {
    const codec = this.#codec;
    if (codec === undefined || !this.#hasWritableLease() || this.#snapshot.ownerToken !== expectedOwnerToken) return false;
    if (this.#snapshot.draft !== undefined && codec.equal(this.#snapshot.draft, draft)) return true;
    this.#setSnapshot({ ...this.#snapshot, draft: codec.clone(draft), revision: this.#snapshot.revision + 1 });
    return this.#publishState("state");
  }

  /** Synchronously freezes this owner while its single resolve RPC is in flight. */
  beginSettle(expectedOwnerToken: string): InteractionSettleToken | undefined {
    const environment = this.#environment;
    if (!this.#hasWritableLease() || this.#snapshot.ownerToken !== expectedOwnerToken || environment === undefined) return undefined;
    let token: InteractionSettleToken;
    try { token = Object.freeze({ id: `${this.#term!}:${this.#snapshot.revision}:${environment.createId()}` }); }
    catch { this.#failUnavailable(); return undefined; }
    this.#settleToken = token;
    return token;
  }

  finishSettle(token: InteractionSettleToken, outcome: "succeeded" | "failed"): boolean {
    if (this.#settleToken?.id !== token.id) return false;
    const wasRetired = this.#retireAfterSettle || this.#disposed || !this.#participating;
    if (outcome === "succeeded" && this.#holdsLock()) {
      this.#settlementPersisted = this.#persistSettlement();
      this.#settled = true;
      this.#setSnapshot({ key: this.#key, status: "settled", revision: this.#snapshot.revision + 1, ownerId: this.#clientId });
      const terminalPublished = wasRetired ? this.#publishDetachedState("settled") : this.#publishState("settled");
      // A live-channel send failure retires the coordinator while the settle
      // token still fences the lock. Retry through a fresh channel before
      // deciding whether it is safe to release that lock.
      if (!terminalPublished) this.#publishDetachedState("settled");
      this.#setSnapshot({ key: this.#key, status: "settled", revision: this.#snapshot.revision, ownerId: this.#clientId });
    }
    this.#settleToken = undefined;
    const resumeAfterFailure = outcome === "failed" && this.#resumeAfterSettle && !this.#disposed;
    this.#resumeAfterSettle = false;
    const retired = wasRetired || this.#retireAfterSettle || this.#disposed || !this.#participating;
    if (retired) {
      this.#retireAfterSettle = false;
      this.#closeChannel();
      if (outcome === "succeeded" && !this.#settlementPersisted) {
        // BroadcastChannel is only notification. If the monotonic terminal
        // fence could not be persisted, a hidden or late peer must never be
        // allowed to acquire the stale Interaction. The browser releases this
        // fail-closed lock only when the retired browsing context goes away.
        return true;
      }
      this.#releaseOwnership("release", outcome === "failed");
    } else if (this.#holdsLock() && !this.#settled) {
      this.#setSnapshot({ ...this.#snapshot, status: "owner", ownerId: this.#clientId, ownerToken: this.#term });
    }
    if (resumeAfterFailure) void this.start();
    return true;
  }

  async takeover(): Promise<boolean> {
    const environment = this.#environment;
    if (this.#disposed || !this.#participating || this.#settled || environment === undefined) return false;
    try {
      if (this.#readPersistedSettlement()) {
        this.#acceptPersistedSettlement();
        return false;
      }
    } catch {
      this.#failUnavailable();
      return false;
    }
    if (this.#hasWritableLease()) return true;
    if (this.#requestedTakeoverId !== undefined) return new Promise((resolve) => this.#takeoverResolvers.push(resolve));
    let requestId: string;
    try { requestId = environment.createId(); }
    catch { this.#failUnavailable(); return false; }
    this.#requestedTakeoverId = requestId;
    this.#setSnapshot({ ...this.#snapshot, status: "claiming" });
    const completion = new Promise<boolean>((resolve) => this.#takeoverResolvers.push(resolve));
    try {
      this.#takeoverTimer = environment.setTimer(() => {
        if (this.#requestedTakeoverId === requestId) this.#settleTakeover(false);
      }, TAKEOVER_REQUEST_TTL_MS);
    } catch {
      this.#failUnavailable();
      return false;
    }
    if (!this.#send({ version: 1, type: "takeover_request", scope: this.#scope, senderId: this.#clientId, requestId })) return false;
    // Recover a lock whose prior page crashed without entering a competing queue.
    void this.#claim({ ifAvailable: true, takeoverRequestId: requestId });
    return completion;
  }

  pause(): void {
    if (!this.#participating) {
      this.#resumeAfterSettle = false;
      return;
    }
    this.#resumeAfterSettle = false;
    this.#participating = false;
    this.#incarnation += 1;
    this.#claimAbort?.abort();
    this.#claimAbort = undefined;
    this.#queuedClaim = undefined;
    this.#cancelOffer(false);
    this.#settleTakeover(false);
    if (this.#settleToken !== undefined && this.#holdsLock()) {
      this.#retireAfterSettle = true;
      this.#closeChannel();
      this.#setSnapshot({ ...this.#snapshot, status: "claiming", ownerId: undefined, ownerToken: undefined });
      return;
    }
    if (this.#settled && this.#holdsLock() && !this.#settlementPersisted) {
      this.#closeChannel();
      this.#setSnapshot({ key: this.#key, status: "settled", revision: this.#snapshot.revision, ...(this.#snapshot.ownerId === undefined ? {} : { ownerId: this.#snapshot.ownerId }) });
      return;
    }
    this.#releaseOwnership("release", !this.#settled);
    this.#closeChannel();
    if (!this.#disposed && this.#environment !== undefined) {
      this.#setSnapshot(this.#settled
        ? { key: this.#key, status: "settled", revision: this.#snapshot.revision, ...(this.#snapshot.ownerId === undefined ? {} : { ownerId: this.#snapshot.ownerId }) }
        : { ...this.#snapshot, status: "claiming", ownerId: undefined, ownerToken: undefined });
    }
  }

  async resume(): Promise<void> {
    if (this.#disposed || this.#participating) return;
    if (this.#retireAfterSettle) {
      this.#resumeAfterSettle = true;
      return;
    }
    await this.start();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.pause();
    this.#disposed = true;
    this.#listeners.clear();
  }

  async #claim(claim: QueuedClaim): Promise<void> {
    const environment = this.#environment;
    if (!this.#participating || this.#disposed || this.#settled || environment === undefined || this.#holdsLock()) return;
    const incarnation = this.#incarnation;
    if (this.#claimPending) {
      if (this.#claimIncarnation !== incarnation || !claim.ifAvailable) this.#queuedClaim = claim;
      return;
    }
    this.#claimPending = true;
    this.#claimIncarnation = incarnation;
    let abort: AbortController | undefined;
    try { abort = claim.ifAvailable ? undefined : environment.createAbortController(); }
    catch { this.#failUnavailable(); this.#claimPending = false; return; }
    this.#claimAbort = abort;
    let initialResolve: (() => void) | undefined;
    const initial = new Promise<void>((resolve) => { initialResolve = resolve; });
    let request: Promise<unknown>;
    try {
      request = environment.locks.request(
        this.#lockName,
        claim.ifAvailable ? { mode: "exclusive", ifAvailable: true } : { mode: "exclusive", signal: abort!.signal },
        async (lock) => {
          const takeoverExpired = claim.takeoverRequestId !== undefined && claim.takeoverRequestId !== this.#requestedTakeoverId;
          if (lock === null || !this.#participating || this.#disposed || incarnation !== this.#incarnation || takeoverExpired) {
            if (lock === null && this.#participating && !this.#disposed && incarnation === this.#incarnation) {
              this.#setSnapshot({ ...this.#snapshot, status: "observer" });
              this.#send({ version: 1, type: "state_request", scope: this.#scope, senderId: this.#clientId });
            }
            initialResolve?.(); initialResolve = undefined;
            return;
          }
          try {
            if (this.#readPersistedSettlement()) {
              this.#acceptPersistedSettlement();
              initialResolve?.(); initialResolve = undefined;
              return;
            }
          } catch {
            initialResolve?.(); initialResolve = undefined;
            this.#failUnavailable();
            return;
          }
          let term: string;
          try { term = environment.createId(); }
          catch { initialResolve?.(); initialResolve = undefined; this.#failUnavailable(); return; }
          let releaseLock!: () => void;
          const hold = new Promise<void>((resolve) => { releaseLock = resolve; });
          this.#releaseLock = releaseLock;
          this.#term = term;
          this.#setSnapshot({ ...this.#snapshot, status: "owner", ownerId: this.#clientId, ownerToken: term, revision: this.#snapshot.revision + 1 });
          const published = this.#publishState("state");
          this.#settleTakeover(published && this.#hasWritableLease());
          initialResolve?.(); initialResolve = undefined;
          await hold;
          this.#releaseLock = undefined;
        }
      );
      // Web Locks queues synchronously before request() returns.
      claim.onQueued?.();
    } catch {
      this.#failUnavailable();
      this.#claimPending = false;
      this.#claimAbort = undefined;
      initialResolve?.();
      return;
    }
    void request.catch(() => {
      if (this.#participating && !this.#disposed && incarnation === this.#incarnation && abort?.signal.aborted !== true) this.#failUnavailable();
      this.#settleTakeover(false);
      initialResolve?.(); initialResolve = undefined;
    }).finally(() => {
      const release = this.#pendingRelease;
      this.#pendingRelease = undefined;
      if (release !== undefined) this.#publishReleasedState(release);
      if (abort !== undefined && this.#claimAbort === abort) this.#claimAbort = undefined;
      this.#claimPending = false;
      initialResolve?.();
      const queued = this.#queuedClaim;
      this.#queuedClaim = undefined;
      if (queued !== undefined && this.#participating && !this.#disposed && !this.#holdsLock()) void this.#claim(queued);
    });
    await initial;
  }

  #receive(value: unknown): void {
    if ((!this.#participating && this.#settleToken === undefined) || this.#disposed) return;
    const message = this.#parseWireMessage(value);
    if (message === undefined || message.scope !== this.#scope || message.senderId === this.#clientId) return;
    if (message.type === "state_request") {
      if (this.#holdsLock()) this.#publishState(this.#settled ? "settled" : "state");
      return;
    }
    if (message.type === "settled") {
      if (this.#holdsLock()) return;
      const knownOwner = this.#snapshot.ownerId;
      const fresh = message.revision > this.#snapshot.revision
        || (message.revision === this.#snapshot.revision && knownOwner === message.ownerId && this.#snapshot.status === "settled");
      if (!fresh) return;
      if (!this.#persistSettlement()) {
        this.#failUnavailable();
        return;
      }
      this.#settled = true;
      this.#settlementPersisted = true;
      this.#settleTakeover(false);
      this.#setSnapshot({ key: this.#key, status: "settled", revision: message.revision, ownerId: message.ownerId });
      return;
    }
    if (this.#settled) return;
    if (message.type === "takeover_request") { this.#offerTakeover(message.senderId, message.requestId); return; }
    if (message.type === "takeover_offer") {
      if (message.targetId !== this.#clientId || message.requestId !== this.#requestedTakeoverId || this.#holdsLock()) return;
      if (this.#acceptedTakeoverOffer?.requestId === message.requestId) return;
      const knownOwner = this.#snapshot.ownerId;
      if (message.revision < this.#snapshot.revision || (message.revision === this.#snapshot.revision
        && (knownOwner !== message.ownerId || !this.#draftMatches(message.draft as D | null)))) return;
      this.#acceptedTakeoverOffer = { requestId: message.requestId, offerId: message.offerId, ownerId: message.ownerId };
      this.#adopt(message.draft as D | null, message.revision, message.ownerId, true);
      void this.#claim({
        ifAvailable: false,
        takeoverRequestId: message.requestId,
        onQueued: () => this.#send({ version: 1, type: "takeover_ack", scope: this.#scope, senderId: this.#clientId, targetId: message.ownerId, requestId: message.requestId, offerId: message.offerId })
      });
      return;
    }
    if (message.type === "takeover_ack") {
      const offer = this.#pendingOffer;
      if (message.targetId !== this.#clientId || offer === undefined || message.senderId !== offer.targetId
        || message.requestId !== offer.requestId || message.offerId !== offer.offerId || !this.#holdsLock()) return;
      this.#cancelOffer(true);
      if (!this.#holdsLock()) return;
      this.#releaseOwnership("release");
      if (this.#snapshot.status === "unavailable") return;
      this.#setSnapshot({ ...this.#snapshot, status: "observer", ownerId: message.senderId, ownerToken: undefined });
      return;
    }
    if (message.type === "takeover_busy") {
      if (message.targetId === this.#clientId && message.requestId === this.#requestedTakeoverId) this.#settleTakeover(false);
      return;
    }
    // An actual exclusive-lock holder never accepts peer state or release.
    if (this.#holdsLock()) return;
    if (message.type === "release") {
      const knownOwner = this.#snapshot.ownerId;
      if (message.revision === this.#snapshot.revision && knownOwner === undefined) return;
      const fresh = message.revision > this.#snapshot.revision
        || (message.revision === this.#snapshot.revision && knownOwner === message.ownerId && this.#draftMatches(message.draft as D | null));
      if (!fresh) return;
      this.#adopt(message.draft as D | null, message.revision, undefined, true);
      if (!this.#claimPending) void this.#claim({ ifAvailable: true });
      return;
    }
    if (message.revision <= this.#snapshot.revision) return;
    this.#adopt(message.draft as D | null, message.revision, message.ownerId);
  }

  #offerTakeover(targetId: string, requestId: string): void {
    const environment = this.#environment;
    // Observers hear the broadcast too, but only the exclusive lock holder may
    // answer it. Otherwise a peer can incorrectly veto the real owner's offer.
    if (!this.#holdsLock()) return;
    if (this.#settled) {
      this.#publishState("settled");
      return;
    }
    if (!this.#hasWritableLease() || environment === undefined || this.#pendingOffer !== undefined) {
      this.#send({ version: 1, type: "takeover_busy", scope: this.#scope, senderId: this.#clientId, targetId, requestId });
      return;
    }
    let offerId: string;
    let timer: unknown;
    try {
      offerId = environment.createId();
      timer = environment.setTimer(() => {
        const offer = this.#pendingOffer;
        if (offer?.offerId !== offerId) return;
        this.#cancelOffer(false);
        this.#send({ version: 1, type: "takeover_busy", scope: this.#scope, senderId: this.#clientId, targetId, requestId });
      }, TAKEOVER_OFFER_TTL_MS);
    } catch {
      this.#failUnavailable();
      return;
    }
    this.#pendingOffer = { targetId, requestId, offerId, timer };
    this.#setSnapshot({ ...this.#snapshot, status: "handoff", ownerId: this.#clientId, ownerToken: undefined });
    if (!this.#send({ version: 1, type: "takeover_offer", scope: this.#scope, senderId: this.#clientId, ownerId: this.#clientId, targetId, requestId, offerId, revision: this.#snapshot.revision, draft: this.#draftValue() })) this.#cancelOffer(false);
  }

  #adopt(draft: D | null, revision: number, ownerId: string | undefined, allowEqual = false): void {
    if (revision < this.#snapshot.revision || (!allowEqual && revision === this.#snapshot.revision)) return;
    const nextStatus = this.#snapshot.status === "claiming" ? "claiming" : "observer";
    if (revision === this.#snapshot.revision && this.#snapshot.status === nextStatus && this.#snapshot.ownerId === ownerId
      && ((draft === null && this.#snapshot.draft === undefined) || (draft !== null && this.#snapshot.draft !== undefined && this.#codec?.equal(this.#snapshot.draft, draft) === true))) return;
    this.#setSnapshot({ key: this.#key, status: nextStatus, ...(draft === null ? {} : { draft: this.#codec!.clone(draft) }), revision, ...(ownerId === undefined ? {} : { ownerId }) });
  }

  #releaseOwnership(type: "release", publish = true): void {
    if (!this.#holdsLock()) return;
    if (publish) {
      this.#pendingRelease = {
        version: 1,
        type,
        scope: this.#scope,
        senderId: this.#clientId,
        ownerId: this.#clientId,
        term: this.#term!,
        revision: this.#snapshot.revision,
        draft: this.#draftValue()
      };
    }
    this.#term = undefined;
    const release = this.#releaseLock;
    this.#releaseLock = undefined;
    release?.();
    if (this.#snapshot.ownerToken !== undefined) this.#setSnapshot({ ...this.#snapshot, ownerToken: undefined });
  }

  #publishState(type: "state" | "settled"): boolean {
    if (this.#term === undefined) return false;
    if (type === "settled") {
      return this.#send({ version: 1, type, scope: this.#scope, senderId: this.#clientId, ownerId: this.#clientId,
        term: this.#term, revision: this.#snapshot.revision, draft: null });
    }
    return this.#send({ version: 1, type, scope: this.#scope, senderId: this.#clientId, ownerId: this.#clientId,
      term: this.#term, revision: this.#snapshot.revision, draft: this.#draftValue() });
  }

  #publishDetachedState(type: "settled"): boolean {
    const environment = this.#environment;
    if (environment === undefined || this.#term === undefined) return false;
    let channel: InteractionChannel | undefined;
    try {
      channel = environment.createChannel(this.#channelName);
      channel.postMessage({ version: 1, type, scope: this.#scope, senderId: this.#clientId, ownerId: this.#clientId,
        term: this.#term, revision: this.#snapshot.revision, draft: null } satisfies WireMessage);
      return true;
    } catch { return false; }
    finally { try { channel?.close(); } catch { /* already unusable */ } }
  }

  #readPersistedSettlement(): boolean {
    const raw = this.#environment!.terminalStore.getItem(this.#terminalKey);
    if (raw === null) return false;
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch { throw new TypeError("Invalid current-v1 Interaction terminal marker."); }
    if (!isRecord(value) || !exactKeys(value, ["version", "type", "scope"])
      || value.version !== 1 || value.type !== TERMINAL_MARKER_TYPE || value.scope !== this.#scope) {
      throw new TypeError("Invalid current-v1 Interaction terminal marker.");
    }
    this.#settlementPersisted = true;
    return true;
  }

  #persistSettlement(): boolean {
    const environment = this.#environment;
    if (environment === undefined) return false;
    try {
      if (this.#readPersistedSettlement()) return true;
      environment.terminalStore.setItem(this.#terminalKey, JSON.stringify({ version: 1, type: TERMINAL_MARKER_TYPE, scope: this.#scope }));
      return this.#readPersistedSettlement();
    } catch { return false; }
  }

  #acceptPersistedSettlement(): void {
    this.#settled = true;
    this.#settlementPersisted = true;
    this.#settleTakeover(false);
    this.#setSnapshot({ key: this.#key, status: "settled", revision: this.#snapshot.revision });
  }

  /** Publish only after the Web Locks request has settled and the UA released it. */
  #publishReleasedState(message: Extract<WireMessage, { readonly type: "release" }>): void {
    if (this.#channel !== undefined) {
      try { this.#channel.postMessage(message); }
      catch { this.#failUnavailable(); }
      return;
    }
    const environment = this.#environment;
    if (environment === undefined) return;
    let channel: InteractionChannel | undefined;
    try {
      channel = environment.createChannel(this.#channelName);
      channel.postMessage(message);
    } catch { /* peers can still use explicit takeover after an owner disappears */ }
    finally { try { channel?.close(); } catch { /* already unusable */ } }
  }

  #send(message: WireMessage): boolean {
    try {
      if (this.#channel === undefined) return false;
      this.#channel.postMessage(message);
      return true;
    } catch {
      this.#failUnavailable();
      return false;
    }
  }

  #failUnavailable(): void {
    if (this.#settleToken !== undefined && this.#holdsLock()) {
      this.#retireAfterSettle = true;
      this.#participating = false;
      this.#incarnation += 1;
      this.#claimAbort?.abort();
      this.#claimAbort = undefined;
      this.#queuedClaim = undefined;
      const offer = this.#pendingOffer;
      this.#pendingOffer = undefined;
      try { if (offer !== undefined) this.#environment?.clearTimer(offer.timer); } catch { /* already unavailable */ }
      this.#settleTakeover(false);
      this.#closeChannel();
      this.#setSnapshot({ ...this.#snapshot, status: "unavailable", ownerId: undefined, ownerToken: undefined });
      return;
    }
    this.#cancelOffer(false);
    this.#settleTakeover(false);
    this.#settleToken = undefined;
    this.#claimAbort?.abort();
    this.#claimAbort = undefined;
    this.#releaseOwnership("release", false);
    this.#closeChannel();
    this.#participating = false;
    this.#setSnapshot({ ...this.#snapshot, status: "unavailable", ownerId: undefined, ownerToken: undefined });
  }

  #cancelOffer(accepted: boolean): void {
    const offer = this.#pendingOffer;
    if (offer === undefined) return;
    this.#pendingOffer = undefined;
    try { this.#environment?.clearTimer(offer.timer); } catch { this.#failUnavailable(); return; }
    if (!accepted && this.#holdsLock() && this.#participating) this.#setSnapshot({ ...this.#snapshot, status: "owner", ownerId: this.#clientId, ownerToken: this.#term });
  }

  #settleTakeover(owned: boolean): void {
    this.#requestedTakeoverId = undefined;
    this.#acceptedTakeoverOffer = undefined;
    if (!owned) {
      if (this.#queuedClaim?.ifAvailable === false) this.#queuedClaim = undefined;
      const abort = this.#claimAbort;
      this.#claimAbort = undefined;
      abort?.abort();
    }
    const timer = this.#takeoverTimer;
    this.#takeoverTimer = undefined;
    try { if (timer !== undefined) this.#environment?.clearTimer(timer); } catch { this.#failUnavailable(); return; }
    if (!owned && this.#participating && !this.#disposed && !this.#holdsLock() && this.#snapshot.status === "claiming") {
      this.#setSnapshot({ ...this.#snapshot, status: "observer", ownerId: this.#snapshot.ownerId });
    }
    const resolvers = this.#takeoverResolvers.splice(0);
    for (const resolve of resolvers) resolve(owned);
  }

  #holdsLock(): boolean { return this.#term !== undefined && this.#releaseLock !== undefined; }
  #hasWritableLease(): boolean { return !this.#settled && this.#participating && !this.#disposed && this.#holdsLock() && this.#snapshot.status === "owner" && this.#snapshot.ownerToken === this.#term && this.#settleToken === undefined && this.#pendingOffer === undefined; }

  #closeChannel(): void {
    const channel = this.#channel;
    this.#channel = undefined;
    if (channel === undefined) return;
    try { channel.removeEventListener("message", this.#messageListener); } catch { /* already unusable */ }
    try { channel.close(); } catch { /* already unusable */ }
  }

  #draftValue(): D | null { return this.#snapshot.draft === undefined ? null : this.#codec!.clone(this.#snapshot.draft); }
  #draftMatches(draft: D | null): boolean {
    return draft === null ? this.#snapshot.draft === undefined
      : this.#snapshot.draft !== undefined && this.#codec?.equal(this.#snapshot.draft, draft) === true;
  }

  #parseWireMessage(value: unknown): WireMessage & { readonly draft?: D | null } | undefined {
    const message = parseWireMessage(value);
    if (message === undefined || !("draft" in message)) return message;
    if (message.draft === null) return message as WireMessage & { readonly draft: null };
    const parsed = this.#codec?.parse(message.draft);
    return parsed === undefined ? undefined : { ...message, draft: parsed };
  }

  #freezeSnapshot(snapshot: InteractionOwnershipSnapshot<D>): InteractionOwnershipSnapshot<D> {
    const key = Object.freeze({ ...snapshot.key });
    const draft = snapshot.draft === undefined ? undefined : this.#codec!.freeze(snapshot.draft);
    return Object.freeze({ key, status: snapshot.status, ...(draft === undefined ? {} : { draft }), revision: snapshot.revision, ...(snapshot.ownerId === undefined ? {} : { ownerId: snapshot.ownerId }), ...(snapshot.ownerToken === undefined ? {} : { ownerToken: snapshot.ownerToken }) });
  }

  #setSnapshot(snapshot: InteractionOwnershipSnapshot<D>): void {
    if (snapshot.status === this.#snapshot.status && snapshot.revision === this.#snapshot.revision
      && snapshot.ownerId === this.#snapshot.ownerId && snapshot.ownerToken === this.#snapshot.ownerToken
      && ((snapshot.draft === undefined && this.#snapshot.draft === undefined)
        || (snapshot.draft !== undefined && this.#snapshot.draft !== undefined && this.#codec?.equal(snapshot.draft, this.#snapshot.draft) === true))) return;
    this.#snapshot = this.#freezeSnapshot(snapshot);
    for (const listener of this.#listeners) listener(this.#snapshot);
  }
}

export function createCurrentV1InteractionOwnershipCoordinator<D>(key: InteractionOwnerKey, transfer: InteractionTransfer<D>, ownerWindow: Window & typeof globalThis): InteractionOwnershipCoordinator<D> {
  return new InteractionOwnershipCoordinator(key, transfer, environmentFromOwnerWindow(ownerWindow));
}

function environmentFromOwnerWindow(ownerWindow: Window & typeof globalThis): InteractionOwnershipEnvironment | undefined {
  try {
    const locks = ownerWindow.navigator.locks;
    const Channel = ownerWindow.BroadcastChannel;
    const randomUUID = ownerWindow.crypto.randomUUID?.bind(ownerWindow.crypto);
    if (locks === undefined || typeof Channel !== "function" || randomUUID === undefined) return undefined;
    const terminalStore = ownerWindow.localStorage;
    const OwnerAbortController = ownerWindow.AbortController;
    if (typeof OwnerAbortController !== "function") return undefined;
    return { locks, createChannel: (name) => new Channel(name), terminalStore, createId: () => randomUUID(), createAbortController: () => new OwnerAbortController(), setTimer: (callback, delayMs) => ownerWindow.setTimeout(callback, delayMs), clearTimer: (timer) => ownerWindow.clearTimeout(timer as number) };
  } catch { return undefined; }
}

function exactOwnerKey(key: InteractionOwnerKey): InteractionOwnerKey {
  const record = key as unknown as Record<string, unknown>;
  if (!exactKeys(record, ["serverId", "profileId", "sessionId", "interactionId", "interactionGeneration"])) throw new TypeError("Interaction owner key must use the exact current-v1 shape.");
  for (const field of ["serverId", "profileId", "sessionId", "interactionId"] as const) if (!nonBlankString(key[field])) throw new TypeError(`Interaction ${field} is required.`);
  if (typeof key.interactionGeneration !== "bigint" || key.interactionGeneration < 0n) throw new TypeError("Interaction interactionGeneration must be a non-negative bigint.");
  return { ...key };
}

function parseWireMessage(value: unknown): WireMessage | undefined {
  if (!isRecord(value) || value.version !== 1 || !nonBlankString(value.scope) || !nonBlankString(value.senderId) || typeof value.type !== "string") return undefined;
  if (value.type === "state_request" && exactKeys(value, ["version", "type", "scope", "senderId"])) return value as unknown as WireMessage;
  if (value.type === "takeover_request" && exactKeys(value, ["version", "type", "scope", "senderId", "requestId"]) && nonBlankString(value.requestId)) return value as unknown as WireMessage;
  if (value.type === "takeover_ack" && exactKeys(value, ["version", "type", "scope", "senderId", "targetId", "requestId", "offerId"]) && nonBlankString(value.targetId) && nonBlankString(value.requestId) && nonBlankString(value.offerId)) return value as unknown as WireMessage;
  if (value.type === "takeover_busy" && exactKeys(value, ["version", "type", "scope", "senderId", "targetId", "requestId"]) && nonBlankString(value.targetId) && nonBlankString(value.requestId)) return value as unknown as WireMessage;
  if (value.type === "takeover_offer" && exactKeys(value, ["version", "type", "scope", "senderId", "ownerId", "targetId", "requestId", "offerId", "revision", "draft"]) && value.senderId === value.ownerId && nonBlankString(value.ownerId) && nonBlankString(value.targetId) && nonBlankString(value.requestId) && nonBlankString(value.offerId) && validRevision(value.revision)) {
    return { version: 1, type: "takeover_offer", scope: value.scope, senderId: value.senderId, ownerId: value.ownerId, targetId: value.targetId, requestId: value.requestId, offerId: value.offerId, revision: value.revision, draft: value.draft };
  }
  if ((value.type === "state" || value.type === "release") && exactKeys(value, ["version", "type", "scope", "senderId", "ownerId", "term", "revision", "draft"]) && value.senderId === value.ownerId && nonBlankString(value.ownerId) && nonBlankString(value.term) && validRevision(value.revision)) {
    return { version: 1, type: value.type, scope: value.scope, senderId: value.senderId, ownerId: value.ownerId, term: value.term, revision: value.revision, draft: value.draft };
  }
  if (value.type === "settled" && exactKeys(value, ["version", "type", "scope", "senderId", "ownerId", "term", "revision", "draft"]) && value.senderId === value.ownerId && nonBlankString(value.ownerId) && nonBlankString(value.term) && validRevision(value.revision) && value.draft === null) {
    return { version: 1, type: "settled", scope: value.scope, senderId: value.senderId, ownerId: value.ownerId, term: value.term, revision: value.revision, draft: null };
  }
  return undefined;
}

function parseDraft(value: unknown): QuestionWizardDraft | undefined {
  if (!isRecord(value) || !exactKeys(value, ["answers", "otherText", "currentIndex", "minimized"]) || !isRecord(value.answers) || !isRecord(value.otherText) || !Number.isSafeInteger(value.currentIndex) || (value.currentIndex as number) < 0 || typeof value.minimized !== "boolean") return undefined;
  const answerEntries: Array<readonly [string, QuestionAnswerDraft]> = [];
  for (const [id, answer] of Object.entries(value.answers)) {
    const parsed = parseAnswer(answer);
    if (!nonBlankString(id) || parsed === undefined) return undefined;
    answerEntries.push([id, parsed]);
  }
  const otherEntries: Array<readonly [string, string]> = [];
  for (const [id, text] of Object.entries(value.otherText)) {
    if (!nonBlankString(id) || typeof text !== "string") return undefined;
    otherEntries.push([id, text]);
  }
  return { answers: Object.fromEntries(answerEntries), otherText: Object.fromEntries(otherEntries), currentIndex: value.currentIndex as number, minimized: value.minimized };
}

function parseAnswer(value: unknown): QuestionAnswerDraft | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "text" && exactKeys(value, ["kind", "value"]) && typeof value.value === "string") return { kind: "text", value: value.value };
  if (value.kind === "boolean" && exactKeys(value, ["kind", "value"]) && typeof value.value === "boolean") return { kind: "boolean", value: value.value };
  if (value.kind === "single" && exactKeys(value, ["kind", "selection"]) && isRecord(value.selection)) {
    if (value.selection.kind === "choice" && exactKeys(value.selection, ["kind", "choiceId"]) && nonBlankString(value.selection.choiceId)) return { kind: "single", selection: { kind: "choice", choiceId: value.selection.choiceId } };
    if (value.selection.kind === "other" && exactKeys(value.selection, ["kind", "text"]) && typeof value.selection.text === "string") return { kind: "single", selection: { kind: "other", text: value.selection.text } };
    return undefined;
  }
  if (value.kind === "multiple" && (exactKeys(value, ["kind", "choiceIds"]) || exactKeys(value, ["kind", "choiceIds", "otherText"])) && Array.isArray(value.choiceIds) && value.choiceIds.every(nonBlankString) && new Set(value.choiceIds).size === value.choiceIds.length) {
    if (Object.hasOwn(value, "otherText") && typeof value.otherText !== "string") return undefined;
    return { kind: "multiple", choiceIds: [...value.choiceIds], ...(typeof value.otherText === "string" ? { otherText: value.otherText } : {}) };
  }
  return undefined;
}

function freezeDraft(draft: QuestionWizardDraft): QuestionWizardDraft {
  const cloned = cloneDraft(draft);
  for (const answer of Object.values(cloned.answers)) {
    if (answer.kind === "multiple") Object.freeze(answer.choiceIds);
    else if (answer.kind === "single") Object.freeze(answer.selection);
    Object.freeze(answer);
  }
  return Object.freeze({ answers: Object.freeze(cloned.answers), otherText: Object.freeze(cloned.otherText), currentIndex: cloned.currentIndex, minimized: cloned.minimized });
}

function cloneDraft(draft: QuestionWizardDraft): QuestionWizardDraft { return { answers: Object.fromEntries(Object.entries(draft.answers).map(([id, answer]) => [id, cloneAnswer(answer)])), otherText: Object.fromEntries(Object.entries(draft.otherText)), currentIndex: draft.currentIndex, minimized: draft.minimized }; }
function cloneAnswer(answer: QuestionAnswerDraft): QuestionAnswerDraft {
  if (answer.kind === "multiple") return { ...answer, choiceIds: [...answer.choiceIds] };
  if (answer.kind === "single") return { kind: "single", selection: { ...answer.selection } };
  return { ...answer };
}
function draftsEqual(left: QuestionWizardDraft, right: QuestionWizardDraft): boolean {
  if (left.currentIndex !== right.currentIndex || left.minimized !== right.minimized) return false;
  const leftAnswerIds = Object.keys(left.answers);
  const rightAnswerIds = Object.keys(right.answers);
  if (leftAnswerIds.length !== rightAnswerIds.length || leftAnswerIds.some((id) => !Object.hasOwn(right.answers, id) || !answersEqual(left.answers[id]!, right.answers[id]!))) return false;
  const leftOtherIds = Object.keys(left.otherText);
  const rightOtherIds = Object.keys(right.otherText);
  return leftOtherIds.length === rightOtherIds.length && leftOtherIds.every((id) => Object.hasOwn(right.otherText, id) && left.otherText[id] === right.otherText[id]);
}
function answersEqual(left: QuestionAnswerDraft, right: QuestionAnswerDraft): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "text" && right.kind === "text") return left.value === right.value;
  if (left.kind === "boolean" && right.kind === "boolean") return left.value === right.value;
  if (left.kind === "single" && right.kind === "single") return left.selection.kind === right.selection.kind
    && (left.selection.kind === "choice" && right.selection.kind === "choice" ? left.selection.choiceId === right.selection.choiceId
      : left.selection.kind === "other" && right.selection.kind === "other" && left.selection.text === right.selection.text);
  return left.kind === "multiple" && right.kind === "multiple" && left.otherText === right.otherText
    && left.choiceIds.length === right.choiceIds.length && left.choiceIds.every((id, index) => id === right.choiceIds[index]);
}
function validRevision(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function nonBlankString(value: unknown): value is string { return typeof value === "string" && value.trim() !== ""; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export const questionWizardDraftCodec: InteractionDraftCodec<QuestionWizardDraft> = Object.freeze({
  parse: parseDraft,
  clone: cloneDraft,
  freeze: freezeDraft,
  equal: draftsEqual
});
