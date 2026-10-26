import { afterEach, expect, it, vi } from "vitest";
import { OperationalStore } from "@joko/store";
import { startConnector, reconcileConnectorResource } from "@jokoagent/linkspan-connectors";
import type { OrchestratorApplication } from "./application.js";
import { advertisedLinkspanOrigin } from "./linkspan-connector.js";
import { startManagedProviderConnector } from "./linkspan-provider-connector.js";

vi.mock("@jokoagent/linkspan-connectors", () => ({ startConnector: vi.fn(), reconcileConnectorResource: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const input = { localOrigin: "https://127.0.0.1:4400", originCaPool: "/private/ca.pem", originServerName: "localhost" };
const configuration = { provider: "localtunnel" as const, budget: { paidEnabled: false, maximumBytes: 1048576, maximumSessionMs: 60000 } };

it("journals each supplier effect before startup and keeps simultaneous entrance ownership independent", async () => {
  const store = new OperationalStore(":memory:");
  const application = { store, serverId: "node" } as OrchestratorApplication;
  const retired: string[] = [];
  vi.mocked(startConnector).mockImplementation(async (config, options) => {
    expect(store.getOperation(options.requestId).status).toBe("started");
    const id = options.requestId.includes(":first:") ? "first" : "second";
    const resource = { provider: config.provider, requestId: options.requestId, id, createdByHost: false };
    options.onResource?.(resource);
    let done!: (value: { reason: "stopped" }) => void;
    const closed = new Promise<{ reason: "stopped" }>(resolve => { done = resolve; });
    return { kind: config.provider, requestId: options.requestId, publicOrigin: `https://${id}.example`, resource,
      limits: { stability: "experimental", free: true, temporaryHostname: true, serviceLevelAgreement: false, notes: [] }, closed,
      close: async () => { retired.push(id); done({ reason: "stopped" }); } };
  });
  try {
    const first = await startManagedProviderConnector(application, { id: "first", connector: configuration }, input);
    const second = await startManagedProviderConnector(application, { id: "second", connector: configuration }, input);
    expect(advertisedLinkspanOrigin(store, "https://fallback.example")).toBe(first.publicOrigin);
    await first.close();
    expect(advertisedLinkspanOrigin(store, "https://fallback.example")).toBe(second.publicOrigin);
    expect(retired).toEqual(["first"]);
    await second.close();
    expect(advertisedLinkspanOrigin(store, "https://fallback.example")).toBe("https://fallback.example");
  } finally { store.close(); }
});

it("preserves an unknown provider effect and refuses to create a replacement before original cleanup is confirmed", async () => {
  const store = new OperationalStore(":memory:");
  const application = { store, serverId: "node" } as OrchestratorApplication;
  vi.mocked(startConnector).mockImplementation(async (config, options) => {
    options.onResource?.({ provider: config.provider, requestId: options.requestId, id: "original", createdByHost: false });
    throw Object.assign(new Error("The original resource receipt was lost."), { code: "outcome_unknown", outcome: "unknown" });
  });
  vi.mocked(reconcileConnectorResource).mockResolvedValue({ state: "outcome_unknown" });
  try {
    await expect(startManagedProviderConnector(application, { id: "first", connector: configuration }, input)).rejects.toMatchObject({ code: "outcome_unknown" });
    const record = store.findSetting<{ requestId: string; state: string }>("service", "orchestrator", "runtime.linkspan.connector.first")!.value;
    expect(store.getOperation(record.requestId).status).toBe("started");
    await expect(startManagedProviderConnector(application, { id: "first", connector: configuration }, input)).rejects.toThrow("unconfirmed cleanup");
    expect(startConnector).toHaveBeenCalledOnce();
    expect(store.getOperation(`${record.requestId}:reconcile`).status).toBe("started");
  } finally { store.close(); }
});

it("journals the exact process-owned tcpmux Noise target and leaves verified HTTPS mandatory for other modes", async () => {
  const store = new OperationalStore(":memory:"), application = { store, serverId: "node" } as OrchestratorApplication;
  const encryptedStreamTarget = { address: "127.0.0.1" as const, port: 45000 };
  const connector = { provider: "frp" as const, mode: "tcpmux" as const,
    helper: { executable: "/private/frpc", target: `${process.platform}-${process.arch}`, version: "0.71.1", sha256: "a".repeat(64) },
    serverAddress: "relay.example", serverPort: 7000, token: "publisher-only", serverName: "relay.example", serverCaPool: "/private/relay-ca.pem",
    publicOrigin: "https://node.example", publicProxyOrigin: "http://relay.example:1337", budget: configuration.budget };
  vi.mocked(startConnector).mockImplementation(async (config, options) => {
    expect(options.encryptedStreamTarget).toEqual(encryptedStreamTarget);
    expect(options.localOrigin).toBeUndefined(); expect(options.originCaPool).toBeUndefined();
    expect(store.getOperation(options.requestId)).toMatchObject({ status: "started", body: { encryptedStreamTarget } });
    const resource = { provider: config.provider, requestId: options.requestId, id: "exact-mux", createdByHost: true };
    options.onResource?.(resource);
    let finish!: (value: { reason: "stopped" }) => void;
    const closed = new Promise<{ reason: "stopped" }>(resolve => { finish = resolve; });
    return { kind: config.provider, requestId: options.requestId, publicOrigin: connector.publicOrigin, resource,
      limits: { stability: "stable", free: true, temporaryHostname: false, serviceLevelAgreement: false, notes: [] }, closed,
      close: async () => { finish({ reason: "stopped" }); } };
  });
  try {
    const published = await startManagedProviderConnector(application, { id: "mux", connector }, { encryptedStreamTarget });
    expect(published.endpointTransport).toEqual({ kind: "http-connect", proxyOrigin: connector.publicProxyOrigin, authority: "node.example:443" });
    await published.close();
    await expect(startManagedProviderConnector(application, { id: "other", connector: configuration }, { encryptedStreamTarget })).rejects.toThrow(/verified HTTPS/u);
    await expect(startManagedProviderConnector(application, { id: "missing", connector }, input)).rejects.toThrow(/exact encrypted TCP target/u);
    expect(startConnector).toHaveBeenCalledOnce();
  } finally { store.close(); }
});
