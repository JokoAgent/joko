import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createWdaOwnerFingerprint, type WdaProcessExecutorOptions } from "./index.js";
import { WdaDriverManager, type WdaDriverManagerOptions } from "./wda-driver-manager.js";
import { WDA_SOURCE_PIN } from "./wda-source-pin.js";

const UDID = "A0123456-1234-1234-1234-123456789ABC";
const RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-19-0";
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "joko-wda-manager-"));
  roots.push(value);
  return value;
}

async function server(handler: (method: string, path: string) => unknown): Promise<number> {
  const app = createServer((request, response) => {
    const body = handler(request.method ?? "", request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  servers.push(app);
  await new Promise<void>(resolve => app.listen(0, "127.0.0.1", resolve));
  const address = app.address();
  if (!address || typeof address === "string") throw new Error("No test port.");
  return address.port;
}

function source(cacheRoot: string): NonNullable<WdaDriverManagerOptions["prepareSource"]> {
  return async () => ({ checkoutPath: join(cacheRoot, "sources", WDA_SOURCE_PIN.revision),
    projectPath: join(cacheRoot, "sources", WDA_SOURCE_PIN.revision, "WebDriverAgent.xcodeproj"),
    revision: WDA_SOURCE_PIN.revision, fromCache: false });
}

function child(pid: number) {
  let ended = false;
  let stopCount = 0;
  let finish!: (value: { code: number | null; signal: "SIGTERM" | null; spawnFailed: boolean }) => void;
  const exited = new Promise<{ code: number | null; signal: "SIGTERM" | null; spawnFailed: boolean }>(resolve => { finish = resolve; });
  return { pid, exited, get isExited() { return ended; }, get stopCount() { return stopCount; },
    exit: () => { ended = true; finish({ code: 1, signal: null, spawnFailed: false }); },
    stop: async () => { stopCount += 1; ended = true; finish({ code: null, signal: "SIGTERM", spawnFailed: false }); } };
}

const start = { instanceId: "instance-1", simulatorUdid: UDID, runtimeIdentifier: RUNTIME,
  xcodeBuild: "19A123", architecture: "arm64" as const };

it("builds once for the exact source/runtime, waits for owned health, then creates and deletes a session", async () => {
  const cacheRoot = await root();
  const owner = createWdaOwnerFingerprint({ cacheRoot, instanceId: start.instanceId, simulatorUdid: UDID });
  const requests: string[] = [];
  const controlPort = await server((method, path) => {
    requests.push(`${method} ${path}`);
    if (path === "/status") return { value: { ready: true, build: { upgradedAt: owner }, os: { name: "iOS" } } };
    if (method === "POST") return { value: { sessionId: "SESSION-1", capabilities: {} } };
    return { value: null };
  });
  let portIndex = 0;
  const ports = [controlPort, controlPort + 1, controlPort, controlPort + 1];
  const children = [child(41), child(42)];
  const plans: WdaProcessExecutorOptions[] = [];
  let builds = 0;
  let launches = 0;
  const manager = new WdaDriverManager({ archivePath: join(cacheRoot, "source.tar.gz"), cacheRoot,
    platform: "darwin", prepareSource: source(cacheRoot), allocatePort: async () => ports[portIndex++]!,
    createExecutor: options => { plans.push(options); return {
      build: async () => { builds += 1; const products = join(options.derivedDataPath, "Build", "Products");
        await mkdir(products, { recursive: true }); await writeFile(join(products, "runner.xctestrun"), "test runner"); },
      launch: () => children[launches++]!
    }; } });
  const first = await manager.start(start);
  expect(first).toMatchObject({ instanceId: "instance-1", simulatorUdid: UDID,
    pid: 41, driverSessionId: "SESSION-1", state: "ready" });
  expect(plans[0]).toMatchObject({ cacheRoot, instanceId: "instance-1", simulatorUdid: UDID,
    controlPort, mjpegPort: controlPort + 1 });
  expect(builds).toBe(1);
  await expect(manager.start({ ...start, instanceId: "instance-2" })).rejects.toMatchObject({ code: "DEVICE_BUSY" });
  await manager.stop(first.instanceId, first.leaseId);
  expect(children[0]?.stopCount).toBe(1);
  const second = await manager.start(start);
  expect(second.pid).toBe(42);
  expect(builds).toBe(1);
  await expect(manager.stop(second.instanceId, first.leaseId)).rejects.toMatchObject({ code: "STALE_PROCESS" });
  expect(children[1]?.stopCount).toBe(0);
  await manager.stop(second.instanceId, second.leaseId);
  expect(requests.filter(item => item === "POST /session")).toHaveLength(2);
  expect(requests.filter(item => item === "DELETE /session/SESSION-1")).toHaveLength(2);
});

it("never launches after an incomplete build, and retries the same cache without adopting a false marker", async () => {
  const cacheRoot = await root();
  let builds = 0;
  let launches = 0;
  const manager = new WdaDriverManager({ archivePath: join(cacheRoot, "source.tar.gz"), cacheRoot,
    platform: "darwin", prepareSource: source(cacheRoot), allocatePort: async () => 18100,
    createExecutor: () => ({ build: async () => { builds += 1; }, launch: () => { launches += 1; return child(51); } }) });
  await expect(manager.start(start)).rejects.toMatchObject({ code: "PORT_UNAVAILABLE" });
  expect(builds).toBe(0);
  const portManager = new WdaDriverManager({ archivePath: join(cacheRoot, "source.tar.gz"), cacheRoot,
    platform: "darwin", prepareSource: source(cacheRoot), allocatePort: (() => {
      let n = 18100; return async () => n++;
    })(), createExecutor: () => ({ build: async () => { builds += 1; }, launch: () => { launches += 1; return child(51); } }) });
  await expect(portManager.start(start)).rejects.toMatchObject({ code: "BUILD_INCOMPLETE" });
  await expect(portManager.start(start)).rejects.toMatchObject({ code: "BUILD_INCOMPLETE" });
  expect(builds).toBe(2);
  expect(launches).toBe(0);
  const names = await readdir(join(cacheRoot, "builds"));
  expect(names).toHaveLength(1);
});

it("cleans an unready child and prevents a stale stop from touching a replacement", async () => {
  const cacheRoot = await root();
  const process = child(61);
  let now = 0;
  const manager = new WdaDriverManager({ archivePath: join(cacheRoot, "source.tar.gz"), cacheRoot,
    platform: "darwin", prepareSource: source(cacheRoot), startTimeoutMs: 1000,
    clock: { now: () => now, sleep: async ms => { now += ms; } },
    allocatePort: (() => { let n = 19100; return async () => n++; })(),
    createExecutor: options => ({ build: async () => { const products = join(options.derivedDataPath, "Build", "Products");
      await mkdir(products, { recursive: true }); await writeFile(join(products, "runner.xctestrun"), "runner"); },
    launch: () => process }),
    createClient: () => ({ probe: async () => ({ ready: false, message: null, osName: null,
      osVersion: null, sdkVersion: null, deviceIp: null }),
    createSession: async () => { throw new Error("must not create"); }, deleteSession: async () => undefined }) });
  await expect(manager.start(start)).rejects.toMatchObject({ code: "START_TIMEOUT" });
  expect(process.stopCount).toBe(1);
  expect(manager.get(start.instanceId)).toBeNull();
  await manager.stop(start.instanceId, "old-lease");
  expect(process.stopCount).toBe(1);
});

it("propagates readiness cancellation and retains an unretired build child until verified cleanup", async () => {
  const cacheRoot = await root();
  const controller = new AbortController();
  const launched = child(71);
  const cancelManager = new WdaDriverManager({ archivePath: join(cacheRoot, "source.tar.gz"), cacheRoot,
    platform: "darwin", prepareSource: source(cacheRoot),
    allocatePort: (() => { let n = 20100; return async () => n++; })(),
    createExecutor: options => ({ build: async () => { const products = join(options.derivedDataPath, "Build", "Products");
      await mkdir(products, { recursive: true }); await writeFile(join(products, "runner.xctestrun"), "runner"); },
    launch: () => launched }),
    createClient: () => ({ probe: async () => { controller.abort(); throw new Error("cancelled"); },
      createSession: async () => { throw new Error("must not create"); }, deleteSession: async () => undefined }) });
  await expect(cancelManager.start({ ...start, signal: controller.signal }))
    .rejects.toMatchObject({ code: "CANCELLED" });
  expect(launched.stopCount).toBe(1);
  expect(cancelManager.get(start.instanceId)).toBeNull();

  const otherRoot = await root();
  let buildAttempts = 0;
  let cleaned = false;
  const cleanupManager = new WdaDriverManager({ archivePath: join(otherRoot, "source.tar.gz"), cacheRoot: otherRoot,
    platform: "darwin", prepareSource: source(otherRoot),
    allocatePort: (() => { let n = 21100; return async () => n++; })(),
    createExecutor: () => ({ build: async () => { buildAttempts += 1;
      if (buildAttempts === 1) throw Object.assign(new Error("private output"), { code: "STOP_FAILED" }); },
    retryPendingBuildCleanup: async () => { cleaned = true; },
    launch: () => { throw new Error("must not launch"); } }) });
  await expect(cleanupManager.start(start)).rejects.toMatchObject({ code: "CLEANUP_REQUIRED" });
  await expect(cleanupManager.start(start)).rejects.toMatchObject({ code: "INSTANCE_BUSY" });
  await cleanupManager.retryOwnedCleanup(start.instanceId);
  expect(cleaned).toBe(true);
  await expect(cleanupManager.start(start)).rejects.toMatchObject({ code: "BUILD_INCOMPLETE" });
  expect(buildAttempts).toBe(2);
});

it("does not publish a session when its driver exits during creation", async () => {
  const cacheRoot = await root();
  const launched = child(91);
  let deleted = "";
  const manager = new WdaDriverManager({ archivePath: join(cacheRoot, "source.tar.gz"), cacheRoot,
    platform: "darwin", prepareSource: source(cacheRoot),
    allocatePort: (() => { let n = 22100; return async () => n++; })(),
    createExecutor: options => ({ build: async () => { const products = join(options.derivedDataPath, "Build", "Products");
      await mkdir(products, { recursive: true }); await writeFile(join(products, "runner.xctestrun"), "runner"); },
    launch: () => launched }),
    createClient: () => ({ probe: async () => ({ ready: true, message: null, osName: "iOS",
      osVersion: "19.0", sdkVersion: "19.0", deviceIp: null }),
    createSession: async () => { launched.exit(); return { id: "SESSION-1", capabilities: {},
      createdAt: new Date(0).toISOString() }; },
    deleteSession: async id => { deleted = id; } }) });
  await expect(manager.start(start)).rejects.toMatchObject({ code: "START_FAILED" });
  expect(deleted).toBe("SESSION-1");
  expect(launched.stopCount).toBe(1);
  expect(manager.get(start.instanceId)).toBeNull();
});
