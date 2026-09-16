import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import {
  CapabilitySupport, ConnectionState, CreateSessionMutationSchema, DeviceKind, EntityKind, EntityRefSchema,
  InputContentSchema, InputPartSchema, NativeSessionPlacement, NativeSessionStartSchema, NewNativeSessionSchema,
  OperationPreconditionSchema, OperationState, OperationMutationSchema, PermissionMode, QueueDeliveryMode,
  SendInputMutationSchema, TargetState, capabilityNames,
  type Event, type EventCursor, type Operation, type OperationMutation, type Session, type Snapshot
} from "@joko/contracts";
import { normalizeNodeOrigin, type MobileNetwork, type NodeIdentity, type PairedCredential } from "./network";

export interface PendingOperation {
  readonly operationId: string;
  readonly connectionId: string;
  readonly kind: "create" | "send";
  readonly sessionId?: string;
  readonly state: "unknown" | "accepted";
}

export interface MobileStorage {
  loadCredential(): Promise<PairedCredential | undefined>;
  saveCredential(credential: PairedCredential): Promise<void>;
  clearCredential(): Promise<void>;
  loadAutomaticEntry(): Promise<boolean>;
  saveAutomaticEntry(enabled: boolean): Promise<void>;
  loadPending(): Promise<PendingOperation[]>;
  savePending(items: readonly PendingOperation[]): Promise<void>;
  loadSelection(): Promise<string | undefined>;
  saveSelection(id?: string): Promise<void>;
}

export interface SavedMobileConnection {
  readonly origin: string;
  readonly serverId: string;
  readonly connectionId: string;
  readonly displayName: string;
  readonly automatic: boolean;
}

export interface MobileState {
  readonly status: "starting" | "unpaired" | "connecting" | "connected" | "offline" | "revoked";
  readonly busy: boolean;
  readonly node?: NodeIdentity;
  readonly origin?: string;
  readonly saved?: SavedMobileConnection;
  readonly challenge?: { readonly id: string; readonly origin: string; readonly deviceName: string };
  readonly owner?: Snapshot;
  readonly selectedId?: string;
  readonly detail?: Snapshot;
  readonly older: readonly Event[];
  readonly window?: readonly Event[];
  readonly live: readonly Event[];
  readonly liveStatus: "paused" | "verifying" | "streaming" | "polling";
  readonly historyBusy: boolean;
  readonly historyEnd: boolean;
  readonly before?: EventCursor;
  readonly pending: readonly PendingOperation[];
  readonly error?: string;
}

const isTerminal = (state: OperationState): boolean => [
  OperationState.SUCCEEDED, OperationState.FAILED, OperationState.CANCELLED, OperationState.CONFLICT
].includes(state);

export class MobileClient {
  #state: MobileState = { status: "starting", busy: false, older: [], live: [], liveStatus: "paused",
    historyBusy: false, historyEnd: false, pending: [] };
  #credential?: PairedCredential;
  #savedCredential?: PairedCredential;
  #listeners = new Set<(state: MobileState) => void>();
  #epoch = 0;
  #abort?: AbortController;
  #timer?: ReturnType<typeof setTimeout>;
  #proofTimer?: ReturnType<typeof setTimeout>;
  #projectionTimer?: ReturnType<typeof setTimeout>;
  #streamAbort?: AbortController;
  #historyOwner?: symbol;
  #projectionReading = false;
  #projectionMisses = 0;
  #streamSequence?: bigint;
  #streamGeneration?: bigint;
  #foreground = true;
  #disposed = false;
  #mutationOwner?: symbol;
  #pendingWrite: Promise<void> = Promise.resolve();

  constructor(
    private readonly network: MobileNetwork,
    private readonly storage: MobileStorage,
    private readonly newId: () => string,
    private readonly platform: string
  ) {}

  get state(): MobileState { return this.#state; }

  subscribe(listener: (state: MobileState) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => this.#listeners.delete(listener);
  }

  #set(patch: Partial<MobileState>): void {
    if (this.#disposed) return;
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener(this.#state);
  }

  #retire(): number {
    this.#abort?.abort();
    this.#streamAbort?.abort();
    this.#streamAbort = undefined;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    if (this.#proofTimer !== undefined) clearTimeout(this.#proofTimer);
    if (this.#projectionTimer !== undefined) clearTimeout(this.#projectionTimer);
    this.#timer = undefined;
    this.#proofTimer = undefined;
    this.#projectionTimer = undefined;
    this.#historyOwner = undefined;
    this.#projectionReading = false;
    this.#projectionMisses = 0;
    this.#streamSequence = undefined;
    this.#streamGeneration = undefined;
    this.#abort = new AbortController();
    return ++this.#epoch;
  }

  #current(epoch: number): boolean { return !this.#disposed && this.#foreground && this.#epoch === epoch; }

  async start(): Promise<void> {
    const epoch = this.#retire();
    try {
      const [credential, automatic, pending, selection] = await Promise.all([
        this.storage.loadCredential(), this.storage.loadAutomaticEntry(), this.storage.loadPending(), this.storage.loadSelection()
      ]);
      if (!this.#current(epoch)) return;
      this.#savedCredential = credential;
      this.#credential = credential && automatic ? credential : undefined;
      const ownedPending = credential ? pending.filter((item) => item.connectionId === credential.connectionId) : [];
      if (ownedPending.length !== pending.length) await this.#persistPending(ownedPending, epoch);
      if (!this.#current(epoch)) return;
      if (!credential && automatic) await this.storage.saveAutomaticEntry(false);
      if (!this.#current(epoch)) return;
      this.#set({
        pending: ownedPending,
        selectedId: credential ? selection : undefined,
        origin: credential?.origin,
        saved: credential ? savedConnection(credential, automatic) : undefined,
        status: credential && automatic ? "connecting" : "unpaired"
      });
      if (credential && automatic) await this.refresh();
    } catch (error) {
      if (this.#current(epoch)) this.#set({ status: "unpaired", error: message(error) });
    }
  }

  async inspect(rawOrigin: string): Promise<NodeIdentity> {
    const epoch = this.#retire();
    const origin = normalizeNodeOrigin(rawOrigin);
    this.#set({ busy: true, error: undefined });
    try {
      const node = await this.network.inspect(origin, this.#abort?.signal);
      if (this.#current(epoch)) this.#set({ node, origin, busy: false, challenge: undefined });
      return node;
    } catch (error) {
      if (this.#current(epoch)) this.#set({ busy: false, error: message(error) });
      throw error;
    }
  }

  async requestPairing(rawOrigin: string, deviceName: string): Promise<string> {
    if (!deviceName.trim()) throw new Error("Enter a device name.");
    const origin = normalizeNodeOrigin(rawOrigin);
    const epoch = this.#retire();
    this.#set({ busy: true, error: undefined, challenge: undefined });
    try {
      const request = await this.network.requestPairing(origin, deviceName, this.platform, this.#abort?.signal);
      if (!this.#current(epoch)) return "";
      if (this.#state.node && (this.#state.origin !== origin || this.#state.node.serverId !== request.identity.serverId)) {
        throw new Error("The Joko node identity changed. Inspect it again.");
      }
      this.#set({ node: request.identity, origin, challenge: { id: request.challengeId, origin, deviceName }, busy: false });
      return request.challengeId;
    } catch (error) {
      if (this.#current(epoch)) this.#set({ busy: false, error: message(error) });
      throw error;
    }
  }

  async pair(rawOrigin: string, code: string, deviceName: string, automatic = false): Promise<void> {
    if (!code.trim() || !deviceName.trim()) throw new Error("Enter a pairing code and device name.");
    const origin = normalizeNodeOrigin(rawOrigin);
    const challenge = this.#state.challenge;
    if (!challenge || challenge.origin !== origin || challenge.deviceName !== deviceName) {
      throw new Error("Request pairing for this node and device before entering its code.");
    }
    const epoch = this.#retire();
    this.#set({ busy: true, error: undefined });
    try {
      const result = await this.network.completePairing(origin, challenge.id, code, deviceName, this.platform, this.#abort?.signal);
      if (!this.#current(epoch)) return;
      if (this.#state.node && (this.#state.origin !== origin || this.#state.node.serverId !== result.identity.serverId)) {
        throw new Error("The Joko node identity changed during pairing. Inspect it again.");
      }
      // Prove the credential's identity and device before making it durable.
      const observed = await this.network.inspect(origin, this.#abort?.signal);
      if (!this.#current(epoch)) return;
      if (observed.serverId !== result.credential.serverId) throw new Error("The Joko node identity changed during pairing.");
      const owner = await this.network.readOwner(result.credential, this.#abort?.signal);
      this.#assertOwner(result.credential, owner, observed);
      if (!this.#current(epoch)) return;
      // Disable the previous target before replacing its credential. A crash or
      // preference write failure therefore always falls back to the connection surface.
      await this.storage.saveAutomaticEntry(false);
      await this.storage.saveCredential(result.credential);
      if (!this.#current(epoch)) {
        await this.storage.clearCredential();
        return;
      }
      let preferenceError: string | undefined;
      if (automatic) {
        try { await this.storage.saveAutomaticEntry(true); }
        catch (error) { preferenceError = `Paired, but automatic entry could not be saved: ${message(error)}`; }
      }
      if (!this.#current(epoch)) {
        await this.storage.clearCredential();
        await this.storage.saveAutomaticEntry(false);
        return;
      }
      this.#credential = result.credential;
      this.#savedCredential = result.credential;
      await this.#persistPending([], epoch);
      this.#set({ status: "connected", busy: false, node: observed, origin, owner: owner.snapshot, pending: [],
        saved: savedConnection(result.credential, automatic && preferenceError === undefined),
        challenge: undefined, error: preferenceError });
      this.#beginStream(epoch, result.credential, owner.snapshot);
      this.#schedule();
    } catch (error) {
      if (this.#current(epoch)) this.#set({ busy: false, error: message(error) });
      throw error;
    }
  }

  cancel(): void { this.#retire(); this.#set({ busy: false, challenge: undefined }); }

  async connectSaved(automatic = false): Promise<void> {
    const credential = this.#savedCredential;
    if (!credential) throw new Error("No saved Joko node is available on this device.");
    this.#credential = credential;
    await this.refresh();
    if (this.#state.status !== "connected") throw new Error(this.#state.error || "The saved Joko node is unavailable.");
    try {
      await this.storage.saveAutomaticEntry(automatic);
      this.#set({ saved: savedConnection(credential, automatic) });
    } catch (error) {
      const detail = `Connected, but the automatic-entry preference could not be saved: ${message(error)}`;
      this.#set({ error: detail, saved: savedConnection(credential, false) });
      throw new Error(detail);
    }
  }

  async disableAutomaticEntry(): Promise<void> {
    await this.storage.saveAutomaticEntry(false);
    if (this.#savedCredential) this.#set({ saved: savedConnection(this.#savedCredential, false) });
  }

  setForeground(active: boolean): void {
    if (this.#foreground === active) return;
    this.#foreground = active;
    this.#retire();
    if (!active) {
      this.#mutationOwner = undefined;
      this.#set({ busy: false, liveStatus: "paused", live: [], historyBusy: false,
        older: [], window: undefined, before: undefined, historyEnd: false });
    }
    if (active && this.#state.status === "starting") void this.start();
    else if (active && this.#credential) void this.refresh();
  }

  async refresh(): Promise<void> {
    const credential = this.#credential;
    if (!credential || !this.#foreground) return;
    const epoch = this.#retire();
    this.#set({ status: "connecting", error: undefined });
    try {
      // This request MUST be anonymous and precede every credentialed reconnect.
      const node = await this.network.inspect(credential.origin, this.#abort?.signal);
      if (!this.#current(epoch)) return;
      if (node.serverId !== credential.serverId) {
        await this.#revoke(epoch, "The saved Joko node identity changed. Pair again with this node.");
        return;
      }
      const owner = await this.network.readOwner(credential, this.#abort?.signal);
      if (!this.#current(epoch)) return;
      this.#assertOwner(credential, owner, node);
      const selectedId = this.#state.selectedId;
      const selected = selectedId !== undefined && owner.snapshot.sessions.some((session) => session.sessionId === selectedId)
        ? selectedId : undefined;
      const detail = selected ? await this.network.readSession(credential, selected, this.#abort?.signal) : undefined;
      if (!this.#current(epoch)) return;
      if (selected !== selectedId) await this.storage.saveSelection(selected);
      if (!this.#current(epoch)) return;
      const sameWindow = selected === selectedId && this.#state.owner?.generation === owner.snapshot.generation;
      this.#set({ node, origin: credential.origin, owner: owner.snapshot, detail, selectedId: selected,
        older: sameWindow ? this.#state.older : [], window: sameWindow ? this.#state.window : undefined,
        before: sameWindow ? this.#state.before : undefined, historyEnd: sameWindow ? this.#state.historyEnd : false,
        historyBusy: false, live: [], status: "connected", error: undefined });
      this.#beginStream(epoch, credential, owner.snapshot);
      await this.reconcile(epoch);
      if (this.#current(epoch)) this.#schedule();
    } catch (error) {
      if (!this.#current(epoch)) return;
      if (isRevoked(error)) await this.#revoke(epoch, "This mobile connection was revoked. Pair again.");
      else {
        this.#set({ status: "offline", liveStatus: "paused", live: [], error: message(error), owner: undefined, detail: undefined });
        this.#schedule();
      }
    }
  }

  #assertOwner(credential: PairedCredential, owner: Awaited<ReturnType<MobileNetwork["readOwner"]>>, node: NodeIdentity): void {
    if (owner.snapshot.server?.serverId !== node.serverId || owner.connection.connectionId !== credential.connectionId
      || owner.connection.deviceId !== credential.deviceId || owner.connection.state !== ConnectionState.CONNECTED
      || owner.device.deviceId !== credential.deviceId || owner.device.kind !== DeviceKind.MOBILE || owner.device.revoked) {
      throw new RevokedError();
    }
  }

  async #revoke(epoch: number, error: string): Promise<void> {
    if (!this.#current(epoch)) return;
    this.#retire();
    this.#credential = undefined;
    this.#savedCredential = undefined;
    await this.storage.clearCredential();
    await this.storage.saveAutomaticEntry(false);
    await this.#persistPending([], this.#epoch);
    await this.storage.saveSelection();
    this.#set({ status: "revoked", busy: false, node: undefined, saved: undefined, challenge: undefined, owner: undefined, detail: undefined,
      selectedId: undefined, older: [], window: undefined, live: [], liveStatus: "paused",
      historyBusy: false, historyEnd: false, before: undefined, pending: [], error });
  }

  #schedule(): void {
    if (!this.#foreground || this.#disposed || !this.#credential) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      if (this.#state.busy) this.#schedule();
      else void this.refresh();
    }, this.#state.liveStatus === "polling" || this.#state.status === "offline" ? 4_000 : 30_000);
  }

  #beginStream(epoch: number, credential: PairedCredential, snapshot: Snapshot): void {
    const cursor = snapshot.resumeCursor;
    if (!this.#current(epoch) || !cursor?.opaqueToken || cursor.generation !== snapshot.generation) {
      this.#set({ liveStatus: "polling" });
      return;
    }
    const controller = new AbortController();
    this.#streamAbort = controller;
    this.#streamGeneration = cursor.generation;
    this.#streamSequence = cursor.sequence;
    this.#set({ liveStatus: "verifying" });
    // An idle stream cannot demonstrate incremental delivery on every native fetch.
    // Until an event arrives, keep a bounded snapshot-polling fallback instead.
    this.#proofTimer = setTimeout(() => {
      if (!this.#current(epoch) || this.#streamAbort !== controller || this.#state.liveStatus !== "verifying") return;
      controller.abort();
      this.#streamAbort = undefined;
      this.#set({ liveStatus: "polling" });
      this.#schedule();
    }, 8_000);
    void this.#consumeStream(epoch, credential, cursor, controller);
  }

  async #consumeStream(epoch: number, credential: PairedCredential, after: EventCursor, controller: AbortController): Promise<void> {
    try {
      for await (const event of this.network.streamOwner(credential, after, controller.signal)) {
        if (!this.#current(epoch) || this.#streamAbort !== controller || controller.signal.aborted) return;
        const cursor = event.cursor;
        if (!event.eventId || !cursor || !cursor.opaqueToken || cursor.generation !== this.#streamGeneration
          || cursor.sequence > (this.#streamSequence ?? 0n) + 1n
          || event.payload?.kind.case === "projectionInvalidated") {
          this.#clearHistory();
          void this.refresh();
          return;
        }
        if (cursor.sequence <= (this.#streamSequence ?? 0n)) continue;
        this.#streamSequence = cursor.sequence;
        if (event.identity?.sessionId === this.#state.selectedId && historyInvalidated(event)) this.#clearHistory();
        if (this.#proofTimer !== undefined) clearTimeout(this.#proofTimer);
        this.#proofTimer = undefined;
        this.#set({ liveStatus: "streaming" });
        if (event.identity?.sessionId && event.identity.sessionId === this.#state.selectedId && !this.#state.window) {
          this.#set({ live: [...this.#state.live.filter((item) => item.eventId !== event.eventId), event].slice(-160) });
        }
        this.#scheduleProjection(epoch, credential);
      }
      if (this.#current(epoch) && this.#streamAbort === controller) this.#fallbackStream();
    } catch (error) {
      if (!this.#current(epoch) || this.#streamAbort !== controller || controller.signal.aborted) return;
      if (isRevoked(error)) await this.#revoke(epoch, "This mobile connection was revoked. Pair again.");
      else if ((error as { code?: number })?.code === Code.FailedPrecondition) void this.refresh();
      else this.#fallbackStream();
    }
  }

  #fallbackStream(): void {
    this.#streamAbort?.abort();
    this.#streamAbort = undefined;
    if (this.#proofTimer !== undefined) clearTimeout(this.#proofTimer);
    this.#proofTimer = undefined;
    this.#set({ liveStatus: "polling" });
    this.#schedule();
  }

  #scheduleProjection(epoch: number, credential: PairedCredential): void {
    if (this.#projectionTimer !== undefined) clearTimeout(this.#projectionTimer);
    this.#projectionTimer = setTimeout(() => {
      this.#projectionTimer = undefined;
      if (this.#current(epoch) && !this.#projectionReading) void this.#syncProjection(epoch, credential);
    }, 180);
  }

  async #syncProjection(epoch: number, credential: PairedCredential): Promise<void> {
    this.#projectionReading = true;
    const selectedId = this.#state.selectedId;
    const edge = this.#streamSequence ?? 0n;
    try {
      const [owner, detail] = await Promise.all([
        this.network.readOwner(credential, this.#abort?.signal),
        selectedId ? this.network.readSession(credential, selectedId, this.#abort?.signal) : Promise.resolve(undefined)
      ]);
      if (!this.#current(epoch) || credential !== this.#credential || selectedId !== this.#state.selectedId) return;
      this.#assertOwner(credential, owner, this.#state.node!);
      if (owner.snapshot.generation !== this.#streamGeneration || detail && detail.generation !== this.#streamGeneration
        || selectedId && !owner.snapshot.sessions.some((item) => item.sessionId === selectedId)) {
        void this.refresh();
        return;
      }
      if (!owner.snapshot.resumeCursor || owner.snapshot.resumeCursor.generation !== this.#streamGeneration
        || owner.snapshot.resumeCursor.sequence < edge
        || detail && (!detail.resumeCursor || detail.resumeCursor.generation !== this.#streamGeneration
          || detail.resumeCursor.sequence < edge)) {
        if (++this.#projectionMisses >= 2) void this.refresh();
        else this.#scheduleProjection(epoch, credential);
        return;
      }
      this.#projectionMisses = 0;
      const durable = detail?.resumeCursor?.sequence ?? owner.snapshot.resumeCursor.sequence;
      this.#set({ owner: owner.snapshot, detail,
        live: this.#state.live.filter((item) => item.cursor && item.cursor.sequence > durable) });
      if ((this.#streamSequence ?? 0n) > durable) this.#scheduleProjection(epoch, credential);
    } catch (error) {
      if (!this.#current(epoch)) return;
      if (isRevoked(error)) await this.#revoke(epoch, "This mobile connection was revoked. Pair again.");
      else void this.refresh();
    } finally {
      if (this.#current(epoch)) this.#projectionReading = false;
    }
  }

  async #persistPending(items: readonly PendingOperation[], epoch: number): Promise<boolean> {
    const write = this.#pendingWrite.then(async () => {
      if (!this.#current(epoch)) return false;
      await this.storage.savePending(items);
      return this.#current(epoch);
    });
    this.#pendingWrite = write.then(() => undefined, () => undefined);
    return write;
  }

  async select(sessionId?: string): Promise<void> {
    if (sessionId !== undefined && !this.#state.owner?.sessions.some((session) => session.sessionId === sessionId)) {
      throw new Error("Select a task from the current Joko node.");
    }
    const epoch = this.#retire();
    await this.storage.saveSelection(sessionId);
    if (!this.#current(epoch)) return;
    this.#set({ selectedId: sessionId, detail: undefined, older: [], window: undefined, live: [],
      historyBusy: false, historyEnd: false, before: undefined, error: undefined });
    await this.refresh();
  }

  async older(): Promise<void> {
    const credential = this.#credential;
    const sessionId = this.#state.selectedId;
    if (!credential || !sessionId || this.#state.status !== "connected" || this.#state.historyEnd || this.#historyOwner) return;
    const epoch = this.#epoch;
    const owner = Symbol("history page");
    this.#historyOwner = owner;
    this.#set({ historyBusy: true });
    try {
      const before = this.#state.before;
      const page = await this.network.readHistory(credential, sessionId, before, this.#abort?.signal);
      if (!this.#current(epoch) || sessionId !== this.#state.selectedId || this.#historyOwner !== owner) return;
      validateHistory(page.events, sessionId, this.#state.owner?.generation, before);
      if (page.before && (page.events.length === 0 || !page.before.opaqueToken || page.before.generation !== this.#state.owner?.generation
        || (before && page.before.sequence >= before.sequence) || page.before.sequence > page.events[0]!.cursor!.sequence)) {
        throw new Error("The task history returned a cyclic or mismatched page cursor.");
      }
      const known = new Set(this.#state.older.map((item) => item.eventId));
      const older = [...page.events.filter((item) => !known.has(item.eventId)), ...this.#state.older];
      const window = this.#state.window ? [...older, ...this.#state.window] : undefined;
      this.#set({ older: window ? [] : older, window, before: page.before, historyEnd: !page.before });
    } catch (error) {
      if (this.#current(epoch) && isStaleHistory(error)) void this.refresh();
      throw error;
    } finally {
      if (this.#historyOwner === owner) { this.#historyOwner = undefined; this.#set({ historyBusy: false }); }
    }
  }

  async around(eventId: string): Promise<void> {
    const credential = this.#ready();
    const sessionId = this.#state.selectedId;
    if (!sessionId || this.#historyOwner) return;
    const epoch = this.#epoch;
    const owner = Symbol("history anchor");
    this.#historyOwner = owner;
    this.#set({ historyBusy: true });
    try {
      const events = await this.network.readAround(credential, sessionId, eventId, this.#abort?.signal);
      if (!this.#current(epoch) || sessionId !== this.#state.selectedId || this.#historyOwner !== owner) return;
      validateHistory(events, sessionId, this.#state.owner?.generation);
      if (!events.some((event) => event.eventId === eventId)) throw new Error("The selected event is no longer in task history.");
      this.#set({ window: events, older: [], before: events[0]!.cursor, historyEnd: false });
    } catch (error) {
      if (this.#current(epoch) && isStaleHistory(error)) void this.refresh();
      throw error;
    } finally {
      if (this.#historyOwner === owner) { this.#historyOwner = undefined; this.#set({ historyBusy: false }); }
    }
  }

  latest(): void { this.#clearHistory(); }

  #clearHistory(): void {
    this.#historyOwner = undefined;
    this.#set({ window: undefined, older: [], before: undefined, historyEnd: false, historyBusy: false });
  }

  async create(targetId: string, name: string): Promise<void> {
    if (this.#state.pending.some((item) => item.kind === "create")) {
      throw new Error("A previous task creation is still pending. Check its operation before creating another task.");
    }
    const owner = this.#state.owner;
    const target = owner?.targets.find((candidate) => candidate.targetId === targetId);
    const backend = owner?.backends.find((candidate) => candidate.backendId === target?.backendId);
    if (!target || !backend || target.state !== TargetState.ACTIVE || !supportsText(backend)) {
      throw new Error("Select an active target with text input support.");
    }
    const credential = this.#ready();
    const action = this.#claimMutation();
    try {
      const epoch = this.#epoch;
      await this.network.prepareTarget(credential, target, this.#abort?.signal);
      if (!this.#current(epoch)) return;
      await this.#submit(create(OperationMutationSchema, {
        preconditions: [create(OperationPreconditionSchema, {
          entity: create(EntityRefSchema, { kind: EntityKind.TARGET, id: targetId }),
          expectedRevision: target.version?.revision
        })],
        payload: { case: "createSession", value: create(CreateSessionMutationSchema, {
          backendId: target.backendId, targetId, displayName: name.trim() || "New task",
          nativeStart: create(NativeSessionStartSchema, {
            kind: { case: "newSession", value: create(NewNativeSessionSchema, { parentNativeReference: "" }) }
          }),
          permissionMode: PermissionMode.ASK, initialPlacement: NativeSessionPlacement.PROJECT
        }) }
      }), { kind: "create" });
    } finally { this.#releaseMutation(action); }
  }

  async send(text: string): Promise<boolean> {
    const value = text.trim();
    const sessionId = this.#state.selectedId;
    const session = this.#state.detail?.sessions.find((item) => item.sessionId === sessionId);
    const backend = this.#state.owner?.backends.find((item) => item.backendId === session?.backendId);
    const generation = session?.nativeBinding?.runtimeGeneration;
    if (!value || !sessionId || !session || !backend || !supportsText(backend) || !generation || generation < 1n) {
      throw new Error("A current task generation and non-empty text are required.");
    }
    if (this.#state.pending.some((item) => item.kind === "send" && item.sessionId === sessionId && item.state === "unknown")) {
      throw new Error("The previous input has an unknown result. Check its operation before sending another message.");
    }
    this.#ready();
    const action = this.#claimMutation();
    try {
      return await this.#submit(create(OperationMutationSchema, {
      preconditions: [create(OperationPreconditionSchema, {
        entity: create(EntityRefSchema, { kind: EntityKind.SESSION, id: sessionId }), expectedGeneration: generation
      })],
      payload: { case: "sendInput", value: create(SendInputMutationSchema, { sessionId,
        input: create(InputContentSchema, { parts: [create(InputPartSchema, { content: { case: "text", value } })] }),
        deliveryMode: QueueDeliveryMode.PROMPT
      }) }
      }), { kind: "send", sessionId });
    } finally { this.#releaseMutation(action); }
  }

  #claimMutation(): symbol {
    if (this.#mutationOwner) throw new Error("Another task operation is already being submitted.");
    const action = Symbol("mobile mutation");
    this.#mutationOwner = action;
    this.#set({ busy: true });
    return action;
  }

  #releaseMutation(action: symbol): void {
    if (this.#mutationOwner !== action) return;
    this.#mutationOwner = undefined;
    this.#set({ busy: false });
  }

  #ready(): PairedCredential {
    if (this.#state.status !== "connected" || !this.#credential || !this.#foreground) {
      throw new Error("Reconnect to the Joko node before making a change.");
    }
    return this.#credential;
  }

  async #submit(mutation: OperationMutation, identity: Pick<PendingOperation, "kind" | "sessionId">): Promise<boolean> {
    const credential = this.#ready();
    const epoch = this.#epoch;
    const pending: PendingOperation = { ...identity, connectionId: credential.connectionId, operationId: this.newId(), state: "unknown" };
    const before = this.#state.pending;
    const next = [...before, pending];
    this.#set({ pending: next, busy: true, error: undefined });
    try {
      if (!await this.#persistPending(next, epoch)) return false;
    } catch (error) {
      if (this.#current(epoch)) this.#set({ pending: before, busy: false });
      throw error;
    }
    let operation: Operation;
    try {
      operation = await this.network.submit(credential, pending.operationId, mutation, this.#abort?.signal);
    } catch (error) {
      if (this.#current(epoch)) this.#set({ busy: false, error: `Operation ${pending.operationId}: ${message(error)}. Check status; it was not resent.` });
      return false;
    }
    if (!this.#current(epoch)) return false;
    await this.#receipt(operation, pending, epoch);
    this.#set({ busy: false });
    const accepted = operation.state !== OperationState.FAILED && operation.state !== OperationState.CONFLICT && operation.state !== OperationState.CANCELLED;
    await this.refresh();
    return accepted;
  }

  async #receipt(operation: Operation, pending: PendingOperation, epoch: number): Promise<void> {
    if (!this.#current(epoch) || this.#credential?.connectionId !== pending.connectionId) return;
    if (operation.state === OperationState.FAILED || operation.state === OperationState.CONFLICT || operation.state === OperationState.CANCELLED) {
      const next = this.#state.pending.filter((item) => item.operationId !== pending.operationId);
      if (await this.#persistPending(next, epoch)) this.#set({ pending: next, error: operation.error?.message || "The operation was rejected." });
      return;
    }
    if (pending.kind === "create" && operation.result?.payload.case === "session") {
      const sessionId = operation.result.payload.value.sessionId;
      if (sessionId) {
        await this.storage.saveSelection(sessionId);
        if (!this.#current(epoch)) return;
        this.#set({ selectedId: sessionId });
      }
    }
    const next = isTerminal(operation.state)
      ? this.#state.pending.filter((item) => item.operationId !== pending.operationId)
      : this.#state.pending.map((item) => item.operationId === pending.operationId ? { ...item, state: "accepted" as const } : item);
    if (await this.#persistPending(next, epoch)) this.#set({ pending: next });
  }

  async reconcile(epoch = this.#epoch): Promise<void> {
    const credential = this.#credential;
    if (!credential || !this.#current(epoch)) return;
    for (const pending of this.#state.pending) {
      if (pending.connectionId !== credential.connectionId) continue;
      try {
        const operation = await this.network.getOperation(credential, pending.operationId, this.#abort?.signal);
        if (!this.#current(epoch)) return;
        if (operation) await this.#receipt(operation, pending, epoch);
        else this.#set({ error: `Operation ${pending.operationId} is not yet confirmed. No input will be resent automatically.` });
      } catch (error) {
        if (!this.#current(epoch)) return;
        if (isRevoked(error)) { await this.#revoke(epoch, "This mobile connection was revoked. Pair again."); return; }
        this.#set({ error: `Could not confirm operation ${pending.operationId}: ${message(error)}` });
      }
    }
  }

  async dismissUnconfirmed(operationId: string): Promise<void> {
    const credential = this.#ready();
    const pending = this.#state.pending.find((item) => item.operationId === operationId && item.connectionId === credential.connectionId);
    if (!pending || pending.state !== "unknown") throw new Error("Only an unconfirmed operation can be cleared.");
    const epoch = this.#epoch;
    const operation = await this.network.getOperation(credential, operationId, this.#abort?.signal);
    if (!this.#current(epoch)) return;
    if (operation) {
      await this.#receipt(operation, pending, epoch);
      throw new Error("The Joko node has this operation; its durable result was refreshed instead of discarding it.");
    }
    const next = this.#state.pending.filter((item) => item.operationId !== operationId);
    if (await this.#persistPending(next, epoch)) this.#set({ pending: next, error: undefined });
  }

  dispose(): void { this.#disposed = true; this.#retire(); this.#listeners.clear(); }
}

function supportsText(backend: Snapshot["backends"][number]): boolean {
  return backend.capabilities?.capabilities.some((item) => item.name === capabilityNames.inputText && item.support === CapabilitySupport.SUPPORTED) === true;
}

function savedConnection(credential: PairedCredential, automatic: boolean): SavedMobileConnection {
  return {
    origin: credential.origin,
    serverId: credential.serverId,
    connectionId: credential.connectionId,
    displayName: credential.displayName,
    automatic
  };
}

class RevokedError extends Error {}
function isRevoked(error: unknown): boolean {
  if (error instanceof RevokedError) return true;
  const candidate = error as { code?: number };
  return candidate?.code === Code.Unauthenticated;
}
function message(error: unknown): string { return error instanceof Error ? error.message : "The Joko node is unavailable."; }

function isStaleHistory(error: unknown): boolean {
  return (error as { code?: number })?.code === Code.FailedPrecondition
    || error instanceof Error && /task history returned|task history changed/.test(error.message);
}

function validateHistory(events: readonly Event[], sessionId: string, generation?: bigint, before?: EventCursor): void {
  if (!generation) throw new Error("The task history changed while loading. Reconnect before browsing it.");
  let last = 0n;
  const ids = new Set<string>();
  for (const event of events) {
    const cursor = event.cursor;
    if (!event.eventId || ids.has(event.eventId) || event.identity?.sessionId !== sessionId
      || !cursor?.opaqueToken || cursor.generation !== generation || cursor.sequence <= last
      || before && cursor.sequence >= before.sequence) {
      throw new Error("The task history returned a mismatched or cyclic page. Reconnect before browsing it.");
    }
    ids.add(event.eventId);
    last = cursor.sequence;
  }
}

function historyInvalidated(event: Event): boolean {
  switch (event.payload?.kind.case) {
    case "messageDeleted":
    case "sessionReset":
    case "historyPruned": return true;
    case "nativeBranchChanged": return event.payload.kind.value.timelineRebuilt;
    default: return false;
  }
}
