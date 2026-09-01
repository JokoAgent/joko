import { describe, expect, it, vi } from "vitest";

import {
  automaticConnectionCommitCurrent,
  automaticConnectionProfile,
  automaticConnectionTargetForProfile,
  automaticConnectionTargetMatchesDevice,
  automaticConnectionTargetMatchesProfile,
  composerDraftWithEditorText,
  logoutConnectionProfile,
  machineRetryDelayMs,
  managedConnectionProfile,
  managedOrchestratorStatusAfterExplicitPairing,
  pendingManagedAutomaticConnectionEligible,
  probeDesktopManagedRuntimeActivity,
  profilesWithManagedConnection,
  qualifiedRemoteSearchFilterId,
  remoteSessionMessageSearchOptionsForProfile,
  shouldDeleteInvalidatedConnectionCredential,
  trustedReusablePairingProfiles
} from "./controller.js";
import type { ConnectionProfile } from "./model.js";

describe("federated message search routing", () => {
  it("passes scalar filters and only node-local ids qualified for the selected profile", () => {
    const eastTarget = qualifiedRemoteSearchFilterId("east", "target-a");
    const westTarget = qualifiedRemoteSearchFilterId("west", "target-b");
    const eastSession = qualifiedRemoteSearchFilterId("east", "session-a");
    const options = remoteSessionMessageSearchOptionsForProfile("east", {
      scope: { kind: "session", sessionId: eastSession },
      semanticMode: "hybrid",
      pageSize: 100,
      filters: {
        targetIds: [eastTarget, westTarget],
        sessionIds: [eastSession],
        sessionStatus: "active",
        sessionActivityFrom: 42
      }
    });

    expect(options).toEqual({
      scope: { kind: "session", sessionId: "session-a" },
      semanticMode: "hybrid",
      pageSize: 100,
      filters: {
        targetIds: ["target-a"],
        sessionIds: ["session-a"],
        sessionStatus: "active",
        sessionActivityFrom: 42
      }
    });
  });

  it("fails closed for bare or another-profile identities without disabling safely routed profiles", () => {
    expect(remoteSessionMessageSearchOptionsForProfile("east", { filters: { backendIds: ["bare-backend"] } })).toBeUndefined();
    expect(remoteSessionMessageSearchOptionsForProfile("east", {
      filters: { backendIds: [qualifiedRemoteSearchFilterId("west", "backend")] }
    })).toBeUndefined();
    expect(remoteSessionMessageSearchOptionsForProfile("west", {
      filters: { backendIds: [qualifiedRemoteSearchFilterId("west", "backend")] }
    })?.filters?.backendIds).toEqual(["backend"]);
  });

  it("uses deterministic increasing retry delays with a firm upper bound", () => {
    const delays = Array.from({ length: 12 }, (_, index) => machineRetryDelayMs("remote-east", index + 1));
    expect(delays[0]).toBeGreaterThanOrEqual(1_700);
    expect(delays.every((delay) => delay <= 120_000)).toBe(true);
    expect(delays.at(-1)).toBe(120_000);
    expect(delays[1]!).toBeGreaterThan(delays[0]!);
  });
});

describe("Desktop-managed Orchestrator profile", () => {
  const connection: JokoDesktopManagedOrchestratorConnection = {
    profileId: "connection_local_1",
    deviceId: "device-local-1",
    serverId: "server-local-1",
    name: "Local Joko",
    origin: "http://127.0.0.1:4318"
  };

  it("accepts only a loopback bootstrap and marks it as Desktop managed", () => {
    expect(managedConnectionProfile(connection, [])).toEqual({
      id: connection.profileId,
      deviceId: connection.deviceId,
      serverId: connection.serverId,
      name: connection.name,
      origin: connection.origin,
      managedLocal: true
    });
  });

  it("preserves prior last-use metadata for the exact connection", () => {
    expect(managedConnectionProfile(connection, [{
      id: connection.profileId,
      deviceId: connection.deviceId,
      serverId: connection.serverId,
      name: "Previous",
      origin: connection.origin,
      lastConnectedAt: 42
    }]).lastConnectedAt).toBe(42);
  });

  it.each([
    "http://192.168.1.20:4318",
    "https://orchestrator.example.test",
    "http://0.0.0.0:4318"
  ])("rejects a managed bootstrap outside loopback: %s", (origin) => {
    expect(() => managedConnectionProfile({ ...connection, origin }, [])).toThrow();
  });

  it("rejects malformed host metadata", () => {
    expect(() => managedConnectionProfile({ ...connection, profileId: "../secret" }, [])).toThrow();
    expect(() => managedConnectionProfile({ ...connection, serverId: "" }, [])).toThrow();
  });

  it("remembers managed local by stable intent across rotating connection profiles", () => {
    const first = managedConnectionProfile(connection, []);
    const rotatedConnection = { ...connection, profileId: "connection_local_2" };
    const rotated = managedConnectionProfile(rotatedConnection, []);
    const target = automaticConnectionTargetForProfile(first);

    expect(target).toEqual({ kind: "managedLocal" });
    expect(automaticConnectionProfile(target, [rotated], { state: "ready", connection: rotatedConnection })).toBe(rotated);
    expect(automaticConnectionProfile(target, [rotated], { state: "starting" })).toBeUndefined();
    expect(automaticConnectionTargetMatchesProfile(target, rotated.id, [rotated])).toBe(true);
    expect(automaticConnectionTargetMatchesDevice(target, rotated.deviceId, [rotated])).toBe(true);
  });

  it("remembers an ordinary remote connection by its exact profile only", () => {
    const remote: ConnectionProfile = { id: "remote-a", deviceId: "device-test", name: "Remote", origin: "https://orchestrator.example.test" , serverId: "server-test" };
    const other: ConnectionProfile = { ...remote, id: "remote-b" };
    const target = automaticConnectionTargetForProfile(remote);

    expect(target).toEqual({ kind: "profile", profileId: remote.id });
    expect(automaticConnectionProfile(target, [other, remote], undefined)).toBe(remote);
    expect(automaticConnectionProfile(target, [other], undefined)).toBeUndefined();
    expect(automaticConnectionTargetMatchesProfile(target, remote.id, [remote])).toBe(true);
    expect(automaticConnectionTargetMatchesProfile(target, other.id, [other])).toBe(false);
  });

  it("reuses pairing credentials only after an exact anonymous node identity match", () => {
    const trusted: ConnectionProfile = {
      id: "trusted",
      deviceId: "device-trusted",
      serverId: "server-trusted",
      name: "Trusted",
      origin: "https://orchestrator.example.test",
      lastConnectedAt: 20
    };
    const replacementIdentity = { ...trusted, id: "replacement", serverId: "server-replacement" };
    const wrongOrigin = { ...trusted, id: "origin", origin: "https://other.example.test" };
    const rejectedManaged = { ...trusted, id: "managed", managedLocal: true };

    expect(trustedReusablePairingProfiles(
      [replacementIdentity, wrongOrigin, rejectedManaged, trusted],
      "https://orchestrator.example.test/",
      "server-trusted"
    )).toEqual([trusted]);
  });

  it("matches revocation targets without requiring the managed service to be ready", () => {
    const managed = managedConnectionProfile(connection, []);
    const remote: ConnectionProfile = {
      id: "remote-a",
      deviceId: "remote-device",
      serverId: "remote-server",
      name: "Remote",
      origin: "https://orchestrator.example.test"
    };
    expect(automaticConnectionTargetMatchesDevice({ kind: "managedLocal" }, managed.deviceId, [managed, remote])).toBe(true);
    expect(automaticConnectionTargetMatchesDevice({ kind: "profile", profileId: remote.id }, remote.deviceId, [managed, remote])).toBe(true);
    expect(automaticConnectionTargetMatchesDevice({ kind: "profile", profileId: remote.id }, managed.deviceId, [managed, remote])).toBe(false);
  });

  it("merges a refreshed local profile without losing concurrent remote changes", () => {
    const stale = managedConnectionProfile(connection, []);
    const rotated = managedConnectionProfile({ ...connection, profileId: "connection_local_2" }, []);
    const remote: ConnectionProfile = { id: "remote-current", deviceId: "device-test", name: "Remote", origin: "https://orchestrator.example.test" , serverId: "server-test" };
    expect(profilesWithManagedConnection([stale, remote], rotated)).toEqual([remote, rotated]);
  });

  it("never lets a pending local startup choice preempt an explicit remote attempt", () => {
    const remote: ConnectionProfile = { id: "remote", deviceId: "device-test", name: "Remote", origin: "https://orchestrator.example.test" , serverId: "server-test" };
    expect(pendingManagedAutomaticConnectionEligible(true, "disconnected", undefined)).toBe(true);
    expect(pendingManagedAutomaticConnectionEligible(true, "connecting", undefined)).toBe(false);
    expect(pendingManagedAutomaticConnectionEligible(true, "disconnected", remote)).toBe(false);
    expect(pendingManagedAutomaticConnectionEligible(false, "disconnected", undefined)).toBe(false);
  });

  it("rejects a late automatic-target write after logout or a newer user preference", () => {
    const current = {
      expectedGatewayGeneration: 4,
      currentGatewayGeneration: 4,
      expectedPreferenceIntent: 7,
      currentPreferenceIntent: 7,
      expectedProfileId: "remote",
      activeProfileId: "remote",
      connectionState: "connected" as const
    };
    expect(automaticConnectionCommitCurrent(current)).toBe(true);
    expect(automaticConnectionCommitCurrent({ ...current, currentGatewayGeneration: 5 })).toBe(false);
    expect(automaticConnectionCommitCurrent({ ...current, currentPreferenceIntent: 8 })).toBe(false);
    expect(automaticConnectionCommitCurrent({ ...current, activeProfileId: undefined })).toBe(false);
    expect(automaticConnectionCommitCurrent({ ...current, connectionState: "disconnected" })).toBe(false);
  });

  it("releases the recovery surface after explicit pairing unless Desktop verified exact adoption", () => {
    const pairedProfile: ConnectionProfile = {
      id: "paired-recovery",
      deviceId: connection.deviceId,
      serverId: connection.serverId,
      name: connection.name,
      origin: connection.origin
    };
    const rotatedConnection = {
      ...connection,
      profileId: "desktop-connection_rotated"
    };
    expect(managedOrchestratorStatusAfterExplicitPairing(undefined, pairedProfile)).toBeUndefined();
    expect(managedOrchestratorStatusAfterExplicitPairing(
      { state: "recoveryRequired", reason: "credentialRejected" },
      pairedProfile
    )).toBeUndefined();
    expect(managedOrchestratorStatusAfterExplicitPairing(
      { state: "ready", connection },
      { ...pairedProfile, id: connection.profileId }
    )).toBeUndefined();
    expect(managedOrchestratorStatusAfterExplicitPairing(
      { state: "ready", connection: { ...rotatedConnection, deviceId: "different-device" } },
      pairedProfile
    )).toBeUndefined();
    expect(managedOrchestratorStatusAfterExplicitPairing(
      { state: "ready", connection: rotatedConnection },
      pairedProfile
    )).toEqual({ state: "ready", connection: rotatedConnection });
  });

  it("keeps managed credentials for Desktop logout verification", () => {
    const managed = managedConnectionProfile(connection, []);
    expect(shouldDeleteInvalidatedConnectionCredential(managed)).toBe(false);
    expect(shouldDeleteInvalidatedConnectionCredential({ ...managed, managedLocal: false })).toBe(true);
  });

  it("retires managed authority only after server logout succeeds", async () => {
    const steps: string[] = [];
    await logoutConnectionProfile({
      profile: managedConnectionProfile(connection, []),
      logoutConnection: async (id) => { steps.push(`server:${id}`); },
      completeManagedLogout: async () => { steps.push("desktop"); },
      deleteProfile: async () => { steps.push("local"); }
    });
    expect(steps).toEqual([`server:${connection.profileId}`, "desktop", "local"]);
  });

  it("does not remove managed authority when neither transport nor Desktop can verify logout", async () => {
    const completeManagedLogout = vi.fn(async () => { throw new Error("logout not verified"); });
    const deleteProfile = vi.fn(async () => undefined);
    await expect(logoutConnectionProfile({
      profile: managedConnectionProfile(connection, []),
      logoutConnection: async () => { throw new Error("server unavailable"); },
      completeManagedLogout,
      deleteProfile
    })).rejects.toThrow("logout not verified");
    expect(completeManagedLogout).toHaveBeenCalledOnce();
    expect(deleteProfile).not.toHaveBeenCalled();
  });

  it("accepts Desktop's stronger revocation proof when self-logout closes the response transport", async () => {
    const steps: string[] = [];
    await logoutConnectionProfile({
      profile: managedConnectionProfile(connection, []),
      logoutConnection: async () => {
        steps.push("server-transport");
        throw new Error("stream closed");
      },
      completeManagedLogout: async () => { steps.push("desktop-proof"); },
      deleteProfile: async () => { steps.push("local"); }
    });
    expect(steps).toEqual(["server-transport", "desktop-proof", "local"]);
  });

  it("does not remove the local profile when Desktop cannot verify managed logout", async () => {
    const deleteProfile = vi.fn(async () => undefined);
    await expect(logoutConnectionProfile({
      profile: managedConnectionProfile(connection, []),
      logoutConnection: async () => undefined,
      completeManagedLogout: async () => { throw new Error("logout not verified"); },
      deleteProfile
    })).rejects.toThrow("logout not verified");
    expect(deleteProfile).not.toHaveBeenCalled();
  });

  it("does not invoke Desktop completion for an ordinary remote profile", async () => {
    const steps: string[] = [];
    await logoutConnectionProfile({
      profile: { id: "remote", deviceId: "device-test", name: "Remote", origin: "https://orchestrator.example.test" , serverId: "server-test" },
      logoutConnection: async () => { steps.push("server"); },
      completeManagedLogout: async () => { steps.push("desktop"); },
      deleteProfile: async () => { steps.push("local"); }
    });
    expect(steps).toEqual(["server", "local"]);
  });

  it("does not delete an ordinary remote profile when server logout fails", async () => {
    const completeManagedLogout = vi.fn(async () => undefined);
    const deleteProfile = vi.fn(async () => undefined);
    await expect(logoutConnectionProfile({
      profile: { id: "remote", deviceId: "device-test", name: "Remote", origin: "https://orchestrator.example.test" , serverId: "server-test" },
      logoutConnection: async () => { throw new Error("server unavailable"); },
      completeManagedLogout,
      deleteProfile
    })).rejects.toThrow("server unavailable");
    expect(completeManagedLogout).not.toHaveBeenCalled();
    expect(deleteProfile).not.toHaveBeenCalled();
  });
});

describe("typed editor effects", () => {
  it("restores returned fork text while preserving the new Session draft envelope", () => {
    const draft = {
      text: "stale",
      attachments: [],
      mentions: [{ id: "mention-1", kind: "resource" as const, reference: "resource-1", label: "Resource", token: "@Resource" }],
      deliveryMode: "followUp" as const
    };
    expect(composerDraftWithEditorText("selected Pi user text", draft)).toEqual({
      ...draft,
      text: "selected Pi user text"
    });
    expect(composerDraftWithEditorText("selected Pi user text", undefined)).toEqual({
      text: "selected Pi user text",
      attachments: [],
      mentions: [],
      deliveryMode: "prompt"
    });
  });

});

describe("Desktop-managed runtime activity probe", () => {
  const connection: JokoDesktopManagedOrchestratorConnection = {
    profileId: "connection_local_1",
    deviceId: "device-local-1",
    serverId: "server-local-1",
    name: "Local Joko",
    origin: "http://127.0.0.1:4318"
  };
  const ready = { state: "ready", connection } as const;

  it("queries the Desktop-owned local runtime independently of the UI's active profile", async () => {
    const steps: string[] = [];
    const getManagedStatus = vi.fn(async () => {
      steps.push("status");
      return ready;
    });
    const probeOrigin = vi.fn(async () => {
      steps.push("identity");
      return { serverId: connection.serverId };
    });
    const readAuthKey = vi.fn(async (profile: ConnectionProfile) => {
      steps.push(`credential:${profile.id}`);
      return "owner-secret";
    });
    const probeRuntime = vi.fn(async (_origin: string, _authKey: string) => {
      steps.push("runtime");
      return true;
    });

    await expect(probeDesktopManagedRuntimeActivity({
      getManagedStatus,
      probeOrigin,
      readAuthKey,
      probeRuntime
    })).resolves.toBe(true);
    expect(probeRuntime).toHaveBeenCalledWith(connection.origin, "owner-secret");
    expect(steps).toEqual([
      "status",
      "identity",
      "status",
      `credential:${connection.profileId}`,
      "status",
      "runtime",
      "status"
    ]);
  });

  it("treats an explicitly disabled managed lifecycle as safe without contacting Orchestrator", async () => {
    const probeOrigin = vi.fn(async () => ({ serverId: connection.serverId }));
    const readAuthKey = vi.fn(async () => "owner-secret");
    const probeRuntime = vi.fn(async () => true);
    await expect(probeDesktopManagedRuntimeActivity({
      getManagedStatus: async () => ({ state: "disabled" }),
      probeOrigin,
      readAuthKey,
      probeRuntime
    })).resolves.toBe(false);
    expect(probeOrigin).not.toHaveBeenCalled();
    expect(readAuthKey).not.toHaveBeenCalled();
    expect(probeRuntime).not.toHaveBeenCalled();
  });

  it.each([
    { state: "starting" } as const,
    { state: "retryableError", reason: "serviceUnavailable" } as const,
    { state: "recoveryRequired", reason: "credentialUnavailable" } as const,
    undefined
  ])("fails closed before network or credential access for unresolved lifecycle state %#", async (status) => {
    const probeOrigin = vi.fn(async () => ({ serverId: connection.serverId }));
    const readAuthKey = vi.fn(async () => "owner-secret");
    const probeRuntime = vi.fn(async () => false);
    await expect(probeDesktopManagedRuntimeActivity({
      getManagedStatus: async () => status,
      probeOrigin,
      readAuthKey,
      probeRuntime
    })).rejects.toThrow("runtime state is unavailable");
    expect(probeOrigin).not.toHaveBeenCalled();
    expect(readAuthKey).not.toHaveBeenCalled();
    expect(probeRuntime).not.toHaveBeenCalled();
  });

  it("checks trusted identity before reading or sending the managed credential", async () => {
    const readAuthKey = vi.fn(async () => "owner-secret");
    const probeRuntime = vi.fn(async () => false);
    await expect(probeDesktopManagedRuntimeActivity({
      getManagedStatus: async () => ready,
      probeOrigin: async () => ({ serverId: "replacement-node" }),
      readAuthKey,
      probeRuntime
    })).rejects.toThrow("identity changed");
    expect(readAuthKey).not.toHaveBeenCalled();
    expect(probeRuntime).not.toHaveBeenCalled();
  });

  it("fails closed when the credential or authoritative RPC is unavailable", async () => {
    const base = {
      getManagedStatus: async () => ready,
      probeOrigin: async () => ({ serverId: connection.serverId })
    };
    const probeRuntime = vi.fn(async () => false);
    await expect(probeDesktopManagedRuntimeActivity({
      ...base,
      readAuthKey: async () => undefined,
      probeRuntime
    })).rejects.toThrow("credential is unavailable");
    expect(probeRuntime).not.toHaveBeenCalled();

    await expect(probeDesktopManagedRuntimeActivity({
      ...base,
      readAuthKey: async () => "owner-secret",
      probeRuntime: async () => Promise.reject(new Error("runtime RPC failed"))
    })).rejects.toThrow("runtime RPC failed");
  });

  it("does not send an old bearer when Desktop changes the owned profile during the probe", async () => {
    const replacement = {
      ...connection,
      profileId: "connection_local_2",
      deviceId: "device-local-2"
    };
    const statuses: JokoDesktopManagedOrchestratorStatus[] = [ready, ready, { state: "ready", connection: replacement }];
    const readAuthKey = vi.fn(async () => "old-owner-secret");
    const probeRuntime = vi.fn(async () => false);

    await expect(probeDesktopManagedRuntimeActivity({
      getManagedStatus: async () => statuses.shift(),
      probeOrigin: async () => ({ serverId: connection.serverId }),
      readAuthKey,
      probeRuntime
    })).rejects.toThrow("changed during the runtime probe");
    expect(readAuthKey).toHaveBeenCalledOnce();
    expect(probeRuntime).not.toHaveBeenCalled();
  });
});
