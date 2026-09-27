import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import { DeviceKind, DevicePeerCapabilityKind } from "@joko/contracts";
import type { NodeDevicePeerAgentRouteOptions } from "@joko/device-peer";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readServiceDevicePeerAuthKey,
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
    const agent = new ServiceDevicePeerAgent({
      config: fixtureConfig("C:\\protected\\service-auth-key"),
      validateCredential: async () => { ordering.push("metadata"); },
      readAuthKey,
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
    expect(readAuthKey).toHaveBeenCalledOnce();
    expect(ordering).toEqual(["metadata", "route", "credential"]);

    const close = agent.close();
    expect(attempt?.signal.aborted).toBe(true);
    await close;
    expect(retire).toHaveBeenCalledOnce();
  });

  it("composes the audited native terminal host into the full Node executor", async () => {
    let capabilities: readonly DevicePeerCapabilityKind[] | undefined;
    const agent = new ServiceDevicePeerAgent({
      config: fixtureConfig("C:\\protected\\service-auth-key"),
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

  it("reads only a stable owner-private credential, including the audited Windows ACL path", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "joko-service-peer-key-")));
    roots.push(root);
    if (process.platform === "win32") await makeWindowsDirectoryPrivate(root);
    const directory = join(root, "device-peer-agent");
    await mkdir(directory, { mode: 0o700 });
    const path = join(directory, "auth-key");
    await writeFile(path, `${AUTH_KEY}\n`, { mode: 0o600, flag: "wx" });
    await chmod(path, 0o600);

    await expect(validateServiceDevicePeerCredentialFile(path)).resolves.toBeUndefined();
    expect(await readServiceDevicePeerAuthKey(path)).toBe(AUTH_KEY);
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

async function allowWindowsEveryoneRead(path: string): Promise<void> {
  await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$acl = [System.IO.File]::GetAccessControl($env:JOKO_ACL_FIXTURE); " +
    "$sid = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0'); " +
    "$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(" +
    "$sid, 'Read', 'None', 'None', 'Allow'))); " +
    "[System.IO.File]::SetAccessControl($env:JOKO_ACL_FIXTURE, $acl)"
  ], { windowsHide: true, env: { ...process.env, JOKO_ACL_FIXTURE: path } });
}
