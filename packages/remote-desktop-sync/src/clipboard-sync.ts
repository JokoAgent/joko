import { ClipboardSyncError } from "./clipboard-sync-failure.js";

export const CLIPBOARD_SYNC_CHUNK_CHARS = 64 * 1_024;
export const CLIPBOARD_SYNC_MAX_CHARS = 32 * 1_024 * 1_024;

export interface ClipboardSyncRemote {
  version(): Promise<string>;
  copy(version: string, inline: boolean): Promise<{ readonly length: number; readonly id?: string; readonly data?: string }>;
  begin(length: number, version: string): Promise<string>;
  read(id: string, offset: number): Promise<string>;
  write(id: string, offset: number, data: string): Promise<void>;
  commit(id: string): Promise<string>;
  paste(json: string, version: string): Promise<string>;
  cancel(id: string): Promise<void>;
}

export interface LocalClipboardReadCache { version?: string; digest?: string }
export interface ClipboardSyncBaseline { local: string; remote: string; localDigest?: string; remoteDigest?: string }
export type ClipboardSyncStage =
  | "local-read-start" | "local-read-complete" | "remote-read-start" | "remote-read-complete"
  | "local-to-remote-complete" | "remote-to-local-complete" | "content-skipped" | "unchanged-content";

export interface ClipboardSyncDeps {
  readonly remote: ClipboardSyncRemote;
  localVersion(): Promise<string>;
  readLocal(): Promise<string>;
  writeLocal(json: string, version: string): Promise<string>;
  current(): boolean;
  digest(json: string): string;
  readonly inline?: boolean;
  readonly localReadCache?: LocalClipboardReadCache;
  trace?(stage: ClipboardSyncStage): void;
}

function skippableContent(error: unknown): boolean {
  return error instanceof ClipboardSyncError &&
    (error.reason === "empty" || error.reason === "unsupported" || error.reason === "too-large");
}

/** Serial sync: opaque versions trigger reads; proven content changes trigger writes. */
export class ClipboardSync {
  #pending = false;
  constructor(
    private readonly deps: ClipboardSyncDeps,
    private readonly baseline: ClipboardSyncBaseline = { local: "", remote: "" }
  ) {}

  private check(): void {
    if (!this.deps.current()) throw new ClipboardSyncError("expired");
  }
  private validVersion(version: string): string {
    if (typeof version !== "string" || !/^(?:[0-9]{1,128}|[0-9a-f]{64})$/u.test(version)) throw new ClipboardSyncError("unsupported");
    return version;
  }
  private async remoteVersion(): Promise<string> {
    const version = await this.deps.remote.version();
    this.check();
    return this.validVersion(version);
  }
  private rememberLocal(version: string, digest: string | undefined): void {
    if (this.deps.localReadCache) Object.assign(this.deps.localReadCache, { version, digest });
  }
  private async readLocal(version: string): Promise<{ json: string; digest: string }> {
    this.deps.trace?.("local-read-start");
    const json = await this.deps.readLocal();
    this.check();
    const digest = this.deps.digest(json);
    if ((await this.deps.localVersion()) !== version) throw new ClipboardSyncError("changed");
    this.check(); this.rememberLocal(version, digest);
    this.deps.trace?.("local-read-complete");
    return { json, digest };
  }
  private async cancel(id: string): Promise<void> {
    await this.deps.remote.cancel(id).catch(() => {});
  }
  private async readRemote(version: string): Promise<{ json: string; digest: string }> {
    let id: string | undefined;
    try {
      this.deps.trace?.("remote-read-start");
      const result = await this.deps.remote.copy(version, this.deps.inline === true);
      this.check();
      if (!Number.isSafeInteger(result.length) || result.length <= 0 || result.length > CLIPBOARD_SYNC_MAX_CHARS) {
        throw new ClipboardSyncError("too-large");
      }
      let json = "";
      if (this.deps.inline && typeof result.data === "string") {
        if (result.data.length > CLIPBOARD_SYNC_CHUNK_CHARS || result.data.length !== result.length) {
          throw new ClipboardSyncError("unsupported");
        }
        json = result.data;
      } else {
        if (typeof result.id !== "string" || !result.id) throw new ClipboardSyncError("unsupported");
        id = result.id;
        while (json.length < result.length) {
          this.check();
          const data = await this.deps.remote.read(id, json.length);
          this.check();
          if (typeof data !== "string" || !data.length || data.length > CLIPBOARD_SYNC_CHUNK_CHARS ||
            json.length + data.length > result.length) throw new ClipboardSyncError("unsupported");
          json += data;
        }
      }
      const digest = this.deps.digest(json);
      if ((await this.remoteVersion()) !== version) throw new ClipboardSyncError("changed");
      this.deps.trace?.("remote-read-complete");
      return { json, digest };
    } finally { if (id) void this.cancel(id); }
  }
  private async writeRemote(json: string, local: string, remote: string): Promise<string> {
    let id: string | undefined;
    try {
      this.check();
      let version: string;
      if (this.deps.inline && json.length <= CLIPBOARD_SYNC_CHUNK_CHARS) {
        if ((await this.deps.localVersion()) !== local) throw new ClipboardSyncError("changed");
        this.check();
        version = await this.deps.remote.paste(json, remote);
      } else {
        id = await this.deps.remote.begin(json.length, remote);
        this.check();
        if (typeof id !== "string" || !id) throw new ClipboardSyncError("unsupported");
        for (let offset = 0; offset < json.length; offset += CLIPBOARD_SYNC_CHUNK_CHARS) {
          this.check();
          await this.deps.remote.write(id, offset, json.slice(offset, offset + CLIPBOARD_SYNC_CHUNK_CHARS));
        }
        if ((await this.deps.localVersion()) !== local) throw new ClipboardSyncError("changed");
        this.check();
        version = await this.deps.remote.commit(id);
      }
      this.check();
      return this.validVersion(version);
    } finally { if (id) void this.cancel(id); }
  }

  async tick(): Promise<void> {
    if (this.#pending) return;
    this.#pending = true;
    let local: string | undefined, remote: string | undefined;
    let readLocalDigest: string | undefined, readRemoteDigest: string | undefined;
    try {
      this.check(); local = await this.deps.localVersion(); this.check(); remote = await this.remoteVersion();
      if (!this.baseline.local) {
        let digest: string | undefined;
        const cache = this.deps.localReadCache;
        if (cache?.version === local) digest = cache.digest;
        else {
          try { digest = (await this.readLocal(local)).digest; }
          catch (error) {
            if (!skippableContent(error)) throw error;
            this.deps.trace?.("content-skipped");
            if ((await this.deps.localVersion()) !== local) throw new ClipboardSyncError("changed");
          }
        }
        let remoteDigest: string | undefined;
        try { remoteDigest = (await this.readRemote(remote)).digest; }
        catch (error) {
          if (!skippableContent(error)) throw error;
          this.deps.trace?.("content-skipped");
          if ((await this.remoteVersion()) !== remote) throw new ClipboardSyncError("changed");
        }
        if ((await this.deps.localVersion()) !== local) throw new ClipboardSyncError("changed");
        this.check(); this.rememberLocal(local, digest);
        Object.assign(this.baseline, { local, remote, localDigest: digest, remoteDigest });
        return;
      }
      let localChanged = local !== this.baseline.local, remoteChanged = remote !== this.baseline.remote;
      if (!localChanged && !remoteChanged) return;
      const localContent = localChanged ? await this.readLocal(local).then(content => {
        readLocalDigest = content.digest; return content;
      }) : undefined;
      const remoteContent = remoteChanged ? await this.readRemote(remote).then(content => {
        readRemoteDigest = content.digest; return content;
      }) : undefined;
      this.check();
      if ((await this.deps.localVersion()) !== local) throw new ClipboardSyncError("changed");
      this.check();
      if (localContent?.digest === this.baseline.localDigest) localChanged = false;
      if (remoteContent?.digest === this.baseline.remoteDigest) remoteChanged = false;
      const localDigest = localContent?.digest ?? this.baseline.localDigest;
      const remoteDigest = remoteContent?.digest ?? this.baseline.remoteDigest;
      if (localDigest && localDigest === remoteDigest) { localChanged = false; remoteChanged = false; }
      if (localChanged && remoteChanged) {
        Object.assign(this.baseline, { local, remote, localDigest, remoteDigest });
        throw new ClipboardSyncError("conflict");
      }
      if (localChanged && localContent) {
        const version = await this.writeRemote(localContent.json, local, remote);
        const actual = await this.readRemote(version);
        Object.assign(this.baseline, { local, remote: version, localDigest: localContent.digest, remoteDigest: actual.digest });
        this.deps.trace?.("local-to-remote-complete");
      } else if (remoteChanged && remoteContent) {
        const written = await this.deps.writeLocal(remoteContent.json, local);
        this.check();
        const actual = await this.readLocal(written);
        Object.assign(this.baseline, { local: written, remote, localDigest: actual.digest, remoteDigest: remoteContent.digest });
        this.deps.trace?.("remote-to-local-complete");
      } else {
        Object.assign(this.baseline, { local, remote, localDigest, remoteDigest });
        this.deps.trace?.("unchanged-content");
      }
    } catch (error) {
      if (local !== undefined && remote !== undefined && skippableContent(error)) {
        this.check();
        Object.assign(this.baseline, { local, remote,
          localDigest: local === this.baseline.local ? this.baseline.localDigest : readLocalDigest,
          remoteDigest: remote === this.baseline.remote ? this.baseline.remoteDigest : readRemoteDigest });
        this.deps.trace?.("content-skipped");
        return;
      }
      throw error;
    } finally { this.#pending = false; }
  }
}
