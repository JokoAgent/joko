import type { VoiceDictionaryReadOnlyView } from "@joko/contracts";
import type { MobileConnectionProfile } from "./connection-storage";
import { mobileReadOnlyDictionaryScope, selectMobileReadOnlyDictionary,
  type CachedMobileReadOnlyDictionary, type MobileReadOnlyDictionaryTransport } from "./mobile-voice-dictionary-readonly";
import type { MobileVoiceDictionaryReadOnlyCache } from "./mobile-voice-dictionary-readonly-cache";

export interface MobileReadOnlyDictionaryHost {
  readonly profile: MobileConnectionProfile;
  readonly status: "loading" | "ready" | "offline" | "error";
  readonly cacheError: boolean;
}
export interface MobileReadOnlyDictionaryControllerState {
  readonly visible: boolean;
  readonly refreshing: boolean;
  readonly hosts: readonly MobileReadOnlyDictionaryHost[];
  readonly selected?: CachedMobileReadOnlyDictionary;
}

/** Multiple read-only sources never take over the active task or share editor authority. */
export class MobileVoiceDictionaryReadOnlyController {
  readonly #listeners = new Set<() => void>();
  #state: MobileReadOnlyDictionaryControllerState = { visible: false, refreshing: false, hosts: [] };
  #profiles: readonly MobileConnectionProfile[] = [];
  #epoch = 0;
  #requests: AbortController[] = [];
  #pending = 0;
  #stopCache: (() => void) | undefined;

  constructor(private readonly cache: MobileVoiceDictionaryReadOnlyCache,
    private readonly connect: (profileId: string, signal: AbortSignal) => Promise<MobileReadOnlyDictionaryTransport>) {}
  get state(): MobileReadOnlyDictionaryControllerState { return this.#state; }
  subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }

  setSources(profiles: readonly MobileConnectionProfile[]): void {
    const sorted = [...profiles].sort((a, b) => a.displayName.localeCompare(b.displayName) || a.profileId.localeCompare(b.profileId, "en-US"));
    if (JSON.stringify(sorted.map((item) => [mobileReadOnlyDictionaryScope(item), item.displayName]))
      === JSON.stringify(this.#profiles.map((item) => [mobileReadOnlyDictionaryScope(item), item.displayName]))) return;
    this.#profiles = sorted;
    this.#retire();
    this.#set({ hosts: sorted.map((profile) => ({ profile, status: "loading", cacheError: false })) });
    if (this.#state.visible) void this.refresh();
  }

  setVisible(visible: boolean): void {
    if (visible === this.#state.visible) return;
    this.#retire();
    this.#stopCache?.(); this.#stopCache = undefined;
    this.#set({ visible, refreshing: false });
    if (visible) { this.#stopCache = this.cache.subscribe(() => this.#set({})); void this.refresh(); }
  }

  async refresh(): Promise<void> {
    if (!this.#state.visible) return;
    this.#retire();
    const epoch = this.#epoch;
    this.#pending = this.#profiles.length;
    this.#set({ refreshing: this.#pending > 0,
      hosts: this.#profiles.map((profile) => ({ profile, status: "loading", cacheError: false })) });
    // Bounded initial parallelism; completed reads leave independently cancellable streams.
    const profiles = [...this.#profiles];
    const workers = Array.from({ length: Math.min(4, profiles.length) }, async () => {
      while (profiles.length > 0 && this.#current(epoch)) await this.#load(profiles.shift()!, epoch);
    });
    await Promise.all(workers);
  }

  async rebuildCache(profileId: string): Promise<void> {
    this.#retire();
    await this.cache.clear(profileId);
    if (this.#state.visible) await this.refresh();
  }

  #current(epoch: number): boolean { return this.#state.visible && this.#epoch === epoch; }
  #retire(): void { this.#epoch += 1; for (const request of this.#requests) request.abort(); this.#requests = []; this.#pending = 0; }
  #host(profile: MobileConnectionProfile, patch: Partial<MobileReadOnlyDictionaryHost>): void {
    this.#set({ hosts: this.#state.hosts.map((host) => mobileReadOnlyDictionaryScope(host.profile) === mobileReadOnlyDictionaryScope(profile) ? { ...host, ...patch } : host) });
  }
  #set(patch: Partial<MobileReadOnlyDictionaryControllerState>): void {
    const next = { ...this.#state, ...patch };
    const values = next.visible ? this.#profiles.flatMap((profile) => { const saved = this.cache.read(profile); return saved ? [saved] : []; }) : [];
    this.#state = Object.freeze({ ...next, selected: selectMobileReadOnlyDictionary(values) });
    for (const listener of this.#listeners) listener();
  }

  async #load(profile: MobileConnectionProfile, epoch: number): Promise<void> {
    const request = new AbortController(); this.#requests.push(request);
    const current = (): boolean => this.#current(epoch) && !request.signal.aborted;
    let transport: MobileReadOnlyDictionaryTransport | undefined;
    let streamFailed = false;
    try {
      try { await this.cache.hydrate(profile); }
      catch { if (current()) this.#host(profile, { cacheError: true }); }
      if (!current()) return;
      const lease = this.cache.lease(profile);
      transport = await this.connect(profile.profileId, request.signal);
      if (!current() || !transport.isCurrent() || mobileReadOnlyDictionaryScope(transport.profile) !== mobileReadOnlyDictionaryScope(profile)) return;
      const source = transport;
      this.#host(profile, { profile: source.profile });
      const adopt = async (value: VoiceDictionaryReadOnlyView): Promise<void> => {
        if (!current() || !source.isCurrent()) return;
        try { await this.cache.apply(source.profile, value, lease); if (current() && source.isCurrent()) this.#host(profile, { cacheError: false }); }
        catch { if (current()) this.#host(profile, { cacheError: true }); }
      };
      void (async () => {
        try {
          for await (const value of source.watchVoiceInputDictionaryReadOnly(request.signal)) {
            if (!current() || !source.isCurrent()) return;
            await adopt(value);
            if (current() && source.isCurrent()) this.#host(profile, { status: "ready" });
          }
          if (current()) throw new Error("The read-only dictionary stream ended.");
        } catch { if (current()) { streamFailed = true; this.#host(profile, { status: "error" }); } }
      })();
      const value = await source.getVoiceInputDictionaryReadOnly(request.signal);
      await adopt(value);
      if (current() && source.isCurrent() && !streamFailed) this.#host(profile, { status: "ready" });
    } catch {
      if (current()) this.#host(profile, { status: transport ? "error" : "offline" });
    } finally {
      if (this.#current(epoch)) { this.#pending -= 1; this.#set({ refreshing: this.#pending > 0 }); }
    }
  }
}
