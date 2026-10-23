import { create } from "@bufbuild/protobuf";
import { ListPartnerGroupsResponseSchema, type ListPartnerGroupsResponse } from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobilePartnerGroupRoster, type MobilePartnerGroupSourceTransport } from "./mobile-partner-group-roster";
import { mobilePartnerRosterSourceKey } from "./mobile-partner-roster";
import type { MobileConnectionProfile } from "./connection-storage";

const models: MobilePartnerGroupRoster[] = [];
afterEach(() => { for (const model of models.splice(0)) model.setActive(false); vi.useRealTimers(); });
const profile = (id: string): MobileConnectionProfile => ({ profileId: id, origin: `https://${id}.test`, serverId: `server-${id}`,
  connectionId: `connection-${id}`, deviceId: `phone-${id}`, displayName: "Same node name" });
const source = (id: string) => ({ profile: profile(id), key: mobilePartnerRosterSourceKey(profile(id)), current: id === "a" });
const catalog = (name: string): ListPartnerGroupsResponse => create(ListPartnerGroupsResponseSchema, { revision: { value: 7n }, groups: [{
  id: "same-group", revision: { value: 4n }, name, updatedAt: { seconds: 12n }, unread: true,
  members: [{ partnerId: "first", name: "First" }, { partnerId: "second", name: "Second" }],
  lastMessage: { content: `${name} preview`, createdAt: { seconds: 20n } }
}] });
function store() {
  const values = new Map<string, string>();
  return { values, getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => { values.set(key, value); },
    removeItem: async (key: string) => { values.delete(key); }, getAllKeys: async () => [...values.keys()] };
}
function transport(id: string, read: () => Promise<ListPartnerGroupsResponse>, signal: AbortSignal): MobilePartnerGroupSourceTransport {
  return { sourceKey: source(id).key, ownerKey: `owner-${id}`, receiptScope: `receipt-${id}`, isCurrent: () => !signal.aborted, list: read };
}
function model(storage: ReturnType<typeof store>, resolve: ConstructorParameters<typeof MobilePartnerGroupRoster>[1]) {
  const result = new MobilePartnerGroupRoster(storage, resolve, () => 1234); models.push(result); return result;
}
describe("paired group directory display ownership", () => {
  it("recovers a transient source and ends a stalled cold read without waiting indefinitely", async () => {
    vi.useFakeTimers();
    let offline = true;
    const resolve = vi.fn(async (id: string, signal: AbortSignal) => {
      if (offline) throw new TypeError("Network offline");
      return transport(id, async () => catalog("Recovered group"), signal);
    });
    const roster = model(store(), resolve); roster.setSources([source("a")]); roster.setActive(true);
    await vi.advanceTimersByTimeAsync(0); expect(roster.snapshot[0]?.status).toBe("offline");
    offline = false; await vi.advanceTimersByTimeAsync(900);
    expect(roster.snapshot[0]).toMatchObject({ status: "online", display: [{ name: "Recovered group" }] });
    const stalled = model(store(), async (id, signal) => transport(id, () => new Promise(() => {}), signal));
    stalled.setSources([source("a")]); stalled.setActive(true);
    await vi.advanceTimersByTimeAsync(9_999); expect(stalled.snapshot[0]?.status).toBe("loading");
    await vi.advanceTimersByTimeAsync(1);
    expect(stalled.snapshot[0]).toMatchObject({ status: "offline", refreshing: false, settled: true });
    stalled.setActive(false); roster.setActive(false);
    const calls = resolve.mock.calls.length; await vi.advanceTimersByTimeAsync(60_000);
    expect(resolve).toHaveBeenCalledTimes(calls);
  });

  it("keeps same group IDs separate and retains only the failed source's display", async () => {
    const storage = store(); let failed = false;
    const roster = model(storage, async (id, signal, expected) => {
      expect(expected).toBe(source(id).key);
      return transport(id, async () => { if (failed && id === "b") throw new Error("Network offline"); return catalog(`Group ${id}`); }, signal);
    });
    roster.setSources([source("a"), source("b")]); roster.setActive(true);
    await vi.waitFor(() => expect(roster.snapshot.map(shard => shard.status)).toEqual(["online", "online"]));
    await vi.waitFor(() => expect(storage.values.size).toBe(2));
    failed = true; roster.refresh(source("b").key);
    await vi.waitFor(() => expect(roster.snapshot[1]?.status).toBe("offline"));
    expect(roster.snapshot[0]?.catalog?.groups[0]?.name).toBe("Group a");
    expect(roster.snapshot[1]?.display[0]).toMatchObject({ groupId: "same-group", name: "Group b", preview: "Group b preview", unread: true });
    expect(roster.transport(source("a").key)).toBeDefined(); expect(roster.transport(source("b").key)).toBeUndefined();
    const saved = JSON.parse([...storage.values.values()][0]!);
    expect(Object.keys(saved.display[0]).sort()).toEqual(["groupId", "members", "name", "preview", "unread", "updatedAt"]);
    expect(saved.display[0].revision).toBeUndefined(); expect(saved.display[0].messages).toBeUndefined();
  });
  it("hydrates display without entry authority and retires revoked source cache", async () => {
    const storage = store(), online = model(storage, async (id, signal) => transport(id, async () => catalog("Saved group"), signal));
    online.setSources([source("a")]); online.setActive(true); await vi.waitFor(() => expect(storage.values.size).toBe(1)); online.setActive(false);
    const offline = model(storage, async () => { throw new Error("Network offline"); });
    offline.setSources([source("a")]); offline.setActive(true);
    await vi.waitFor(() => expect(offline.snapshot[0]).toMatchObject({ status: "offline", display: [{ name: "Saved group" }] }));
    expect(offline.transport(source("a").key)).toBeUndefined(); expect(offline.snapshot[0]?.catalog).toBeUndefined();
    offline.setSources([]); expect(offline.snapshot).toEqual([]); await vi.waitFor(() => expect(storage.values.size).toBe(0));
    storage.values.set(`joko.mobile.partner-group-roster.v1:${encodeURIComponent(source("a").key)}`,
      JSON.stringify({ schema: "joko.mobile.partner-group-roster.v1", sourceKey: source("a").key, savedAt: 1, displayTotal: 0, display: [], revision: "forbidden" }));
    offline.setSources([source("a")]); await vi.waitFor(() => expect(offline.snapshot[0]?.status).toBe("offline"));
    expect(offline.snapshot[0]?.display).toEqual([]);
  });
  it("bounds source fanout and rejects late, background and substituted-source results", async () => {
    const storage = store(), pending = new Map<string, (value: ListPartnerGroupsResponse) => void>(); let running = 0, maximum = 0;
    const roster = model(storage, async (id, signal) => transport(id, () => {
      running++; maximum = Math.max(maximum, running);
      return new Promise<ListPartnerGroupsResponse>(resolve => pending.set(id, value => { running--; resolve(value); }));
    }, signal));
    roster.setSources([source("a"), source("b"), source("c")]); roster.setActive(true);
    await vi.waitFor(() => expect(pending.size).toBe(2));
    roster.setSources([source("b"), source("c")]); pending.get("a")!(catalog("Forgotten"));
    await vi.waitFor(() => expect(pending.has("c")).toBe(true)); roster.setActive(false);
    pending.get("b")!(catalog("Background")); pending.get("c")!(catalog("Background"));
    await vi.waitFor(() => expect(running).toBe(0)); expect(maximum).toBe(2); expect(storage.values.size).toBe(0);
    const list = vi.fn(async () => catalog("Wrong source"));
    const substituted = model(store(), async (_id, signal) => transport("b", list, signal)); substituted.setSources([source("a")]); substituted.setActive(true);
    await vi.waitFor(() => expect(substituted.snapshot[0]?.status).toBe("error")); expect(list).not.toHaveBeenCalled();
  });
  it("settles an expired live proof instead of stranding refresh and reacquires it on source adoption", async () => {
    let current = false;
    const roster = model(store(), async (id, signal) => ({ ...transport(id, async () => catalog("Current group"), signal), isCurrent: () => current && !signal.aborted }));
    roster.setSources([source("a")]); roster.setActive(true);
    await vi.waitFor(() => expect(roster.snapshot[0]).toMatchObject({ status: "error", refreshing: false }));
    current = true; roster.setSources([{ ...source("a"), current: false }]);
    await vi.waitFor(() => expect(roster.snapshot[0]?.status).toBe("online")); expect(roster.transport(source("a").key)).toBeDefined();
  });
});
