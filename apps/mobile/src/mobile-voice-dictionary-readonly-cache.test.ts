import { describe, expect, it, vi } from "vitest";
import { MobileVoiceDictionaryReadOnlyCache } from "./mobile-voice-dictionary-readonly-cache";
import { mobileReadOnlyDictionaryEntryViews, selectMobileReadOnlyDictionary } from "./mobile-voice-dictionary-readonly";
import { dictionaryStamp, memoryReadOnlyCache, readOnlyProfile, readOnlyValue } from "./test/voice-dictionary-readonly";

describe("read-only per-pair dictionary cache", () => {
  it("restores the exact pair without credentials or an editable replica and isolates other owners", async () => {
    const { cache, storage, values } = memoryReadOnlyCache();
    const profile = { ...readOnlyProfile(), authKey: "private-credential" };
    await cache.apply(profile, readOnlyValue(), cache.lease(profile));
    const bytes = [...values.values()].join("");
    expect(bytes).not.toContain("private-credential"); expect(bytes).not.toContain("incarnations"); expect(bytes).not.toContain("candidates");
    const restored = new MobileVoiceDictionaryReadOnlyCache(storage);
    await restored.hydrate(profile);
    expect(restored.read(profile)?.snapshot).toEqual(readOnlyValue());
    for (const patch of [{ serverId: "other" }, { connectionId: "other" }, { deviceId: "other" }, { origin: "http://127.0.0.1:5000" }, { profileId: "other" }]) {
      const other = { ...profile, ...patch }; await restored.hydrate(other); expect(restored.read(other)).toBeUndefined();
    }
  });

  it("keeps disabled empty projections durable and rejects late reads after toggle or clock rollback", async () => {
    let now = 1_000;
    const { cache, storage } = memoryReadOnlyCache(() => now);
    const profile = readOnlyProfile(); const lease = cache.lease(profile);
    await cache.apply(profile, readOnlyValue(), lease);
    const fetchedAt = cache.read(profile)!.fetchedAt;
    now = 1;
    const off = readOnlyValue(3n, { syncEnabled: false, entries: [] });
    await cache.apply(profile, off, lease);
    expect(cache.read(profile)!.fetchedAt).toBeGreaterThan(fetchedAt);
    expect(await cache.apply(profile, readOnlyValue(), lease)).toBe(false);
    expect(await cache.apply(profile, readOnlyValue(4n, { stateVector: {} }), lease)).toBe(false);
    expect(cache.read(profile)?.snapshot).toEqual(off);
    const reopened = new MobileVoiceDictionaryReadOnlyCache(storage, () => 0);
    await reopened.hydrate(profile); expect(reopened.read(profile)?.snapshot).toEqual(off);
    await reopened.apply(profile, readOnlyValue(4n), reopened.lease(profile));
    expect(reopened.read(profile)!.fetchedAt).toBeGreaterThan(cache.read(profile)!.fetchedAt);
  });

  it("hydrates one freshness baseline before concurrent push or GET and never persists an older frame over it", async () => {
    const { cache, storage, values } = memoryReadOnlyCache(); const profile = readOnlyProfile();
    await cache.apply(profile, readOnlyValue(6n), cache.lease(profile));
    const key = [...values.keys()][0]!; const saved = values.get(key)!;
    let finish!: (raw: string) => void;
    const original = storage.getItem;
    storage.getItem = vi.fn(async (target) => target === key ? await new Promise<string>((resolve) => { finish = resolve; }) : original(target));
    const reopened = new MobileVoiceDictionaryReadOnlyCache(storage);
    const hydrated = reopened.hydrate(profile);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const late = reopened.apply(profile, readOnlyValue(5n), reopened.lease(profile));
    finish(saved); await hydrated; expect(await late).toBe(false);
    expect(reopened.read(profile)?.snapshot.revision).toBe(6n); expect(values.get(key)).toBe(saved);
  });

  it("fences an in-flight disk write and late network lease before durable clear without touching another pair", async () => {
    const { cache, storage, values } = memoryReadOnlyCache(); const profile = readOnlyProfile(); const other = readOnlyProfile("b");
    await cache.apply(other, readOnlyValue(), cache.lease(other));
    const original = storage.setItem;
    let finish!: () => void;
    storage.setItem = vi.fn(async (key, value) => {
      if (key.includes("profile-a") && !key.endsWith("retired")) await new Promise<void>((resolve) => { finish = resolve; });
      await original(key, value);
    });
    const lease = cache.lease(profile); const pending = cache.apply(profile, readOnlyValue(), lease);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const cleared = cache.clear(profile.profileId);
    expect(cache.read(profile)).toBeUndefined(); expect(cache.isCurrent(lease)).toBe(false);
    finish(); expect(await pending).toBe(false); await cleared;
    expect(await cache.apply(profile, readOnlyValue(8n), lease)).toBe(false);
    const reopened = new MobileVoiceDictionaryReadOnlyCache(storage);
    await reopened.hydrate(profile); await reopened.hydrate(other);
    expect(reopened.read(profile)).toBeUndefined(); expect(reopened.read(other)?.snapshot.revision).toBe(2n);
    expect([...values.keys()].filter((key) => key.includes("profile-a"))).toHaveLength(1);
  });

  it("makes incompatible cache data explicit, retains a valid live projection and rebuilds only on request", async () => {
    const { cache, storage, values } = memoryReadOnlyCache(); const profile = readOnlyProfile();
    await cache.apply(profile, readOnlyValue(), cache.lease(profile)); const key = [...values.keys()][0]!;
    values.set(key, JSON.stringify({ version: 0, dictionary: ["OldShape"] }));
    const reopened = new MobileVoiceDictionaryReadOnlyCache(storage);
    await expect(reopened.hydrate(profile)).rejects.toThrow(/invalid/u);
    await expect(reopened.apply(profile, readOnlyValue(7n), reopened.lease(profile))).rejects.toThrow(/invalid/u);
    expect(reopened.read(profile)?.snapshot.revision).toBe(7n); expect(values.get(key)).toContain("OldShape");
    await reopened.clear(profile.profileId);
    await reopened.apply(profile, readOnlyValue(7n), reopened.lease(profile));
    const again = new MobileVoiceDictionaryReadOnlyCache(storage);
    await again.hydrate(profile); expect(again.read(profile)?.snapshot.revision).toBe(7n);
  });

  it("reports failed persistence or cleanup while retiring memory and all old leases immediately", async () => {
    const { cache, storage } = memoryReadOnlyCache(); const profile = readOnlyProfile(); const lease = cache.lease(profile);
    storage.setItem = vi.fn(async () => { throw new Error("Storage failed."); });
    await expect(cache.apply(profile, readOnlyValue(), lease)).rejects.toThrow();
    expect(cache.read(profile)?.snapshot.revision).toBe(2n);
    await expect(cache.clear(profile.profileId)).rejects.toThrow(/could not be cleared/u);
    expect(cache.read(profile)).toBeUndefined(); expect(cache.isCurrent(lease)).toBe(false);
  });
});

describe("multi-node read-only dictionary selection", () => {
  const saved = (id: string, fetchedAt: number, a: number, b: number, text: string) => ({ profile: readOnlyProfile(id), fetchedAt,
    snapshot: readOnlyValue(BigInt(fetchedAt), { stateVector: { a: dictionaryStamp(a, "a"), b: dictionaryStamp(b, "b") },
      entries: text ? [{ text, frequency: 1, aliases: [] }] : [] }) });
  it("selects a complete containing deletion snapshot rather than an offline union or maximum HLC", () => {
    const stale = saved("a", 500, 99, 0, "DeletedTerm"); const newer = saved("b", 1, 99, 1, "");
    expect(selectMobileReadOnlyDictionary([stale, newer])).toBe(newer);
    const concurrent = saved("c", 600, 0, 2, "ConcurrentTerm");
    expect(selectMobileReadOnlyDictionary([stale, concurrent])).toBe(concurrent);
  });
  it("filters all dominated nodes before concurrent tie-breaking, even when reduction order would revive stale content", () => {
    const a = saved("a", 100, 2, 2, "CompleteA"); const b = saved("b", 200, 3, 1, "ConcurrentB");
    const c = saved("c", 300, 1, 2, "StaleC");
    for (const values of [[a, b, c], [c, a, b], [b, c, a]]) expect(selectMobileReadOnlyDictionary(values)).toBe(b);
    const equal = { ...b, profile: readOnlyProfile("a") };
    expect(selectMobileReadOnlyDictionary([b, equal])).toBe(equal);
    expect(selectMobileReadOnlyDictionary([equal, b])).toBe(equal);
  });
  it("orders frequency and observed aliases and exposes at most three aliases without edit identities", () => {
    const value = { profile: readOnlyProfile(), fetchedAt: 1, snapshot: readOnlyValue(2n, {
      entries: [{ text: "Lower", frequency: 1, aliases: [] }, { text: "Higher", frequency: 4,
        aliases: [{ text: "four", count: 4 }, { text: "two", count: 2 }, { text: "one", count: 1 }, { text: "three", count: 3 }] }] }) };
    expect(mobileReadOnlyDictionaryEntryViews(value)).toEqual([{ key: "higher", text: "Higher", frequency: 4,
      aliases: ["four", "three", "two"] }, { key: "lower", text: "Lower", frequency: 1, aliases: [] }]);
  });
});
