import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { BackendAdapter } from "@joko/core";
import { HostedAgentStore, OperationalStore } from "@joko/store";
import { expect, it, vi } from "vitest";
import { HostedAgentDerivations } from "./hosted-agent-derivations.js";
import { HostedAgentSessionSlots } from "./hosted-agent-limits.js";

it("retains the exact detached cleanup process and quota after a failed close, and never deletes the child twice", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joko-native-derive-cleanup-"))), database = new OperationalStore(":memory:"), store = new HostedAgentStore(database);
  const owner = { authorityId: "share", deviceId: "source", sessionId: "parent", targetId: "target", nativeSessionId: "parent-alias", backendId: "native", trust: "guest" as const };
  const source = store.claim(owner, "parent-process", "create"), sourceBinding = { opaqueRef: "native-parent", nativeSessionId: "parent", generation: 1 };
  store.bind(source.key, source.leaseId, sourceBinding);
  await mkdir(join(root, source.key, "workspace"), { recursive: true }); await mkdir(join(root, source.key, "native"));
  const childOwner = { ...owner, sessionId: "child", nativeSessionId: "child-alias" };
  const child = store.prepareDerivation(source.key, source.leaseId, childOwner, { operationId: "native-fork", kind: "fork", providerId: "provider", modelId: "model" });
  store.updateDerivation(child.key, child.leaseId, { state: "unknown" }, { opaqueRef: "native-child", nativeSessionId: "child", generation: 1 });
  const slots = new HostedAgentSessionSlots(), deletion = vi.fn(async () => {}), dispose = vi.fn(async () => {});
  dispose.mockRejectedValueOnce(new Error("Native process closure is unconfirmed."));
  const createAdapter = vi.fn(async () => ({ id: "native", hostedExecutionCapabilities: { toolsOnSource: true, isolatedGuests: true },
    supportsDetachedSessionDeletion: () => true, deleteSession: deletion, dispose }) as unknown as BackendAdapter);
  const manager = new HostedAgentDerivations({ root, store, slots, artifactCapacityBytes: 1024, createAdapter, isRunning: () => false, assertAdoption: () => {} });
  const principal = { id: owner.authorityId, deviceId: owner.deviceId, trust: owner.trust, assertCurrent: () => {} };
  const command = { kind: "derivation_lifecycle" as const, action: "cleanup" as const, derivationKind: "fork" as const, operationId: "native-fork", backendId: "native", providerId: "provider",
    sourceSessionId: "parent", sourceTargetId: "target", sourceNativeSessionId: "parent-alias", sessionId: "child", targetId: "target", nativeSessionId: "child-alias" };
  try {
    await expect(manager.manage(principal, command, new AbortController().signal)).rejects.toThrow("confirm closure");
    expect(manager.hasPhysicalOwner(child.key)).toBe(true); expect(slots.summary().total).toBe(1); expect(deletion).toHaveBeenCalledOnce();
    await manager.manage(principal, command, new AbortController().signal);
    expect(createAdapter).toHaveBeenCalledOnce(); expect(deletion).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledTimes(2);
    expect(slots.summary().total).toBe(0); expect(store.find(child.key)?.derivation?.state).toBe("cleaned");
    await manager.manage(principal, command, new AbortController().signal); expect(deletion).toHaveBeenCalledOnce();
  } finally {
    await manager.dispose(); database.close();
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup."); await rm(root, { recursive: true, force: true });
  }
});
