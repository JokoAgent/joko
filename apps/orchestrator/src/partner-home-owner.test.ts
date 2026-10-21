import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationalStore, type PartnerCapabilitiesRecord } from "@joko/store";
import { PartnerHomeError, PartnerHomeOwner, PartnerHomeStorage, type PartnerHomeRuntime } from "./partner-home-owner.js";

const stores: OperationalStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const capabilities: PartnerCapabilitiesRecord = { modelChain: [{ backendId: "managed", providerId: "configured", modelId: "vendor/model", fastMode: false }], permissionMode: "ask", planMode: false };
function fixture() {
  const store = new OperationalStore(":memory:"); stores.push(store); const storage = new PartnerHomeStorage(store);
  const runtime: PartnerHomeRuntime = { authorityServerId: "authority", local: { kind: "service", deviceId: "authority", name: "Service" },
    profile: () => ({ revision: 1n, lifecycle: "active", ready: true, sessionId: "original-session" }), sessions: () => ["original-session", "owned-task"],
    management: async (_id, action) => action(), assertDestination: vi.fn(async () => undefined), busy: vi.fn(async () => false),
    sourceAvailable: () => true, stop: vi.fn(async () => undefined), prepare: vi.fn(async () => "17"),
    activate: vi.fn(async () => "new-session"), assertOwner: () => undefined };
  const owner = new PartnerHomeOwner(storage, runtime, { wait: async () => undefined, busyWaitMs: 1 });
  const input = { requestId: "change-computer-once", partnerId: "partner", expectedGeneration: 1, expectedPartnerRevision: 1n,
    destination: { kind: "device" as const, deviceId: "computer", controllerDeviceId: "phone", name: "Laptop", root: "/home/person/.joko/partner" },
    capabilities, busyAction: "wait" as const, continueWhenSourceOffline: false };
  return { store, storage, runtime, owner, input };
}
describe("durable Partner execution-home authority", () => {
  it("persists input fencing before effects, lets already admitted work settle, and publishes one new generation", async () => {
    const f = fixture(); let release!: () => void;
    vi.mocked(f.runtime.busy).mockImplementationOnce(async () => { expect(f.storage.freezesInput("original-session")).toBe(true);
      expect(f.storage.blocksSession("original-session")).toBe(false); await new Promise<void>(resolve => { release = resolve; }); return false; });
    const accepted = await f.owner.move(f.input);
    expect(accepted.phase).toBe("waiting"); expect(f.runtime.prepare).not.toHaveBeenCalled();
    release(); await vi.waitFor(() => expect(f.owner.get(f.input.requestId)?.phase).toBe("ready"));
    expect(f.owner.current("partner")).toMatchObject({ generation: 2, location: { deviceId: "computer" } });
    expect(f.storage.blocksSession("owned-task")).toBe(true); expect(f.storage.freezesInput("original-session")).toBe(true);
    expect(f.runtime.prepare).toHaveBeenCalledOnce(); expect(f.runtime.activate).toHaveBeenCalledOnce();
    const renamed = await f.owner.move({ ...f.input, destination: { ...f.input.destination, name: "Renamed laptop" } });
    expect(renamed.canonicalSessionId).toBe("new-session"); expect(f.runtime.activate).toHaveBeenCalledOnce();
    await expect(f.owner.move({ ...f.input, capabilities: { ...capabilities, planMode: true } })).rejects.toThrow("another action");
    await f.owner.close();
  });
  it("requires explicit offline continuation and never stops or replays unavailable old work", async () => {
    const f = fixture(); f.runtime.sourceAvailable = () => false;
    await f.owner.move(f.input); await vi.waitFor(() => expect(f.owner.get(f.input.requestId)?.failure).toBe("source-unavailable"));
    expect(f.owner.current("partner").generation).toBe(1); expect(f.storage.freezesInput("original-session")).toBe(false);
    await f.owner.move({ ...f.input, requestId: "explicit-offline-home", continueWhenSourceOffline: true });
    await vi.waitFor(() => expect(f.owner.get("explicit-offline-home")?.phase).toBe("ready"));
    expect(f.runtime.stop).not.toHaveBeenCalled(); expect(f.runtime.busy).not.toHaveBeenCalled(); await f.owner.close();
  });
  it("retains unknown shutdown ownership across restart and only retries the original action explicitly", async () => {
    const f = fixture(); vi.mocked(f.runtime.stop).mockRejectedValueOnce(new PartnerHomeError("outcome-unknown", "Unconfirmed close"));
    await f.owner.move({ ...f.input, busyAction: "stop" });
    await vi.waitFor(() => expect(f.owner.get(f.input.requestId)?.failure).toBe("outcome-unknown"));
    expect(f.storage.blocksSession("owned-task")).toBe(true); expect(f.runtime.prepare).not.toHaveBeenCalled(); await f.owner.close();
    const reopened = new PartnerHomeOwner(new PartnerHomeStorage(f.store), f.runtime); await reopened.recover();
    expect(f.runtime.stop).toHaveBeenCalledOnce(); expect(reopened.get(f.input.requestId)?.phase).toBe("needs-attention");
    const done = await reopened.retry(f.input.requestId); expect(done.phase).toBe("ready");
    expect(f.runtime.stop).toHaveBeenCalledTimes(2); expect(f.runtime.activate).toHaveBeenCalledOnce(); await reopened.close();
  });
  it("keeps the old computer fenced after target activation fails and retries the committed generation", async () => {
    const f = fixture(); vi.mocked(f.runtime.activate).mockRejectedValueOnce(new Error("Runtime unavailable"));
    await f.owner.move(f.input); await vi.waitFor(() => expect(f.owner.get(f.input.requestId)?.phase).toBe("needs-attention"));
    expect(f.owner.current("partner").generation).toBe(2); expect(f.storage.blocksSession("original-session")).toBe(true);
    expect((await f.owner.retry(f.input.requestId)).canonicalSessionId).toBe("new-session");
    expect(f.owner.current("partner").generation).toBe(2); expect(f.runtime.prepare).toHaveBeenCalledOnce(); await f.owner.close();
  });
  it("does not run any effect after a concurrent profile change invalidates the target inspection", async () => {
    const f = fixture(); let revision = 1n; f.runtime.profile = () => ({ revision, lifecycle: "active", ready: true, sessionId: "original-session" });
    vi.mocked(f.runtime.assertDestination).mockImplementationOnce(async () => { revision = 2n; });
    await expect(f.owner.move(f.input)).rejects.toThrow("changed during");
    expect(f.storage.list()).toEqual([]); expect(f.runtime.prepare).not.toHaveBeenCalled(); await f.owner.close();
  });
  it("does not revive an earlier failed receipt while a newer change owns the Partner", async () => {
    const f = fixture(); vi.mocked(f.runtime.prepare).mockRejectedValueOnce(new Error("Target unavailable"));
    await f.owner.move(f.input); await vi.waitFor(() => expect(f.owner.get(f.input.requestId)?.phase).toBe("needs-attention"));
    let release!: () => void;
    vi.mocked(f.runtime.busy).mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return false; });
    await f.owner.move({ ...f.input, requestId: "newer-change" });
    const original = await f.owner.retry(f.input.requestId); expect(original.failure).toBe("state-changed");
    expect(f.runtime.prepare).toHaveBeenCalledOnce(); release();
    await vi.waitFor(() => expect(f.owner.get("newer-change")?.phase).toBe("ready"));
    expect(f.owner.current("partner").generation).toBe(2); await f.owner.close();
  });
});
