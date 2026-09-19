import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import {
  CapabilitySupport, ConnectionState, CreateSessionMutationSchema, DeviceKind, EntityKind, EntityRefSchema,
  LAN_DISCOVERY_PEER_TTL_MS,
  InputContentSchema, InputPartSchema, NativeSessionPlacement, NativeSessionStartSchema, NewNativeSessionSchema,
  LogoutConnectionMutationSchema, OperationPreconditionSchema, OperationState, OperationMutationSchema,
  PermissionMode, QueueDeliveryMode, RevokeDeviceMutationSchema, SendInputMutationSchema, TargetState, capabilityNames,
  type DiscoveredNodeRecord, type Event, type EventCursor, type Operation, type OperationMutation, type Session, type Snapshot
} from "@joko/contracts";
import {
  MobileCredentialStorageError, profileFromCredential,
  type MobileConnectionProfile, type MobileStorage, type PendingOperation
} from "./connection-storage";
import type { MobileDiscovery } from "./connection-discovery";
import { normalizeNodeOrigin, type MobileNetwork, type NodeIdentity, type PairedCredential } from "./network";

export type { MobileStorage, PendingOperation } from "./connection-storage";

export type SavedCredentialState = "unknown" | "checking" | "available" | "missing" | "unreadable" | "unavailable" | "identity-conflict" | "offline";

export interface SavedMobileConnection extends MobileConnectionProfile {
  readonly automatic: boolean;
  readonly credentialState: SavedCredentialState;
  readonly pendingOperations: readonly PendingOperation[];
  readonly error?: string;
}

export interface NearbyMobileNode extends DiscoveredNodeRecord {
  readonly health: number;
}

export interface MobileState {
  readonly status: "starting" | "unpaired" | "connecting" | "connected" | "offline" | "revoked";
  readonly busy: boolean;
  readonly node?: NodeIdentity;
  readonly origin?: string;
  readonly saved: readonly SavedMobileConnection[];
  readonly automaticProfileId?: string;
  readonly activeProfileId?: string;
  readonly connectionMode: "nearby" | "saved" | "add";
  readonly candidate?: { readonly origin: string; readonly node: NodeIdentity };
  readonly connectionAttemptError?: string;
  readonly discoveryState: "idle" | "refreshing" | "ready" | "error";
  readonly nearby: readonly NearbyMobileNode[];
  readonly discoveryError?: string;
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
  #state: MobileState = { status: "starting", busy: false, saved: [], connectionMode: "nearby",
    discoveryState: "idle", nearby: [], older: [], live: [], liveStatus: "paused",
    historyBusy: false, historyEnd: false, pending: [] };
  #credential?: PairedCredential;
  #profiles: MobileConnectionProfile[] = [];
  #automaticProfileId?: string;
  #activeProfileId?: string;
  #allPending: PendingOperation[] = [];
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
  #catalogEpoch = 0;
  #catalogAbort?: AbortController;
  #connectionAttemptEpoch = 0;
  #connectionAttemptAbort?: AbortController;
  #discoveryExpiryTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly network: MobileNetwork,
    private readonly storage: MobileStorage,
    private readonly discovery: MobileDiscovery,
    private readonly newId: () => string,
    private readonly platform: string,
    private readonly now: () => number = Date.now
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

  #beginConnectionAttempt(): { readonly generation: number; readonly controller: AbortController } {
    if (this.#mutationOwner) throw new Error("Finish the current task operation before changing Joko nodes.");
    this.#cancelCatalogAttempt();
    this.#connectionAttemptAbort?.abort();
    const controller = new AbortController();
    this.#connectionAttemptAbort = controller;
    const generation = ++this.#connectionAttemptEpoch;
    this.#set({ busy: true, connectionAttemptError: undefined });
    return { generation, controller };
  }

  #connectionAttemptCurrent(generation: number, controller: AbortController): boolean {
    return !this.#disposed && this.#foreground && this.#connectionAttemptEpoch === generation
      && this.#connectionAttemptAbort === controller && !controller.signal.aborted;
  }

  #hasActiveConnection(): boolean {
    return this.#credential !== undefined && this.#activeProfileId !== undefined;
  }

  async start(): Promise<void> {
    const epoch = this.#retire();
    try {
      const [index, pending] = await Promise.all([
        this.storage.loadConnectionIndex(), this.storage.loadPending()
      ]);
      if (!this.#current(epoch)) return;
      this.#profiles = [...index.profiles];
      this.#automaticProfileId = index.automaticProfileId;
      this.#allPending = pending;
      this.#set({
        pending: [],
        selectedId: undefined,
        automaticProfileId: index.automaticProfileId,
        saved: this.#savedViews(),
        connectionMode: index.automaticProfileId === undefined ? this.#state.connectionMode : "saved",
        status: index.automaticProfileId === undefined ? "unpaired" : "connecting",
        candidate: undefined,
        connectionAttemptError: undefined,
        error: undefined
      });
      if (index.automaticProfileId === undefined) return;
      if (!this.#profiles.some((profile) => profile.profileId === index.automaticProfileId)) {
        this.#set({
          status: "unpaired",
          error: "The automatic Joko connection no longer exists on this device. Turn automatic entry off or choose another saved connection."
        });
        return;
      }
      try { await this.connectSaved(index.automaticProfileId); }
      catch { /* connectSaved owns the exact, actionable recovery state. */ }
    } catch (error) {
      if (this.#current(epoch)) this.#set({ status: "unpaired", error: message(error) });
    }
  }

  async inspect(rawOrigin: string): Promise<NodeIdentity> {
    const origin = normalizeNodeOrigin(rawOrigin);
    const { generation, controller } = this.#beginConnectionAttempt();
    try {
      const node = await this.network.inspect(origin, controller.signal);
      if (!this.#connectionAttemptCurrent(generation, controller)) return node;
      this.#connectionAttemptAbort = undefined;
      this.#set({ candidate: { origin, node }, busy: false, challenge: undefined, connectionAttemptError: undefined });
      return node;
    } catch (error) {
      this.#failConnectionAttempt(generation, controller, message(error));
      throw error;
    }
  }

  async requestPairing(rawOrigin: string, deviceName: string): Promise<string> {
    if (!deviceName.trim()) throw new Error("Enter a device name.");
    const origin = normalizeNodeOrigin(rawOrigin);
    const { generation, controller } = this.#beginConnectionAttempt();
    this.#set({ challenge: undefined });
    try {
      const request = await this.network.requestPairing(origin, deviceName, this.platform, controller.signal);
      if (!this.#connectionAttemptCurrent(generation, controller)) return "";
      const candidate = this.#state.candidate;
      if (candidate && (candidate.origin !== origin || candidate.node.serverId !== request.identity.serverId)) {
        throw new Error("The Joko node identity changed. Inspect it again.");
      }
      this.#connectionAttemptAbort = undefined;
      this.#set({ candidate: { origin, node: request.identity }, challenge: { id: request.challengeId, origin, deviceName },
        busy: false, connectionAttemptError: undefined });
      return request.challengeId;
    } catch (error) {
      this.#failConnectionAttempt(generation, controller, message(error));
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
    const { generation, controller } = this.#beginConnectionAttempt();
    try {
      const result = await this.network.completePairing(origin, challenge.id, code, deviceName, this.platform, controller.signal);
      if (!this.#connectionAttemptCurrent(generation, controller)) return;
      const candidate = this.#state.candidate;
      if (candidate && (candidate.origin !== origin || candidate.node.serverId !== result.identity.serverId)) {
        throw new Error("The Joko node identity changed during pairing. Inspect it again.");
      }
      // Prove the credential's identity and device before making it durable.
      const observed = await this.network.inspect(origin, controller.signal);
      if (!this.#connectionAttemptCurrent(generation, controller)) return;
      if (observed.serverId !== result.credential.serverId) throw new Error("The Joko node identity changed during pairing.");
      const owner = await this.network.readOwner(result.credential, controller.signal);
      this.#assertOwner(result.credential, owner, observed);
      if (!this.#connectionAttemptCurrent(generation, controller)) return;
      await this.storage.saveConnection(result.credential);
      if (!this.#connectionAttemptCurrent(generation, controller)) return;
      const profile = profileFromCredential(result.credential);
      this.#profiles = upsertProfile(this.#profiles, profile);
      let preferenceError: string | undefined;
      try {
        // Apply the same explicit automatic-entry choice for every successful
        // pairing path, but only after the new credential is durable.
        await this.storage.saveAutomaticProfile(automatic ? profile.profileId : undefined);
        this.#automaticProfileId = automatic ? profile.profileId : undefined;
      }
      catch (error) { preferenceError = `Paired, but automatic entry could not be saved: ${message(error)}`; }
      await this.#adoptConnection(generation, controller, result.credential, observed, owner, undefined, undefined, preferenceError);
    } catch (error) {
      this.#failConnectionAttempt(generation, controller, message(error));
      throw error;
    }
  }

  cancel(): void {
    this.#cancelCatalogAttempt();
    this.#connectionAttemptAbort?.abort();
    this.#connectionAttemptAbort = undefined;
    this.#connectionAttemptEpoch += 1;
    this.#set({
      busy: this.#mutationOwner !== undefined,
      challenge: undefined,
      candidate: undefined,
      connectionAttemptError: undefined,
      ...(!this.#hasActiveConnection() && this.#state.status === "connecting" ? { status: "unpaired" as const } : {})
    });
  }

  async connectSaved(profileId: string, automatic?: boolean): Promise<void> {
    const profile = this.#profiles.find((candidate) => candidate.profileId === profileId);
    if (!profile) throw new Error("This saved Joko connection is no longer available on this device.");
    if (this.#activeProfileId === profileId && this.#credential) {
      await this.refresh();
      if (this.#state.status === "connected" && automatic !== undefined) {
        await this.setAutomaticEntryForActive(automatic);
      }
      return;
    }
    const { generation, controller } = this.#beginConnectionAttempt();
    this.#set({
      ...(!this.#hasActiveConnection() ? { status: "connecting" as const } : {}),
      candidate: undefined,
      challenge: undefined,
      saved: this.#savedViews(profileId, "checking")
    });
    try {
      // Public identity proof must precede the protected credential read.
      const node = await this.network.inspect(profile.origin, controller.signal);
      if (!this.#connectionAttemptCurrent(generation, controller)) return;
      this.#set({ candidate: { origin: profile.origin, node } });
      if (node.serverId !== profile.serverId) {
        const detail = "The saved Joko node identity changed. Its credential was not read; forget it or inspect and pair this node again.";
        this.#failConnectionAttempt(generation, controller, detail, {
          saved: this.#savedViews(profileId, "identity-conflict", detail)
        });
        throw new Error(detail);
      }
      let credential: PairedCredential | undefined;
      try { credential = await this.storage.loadCredential(profileId); }
      catch (error) {
        if (!this.#connectionAttemptCurrent(generation, controller)) return;
        const failure = credentialFailure(error);
        this.#failConnectionAttempt(generation, controller, message(error), {
          saved: this.#savedViews(profileId, failure, message(error))
        });
        throw error;
      }
      if (!credential || !credentialMatchesProfile(credential, profile)) {
        const detail = credential
          ? "The protected credential does not match this saved Joko connection. Forget it and pair again."
          : "The protected credential for this saved Joko connection is missing. Forget it and pair again.";
        this.#failConnectionAttempt(generation, controller, detail, {
          saved: this.#savedViews(profileId, credential ? "unreadable" : "missing", detail)
        });
        throw new Error(detail);
      }
      const selection = await this.storage.loadSelection(profileId);
      if (!this.#connectionAttemptCurrent(generation, controller)) return;
      const owner = await this.network.readOwner(credential, controller.signal);
      if (!this.#connectionAttemptCurrent(generation, controller)) return;
      this.#assertOwner(credential, owner, node);
      const selected = selection !== undefined && owner.snapshot.sessions.some((session) => session.sessionId === selection)
        ? selection : undefined;
      const detail = selected ? await this.network.readSession(credential, selected, controller.signal) : undefined;
      if (!this.#connectionAttemptCurrent(generation, controller)) return;
      if (selected !== selection) await this.storage.saveSelection(profileId, selected);
      let preferenceError: string | undefined;
      if (automatic !== undefined) {
        try {
          await this.storage.saveAutomaticProfile(automatic ? profileId : undefined);
          this.#automaticProfileId = automatic ? profileId : undefined;
        } catch (error) {
          preferenceError = `Connected, but the automatic-entry preference could not be saved: ${message(error)}`;
        }
      }
      await this.#adoptConnection(generation, controller, credential, node, owner, selected, detail, preferenceError);
    } catch (error) {
      if (!this.#connectionAttemptCurrent(generation, controller)) {
        if (controller.signal.aborted) return;
        throw error;
      }
      if (isRevoked(error)) {
        await this.#invalidateConnectionAttemptProfile(
          generation,
          controller,
          profileId,
          "This mobile connection was revoked. Forget it or pair this device again."
        );
      } else if (error instanceof CredentialIdentityError) {
        this.#failConnectionAttempt(generation, controller, error.message, {
          saved: this.#savedViews(profileId, "identity-conflict", error.message)
        });
      } else if (this.#state.saved.find((item) => item.profileId === profileId)?.credentialState === "checking") {
        const detail = message(error);
        this.#failConnectionAttempt(generation, controller, detail, {
          saved: this.#savedViews(profileId, "offline", detail)
        });
      }
      throw error;
    }
  }

  async #adoptConnection(
    generation: number,
    controller: AbortController,
    credential: PairedCredential,
    node: NodeIdentity,
    owner: Awaited<ReturnType<MobileNetwork["readOwner"]>>,
    selectedId?: string,
    detail?: Snapshot,
    preferenceError?: string
  ): Promise<void> {
    if (!this.#connectionAttemptCurrent(generation, controller)) return;
    this.#connectionAttemptAbort = undefined;
    const epoch = this.#retire();
    if (!this.#current(epoch)) return;
    this.#credential = credential;
    this.#activeProfileId = credential.profileId;
    const ownedPending = this.#allPending.filter((item) => item.connectionId === credential.connectionId);
    this.#set({
      status: "connected",
      busy: false,
      node,
      origin: credential.origin,
      owner: owner.snapshot,
      detail,
      selectedId,
      activeProfileId: credential.profileId,
      automaticProfileId: this.#automaticProfileId,
      pending: ownedPending,
      saved: this.#savedViews(credential.profileId, "available"),
      candidate: undefined,
      challenge: undefined,
      connectionAttemptError: undefined,
      older: [],
      window: undefined,
      before: undefined,
      historyEnd: false,
      historyBusy: false,
      live: [],
      error: preferenceError
    });
    this.#beginStream(epoch, credential, owner.snapshot);
    await this.reconcile(epoch);
    if (this.#current(epoch)) this.#schedule();
  }

  #failConnectionAttempt(
    generation: number,
    controller: AbortController,
    detail: string,
    patch: Partial<MobileState> = {}
  ): void {
    if (!this.#connectionAttemptCurrent(generation, controller)) return;
    this.#connectionAttemptAbort = undefined;
    this.#set({
      ...(!this.#hasActiveConnection() ? { status: "unpaired" as const } : {}),
      busy: false,
      connectionAttemptError: detail,
      ...patch
    });
  }

  async #invalidateConnectionAttemptProfile(
    generation: number,
    controller: AbortController,
    profileId: string,
    detail: string
  ): Promise<void> {
    if (!this.#connectionAttemptCurrent(generation, controller)) return;
    let automaticFailure: string | undefined;
    const wasAutomatic = this.#automaticProfileId === profileId;
    if (wasAutomatic) {
      try {
        await this.storage.saveAutomaticProfile();
        this.#automaticProfileId = undefined;
      } catch (error) { automaticFailure = message(error); }
    }
    if (!this.#connectionAttemptCurrent(generation, controller)) return;
    let credentialFailure: string | undefined;
    try {
      await this.storage.deleteCredential(profileId);
      if (wasAutomatic) this.#automaticProfileId = undefined;
    }
    catch (error) { credentialFailure = message(error); }
    if (!this.#connectionAttemptCurrent(generation, controller)) return;
    const cleanup = [credentialFailure, this.#automaticProfileId === profileId ? automaticFailure : undefined]
      .filter(Boolean).join(" ");
    const error = cleanup ? `${detail} ${cleanup}` : detail;
    this.#connectionAttemptAbort = undefined;
    this.#set({
      ...(!this.#hasActiveConnection() ? { status: "revoked" as const } : {}),
      busy: false,
      automaticProfileId: this.#automaticProfileId,
      saved: this.#savedViews(profileId, credentialFailure ? "unavailable" : "missing", error),
      connectionAttemptError: error
    });
  }

  async disableAutomaticEntry(): Promise<void> {
    if (this.#mutationOwner || this.#connectionAttemptAbort || this.#state.busy) {
      throw new Error("Finish the current operation before changing automatic entry.");
    }
    this.#cancelCatalogAttempt();
    this.#set({ busy: true });
    try {
      await this.storage.saveAutomaticProfile();
      this.#automaticProfileId = undefined;
      this.#set({ busy: false, automaticProfileId: undefined, saved: this.#savedViews() });
    } catch (error) {
      this.#set({ busy: false });
      throw error;
    }
  }

  setConnectionMode(mode: MobileState["connectionMode"]): void {
    this.cancel();
    this.#set({ connectionMode: mode });
  }

  async refreshSaved(): Promise<void> {
    const { generation, controller } = this.#beginCatalogAttempt();
    this.#set({ saved: this.#profiles.map((profile) => this.#savedConnection(
      profile,
      this.#automaticProfileId === profile.profileId,
      "checking"
    )) });
    const saved = await Promise.all(this.#profiles.map(async (profile): Promise<SavedMobileConnection> => {
      try {
        const identity = await this.network.inspect(profile.origin, controller.signal);
        if (!this.#catalogCurrent(generation, controller)) {
          return this.#savedConnection(profile, this.#automaticProfileId === profile.profileId, "unknown");
        }
        if (identity.serverId !== profile.serverId) {
          return this.#savedConnection(profile, this.#automaticProfileId === profile.profileId, "identity-conflict",
            "The node at this address has a different identity. Its credential was not read.");
        }
        const credential = await this.storage.loadCredential(profile.profileId);
        if (credential === undefined) {
          return this.#savedConnection(profile, this.#automaticProfileId === profile.profileId, "missing",
            "The protected credential is missing. Forget this connection and pair again.");
        }
        if (!credentialMatchesProfile(credential, profile)) {
          return this.#savedConnection(profile, this.#automaticProfileId === profile.profileId, "unreadable",
            "The protected credential does not match this exact connection.");
        }
        return this.#savedConnection(profile, this.#automaticProfileId === profile.profileId, "available");
      } catch (error) {
        if (controller.signal.aborted) return this.#savedConnection(profile, this.#automaticProfileId === profile.profileId, "unknown");
        const failure = error instanceof MobileCredentialStorageError ? credentialFailure(error) : "offline";
        return this.#savedConnection(profile, this.#automaticProfileId === profile.profileId, failure, message(error));
      }
    }));
    if (!this.#catalogCurrent(generation, controller)) return;
    this.#catalogAbort = undefined;
    this.#set({ saved });
  }

  async refreshNearby(): Promise<void> {
    const { generation, controller } = this.#beginCatalogAttempt();
    const previous = this.#unexpiredNearby(this.#state.nearby);
    this.#set({ discoveryState: "refreshing", discoveryError: undefined });
    const failures: string[] = [];
    let direct: readonly DiscoveredNodeRecord[] = [];
    try { direct = await this.discovery.scan(controller.signal); }
    catch (error) { if (!controller.signal.aborted) failures.push(message(error)); }
    if (!this.#catalogCurrent(generation, controller)) return;
    const seedOrigins = [...new Set([...direct.map((node) => node.origin), ...this.#profiles.map((profile) => profile.origin)])];
    const expanded = await Promise.all(seedOrigins.slice(0, 64).map(async (origin) => {
      try { return await this.network.discover(origin, controller.signal); }
      catch (error) { if (!controller.signal.aborted) failures.push(message(error)); return [] as readonly DiscoveredNodeRecord[]; }
    }));
    if (!this.#catalogCurrent(generation, controller)) return;
    const candidates = mergeDiscoveryCandidates([...direct, ...expanded.flat()]);
    const verified = (await Promise.all(candidates.slice(0, 128).map(async (candidate): Promise<NearbyMobileNode | undefined> => {
      try {
        const identity = await this.network.inspect(candidate.origin, controller.signal);
        if (identity.serverId !== candidate.serverId) return undefined;
        return {
          ...candidate,
          displayName: identity.displayName,
          version: identity.version,
          apiVersion: identity.apiVersion,
          pairingEnabled: identity.pairingEnabled,
          health: identity.health
        };
      } catch (error) {
        if (!controller.signal.aborted) failures.push(message(error));
        return undefined;
      }
    }))).filter((node): node is NearbyMobileNode => node !== undefined)
      .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.serverId.localeCompare(right.serverId));
    if (!this.#catalogCurrent(generation, controller)) return;
    const detail = [...new Set(failures)].slice(0, 2).join(" ");
    const nearby = mergeRecentNearby(previous, verified);
    this.#catalogAbort = undefined;
    if (verified.length === 0 && failures.length > 0) {
      this.#set({ discoveryState: "error", nearby, discoveryError: detail || "Nearby Joko nodes could not be refreshed." });
    } else {
      this.#set({ discoveryState: "ready", nearby, discoveryError: detail || undefined });
    }
    this.#scheduleNearbyExpiry();
  }

  #unexpiredNearby(nodes: readonly NearbyMobileNode[]): NearbyMobileNode[] {
    const now = this.now();
    return nodes.filter((node) => node.lastSeen + LAN_DISCOVERY_PEER_TTL_MS > now);
  }

  #scheduleNearbyExpiry(): void {
    if (this.#discoveryExpiryTimer !== undefined) clearTimeout(this.#discoveryExpiryTimer);
    this.#discoveryExpiryTimer = undefined;
    const nextExpiry = this.#state.nearby.reduce<number | undefined>((earliest, node) => {
      const expiresAt = node.lastSeen + LAN_DISCOVERY_PEER_TTL_MS;
      return earliest === undefined || expiresAt < earliest ? expiresAt : earliest;
    }, undefined);
    if (nextExpiry === undefined || this.#disposed || !this.#foreground) return;
    this.#discoveryExpiryTimer = setTimeout(() => {
      this.#discoveryExpiryTimer = undefined;
      const nearby = this.#unexpiredNearby(this.#state.nearby);
      if (nearby.length !== this.#state.nearby.length) this.#set({ nearby });
      this.#scheduleNearbyExpiry();
    }, Math.max(1, nextExpiry - this.now() + 1));
  }

  async inspectNearby(node: NearbyMobileNode): Promise<NodeIdentity> {
    this.#set({ connectionMode: "add" });
    return this.inspect(node.origin);
  }

  async setAutomaticEntryForActive(enabled: boolean): Promise<void> {
    if (this.#mutationOwner || this.#connectionAttemptAbort || this.#state.busy) {
      throw new Error("Finish the current operation before changing automatic entry.");
    }
    this.#cancelCatalogAttempt();
    const profileId = this.#activeProfileId;
    if (enabled && (!profileId || this.#state.status !== "connected")) {
      throw new Error("Connect to a saved Joko node before enabling automatic entry.");
    }
    this.#set({ busy: true });
    try {
      await this.storage.saveAutomaticProfile(enabled ? profileId : undefined);
      this.#automaticProfileId = enabled ? profileId : undefined;
      this.#set({ busy: false, automaticProfileId: this.#automaticProfileId, saved: this.#savedViews() });
    } catch (error) {
      this.#set({ busy: false });
      throw error;
    }
  }

  async forgetConnection(profileId: string): Promise<void> {
    if (this.#mutationOwner || this.#state.busy) {
      throw new Error("Finish the current operation before forgetting a saved connection.");
    }
    const profile = this.#profiles.find((candidate) => candidate.profileId === profileId);
    if (!profile) return;
    this.cancel();
    this.#set({ busy: true });
    const wasActive = this.#activeProfileId === profileId;
    try {
      await this.storage.deleteConnection(profileId);
    } catch (error) {
      const detail = message(error);
      if (wasActive) {
        this.#retire();
        this.#credential = undefined;
        this.#activeProfileId = undefined;
        this.#set({ status: "unpaired", busy: false, activeProfileId: undefined,
          automaticProfileId: this.#automaticProfileId, node: undefined, origin: undefined,
          saved: this.#savedViews(profileId, credentialFailure(error), detail), candidate: undefined,
          connectionAttemptError: undefined, challenge: undefined,
          owner: undefined, detail: undefined, selectedId: undefined, older: [], window: undefined,
          live: [], liveStatus: "paused", historyBusy: false, historyEnd: false, before: undefined,
          pending: [], error: detail });
      } else {
        this.#set({ busy: false, automaticProfileId: this.#automaticProfileId,
          saved: this.#savedViews(profileId, credentialFailure(error), detail), error: detail });
      }
      throw error;
    }
    this.#profiles = this.#profiles.filter((candidate) => candidate.profileId !== profileId);
    if (this.#automaticProfileId === profileId) this.#automaticProfileId = undefined;
    const cleanupFailures: string[] = [];
    try { await this.storage.saveSelection(profileId); }
    catch (error) { cleanupFailures.push(`task selection: ${message(error)}`); }
    try { await this.#dropPendingConnections([profile.connectionId]); }
    catch (error) { cleanupFailures.push(`operation receipts: ${message(error)}`); }
    const cleanupError = cleanupFailures.length === 0
      ? undefined
      : `The connection was forgotten, but Joko could not clear ${cleanupFailures.join("; ")}.`;
    if (!wasActive) {
      this.#set({ busy: false, automaticProfileId: this.#automaticProfileId, saved: this.#savedViews(), error: cleanupError });
      return;
    }
    this.#retire();
    this.#credential = undefined;
    this.#activeProfileId = undefined;
    this.#set({ status: "unpaired", busy: false, node: undefined, origin: undefined,
      activeProfileId: undefined, automaticProfileId: this.#automaticProfileId, saved: this.#savedViews(),
      candidate: undefined, connectionAttemptError: undefined, challenge: undefined,
      owner: undefined, detail: undefined, selectedId: undefined,
      older: [], window: undefined, live: [], liveStatus: "paused", historyBusy: false,
      historyEnd: false, before: undefined, pending: [], error: cleanupError });
  }

  #beginCatalogAttempt(): { readonly generation: number; readonly controller: AbortController } {
    if (this.#mutationOwner || this.#connectionAttemptAbort || this.#state.busy) {
      throw new Error("Finish the current operation before refreshing Joko connections.");
    }
    this.#catalogAbort?.abort();
    const controller = new AbortController();
    this.#catalogAbort = controller;
    return { generation: ++this.#catalogEpoch, controller };
  }

  #catalogCurrent(generation: number, controller: AbortController): boolean {
    return !this.#disposed && this.#foreground && this.#catalogEpoch === generation
      && this.#catalogAbort === controller && !controller.signal.aborted;
  }

  #cancelCatalogAttempt(): void {
    this.#catalogAbort?.abort();
    this.#catalogAbort = undefined;
    this.#catalogEpoch += 1;
    const discoveryRefreshing = this.#state.discoveryState === "refreshing";
    const savedChecking = this.#state.saved.some((profile) => profile.credentialState === "checking");
    if (!discoveryRefreshing && !savedChecking) return;
    this.#set({
      ...(discoveryRefreshing ? { discoveryState: "idle" as const } : {}),
      ...(savedChecking ? {
        saved: this.#state.saved.map((profile) => profile.credentialState === "checking"
          ? { ...profile, credentialState: "unknown" as const, error: undefined }
          : profile)
      } : {})
    });
  }

  setForeground(active: boolean): void {
    if (this.#foreground === active) return;
    this.#foreground = active;
    this.#retire();
    if (!active) {
      this.#connectionAttemptAbort?.abort();
      this.#connectionAttemptAbort = undefined;
      this.#connectionAttemptEpoch += 1;
      if (this.#discoveryExpiryTimer !== undefined) clearTimeout(this.#discoveryExpiryTimer);
      this.#discoveryExpiryTimer = undefined;
      this.#cancelCatalogAttempt();
      this.#mutationOwner = undefined;
      this.#set({
        ...(!this.#hasActiveConnection() && this.#state.status === "connecting" ? { status: "unpaired" as const } : {}),
        busy: false,
        candidate: undefined,
        challenge: undefined,
        connectionAttemptError: undefined,
        liveStatus: "paused",
        live: [],
        historyBusy: false,
        older: [],
        window: undefined,
        before: undefined,
        historyEnd: false
      });
    }
    if (active) {
      const nearby = this.#unexpiredNearby(this.#state.nearby);
      if (nearby.length !== this.#state.nearby.length) this.#set({ nearby });
      this.#scheduleNearbyExpiry();
    }
    if (active) {
      if (this.#credential) void this.refresh();
      else void this.start();
    }
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
        this.#identityConflict(epoch, credential.profileId,
          "The saved Joko node identity changed. Its credential was not read again; forget it or pair this node explicitly.");
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
      if (selected !== selectedId) await this.storage.saveSelection(credential.profileId, selected);
      if (!this.#current(epoch)) return;
      const sameWindow = selected === selectedId && this.#state.owner?.generation === owner.snapshot.generation;
      this.#set({ node, origin: credential.origin, owner: owner.snapshot, detail, selectedId: selected,
        older: sameWindow ? this.#state.older : [], window: sameWindow ? this.#state.window : undefined,
        before: sameWindow ? this.#state.before : undefined, historyEnd: sameWindow ? this.#state.historyEnd : false,
        historyBusy: false, live: [], status: "connected", error: undefined,
        saved: this.#savedViews(credential.profileId, "available") });
      this.#beginStream(epoch, credential, owner.snapshot);
      await this.reconcile(epoch);
      if (this.#current(epoch)) this.#schedule();
    } catch (error) {
      if (!this.#current(epoch)) return;
      if (isRevoked(error)) await this.#invalidateCredential(
        epoch,
        credential.profileId,
        "This mobile connection was revoked. Forget it or pair this device again."
      );
      else if (error instanceof CredentialIdentityError) {
        this.#identityConflict(epoch, credential.profileId, error.message);
      }
      else {
        this.#set({ status: "offline", liveStatus: "paused", live: [], error: message(error) });
        this.#schedule();
      }
    }
  }

  #assertOwner(credential: PairedCredential, owner: Awaited<ReturnType<MobileNetwork["readOwner"]>>, node: NodeIdentity): void {
    if (owner.snapshot.server?.serverId !== node.serverId || owner.snapshot.server.apiVersion !== node.apiVersion) {
      throw new CredentialIdentityError("The authenticated snapshot did not match the inspected Joko node identity and API. The saved credential was kept but suspended.");
    }
    if (owner.connection.connectionId !== credential.connectionId
      || owner.connection.connectionProfileId !== credential.profileId
      || owner.connection.deviceId !== credential.deviceId
      || owner.device.deviceId !== credential.deviceId || owner.device.kind !== DeviceKind.MOBILE) {
      throw new CredentialIdentityError("The protected credential did not resolve to its exact saved Joko connection and device. It was kept but suspended.");
    }
    if (owner.connection.state !== ConnectionState.CONNECTED || owner.device.revoked) {
      throw new RevokedError();
    }
    const projectedConnection = owner.snapshot.connections.find((item) => item.connectionId === credential.connectionId);
    const projectedDevice = owner.snapshot.devices.find((item) => item.deviceId === credential.deviceId);
    if (projectedConnection?.connectionProfileId !== credential.profileId
      || projectedConnection.deviceId !== credential.deviceId || projectedDevice?.kind !== DeviceKind.MOBILE) {
      throw new CredentialIdentityError("The authenticated Joko snapshot did not prove the exact saved connection and device. The credential was kept but suspended.");
    }
    if (projectedConnection.state !== ConnectionState.CONNECTED || projectedDevice.revoked) throw new RevokedError();
  }

  #identityConflict(epoch: number, profileId: string, error: string): void {
    if (!this.#current(epoch)) return;
    this.#connectionAttemptAbort?.abort();
    this.#connectionAttemptAbort = undefined;
    this.#connectionAttemptEpoch += 1;
    this.#retire();
    this.#credential = undefined;
    this.#activeProfileId = undefined;
    this.#set({ status: "unpaired", busy: false, activeProfileId: undefined, node: undefined,
      saved: this.#savedViews(profileId, "identity-conflict", error), candidate: undefined,
      connectionAttemptError: undefined, challenge: undefined, owner: undefined, detail: undefined,
      selectedId: undefined, older: [], window: undefined, live: [], liveStatus: "paused",
      historyBusy: false, historyEnd: false, before: undefined, pending: [], error });
  }

  async #invalidateCredential(epoch: number, profileId: string, error: string): Promise<void> {
    if (!this.#current(epoch)) return;
    this.#connectionAttemptAbort?.abort();
    this.#connectionAttemptAbort = undefined;
    this.#connectionAttemptEpoch += 1;
    this.#retire();
    this.#credential = undefined;
    this.#activeProfileId = undefined;
    let automaticFailure: string | undefined;
    const wasAutomatic = this.#automaticProfileId === profileId;
    if (wasAutomatic) {
      try {
        await this.storage.saveAutomaticProfile();
        this.#automaticProfileId = undefined;
      }
      catch (failure) { automaticFailure = message(failure); }
    }
    let credentialFailureMessage: string | undefined;
    try {
      await this.storage.deleteCredential(profileId);
      if (wasAutomatic) this.#automaticProfileId = undefined;
    }
    catch (failure) { credentialFailureMessage = message(failure); }
    const cleanupFailure = credentialFailureMessage === undefined
      ? undefined
      : [credentialFailureMessage, automaticFailure].filter(Boolean).join(" ");
    const cleanupError = cleanupFailure === undefined ? undefined : ` ${cleanupFailure}`;
    this.#set({ status: "revoked", busy: false, activeProfileId: undefined,
      automaticProfileId: this.#automaticProfileId, node: undefined,
      saved: this.#savedViews(profileId, cleanupError ? "unavailable" : "missing", `${error}${cleanupError ?? ""}`),
      candidate: undefined, connectionAttemptError: undefined, challenge: undefined, owner: undefined, detail: undefined,
      selectedId: undefined, older: [], window: undefined, live: [], liveStatus: "paused",
      historyBusy: false, historyEnd: false, before: undefined, pending: [], error: `${error}${cleanupError ?? ""}` });
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
      if (isRevoked(error)) await this.#invalidateCredential(
        epoch,
        credential.profileId,
        "This mobile connection was revoked. Forget it or pair this device again."
      );
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
      if (isRevoked(error)) await this.#invalidateCredential(
        epoch,
        credential.profileId,
        "This mobile connection was revoked. Forget it or pair this device again."
      );
      else void this.refresh();
    } finally {
      if (this.#current(epoch)) this.#projectionReading = false;
    }
  }

  async #persistPending(items: readonly PendingOperation[], epoch: number): Promise<boolean> {
    const connectionId = this.#credential?.connectionId;
    if (connectionId === undefined) return false;
    const write = this.#pendingWrite.then(async () => {
      if (!this.#current(epoch) || this.#credential?.connectionId !== connectionId) return false;
      const merged = [
        ...this.#allPending.filter((item) => item.connectionId !== connectionId),
        ...items
      ];
      await this.storage.savePending(merged);
      this.#allPending = merged;
      const current = this.#current(epoch) && this.#credential?.connectionId === connectionId;
      if (current) this.#set({ saved: this.#savedViews() });
      return current;
    });
    this.#pendingWrite = write.then(() => undefined, () => undefined);
    return write;
  }

  async #dropPendingConnections(connectionIds: readonly string[]): Promise<void> {
    const removed = new Set(connectionIds);
    const write = this.#pendingWrite.then(async () => {
      const next = this.#allPending.filter((item) => !removed.has(item.connectionId));
      if (next.length === this.#allPending.length) return;
      await this.storage.savePending(next);
      this.#allPending = next;
      this.#set({ saved: this.#savedViews() });
    });
    this.#pendingWrite = write.then(() => undefined, () => undefined);
    await write;
  }

  async select(sessionId?: string): Promise<void> {
    if (sessionId !== undefined && !this.#state.owner?.sessions.some((session) => session.sessionId === sessionId)) {
      throw new Error("Select a task from the current Joko node.");
    }
    const profileId = this.#activeProfileId;
    if (!profileId) throw new Error("Reconnect to a saved Joko node before selecting a task.");
    const epoch = this.#retire();
    await this.storage.saveSelection(profileId, sessionId);
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

  async logoutConnection(connectionId: string): Promise<boolean> {
    const connection = this.#state.owner?.connections.find((candidate) => candidate.connectionId === connectionId);
    const revision = connection?.version?.revision;
    if (!connection || !revision || revision.value < 1n) throw new Error("A current connection revision is required for logout.");
    const action = this.#claimMutation();
    try {
      return await this.#submit(create(OperationMutationSchema, {
        preconditions: [create(OperationPreconditionSchema, {
          entity: create(EntityRefSchema, { kind: EntityKind.CONNECTION, id: connectionId }),
          expectedRevision: revision
        })],
        payload: { case: "logoutConnection", value: create(LogoutConnectionMutationSchema, { connectionId }) }
      }), { kind: "logout", targetConnectionId: connectionId });
    } finally { this.#releaseMutation(action); }
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    const credential = this.#ready();
    if (deviceId === credential.deviceId) {
      throw new Error("Log out this mobile connection instead of revoking its current device from itself.");
    }
    const device = this.#state.owner?.devices.find((candidate) => candidate.deviceId === deviceId);
    const revision = device?.version?.revision;
    if (!device || device.revoked || !revision || revision.value < 1n) {
      throw new Error("A current non-revoked device revision is required.");
    }
    const action = this.#claimMutation();
    try {
      return await this.#submit(create(OperationMutationSchema, {
        preconditions: [create(OperationPreconditionSchema, {
          entity: create(EntityRefSchema, { kind: EntityKind.DEVICE, id: deviceId }),
          expectedRevision: revision
        })],
        payload: { case: "revokeDevice", value: create(RevokeDeviceMutationSchema, {
          deviceId,
          reason: "Revoked from Joko mobile"
        }) }
      }), { kind: "revoke", targetDeviceId: deviceId });
    } finally { this.#releaseMutation(action); }
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
    if (this.#mutationOwner || this.#connectionAttemptAbort || this.#state.busy) {
      throw new Error("Another task or connection operation is already in progress.");
    }
    this.#cancelCatalogAttempt();
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

  async #completeServerRemoval(
    matches: (profile: MobileConnectionProfile) => boolean,
    confirmation: string
  ): Promise<void> {
    const targets = this.#profiles.filter(matches);
    const failed = new Map<string, string>();
    const removed = new Set<string>();
    for (const profile of targets) {
      let automaticFailure: string | undefined;
      const wasAutomatic = this.#automaticProfileId === profile.profileId;
      if (wasAutomatic) {
        try {
          await this.storage.saveAutomaticProfile();
          this.#automaticProfileId = undefined;
        }
        catch (error) { automaticFailure = message(error); }
      }
      try {
        await this.storage.deleteConnection(profile.profileId);
        if (wasAutomatic) this.#automaticProfileId = undefined;
        await this.storage.saveSelection(profile.profileId).catch(() => undefined);
        removed.add(profile.profileId);
      } catch (error) {
        failed.set(profile.profileId, [message(error), automaticFailure].filter(Boolean).join(" "));
      }
    }
    let receiptCleanupError: string | undefined;
    try { await this.#dropPendingConnections(targets.map((profile) => profile.connectionId)); }
    catch (error) { receiptCleanupError = message(error); }
    this.#profiles = this.#profiles.filter((profile) => !removed.has(profile.profileId));
    const activeRemoved = this.#activeProfileId !== undefined && targets.some((profile) => profile.profileId === this.#activeProfileId);
    const saved = this.#profiles.map((profile) => {
      const failure = failed.get(profile.profileId);
      return this.#savedConnection(
        profile,
        this.#automaticProfileId === profile.profileId,
        failure ? "unavailable" : this.#state.saved.find((item) => item.profileId === profile.profileId)?.credentialState ?? "unknown",
        failure
      );
    });
    const cleanupError = failed.size === 0 && receiptCleanupError === undefined
      ? undefined
      : `${confirmation}${failed.size === 0 ? "" : ` Joko could not finish removing ${failed.size === 1 ? "its local credential" : "some local credentials"}; retry Forget.`}`
        + `${receiptCleanupError === undefined ? "" : ` Local operation receipts could not be cleared: ${receiptCleanupError}`}`;
    if (!activeRemoved) {
      this.#set({ automaticProfileId: this.#automaticProfileId, saved, error: cleanupError });
      return;
    }
    this.#retire();
    this.#credential = undefined;
    this.#activeProfileId = undefined;
    this.#set({ status: "unpaired", busy: false, activeProfileId: undefined,
      automaticProfileId: this.#automaticProfileId, node: undefined, origin: undefined, saved,
      candidate: undefined, connectionAttemptError: undefined, challenge: undefined,
      owner: undefined, detail: undefined, selectedId: undefined,
      older: [], window: undefined, live: [], liveStatus: "paused", historyBusy: false,
      historyEnd: false, before: undefined, pending: [], error: cleanupError });
  }

  async #submit(
    mutation: OperationMutation,
    identity: Pick<PendingOperation, "kind" | "sessionId" | "targetConnectionId" | "targetDeviceId">
  ): Promise<boolean> {
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
    const accepted = operation.state !== OperationState.FAILED && operation.state !== OperationState.CONFLICT && operation.state !== OperationState.CANCELLED;
    if (this.#current(epoch)) {
      this.#set({ busy: false });
      await this.refresh();
    }
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
      if (sessionId && this.#activeProfileId) {
        await this.storage.saveSelection(this.#activeProfileId, sessionId);
        if (!this.#current(epoch)) return;
        this.#set({ selectedId: sessionId });
      }
    }
    const next = isTerminal(operation.state)
      ? this.#state.pending.filter((item) => item.operationId !== pending.operationId)
      : this.#state.pending.map((item) => item.operationId === pending.operationId ? { ...item, state: "accepted" as const } : item);
    if (!await this.#persistPending(next, epoch)) return;
    this.#set({ pending: next });
    if (operation.state === OperationState.SUCCEEDED && pending.kind === "logout" && pending.targetConnectionId) {
      await this.#completeServerRemoval(
        (profile) => profile.connectionId === pending.targetConnectionId,
        "The connection was logged out on the Joko node."
      );
    } else if (operation.state === OperationState.SUCCEEDED && pending.kind === "revoke" && pending.targetDeviceId) {
      await this.#completeServerRemoval(
        (profile) => profile.deviceId === pending.targetDeviceId,
        "The device was revoked on the Joko node."
      );
    }
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
        if (isRevoked(error)) {
          await this.#invalidateCredential(
            epoch,
            credential.profileId,
            "This mobile connection was revoked. Forget it or pair this device again."
          );
          return;
        }
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

  #savedViews(
    profileId?: string,
    credentialState?: SavedCredentialState,
    error?: string
  ): SavedMobileConnection[] {
    const previous = new Map(this.#state.saved.map((profile) => [profile.profileId, profile]));
    return this.#profiles.map((profile) => {
      const prior = previous.get(profile.profileId);
      return this.#savedConnection(
        profile,
        this.#automaticProfileId === profile.profileId,
        profile.profileId === profileId && credentialState !== undefined
          ? credentialState
          : prior?.credentialState ?? "unknown",
        profile.profileId === profileId && credentialState !== undefined ? error : prior?.error
      );
    });
  }

  #savedConnection(
    profile: MobileConnectionProfile,
    automatic: boolean,
    credentialState: SavedCredentialState,
    error?: string
  ): SavedMobileConnection {
    return savedConnection(
      profile,
      automatic,
      credentialState,
      this.#allPending.filter((item) => item.connectionId === profile.connectionId),
      error
    );
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#discoveryExpiryTimer !== undefined) clearTimeout(this.#discoveryExpiryTimer);
    this.#discoveryExpiryTimer = undefined;
    this.#catalogAbort?.abort();
    this.#catalogAbort = undefined;
    this.#connectionAttemptAbort?.abort();
    this.#connectionAttemptAbort = undefined;
    this.#retire();
    this.#listeners.clear();
  }
}

function supportsText(backend: Snapshot["backends"][number]): boolean {
  return backend.capabilities?.capabilities.some((item) => item.name === capabilityNames.inputText && item.support === CapabilitySupport.SUPPORTED) === true;
}

function savedConnection(
  profile: MobileConnectionProfile,
  automatic: boolean,
  credentialState: SavedCredentialState,
  pendingOperations: readonly PendingOperation[],
  error?: string
): SavedMobileConnection {
  return {
    ...profile,
    automatic,
    credentialState,
    pendingOperations,
    ...(error === undefined ? {} : { error })
  };
}

function upsertProfile(
  profiles: readonly MobileConnectionProfile[],
  profile: MobileConnectionProfile
): MobileConnectionProfile[] {
  return [
    ...profiles.filter((candidate) => candidate.profileId !== profile.profileId && candidate.connectionId !== profile.connectionId),
    profile
  ];
}

function credentialMatchesProfile(credential: PairedCredential, profile: MobileConnectionProfile): boolean {
  return credential.profileId === profile.profileId && credential.origin === profile.origin
    && credential.serverId === profile.serverId && credential.connectionId === profile.connectionId
    && credential.deviceId === profile.deviceId;
}

function credentialFailure(error: unknown): Extract<SavedCredentialState, "unavailable" | "unreadable"> {
  return error instanceof MobileCredentialStorageError && error.failure === "unreadable" ? "unreadable" : "unavailable";
}

function mergeDiscoveryCandidates(nodes: readonly DiscoveredNodeRecord[]): DiscoveredNodeRecord[] {
  const candidates = new Map<string, DiscoveredNodeRecord>();
  const conflicts = new Set<string>();
  for (const node of nodes) {
    const previous = candidates.get(node.serverId);
    if (previous !== undefined && previous.origin !== node.origin) {
      candidates.delete(node.serverId);
      conflicts.add(node.serverId);
      continue;
    }
    if (!conflicts.has(node.serverId)) candidates.set(node.serverId, node);
  }
  return [...candidates.values()].sort((left, right) =>
    left.displayName.localeCompare(right.displayName) || left.serverId.localeCompare(right.serverId));
}

function mergeRecentNearby(
  previous: readonly NearbyMobileNode[],
  observed: readonly NearbyMobileNode[]
): NearbyMobileNode[] {
  const byServer = new Map<string, NearbyMobileNode>();
  const conflicts = new Set<string>();
  for (const node of [...previous, ...observed]) {
    const known = byServer.get(node.serverId);
    if (known !== undefined && known.origin !== node.origin) {
      byServer.delete(node.serverId);
      conflicts.add(node.serverId);
      continue;
    }
    if (!conflicts.has(node.serverId)) byServer.set(node.serverId, node);
  }
  return [...byServer.values()].sort((left, right) =>
    left.displayName.localeCompare(right.displayName) || left.serverId.localeCompare(right.serverId));
}

class CredentialIdentityError extends Error {}
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
