import type { VoiceDictionaryPeerStatusView } from "@joko/contracts";
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
  async #mutate(ownerKey: string, effect: (transport: MobileVoiceDictionaryTransport, signal: AbortSignal) => Promise<VoiceDictionaryPeerStatusView>): Promise<void> {
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
      this.#adopt(value, pushEpoch);
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
