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
  readonly driverSnapshotId?: string;
  readonly elements: Map<string, { readonly token: string; readonly index?: number }>;
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

  record(processId: number, windowId: number, driverSnapshotId?: string): string {
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
    this.#metadataById.set(id, { windowKey, processId, windowId, driverSnapshotId, elements: new Map() });
    return id;
  }

  registerElement(snapshotId: string, token: string, index?: number): string | undefined {
    const metadata = this.#metadataById.get(snapshotId);
    if (metadata === undefined || metadata.elements.size >= 2_000) return undefined;
    const key = `${snapshotId}:${metadata.elements.size}`;
    metadata.elements.set(key, { token, index });
    return key;
  }

  reference(snapshotId: string): { readonly snapshotId: string; readonly windowId: number; readonly driverSnapshotId?: string } | undefined {
    const id = this.#aliases.get(snapshotId) ?? snapshotId;
    const meta = this.#metadataById.get(id);
    return meta === undefined ? undefined : { snapshotId: id, windowId: meta.windowId, driverSnapshotId: meta.driverSnapshotId };
  }

  element(token: string): { readonly snapshotId: string; readonly token: string; readonly index?: number } | undefined {
    for (const [snapshotId, metadata] of this.#metadataById) {
      const element = metadata.elements.get(token);
      if (element !== undefined) return { snapshotId, ...element };
    }
    return undefined;
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

  invalidate(processId: number, windowId: number): void {
    // Retain old identities so a driver alias cannot later rebind to a fresh
    // observation and accidentally authorize an action from the failed view.
    this.#latestByWindow.delete(`${processId}\0${windowId}`);
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
