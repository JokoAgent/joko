export interface SystemAudioMuteBackend {
  readonly supported: boolean;
  getMuted(): Promise<boolean>;
  setMuted(muted: boolean): Promise<void>;
}

interface LoudnessClient {
  getMuted(): Promise<boolean>;
  setMuted(muted: boolean): Promise<void>;
}

export function createSystemAudioMuteBackend(
  platform: NodeJS.Platform = process.platform,
  loadClient: () => Promise<LoudnessClient> = loadLoudnessClient
): SystemAudioMuteBackend {
  if (platform !== "win32" && platform !== "darwin") {
    return Object.freeze({
      supported: false,
      getMuted: async () => false,
      setMuted: async () => undefined
    });
  }
  let client: Promise<LoudnessClient> | undefined;
  const requireClient = (): Promise<LoudnessClient> => client ??= loadClient();
  return Object.freeze({
    supported: true,
    getMuted: async () => (await requireClient()).getMuted(),
    setMuted: async (muted: boolean) => (await requireClient()).setMuted(muted)
  });
}

export class SystemAudioMuteGuard<Owner> {
  readonly #backend: SystemAudioMuteBackend;
  readonly #owners = new Set<Owner>();
  #originalMuted: boolean | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(backend: SystemAudioMuteBackend) {
    this.#backend = backend;
  }

  acquire(owner: Owner): Promise<void> {
    return this.#enqueue(async () => {
      if (!this.#backend.supported || this.#owners.has(owner)) return;
      if (this.#owners.size === 0 && this.#originalMuted === undefined) {
        const muted = await this.#backend.getMuted();
        if (!muted) await this.#backend.setMuted(true);
        this.#originalMuted = muted;
      }
      this.#owners.add(owner);
    });
  }

  release(owner: Owner): Promise<void> {
    return this.#enqueue(async () => {
      if (!this.#owners.delete(owner) || this.#owners.size !== 0) return;
      await this.#restoreOriginalState();
    });
  }

  releaseAll(): Promise<void> {
    return this.#enqueue(async () => {
      this.#owners.clear();
      await this.#restoreOriginalState();
    });
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.catch(() => undefined);
    return result;
  }

  async #restoreOriginalState(): Promise<void> {
    const originalMuted = this.#originalMuted;
    if (originalMuted === undefined) return;
    if (!originalMuted) await this.#backend.setMuted(false);
    this.#originalMuted = undefined;
  }
}

async function loadLoudnessClient(): Promise<LoudnessClient> {
  const loaded = await import("loudness");
  const candidate: unknown = (loaded as { readonly default?: unknown }).default ?? loaded;
  if (typeof candidate !== "object" || candidate === null
    || typeof (candidate as Record<string, unknown>)["getMuted"] !== "function"
    || typeof (candidate as Record<string, unknown>)["setMuted"] !== "function") {
    throw new TypeError("System audio control is unavailable.");
  }
  return candidate as LoudnessClient;
}
