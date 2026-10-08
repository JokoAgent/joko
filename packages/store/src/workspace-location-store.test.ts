import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { RemoteWorkspaceBinding, SessionDescriptor, TargetDescriptor } from "@joko/core";
import { afterEach, describe, expect, it } from "vitest";

import { OperationalStore, StoreError } from "./index.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("durable workspace locations", () => {
  it("freezes a Device peer Target binding while preserving its Session snapshot across restart", () => {
    const fixture = createFixture();
    const sshBinding = {
      kind: "ssh" as const,
      hostTargetId: "host-target",
      hostId: "build",
      workspaceRoot: "/srv/project"
    };
    const peerBinding = {
      kind: "device_peer" as const,
      controllerDeviceId: "controller-device",
      targetDeviceId: "peer-device",
      workspaceRoot: "D:\\projects\\peer"
    };

    fixture.store.upsertTarget(target("ssh-target", sshBinding));
    fixture.store.upsertTarget(target("peer-target", peerBinding));
    fixture.store.createSession(session("peer-session", "peer-target", peerBinding));

    expect(fixture.store.getTarget("local-target").descriptor.remoteWorkspace).toBeUndefined();
    expect(fixture.store.getTarget("ssh-target").descriptor.remoteWorkspace).toEqual(sshBinding);
    expect(fixture.store.getTarget("peer-target").descriptor.remoteWorkspace).toEqual(peerBinding);
    expect(fixture.store.getTarget("peer-target").descriptor.remoteWorkspace)
      .not.toHaveProperty("routeGeneration");

    fixture.store.upsertTarget({ ...target("peer-target", peerBinding), displayName: "Renamed peer" });
    expect(fixture.store.getTarget("peer-target").descriptor.displayName).toBe("Renamed peer");
    for (const rebound of [
      { ...peerBinding, workspaceRoot: "D:\\projects\\next" },
      { ...peerBinding, targetDeviceId: "controller-device", controllerDeviceId: "peer-device" },
      sshBinding,
      undefined
    ]) {
      expect(() => fixture.store.upsertTarget(target("peer-target", rebound)))
        .toThrow(/Device peer Target workspace binding is immutable/u);
    }
    fixture.store.revokeDevice("peer-device");
    expect(fixture.store.getTarget("peer-target").descriptor.remoteWorkspace).toEqual(peerBinding);
    expect(fixture.store.getSession("peer-session").descriptor.remoteWorkspace).toEqual(peerBinding);

    const reopened = fixture.reopen();
    expect(reopened.getTarget("peer-target").descriptor.remoteWorkspace).toEqual(peerBinding);
    expect(reopened.getTarget("peer-target").descriptor.displayName).toBe("Renamed peer");
    expect(reopened.getSession("peer-session").descriptor.remoteWorkspace).toEqual(peerBinding);
    expect(reopened.getDevice("peer-device").state).toBe("revoked");
  });

  it("rejects mixed current-v1 shapes and protects a bound Device from deletion", () => {
    const fixture = createFixture();
    const peerBinding = {
      kind: "device_peer" as const,
      controllerDeviceId: "controller-device",
      targetDeviceId: "peer-device",
      workspaceRoot: "/home/peer/project"
    };
    fixture.store.upsertTarget(target("peer-target", peerBinding));

    const mixed = {
      ...peerBinding,
      hostTargetId: "host-target",
      hostId: "build"
    } as unknown as RemoteWorkspaceBinding;
    expect(() => fixture.store.upsertTarget(target("mixed-target", mixed)))
      .toThrow(StoreError);
    const routeBound = { ...peerBinding, routeGeneration: 7 } as unknown as RemoteWorkspaceBinding;
    expect(() => fixture.store.upsertTarget(target("route-bound-target", routeBound)))
      .toThrow(/fields do not match its kind/u);
    for (const workspaceRoot of ["\\peer-project", "C:peer-project"]) {
      expect(() => fixture.store.upsertTarget(target(`invalid-root-${workspaceRoot.length}`, {
        ...peerBinding,
        workspaceRoot
      }))).toThrow(/absolute host-native path/u);
    }

    fixture.close();
    const database = new DatabaseSync(fixture.filePath);
    try {
      database.exec("PRAGMA foreign_keys = ON");
      expect(() => database.prepare(`
        UPDATE targets
        SET remote_location_kind = 'device_peer', remote_host_target_id = 'host-target',
          remote_host_id = 'build', remote_target_device_id = 'peer-device',
          remote_workspace_root = '/mixed'
        WHERE id = 'local-target'
      `).run()).toThrow(/target remote workspace binding is incomplete/u);
      expect(() => database.prepare("DELETE FROM devices WHERE id = 'peer-device'").run())
        .toThrow(/FOREIGN KEY constraint failed/u);
      expect(() => database.prepare("DELETE FROM devices WHERE id = 'controller-device'").run())
        .toThrow(/FOREIGN KEY constraint failed/u);
    } finally {
      database.close();
    }
  });
});

function target(id: string, remoteWorkspace?: RemoteWorkspaceBinding): TargetDescriptor {
  return {
    id,
    backendId: "backend",
    displayName: id,
    workspaceRoot: `D:/service/${id}`,
    managed: false,
    trusted: true,
    ...(remoteWorkspace === undefined ? {} : { remoteWorkspace })
  };
}

function session(id: string, targetId: string, remoteWorkspace: RemoteWorkspaceBinding): SessionDescriptor {
  return {
    id,
    backendId: "backend",
    targetId,
    title: id,
    binding: { opaqueRef: `native:${id}`, generation: 0 },
    pinned: false,
    archived: false,
    permissionMode: "ask",
    planMode: false,
    fastMode: false,
    remoteWorkspace,
    createdAt: 1,
    updatedAt: 1
  };
}

function createFixture(): {
  readonly filePath: string;
  readonly store: OperationalStore;
  close(): void;
  reopen(): OperationalStore;
} {
  const directory = mkdtempSync(path.join(tmpdir(), "joko-workspace-location-store-"));
  const filePath = path.join(directory, "operational.sqlite");
  let store = new OperationalStore(filePath);
  store.upsertBackend({
    id: "backend",
    adapterKind: "fixture",
    displayName: "Backend",
    version: "1",
    instanceGeneration: 0,
    health: "healthy",
    installationState: "installed",
    authenticationState: "not_required",
    capabilities: new Map(),
    models: [],
    tools: [],
    diagnostics: []
  });
  store.upsertTarget(target("host-target"));
  store.upsertTarget(target("local-target"));
  store.createRemoteHost({
    ownerId: "owner",
    targetId: "host-target",
    id: "build",
    hostname: "build.example.test",
    user: "builder",
    source: "manual"
  });
  store.createDevice({
    id: "controller-device",
    defaultName: "Controller",
    kind: "web",
    platform: "web",
    appVersion: "test"
  });
  store.createDevice({
    id: "peer-device",
    defaultName: "Peer",
    kind: "desktop",
    platform: "win32",
    appVersion: "test"
  });
  cleanups.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    filePath,
    get store() { return store; },
    close() { store.close(); },
    reopen() {
      store.close();
      store = new OperationalStore(filePath);
      return store;
    }
  };
}
