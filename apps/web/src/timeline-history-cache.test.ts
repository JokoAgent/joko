import { describe, expect, it } from "vitest";
import { TimelineHistoryCache, timelineHistoryOwnerKey, type CachedTimelineHistory } from "./timeline-history-cache.js";

const history = (key: string, count = 1): CachedTimelineHistory => ({ ownerKey: key, sourceVersion: "one", sessionId: key,
  generation: 1n, historyRevision: 0n, initialized: true, items: Array.from({ length: count }, (_, index) => ({
    id: `${key}-${index}`, sequence: BigInt(index), kind: "assistant", text: "Saved message", createdAt: 1 })) });
describe("task history windows", () => {
  it("retains revisited windows and evicts complete least recently used windows by combined size", () => {
    const cache = new TimelineHistoryCache({ sessions: 20, items: 4, characters: 100_000 });
    cache.set(history("a", 2)); cache.set(history("b", 2));
    expect(cache.get("a")?.items).toHaveLength(2);
    cache.set(history("c", 2));
    expect(cache.get("b")).toBeUndefined(); expect(cache.get("a")?.items).toHaveLength(2); expect(cache.get("c")?.items).toHaveLength(2);
    cache.set(history("too-large", 5)); expect(cache.get("too-large")).toBeUndefined();
    cache.clear(); expect(cache.get("a")).toBeUndefined();
  });
  it("does not reuse a task across nodes, connections, service/native generations or a rewind", () => {
    const profile = { id: "connection", origin: "https://node.test", serverId: "server" };
    const key = timelineHistoryOwnerKey(profile, 1n, "session", 2n, 0n)!;
    const cache = new TimelineHistoryCache(); cache.set({ ...history(key), ownerKey: key });
    for (const other of [
      timelineHistoryOwnerKey({ ...profile, id: "other" }, 1n, "session", 2n, 0n),
      timelineHistoryOwnerKey({ ...profile, serverId: "other" }, 1n, "session", 2n, 0n),
      timelineHistoryOwnerKey({ ...profile, origin: "https://other.test" }, 1n, "session", 2n, 0n),
      timelineHistoryOwnerKey(profile, 2n, "session", 2n, 0n),
      timelineHistoryOwnerKey(profile, 1n, "session", 3n, 0n),
      timelineHistoryOwnerKey(profile, 1n, "session", 2n, 1n)
    ]) expect(cache.get(other!)).toBeUndefined();
    expect(cache.get(key)).toBeDefined();
    expect(timelineHistoryOwnerKey(undefined, 1n, "session", 2n, 0n)).toBeUndefined();
  });
});
