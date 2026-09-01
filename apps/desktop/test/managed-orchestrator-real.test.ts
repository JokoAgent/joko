import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  probeManagedOrchestratorConnection,
  selectManagedOrchestratorPorts,
  startManagedOrchestrator,
  type ManagedOrchestratorRuntime
} from "../src/managed-orchestrator.js";
import { mkdtempSync } from "./test-paths.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const orchestratorEntryPath = resolve(repositoryRoot, "apps/orchestrator/src/main.ts");
const tsxLoader = import.meta.resolve("tsx");
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("real managed Orchestrator child", () => {
  it("survives persistent Desktop release after the durable ACK and then stops explicitly", async () => {
    const fixture = createFixture();
    const runtime = await startRealManagedOrchestrator(fixture);
    const authKey = runtime.takeAuthKey();
    await runtime.commit();
    runtime.release();

    const probe = await probeManagedOrchestratorConnection({
      connection: runtime.connection,
      readAuthKey: async () => authKey
    });
    if (probe !== "authenticated") {
      const identity = await rawConnect(runtime.connection.origin, "joko.v1.ConnectionService/GetServerInfo");
      const authenticated = await rawConnect(
        runtime.connection.origin,
        "joko.v1.ConnectionService/ListConnections",
        authKey
      );
      throw new Error(`Managed probe failed (${probe}; identity=${identity}; authenticated=${authenticated}).`);
    }

    await runtime.stop();
    await expectEventuallyAbsent(runtime);
  }, 30_000);

  it("recovers persisted metadata when the commit ACK was lost and fences an ephemeral smoke child", async () => {
    const fixture = createFixture();
    const interrupted = await startRealManagedOrchestrator(fixture);
    const interruptedAuthKey = interrupted.takeAuthKey();
    await interrupted.stop();
    await expectEventuallyAbsent(interrupted);

    const recovered = await startRealManagedOrchestrator(fixture, {
      previousConnection: {
        connectionId: interrupted.connection.profileId,
        authKey: interruptedAuthKey
      },
      ephemeral: true
    });
    const recoveredAuthKey = recovered.takeAuthKey();
    await recovered.commit();
    recovered.release();

    // Ephemeral packaged-smoke ownership intentionally keeps the liveness
    // lease after commit. Releasing/crashing the Desktop must close the child.
    await expectEventuallyAbsent(recovered);
    await recovered.stop();
    expect(recoveredAuthKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  }, 45_000);
});

function createFixture() {
  const root = mkdtempSync(resolve(tmpdir(), "joko-managed-real-"));
  const workspaceRoot = resolve(root, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  const runtimes: ManagedOrchestratorRuntime[] = [];
  cleanups.push(async () => {
    for (const runtime of runtimes.reverse()) await runtime.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    workspaceRoot,
    dataDirectory: resolve(root, "data"),
    deviceId: randomUUID(),
    runtimes
  };
}

async function startRealManagedOrchestrator(
  fixture: ReturnType<typeof createFixture>,
  options: {
    readonly previousConnection?: { readonly connectionId: string; readonly authKey: string };
    readonly ephemeral?: boolean;
  } = {}
): Promise<ManagedOrchestratorRuntime> {
  const ports = await selectManagedOrchestratorPorts();
  const runtime = await startManagedOrchestrator({
    orchestratorEntryPath,
    dataDirectory: fixture.dataDirectory,
    workspaceRoot: fixture.workspaceRoot,
    deviceId: fixture.deviceId,
    deviceName: "Joko Desktop integration",
    appVersion: "0.1.0-test",
    publicPort: ports.publicPort,
    internalPort: ports.internalPort,
    environment: {
      ...process.env,
      JOKO_BROWSER_ENABLED: "0"
    },
    ...(options.previousConnection === undefined ? {} : { previousConnection: options.previousConnection }),
    ...(options.ephemeral === undefined ? {} : { ephemeral: options.ephemeral }),
    spawnChild(_executable: string, args: readonly string[], spawnOptions: SpawnOptions) {
      const child = spawn(process.execPath, ["--import", tsxLoader, ...args], spawnOptions);
      const requestPipe = child.stdio[3];
      const responsePipe = child.stdio[4];
      if (!isWritable(requestPipe) || !isReadable(responsePipe)) {
        child.kill("SIGKILL");
        throw new Error("Real managed Orchestrator pipes were unavailable.");
      }
      return { child, requestPipe, responsePipe };
    }
  });
  fixture.runtimes.push(runtime);
  return runtime;
}

async function expectEventuallyAbsent(runtime: ManagedOrchestratorRuntime): Promise<void> {
  const deadline = Date.now() + 5_000;
  do {
    const result = await probeManagedOrchestratorConnection({
      connection: runtime.connection,
      readAuthKey: async () => undefined
    });
    if (result === "absent") return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  } while (Date.now() < deadline);
  throw new Error("Managed Orchestrator remained reachable after confirmed shutdown.");
}

function isWritable(value: ChildProcess["stdio"][number]): value is Writable {
  return value !== null && value !== undefined && "write" in value && typeof value.write === "function";
}

function isReadable(value: ChildProcess["stdio"][number]): value is Readable {
  return value !== null && value !== undefined && "on" in value && typeof value.on === "function";
}

async function rawConnect(origin: string, method: string, authKey?: string): Promise<string> {
  const response = await fetch(`${origin}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "connect-protocol-version": "1",
      ...(authKey === undefined ? {} : { authorization: `Bearer ${authKey}` })
    },
    body: "{}"
  });
  return `${response.status}:${(await response.text()).slice(0, 200)}`;
}
