import {
  mobileVoiceDictionaryTermKey,
  normalizeMobileVoiceDictionaryTerm,
  previewMobileVoiceDictionaryEdit
} from "./mobile-voice-dictionary";
import type { MobileVoiceDictionarySnapshot, MobileVoiceDictionaryTransport } from "./mobile-voice-dictionary-service";
import type { MobileVoiceDictionaryEditOutcome, MobileVoiceDictionaryHistoryKind, MobileVoicePreferencesStore } from "./mobile-voice-preferences-store";

export interface MobileVoiceDictionaryControllerState {
  readonly status: "unavailable" | "loading" | "ready" | "error";
  readonly ownerKey?: string;
  readonly snapshot?: MobileVoiceDictionarySnapshot;
  readonly saving: boolean;
}

/** Ephemeral node projection. The service is the sole dictionary writer. */
export class MobileVoiceDictionaryController {
  #state: MobileVoiceDictionaryControllerState = { status: "unavailable", saving: false };
  #transport?: MobileVoiceDictionaryTransport;
  #request?: AbortController;
  #epoch = 0;
  #listeners = new Set<() => void>();

  constructor(private readonly preferences: Pick<MobileVoicePreferencesStore, "recordDictionaryChange">) {}

  get snapshot(): MobileVoiceDictionaryControllerState { return this.#state; }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setTransport(transport: MobileVoiceDictionaryTransport | undefined): void {
    if (transport?.ownerKey === this.#transport?.ownerKey && this.#transport?.isCurrent()) return;
    this.#request?.abort();
    this.#epoch += 1;
    this.#transport = transport?.isCurrent() ? transport : undefined;
    this.#publish(this.#transport
      ? { status: "loading", ownerKey: this.#transport.ownerKey, saving: false }
      : { status: "unavailable", saving: false });
    if (this.#transport) void this.refresh().catch(() => undefined);
  }

  async refresh(): Promise<void> {
    const transport = this.#transport;
    if (!transport?.isCurrent() || this.#state.saving) return;
    this.#request?.abort();
    const request = new AbortController();
    const epoch = ++this.#epoch;
    this.#request = request;
    try {
      const snapshot = await transport.getVoiceInputDictionary(request.signal);
      if (this.#current(transport, epoch, request)) this.#publish({ status: "ready", ownerKey: transport.ownerKey, snapshot, saving: false });
    } catch (error) {
      if (this.#current(transport, epoch, request)) this.#publish({ ...this.#state, status: "error", saving: false });
      throw error;
    }
  }

  setSyncEnabled(enabled: boolean): Promise<void> {
    return this.#mutate((transport, revision, signal) => transport.setVoiceInputDictionarySyncEnabled(revision, enabled, signal));
  }

  addTerm(text: string): Promise<void> {
    const term = normalizeMobileVoiceDictionaryTerm(text);
    if (!term) return Promise.reject(new Error("The dictionary term is invalid."));
    return this.#mutate((transport, revision, signal) => transport.addVoiceInputDictionaryTerms(revision, [term], signal), undefined, "manualAdd", [term]);
  }

  async editEntry(id: string, text: string, aliasDraft: string, expectedRevision: bigint): Promise<MobileVoiceDictionaryEditOutcome> {
    const term = normalizeMobileVoiceDictionaryTerm(text);
    if (!term) throw new Error("The dictionary term is invalid.");
    const aliases: string[] = [];
    const seen = new Set<string>();
    for (const line of aliasDraft.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      const alias = normalizeMobileVoiceDictionaryTerm(line);
      if (!alias) throw new Error("The dictionary alias is invalid.");
      const key = mobileVoiceDictionaryTermKey(alias);
      if (key === mobileVoiceDictionaryTermKey(term) || seen.has(key)) continue;
      seen.add(key);
      aliases.push(alias);
    }
    if (aliases.length > 8) throw new Error("The dictionary alias limit is exceeded.");
    const dictionary = this.#state.snapshot?.dictionary;
    const preview = dictionary && previewMobileVoiceDictionaryEdit(dictionary, id, term);
    const outcome = preview?.kind === "mergeEntry" ? "mergedEntry" : preview?.kind === "mergeCandidate" ? "mergedCandidate" : "updated";
    await this.#mutate((transport, revision, signal) => transport.editVoiceInputDictionaryEntry(revision, id, term, aliases, signal),
      expectedRevision, outcome === "updated" ? "manualEdit" : "manualMerge", [term]);
    return outcome;
  }

  deleteEntry(id: string, expectedRevision: bigint): Promise<void> {
    const source = this.#state.snapshot?.dictionary.entries.find((entry) => entry.id === id);
    if (!source) return Promise.reject(new Error("The dictionary entry is unavailable."));
    return this.#mutate((transport, revision, signal) => transport.deleteVoiceInputDictionaryEntry(revision, id, signal),
      expectedRevision, "manualDelete", [source.text]);
  }

  async #mutate(
    effect: (transport: MobileVoiceDictionaryTransport, revision: bigint, signal: AbortSignal) => Promise<MobileVoiceDictionarySnapshot>,
    expectedRevision?: bigint,
    historyKind?: MobileVoiceDictionaryHistoryKind,
    terms: readonly string[] = []
  ): Promise<void> {
    const transport = this.#transport;
    const before = this.#state.snapshot;
    if (!transport?.isCurrent() || !before || this.#state.saving) throw new Error("The dictionary is unavailable or busy.");
    this.#request?.abort();
    const request = new AbortController();
    const epoch = ++this.#epoch;
    this.#request = request;
    this.#publish({ ...this.#state, saving: true });
    try {
      const snapshot = await effect(transport, expectedRevision ?? before.revision, request.signal);
      if (!this.#current(transport, epoch, request)) throw new Error("The dictionary owner changed.");
      this.#publish({ status: "ready", ownerKey: transport.ownerKey, snapshot, saving: true });
      if (historyKind && snapshot.revision !== before.revision) {
        // The remote commit remains successful even if private metadata fails.
        await this.preferences.recordDictionaryChange(historyKind, terms,
          () => this.#current(transport, epoch, request)).catch(() => undefined);
      }
    } catch (error) {
      if (this.#current(transport, epoch, request)) {
        // Refresh authority after conflict/unknown, without rebasing an editor's revision.
        try {
          const snapshot = await transport.getVoiceInputDictionary(request.signal);
          if (this.#current(transport, epoch, request)) this.#publish({ status: "ready", ownerKey: transport.ownerKey, snapshot, saving: true });
        } catch {
          if (this.#current(transport, epoch, request)) this.#publish({ ...this.#state, status: "error" });
        }
      }
      throw error;
    } finally {
      if (this.#current(transport, epoch, request)) this.#publish({ ...this.#state, saving: false });
    }
  }

  #current(transport: MobileVoiceDictionaryTransport, epoch: number, request: AbortController): boolean {
    return this.#transport === transport && transport.isCurrent() && this.#epoch === epoch && !request.signal.aborted;
  }
  #publish(state: MobileVoiceDictionaryControllerState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}
