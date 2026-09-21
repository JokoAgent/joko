import { describe, expect, it, vi } from "vitest";
import {
  MOBILE_DIAGNOSTIC_EVENT_LIMIT,
  MOBILE_DIAGNOSTIC_RETENTION_MS,
  MobileDiagnosticsStore,
  mobileDiagnosticsTesting,
  projectMobileDiagnosticEvent,
  restoreMobileDiagnosticEvents,
  type MobileDiagnosticsExportDriver,
  type MobileDiagnosticsTemporaryFile
} from "./mobile-diagnostics";

const NOW = 2_000_000_000_000;

function storage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: vi.fn(async () => value),
    setItem: vi.fn(async (_key: string, next: string) => { value = next; }),
    read: () => value
  };
}

function exportDriver(patch: Partial<MobileDiagnosticsExportDriver> = {}) {
  let staged = new Uint8Array();
  const temporary: MobileDiagnosticsTemporaryFile = {
    uri: "file:///cache/joko-mobile-diagnostics/export/joko-mobile-diagnostics.json",
    directoryUri: "file:///cache/joko-mobile-diagnostics/export",
    byteSize: 0
  };
  const driver: MobileDiagnosticsExportDriver = {
    maintain: vi.fn(async () => undefined),
    sharingAvailable: vi.fn(async () => true),
    stage: vi.fn(async (bytes) => {
      staged = bytes;
      return { ...temporary, byteSize: bytes.byteLength };
    }),
    remove: vi.fn(async () => undefined),
    share: vi.fn(async () => undefined),
    ...patch
  };
  return { driver, staged: () => staged };
}

function event(at = NOW) {
  return { at, name: "connection.state", fields: { foreground: true, state: "connected" } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, resolve, reject };
}

describe("mobile diagnostic privacy projection", () => {
  it("accepts only exact event names and per-event bounded fields", () => {
    expect(projectMobileDiagnosticEvent(event(), NOW)).toEqual(event());
    expect(projectMobileDiagnosticEvent({
      at: NOW,
      name: "app.lifecycle",
      fields: { state: "background" }
    }, NOW)).toEqual({ at: NOW, name: "app.lifecycle", fields: { state: "background" } });
    expect(projectMobileDiagnosticEvent({ at: NOW, name: "js.stall", fields: { elapsedMs: 1_234 } }, NOW))
      .toEqual({ at: NOW, name: "js.stall", fields: { elapsedMs: 1_234 } });

    expect(projectMobileDiagnosticEvent({
      ...event(),
      fields: { ...event().fields, token: "secret", sessionId: "session-private" }
    }, NOW)).toBeUndefined();
    expect(projectMobileDiagnosticEvent({ at: NOW, name: "raw.error", fields: { message: "secret" } }, NOW))
      .toBeUndefined();
    expect(projectMobileDiagnosticEvent({ at: NOW + 1, name: "app.started", fields: { state: "active" } }, NOW))
      .toBeUndefined();
    expect(projectMobileDiagnosticEvent({ at: NOW, name: "js.stall", fields: { elapsedMs: 86_400_001 } }, NOW))
      .toBeUndefined();
  });

  it("reprojects the entire restored journal and removes only valid expired events", () => {
    expect(restoreMobileDiagnosticEvents([
      event(NOW - MOBILE_DIAGNOSTIC_RETENTION_MS - 1),
      event(NOW)
    ], NOW)).toEqual([event(NOW)]);
    expect(restoreMobileDiagnosticEvents([
      event(NOW),
      { at: NOW, name: "connection.state", fields: { foreground: true, state: "connected", path: "C:/private" } }
    ], NOW)).toEqual([]);
  });
});

describe("MobileDiagnosticsStore", () => {
  it("hydrates only strict current-v1 state, prunes retention, and records nothing while disabled", async () => {
    const saved = storage(JSON.stringify({
      version: 1,
      enabled: false,
      events: [event(NOW - MOBILE_DIAGNOSTIC_RETENTION_MS - 1), event(NOW)]
    }));
    const store = new MobileDiagnosticsStore(saved, exportDriver().driver, () => NOW, () => "export-1");
    const listener = vi.fn();
    store.subscribe(listener);

    await store.hydrate();
    store.record("app.lifecycle", { state: "active" });

    expect(store.snapshot).toMatchObject({ status: "ready", enabled: false, eventCount: 1 });
    expect(store.eventsForTesting()).toEqual([event(NOW)]);
    await store.flush();
    expect(JSON.parse(saved.read()!)).toEqual({ version: 1, enabled: false, events: [event(NOW)] });
    expect(listener).toHaveBeenCalled();
  });

  it.each([
    "not-json",
    JSON.stringify({ version: 0, enabled: true, events: [] }),
    JSON.stringify({ version: 1, enabled: true, events: [], legacy: true }),
    JSON.stringify({ version: 1, enabled: true, events: [{
      at: NOW,
      name: "connection.state",
      fields: { foreground: true, state: "connected", credential: "secret" }
    }] })
  ])("fails closed without restoring an invalid record: %s", async (raw) => {
    const store = new MobileDiagnosticsStore(storage(raw), exportDriver().driver, () => NOW, () => "export-1");

    await store.hydrate();

    expect(store.snapshot.status).toBe("error");
    expect(store.snapshot.enabled).toBe(false);
    expect(store.snapshot.eventCount).toBe(0);
    expect(store.eventsForTesting()).toEqual([]);
  });

  it("publishes enable only after durable storage and ignores non-allowlisted runtime input", async () => {
    const saved = storage();
    const write = deferred<void>();
    saved.setItem.mockImplementationOnce(async () => write.promise);
    const store = new MobileDiagnosticsStore(saved, exportDriver().driver, () => NOW, () => "export-1");
    await store.hydrate();

    const enabling = store.setEnabled(true);
    expect(store.snapshot).toMatchObject({ enabled: false, saving: true });
    store.record("app.lifecycle", { state: "active" });
    expect(store.snapshot.eventCount).toBe(0);
    write.resolve();
    await enabling;

    expect(store.snapshot).toMatchObject({ status: "ready", enabled: true, saving: false });
    store.record("connection.state", { foreground: true, state: "connected" });
    store.record("connection.state", { foreground: true, state: "connected", token: "secret" });
    expect(() => store.record("connection.state", new Proxy({}, {
      ownKeys: () => { throw new Error("untrusted fields"); }
    }))).not.toThrow();
    expect(store.eventsForTesting()).toEqual([event(NOW)]);
  });

  it("does not let a concurrent lifecycle flush overwrite an enable that is not yet durable", async () => {
    const saved = storage();
    const write = deferred<void>();
    saved.setItem.mockImplementationOnce(async () => write.promise);
    const store = new MobileDiagnosticsStore(saved, exportDriver().driver, () => NOW, () => "export-1");
    await store.hydrate();

    const enabling = store.setEnabled(true);
    const flushing = store.flush();
    write.resolve();
    await enabling;
    await flushing;

    expect(saved.setItem).toHaveBeenCalledOnce();
    expect(JSON.parse(saved.setItem.mock.calls[0]![1])).toEqual({ version: 1, enabled: true, events: [] });
    expect(store.snapshot.enabled).toBe(true);
  });

  it("coalesces repeated lifecycle flushes while the same revision is being written", async () => {
    const saved = storage(JSON.stringify({ version: 1, enabled: true, events: [] }));
    const store = new MobileDiagnosticsStore(saved, exportDriver().driver, () => NOW, () => "export-1");
    await store.hydrate();
    store.record("app.lifecycle", { state: "active" });
    const write = deferred<void>();
    saved.setItem.mockImplementationOnce(async () => write.promise);

    const first = store.flush();
    const second = store.flush();
    const third = store.flush();
    write.resolve();
    await Promise.all([first, second, third]);

    expect(saved.setItem).toHaveBeenCalledOnce();
  });

  it("stops runtime recording immediately when a durable opt-out fails", async () => {
    const saved = storage(JSON.stringify({ version: 1, enabled: true, events: [] }));
    const store = new MobileDiagnosticsStore(saved, exportDriver().driver, () => NOW, () => "export-1");
    await store.hydrate();
    saved.setItem.mockRejectedValueOnce(new Error("disk locked"));

    const disabling = store.setEnabled(false);
    expect(store.snapshot.enabled).toBe(false);
    await expect(disabling).rejects.toThrow("Recording is off for this run");
    store.record("app.lifecycle", { state: "background" });

    expect(store.snapshot).toMatchObject({ status: "error", enabled: false, eventCount: 0 });
  });

  it("bounds the journal and serializes clear after an older in-flight flush", async () => {
    const saved = storage(JSON.stringify({ version: 1, enabled: true, events: [] }));
    const store = new MobileDiagnosticsStore(saved, exportDriver().driver, () => NOW, () => "export-1");
    await store.hydrate();
    for (let index = 0; index < MOBILE_DIAGNOSTIC_EVENT_LIMIT + 20; index += 1) {
      store.record("js.stall", { elapsedMs: index });
    }
    expect(store.snapshot.eventCount).toBe(MOBILE_DIAGNOSTIC_EVENT_LIMIT);

    const firstWrite = deferred<void>();
    saved.setItem.mockImplementationOnce(async () => firstWrite.promise);
    const flushing = store.flush();
    const clearing = store.clear();
    expect(store.snapshot.eventCount).toBe(0);
    firstWrite.resolve();
    await flushing;
    await clearing;

    expect(saved.setItem).toHaveBeenCalledTimes(2);
    expect(JSON.parse(saved.setItem.mock.calls.at(-1)![1])).toEqual({ version: 1, enabled: true, events: [] });
    expect(store.eventsForTesting()).toEqual([]);
  });

  it("exports a reprojected bounded JSON file, retains dispatched bytes, and blocks duplicate export", async () => {
    const saved = storage(JSON.stringify({ version: 1, enabled: true, events: [event(NOW)] }));
    const share = deferred<void>();
    const native = exportDriver({ share: vi.fn(async () => share.promise) });
    const store = new MobileDiagnosticsStore(saved, native.driver, () => NOW, () => "export-1");
    await store.hydrate();

    const exporting = store.export({ appVersion: "1.2.3", platform: "android" });
    await vi.waitFor(() => expect(native.driver.share).toHaveBeenCalledOnce());
    expect(store.snapshot.exporting).toBe(true);
    await expect(store.export({ appVersion: "1.2.3", platform: "android" }))
      .rejects.toThrow("already in progress");
    share.resolve();
    await exporting;

    const payload = JSON.parse(new TextDecoder().decode(native.staged()));
    expect(payload).toEqual({
      format: "joko.mobile.diagnostics",
      version: 1,
      generatedAt: NOW,
      app: { appVersion: "1.2.3", platform: "android" },
      retentionDays: 7,
      events: [event(NOW)]
    });
    expect(native.driver.maintain).toHaveBeenCalledOnce();
    expect(native.driver.stage).toHaveBeenCalledWith(expect.any(Uint8Array), "export-1");
    expect(native.driver.remove).not.toHaveBeenCalled();
    expect(store.snapshot).toMatchObject({ status: "ready", exporting: false });
  });

  it("cleans a staged export when native sharing fails and never stages when sharing is unavailable", async () => {
    const saved = storage(JSON.stringify({ version: 1, enabled: false, events: [] }));
    const failed = exportDriver({ share: vi.fn(async () => { throw new Error("sheet failed"); }) });
    const store = new MobileDiagnosticsStore(saved, failed.driver, () => NOW, () => "export-1");
    await store.hydrate();

    await expect(store.export({ appVersion: "bad version with spaces", platform: "unknown" }))
      .rejects.toThrow("sheet failed");
    expect(failed.driver.remove).toHaveBeenCalledOnce();
    expect(store.snapshot.status).toBe("error");

    const unavailable = exportDriver({ sharingAvailable: vi.fn(async () => false) });
    const second = new MobileDiagnosticsStore(saved, unavailable.driver, () => NOW, () => "export-2");
    await second.hydrate();
    await expect(second.export({ appVersion: "1.0.0", platform: "ios" })).rejects.toThrow("unavailable");
    expect(unavailable.driver.stage).not.toHaveBeenCalled();
  });

  it("does not hide an unreadable saved preference merely because a sanitized export succeeds", async () => {
    const saved = storage("damaged");
    const native = exportDriver();
    const store = new MobileDiagnosticsStore(saved, native.driver, () => NOW, () => "export-1");
    await store.hydrate();
    expect(store.snapshot.status).toBe("error");

    await store.export({ appVersion: "1.0.0", platform: "ios" });

    expect(store.snapshot.status).toBe("error");
    expect(store.snapshot.error).toContain("Saved local diagnostics are unavailable");
    expect(native.driver.share).toHaveBeenCalledOnce();
  });

  it("uses only the Joko-owned current-v1 storage and cache names", () => {
    expect(mobileDiagnosticsTesting).toEqual({
      exportFileName: "joko-mobile-diagnostics.json",
      exportRoot: "joko-mobile-diagnostics",
      storageKey: "joko.mobile.diagnostics.v1"
    });
  });
});
