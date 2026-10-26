import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OperationalStore } from "@joko/store";
import { issueIrohRelayLease } from "@jokoagent/linkspan-iroh-services";
import { afterEach, expect, it, vi } from "vitest";
import { CredentialVault } from "./credential-vault.js";
import { CredentialManager } from "./credential-manager.js";
import { issueAuthorizedIrohRelayInvitation, registerIrohRelayIssuer } from "./linkspan-iroh-lease.js";
import type { OrchestratorApplication } from "./application.js";
import type { OrchestratorConfig } from "./config.js";

vi.mock("@jokoagent/linkspan-iroh-services", () => ({ issueIrohRelayLease: vi.fn() }));
vi.mock("./remote-desktop-ice-configuration.js", () => ({ readIceToken: vi.fn(async () => "issuer-master-secret") }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); vi.clearAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const nodeEndpointId = "a".repeat(64), recipientEndpointId = "b".repeat(64);
const publicKey = `ed25519:${"c".repeat(64)}`;
const requestId = "14e65538-b20a-405d-a946-b10017f2fdf9";
const serializeRecords = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-iroh-issuer-")), workspace = join(root, "workspace");
  await mkdir(workspace); await writeFile(join(root, "issuer-secret"), "issuer-master-secret", { mode: 0o600 });
  const store = new OperationalStore(":memory:");
  const credentials = new CredentialManager({ vault: await CredentialVault.open(join(root, "master.key")), storagePath: join(root, "records.json") });
  await credentials.initialize();
  const app = { store, credentials, config: { workspace: { root: workspace }, publicOrigin: "https://node.example" } as OrchestratorConfig,
    serverId: "trusted-node", linkspanIdentity: { publicKey } as NonNullable<OrchestratorApplication["linkspanIdentity"]> };
  const retire = registerIrohRelayIssuer(app, { entryId: "paid-relay", endpointId: nodeEndpointId, ticket: "trusted-runtime-ticket",
    configuration: { provider: "iroh", secretKeyHex: "1".repeat(64), invitationDirectory: root,
      servicesApiSecretPath: join(root, "issuer-secret"), relayUrls: ["https://selected-relay.example"], relayLeaseTtlSeconds: 600 } });
  cleanups.push(async () => { retire(); store.close(); await rm(root, { recursive: true, force: true }); });
  const input = { requestId, nodeEndpointId, recipientEndpointId, ownerConnectionId: "original-owner",
    signal: new AbortController().signal, assertCurrent: vi.fn() };
  return { app, input, retire };
}

it("records the original owner/recipient before minting and privately replays a lost response without another lease", async () => {
  const f = await fixture();
  vi.mocked(issueIrohRelayLease).mockImplementation(async options => {
    const op = f.app.store.getOperation(`linkspan-iroh-lease:${requestId}`);
    expect(op.status).toBe("started");
    expect(op.body).toMatchObject({ ownerConnectionId: "original-owner", clientEndpointId: recipientEndpointId });
    expect(options.apiSecret).toBe("issuer-master-secret");
    return { endpointId: recipientEndpointId, relayToken: "recipient-relay-secret", scope: "relay:use", expiresAt: Date.now() + 600000 };
  });
  const first = await issueAuthorizedIrohRelayInvitation(f.app, f.input);
  const repeated = await issueAuthorizedIrohRelayInvitation(f.app, f.input);
  expect(repeated).toEqual(first); expect(issueIrohRelayLease).toHaveBeenCalledOnce();
  expect(first).toMatchObject({ serverId: "trusted-node", endpointPublicKey: publicKey, recipientEndpointId, relayToken: "recipient-relay-secret" });
  expect(serializeRecords(f.app.store.listSettings())).not.toContain("recipient-relay-secret");
  expect(serializeRecords(f.app.store.getOperation(`linkspan-iroh-lease:${requestId}`))).not.toContain("issuer-master-secret");
  await expect(issueAuthorizedIrohRelayInvitation(f.app, { ...f.input, ownerConnectionId: "different-owner" })).rejects.toThrow("different authority");
  await expect(issueAuthorizedIrohRelayInvitation(f.app, { ...f.input, recipientEndpointId: "d".repeat(64) })).rejects.toThrow("different authority");
});

it("keeps the exact expired private receipt queryable after a lost response without extending it or requiring a live issuer", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const f = await fixture();
  vi.mocked(issueIrohRelayLease).mockResolvedValue({ endpointId: recipientEndpointId, relayToken: "original-short-lease", scope: "relay:use", expiresAt: Date.now() + 60000 });
  const original = await issueAuthorizedIrohRelayInvitation(f.app, f.input);
  vi.setSystemTime(original.expiresAt + 1); f.retire();
  const checkpoint = await issueAuthorizedIrohRelayInvitation(f.app, f.input);
  expect(checkpoint).toEqual(original); expect(checkpoint.expiresAt).toBeLessThan(Date.now()); expect(issueIrohRelayLease).toHaveBeenCalledOnce();
});

it("never adopts a late recipient lease after the original owner is revoked", async () => {
  const f = await fixture(); let resolve!: () => void; let current = true;
  vi.mocked(issueIrohRelayLease).mockImplementation(async () => {
    await new Promise<void>(done => { resolve = done; });
    return { endpointId: recipientEndpointId, relayToken: "late-private-lease", scope: "relay:use", expiresAt: Date.now() + 600000 };
  });
  const pending = issueAuthorizedIrohRelayInvitation(f.app, { ...f.input, assertCurrent: () => { if (!current) throw new Error("owner revoked"); } });
  const rejected = expect(pending).rejects.toThrow("owner revoked");
  await vi.waitFor(() => expect(issueIrohRelayLease).toHaveBeenCalledOnce()); current = false; resolve(); await rejected;
  expect(f.app.credentials.list({ providerId: "iroh.relay-use" })).toHaveLength(0);
  expect(serializeRecords(f.app.store.listSettings())).not.toContain("late-private-lease");
  expect(f.app.store.getOperation(`linkspan-iroh-lease:${requestId}`).status).toBe("started");
});
