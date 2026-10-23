import { create } from "@bufbuild/protobuf";
import { SnapshotSchema } from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";
import { readMobilePartnerOfflineConversation } from "./mobile-partner-offline-conversation";
import { mobilePartnerRosterSourceKey, type MobilePartnerRosterDisplay } from "./mobile-partner-roster";
import type { MobileOfflineCacheSnapshot } from "./mobile-offline-cache";

const profile = { profileId: "profile", origin: "https://node.test", serverId: "server", connectionId: "connection", deviceId: "phone", displayName: "Node" };
const source = { profile, key: mobilePartnerRosterSourceKey(profile), current: false };
const row: MobilePartnerRosterDisplay = { partnerId: "partner", displayName: "Ada", avatar: "orbit", lifecycle: "active", preview: "Saved reply",
  updatedAt: 1234, unread: 0, conversation: { sessionId: "session", targetId: "target" } };
const cached = (): MobileOfflineCacheSnapshot => ({ node: { serverId: "server", displayName: "Node", apiVersion: "v1", version: "1", health: 1, pairingEnabled: false },
  cachedAt: 1000, detailCachedAt: 900, owner: create(SnapshotSchema),
  detail: create(SnapshotSchema, { server: { serverId: "server" }, scope: { kind: { case: "session", value: { sessionId: "session" } } },
    sessions: [{ sessionId: "session", targetId: "target" }], timeline: [{ eventId: "saved-message" }] }) });

describe("saved Partner conversation read", () => {
  it("opens only the exact saved task without changing nodes or reading a credential", async () => {
    const value = cached(), load = vi.fn(async () => value);
    const result = await readMobilePartnerOfflineConversation({ load }, source, row, () => true, new AbortController().signal);
    expect(load).toHaveBeenCalledWith(profile, "session");
    expect(result).toMatchObject({ sourceKey: source.key, partnerId: "partner", sessionId: "session", savedAt: 900, events: [{ eventId: "saved-message" }] });
    expect(Object.keys(result).sort()).toEqual(["displayName", "events", "partnerId", "savedAt", "sessionId", "sourceKey"]);
  });

  it("rejects unavailable, substituted and retired cache results", async () => {
    const signal = new AbortController().signal;
    await expect(readMobilePartnerOfflineConversation({ load: async () => undefined }, source, row, () => true, signal)).rejects.toThrow("no saved conversation");
    for (const change of [
      (value: MobileOfflineCacheSnapshot) => { value.detail!.sessions[0]!.targetId = "other"; },
      (value: MobileOfflineCacheSnapshot) => { value.detail!.server!.serverId = "other"; },
      (value: MobileOfflineCacheSnapshot) => { value.detail!.scope!.kind = { case: "owner", value: { $typeName: "joko.v1.OwnerSnapshotScope" } }; }
    ]) {
      const value = cached(); change(value);
      await expect(readMobilePartnerOfflineConversation({ load: async () => value }, source, row, () => true, signal)).rejects.toThrow("no saved conversation");
    }
    let current = true;
    await expect(readMobilePartnerOfflineConversation({ load: async () => { current = false; return cached(); } }, source, row, () => current, signal)).rejects.toThrow("source changed");
    const abort = new AbortController(); abort.abort(); const load = vi.fn(async () => cached());
    await expect(readMobilePartnerOfflineConversation({ load }, source, row, () => true, abort.signal)).rejects.toThrow();
    expect(load).not.toHaveBeenCalled();
  });
});
