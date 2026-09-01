export type ComputerSnapshotValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "unknown_snapshot" | "superseded" | "window_mismatch";
      readonly latestSnapshotId?: string;
    };

interface SnapshotMeta {
  readonly windowKey: string;
  readonly processId: number;
  readonly windowId: number;
}

const MAXIMUM_WINDOWS = 256;
const MAXIMUM_SNAPSHOTS = 1_024;

export class ComputerWindowSnapshotTracker {
  readonly #latestByWindow = new Map<string, string>();
  readonly #metadataById = new Map<string, SnapshotMeta>();
  readonly #aliases = new Map<string, string>();
  readonly #idFactory: () => string;
  #sequence = 0;

  constructor(idFactory: () => string = () => Math.random().toString(36).slice(2, 10)) {
    this.#idFactory = idFactory;
  }

  record(processId: number, windowId: number): string {
    const windowKey = `${processId}\0${windowId}`;
    if (!this.#latestByWindow.has(windowKey) && this.#latestByWindow.size >= MAXIMUM_WINDOWS) {
      const oldest = this.#latestByWindow.keys().next().value as string | undefined;
      if (oldest !== undefined) this.#latestByWindow.delete(oldest);
    }
    while (this.#metadataById.size >= MAXIMUM_SNAPSHOTS) {
      const oldest = this.#metadataById.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#metadataById.delete(oldest);
      for (const [alias, snapshotId] of this.#aliases) {
        if (snapshotId === oldest) this.#aliases.delete(alias);
      }
    }
    this.#sequence += 1;
    const suffix = this.#idFactory().replace(/[^a-z0-9_-]/giu, "").slice(0, 20) || "snapshot";
    const id = `ws-${this.#sequence.toString(36)}-${suffix}`;
    this.#latestByWindow.set(windowKey, id);
    this.#metadataById.set(id, { windowKey, processId, windowId });
    return id;
  }

  registerAlias(snapshotId: string, alias: string): void {
    if (!this.#metadataById.has(snapshotId) || alias === snapshotId || alias.trim() === "") return;
    if (this.#aliases.has(alias)) return;
    if (this.#aliases.size >= MAXIMUM_SNAPSHOTS) {
      const oldest = this.#aliases.keys().next().value as string | undefined;
      if (oldest !== undefined) this.#aliases.delete(oldest);
    }
    this.#aliases.set(alias, snapshotId);
  }

  validate(
    snapshotId: string,
    processId: number,
    windowId?: number
  ): ComputerSnapshotValidation {
    const canonicalId = this.#aliases.get(snapshotId) ?? snapshotId;
    const metadata = this.#metadataById.get(canonicalId);
    if (metadata === undefined) return { ok: false, reason: "unknown_snapshot" };
    if (metadata.processId !== processId || (windowId !== undefined && metadata.windowId !== windowId)) {
      return {
        ok: false,
        reason: "window_mismatch",
        latestSnapshotId: this.#latestByWindow.get(metadata.windowKey)
      };
    }
    const latest = this.#latestByWindow.get(metadata.windowKey);
    if (latest !== canonicalId) return { ok: false, reason: "superseded", latestSnapshotId: latest };
    return { ok: true };
  }
}
