import { afterEach, describe, expect, it, vi } from "vitest";
import { MobilePartnerRoster, mobilePartnerRosterSourceKey, type MobilePartnerRosterSourceTransport } from "./mobile-partner-roster";
import { profilePartner } from "./test/mobile-partner-profile";
import type { MobileConnectionProfile } from "./connection-storage";
import type { MobilePartnerCatalog } from "./mobile-partner-directory";

const models: MobilePartnerRoster[] = [];
afterEach(() => { for (const model of models.splice(0)) model.setActive(false); });
const profile = (id: string): MobileConnectionProfile => ({ profileId: id, origin: `https://${id}.test`, serverId: `server-${id}`,
  connectionId: `connection-${id}`, deviceId: `phone-${id}`, displayName: "Same node name" });
const source = (id: string) => ({ profile: profile(id), key: mobilePartnerRosterSourceKey(profile(id)), current: id === "a" });
const catalog = (name: string, count = 1): MobilePartnerCatalog => ({ directory: { revision: 1n, activeCount: count,
  archivedCount: 0, errorCount: 0, updatedAt: 1_000 }, partners: Array.from({ length: count }, (_, index) => ({ ...profilePartner,
    partnerId: count === 1 ? "same-partner" : `partner-${index}`, displayName: name })) });
function store() {
  const values = new Map<string, string>();
  return { values, getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn(async (key: string) => { values.delete(key); }), getAllKeys: async () => [...values.keys()] };
}
function transport(id: string, read: () => Promise<MobilePartnerCatalog>, signal: AbortSignal): MobilePartnerRosterSourceTransport {
  return { profile: profile(id), sourceKey: source(id).key, ownerKey: `owner-${id}`, isCurrent: () => !signal.aborted,
    list: read, observation: () => undefined, canonical: async selected => ({ sessionId: "session", partner: selected }) };
}
function model(storage: ReturnType<typeof store>, resolve: ConstructorParameters<typeof MobilePartnerRoster>[1]) {
  const result = new MobilePartnerRoster(storage, resolve, () => 1234); models.push(result); return result;
}
describe("paired Partner roster source ownership", () => {
  it("keeps same-ID sources isolated and updates successful shards independently of another failure", async () => {
    const storage = store(); let failed = false;
    const resolve = vi.fn(async (id: string, signal: AbortSignal) => transport(id, async () => {
      if (id === "b" && failed) throw new Error("Network offline"); return catalog(id === "a" ? "Ada" : "Bea");
    }, signal));
    const roster = model(storage, resolve); roster.setSources([source("a"), source("b")]); roster.setActive(true);
    await vi.waitFor(() => expect(roster.snapshot.map(shard => shard.status)).toEqual(["online", "online"]));
    await vi.waitFor(() => expect(storage.values.size).toBe(2));
    failed = true; roster.refresh(source("b").key);
    await vi.waitFor(() => expect(roster.snapshot[1]?.status).toBe("offline"));
    expect(roster.snapshot[0]).toMatchObject({ status: "online", display: [{ partnerId: "same-partner", displayName: "Ada" }] });
    expect(roster.snapshot[1]).toMatchObject({ display: [{ partnerId: "same-partner", displayName: "Bea" }] });
    expect(roster.transport(source("a").key)).toBeDefined(); expect(roster.transport(source("b").key)).toBeUndefined();
    expect([...storage.values.values()].join(" ")).not.toContain("canonicalSessionId");
    expect([...storage.values.values()].join(" ")).not.toContain("identitySource");
  });
  it("bounds concurrent reads to two and retires forgotten or background late results", async () => {
    const storage = store(), pending = new Map<string, (value: MobilePartnerCatalog) => void>(); let running = 0, maximum = 0;
    const resolve = vi.fn(async (id: string, signal: AbortSignal) => transport(id, () => {
      running++; maximum = Math.max(maximum, running);
      return new Promise<MobilePartnerCatalog>(resolve => pending.set(id, value => { running--; resolve(value); }));
    }, signal));
    const roster = model(storage, resolve); roster.setSources([source("a"), source("b"), source("c")]); roster.setActive(true);
    await vi.waitFor(() => expect(pending.size).toBe(2)); expect(resolve).toHaveBeenCalledTimes(2);
    roster.setSources([source("b"), source("c")]); pending.get("a")!(catalog("Forgotten"));
    await vi.waitFor(() => expect(pending.has("c")).toBe(true));
    roster.setActive(false); pending.get("b")!(catalog("Background")); pending.get("c")!(catalog("Background"));
    await vi.waitFor(() => expect(running).toBe(0)); expect(maximum).toBe(2);
    expect(roster.snapshot.every(shard => shard.catalog === undefined && shard.display.length === 0)).toBe(true);
    expect(storage.values.size).toBe(0);
  });
  it("hydrates only display cache, removes revoked source cache and rejects corrupt current-v1 data", async () => {
    const storage = store(), online = model(storage, async (id, signal) => transport(id, async () => catalog("Ada"), signal));
    online.setSources([source("a")]); online.setActive(true);
    await vi.waitFor(() => expect(storage.values.size).toBe(1)); online.setActive(false);
    const offline = model(storage, async () => { throw new Error("Network offline"); });
    offline.setSources([source("a")]); offline.setActive(true);
    await vi.waitFor(() => expect(offline.snapshot[0]).toMatchObject({ status: "offline", display: [{ displayName: "Ada" }] }));
    expect(offline.transport(source("a").key)).toBeUndefined();
    offline.setSources([]); expect(offline.snapshot).toEqual([]);
    await vi.waitFor(() => expect(storage.values.size).toBe(0));
    storage.values.set(`joko.mobile.partner-roster.v1:${encodeURIComponent(source("a").key)}`,
      JSON.stringify({ schema: "joko.mobile.partner-roster.v1", sourceKey: source("a").key, savedAt: 1234, display: [], displayTotal: 0, credential: "unexpected" }));
    const corrupt = model(storage, async () => { throw new Error("Network offline"); }); corrupt.setSources([source("a")]); corrupt.setActive(true);
    await vi.waitFor(() => expect(corrupt.snapshot[0]?.status).toBe("offline")); expect(corrupt.snapshot[0]?.display).toEqual([]);
  });
  it("shows the entire live directory while bounding and identifying the offline subset", async () => {
    const storage = store(), roster = model(storage, async (id, signal) => transport(id, async () => catalog("Partner", 240), signal));
    roster.setSources([source("a")]); roster.setActive(true);
    await vi.waitFor(() => expect(roster.snapshot[0]?.display.length).toBe(240));
    await vi.waitFor(() => expect(storage.values.size).toBe(1));
    const cached = JSON.parse([...storage.values.values()][0]!); expect(cached.display).toHaveLength(200); expect(cached.displayTotal).toBe(240);
  });
});
