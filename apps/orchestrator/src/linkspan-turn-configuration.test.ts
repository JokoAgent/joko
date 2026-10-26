import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OperationalStore } from "@joko/store";
import { afterEach, expect, it, vi } from "vitest";
import { CredentialVault } from "./credential-vault.js";
import { CredentialManager } from "./credential-manager.js";
import { LinkspanRemoteDesktopTurnConfiguration } from "./linkspan-turn-configuration.js";
import type { OrchestratorConfig } from "./config.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const material = { iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }, {
  urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:443?transport=udp",
    "turn:turn.cloudflare.com:3478?transport=tcp", "turn:turn.cloudflare.com:80?transport=tcp",
    "turns:turn.cloudflare.com:5349?transport=tcp", "turns:turn.cloudflare.com:443?transport=tcp"],
  username: "private-username", credential: "short-lived-password"
}] };

async function fixture(fetcher: typeof fetch, configuration?: NonNullable<OrchestratorConfig["remoteDesktopTurn"]>) {
  const root = await mkdtemp(join(tmpdir(), "joko-turn-"));
  const store = new OperationalStore(":memory:");
  const credentials = new CredentialManager({ vault: await CredentialVault.open(join(root, "master.key")), storagePath: join(root, "records.json") });
  await credentials.initialize();
  const provider = new LinkspanRemoteDesktopTurnConfiguration({ store, credentials,
    configuration: configuration ?? { keyId: "selected-key", tokenPath: join(root, "token"), ttlSeconds: 600 },
    readToken: async () => configuration?.provider === "coturn" ? "private-coturn-shared-secret" : "publisher-token", fetch: fetcher });
  cleanups.push(async () => { await provider.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, provider, store, credentials };
}
const input = (leaseId = "authorized-lease") => ({ leaseId, controllerDeviceId: "controller", targetDeviceId: "target",
  signal: new AbortController().signal, assertCurrent: vi.fn() });

it("claims the effect before issuing, filters provider material through the current ICE contract and privately saves exact cleanup handles", async () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    if (String(url).endsWith("/revoke")) return new Response(null, { status: 204 });
    const records = f.store.listSettingsByKeyPrefix("service", "orchestrator", "runtime.linkspan.turn.");
    expect(records).toHaveLength(1);
    const requestId = (records[0]!.value as { requestId: string }).requestId;
    expect(f.store.getOperation(requestId).status).toBe("started");
    return Response.json(material, { status: 201 });
  });
  f = await fixture(fetcher);
  const request = input();
  const [first, second] = await Promise.all([f.provider.getConfiguration(request), f.provider.getConfiguration(request)]);
  expect(first).toEqual(second);
  expect(first).toHaveLength(2);
  expect(first.every(server => server.urls.length <= 4)).toBe(true);
  expect(first.flatMap(server => server.urls)).toContain("turns:turn.cloudflare.com:443?transport=tcp");
  expect(first[0]?.credential).toBe("short-lived-password");
  expect(request.assertCurrent).toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledTimes(1);
  const publicRecords = JSON.stringify(f.store.listSettings().map(setting => setting.value));
  expect(publicRecords).not.toContain("private-username");
  expect(publicRecords).not.toContain("short-lived-password");
  const sealed = await readFile(join(f.root, "records.json"), "utf8");
  expect(sealed).not.toContain("private-username");
  expect(sealed).not.toContain("publisher-token");
  await f.provider.releaseConfiguration(request.leaseId);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(String(fetcher.mock.calls[1]?.[0])).toMatch(/\/credentials\/private-username\/revoke$/u);
  expect(f.credentials.list({ providerId: "cloudflare.turn" })).toHaveLength(0);
});

it("keeps an unknown issuance attached to its original Operation and never regenerates on repeated ICE requests", async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("private-upstream-failure"));
  const f = await fixture(fetcher);
  const first = await f.provider.getConfiguration(input());
  const second = await f.provider.getConfiguration(input());
  expect(first[0]?.credential).toBeUndefined(); expect(second[0]?.credential).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(1);
  const record = f.store.listSettingsByKeyPrefix("service", "orchestrator", "runtime.linkspan.turn.")[0]!.value as { requestId: string; state: string };
  expect(record.state).toBe("outcome_unknown");
  expect(f.store.getOperation(record.requestId).status).toBe("started");
  await f.provider.releaseConfiguration("authorized-lease");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("retires a late issuance when the original media authorization changes before adoption", async () => {
  let release!: () => void;
  let valid = true;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => {
    if (String(url).endsWith("/revoke")) return new Response(null, { status: 204 });
    await new Promise<void>(resolve => { release = resolve; });
    return Response.json(material, { status: 201 });
  });
  const f = await fixture(fetcher);
  const pending = f.provider.getConfiguration({ ...input(), assertCurrent: () => { if (!valid) throw new Error("revoked"); } });
  const rejection = expect(pending).rejects.toThrow("revoked");
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  valid = false; release();
  await rejection;
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(String(fetcher.mock.calls[1]?.[0])).toMatch(/\/revoke$/u);
});

it("does not relabel a definite provider rejection as an unknown external effect", async () => {
  const f = await fixture(vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 })));
  expect((await f.provider.getConfiguration(input()))[0]?.credential).toBeUndefined();
  const record = f.store.listSettingsByKeyPrefix("service", "orchestrator", "runtime.linkspan.turn.")[0]!.value as { requestId: string; state: string };
  expect(record.state).toBe("closed");
  expect(f.store.getOperation(record.requestId).status).toBe("completed");
});

it("reconciles a saved exact resource on restart, without issuing another credential", async () => {
  let failCleanup = true;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => {
    if (!String(url).endsWith("/revoke")) return Response.json(material, { status: 201 });
    if (failCleanup) throw new Error("offline");
    return new Response(null, { status: 204 });
  });
  const f = await fixture(fetcher);
  await f.provider.getConfiguration(input());
  await f.provider.releaseConfiguration("authorized-lease");
  expect(fetcher).toHaveBeenCalledTimes(2);
  failCleanup = false;
  const resumed = new LinkspanRemoteDesktopTurnConfiguration({ store: f.store, credentials: f.credentials,
    configuration: { keyId: "selected-key", tokenPath: join(f.root, "token"), ttlSeconds: 600 },
    readToken: async () => "publisher-token", fetch: fetcher });
  await resumed.initialize();
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(String(fetcher.mock.calls[2]?.[0])).toMatch(/\/credentials\/private-username\/revoke$/u);
  expect(f.credentials.list({ providerId: "cloudflare.turn" })).toHaveLength(0);
  await resumed.close();
});

it("refreshes only confirmed expiring material under the original live media authority", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => String(url).endsWith("/revoke")
    ? new Response(null, { status: 204 }) : Response.json(material, { status: 201 }));
  const f = await fixture(fetcher);
  const request = input();
  const first = await f.provider.getConfiguration(request);
  vi.setSystemTime(Date.now() + 500_000);
  const second = await f.provider.getConfiguration(request);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(second[0]!.expiresAt!.seconds).toBeGreaterThan(first[0]!.expiresAt!.seconds);
  expect(request.assertCurrent).toHaveBeenCalled();
  await f.provider.releaseConfiguration(request.leaseId);
  expect(fetcher).toHaveBeenCalledTimes(4);
});

it("uses selected Twilio short-lived material and records TTL-only retirement without claiming provider revocation", async () => {
  const accountSid = `AC${"a".repeat(32)}`;
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ account_sid: accountSid, ttl: "600", ice_servers: [
    { urls: "turn:global.turn.twilio.com:3478?transport=udp", username: "twilio-private-user", credential: "twilio-short-secret" },
    { urls: "turn:global.turn.twilio.com:443?transport=tcp", username: "twilio-private-user", credential: "twilio-short-secret" }
  ] }, { status: 201 }));
  const f = await fixture(fetcher, { provider: "twilio", keyId: accountSid, tokenPath: "/private/token", ttlSeconds: 600 });
  const servers = await f.provider.getConfiguration(input());
  expect(servers[0]?.credential).toBe("twilio-short-secret");
  await f.provider.releaseConfiguration("authorized-lease");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(f.credentials.list({ providerId: "twilio.turn" })).toHaveLength(0);
  const record = f.store.listSettingsByKeyPrefix("service", "orchestrator", "runtime.linkspan.turn.")[0]!.value as { requestId: string };
  expect(f.store.getOperation(`${record.requestId}:revoke`).response).toMatchObject({ providerRetirement: { state: "awaiting-expiry", individualRevocation: false } });
  expect(JSON.stringify(f.store.listSettings().map(setting => setting.value))).not.toContain("twilio-short-secret");
});

it("settles the original issuance only after an exact known resource is retired when its protected receipt could not be saved", async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => String(url).endsWith("/revoke")
    ? new Response(null, { status: 204 }) : Response.json(material, { status: 201 }));
  const f = await fixture(fetcher);
  vi.spyOn(f.credentials, "compareAndSetManagedSecret").mockRejectedValueOnce(new Error("Protected receipt storage failed."));
  expect((await f.provider.getConfiguration(input()))[0]?.credential).toBeUndefined();
  const record = f.store.listSettingsByKeyPrefix("service", "orchestrator", "runtime.linkspan.turn.")[0]!.value as { requestId: string; state: string };
  expect(record.state).toBe("closed");
  expect(f.store.getOperation(record.requestId)).toMatchObject({ status: "completed", response: {
    state: "closed", reason: "issued_then_retired_after_receipt_failure", cleanupOperationId: `${record.requestId}:revoke`
  } });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("issues optional coturn REST material inside the same media authority without calling a broker", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const f = await fixture(fetcher, { provider: "coturn", keyId: "existing-relay", tokenPath: "/private/token", ttlSeconds: 600,
    urls: ["turn:relay.example:3478?transport=udp", "turns:relay.example:443?transport=tcp"] });
  const servers = await f.provider.getConfiguration(input());
  expect(servers[0]?.urls).toContain("turns:relay.example:443?transport=tcp");
  expect(servers[0]?.credential).toBeTruthy();
  await f.provider.releaseConfiguration("authorized-lease");
  expect(fetcher).not.toHaveBeenCalled();
  expect(f.credentials.list({ providerId: "coturn.turn" })).toHaveLength(0);
});
