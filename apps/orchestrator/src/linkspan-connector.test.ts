import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startQuickTunnel, type CloudflareTunnelExit } from "@jokoagent/linkspan-cloudflare";
import { OperationalStore } from "@joko/store";
import { afterEach, expect, it, vi } from "vitest";
import type { OrchestratorApplication } from "./application.js";
import { advertisedLinkspanOrigin, startManagedLinkspanConnector } from "./linkspan-connector.js";

vi.mock("@jokoagent/linkspan-cloudflare", () => ({ startQuickTunnel: vi.fn() }));
afterEach(() => vi.resetAllMocks());

const journal = "runtime.linkspan.quick";
const originTls = { originCaPool: "/pinned/origin.pem", originServerName: "localhost" };
interface Record { requestId: string; processId?: number; state: "starting" | "active" | "closed"; publicOrigin?: string }

it("advertises only the current owned publication and withdraws it before an uncertain close", async () => {
  const store = new OperationalStore(":memory:"), origin = "https://owned.trycloudflare.com", fallback = "http://127.0.0.1:4318";
  const application = { store, serverId: "node" } as OrchestratorApplication;
  let resolveClosed!: (value: CloudflareTunnelExit) => void;
  const closed = new Promise<CloudflareTunnelExit>(resolve => { resolveClosed = resolve; });
  vi.mocked(startQuickTunnel).mockImplementationOnce(async options => ({ kind: "cloudflare.quick", requestId: options.requestId, processId: process.pid,
    publicOrigin: origin, limits: { temporaryHostname: true, maximumInflightRequests: 200, serverSentEvents: false,
      serviceLevelAgreement: false, intendedUse: "testing-and-development" }, closed,
    close: async () => { throw Object.assign(new Error("Shutdown was not confirmed."), { code: "cleanup_failed" }); } }));
  try {
    store.setSetting("service", "orchestrator", journal, { requestId: "restored", state: "active", processId: process.pid, publicOrigin: origin });
    expect(advertisedLinkspanOrigin(store, fallback)).toBe(fallback);
    store.setSetting("service", "orchestrator", journal, { requestId: "restored", state: "closed", processId: process.pid, publicOrigin: origin });
    const resource = await startManagedLinkspanConnector(application, { executable: "/pinned/helper", localOrigin: "https://127.0.0.1:4400", ...originTls });
    expect(startQuickTunnel).toHaveBeenCalledWith(expect.objectContaining({ localOrigin: "https://127.0.0.1:4400", ...originTls }));
    expect(resource.limits).toMatchObject({ temporaryHostname: true, maximumInflightRequests: 200, serviceLevelAgreement: false });
    const active = store.findSetting<Record>("service", "orchestrator", journal)!.value;
    expect(store.getOperation(active.requestId).response).toMatchObject({ publicOrigin: origin, limits: resource.limits });
    expect(advertisedLinkspanOrigin(store, fallback)).toBe(origin);
    await expect(resource.close()).rejects.toMatchObject({ code: "cleanup_failed" });
    expect(store.findSetting<Record>("service", "orchestrator", journal)!.value.state).toBe("active");
    expect(advertisedLinkspanOrigin(store, fallback)).toBe(fallback);
    resolveClosed({ reason: "stopped", exitCode: 0, signal: null }); await Promise.resolve();
    expect(store.findSetting<Record>("service", "orchestrator", journal)!.value.state).toBe("closed");
  } finally { store.close(); }
});

it("retains the original pending effect and refuses replacement while helper cleanup remains unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-connector-journal-"));
  const database = join(root, "store.db");
  let store = new OperationalStore(database);
  const input = { executable: join(root, "pinned-helper"), localOrigin: "https://127.0.0.1:4400", ...originTls };
  const start = vi.mocked(startQuickTunnel);
  start.mockImplementationOnce(async options => {
    options.onSpawn?.({ processId: process.pid, requestId: options.requestId });
    throw Object.assign(new Error("The owned process did not confirm shutdown."), { code: "cleanup_failed" });
  });
  try {
    await expect(startManagedLinkspanConnector({ store, serverId: "node" } as OrchestratorApplication, input)).rejects.toMatchObject({ code: "cleanup_failed" });
    const pending = store.findSetting<Record>("service", "orchestrator", journal)!.value;
    expect(pending).toMatchObject({ processId: process.pid, state: "starting" });
    expect(store.getOperation(pending.requestId).status).toBe("started");
    store.close();
    store = new OperationalStore(database);
    await expect(startManagedLinkspanConnector({ store, serverId: "node" } as OrchestratorApplication, input)).rejects.toThrow("cleanup is unconfirmed");
    expect(start).toHaveBeenCalledTimes(1);
    expect(store.findSetting<Record>("service", "orchestrator", journal)!.value).toEqual(pending);
    expect(store.getOperation(pending.requestId).status).toBe("started");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

it("records a confirmed failed startup as retired before a new resource can be attempted", async () => {
  const store = new OperationalStore(":memory:");
  const application = { store, serverId: "node" } as OrchestratorApplication;
  vi.mocked(startQuickTunnel).mockRejectedValueOnce(Object.assign(new Error("Helper failed after confirmed retirement."), { code: "unavailable" }));
  try {
    await expect(startManagedLinkspanConnector(application, { executable: "/pinned/helper", localOrigin: "https://127.0.0.1:4400", ...originTls })).rejects.toMatchObject({ code: "unavailable" });
    const retired = store.findSetting<Record>("service", "orchestrator", journal)!.value;
    expect(retired.state).toBe("closed");
    expect(store.getOperation(retired.requestId)).toMatchObject({ status: "completed", response: { state: "closed", reason: "startup_failed_and_child_retired" } });
  } finally { store.close(); }
});

it("keeps an active resource recorded when its close receipt is unavailable", async () => {
  const store = new OperationalStore(":memory:");
  const application = { store, serverId: "node" } as OrchestratorApplication;
  const input = { executable: "/pinned/helper", localOrigin: "https://127.0.0.1:4400", ...originTls };
  vi.mocked(startQuickTunnel).mockImplementationOnce(async options => ({
    kind: "cloudflare.quick", requestId: options.requestId, processId: process.pid,
    publicOrigin: "https://owned.trycloudflare.com",
    limits: { temporaryHostname: true, maximumInflightRequests: 200, serverSentEvents: false,
      serviceLevelAgreement: false, intendedUse: "testing-and-development" },
    closed: new Promise<CloudflareTunnelExit>(() => undefined),
    close: async () => { throw Object.assign(new Error("Shutdown was not confirmed."), { code: "cleanup_failed" }); }
  }));
  try {
    const active = await startManagedLinkspanConnector(application, input);
    await expect(active.close()).rejects.toMatchObject({ code: "cleanup_failed" });
    const retained = store.findSetting<Record>("service", "orchestrator", journal)!.value;
    expect(retained).toMatchObject({ processId: process.pid, state: "active", publicOrigin: "https://owned.trycloudflare.com" });
    await expect(startManagedLinkspanConnector(application, input)).rejects.toThrow("cleanup is unconfirmed");
    expect(startQuickTunnel).toHaveBeenCalledOnce();
  } finally { store.close(); }
});

it.each([false, true])("retires the exact started child after its publication receipt fails (cleanup failure: %s)", async cleanupFails => {
  const store = new OperationalStore(":memory:");
  const application = { store, serverId: "node" } as OrchestratorApplication;
  const input = { executable: "/pinned/helper", localOrigin: "https://127.0.0.1:4400", ...originTls };
  const receiptError = new Error("Publication persistence failed.");
  const cleanupError = Object.assign(new Error("Shutdown was not confirmed."), { code: "cleanup_failed" });
  let resolveClosed!: (value: CloudflareTunnelExit) => void;
  const closed = new Promise<CloudflareTunnelExit>(resolve => { resolveClosed = resolve; });
  const close = vi.fn(async () => {
    if (cleanupFails) throw cleanupError;
    resolveClosed({ reason: "stopped", exitCode: 0, signal: null });
  });
  vi.mocked(startQuickTunnel).mockImplementationOnce(async options => {
    options.onSpawn?.({ processId: process.pid, requestId: options.requestId });
    return { kind: "cloudflare.quick", requestId: options.requestId, processId: process.pid,
      publicOrigin: "https://owned.trycloudflare.com", limits: { temporaryHostname: true, maximumInflightRequests: 200,
        serverSentEvents: false, serviceLevelAgreement: false, intendedUse: "testing-and-development" }, closed, close };
  });
  vi.spyOn(store, "completeDeferredEffectOperation").mockImplementationOnce(() => { throw receiptError; });
  try {
    const attempt = startManagedLinkspanConnector(application, input);
    if (cleanupFails) await expect(attempt).rejects.toMatchObject({ code: "cleanup_failed", errors: [receiptError, cleanupError] });
    else await expect(attempt).rejects.toBe(receiptError);
    expect(close).toHaveBeenCalledOnce();
    expect(startQuickTunnel).toHaveBeenCalledOnce();
    const retained = store.findSetting<Record>("service", "orchestrator", journal)!.value;
    if (cleanupFails) {
      expect(retained).toMatchObject({ state: "starting", processId: process.pid });
      expect(store.getOperation(retained.requestId).status).toBe("started");
      await expect(startManagedLinkspanConnector(application, input)).rejects.toThrow("cleanup is unconfirmed");
      expect(startQuickTunnel).toHaveBeenCalledOnce();
    } else {
      expect(retained.state).toBe("closed");
      expect(store.getOperation(retained.requestId)).toMatchObject({ status: "completed", response: { state: "closed", reason: "publication_receipt_failed_and_child_retired" } });
    }
  } finally { store.close(); }
});
