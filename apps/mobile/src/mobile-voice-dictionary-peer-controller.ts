import { readVoiceDictionaryPeerInvitation, type VoiceDictionaryPeerListener, type VoiceDictionaryPeerStatusView } from "@joko/contracts";
import type { MobileVoiceDictionaryTransport } from "./mobile-voice-dictionary-service";

export interface MobileVoiceDictionaryPeerState {
  readonly status: "unavailable" | "loading" | "ready" | "error";
  readonly ownerKey?: string;
  readonly value?: VoiceDictionaryPeerStatusView;
  readonly busy: boolean;
}

/** Ephemeral sharing projection. Neither identities nor grants are persisted on the phone. */
export class MobileVoiceDictionaryPeerController {
  #state: MobileVoiceDictionaryPeerState = { status: "unavailable", busy: false };
  #transport?: MobileVoiceDictionaryTransport;
  #request?: AbortController;
  #watchRequest?: AbortController;
  #watchEpoch = 0;
  #pushEpoch = 0;
  #streamFailed = false;
  #epoch = 0;
  readonly #listeners = new Set<() => void>();
  get snapshot(): MobileVoiceDictionaryPeerState { return this.#state; }
  subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  setTransport(transport: MobileVoiceDictionaryTransport | undefined): void {
    if (transport?.ownerKey === this.#transport?.ownerKey && this.#transport?.isCurrent()) return;
    this.#epoch += 1; this.#request?.abort();
    this.#watchEpoch += 1; this.#watchRequest?.abort();
    this.#streamFailed = false;
    this.#transport = transport?.isCurrent() ? transport : undefined;
    this.#publish(this.#transport ? { status: "loading", ownerKey: this.#transport.ownerKey, busy: false } : { status: "unavailable", busy: false });
    if (this.#transport) void this.refresh().catch(() => undefined);
  }
  async refresh(): Promise<void> {
    const transport = this.#transport;
    if (!transport?.isCurrent() || this.#state.busy) return;
    this.#startWatch(transport);
    const pushEpoch = this.#pushEpoch;
    const epoch = ++this.#epoch;
    this.#request?.abort();
    const request = this.#request = new AbortController();
    try {
      const value = await transport.getVoiceInputDictionaryPeerStatus(request.signal);
      if (this.#current(transport, epoch, request)) this.#adopt(value, pushEpoch);
    } catch (error) {
      if (this.#current(transport, epoch, request)) this.#publish({ ...this.#state, status: "error", busy: false });
      throw error;
    }
  }

  #startWatch(transport: MobileVoiceDictionaryTransport): void {
    this.#watchRequest?.abort();
    const epoch = ++this.#watchEpoch;
    const request = this.#watchRequest = new AbortController();
    const current = (): boolean => epoch === this.#watchEpoch && transport === this.#transport && transport.isCurrent() && !request.signal.aborted;
    void (async () => {
      try {
        for await (const value of transport.watchVoiceInputDictionaryPeerStatus(request.signal)) {
          if (!current()) return;
          this.#pushEpoch += 1;
          if (!this.#state.value || value.configurationRevision >= this.#state.value.configurationRevision) {
            this.#streamFailed = false;
            this.#publish({ status: "ready", ownerKey: transport.ownerKey, value, busy: this.#state.busy });
          }
        }
        if (current()) throw new Error("Dictionary sharing updates disconnected.");
      } catch {
        if (current()) { this.#streamFailed = true; this.#publish({ ...this.#state, status: "error" }); }
      }
    })();
  }
  #adopt(value: VoiceDictionaryPeerStatusView, pushEpoch: number): void {
    const latest = this.#state.value;
    const preserve = latest && (latest.configurationRevision > value.configurationRevision ||
      (latest.configurationRevision === value.configurationRevision && pushEpoch !== this.#pushEpoch));
    this.#publish({ status: this.#streamFailed ? "error" : "ready", ownerKey: this.#transport!.ownerKey,
      value: preserve ? latest : value, busy: false });
  }
  grant(ownerKey: string, revision: bigint, peerId: string, fingerprint: string): Promise<void> {
    return this.#mutate(ownerKey, (transport, signal) => transport.grantVoiceInputDictionaryPeer(revision, peerId, fingerprint, signal));
  }
  revoke(ownerKey: string, peerId: string, revision: bigint): Promise<void> {
    return this.#mutate(ownerKey, (transport, signal) => transport.revokeVoiceInputDictionaryPeer(peerId, revision, signal));
  }
  syncNow(ownerKey: string, revision: bigint): Promise<void> {
    return this.#mutate(ownerKey, (transport, signal) => transport.syncVoiceInputDictionaryNow(revision, undefined, signal));
  }
  async configureListener(ownerKey: string, revision: bigint, listener: VoiceDictionaryPeerListener | undefined): Promise<void> {
    this.#assertRevision(ownerKey, revision);
    return this.#mutate(ownerKey, (transport, signal) => transport.configureVoiceInputDictionaryListener(revision, listener, signal));
  }
  async grantDirect(ownerKey: string, revision: bigint, invitation: string, fingerprint: string): Promise<void> {
    this.#assertRevision(ownerKey, revision);
    const preview = readVoiceDictionaryPeerInvitation(invitation);
    if (preview.fingerprint !== fingerprint || preview.nodeId === this.#state.value!.nodeId ||
      this.#state.value!.peers.some((peer) => peer.peerId === preview.nodeId && peer.fingerprint !== fingerprint)) throw new Error("Dictionary peer identity changed.");
    return this.#mutate(ownerKey, (transport, signal) => transport.grantVoiceInputDictionaryDirectPeer(revision, invitation, fingerprint, signal));
  }
  async clearRoute(ownerKey: string, revision: bigint, peerId: string): Promise<void> {
    this.#assertRevision(ownerKey, revision);
    return this.#mutate(ownerKey, (transport, signal) => transport.clearVoiceInputDictionaryPeerRoute(revision, peerId, signal));
  }
  async invitation(ownerKey: string, revision: bigint): Promise<string> {
    this.#assertRevision(ownerKey, revision);
    const expected = this.#state.value!;
    const result = await this.#execute(ownerKey, (transport, signal) => transport.getVoiceInputDictionaryPeerInvitation(signal));
    const preview = readVoiceDictionaryPeerInvitation(result);
    if (this.#state.value?.configurationRevision !== revision || preview.nodeId !== expected.nodeId || preview.fingerprint !== expected.fingerprint ||
      preview.host !== expected.listener?.host || preview.port !== expected.listener?.port) throw new Error("Dictionary invitation authority changed.");
    return result;
  }
  #assertRevision(ownerKey: string, revision: bigint): void {
    if (this.#state.ownerKey !== ownerKey || this.#state.value?.configurationRevision !== revision) throw new Error("Dictionary sharing revision or owner changed.");
  }
  async #mutate(ownerKey: string, effect: (transport: MobileVoiceDictionaryTransport, signal: AbortSignal) => Promise<VoiceDictionaryPeerStatusView>): Promise<void> {
    await this.#execute(ownerKey, effect);
  }
  async #execute<T extends VoiceDictionaryPeerStatusView | string>(ownerKey: string, effect: (transport: MobileVoiceDictionaryTransport, signal: AbortSignal) => Promise<T>): Promise<T> {
    const transport = this.#transport;
    if (!transport?.isCurrent() || transport.ownerKey !== ownerKey || this.#state.status !== "ready" || this.#state.busy || !this.#state.value?.available) throw new Error("Dictionary sharing is unavailable or its owner changed.");
    const epoch = ++this.#epoch;
    const pushEpoch = this.#pushEpoch;
    this.#request?.abort();
    const request = this.#request = new AbortController();
    this.#publish({ ...this.#state, busy: true });
    try {
      const value = await effect(transport, request.signal);
      if (!this.#current(transport, epoch, request)) throw new Error("Dictionary sharing authority changed.");
      if (typeof value === "string") { readVoiceDictionaryPeerInvitation(value); this.#publish({ ...this.#state, busy: false }); }
      else this.#adopt(value, pushEpoch);
      return value;
    } catch (error) {
      if (this.#current(transport, epoch, request)) {
        this.#publish({ ...this.#state, status: "error", busy: false });
        // Refresh the same owner once, never replay the user's grant or revocation.
        const pushed = this.#pushEpoch;
        try {
          const value = await transport.getVoiceInputDictionaryPeerStatus(request.signal);
          if (this.#current(transport, epoch, request)) this.#adopt(value, pushed);
        } catch {}
      }
      throw error;
    }
  }
  #current(transport: MobileVoiceDictionaryTransport, epoch: number, request: AbortController): boolean {
    return transport === this.#transport && epoch === this.#epoch && !request.signal.aborted && transport.isCurrent();
  }
  #publish(state: MobileVoiceDictionaryPeerState): void { this.#state = state; for (const listener of this.#listeners) listener(); }
}
