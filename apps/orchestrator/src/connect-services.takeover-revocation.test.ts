import { rmSync } from "node:fs";
import { mkdtempSync } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import {
  BrowserTakeoverConflictError,
  sameTakeoverFence,
  type BrowserTakeover,
  type BrowserTakeoverFence
} from "@joko/tool-browser";
import { OperationalStore, type ConnectionRecord } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OrchestratorApplication } from "./application.js";
import { createConnectServices } from "./connect-services.js";
import { ConnectionManager } from "./connection-manager.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

interface MutationInput {
  readonly operationId: string;
  readonly connection: ConnectionRecord;
  readonly kind: string;
  readonly body: unknown;
  readonly commit: (store: OperationalStore) => unknown;
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "joko-takeover-revoke-"));
  const store = new OperationalStore(join(directory, "orchestrator.db"));
  cleanups.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const actor = store.createConnection({
    id: "connection-actor",
    deviceId: "device-actor",
    name: "Owner",
    authKeyDigest: "digest-actor",
    pairedAt: 1
  });
  const manager = new ConnectionManager(store);
  const revoke = vi.fn((connectionId: string) => manager.revoke(connectionId));
  const logout = vi.fn((connectionId: string, authenticatedConnectionId: string) =>
    manager.logout(connectionId, authenticatedConnectionId));
  const revokeDevice = vi.fn((deviceId: string) => manager.revokeDevice(deviceId));
  const connections = {
    authenticate: vi.fn(() => store.authorizeConnection(actor.id, actor.authKeyDigest)),
    logout,
    revoke,
    revokeDevice
  };
  let current: BrowserTakeover | undefined;
  const endHumanTakeover = vi.fn(async (fence: BrowserTakeoverFence): Promise<void> => {
    if (current === undefined || !sameTakeoverFence(current, fence)) {
      throw new BrowserTakeoverConflictError("Browser takeover is missing, expired, or fenced.");
    }
    current = undefined;
  });
  const browser = {
    id: "browser",
    generation: 7,
    currentHumanTakeover: () => current,
    endHumanTakeover
  };
  const sessionHost = {
    mutate: async (input: MutationInput) => store.runAuthorizedOperation(
      input.connection.id,
      input.connection.authKeyDigest,
      { id: input.operationId, kind: input.kind, body: input.body },
      () => input.commit(store)
    )
  };
  const application = {
    config: { publicOrigin: "https://orchestrator.example.test" },
    store,
    connections,
    artifacts: {},
    blobTransfers: {},
    artifactRepository: {},
    workspaces: {},
    workspaceChanges: {},
    sessionHost,
    scheduler: {},
    adapters: [],
    browser,
    browserActivity: [],
    close: async () => undefined
  } as unknown as OrchestratorApplication;
  return {
    actor,
    browser,
    connections,
    endHumanTakeover,
    services: createConnectServices(application),
    setCurrent: (takeover: BrowserTakeover | undefined) => { current = takeover; },
    current: () => current,
    store
  };
}

function addConnection(
  store: OperationalStore,
  id: string,
  deviceId: string
): ConnectionRecord {
  return store.createConnection({
    id,
    deviceId,
    name: id,
    authKeyDigest: `digest-${id}`,
    pairedAt: 2
  });
}

function takeover(owner: string, generation = 7, takeoverId = "takeover-old"): BrowserTakeover {
  return {
    providerId: "browser",
    pageId: `page-${generation}`,
    generation,
    owner,
    takeoverId,
    startedAt: 10,
    expiresAt: 60_000
  };
}

function logoutMutation(connectionId: string): contract.OperationMutation {
  return create(contract.OperationMutationSchema, {
    payload: {
      case: "logoutConnection",
      value: create(contract.LogoutConnectionMutationSchema, { connectionId })
    }
  });
}

function revokeDeviceMutation(deviceId: string): contract.OperationMutation {
  return create(contract.OperationMutationSchema, {
    payload: {
      case: "revokeDevice",
      value: create(contract.RevokeDeviceMutationSchema, { deviceId, reason: "test" })
    }
  });
}

async function submit(
  services: ReturnType<typeof createConnectServices>,
  operationId: string,
  mutation: contract.OperationMutation
): Promise<void> {
  await services.operation.submitOperation(create(contract.SubmitOperationRequestSchema, {
    operationId,
    connectionId: "connection-actor",
    mutation
  }), {
    requestHeader: new Headers({ authorization: "Bearer test" }),
    signal: new AbortController().signal
  } as never);
}

describe("Connect Browser takeover revocation cleanup", () => {
  it("ends the exact logoutConnection owner's takeover once and does not repeat cleanup on mutation replay", async () => {
    const value = fixture();
    const revoked = addConnection(value.store, "connection-browser-owner", "device-browser-owner");
    const original = takeover(revoked.id);
    value.setCurrent(original);
    const mutation = logoutMutation(revoked.id);

    await submit(value.services, "operation-logout-browser-owner", mutation);

    expect(value.connections.logout).toHaveBeenCalledWith(revoked.id, value.actor.id);
    expect(value.endHumanTakeover).toHaveBeenCalledOnce();
    expect(value.endHumanTakeover).toHaveBeenCalledWith({
      providerId: original.providerId,
      pageId: original.pageId,
      generation: original.generation,
      owner: original.owner,
      takeoverId: original.takeoverId
    });
    expect(value.current()).toBeUndefined();
    expect(value.store.getConnection(revoked.id).state).toBe("revoked");

    const newer = takeover(revoked.id, 8, "takeover-new-after-replay");
    value.setCurrent(newer);
    await submit(value.services, "operation-logout-browser-owner", mutation);

    expect(value.connections.logout).toHaveBeenCalledOnce();
    expect(value.endHumanTakeover).toHaveBeenCalledOnce();
    expect(value.current()).toEqual(newer);
  });

  it("rejects a new logout operation for connection history that is already revoked", async () => {
    const value = fixture();
    const revoked = addConnection(value.store, "connection-already-revoked", "device-already-revoked");
    value.connections.revoke(revoked.id);

    await expect(submit(
      value.services,
      "operation-repeat-logout",
      logoutMutation(revoked.id)
    )).rejects.toThrow("already revoked");
    expect(value.connections.revoke).toHaveBeenCalledOnce();
    expect(value.connections.logout).not.toHaveBeenCalled();
  });

  it("checks every Connection in a 1:N revokeDevice result and releases only its exact owner", async () => {
    const value = fixture();
    const first = addConnection(value.store, "connection-device-first", "device-shared");
    const owner = addConnection(value.store, "connection-device-owner", "device-shared");
    const active = takeover(owner.id);
    value.setCurrent(active);

    await submit(value.services, "operation-revoke-shared-device", revokeDeviceMutation("device-shared"));

    expect(value.connections.revokeDevice).toHaveBeenCalledOnce();
    expect(value.store.getConnection(first.id).state).toBe("revoked");
    expect(value.store.getConnection(owner.id).state).toBe("revoked");
    expect(value.endHumanTakeover).toHaveBeenCalledExactlyOnceWith({
      providerId: active.providerId,
      pageId: active.pageId,
      generation: active.generation,
      owner: active.owner,
      takeoverId: active.takeoverId
    });
    expect(value.current()).toBeUndefined();
  });

  it("does not disturb a takeover owned by an unrelated Connection", async () => {
    const value = fixture();
    addConnection(value.store, "connection-device-target", "device-target");
    const unrelated = takeover(value.actor.id);
    value.setCurrent(unrelated);

    await submit(value.services, "operation-revoke-unrelated-device", revokeDeviceMutation("device-target"));

    expect(value.endHumanTakeover).not.toHaveBeenCalled();
    expect(value.current()).toEqual(unrelated);
  });

  it("cannot end a newer takeover when the observed fence changes during asynchronous cleanup", async () => {
    const value = fixture();
    const revoked = addConnection(value.store, "connection-race-owner", "device-race-owner");
    const original = takeover(revoked.id);
    const newer = takeover(revoked.id, 8, "takeover-new-generation");
    value.setCurrent(original);
    const diagnostic = vi.spyOn(value.store, "appendDiagnostic");
    value.endHumanTakeover.mockImplementationOnce(async () => {
      value.setCurrent(newer);
      throw new BrowserTakeoverConflictError("stale cleanup fence");
    });

    await submit(value.services, "operation-logout-racing-owner", logoutMutation(revoked.id));
    await vi.waitFor(() => expect(value.current()).toEqual(newer));

    expect(value.current()).toEqual(newer);
    expect(diagnostic).not.toHaveBeenCalled();
  });

  it("keeps revocation successful and records only a redacted diagnostic when cleanup fails", async () => {
    const value = fixture();
    const revoked = addConnection(value.store, "connection-failing-owner", "device-failing-owner");
    const active = takeover(revoked.id);
    value.setCurrent(active);
    const diagnostic = vi.spyOn(value.store, "appendDiagnostic");
    value.endHumanTakeover.mockRejectedValueOnce(new Error(
      "secret bearer-token and https://credential.example.invalid"
    ));

    await submit(value.services, "operation-logout-failing-owner", logoutMutation(revoked.id));
    await vi.waitFor(() => expect(diagnostic).toHaveBeenCalledOnce());

    expect(value.store.getConnection(revoked.id).state).toBe("revoked");
    expect(value.current()).toEqual(active);
    expect(diagnostic).toHaveBeenCalledWith({
      severity: "warning",
      component: "browser",
      code: "BROWSER_TAKEOVER_REVOKE_CLEANUP_FAILED",
      message: "A revoked Connection's Browser takeover could not be released automatically.",
      details: {}
    });
    const serialized = JSON.stringify(diagnostic.mock.calls);
    expect(serialized).not.toContain("bearer-token");
    expect(serialized).not.toContain("credential.example.invalid");
    expect(serialized).not.toContain(revoked.id);
    expect(serialized).not.toContain(active.takeoverId);
  });
});
