import { ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import { mkdtempSync } from "./test-paths.js";

import {
  DesktopBootstrapFrameDecoder,
  DesktopBootstrapGrant,
  decodeDesktopBootstrapCommitPayload,
  decodeDesktopBootstrapRequestPayload,
  encodeDesktopBootstrapCommittedFrame,
  encodeDesktopBootstrapResponseFrame
} from "@joko/contracts/desktop-bootstrap";
import {
  MANAGED_OUTBOUND_PROXY_SNAPSHOT_ENV,
  createManagedOutboundProxyResolver,
  encodeManagedOutboundProxySnapshot
} from "@joko/contracts/managed-outbound-proxy";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canRespawnManagedOrchestratorAfterProbe,
  completeManagedOrchestratorLogout,
  completeVerifiedManagedOrchestratorLogout,
  commitVerifiedManagedOrchestratorAdoption,
  loadOrCreateManagedOrchestratorDeviceId,
  managedOrchestratorEnvironment,
  managedOrchestratorOutboundProxySnapshotEnvironment,
  parseManagedChromiumProxyResult,
  persistManagedOrchestratorDeviceId,
  probeManagedOrchestratorConnection,
  resolveManagedOrchestratorEntry,
  startManagedOrchestrator,
  startManagedOrchestratorWithAuthorizationFence,
  verifyManagedOrchestratorAdoption
} from "../src/managed-orchestrator.js";
import { validateProfileId } from "../src/security.js";

const DEVICE_ID = "d6a365ef-ef33-4fb7-a0f1-a02eb57fef75";
const cleanups: Array<() => void> = [];

afterEach(() => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("managed local Orchestrator", () => {
  it("persists one private installation Device identity", async () => {
    const directory = temporaryDirectory();
    const path = resolve(directory, "identity", "device-id");
    const first = await loadOrCreateManagedOrchestratorDeviceId(path);
    const second = await loadOrCreateManagedOrchestratorDeviceId(path);
    expect(first).toMatch(/^[0-9a-f-]{36}$/u);
    expect(second).toBe(first);

    const replacement = "96b9af15-3b3b-489d-b3aa-9fc488d79ba2";
    await persistManagedOrchestratorDeviceId(path, replacement);
    await expect(loadOrCreateManagedOrchestratorDeviceId(path)).resolves.toBe(replacement);
  });

  it("accepts a delayed chunked private response and yields a profile-safe connection", async () => {
    const directory = temporaryDirectory();
    const entryPath = resolve(fileURLToPath(import.meta.url));
    const resourcesDirectory = resolve(directory, "resources");
    let spawnArgs: readonly string[] | undefined;
    let spawnOptions: SpawnOptions | undefined;
    let requestCapability: string | undefined;
    const fake = fakeOrchestratorChild({
      expectedParentPid: 321,
      origin: "http://127.0.0.1:45180",
      responseDelayMs: 15,
      onRequest(capability) { requestCapability = capability; }
    });

    const runtime = await startManagedOrchestrator({
      orchestratorEntryPath: entryPath,
      nodeImportPath: entryPath,
      resourcesDirectory,
      dataDirectory: resolve(directory, "data"),
      workspaceRoot: directory,
      deviceId: DEVICE_ID,
      deviceName: "Joko Desktop",
      appVersion: "0.1.0",
      platform: "win32",
      parentPid: 321,
      publicPort: 45180,
      internalPort: 45179,
      environment: {
        PATH: process.env.PATH,
        OPENAI_API_KEY: "must-not-cross",
        NODE_OPTIONS: "--inspect",
        JOKO_LOG_LEVEL: "warn"
      },
      now: () => 1_000,
      spawnChild(executable, args, options) {
        spawnArgs = args;
        spawnOptions = options;
        return fake.spawned;
      }
    });

    expect(runtime.connection).toEqual({
      profileId: expect.stringMatching(/^desktop-connection_[A-Za-z0-9_-]+$/u),
      deviceId: DEVICE_ID,
      serverId: "orchestrator-managed",
      name: "Local Joko",
      origin: "http://127.0.0.1:45180"
    });
    expect(() => validateProfileId(runtime.connection.profileId)).not.toThrow();
    expect(runtime.takeAuthKey()).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(() => runtime.takeAuthKey()).toThrow(/already consumed/u);
    expect(spawnArgs).toEqual(["--import", pathToFileURL(entryPath).href, entryPath, "--desktop-hosted"]);
    expect(JSON.stringify(spawnArgs)).not.toContain(requestCapability);
    expect(spawnOptions?.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(spawnOptions?.env).not.toHaveProperty("NODE_OPTIONS");
    expect(spawnOptions?.env).toMatchObject({
      ELECTRON_RUN_AS_NODE: "1",
      JOKO_HOST: "127.0.0.1",
      JOKO_ALLOW_INSECURE_LOOPBACK: "1",
      JOKO_LAN_DISCOVERY: "0",
      JOKO_DESKTOP_RESOURCES_PATH: resourcesDirectory,
      JOKO_LOG_LEVEL: "warn"
    });

    await runtime.commit();
    await runtime.stop();
    expect(fake.child.exitCode).toBe(0);
  });

  it("does not report a stubborn child stopped until termination is observed", async () => {
    const directory = temporaryDirectory();
    const fake = fakeOrchestratorChild({
      expectedParentPid: 321,
      origin: "http://127.0.0.1:45182",
      exitOnRequestPipeClose: false
    });
    const runtime = await startManagedOrchestrator({
      orchestratorEntryPath: resolve(fileURLToPath(import.meta.url)),
      dataDirectory: resolve(directory, "data"),
      workspaceRoot: directory,
      deviceId: DEVICE_ID,
      deviceName: "Joko Desktop",
      appVersion: "0.1.0",
      parentPid: 321,
      publicPort: 45182,
      internalPort: 45181,
      now: () => 1_000,
      spawnChild: () => fake.spawned
    });
    await runtime.commit();
    vi.useFakeTimers();
    const stopping = runtime.stop();
    const stopped = expect(stopping).rejects.toThrow(/did not stop/u);
    await vi.advanceTimersByTimeAsync(15_001);
    await stopped;
    expect(fake.child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(fake.child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  });

  it("releases a successful daemon without killing it when the Desktop UI exits", async () => {
    const directory = temporaryDirectory();
    const fake = fakeOrchestratorChild({
      expectedParentPid: 321,
      origin: "http://127.0.0.1:45184",
      exitOnRequestPipeClose: false
    });
    const runtime = await startManagedOrchestrator({
      orchestratorEntryPath: resolve(fileURLToPath(import.meta.url)),
      dataDirectory: resolve(directory, "data"),
      workspaceRoot: directory,
      deviceId: DEVICE_ID,
      deviceName: "Joko Desktop",
      appVersion: "0.1.0",
      parentPid: 321,
      publicPort: 45184,
      internalPort: 45183,
      now: () => 1_000,
      spawnChild: () => fake.spawned
    });

    await runtime.commit();
    runtime.release();

    expect(fake.child.kill).not.toHaveBeenCalled();
    expect(fake.child.unref).toHaveBeenCalledOnce();
    expect(fake.child.exitCode).toBeNull();
  });

  it("verifies saved server identity before reading or sending its bearer", async () => {
    const events: string[] = [];
    const connection = {
      profileId: "desktop-connection_profile",
      deviceId: DEVICE_ID,
      serverId: "orchestrator-managed",
      name: "Local Joko",
      origin: "http://127.0.0.1:45180"
    } as const;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization === null) {
        events.push("identity");
        return new Response(JSON.stringify({ server: { serverId: "orchestrator-managed" } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      events.push(`auth:${authorization}`);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    const readAuthKey = vi.fn(async () => {
      events.push("read-key");
      return "opaque-key";
    });

    await expect(probeManagedOrchestratorConnection({
      connection,
      readAuthKey,
      fetch: fetchImpl as typeof fetch
    })).resolves.toBe("authenticated");
    expect(events).toEqual(["identity", "read-key", "auth:Bearer opaque-key"]);

    readAuthKey.mockClear();
    const wrongIdentity = vi.fn(async () => new Response(JSON.stringify({ server: { serverId: "different" } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    await expect(probeManagedOrchestratorConnection({
      connection,
      readAuthKey,
      fetch: wrongIdentity as typeof fetch
    })).resolves.toBe("identityConflict");
    expect(readAuthKey).not.toHaveBeenCalled();
  });

  it("classifies missing, rejected, unavailable, and absent saved endpoints without minting authority", async () => {
    const connection = {
      profileId: "desktop-connection_profile",
      deviceId: DEVICE_ID,
      serverId: "orchestrator-managed",
      name: "Local Joko",
      origin: "http://127.0.0.1:45180"
    } as const;
    const identity = (): Response => new Response(JSON.stringify({ server: { serverId: "orchestrator-managed" } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });

    await expect(probeManagedOrchestratorConnection({
      connection,
      readAuthKey: async () => undefined,
      fetch: vi.fn(async () => identity()) as typeof fetch
    })).resolves.toBe("credentialUnavailable");

    const rejected = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      new Headers(init?.headers).has("authorization")
        ? new Response("{}", { status: 401, headers: { "content-type": "application/json" } })
        : identity());
    await expect(probeManagedOrchestratorConnection({
      connection,
      readAuthKey: async () => "opaque-key",
      fetch: rejected as typeof fetch
    })).resolves.toBe("credentialRejected");

    await expect(probeManagedOrchestratorConnection({
      connection,
      readAuthKey: async () => "opaque-key",
      fetch: vi.fn(async () => { throw new Error("timed out"); }) as typeof fetch
    })).resolves.toBe("serviceUnavailable");

    await expect(probeManagedOrchestratorConnection({
      connection,
      readAuthKey: async () => "opaque-key",
      fetch: vi.fn(async () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); }) as typeof fetch
    })).resolves.toBe("absent");
  });

  it("adopts only an exact authenticated Connection behind the saved stable server identity", async () => {
    const connection = {
      profileId: "desktop-connection_recovered",
      deviceId: "96b9af15-3b3b-489d-b3aa-9fc488d79ba2",
      serverId: "orchestrator-managed",
      name: "Local Joko",
      origin: "http://127.0.0.1:45180"
    } as const;
    const identity = (): Response => new Response(JSON.stringify({ server: { serverId: "orchestrator-managed" } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
    const exactCatalog = (): Response => new Response(JSON.stringify({
      connections: [{
        connectionId: connection.profileId,
        deviceId: connection.deviceId,
        state: "CONNECTION_STATE_CONNECTED"
      }]
    }), { status: 200, headers: { "content-type": "application/json" } });

    const validFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      new Headers(init?.headers).has("authorization") ? exactCatalog() : identity());
    await expect(verifyManagedOrchestratorAdoption({
      expectedServerId: connection.serverId,
      connection,
      readAuthKey: async () => "owner-paired-key",
      fetch: validFetch as typeof fetch
    })).resolves.toBe("verified");
    expect(validFetch).toHaveBeenCalledTimes(2);

    const missingKeyFetch = vi.fn(async () => identity());
    await expect(verifyManagedOrchestratorAdoption({
      expectedServerId: connection.serverId,
      connection,
      readAuthKey: async () => undefined,
      fetch: missingKeyFetch as typeof fetch
    })).resolves.toBe("credentialUnavailable");
    expect(missingKeyFetch).toHaveBeenCalledOnce();

    const rejectedFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      new Headers(init?.headers).has("authorization")
        ? new Response("{}", { status: 401, headers: { "content-type": "application/json" } })
        : identity());
    await expect(verifyManagedOrchestratorAdoption({
      expectedServerId: connection.serverId,
      connection,
      readAuthKey: async () => "wrong-key",
      fetch: rejectedFetch as typeof fetch
    })).resolves.toBe("credentialRejected");

    const readCrossServerKey = vi.fn(async () => "must-not-be-read");
    const fetchCrossServer = vi.fn(async () => identity());
    await expect(verifyManagedOrchestratorAdoption({
      expectedServerId: "different-managed-orchestrator",
      connection,
      readAuthKey: readCrossServerKey,
      fetch: fetchCrossServer as typeof fetch
    })).resolves.toBe("identityConflict");
    expect(fetchCrossServer).not.toHaveBeenCalled();
    expect(readCrossServerKey).not.toHaveBeenCalled();
  });

  it("allowlists child environment values instead of inheriting tokens or Node injection", () => {
    const snapshot = encodeManagedOutboundProxySnapshot({
      "android-platform-tools-linux": "http://proxy.example:8080"
    });
    const codexHome = resolve("C:/Profiles/Codex");
    const claudeConfigDirectory = resolve("C:/Profiles/Claude");
    expect(managedOrchestratorEnvironment({
      PATH: "system-path",
      HOME: "home",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      HTTPS_PROXY: "http://person:secret@proxy.example:8080",
      https_proxy: "socks5://person:socks-secret@proxy.example:1080",
      NO_PROXY: "localhost,.example.test",
      GITHUB_TOKEN: "release-token",
      JOKO_ANDROID_ADB_PATH: "C:\\Android\\platform-tools\\adb.exe",
      ANDROID_ADB_SERVER_PORT: "6040",
      ANDROID_SDK_ROOT: "C:\\Android\\Sdk",
      JOKO_COMPUTER_DRIVER_EXECUTABLE: "C:\\Tools\\cua-driver.exe",
      DISPLAY: ":0",
      ALL_PROXY: "socks5://proxy.example:1080",
      NODE_OPTIONS: "--require attacker.js",
      NPM_TOKEN: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      JOKO_PI_EXECUTABLE: "pi",
      JOKO_CODEX_EXECUTABLE: "C:\\Tools\\codex.exe",
      JOKO_CLAUDE_CODE_EXECUTABLE: "C:\\Tools\\claude.exe",
      CODEX_HOME: codexHome,
      CODEX_PROFILE: "work-profile",
      CLAUDE_CONFIG_DIR: claudeConfigDirectory,
      CODEX_API_KEY: "secret",
      CLAUDE_CODE_OAUTH_TOKEN: "secret",
      [MANAGED_OUTBOUND_PROXY_SNAPSHOT_ENV]: snapshot,
      JOKO_UNAUDITED_SECRET: "secret"
    })).toEqual({
      PATH: "system-path",
      HOME: "home",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      JOKO_PI_EXECUTABLE: "pi",
      JOKO_CODEX_EXECUTABLE: "C:\\Tools\\codex.exe",
      JOKO_CLAUDE_CODE_EXECUTABLE: "C:\\Tools\\claude.exe",
      CODEX_HOME: codexHome,
      CODEX_PROFILE: "work-profile",
      CLAUDE_CONFIG_DIR: claudeConfigDirectory,
      HTTPS_PROXY: "http://person:secret@proxy.example:8080/",
      https_proxy: "socks5://person:socks-secret@proxy.example:1080",
      NO_PROXY: "localhost,.example.test",
      GITHUB_TOKEN: "release-token",
      JOKO_ANDROID_ADB_PATH: "C:\\Android\\platform-tools\\adb.exe",
      ANDROID_ADB_SERVER_PORT: "6040",
      ANDROID_SDK_ROOT: "C:\\Android\\Sdk",
      JOKO_COMPUTER_DRIVER_EXECUTABLE: "C:\\Tools\\cua-driver.exe",
      DISPLAY: ":0",
      ALL_PROXY: "socks5://proxy.example:1080",
      [MANAGED_OUTBOUND_PROXY_SNAPSHOT_ENV]: snapshot
    });
    expect(managedOrchestratorEnvironment({
      ANDROID_ADB_SERVER_PORT: "70000",
      CODEX_HOME: "relative/codex",
      CODEX_PROFILE: "invalid\nprofile",
      CLAUDE_CONFIG_DIR: ""
    })).toEqual({});
  });

  it("takes one fixed system proxy snapshot for managed outbound routes", async () => {
    const resolveProxy = vi.fn(async (url: string) => (
      url.includes("platform-tools-latest-linux") || url.includes("api.anthropic.com/api/oauth/profile")
    )
      ? "SOCKS5 ignored.example:1080; PROXY proxy.example:8080; DIRECT"
      : "DIRECT");
    const environment = await managedOrchestratorOutboundProxySnapshotEnvironment({}, resolveProxy);
    const resolve = createManagedOutboundProxyResolver(environment[MANAGED_OUTBOUND_PROXY_SNAPSHOT_ENV]);

    expect(resolveProxy).toHaveBeenCalledTimes(10);
    expect(resolve("https://api.anthropic.com/api/oauth/profile"))
      .toBe("http://proxy.example:8080/");
    expect(resolve("https://dl.google.com/android/repository/platform-tools-latest-linux.zip"))
      .toBe("http://proxy.example:8080/");
    expect(resolve("https://api.github.com/repos/trycua/cua/releases/tags/cua-driver-rs-v1.2.3"))
      .toBeNull();
  });

  it("prefers a system HTTP proxy and otherwise retains the first SOCKS5 fallback", () => {
    expect(parseManagedChromiumProxyResult(
      "SOCKS5 socks-first.example:1080; HTTPS unsupported.example:443; PROXY http.example:8080; DIRECT"
    )).toBe("http://http.example:8080/");
    expect(parseManagedChromiumProxyResult(
      "SOCKS5 socks-first.example:1080; SOCKS5 socks-second.example:1081; DIRECT"
    )).toBe("socks5://socks-first.example:1080");
    expect(parseManagedChromiumProxyResult("HTTP http-kind.example:8080; DIRECT"))
      .toBe("http://http-kind.example:8080/");
    expect(parseManagedChromiumProxyResult("DIRECT; SOCKS5 ignored.example:1080")).toBeNull();
    expect(parseManagedChromiumProxyResult("HTTPS unsupported.example:443; SOCKS fallback.example:1080"))
      .toBeNull();
  });

  it("lets explicit application proxy environment win and never snapshots proxy credentials", async () => {
    const resolveProxy = vi.fn(async () => "PROXY system.example:8080");
    await expect(managedOrchestratorOutboundProxySnapshotEnvironment({
      HTTPS_PROXY: "http://person:secret@proxy.example:8080"
    }, resolveProxy)).resolves.toEqual({});
    expect(resolveProxy).not.toHaveBeenCalled();
    expect(parseManagedChromiumProxyResult("PROXY person:secret@proxy.example:8080; DIRECT")).toBeNull();
    expect(parseManagedChromiumProxyResult("SOCKS5 person:secret@proxy.example:1080; DIRECT")).toBeNull();
    expect(parseManagedChromiumProxyResult("SOCKS5 proxy.example:0; DIRECT")).toBeNull();
    expect(parseManagedChromiumProxyResult("HTTPS proxy.example:443; DIRECT")).toBeNull();
  });

  it("does not spawn an offline managed service after its saved credential was removed", async () => {
    const start = vi.fn(async () => "started");
    await expect(startManagedOrchestratorWithAuthorizationFence({
      previous: {
        profileId: "desktop-connection_saved",
        deviceId: DEVICE_ID,
        serverId: "orchestrator-managed",
        name: "Local Joko",
        origin: "http://127.0.0.1:45180"
      },
      readAuthKey: async () => undefined,
      start
    })).rejects.toThrow(/authorization is unavailable/u);
    expect(start).not.toHaveBeenCalled();
  });

  it("retires exact managed restart metadata before cleaning the revoked credential", async () => {
    const expected = {
      profileId: "desktop-connection_saved",
      deviceId: DEVICE_ID,
      serverId: "orchestrator-managed",
      name: "Local Joko",
      origin: "http://127.0.0.1:45180"
    };
    const steps: string[] = [];
    await completeManagedOrchestratorLogout({
      expected,
      readSavedConnection: async () => {
        steps.push("read");
        return expected;
      },
      deleteSavedConnection: async () => { steps.push("metadata"); },
      deleteCredential: async (profileId) => { steps.push(`credential:${profileId}`); }
    });
    expect(steps).toEqual(["read", "metadata", `credential:${expected.profileId}`]);
  });

  it("fails closed when logout no longer matches durable managed authority", async () => {
    const expected = {
      profileId: "desktop-connection_saved",
      deviceId: DEVICE_ID,
      serverId: "orchestrator-managed",
      name: "Local Joko",
      origin: "http://127.0.0.1:45180"
    };
    const deleteSavedConnection = vi.fn(async () => undefined);
    const deleteCredential = vi.fn(async () => undefined);
    await expect(completeManagedOrchestratorLogout({
      expected,
      readSavedConnection: async () => ({ ...expected, profileId: "replacement-connection" }),
      deleteSavedConnection,
      deleteCredential
    })).rejects.toThrow(/no longer matches/u);
    expect(deleteSavedConnection).not.toHaveBeenCalled();
    expect(deleteCredential).not.toHaveBeenCalled();
  });

  it("keeps retired metadata final when stale credential cleanup fails", async () => {
    const expected = {
      profileId: "desktop-connection_saved",
      deviceId: DEVICE_ID,
      serverId: "orchestrator-managed",
      name: "Local Joko",
      origin: "http://127.0.0.1:45180"
    };
    const cleanupFailure = new Error("credential cleanup failed");
    const onCredentialCleanupFailure = vi.fn();
    await expect(completeManagedOrchestratorLogout({
      expected,
      readSavedConnection: async () => expected,
      deleteSavedConnection: async () => undefined,
      deleteCredential: async () => { throw cleanupFailure; },
      onCredentialCleanupFailure
    })).resolves.toBeUndefined();
    expect(onCredentialCleanupFailure).toHaveBeenCalledWith(cleanupFailure);
  });

  it("persists only the privately rotated authority during managed recovery adoption", async () => {
    const candidate = {
      profileId: "paired-recovery",
      deviceId: DEVICE_ID,
      serverId: "orchestrator-managed",
      name: "Local Joko",
      origin: "http://127.0.0.1:45180"
    };
    const managed = { ...candidate, profileId: "desktop-connection_rotated", origin: "http://127.0.0.1:45182" };
    const steps: string[] = [];
    const runtime = {
      connection: managed,
      takeAuthKey: () => { steps.push("take-key"); return "a".repeat(43); },
      commit: async () => { steps.push("commit"); },
      release: () => undefined,
      stop: async () => { steps.push("stop-new"); }
    };
    await expect(commitVerifiedManagedOrchestratorAdoption({
      candidate,
      previousDeviceId: "0c47df78-8f4c-4702-a600-2b5415cadb82",
      stopCurrentRuntime: async () => { steps.push("stop-old"); },
      startWithCandidateProof: async (value) => {
        expect(value).toEqual(candidate);
        steps.push("private-bootstrap");
        return runtime;
      },
      persistDeviceId: async (id) => { steps.push(`device:${id}`); },
      restorePreviousDeviceId: async (id) => { steps.push(`restore:${id}`); },
      restorePreviousConnection: async () => { steps.push("restore-metadata"); },
      storeCredential: async (id, key) => { steps.push(`credential:${id}:${key.length}`); },
      persistConnection: async (value) => { steps.push(`metadata:${value.profileId}`); },
      deleteCredential: async (id) => { steps.push(`delete:${id}`); }
    })).resolves.toBe(runtime);
    expect(steps).toEqual([
      "stop-old",
      "private-bootstrap",
      "take-key",
      `device:${DEVICE_ID}`,
      "credential:desktop-connection_rotated:43",
      "metadata:desktop-connection_rotated",
      "commit",
      "delete:paired-recovery"
    ]);
  });

  it("rolls back pre-metadata adoption state and rejects an unrotated authority", async () => {
    const candidate = {
      profileId: "paired-recovery",
      deviceId: DEVICE_ID,
      serverId: "orchestrator-managed",
      name: "Local Joko",
      origin: "http://127.0.0.1:45180"
    };
    const steps: string[] = [];
    const runtime = {
      connection: { ...candidate, profileId: "desktop-connection_rotated" },
      takeAuthKey: () => "b".repeat(43),
      commit: async () => undefined,
      release: () => undefined,
      stop: async () => { steps.push("stop-new"); }
    };
    await expect(commitVerifiedManagedOrchestratorAdoption({
      candidate,
      previousDeviceId: "0c47df78-8f4c-4702-a600-2b5415cadb82",
      stopCurrentRuntime: async () => { steps.push("stop-old"); },
      startWithCandidateProof: async () => runtime,
      persistDeviceId: async () => { steps.push("device"); },
      restorePreviousDeviceId: async () => { steps.push("restore"); },
      restorePreviousConnection: async () => { steps.push("restore-metadata"); },
      storeCredential: async () => { steps.push("credential"); },
      persistConnection: async () => { throw new Error("metadata failed"); },
      deleteCredential: async (id) => { steps.push(`delete:${id}`); }
    })).rejects.toThrow("metadata failed");
    expect(steps).toEqual([
      "stop-old",
      "device",
      "credential",
      "delete:desktop-connection_rotated",
      "restore-metadata",
      "restore",
      "stop-new"
    ]);

    const wrongRuntime = { ...runtime, connection: candidate };
    await expect(commitVerifiedManagedOrchestratorAdoption({
      candidate,
      previousDeviceId: candidate.deviceId,
      stopCurrentRuntime: async () => undefined,
      startWithCandidateProof: async () => wrongRuntime,
      persistDeviceId: async () => { throw new Error("must not persist"); },
      restorePreviousDeviceId: async () => undefined,
      restorePreviousConnection: async () => undefined,
      storeCredential: async () => undefined,
      persistConnection: async () => undefined,
      deleteCredential: async () => undefined
    })).rejects.toThrow(/wrong authority/u);
    expect(steps.at(-1)).toBe("stop-new");
  });

  it("does not persist a rotated authority when adoption fails before its metadata checkpoint", async () => {
    const candidate = {
      profileId: "paired-recovery",
      deviceId: DEVICE_ID,
      serverId: "orchestrator-managed",
      name: "Local Joko",
      origin: "http://127.0.0.1:45180"
    };
    const runtime = {
      connection: { ...candidate, profileId: "desktop-connection_rotated" },
      takeAuthKey: () => "c".repeat(43),
      commit: vi.fn(async () => undefined),
      release: () => undefined,
      stop: vi.fn(async () => undefined)
    };
    const persistConnection = vi.fn(async () => undefined);
    const deleteCredential = vi.fn(async () => undefined);
    const restorePreviousDeviceId = vi.fn(async () => undefined);
    const restorePreviousConnection = vi.fn(async () => undefined);
    await expect(commitVerifiedManagedOrchestratorAdoption({
      candidate,
      previousDeviceId: "0c47df78-8f4c-4702-a600-2b5415cadb82",
      stopCurrentRuntime: async () => undefined,
      startWithCandidateProof: async () => runtime,
      persistDeviceId: async () => undefined,
      restorePreviousDeviceId,
      restorePreviousConnection,
      storeCredential: async () => { throw new Error("credential store failed"); },
      persistConnection,
      deleteCredential
    })).rejects.toThrow("credential store failed");
    expect(persistConnection).not.toHaveBeenCalled();
    expect(runtime.commit).not.toHaveBeenCalled();
    expect(deleteCredential).toHaveBeenCalledOnce();
    expect(deleteCredential).toHaveBeenCalledWith(runtime.connection.profileId);
    expect(restorePreviousConnection).toHaveBeenCalledOnce();
    expect(restorePreviousDeviceId).toHaveBeenCalledOnce();
    expect(runtime.stop).toHaveBeenCalledOnce();
  });

  it("keeps the durable provisional checkpoint when the private commit acknowledgement fails", async () => {
    const candidate = {
      profileId: "paired-recovery",
      deviceId: DEVICE_ID,
      serverId: "orchestrator-managed",
      name: "Local Joko",
      origin: "http://127.0.0.1:45180"
    };
    const managed = { ...candidate, profileId: "desktop-connection_rotated" };
    const runtime = {
      connection: managed,
      takeAuthKey: () => "d".repeat(43),
      commit: vi.fn(async () => { throw new Error("commit acknowledgement failed"); }),
      release: () => undefined,
      stop: vi.fn(async () => undefined)
    };
    let checkpoint: typeof managed | undefined;
    const deleteCredential = vi.fn(async () => undefined);
    const restorePreviousDeviceId = vi.fn(async () => undefined);
    const restorePreviousConnection = vi.fn(async () => undefined);
    await expect(commitVerifiedManagedOrchestratorAdoption({
      candidate,
      previousDeviceId: candidate.deviceId,
      stopCurrentRuntime: async () => undefined,
      startWithCandidateProof: async () => runtime,
      persistDeviceId: async () => undefined,
      restorePreviousDeviceId,
      restorePreviousConnection,
      storeCredential: async () => undefined,
      persistConnection: async (connection) => { checkpoint = connection; },
      deleteCredential
    })).rejects.toThrow("commit acknowledgement failed");
    expect(checkpoint).toEqual(managed);
    expect(deleteCredential).not.toHaveBeenCalled();
    expect(restorePreviousConnection).not.toHaveBeenCalled();
    expect(restorePreviousDeviceId).not.toHaveBeenCalled();
    expect(runtime.stop).toHaveBeenCalledOnce();
  });

  it.each([
    "authenticated",
    "absent",
    "serviceUnavailable",
    "identityConflict",
    "credentialUnavailable"
  ] as const)("does not retire authority when explicit logout probe is %s", async (probe) => {
    const readSavedConnection = vi.fn(async () => undefined);
    const deleteSavedConnection = vi.fn(async () => undefined);
    const deleteCredential = vi.fn(async () => undefined);
    await expect(completeVerifiedManagedOrchestratorLogout({
      verifyRevocation: async () => probe,
      completion: {
        expected: {
          profileId: "desktop-connection_saved",
          deviceId: DEVICE_ID,
          serverId: "orchestrator-managed",
          name: "Local Joko",
          origin: "http://127.0.0.1:45180"
        },
        readSavedConnection,
        deleteSavedConnection,
        deleteCredential
      }
    })).rejects.toThrow(/not durably verified/u);
    expect(readSavedConnection).not.toHaveBeenCalled();
    expect(deleteSavedConnection).not.toHaveBeenCalled();
    expect(deleteCredential).not.toHaveBeenCalled();
  });

  it("retires authority only after the old bearer is rejected", async () => {
    const expected = {
      profileId: "desktop-connection_saved",
      deviceId: DEVICE_ID,
      serverId: "orchestrator-managed",
      name: "Local Joko",
      origin: "http://127.0.0.1:45180"
    };
    const steps: string[] = [];
    await completeVerifiedManagedOrchestratorLogout({
      verifyRevocation: async () => {
        steps.push("probe");
        return "credentialRejected";
      },
      completion: {
        expected,
        readSavedConnection: async () => {
          steps.push("read");
          return expected;
        },
        deleteSavedConnection: async () => { steps.push("metadata"); },
        deleteCredential: async () => { steps.push("credential"); }
      }
    });
    expect(steps).toEqual(["probe", "read", "metadata", "credential"]);
  });

  it("respawns a service-unavailable saved identity only after a confirmed controlled stop", async () => {
    expect(canRespawnManagedOrchestratorAfterProbe("serviceUnavailable", false)).toBe(false);
    expect(canRespawnManagedOrchestratorAfterProbe("serviceUnavailable", true)).toBe(true);
    expect(canRespawnManagedOrchestratorAfterProbe("absent", false)).toBe(true);
    const start = vi.fn(async () => "restarted");
    await expect(startManagedOrchestratorWithAuthorizationFence({
      previous: {
        profileId: "desktop-connection_saved",
        deviceId: DEVICE_ID,
        serverId: "orchestrator-managed",
        name: "Local Joko",
        origin: "http://127.0.0.1:45180"
      },
      readAuthKey: async () => "a".repeat(43),
      start
    })).resolves.toBe("restarted");
    expect(start).toHaveBeenCalledWith({
      connectionId: "desktop-connection_saved",
      authKey: "a".repeat(43)
    });
  });

  it("resolves production only from Electron resources and development from the current workspace build", () => {
    const directory = temporaryDirectory();
    const sourceDirectory = resolve(directory, "desktop", "dist");
    const resourcesPath = resolve(directory, "installed", "resources");
    mkdirSync(resolve(sourceDirectory, "orchestrator-runtime", "dist"), { recursive: true });
    writeFileSync(resolve(sourceDirectory, "orchestrator-runtime", "dist", "main.js"), "export {};\n");

    expect(resolveManagedOrchestratorEntry(sourceDirectory)).toBe(
      resolve(sourceDirectory, "orchestrator-runtime", "dist", "main.js")
    );
    expect(resolveManagedOrchestratorEntry(sourceDirectory, {
      developmentWorkspace: true
    })).toBe(resolve(sourceDirectory, "..", "..", "orchestrator", "dist", "main.js"));
    expect(resolveManagedOrchestratorEntry(sourceDirectory, {
      packaged: true,
      resourcesPath,
      developmentWorkspace: true
    })).toBe(resolve(resourcesPath, "orchestrator-runtime", "dist", "main.js"));
    expect(() => resolveManagedOrchestratorEntry(sourceDirectory, { packaged: true }))
      .toThrow(/could not start securely/u);
  });
});

function fakeOrchestratorChild(options: {
  readonly expectedParentPid: number;
  readonly origin: string;
  readonly responseDelayMs?: number;
  readonly exitOnRequestPipeClose?: boolean;
  readonly onRequest?: (capability: string) => void;
}) {
  const child = new ChildProcess();
  const requestPipe = new PassThrough();
  const responsePipe = new PassThrough();
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  Object.defineProperties(child, {
    pid: { value: 777, configurable: true },
    exitCode: { get: () => exitCode, configurable: true },
    signalCode: { get: () => signalCode, configurable: true }
  });
  const exit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (exitCode !== null || signalCode !== null) return;
    exitCode = code;
    signalCode = signal;
    child.emit("exit", code, signal);
  };
  child.kill = vi.fn(() => true);
  child.unref = vi.fn();
  if (options.exitOnRequestPipeClose !== false) requestPipe.once("close", () => exit(0, null));

  let decoder = new DesktopBootstrapFrameDecoder();
  let grant: DesktopBootstrapGrant | undefined;
  requestPipe.on("data", (chunk: Buffer) => {
    const [payload] = decoder.push(chunk);
    if (payload === undefined) return;
    decoder.finish();
    decoder = new DesktopBootstrapFrameDecoder();
    try {
      if (grant === undefined) {
        const request = decodeDesktopBootstrapRequestPayload(payload);
        options.onRequest?.(request.capability);
        grant = DesktopBootstrapGrant.accept(request, {
          expectedParentPid: options.expectedParentPid,
          now: () => request.issuedAt + 1
        });
        const response = grant.exchange({
          serverId: "orchestrator-managed",
          origin: options.origin,
          issueConnection: (input) => ({
            connection: {
              id: `desktop-connection_${input.desktopInstanceId}`,
              deviceId: input.desktopDeviceId
            },
            authKey: Buffer.alloc(32, 9).toString("base64url")
          })
        });
        const frame = encodeDesktopBootstrapResponseFrame(response);
        const delay = options.responseDelayMs ?? 0;
        setTimeout(() => {
          responsePipe.write(frame.subarray(0, 7));
          setTimeout(() => responsePipe.write(frame.subarray(7)), delay);
        }, delay);
        return;
      }
      const commit = decodeDesktopBootstrapCommitPayload(payload);
      const committed = grant.confirmCommit(commit);
      responsePipe.end(encodeDesktopBootstrapCommittedFrame(committed));
    } finally {
      payload.fill(0);
    }
  });
  return {
    child,
    spawned: { child, requestPipe, responsePipe }
  };
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "joko-managed-orchestrator-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
