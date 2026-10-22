import { createHash } from "node:crypto";
import { mkdir, readdir, realpath, rename, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevicePeerResponsePhase, type DevicePeerCommand } from "@joko/contracts";
import { createInProcessDevicePeerHarness, LocalDevicePeerFileTransport, NodeDevicePeerAgentExecutor,
  type NodeDevicePeerAgentEmission } from "@joko/device-peer";
import { OperationalStore } from "@joko/store";
import { describe, expect, it, vi } from "vitest";
import { DevicePeerOwner } from "./device-peer-owner.js";
import { RemoteExecutionRouter } from "./remote-execution-router.js";
import { RemoteFileVersionCache } from "./remote-file-version-cache.js";
import { RemoteWorkspaceService } from "./remote-workspace-service.js";
import { WorkspaceService, type WorkspaceRegistration } from "./workspace-service.js";
import { mkdtemp } from "./test-paths.js";

describe("remote workspace version cache integration", () => {
  it("reuses authenticated peer bytes for preview, download and a cold cache while still validating stat", async () => {
    const f = await fixture();
    let service = await f.open();
    try {
      const first = await service.preview("cache-workspace", "owned.txt");
      expect(first.text).toBe("hello");
      expect(f.reads).toHaveBeenCalledTimes(1);
      const downloaded = await service.materializeFile("cache-workspace", "owned.txt", first.entry.revision, async (handle, options) => {
        const bytes = await handle.readFile();
        await options.beforeFinalize({ sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length });
        return bytes.toString("utf8");
      });
      expect(downloaded).toBe("hello");
      expect(f.reads).toHaveBeenCalledTimes(1);
      await service.close();
      service = await f.open();
      expect((await service.preview("cache-workspace", "owned.txt", 2)).text).toBe("he");
      expect(f.reads).toHaveBeenCalledTimes(1);
      expect(f.commands.filter(command => command.action.case === "statFile").length).toBeGreaterThan(3);
      const bin = (await readdir(f.cacheRoot)).find(name => name.endsWith(".bin"))!;
      await writeFile(join(f.cacheRoot, bin), "helXX");
      expect((await service.preview("cache-workspace", "owned.txt", 2)).text).toBe("he");
      expect(f.reads).toHaveBeenCalledTimes(2);
      expect((await readdir(f.cacheRoot)).filter(name => name.endsWith(".part"))).toEqual([]);
    } finally { await service.close(); await f.close(); }
  });

  it("invalidates same-size writes with a preserved mtime using the host's exact version", async () => {
    const f = await fixture();
    const service = await f.open();
    try {
      const before = await f.files.stat(f.file);
      expect((await service.preview("cache-workspace", "owned.txt")).text).toBe("hello");
      await writeFile(f.file, "world");
      await utimes(f.file, new Date(4000), new Date(4000));
      const after = await f.files.stat(f.file);
      expect(after.size).toBe(before.size);
      expect(after.modifiedAt).toBe(before.modifiedAt);
      expect(after.version).not.toBe(before.version);
      expect((await service.preview("cache-workspace", "owned.txt")).text).toBe("world");
      expect(f.reads).toHaveBeenCalledTimes(2);
      expect((await readdir(f.cacheRoot)).filter(name => name.endsWith(".bin"))).toHaveLength(1);
    } finally { await service.close(); await f.close(); }
  });

  it("isolates the controller binding and refuses existing cached bytes after route retirement", async () => {
    const f = await fixture();
    const first = await f.open();
    let second: WorkspaceService | undefined;
    try {
      expect((await first.preview("cache-workspace", "owned.txt")).text).toBe("hello");
      const other = f.store.createConnection({ id: "other-controller", deviceId: "other-controller-device",
        device: { defaultName: "Other controller", kind: "web", platform: "web" }, name: "Other controller", authKeyDigest: "other-digest" });
      const binding = f.registration.remote!.binding;
      if (binding.kind !== "device_peer") throw new Error("The fixture requires a paired workspace.");
      second = await f.open({ ...f.registration, remote: { ...f.registration.remote!, binding: { ...binding, controllerDeviceId: other.deviceId } } });
      expect((await second.preview("cache-workspace", "owned.txt")).text).toBe("hello");
      expect(f.reads).toHaveBeenCalledTimes(2);
      expect((await readdir(f.cacheRoot)).filter(name => name.endsWith(".bin"))).toHaveLength(2);
      f.owner.retireRoute(f.route, "authority_changed");
      await expect(first.preview("cache-workspace", "owned.txt")).rejects.toBeDefined();
      await expect(second.preview("cache-workspace", "owned.txt")).rejects.toBeDefined();
      expect(f.reads).toHaveBeenCalledTimes(2);
    } finally { await first.close(); await second?.close(); await f.close(); }
  });

  it("keeps fresh authorized reads available when the optional cache cannot write", async () => {
    const f = await fixture();
    await writeFile(f.cacheRoot, "preserve this unrelated file");
    const service = await f.open();
    try {
      expect((await service.preview("cache-workspace", "owned.txt")).text).toBe("hello");
      expect((await service.preview("cache-workspace", "owned.txt")).text).toBe("hello");
      expect(f.reads).toHaveBeenCalledTimes(2);
    } finally { await service.close(); await f.close(); }
  });

  it("binds byte reads to the attested object even when a directory is replaced and restored", async () => {
    const f = await fixture();
    const service = await f.open();
    const replacement = join(f.root, "replacement"), saved = join(f.root, "saved");
    await mkdir(replacement);
    await writeFile(join(replacement, "owned.txt"), "other");
    await utimes(join(replacement, "owned.txt"), new Date(4000), new Date(4000));
    const original = LocalDevicePeerFileTransport.prototype.read.bind(f.files);
    let substituted = false;
    f.reads.mockImplementationOnce(async request => {
      await rename(f.workspaceRoot, saved);
      await rename(replacement, f.workspaceRoot);
      substituted = true;
      try { return await original(request); }
      finally {
        await rename(f.workspaceRoot, replacement);
        await rename(saved, f.workspaceRoot);
      }
    });
    try {
      const version = (await f.files.stat(f.file)).version;
      await expect(service.preview("cache-workspace", "owned.txt")).rejects.toBeDefined();
      expect(substituted).toBe(true);
      expect((await f.files.stat(f.file)).version).toBe(version);
      expect(await readdir(f.cacheRoot)).toEqual([]);
      expect((await service.preview("cache-workspace", "owned.txt")).text).toBe("hello");
      expect(f.reads).toHaveBeenCalledTimes(2);
      const request = f.commands.find(command => command.action.case === "readFile");
      expect(request?.action.case === "readFile" ? request.action.value.expectedVersion : undefined).toBe(version);
    } finally { await service.close(); await f.close(); }
  });

  it("does not publish cached bytes after the exact route that read them is retired", async () => {
    const f = await fixture();
    const service = await f.open();
    let release!: () => void, observed!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const read = new Promise<void>(resolve => { observed = resolve; });
    const original = LocalDevicePeerFileTransport.prototype.read.bind(f.files);
    f.reads.mockImplementation(async request => {
      const bytes = await original(request); observed(); await gate; return bytes;
    });
    try {
      const pending = service.preview("cache-workspace", "owned.txt");
      const rejected = pending.then(() => false, () => true);
      await read;
      f.owner.retireRoute(f.route, "authority_changed");
      release();
      expect(await rejected).toBe(true);
      expect(await readdir(f.cacheRoot)).toEqual([]);
      await expect(service.preview("cache-workspace", "owned.txt")).rejects.toBeDefined();
      expect(f.reads).toHaveBeenCalledTimes(1);
    } finally { release(); await service.close(); await f.close(); }
  });
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joko-peer-cache-")));
  const workspaceRoot = join(root, "workspace"), cacheRoot = join(root, "private-cache");
  await mkdir(workspaceRoot);
  const file = join(workspaceRoot, "owned.txt");
  await writeFile(file, "hello");
  await utimes(file, new Date(4000), new Date(4000));
  const store = new OperationalStore(":memory:");
  const controller = store.createConnection({ id: "cache-controller", deviceId: "cache-controller-device",
    device: { defaultName: "Controller", kind: "web", platform: "web" }, name: "Controller", authKeyDigest: "controller-digest" });
  const target = store.createConnection({ id: "cache-target", deviceId: "cache-target-device",
    device: { defaultName: "Target", kind: "desktop", platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux" },
    name: "Target", authKeyDigest: "target-digest" });
  store.setDeviceRemoteControlEnabled(target.deviceId, true);
  const owner = new DevicePeerOwner({ store }), files = new LocalDevicePeerFileTransport();
  const reads = vi.spyOn(files, "read");
  const executor = new NodeDevicePeerAgentExecutor({ files, recentDirectoriesPath: join(root, "recent.json") });
  const commands: DevicePeerCommand[] = [];
  const harness = createInProcessDevicePeerHarness({ targetDeviceId: target.deviceId, capabilities: ["files", "process"],
    agent: { handle: async (frame, signal) => {
      const command = frame.payload as DevicePeerCommand;
      commands.push(command);
      const results: NodeDevicePeerAgentEmission[] = [];
      await executor.execute(command, signal, async result => { results.push(result); });
      const completed = results.find(result => result.phase === DevicePeerResponsePhase.COMPLETED);
      if (completed) return { outcome: "completed", value: completed.payload };
      if (results.some(result => result.phase === DevicePeerResponsePhase.ABORTED)) return { outcome: "aborted" };
      const failure = results.find(result => result.payload.case === "failure");
      if (failure?.payload.case === "failure") return { outcome: "failed", errorCode: "native_rejected", failure: failure.payload.value };
      throw new Error("The native file request did not produce a terminal result.");
    } } });
  const route = owner.registerRoute(target, harness.transport);
  const execution = new RemoteExecutionRouter({ peers: owner,
    hosts: { captureProcessAuthority: async () => { throw new Error("SSH is outside this paired-device fixture."); },
      captureTransportAuthority: async () => { throw new Error("SSH is outside this paired-device fixture."); } } });
  const registration: WorkspaceRegistration = { id: "cache-workspace", root: workspaceRoot, displayName: "Owned workspace", trusted: true,
    remote: { targetId: "cache-target", binding: { kind: "device_peer", controllerDeviceId: controller.deviceId,
      targetDeviceId: target.deviceId, workspaceRoot } } };
  return { files, file, reads, commands, cacheRoot, owner, route, store, registration, root, workspaceRoot,
    open: async (registered = registration) => {
      const service = new WorkspaceService({ remoteDelegate: new RemoteWorkspaceService(execution,
        { cache: new RemoteFileVersionCache(cacheRoot) }) });
      await service.register(registered);
      return service;
    },
    close: async () => { owner.retireRoute(route, "shutdown"); await executor.retire(); store.close(); }
  };
}
