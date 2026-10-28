import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fromBinary } from "@bufbuild/protobuf";
import { ExtensionDeviceSyncEnvelopeSchema } from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { expect, it, vi } from "vitest";
import { CredentialVault, type EncryptedCredential } from "./credential-vault.js";
import { DevicePeerOwner } from "./device-peer-owner.js";
import type { ExtensionCatalogDescriptor } from "./extension-catalog.js";
import type { PiResourceDescriptor } from "./resource-manager.js";
import { ExtensionDeviceSync } from "./extension-device-sync.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-plugin-sync-")), stores = [new OperationalStore(":memory:"), new OperationalStore(":memory:")];
  const vaults = await Promise.all([CredentialVault.open(join(root, "a.key")), CredentialVault.open(join(root, "b.key"))]);
  const states = [{ enabled: true, revision: 1n, source: "npm:@test/sync" }, { enabled: true, revision: 1n, source: "npm:@test/sync" }];
  const extensions = states.map((state, index) => () => ({ id: `plugin-${index}`, revision: state.revision, enabled: state.enabled, installed: true,
    owner: { kind: "resource", resourceId: "resource", resourceVersion: state.revision, discoveredRevision: "content" },
    setup: { state: "not_required" }, permissions: [{ id: "runtime-device-sync", required: true, granted: true }],
    runtime: { html: "ui/index.html", tools: [], extensionEntry: "extensions/main.js", deviceSync: true } } as unknown as ExtensionCatalogDescriptor));
  const resources = states.map(state => () => ({ id: "resource", kind: "package", scope: "managed", enabled: true, state: "installed", packageIdentity: "@test/sync",
    sourceKind: "npm", sourceIdentity: state.source, discoveredRevision: "content", versionNumber: state.revision } as unknown as PiResourceDescriptor));
  let receiver!: ExtensionDeviceSync, sender!: ExtensionDeviceSync, linked = true, autoReply = true, loseReply = false;
  const events: { readonly requestId: string; readonly data: unknown }[] = [], wire: Uint8Array[] = [];
  receiver = new ExtensionDeviceSync({ store: stores[1]!, vault: vaults[1]!, peers: new DevicePeerOwner({ store: stores[1]! }),
    catalog: { get: extensions[1]!, snapshot: () => ({ revision: 1n, entries: [extensions[1]!()], recoveredFromCorruption: false }) }, resources: { get: resources[1]! },
    peerDirectory: () => [], deliver: async (_id, event, signal, current) => {
      const message = event as { requestId: string; data: unknown }; events.push(message);
      if (autoReply) expect(await receiver.request("plugin-1", { op: "reply", requestId: message.requestId, data: { received: message.data } }, signal, current)).toEqual({ ok: true });
      return true;
    } });
  sender = new ExtensionDeviceSync({ store: stores[0]!, vault: vaults[0]!, peers: new DevicePeerOwner({ store: stores[0]! }),
    catalog: { get: extensions[0]!, snapshot: () => ({ revision: 1n, entries: [extensions[0]!()], recoveredFromCorruption: false }) }, resources: { get: resources[0]! },
    deliver: async () => false, peerDirectory: () => linked ? [{ id: "desktop-b", name: "Desktop B", epoch: "original-route",
      assertCurrent: () => { if (!linked) throw new Error("Route revoked."); }, exchange: async (bytes, signal) => {
        wire.push(bytes); const response = await receiver.invoke("original-route:", bytes, signal, () => { if (!linked) throw new Error("Peer retired."); });
        if (loseReply && fromBinary(ExtensionDeviceSyncEnvelopeSchema, bytes).data.byteLength) throw new Error("Reply lost."); return response;
      } }] : [] });
  sender.setActive(true); receiver.setActive(true);
  return { root, sender, receiver, states, stores, events, wire, setAutoReply: (value: boolean) => { autoReply = value; }, loseReply: () => { loseReply = true; }, unlink: () => { linked = false; receiver.retire("original-route:"); },
    close: async () => { sender.close(); receiver.close(); stores.forEach(store => store.close()); if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup."); await rm(root, { recursive: true, force: true }); } };
}

it("exchanges only ciphertext between matching approved plugin namespaces and leaves persistence to the plugin", async () => {
  const f = await fixture(); try {
    const signal = new AbortController().signal;
    expect(await f.sender.request("plugin-0", { op: "status" }, signal, () => {})).toMatchObject({ ok: true, peers: [{ deviceId: "desktop-b" }] });
    expect(await f.sender.request("plugin-0", { op: "request", peer: "desktop-b", data: { document: "private plugin data" } }, signal, () => {}))
      .toEqual({ ok: true, data: { received: { document: "private plugin data" } } });
    expect(f.events).toHaveLength(1); expect(f.wire).toHaveLength(2);
    for (const bytes of f.wire) expect(Buffer.from(bytes).toString("utf8")).not.toContain("private plugin data");
    const persisted = JSON.stringify(f.stores.map(store => store.listSettings().map(setting => setting.value)));
    expect(persisted).not.toContain("private plugin data"); expect(persisted).not.toContain('"data"');
    f.states[1]!.source = "npm:@different/namespace";
    expect(await f.sender.request("plugin-0", { op: "request", peer: "desktop-b", data: "other" }, signal, () => {})).toMatchObject({ ok: false });
    expect(f.events).toHaveLength(1);
  } finally { await f.close(); }
});

it("reopens the same sealed identity and refuses tampered or redacted keys without rotating or sending", async () => {
  const f = await fixture(), signal = new AbortController().signal, scope = "extension-device-sync.v1";
  let restarted: ExtensionDeviceSync | undefined;
  try {
    expect(await f.sender.request("plugin-0", { op: "request", peer: "desktop-b", data: "before restart" }, signal, () => {}))
      .toEqual({ ok: true, data: { received: "before restart" } });
    const stored = f.stores[0]!.getSetting<{ format: 1; publicKey: string; sealedPrivateKey: EncryptedCredential }>("service", scope, "identity").value;
    expect(stored).toMatchObject({ format: 1, sealedPrivateKey: { algorithm: "aes-256-gcm" } });
    const vault = await CredentialVault.open(join(f.root, "a.key"));
    expect(JSON.stringify(stored)).not.toContain(vault.open(stored.sealedPrivateKey, scope));
    f.sender.close();
    restarted = new ExtensionDeviceSync({ ...f.sender.options, vault }); restarted.setActive(true);
    expect(await restarted.request("plugin-0", { op: "request", peer: "desktop-b", data: "after restart" }, signal, () => {}))
      .toEqual({ ok: true, data: { received: "after restart" } });
    expect(fromBinary(ExtensionDeviceSyncEnvelopeSchema, f.wire[0]!).publicKey).toBe(stored.publicKey);
    expect(fromBinary(ExtensionDeviceSyncEnvelopeSchema, f.wire[2]!).publicKey).toBe(stored.publicKey);
    const tag = Buffer.from(stored.sealedPrivateKey.tag, "base64"); tag[0] = tag[0]! ^ 1;
    for (const invalid of [
      { ...stored, sealedPrivateKey: { ...stored.sealedPrivateKey, tag: tag.toString("base64") } },
      { format: 1, publicKey: stored.publicKey, privateKey: "[REDACTED]" },
      null
    ]) {
      f.stores[0]!.setSetting("service", scope, "identity", invalid);
      expect(await restarted.request("plugin-0", { op: "request", peer: "desktop-b", data: "must not dispatch" }, signal, () => {}))
        .toEqual({ ok: false, errorCode: "SYNC_SECURE_STORAGE_UNAVAILABLE" });
      expect(f.stores[0]!.getSetting("service", scope, "identity").value).toEqual(invalid);
      expect(f.events).toHaveLength(2); expect(f.wire).toHaveLength(4);
    }
  } finally { restarted?.close(); await f.close(); }
});

it.each(["disabled", "reinstalled", "peer", "cancelled"] as const)("discards late replies after %s without retrying the effect", async reason => {
  const f = await fixture(), source = new AbortController(); f.setAutoReply(false);
  try {
    const pending = f.sender.request("plugin-0", { op: "request", peer: "desktop-b", data: "pending" }, source.signal, () => {});
    await vi.waitFor(() => expect(f.events).toHaveLength(1));
    if (reason === "disabled") f.states[1]!.enabled = false;
    else if (reason === "reinstalled") { f.states[1]!.revision++; f.receiver.invalidatePlugin("plugin-1"); }
    else if (reason === "peer") f.unlink(); else source.abort();
    const result = await pending; expect(result).toMatchObject({ ok: false });
    expect(await f.receiver.request("plugin-1", { op: "reply", requestId: f.events[0]!.requestId, data: "late" }, new AbortController().signal, () => {})).toMatchObject({ ok: false });
    expect(f.wire.filter(bytes => fromBinary(ExtensionDeviceSyncEnvelopeSchema, bytes).data.byteLength)).toHaveLength(1);
  } finally { source.abort(); await f.close(); }
});

it("reports a lost reply as unknown and does not replay or accept oversized input", async () => {
  const f = await fixture(); try {
    f.loseReply(); const signal = new AbortController().signal;
    expect(await f.sender.request("plugin-0", { op: "request", peer: "desktop-b", data: "once" }, signal, () => {})).toEqual({ ok: false, errorCode: "SYNC_RESULT_UNKNOWN" });
    expect(f.events).toHaveLength(1); expect(f.wire).toHaveLength(2);
    expect(await f.sender.request("plugin-0", { op: "request", peer: "desktop-b", data: "x".repeat(65 * 1024) }, signal, () => {})).toEqual({ ok: false, errorCode: "SYNC_TOO_LARGE" });
    expect(f.wire).toHaveLength(2);
  } finally { await f.close(); }
});
