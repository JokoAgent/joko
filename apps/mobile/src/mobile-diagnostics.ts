import type { MobilePlainStorageDriver } from "./connection-storage";

export const MOBILE_DIAGNOSTIC_EVENT_LIMIT = 500;
export const MOBILE_DIAGNOSTIC_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const MOBILE_DIAGNOSTIC_STORAGE_BYTES = 256 * 1_024;

const STORAGE_KEY = "joko.mobile.diagnostics.v1";
const EXPORT_ROOT = "joko-mobile-diagnostics";
const EXPORT_FILE_NAME = "joko-mobile-diagnostics.json";
const CONNECTION_STATES = ["starting", "unpaired", "connecting", "connected", "offline", "revoked"] as const;
const APP_STATES = ["active", "inactive", "background", "unknown"] as const;

export type MobileDiagnosticEventName = "app.started" | "app.lifecycle" | "connection.state" | "js.stall";
export type MobileDiagnosticField = boolean | number | string;

export interface MobileDiagnosticEvent {
  readonly at: number;
  readonly name: MobileDiagnosticEventName;
  readonly fields: Readonly<Record<string, MobileDiagnosticField>>;
}

export interface MobileDiagnosticsState {
  readonly status: "loading" | "ready" | "error";
  readonly enabled: boolean;
  readonly saving: boolean;
  readonly exporting: boolean;
  readonly eventCount: number;
  readonly error?: string;
}

export interface MobileDiagnosticsTemporaryFile {
  readonly uri: string;
  readonly directoryUri: string;
  readonly byteSize: number;
}

export interface MobileDiagnosticsExportDriver {
  maintain(): Promise<void>;
  sharingAvailable(): Promise<boolean>;
  stage(bytes: Uint8Array, operationId: string): Promise<MobileDiagnosticsTemporaryFile>;
  remove(file: MobileDiagnosticsTemporaryFile): Promise<void>;
  share(file: MobileDiagnosticsTemporaryFile): Promise<void>;
}

export interface MobileDiagnosticsExportMetadata {
  readonly appVersion: string;
  readonly platform: "android" | "ios" | "unknown";
}

export class MobileDiagnosticsStore {
  #state: MobileDiagnosticsState = {
    status: "loading",
    enabled: false,
    saving: false,
    exporting: false,
    eventCount: 0
  };
  #events: MobileDiagnosticEvent[] = [];
  #listeners = new Set<() => void>();
  #hydrate?: Promise<void>;
  #hydrated = false;
  #enabled = false;
  #exporting = false;
  #persistenceError?: string;
  #actionError?: string;
  #revision = 0;
  #persistedRevision = 0;
  #writeTail = Promise.resolve();
  #flushInFlight?: Promise<void>;
  #maintenance?: Promise<void>;

  constructor(
    private readonly storage: Pick<MobilePlainStorageDriver, "getItem" | "setItem">,
    private readonly exportDriver: MobileDiagnosticsExportDriver = expoMobileDiagnosticsExportDriver,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = fallbackId
  ) {}

  get snapshot(): MobileDiagnosticsState { return this.#state; }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  hydrate(): Promise<void> {
    if (this.#hydrated) return Promise.resolve();
    if (!this.#hydrate) this.#hydrate = this.#read();
    return this.#hydrate;
  }

  async maintainExportCache(): Promise<void> {
    try {
      await this.#maintain();
    } catch (cause) {
      if (this.#hydrated) {
        this.#publishActionError(`The old local diagnostic export could not be removed: ${errorText(cause)}`);
      }
      throw cause;
    }
  }

  async setEnabled(value: boolean): Promise<void> {
    if (!this.#hydrated) await this.hydrate();
    if (typeof value !== "boolean") throw new Error("The local diagnostics preference is invalid.");
    if (this.#state.saving) throw new Error("A local diagnostics preference is already being saved.");
    if (this.#exporting) throw new Error("Wait for the local diagnostics export to finish.");
    if (this.#enabled === value && this.#state.status === "ready") return;

    this.#prune(this.now());

    if (!value) this.#enabled = false;
    this.#publish({
      status: this.#state.status,
      enabled: value ? false : this.#enabled,
      saving: true,
      exporting: false,
      eventCount: this.#events.length
    });
    const revision = ++this.#revision;
    try {
      await this.#persist(revision, value);
      this.#enabled = value;
      this.#publishReady(true);
    } catch (cause) {
      this.#enabled = false;
      const outcome = value
        ? "Recording remains off."
        : "Recording is off for this run, but the saved preference could not be confirmed.";
      const error = `The local diagnostics preference could not be saved. ${outcome} ${errorText(cause)}`;
      this.#publishPersistenceError(error);
      throw new Error(error);
    }
  }

  record(name: MobileDiagnosticEventName, fields: Readonly<Record<string, unknown>>): void {
    try {
      if (!this.#hydrated || !this.#enabled) return;
      const now = this.now();
      const event = projectMobileDiagnosticEvent({ at: now, name, fields }, now);
      if (!event) return;
      this.#prune(now);
      this.#events.push(event);
      if (this.#events.length > MOBILE_DIAGNOSTIC_EVENT_LIMIT) {
        this.#events.splice(0, this.#events.length - MOBILE_DIAGNOSTIC_EVENT_LIMIT);
      }
      this.#revision += 1;
      this.#publish({ ...this.#state, enabled: this.#enabled, eventCount: this.#events.length });
    } catch {
      // Best-effort instrumentation must never affect the product path it observes.
    }
  }

  async flush(): Promise<void> {
    if (!this.#hydrated) await this.hydrate();
    if (this.#state.saving) {
      await this.#writeTail;
      return;
    }
    if (this.#flushInFlight) {
      await this.#flushInFlight;
      if (this.#revision > this.#persistedRevision) await this.flush();
      return;
    }
    this.#prune(this.now());
    if (this.#revision <= this.#persistedRevision) {
      await this.#writeTail;
      return;
    }
    const revision = this.#revision;
    const action = (async () => {
      try {
        await this.#persist(revision, this.#enabled);
        if (!this.#state.saving && !this.#state.exporting) this.#publishReady(true);
      } catch (cause) {
        const error = `Local diagnostic events could not be saved: ${errorText(cause)}`;
        this.#publishPersistenceError(error);
        throw new Error(error);
      }
    })();
    const tracked = action.finally(() => {
      if (this.#flushInFlight === tracked) this.#flushInFlight = undefined;
    });
    this.#flushInFlight = tracked;
    await tracked;
  }

  async clear(): Promise<void> {
    if (!this.#hydrated) await this.hydrate();
    if (this.#state.saving || this.#exporting) {
      throw new Error("Wait for the current local diagnostics action to finish.");
    }
    this.#events = [];
    const revision = ++this.#revision;
    this.#publish({ ...this.#state, saving: true, eventCount: 0, error: undefined });
    try {
      await this.#persist(revision, this.#enabled);
      this.#publishReady(true);
    } catch (cause) {
      const error = `Local diagnostics could not be cleared durably: ${errorText(cause)}`;
      this.#publishPersistenceError(error);
      throw new Error(error);
    }
  }

  async export(metadata: MobileDiagnosticsExportMetadata): Promise<void> {
    if (!this.#hydrated) await this.hydrate();
    if (this.#exporting) throw new Error("A local diagnostics export is already in progress.");
    if (this.#state.saving) throw new Error("Wait for the local diagnostics preference to finish saving.");
    const normalized = normalizeExportMetadata(metadata);
    this.#exporting = true;
    this.#publish({ ...this.#state, exporting: true });
    let temporary: MobileDiagnosticsTemporaryFile | undefined;
    let dispatched = false;
    try {
      await this.flush().catch(() => undefined);
      await this.#maintain();
      if (!await this.exportDriver.sharingAvailable()) {
        throw new Error("System sharing is unavailable on this device.");
      }
      const generatedAt = this.now();
      const events = restoreMobileDiagnosticEvents(this.#events, generatedAt);
      const bytes = new TextEncoder().encode(JSON.stringify({
        format: "joko.mobile.diagnostics",
        version: 1,
        generatedAt,
        app: normalized,
        retentionDays: 7,
        events
      }));
      if (bytes.byteLength > MOBILE_DIAGNOSTIC_STORAGE_BYTES) {
        throw new Error("The bounded local diagnostics export is unexpectedly large.");
      }
      temporary = await this.exportDriver.stage(bytes, safeOperationId(this.newId()));
      if (!validTemporaryFile(temporary) || temporary.byteSize !== bytes.byteLength) {
        throw new Error("The local diagnostics export failed byte verification.");
      }
      await this.exportDriver.share(temporary);
      dispatched = true;
      this.#publishReady(false, true);
    } catch (cause) {
      const error = `Local diagnostics could not be exported: ${errorText(cause)}`;
      this.#publishActionError(error);
      throw new Error(error);
    } finally {
      if (temporary && !dispatched) {
        try { await this.exportDriver.remove(temporary); }
        catch { /* Preserve the original action result; next maintenance retries cleanup. */ }
      }
      this.#exporting = false;
      if (this.#state.exporting) this.#publish({ ...this.#state, exporting: false });
    }
  }

  eventsForTesting(): readonly MobileDiagnosticEvent[] {
    return restoreMobileDiagnosticEvents(this.#events, this.now());
  }

  async #read(): Promise<void> {
    try {
      const raw = await this.storage.getItem(STORAGE_KEY);
      if (raw !== null) {
        const parsed = parseStoredDiagnostics(raw, this.now());
        this.#enabled = parsed.enabled;
        this.#events = parsed.events;
        if (parsed.pruned) this.#revision += 1;
      }
      this.#hydrated = true;
      this.#publishReady(true);
    } catch (cause) {
      this.#hydrated = true;
      this.#enabled = false;
      this.#events = [];
      this.#revision = 0;
      this.#persistedRevision = 0;
      this.#publishPersistenceError(
        `Saved local diagnostics are unavailable. Recording is off and no saved events were loaded: ${errorText(cause)}`
      );
    }
  }

  #prune(now: number): void {
    const retained = this.#events.filter((event) => event.at >= now - MOBILE_DIAGNOSTIC_RETENTION_MS && event.at <= now);
    if (retained.length === this.#events.length) return;
    this.#events = retained;
    this.#revision += 1;
    this.#publish({ ...this.#state, eventCount: retained.length });
  }

  async #persist(revision: number, enabled: boolean): Promise<void> {
    const events = restoreMobileDiagnosticEvents(this.#events, this.now());
    const serialized = JSON.stringify({ version: 1, enabled, events });
    if (new TextEncoder().encode(serialized).byteLength > MOBILE_DIAGNOSTIC_STORAGE_BYTES) {
      throw new Error("the bounded current-v1 record exceeds its storage budget");
    }
    const pending = this.#writeTail.then(() => this.storage.setItem(STORAGE_KEY, serialized));
    this.#writeTail = pending.catch(() => undefined);
    await pending;
    this.#persistedRevision = Math.max(this.#persistedRevision, revision);
  }

  #maintain(): Promise<void> {
    if (!this.#maintenance) {
      const pending = this.exportDriver.maintain().finally(() => {
        if (this.#maintenance === pending) this.#maintenance = undefined;
      });
      this.#maintenance = pending;
    }
    return this.#maintenance;
  }

  #publishReady(clearPersistence = false, clearAction = false): void {
    if (clearPersistence) this.#persistenceError = undefined;
    if (clearAction) this.#actionError = undefined;
    const error = this.#actionError ?? this.#persistenceError;
    this.#publish({
      status: error ? "error" : "ready",
      enabled: this.#enabled,
      saving: false,
      exporting: this.#exporting,
      eventCount: this.#events.length,
      ...(error ? { error } : {})
    });
  }

  #publishPersistenceError(error: string): void {
    this.#persistenceError = error;
    this.#publishErrors();
  }

  #publishActionError(error: string): void {
    this.#actionError = error;
    this.#publishErrors();
  }

  #publishErrors(): void {
    const error = this.#actionError ?? this.#persistenceError!;
    this.#publish({
      status: "error",
      enabled: this.#enabled,
      saving: false,
      exporting: this.#exporting,
      eventCount: this.#events.length,
      error
    });
  }

  #publish(state: MobileDiagnosticsState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}

export function projectMobileDiagnosticEvent(value: unknown, now = Date.now()): MobileDiagnosticEvent | undefined {
  if (!isRecord(value) || !exactKeys(value, ["at", "fields", "name"])) return undefined;
  if (!Number.isSafeInteger(value.at) || (value.at as number) < 0 || (value.at as number) > now) return undefined;
  if (!isRecord(value.fields)) return undefined;
  const fields = value.fields;
  switch (value.name) {
    case "app.started":
    case "app.lifecycle":
      if (!exactKeys(fields, ["state"]) || !includes(APP_STATES, fields.state)) return undefined;
      return { at: value.at as number, name: value.name, fields: { state: fields.state } };
    case "connection.state":
      if (!exactKeys(fields, ["foreground", "state"]) || !includes(CONNECTION_STATES, fields.state)
        || typeof fields.foreground !== "boolean") return undefined;
      return { at: value.at as number, name: value.name, fields: {
        foreground: fields.foreground,
        state: fields.state
      } };
    case "js.stall":
      if (!exactKeys(fields, ["elapsedMs"]) || !boundedTiming(fields.elapsedMs)) return undefined;
      return { at: value.at as number, name: value.name, fields: { elapsedMs: fields.elapsedMs } };
    default:
      return undefined;
  }
}

export function restoreMobileDiagnosticEvents(value: unknown, now = Date.now()): MobileDiagnosticEvent[] {
  if (!Array.isArray(value) || value.length > MOBILE_DIAGNOSTIC_EVENT_LIMIT) return [];
  const events: MobileDiagnosticEvent[] = [];
  for (const row of value) {
    const event = projectMobileDiagnosticEvent(row, now);
    if (!event) return [];
    if (event.at >= now - MOBILE_DIAGNOSTIC_RETENTION_MS) events.push(event);
  }
  return events;
}

function parseStoredDiagnostics(raw: string, now: number): {
  readonly enabled: boolean;
  readonly events: MobileDiagnosticEvent[];
  readonly pruned: boolean;
} {
  if (new TextEncoder().encode(raw).byteLength > MOBILE_DIAGNOSTIC_STORAGE_BYTES) {
    throw new Error("the record exceeds its storage budget");
  }
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || !exactKeys(value, ["enabled", "events", "version"])
    || value.version !== 1 || typeof value.enabled !== "boolean" || !Array.isArray(value.events)
    || value.events.length > MOBILE_DIAGNOSTIC_EVENT_LIMIT) {
    throw new Error("the record is not the strict current-v1 shape");
  }
  const events = restoreMobileDiagnosticEvents(value.events, now);
  if (events.length === 0 && value.events.length > 0) {
    const allExpired = value.events.every((row) => {
      const event = projectMobileDiagnosticEvent(row, now);
      return event !== undefined && event.at < now - MOBILE_DIAGNOSTIC_RETENTION_MS;
    });
    if (!allExpired) throw new Error("the event journal failed its privacy projection");
  } else if (events.length < value.events.length) {
    for (const row of value.events) {
      if (!projectMobileDiagnosticEvent(row, now)) throw new Error("the event journal failed its privacy projection");
    }
  }
  return { enabled: value.enabled, events, pruned: events.length !== value.events.length };
}

function normalizeExportMetadata(metadata: MobileDiagnosticsExportMetadata): MobileDiagnosticsExportMetadata {
  const version = typeof metadata?.appVersion === "string" ? metadata.appVersion.trim() : "";
  const appVersion = version.length > 0 && version.length <= 64 && /^[A-Za-z0-9._+-]+$/u.test(version)
    ? version
    : "unknown";
  const platform = metadata?.platform === "android" || metadata?.platform === "ios" ? metadata.platform : "unknown";
  return { appVersion, platform };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function boundedTiming(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 86_400_000;
}

function safeOperationId(value: string): string {
  const exact = typeof value === "string" ? value.trim() : "";
  if (!exact || exact.length > 128 || !/^[A-Za-z0-9_-]+$/u.test(exact)) {
    throw new Error("The local diagnostics export identity is invalid.");
  }
  return exact;
}

function validTemporaryFile(file: MobileDiagnosticsTemporaryFile): boolean {
  return Boolean(file && typeof file.uri === "string" && typeof file.directoryUri === "string"
    && file.directoryUri.length > 0 && file.uri.startsWith(`${file.directoryUri}/`)
    && file.uri.endsWith(`/${EXPORT_FILE_NAME}`) && Number.isSafeInteger(file.byteSize) && file.byteSize >= 0);
}

function fallbackId(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function errorText(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : "storage or native sharing failed";
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

const expoMobileDiagnosticsExportDriver: MobileDiagnosticsExportDriver = {
  async maintain() {
    const { Directory, Paths } = await import("expo-file-system");
    const root = new Directory(Paths.cache, EXPORT_ROOT);
    if (root.exists) root.delete();
  },
  async sharingAvailable() {
    const Sharing = await import("expo-sharing");
    return Sharing.isAvailableAsync();
  },
  async stage(bytes, operationId) {
    const { Directory, File, Paths } = await import("expo-file-system");
    const root = new Directory(Paths.cache, EXPORT_ROOT);
    root.create({ idempotent: true, intermediates: true });
    const directory = new Directory(root, operationId);
    directory.create();
    const file = new File(directory, EXPORT_FILE_NAME);
    try {
      file.create();
      file.write(bytes);
      const written = await file.bytes();
      if (!equalBytes(bytes, written)) throw new Error("The staged local diagnostics file failed readback verification.");
      return {
        uri: file.uri,
        directoryUri: directory.uri.replace(/\/$/u, ""),
        byteSize: written.byteLength
      };
    } catch (error) {
      if (directory.exists) directory.delete();
      throw error;
    }
  },
  async remove(temporary) {
    const { Directory, Paths } = await import("expo-file-system");
    const root = new Directory(Paths.cache, EXPORT_ROOT);
    const prefix = root.uri.endsWith("/") ? root.uri : `${root.uri}/`;
    const directory = new Directory(temporary.directoryUri);
    if (!directory.uri.startsWith(prefix) || directory.uri === root.uri) {
      throw new Error("Refusing to remove a directory outside the local diagnostics cache.");
    }
    if (directory.exists) directory.delete();
  },
  async share(file) {
    const Sharing = await import("expo-sharing");
    await Sharing.shareAsync(file.uri, { mimeType: "application/json", UTI: "public.json" });
  }
};

export const mobileDiagnosticsTesting = {
  exportFileName: EXPORT_FILE_NAME,
  exportRoot: EXPORT_ROOT,
  storageKey: STORAGE_KEY
};
