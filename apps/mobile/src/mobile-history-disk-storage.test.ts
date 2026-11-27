import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import { ConnectionState, DeviceKind, MessageRole, SnapshotSchema } from "@joko/contracts";
import { createMobileHistoryDiskStorage, createExpoMobileHistoryDiskIO } from "./mobile-history-disk-storage";
import { MobileOfflineCache } from "./mobile-offline-cache";

const fixture: { root: string; beforeStageRead?: () => Promise<void>; beforeMove?: (from: string, to: string) => void } = { root: "" };
async function nodeFileSystem() {
  const fs = await import("node:fs"), path = await import("node:path");
  const uri = (part: string | { uri: string }) => typeof part === "string" ? part : part.uri;
  class Directory {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) { this.uri = path.join(...parts.map(uri)); }
    get name() { return path.basename(this.uri); }
    get exists() { return fs.existsSync(this.uri); }
    create() { fs.mkdirSync(this.uri, { recursive: true }); }
    list(): Array<Directory | File> { return fs.readdirSync(this.uri, { withFileTypes: true }).map(entry => entry.isDirectory() ? new Directory(this, entry.name) : new File(this, entry.name)); }
  }
  class File {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) { this.uri = path.join(...parts.map(uri)); }
    get name() { return path.basename(this.uri); }
    get exists() { return fs.existsSync(this.uri); }
    get size() { return fs.statSync(this.uri).size; }
    create() { fs.writeFileSync(this.uri, ""); }
    write(text: string) { fs.writeFileSync(this.uri, text); }
    async text() { if (this.uri.endsWith(".tmp")) await fixture.beforeStageRead?.(); return fs.promises.readFile(this.uri, "utf8"); }
    delete() { fs.unlinkSync(this.uri); }
    moveSync(destination: File) {
      fixture.beforeMove?.(this.name, destination.name);
      if (destination.exists) throw new Error("Destination exists");
      fs.renameSync(this.uri, destination.uri);
      this.uri = destination.uri;
    }
  }
  return { Directory, File, Paths: { get cache() { return fixture.root; } } };
}
const fileSystem = nodeFileSystem();
const disk = createExpoMobileHistoryDiskIO(async () => await fileSystem as unknown as Pick<typeof import("expo-file-system"), "Directory" | "File" | "Paths">);

beforeEach(async () => { fixture.beforeStageRead = undefined; fixture.beforeMove = undefined; fixture.root = await mkdtemp(join(tmpdir(), "joko-history-disk-")); });
afterEach(async () => {
  if (!fixture.root.startsWith(tmpdir() + sep) || !fixture.root.includes("joko-history-disk-")) throw new Error("Unsafe fixture cleanup.");
  await rm(fixture.root, { recursive: true, force: true });
});

describe("private message history files", () => {
  it("reopens the committed index and messages after a failed offline read-recency replacement", async () => {
    const reopen = () => {
      const io = createExpoMobileHistoryDiskIO(async () => await fileSystem as unknown as Pick<typeof import("expo-file-system"), "Directory" | "File" | "Paths">);
      return new MobileOfflineCache(createMobileHistoryDiskStorage(io), () => 1000, () => "write");
    };
    const profile = { profileId: "profile", serverId: "server", connectionId: "connection", deviceId: "device", displayName: "Phone", origin: "https://node.example" };
    const node = { serverId: profile.serverId, displayName: "Node", apiVersion: "joko.v1", version: "0.1.0", health: 1, pairingEnabled: true };
    const session = { sessionId: "task", backendId: "backend", targetId: "target", nativeBinding: { runtimeGeneration: 1n } };
    const owner = create(SnapshotSchema, { snapshotId: "index", generation: 1n, scope: { kind: { case: "owner", value: {} } }, server: node,
      connections: [{ connectionId: profile.connectionId, connectionProfileId: profile.profileId, deviceId: profile.deviceId, state: ConnectionState.CONNECTED }],
      devices: [{ deviceId: profile.deviceId, kind: DeviceKind.MOBILE, connectionIds: [profile.connectionId] }], sessions: [session] });
    const detail = create(SnapshotSchema, { snapshotId: "detail", generation: 1n, server: node, sessions: [session],
      scope: { kind: { case: "session", value: { sessionId: "task", recentTimelineItems: 120 } } },
      timeline: [{ eventId: "message", identity: { sessionId: "task" }, payload: { kind: { case: "messageCompleted",
        value: { messageId: "reply", role: MessageRole.ASSISTANT, blocks: [{ content: { case: "text", value: "Saved reply" } }] } } } }] });
    const cache = reopen();
    await cache.save(profile, node, owner, detail);
    const move = vi.fn((from: string, to: string) => {
      if (from === "manifest.tmp" && to === "manifest.json") throw new Error("Manifest move failed");
    });
    fixture.beforeMove = move;
    expect((await cache.load(profile, "task"))?.detail?.timeline).toEqual(detail.timeline);
    expect(move).toHaveBeenCalledWith("manifest.tmp", "manifest.json");
    fixture.beforeMove = undefined;
    const cold = reopen();
    expect((await cold.load(profile))?.owner.sessions.map(item => item.sessionId)).toEqual(["task"]);
    expect((await cold.load(profile, "task"))?.detail?.timeline).toEqual(detail.timeline);
  });
  it("does not let one profile's enumeration remove another in-flight history write", async () => {
    const storage = createMobileHistoryDiskStorage(disk);
    let complete!: () => void;
    fixture.beforeStageRead = () => new Promise<void>(resolve => { complete = resolve; });
    const write = storage.setItem("joko.mobile.offline-cache.v1.profile.manifest", "original owner");
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    expect(await storage.getAllKeys()).toEqual([]);
    complete(); await write;
    expect(await storage.getItem("joko.mobile.offline-cache.v1.profile.manifest")).toBe("original owner");
  });

  it("persists exact Unicode bytes through cold reads and enumerates profile ownership without reading message bodies", async () => {
    const storage = createMobileHistoryDiskStorage(disk);
    const key = "joko.mobile.offline-cache.v1.profile.detail.session.write";
    await storage.setItem(key, "Saved message 中文 👋");
    await storage.setItem("joko.mobile.offline-cache.v1.profile.manifest", "manifest");
    await storage.setItem("joko.mobile.offline-cache.v1.other.manifest", "other owner");
    const cold = createMobileHistoryDiskStorage(disk);
    expect(await cold.getItem(key)).toBe("Saved message 中文 👋");
    expect([...(await cold.getAllKeys())].sort()).toEqual([key, "joko.mobile.offline-cache.v1.profile.manifest", "joko.mobile.offline-cache.v1.other.manifest"].sort());
    await cold.multiRemove([key, "joko.mobile.offline-cache.v1.profile.manifest"]);
    expect(await cold.getItem(key)).toBeNull();
    expect(await cold.getItem("joko.mobile.offline-cache.v1.other.manifest")).toBe("other owner");
  });
  it("rejects escaping/unrelated keys, never reads an old settings copy, and removes unfinished cache writes", async () => {
    const storage = createMobileHistoryDiskStorage(disk);
    for (const key of ["credential", "joko.mobile.offline-cache.v1...manifest", "joko.mobile.offline-cache.v1.profile.detail.session/escape.write"])
      expect(() => storage.setItem(key, "unrelated")).toThrow("key is invalid");
    await storage.setItem("joko.mobile.offline-cache.v1.profile.manifest", "valid");
    await writeFile(join(fixture.root, "joko-mobile-history-v1", "profile", "manifest.tmp"), "incomplete");
    expect(await storage.getAllKeys()).toEqual(["joko.mobile.offline-cache.v1.profile.manifest"]);
    expect(await storage.getItem("joko.mobile.offline-cache.v1.missing.manifest")).toBeNull();
    await storage.setItem("joko.mobile.offline-cache.v1.profile.manifest", "replacement");
    expect(await storage.getItem("joko.mobile.offline-cache.v1.profile.manifest")).toBe("replacement");
  });
});
