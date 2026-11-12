export type ComputerSnapshotValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "unknown_snapshot" | "superseded" | "window_mismatch";
      readonly latestSnapshotId?: string;
    };

export interface ComputerScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface ComputerWindowObservationScope {
  readonly query?: string;
  readonly max_elements?: number;
  readonly max_depth?: number;
}

interface SnapshotElement {
  readonly token: string;
  readonly index?: number;
  readonly point?: ComputerScreenPoint;
}

interface SnapshotMeta {
  readonly windowKey: string;
  readonly processId: number;
  readonly windowId: number;
  readonly driverSnapshotId?: string;
  readonly elements: Map<string, SnapshotElement>;
  elementPoints?: Map<number, ComputerScreenPoint | undefined>;
}

const MAXIMUM_WINDOWS = 256;
const MAXIMUM_SNAPSHOTS = 1_024;
const MAXIMUM_ELEMENTS = 2_000;

export class ComputerWindowSnapshotTracker {
  readonly #latestByWindow = new Map<string, { readonly id?: string; readonly scope: ComputerWindowObservationScope }>();
  readonly #metadataById = new Map<string, SnapshotMeta>();
  readonly #aliases = new Map<string, string>();
  readonly #idFactory: () => string;
  #sequence = 0;

  constructor(idFactory: () => string = () => Math.random().toString(36).slice(2, 10)) {
    this.#idFactory = idFactory;
  }

  record(processId: number, windowId: number, driverSnapshotId?: string, scope: ComputerWindowObservationScope = {}): string {
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
    this.#latestByWindow.set(windowKey, { id, scope });
    this.#metadataById.set(id, { windowKey, processId, windowId, driverSnapshotId, elements: new Map() });
    return id;
  }

  registerElement(snapshotId: string, token: string, index?: number, point?: ComputerScreenPoint): string | undefined {
    const metadata = this.#metadataById.get(snapshotId);
    if (metadata === undefined || metadata.elements.size >= MAXIMUM_ELEMENTS) return undefined;
    const key = `${snapshotId}:${metadata.elements.size}`;
    metadata.elements.set(key, { token, index, ...(point === undefined ? {} : { point }) });
    return key;
  }

  recordElementPoint(snapshotId: string, index: number, point: ComputerScreenPoint | undefined): void {
    const metadata = this.#metadataById.get(snapshotId);
    if (metadata === undefined || !Number.isSafeInteger(index) || index < 0) return;
    const points = metadata.elementPoints ??= new Map();
    if (points.has(index)) points.set(index, undefined);
    else if (points.size < MAXIMUM_ELEMENTS) points.set(index, point);
  }

  elementPoint(snapshotId: string, index: number): ComputerScreenPoint | undefined {
    const id = this.#aliases.get(snapshotId) ?? snapshotId;
    return this.#metadataById.get(id)?.elementPoints?.get(index);
  }

  reference(snapshotId: string): { readonly snapshotId: string; readonly windowId: number; readonly driverSnapshotId?: string } | undefined {
    const id = this.#aliases.get(snapshotId) ?? snapshotId;
    const meta = this.#metadataById.get(id);
    return meta === undefined ? undefined : { snapshotId: id, windowId: meta.windowId, driverSnapshotId: meta.driverSnapshotId };
  }

  element(token: string): ({ readonly snapshotId: string } & SnapshotElement) | undefined {
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
    const key = `${processId}\0${windowId}`;
    const previous = this.#latestByWindow.get(key);
    if (previous !== undefined) this.#latestByWindow.set(key, { scope: previous.scope });
  }

  observationScope(processId: number, windowId: number): ComputerWindowObservationScope | undefined {
    return this.#latestByWindow.get(`${processId}\0${windowId}`)?.scope;
  }

  resetTransportReferences(): void {
    this.#metadataById.clear();
    this.#aliases.clear();
    for (const [key, { scope }] of this.#latestByWindow) this.#latestByWindow.set(key, { scope });
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
        latestSnapshotId: this.#latestByWindow.get(metadata.windowKey)?.id
      };
    }
    const latest = this.#latestByWindow.get(metadata.windowKey)?.id;
    if (latest !== canonicalId) return { ok: false, reason: "superseded", latestSnapshotId: latest };
    return { ok: true };
  }
}
