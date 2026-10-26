import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import { DeviceKind, DevicePeerCapabilityKind } from "@joko/contracts";
import type { NodeDevicePeerAgentRouteOptions } from "@joko/device-peer";
import type { EndpointTransport } from "@joko/connection-transport/trust";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readServiceDevicePeerAuthKey,
  readServiceDevicePeerTransport,
  createServiceDevicePeerRuntimeExecutables,
  ServiceDevicePeerAgent,
  validateServiceDevicePeerCredentialFile
} from "./service-device-peer-agent.js";

const AUTH_KEY = "A".repeat(43);
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("standalone Service Device peer agent", () => {
  it.each<EndpointTransport>([
    { kind: "webrtc" },
    { kind: "http-connect", proxyOrigin: "http://proxy.example:1337", authority: "node.example:443" },
    { kind: "iroh", endpointId: "a".repeat(64), ticket: "a".repeat(24), clientKey: "b".repeat(64) },
    { kind: "tailcat", endpointId: `nodekey:${"a".repeat(64)}`, address: "tcprivateLocator", port: 443, clientKey: `privkey:${"b".repeat(64)}` }
  ])("keeps selected $kind transport material within the original Service authority", async endpointTransport => {
    const readAuthKey = vi.fn(async () => AUTH_KEY), prepareTransport = vi.fn(async () => {});
    const readTransport = vi.fn(async () => endpointTransport);
    let attempt: NodeDevicePeerAgentRouteOptions | undefined;
    const agent = new ServiceDevicePeerAgent({ config: { ...fixtureConfig("private-auth-key"), endpointPublicKey: `ed25519:${"c".repeat(64)}`,
      transportKind: endpointTransport.kind, ...(endpointTransport.kind === "webrtc" ? {} : { transportPath: "private-transport.json" }) },
      readAuthKey, validateCredential: async () => {}, readTransport, prepareTransport,
      createExecutor: () => ({ capabilities: [DevicePeerCapabilityKind.FILES], execute: vi.fn(), retire: async () => {} }),
      runRoute: async options => { attempt = options; await aborted(options.signal); }
    });
    try {
      await agent.start(); await eventually(() => attempt !== undefined);
      expect(attempt!.connection).toMatchObject({ transportKind: endpointTransport.kind, endpointTransport });
      expect(readAuthKey).not.toHaveBeenCalled();
      expect(await attempt!.isAuthorityCurrent(attempt!.connection)).toBe(true);
      expect(await attempt!.isAuthorityCurrent({ ...attempt!.connection, transportKind: "https", endpointTransport: undefined })).toBe(false);
      if (endpointTransport.kind === "webrtc") { expect(readTransport).not.toHaveBeenCalled(); expect(prepareTransport).not.toHaveBeenCalled(); }
      else if (endpointTransport.kind === "http-connect") { expect(readTransport).toHaveBeenCalledOnce(); expect(prepareTransport).not.toHaveBeenCalled(); }
      else { expect(readTransport).toHaveBeenCalledOnce(); expect(prepareTransport).toHaveBeenCalledExactlyOnceWith(endpointTransport.kind); }
    } finally { await agent.close(); }
  });

  it.each(["tailcat", "http-connect"] as const)("refuses a private locator for another selected %s backend before starting the route or reading its bearer", async transportKind => {
    const readAuthKey = vi.fn(async () => AUTH_KEY), runRoute = vi.fn(async () => {}), prepareTransport = vi.fn(async () => {});
    const agent = new ServiceDevicePeerAgent({ config: { ...fixtureConfig("private-auth-key"), endpointPublicKey: `ed25519:${"c".repeat(64)}`, transportKind, transportPath: "private-transport.json" },
      validateCredential: async () => {}, readAuthKey, runRoute, prepareTransport,
      readTransport: async () => ({ kind: "webrtc" }) });
    try { await expect(agent.start()).rejects.toThrow(/transport is unavailable or unsafe/u); }
    finally { await agent.close(); }
    expect(runRoute).not.toHaveBeenCalled(); expect(readAuthKey).not.toHaveBeenCalled(); expect(prepareTransport).not.toHaveBeenCalled();
  });
  it("resolves Node and bundled runtime identities without PATH lookup", async () => {
    const located = await createServiceDevicePeerRuntimeExecutables({});
    expect(located.node?.executable).toBe(await realpath(process.execPath));
    expect(located.node?.executable === undefined || isAbsolute(located.node.executable)).toBe(true);
    expect(located.pi?.executable).toBe(located.node?.executable);
    expect(located.pi?.argumentPrefix).toHaveLength(1);
    expect(located.pi?.argumentPrefix?.every(isAbsolute)).toBe(true);
    if (process.versions.electron !== undefined) {
      expect(located.node?.environment).toMatchObject({ ELECTRON_RUN_AS_NODE: "1" });
    }
    expect(located.claude?.executable).toBe(located.node?.executable);
    expect(located.claude?.argumentPrefix).toHaveLength(1);
    expect(located.claude?.argumentPrefix?.[0]).toMatch(/device-peer-manager\.mjs$/u);
    expect(located.claude?.argumentPrefix?.every(isAbsolute)).toBe(true);
    expect(located.claude?.environment).toMatchObject({
      JOKO_CLAUDE_EXECUTABLE: expect.stringMatching(
        process.platform === "win32" ? /claude\.exe$/iu : /claude$/u
      ),
      JOKO_CLAUDE_LOCATOR_MODE: "device-peer"
    });
  });

  it("owns only its exact SERVICE authority and aborts and retires it during shutdown", async () => {
    const retire = vi.fn(async () => undefined);
    const ordering: string[] = [];
    const readAuthKey = vi.fn(async () => {
      ordering.push("credential");
      return AUTH_KEY;
    });
    let attempt: NodeDevicePeerAgentRouteOptions | undefined;
    let admittedCredential: string | undefined;
    let unrelatedCredential: string | undefined;
    let exactAuthority = false;
    let nativeName = "Service OS host";
    const agent = new ServiceDevicePeerAgent({
      config: fixtureConfig("C:\\protected\\service-auth-key"),
      validateCredential: async () => { ordering.push("metadata"); },
      readAuthKey,
      readDefaultDeviceName: () => nativeName,
      createExecutor: () => ({
        capabilities: [DevicePeerCapabilityKind.FILES],
        execute: vi.fn(async () => undefined),
        retire
      }),
      async runRoute(options) {
        ordering.push("route");
        expect(readAuthKey).not.toHaveBeenCalled();
        attempt = options;
        admittedCredential = await options.readAuthKey(options.connection.credentialId);
        unrelatedCredential = await options.readAuthKey("another-connection");
        exactAuthority = await options.isAuthorityCurrent(options.connection);
        await aborted(options.signal);
      }
    });

    await agent.start();
    await eventually(() => attempt !== undefined && admittedCredential !== undefined);
    expect(attempt?.connection).toEqual({
      credentialId: "service-connection",
      deviceId: "service-device",
      serverId: "controller-server",
      origin: "https://controller.example.test",
      expectedDeviceKind: DeviceKind.SERVICE
    });
    expect(admittedCredential).toBe(AUTH_KEY);
    expect(unrelatedCredential).toBeUndefined();
    expect(exactAuthority).toBe(true);
    expect(attempt?.readDefaultDeviceName()).toBe("Service OS host");
    nativeName = "Updated Service OS host";
    expect(attempt?.readDefaultDeviceName()).toBe("Updated Service OS host");
    expect(readAuthKey).toHaveBeenCalledOnce();
    expect(ordering).toEqual(["metadata", "route", "credential"]);

    const close = agent.close();
    expect(attempt?.signal.aborted).toBe(true);
    await close;
    expect(retire).toHaveBeenCalledOnce();
  });

  it("composes the audited native terminal host into the full Node executor", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "joko-service-peer-executor-")));
    roots.push(root);
    let capabilities: readonly DevicePeerCapabilityKind[] | undefined;
    const agent = new ServiceDevicePeerAgent({
      config: { ...fixtureConfig(join(root, "service-auth-key")), stateDirectory: root },
      validateCredential: async () => undefined,
      readAuthKey: async () => AUTH_KEY,
      async runRoute(options) {
        capabilities = [...options.executor.capabilities];
        await aborted(options.signal);
      }
    });

    await agent.start();
    await eventually(() => capabilities !== undefined);
    expect(capabilities).toEqual([
      DevicePeerCapabilityKind.FILES,
      DevicePeerCapabilityKind.PROCESS,
      DevicePeerCapabilityKind.TERMINAL,
      DevicePeerCapabilityKind.FORWARDING
    ]);
    await agent.close();
  });

  it("returns one controlled startup error without exposing a credential path or reader failure", async () => {
    const credentialPath = "C:\\private\\must-not-escape\\service-auth-key";
    const agent = new ServiceDevicePeerAgent({
      config: fixtureConfig(credentialPath),
      validateCredential: async () => { throw new Error(`cannot inspect ${credentialPath}`); },
      readAuthKey: vi.fn(async () => { throw new Error("must not read bearer bytes"); }),
      createExecutor: () => { throw new Error("must not start"); }
    });
    let failure: unknown;
    try {
      await agent.start();
    } catch (error) {
      failure = error;
    } finally {
      await agent.close();
    }
    expect(failure).toEqual(new Error("The Service Device peer credential file is unavailable or unsafe."));
    expect(String(failure)).not.toContain(credentialPath);
  });

  it.each([
    { kind: "tailcat", endpointId: `nodekey:${"a".repeat(64)}`, address: "tcprivateLocator", port: 443, clientKey: `privkey:${"b".repeat(64)}` },
    { kind: "http-connect", proxyOrigin: "http://proxy.example:1337", authority: "controller.example.test:443" }
  ])("reads only a stable owner-private credential and $kind locator, including the audited Windows ACL path", async locator => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "joko-service-peer-key-")));
    roots.push(root);
    if (process.platform === "win32") await makeWindowsDirectoryPrivate(root);
    const directory = join(root, "device-peer-agent");
    await mkdir(directory, { mode: 0o700 });
    const path = join(directory, "auth-key");
    await writePrivateFixture(path, `${AUTH_KEY}\n`);

    await expect(validateServiceDevicePeerCredentialFile(path)).resolves.toBeUndefined();
    expect(await readServiceDevicePeerAuthKey(path)).toBe(AUTH_KEY);
    const transport = join(directory, "transport.json");
    await writePrivateFixture(transport, JSON.stringify(locator));
    expect(await readServiceDevicePeerTransport(transport)).toEqual(locator);
    if (process.platform === "win32") await allowWindowsEveryoneRead(transport);
    else await chmod(transport, 0o644);
    await expect(readServiceDevicePeerTransport(transport)).rejects.toBeDefined();
    if (process.platform === "win32") await allowWindowsEveryoneRead(path);
    else await chmod(path, 0o644);
    await expect(validateServiceDevicePeerCredentialFile(path)).rejects.toBeDefined();
    expect(await readServiceDevicePeerAuthKey(path)).toBeUndefined();
  }, 30_000);
});

function fixtureConfig(credentialPath: string) {
  return {
    controllerOrigin: "https://controller.example.test",
    controllerServerId: "controller-server",
    connectionId: "service-connection",
    deviceId: "service-device",
    credentialPath,
    stateDirectory: "C:\\private\\service-state"
  } as const;
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveAbort) => signal.addEventListener("abort", () => resolveAbort(), { once: true }));
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 0));
  }
  throw new Error("Condition did not settle.");
}

async function makeWindowsDirectoryPrivate(path: string): Promise<void> {
  await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; " +
    "$acl = New-Object System.Security.AccessControl.DirectorySecurity; " +
    "$acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false); " +
    "$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(" +
    "$sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))); " +
    "[System.IO.Directory]::SetAccessControl($env:JOKO_ACL_FIXTURE, $acl)"
  ], { windowsHide: true, env: { ...process.env, JOKO_ACL_FIXTURE: path } });
}

async function writePrivateFixture(path: string, content: string): Promise<void> {
  if (process.platform !== "win32") {
    await writeFile(path, content, { mode: 0o600, flag: "wx" }); await chmod(path, 0o600); return;
  }
  // Match remote-ssh/create-private-file's atomic FileSecurity creation. An
  // inherited private DACL and chmod alone do not select the file owner when
  // the Windows host runs with an elevated token.
  await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference = 'Stop'; " +
    "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; " +
    "$acl = New-Object System.Security.AccessControl.FileSecurity; " +
    "$acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false); " +
    "$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow'))); " +
    "$file = [System.IO.FileStream]::new($env:JOKO_ACL_FIXTURE, [System.IO.FileMode]::CreateNew, " +
    "[System.Security.AccessControl.FileSystemRights]::FullControl, [System.IO.FileShare]::ReadWrite, 4096, [System.IO.FileOptions]::None, $acl); " +
    "$file.Dispose()"
  ], { windowsHide: true, env: { ...process.env, JOKO_ACL_FIXTURE: path } });
  await writeFile(path, content, { flag: "r+" });
}

async function allowWindowsEveryoneRead(path: string): Promise<void> {
  await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$acl = [System.IO.File]::GetAccessControl($env:JOKO_ACL_FIXTURE); " +
    "$sid = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0'); " +
    "$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(" +
    "$sid, 'Read', 'None', 'None', 'Allow'))); " +
    "[System.IO.File]::SetAccessControl($env:JOKO_ACL_FIXTURE, $acl)"
  ], { windowsHide: true, env: { ...process.env, JOKO_ACL_FIXTURE: path } });
}
