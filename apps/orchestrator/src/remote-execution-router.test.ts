import { createInProcessDevicePeerHarness } from "@joko/device-peer";
import { OperationalStore } from "@joko/store";
import type { RemoteFileTransportPort, RemoteProcessTransportPort } from "@joko/remote-ssh";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DevicePeerOwner } from "./device-peer-owner.js";
import { RemoteExecutionRouter } from "./remote-execution-router.js";
import type { RemoteHostRegistry } from "./remote-host-registry.js";

const stores: OperationalStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("RemoteExecutionRouter", () => {
  it("binds workspace files and processes to one SSH capture and rechecks its synchronous file authority", async () => {
    const unused = async (): Promise<never> => { throw Error("No transport I/O in router authority test."); };
    const files: RemoteFileTransportPort = { realpath: unused, stat: unused, list: unused, read: unused, write: unused,
      mkdir: unused, rename: unused, remove: unused };
    const processes: RemoteProcessTransportPort = { open: unused };
    let processCurrent = true; let filesCurrent = true;
    const assertCurrent = vi.fn(() => { if (!processCurrent) throw Error("Captured process lease retired."); });
    const assertFilesCurrent = vi.fn(() => { assertCurrent(); if (!filesCurrent) throw Error("Captured file capability retired."); });
    const captured: Awaited<ReturnType<RemoteHostRegistry["captureProcessAuthority"]>> = {
      host: { ownerId: "owner", targetId: "target", id: "host", hostname: "host.example.test", port: 22, user: "maker",
        revision: 3n, source: "manual", authenticationMode: "system_agent", autoConnect: false, autoConnectRevision: 1n, createdAt: 1, updatedAt: 1,
        status: { state: "ready", changedAt: 1 }, trust: { algorithm: "ssh-ed25519", fingerprint: "SHA256:approved", pinnedAt: 1 } },
      hostRevision: 3n, leaseGeneration: 7,
      lease: { capabilities: { commandExecution: false, processStreaming: true, fileTransfer: true,
        tcpForwarding: false, interactiveTerminal: false }, files, processes },
      assertCurrent, assertFilesCurrent, assertForwardingCurrent: () => { throw Error("No forwarding capability."); }
    };
    const hosts = { captureProcessAuthority: vi.fn(async () => captured), captureTransportAuthority: vi.fn() };
    const router = new RemoteExecutionRouter({ hosts, peers: {} as DevicePeerOwner });
    const binding = { kind: "ssh" as const, hostTargetId: "target", hostId: "host", workspaceRoot: "/srv/project" };
    const authority = await router.workspace(binding);
    expect(hosts.captureProcessAuthority).toHaveBeenCalledExactlyOnceWith("target", "host", undefined);
    expect(hosts.captureTransportAuthority).not.toHaveBeenCalled();
    expect(authority.files).toBe(files); expect(authority.processes).toBe(processes);
    expect(JSON.parse(authority.authorityIdentity)).toEqual({ hostRevision: "3", leaseGeneration: 7 });
    expect(authority.pathStyle).toBe("posix");
    expect(() => authority.assertCurrent()).not.toThrow(); expect(() => authority.assertFilesCurrent()).not.toThrow();
    filesCurrent = false;
    expect(() => authority.assertCurrent()).toThrow(/file capability retired/u);
    expect(() => authority.assertFilesCurrent()).toThrow(/file capability retired/u);
    filesCurrent = true; processCurrent = false;
    expect(() => authority.assertCurrent()).toThrow(/process lease retired/u);
    expect(() => authority.assertFilesCurrent()).toThrow(/process lease retired/u);
    expect(hosts.captureProcessAuthority).toHaveBeenCalledOnce(); expect(hosts.captureTransportAuthority).not.toHaveBeenCalled();
  });

  it("resolves a durable peer binding through its frozen controller relation and current route", async () => {
    const store = new OperationalStore(":memory:");
    stores.push(store);
    const controller = store.createConnection({
      id: "controller-connection",
      deviceId: "controller-device",
      device: { defaultName: "Controller", kind: "web", platform: "web" },
      name: "Controller",
      authKeyDigest: "controller-digest"
    });
    const target = store.createConnection({
      id: "target-connection",
      deviceId: "target-device",
      device: { defaultName: "Target", kind: "desktop", platform: "windows" },
      name: "Target",
      authKeyDigest: "target-digest"
    });
    store.setDeviceRemoteControlEnabled(target.deviceId, true);
    const peers = new DevicePeerOwner({ store });
    peers.registerRoute(target, createInProcessDevicePeerHarness({
      targetDeviceId: target.deviceId,
      capabilities: ["files", "process", "terminal"],
      agent: { handle: async () => ({ outcome: "failed", errorCode: "not_used" }) }
    }).transport);
    const hosts = {
      captureTransportAuthority: vi.fn(),
      captureProcessAuthority: vi.fn()
    };
    const router = new RemoteExecutionRouter({ hosts: hosts as never, peers });
    const captured = await router.terminal({
      kind: "device_peer",
      controllerDeviceId: controller.deviceId,
      targetDeviceId: target.deviceId,
      workspaceRoot: "C:\\project"
    });

    expect(captured.kind).toBe("device_peer");
    expect(hosts.captureTransportAuthority).not.toHaveBeenCalled();
    expect(hosts.captureProcessAuthority).not.toHaveBeenCalled();
    expect(() => captured.assertCurrent()).not.toThrow();

    store.setDeviceControlRelation({
      controllerDeviceId: controller.deviceId,
      targetDeviceId: target.deviceId,
      inboundAllowed: false
    });
    expect(() => captured.assertCurrent()).toThrow(/authority|authorized/u);
    await expect(router.files({
      kind: "device_peer",
      controllerDeviceId: controller.deviceId,
      targetDeviceId: target.deviceId,
      workspaceRoot: "C:\\project"
    })).rejects.toThrow(/authorized/u);
  });
});
