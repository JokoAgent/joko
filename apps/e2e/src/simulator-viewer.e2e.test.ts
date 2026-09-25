import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Code } from "@connectrpc/connect";
import { CapabilitySupport, SimulatorViewerAction } from "@joko/contracts";
import { createOrchestratorApplication, createPublicServer,
  type OrchestratorConfig } from "@joko/orchestrator";
import { chromium, type Browser } from "playwright-core";
import { expect, it, vi } from "vitest";
import { createE2eClients } from "./connect-clients.js";

it("serves authenticated task-owned Simulator inventory and durable exact deletion over public Connect", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-simulator-viewer-e2e-"));
  const workspace = join(root, "workspace");
  const dataDirectory = join(root, "data");
  await mkdir(workspace);
  const config: OrchestratorConfig = {
    host: "127.0.0.1", port: 0, internalPort: 4317,
    publicOrigin: "http://127.0.0.1", internalOrigin: "http://127.0.0.1:4317",
    dataDirectory, databasePath: join(dataDirectory, "orchestrator.db"),
    allowInsecureLoopback: true, allowInsecureLan: false, lanDiscoveryEnabled: false,
    codexExecutable: join(root, "missing-codex"), piAgentHome: join(dataDirectory, "pi"),
    workspace: { id: "workspace", root: workspace, displayName: "Viewer fixture", trusted: true },
    artifactDirectory: join(dataDirectory, "artifacts"), webDirectory: join(root, "no-web"),
    corsOrigins: [], iosSimulatorDriver: {
      archivePath: join(root, "missing-driver.tar.gz"), cacheRoot: join(dataDirectory, "driver-cache")
    }
  };
  const udid = "A0123456-1234-1234-1234-123456789ABC";
  const device = { udid, name: "Joko iPhone", state: "Booted", isAvailable: true,
    runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-19-0", runtimeName: "iOS 19.0",
    runtimeVersion: "19.0", deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
    lastBootedAt: null } as const;
  let existing = true;
  let shutdown = false;
  let deletes = 0;
  const application = await createOrchestratorApplication(config, { simulatorRuntime: {
    environment: { inspect: async () => ({ platform: "darwin", supported: true, ready: true,
      xcodeVersion: "Xcode 16.4", runtimes: [], devices: existing ? [device] : [],
      issue: null, error: null, setupSteps: [] }) },
    lifecycle: {
      findExact: async value => existing && value === udid ? { ...device, state: shutdown ? "Shutdown" : "Booted" } : null,
      bootExact: async () => { throw new Error("Unexpected boot."); },
      shutdownExact: async value => { expect(value).toBe(udid); shutdown = true; }
    },
    delete: { deleteExact: async input => {
      expect(input).toEqual({ udid, name: device.name, runtimeIdentifier: device.runtimeIdentifier,
        deviceTypeIdentifier: device.deviceTypeIdentifier });
      expect(shutdown).toBe(true);
      expect(application.store.listOperations({ sessionId: "viewer-task", status: "started" })
        .some(operation => operation.kind === "ios_simulator_instance_control")).toBe(true);
      deletes += 1;
      existing = false;
    } },
    driver: { architecture: "arm64", manager: {
      get: () => null, start: async () => { throw new Error("Unexpected driver start."); },
      stop: async () => { throw new Error("Unexpected driver stop."); },
      retryOwnedCleanup: async () => {}
    }, cleanupOrphans: async () => {} }
  } });
  let server: Awaited<ReturnType<typeof createPublicServer>> | undefined;
  try {
    const target = application.store.getTarget("workspace").descriptor;
    application.store.createSession({ id: "viewer-task", backendId: target.backendId,
      targetId: target.id, title: "Viewer task", binding: { opaqueRef: "viewer-native", generation: 1 },
      pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false,
      createdAt: Date.now(), updatedAt: Date.now() });
    application.store.createSession({ id: "other-task", backendId: target.backendId,
      targetId: target.id, title: "Other task", binding: { opaqueRef: "other-native", generation: 1 },
      pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false,
      createdAt: Date.now(), updatedAt: Date.now() });
    const owned = application.simulatorViewer!.ownership.bindCreatedDevice(
      { sessionId: "viewer-task", targetId: target.id, generation: 1 }, device, device.name);
    const challenge = application.connections.issuePairing("Viewer test");
    const paired = application.connections.completePairing({ challengeId: challenge.id,
      code: challenge.code, connectionName: "Viewer client" });
    server = await createPublicServer(application);
    server.log.level = "silent";
    const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
    const clients = createE2eClients(baseUrl, paired.authKey);
    const anonymous = createE2eClients(baseUrl);
    await expect(anonymous.simulatorViewer.getSimulatorViewerState({ sessionId: "viewer-task" }))
      .rejects.toMatchObject({ code: Code.Unauthenticated });
    expect(await clients.simulatorViewer.getSimulatorViewerState({ sessionId: "other-task" }))
      .toMatchObject({ instances: [] });
    application.simulatorViewer!.ownership.bindCreatedDevice(
      { sessionId: "other-task", targetId: target.id, generation: 1 },
      { ...device, udid: "B0123456-1234-1234-1234-123456789ABC", name: "Old binding" }, "Old binding");
    application.store.updateSession("other-task", {
      binding: { opaqueRef: "other-native", generation: 2 }
    });
    await expect(clients.simulatorViewer.getSimulatorViewerState({ sessionId: "other-task" }))
      .rejects.toMatchObject({ code: Code.Aborted });
    const state = await clients.simulatorViewer.getSimulatorViewerState({ sessionId: "viewer-task" });
    expect(state).toMatchObject({ support: CapabilitySupport.SUPPORTED,
      devices: [{ udid }], instances: [{ simulatorUdid: udid, creationProvenance: "joko" }] });
    const watchRequest = { sessionId: "viewer-task", route: { instanceId: owned.instanceId,
      generation: BigInt(owned.generation), leaseId: owned.lease.id },
      mjpegFramesPerSecond: 10, jpegQuality: 45, mjpegScalingPercent: 70 };
    await expect(anonymous.simulatorViewer.watchSimulatorFrames(watchRequest)[Symbol.asyncIterator]().next())
      .rejects.toMatchObject({ code: Code.Unauthenticated });
    await expect(clients.simulatorViewer.watchSimulatorFrames({ ...watchRequest,
      route: { ...watchRequest.route, leaseId: "wrong-lease" } })[Symbol.asyncIterator]().next())
      .rejects.toMatchObject({ code: Code.Aborted });
    await expect(clients.simulatorViewer.watchSimulatorFrames(watchRequest)[Symbol.asyncIterator]().next())
      .rejects.toMatchObject({ code: Code.FailedPrecondition });
    const request = { sessionId: "viewer-task", requestId: randomUUID(),
      action: SimulatorViewerAction.DELETE,
      route: { instanceId: owned.instanceId, generation: BigInt(owned.generation), leaseId: owned.lease.id } };
    await expect(clients.simulatorViewer.controlSimulatorInstance({ ...request, requestId: randomUUID(),
      route: { ...request.route, leaseId: "wrong-lease" } })).rejects.toBeDefined();
    expect(deletes).toBe(0);
    const result = await clients.simulatorViewer.controlSimulatorInstance(request);
    expect(result).toMatchObject({ deleted: true, replayed: false });
    expect((await clients.simulatorViewer.controlSimulatorInstance(request)).replayed).toBe(true);
    expect(deletes).toBe(1);
    expect((await clients.simulatorViewer.getSimulatorViewerState({ sessionId: "viewer-task" })).instances).toEqual([]);
    expect(application.store.listOperations({ sessionId: "viewer-task", status: "completed" })
      .some(operation => operation.kind === "ios_simulator_instance_control")).toBe(true);
  } finally {
    await server?.close();
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

const mountedIt = process.env.JOKO_BROWSER_EXECUTABLE?.trim() &&
  process.env.JOKO_MOUNTED_WEB_DIR?.trim() ? it : it.skip;

mountedIt("shows the production Simulator task grid and confirms deletion in the mounted Web inspector",
  { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-simulator-viewer-web-"));
  const workspace = join(root, "workspace");
  const dataDirectory = join(root, "data");
  await mkdir(workspace);
  const config: OrchestratorConfig = {
    host: "127.0.0.1", port: 0, internalPort: 4317,
    publicOrigin: "http://127.0.0.1", internalOrigin: "http://127.0.0.1:4317",
    dataDirectory, databasePath: join(dataDirectory, "orchestrator.db"),
    allowInsecureLoopback: true, allowInsecureLan: false, lanDiscoveryEnabled: false,
    codexExecutable: join(root, "missing-codex"), piAgentHome: join(dataDirectory, "pi"),
    workspace: { id: "workspace", root: workspace, displayName: "Viewer Web fixture", trusted: true },
    artifactDirectory: join(dataDirectory, "artifacts"), webDirectory: process.env.JOKO_MOUNTED_WEB_DIR!,
    corsOrigins: [], iosSimulatorDriver: {
      archivePath: join(root, "missing-driver.tar.gz"), cacheRoot: join(dataDirectory, "driver-cache")
    }
  };
  const udid = "A0123456-1234-1234-1234-123456789ABC";
  const device = { udid, name: "Joko iPhone", state: "Shutdown", isAvailable: true,
    runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-19-0", runtimeName: "iOS 19.0",
    runtimeVersion: "19.0", deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
    lastBootedAt: null } as const;
  let existing = true;
  let booted = false;
  let deletes = 0;
  let jpeg: Buffer | undefined;
  let png: Buffer | undefined;
  let h264: Uint8Array | undefined;
  let stopNative = false;
  let wdaPort = 0;
  let ownerFingerprint = "";
  const viewerInputs: Array<{ readonly url: string; readonly body: unknown;
    readonly claimed: boolean }> = [];
  const deviceCommands: Array<{ readonly url: string; readonly body: unknown;
    readonly claimed: boolean }> = [];
  const screenshots: boolean[] = [];
  let orientation: "PORTRAIT" | "LANDSCAPE" = "PORTRAIT";
  const liveTouches: Array<{ readonly gestureId: string; readonly phase: string;
    readonly sequence: number; readonly x: number; readonly y: number;
    readonly claimed: boolean }> = [];
  const viewerProfiles: unknown[] = [];
  let activeDriver: { instanceId: string; simulatorUdid: string; leaseId: string; pid: number;
    controlPort: number; mjpegPort: number; sourceRevision: string; buildCacheKey: string;
    driverSessionId: string; health: { ready: true; message: null; osName: string;
      osVersion: string; sdkVersion: string; deviceIp: null }; state: "ready" } | null = null;
  const mjpegServer: Server = createServer((_request, response) => {
    if (!jpeg) { response.writeHead(503); response.end(); return; }
    response.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame" });
    const send = (): void => {
      if (!jpeg || response.destroyed) return;
      response.write(Buffer.concat([Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`),
        jpeg, Buffer.from("\r\n")]));
    };
    send();
    const timer = setInterval(send, 500);
    response.on("close", () => clearInterval(timer));
  });
  await new Promise<void>(resolve => mjpegServer.listen(0, "127.0.0.1", resolve));
  const address = mjpegServer.address();
  if (!address || typeof address === "string") throw new Error("MJPEG loopback port was not allocated.");
  const application = await createOrchestratorApplication(config, { simulatorRuntime: {
    environment: { inspect: async () => ({ platform: "darwin", supported: true, ready: true,
      xcodeVersion: "Xcode 16.4\nBuild version 16F6", runtimes: [],
      devices: existing ? [{ ...device, state: booted ? "Booted" : "Shutdown" }] : [],
      issue: null, error: null, setupSteps: [] }) },
    lifecycle: {
      findExact: async value => existing && value === udid
        ? { ...device, state: booted ? "Booted" : "Shutdown" } : null,
      bootExact: async value => { expect(value).toBe(udid); booted = true;
        return { ...device, state: "Booted" }; },
      shutdownExact: async value => { expect(value).toBe(udid); booted = false; },
      takeScreenshot: async value => {
        expect(value).toBe(udid);
        screenshots.push(application.store.listOperations({ sessionId: "viewer-web-task",
          status: "started" }).some(operation => operation.kind === "ios_simulator_screenshot"));
        if (!png) throw new Error("Fixture screenshot is unavailable.");
        return png;
      }
    },
    delete: { deleteExact: async input => {
      expect(input.udid).toBe(udid);
      deletes += 1;
      existing = false;
    } },
    driver: { architecture: "arm64", nativeHidRuntime: {
      probe: async () => true,
      touch: async () => { throw new Error("Viewer must use a continuous native contact."); },
      beginLiveTouch: async (identity, gestureId, point) => {
        expect(identity.simulatorUdid).toBe(udid);
        const record = (phase: string, sequence: number,
          next: { readonly x: number; readonly y: number }): void => {
          liveTouches.push({ gestureId, phase, sequence, x: next.x, y: next.y,
            claimed: application.store.listOperations({ sessionId: "viewer-web-task",
              status: "started" }).some(operation => operation.kind === "ios_simulator_input") });
        };
        record("begin", 0, point);
        return { move: async (next, sequence) => record("move", sequence, next),
          end: async (next, sequence) => record("end", sequence, next),
          cancel: async (next, sequence) => record("cancel", sequence, next),
          forceRelease: () => {} };
      }
    }, nativeH264Runtime: {
      probe: async () => h264 !== undefined,
      stream: async function* (_identity, _profile, signal) {
        let sequence = 0;
        while (!signal?.aborted && !stopNative) {
          sequence += 1;
          yield { sequence, width: 64, height: 64, timestampMicros: sequence * 1_000_000,
            keyFrame: true, format: "annex-b" as const, bytes: h264!,
            receivedAt: new Date().toISOString() };
          await new Promise<void>(resolve => setTimeout(resolve, 250));
        }
        if (stopNative) throw new Error("Native frame source disconnected.");
      }
    }, manager: {
      get: instanceId => activeDriver?.instanceId === instanceId ? activeDriver : null,
      start: async options => {
        ownerFingerprint = createHash("sha256").update([
          resolve(join(dataDirectory, "driver-cache")), options.instanceId,
          options.simulatorUdid.toUpperCase()
        ].join("\0")).digest("hex");
        activeDriver = { instanceId: options.instanceId, simulatorUdid: udid,
          leaseId: randomUUID(), pid: process.pid, controlPort: wdaPort,
          mjpegPort: address.port, sourceRevision: "fixture", buildCacheKey: "a".repeat(64),
          driverSessionId: "SESSION-1", health: { ready: true, message: null,
            osName: "iOS", osVersion: "19.0", sdkVersion: "19.0", deviceIp: null }, state: "ready" };
        return activeDriver;
      },
      stop: async () => { activeDriver = null; },
      retryOwnedCleanup: async () => {}
    }, cleanupOrphans: async () => {} }
  } });
  const wdaServer: Server = createServer((request, response) => {
    const send = (value: unknown): void => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ value }));
    };
    if (request.method === "POST" && request.url && [
      "/session/SESSION-1/actions", "/session/SESSION-1/wda/keys",
      "/session/SESSION-1/appium/settings", "/session/SESSION-1/wda/pressButton",
      "/session/SESSION-1/orientation", "/session/SESSION-1/wda/lock",
      "/session/SESSION-1/wda/unlock"
    ].includes(request.url)) {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (request.url === "/session/SESSION-1/appium/settings") viewerProfiles.push(body);
        else if (request.url === "/session/SESSION-1/wda/keys" ||
          request.url === "/session/SESSION-1/actions") viewerInputs.push({ url: request.url!, body,
          claimed: application.store.listOperations({ sessionId: "viewer-web-task", status: "started" })
            .some(operation => operation.kind === "ios_simulator_input") });
        else {
          const kind = request.url === "/session/SESSION-1/wda/pressButton"
            ? "ios_simulator_input" : "ios_simulator_state_control";
          deviceCommands.push({ url: request.url!, body,
            claimed: application.store.listOperations({ sessionId: "viewer-web-task",
              status: "started" }).some(operation => operation.kind === kind) });
          if (request.url === "/session/SESSION-1/orientation") orientation = body.orientation;
        }
        send(null);
      });
      return;
    }
    if (request.method !== "GET") { response.writeHead(405); response.end(); return; }
    if (request.url === "/status") send({ ready: true, build: { upgradedAt: ownerFingerprint } });
    else if (request.url === "/session/SESSION-1/source?format=json") send({
      type: "XCUIElementTypeOther", children: [{ type: "XCUIElementTypeTextField",
        label: "Viewer input", enabled: true, visible: true,
        rect: { x: 10, y: 20, width: 160, height: 44 } }]
    });
    else if (request.url === "/session/SESSION-1/window/size") send(orientation === "PORTRAIT"
      ? { width: 393, height: 852 } : { width: 852, height: 393 });
    else if (request.url === "/session/SESSION-1/orientation") send(orientation);
    else { response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ value: { error: "invalid session id" } })); }
  });
  let server: Awaited<ReturnType<typeof createPublicServer>> | undefined;
  let browser: Browser | undefined;
  try {
    await new Promise<void>(resolveWda => wdaServer.listen(0, "127.0.0.1", resolveWda));
    const wdaAddress = wdaServer.address();
    if (!wdaAddress || typeof wdaAddress === "string") {
      throw new Error("WDA loopback port was not allocated.");
    }
    wdaPort = wdaAddress.port;
    const target = application.store.getTarget("workspace").descriptor;
    application.store.createSession({ id: "viewer-web-task", backendId: target.backendId,
      targetId: target.id, title: "Viewer Web task",
      binding: { opaqueRef: "viewer-web-native", generation: 1 }, pinned: false,
      archived: false, permissionMode: "ask", planMode: false, fastMode: false,
      createdAt: Date.now(), updatedAt: Date.now() });
    const codes = new Map<string, string>();
    const removePairingListener = application.connections.onPairingIssued(challenge => {
      codes.set(challenge.id, challenge.code);
    });
    try {
      application.connections.openPairingWindow();
      server = await createPublicServer(application);
      server.log.level = "silent";
      const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
      const anonymous = createE2eClients(baseUrl);
      const challenge = await anonymous.connection.beginPairing({ deviceDisplayName: "Viewer Web" });
      const code = codes.get(challenge.challenge!.challengeId);
      if (!code) throw new Error("Viewer Web pairing code was not observed.");
      browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
      const page = await browser.newPage({ viewport: { width: 1160, height: 850 } });
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"],
        { origin: new URL(baseUrl).origin });
      const dataUrls = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 16; canvas.height = 12;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Browser canvas is unavailable.");
        context.fillStyle = "#497cbd";
        context.fillRect(0, 0, 16, 12);
        return { jpeg: canvas.toDataURL("image/jpeg", 0.8),
          png: canvas.toDataURL("image/png") };
      });
      jpeg = Buffer.from(dataUrls.jpeg.split(",")[1] ?? "", "base64");
      png = Buffer.from(dataUrls.png.split(",")[1] ?? "", "base64");
      expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      await page.goto(`${baseUrl}/#/tasks/viewer-web-task`, { waitUntil: "domcontentloaded" });
      // A 64×64 solid frame encoded as Annex-B Main-profile H.264 by libx264.
      h264 = new Uint8Array(Buffer.from("AAAAAWdNQArcQmwEQAAAAwBAAAADAIPEieAAAAABaO4PLIAAAAFliIQEv/7oyfzLHD3dQ0paXYOlpxzCPR0j/rkHZkvIIcFZB4uJwQ==", "base64"));
      expect(h264.subarray(0, 4)).toEqual(new Uint8Array([0, 0, 0, 1]));
      const decoderSupported = await page.evaluate(async () => typeof VideoDecoder !== "undefined" &&
        (await VideoDecoder.isConfigSupported({ codec: "avc1.4d400a", codedWidth: 64,
          codedHeight: 64, optimizeForLatency: true,
          hardwareAcceleration: "prefer-hardware" })).supported);
      expect(decoderSupported).toBe(true);
      await page.locator(".connection-tabs > button").nth(2).click();
      await page.getByLabel("Joko node address").fill(baseUrl);
      await page.getByLabel("Pairing code").fill(code);
      await page.getByLabel("Device name").fill("Viewer Web");
      await page.locator("form.pair-form button[type=submit]").click();
      await page.locator("aside.inspector").waitFor({ state: "attached", timeout: 30_000 });
      const current = application.store.getSession("viewer-web-task").descriptor;
      application.simulatorViewer!.ownership.bindCreatedDevice(
        { sessionId: current.id, targetId: current.targetId,
          generation: current.binding.generation }, device, device.name);
      if (await page.locator("aside.inspector.is-open").count() === 0) {
        await page.getByRole("button", { name: "Open details" }).click({ timeout: 30_000 });
      }
      const inspector = page.locator("aside.inspector.is-open");
      await inspector.getByRole("button", { name: "Add tab" }).click();
      await inspector.getByRole("menuitem", { name: "Simulator" }).click();
      const panel = inspector.locator('[data-tab-kind="simulator"]');
      await panel.getByRole("article", { name: "Joko iPhone" }).waitFor({ state: "visible" });
      await panel.getByText("paused").first().waitFor();
      await panel.getByRole("button", { name: "Start", exact: true }).click();
      await panel.locator(".simulator-viewer__screen canvas").waitFor({ state: "visible" });
      await page.waitForFunction(() => {
        const canvas = document.querySelector<HTMLCanvasElement>(".simulator-viewer__screen canvas");
        return canvas?.width === 64 && canvas.height === 64 &&
          (canvas.getContext("2d")?.getImageData(1, 1, 1, 1).data[3] ?? 0) > 0;
      });
      stopNative = true;
      await panel.locator(".simulator-viewer__screen img").waitFor({ state: "visible" });
      await page.waitForFunction(() => {
        const image = document.querySelector<HTMLImageElement>(".simulator-viewer__screen img");
        return image?.complete && image.naturalWidth === 16 && image.naturalHeight === 12;
      });
      await vi.waitFor(() => expect(viewerProfiles).toContainEqual({ settings: {
        mjpegServerFramerate: 10, mjpegServerScreenshotQuality: 45, mjpegScalingFactor: 70
      } }), { timeout: 5_000 });
      await panel.getByLabel("Video quality").selectOption("high");
      await vi.waitFor(() => expect(viewerProfiles).toContainEqual({ settings: {
        mjpegServerFramerate: 20, mjpegServerScreenshotQuality: 70, mjpegScalingFactor: 100
      } }), { timeout: 5_000 });
      await panel.locator(".simulator-viewer__screen img").waitFor({ state: "visible" });
      const textInput = panel.getByRole("textbox", { name: "Text to type in the Simulator" });
      await textInput.fill("mounted-private-text");
      await textInput.press("Enter");
      await vi.waitFor(() => expect(viewerInputs).toHaveLength(1), { timeout: 5_000 });
      expect(viewerInputs[0]).toMatchObject({ url: "/session/SESSION-1/wda/keys", claimed: true });
      expect(await textInput.inputValue()).toBe("");

      const interactiveFrame = panel.locator(".simulator-viewer__screen img");
      await interactiveFrame.click({ position: { x: 8, y: 6 } });
      await vi.waitFor(() => expect(liveTouches).toHaveLength(2), { timeout: 5_000 });
      expect(liveTouches.map(touch => touch.phase)).toEqual(["begin", "end"]);
      expect(new Set(liveTouches.map(touch => touch.gestureId)).size).toBe(1);
      expect(liveTouches.every(touch => touch.claimed)).toBe(true);
      const frameBox = await interactiveFrame.boundingBox();
      if (!frameBox) throw new Error("Visible Simulator frame has no pointer bounds.");
      await page.mouse.move(frameBox.x + 2, frameBox.y + 2);
      await page.mouse.down();
      await page.mouse.move(frameBox.x + frameBox.width - 2,
        frameBox.y + frameBox.height - 2, { steps: 4 });
      await page.mouse.up();
      await vi.waitFor(() => {
        expect(liveTouches.length).toBeGreaterThan(3);
        expect(liveTouches.at(-1)?.phase).toBe("end");
      }, { timeout: 5_000 });
      const drag = liveTouches.slice(2);
      expect(drag[0]?.phase).toBe("begin");
      expect(drag.some(touch => touch.phase === "move")).toBe(true);
      expect(drag.at(-1)?.phase).toBe("end");
      expect(new Set(drag.map(touch => touch.gestureId)).size).toBe(1);
      expect(drag.every(touch => touch.claimed)).toBe(true);
      expect(viewerInputs).toHaveLength(1);
      const inputOperations = application.store.listOperations({ sessionId: "viewer-web-task",
        status: "completed" }).filter(operation => operation.kind === "ios_simulator_input");
      expect(inputOperations).toHaveLength(3);
      expect(JSON.stringify(inputOperations.map(operation => ({ body: operation.body,
        response: "response" in operation ? operation.response : null })),
      (_key, value) => typeof value === "bigint" ? value.toString() : value))
        .not.toContain("mounted-private-text");
      await panel.getByText(/393×852 · Video: WDA MJPEG · Input: Native touch/u).waitFor();
      await panel.getByRole("button", { name: "Home", exact: true }).click();
      await vi.waitFor(() => expect(deviceCommands).toContainEqual({
        url: "/session/SESSION-1/wda/pressButton", body: { name: "home" }, claimed: true
      }), { timeout: 5_000 });
      await panel.getByRole("button", { name: "Rotate device" }).click();
      await vi.waitFor(() => expect(deviceCommands).toContainEqual({
        url: "/session/SESSION-1/orientation", body: { orientation: "LANDSCAPE" }, claimed: true
      }), { timeout: 5_000 });
      await panel.getByText(/852×393 · Video: WDA MJPEG · Input: Native touch/u).waitFor();
      await panel.getByRole("button", { name: "Lock screen", exact: true }).click();
      await panel.getByRole("button", { name: "Unlock screen", exact: true }).click();
      expect(deviceCommands.map(item => item.url)).toEqual([
        "/session/SESSION-1/wda/pressButton", "/session/SESSION-1/orientation",
        "/session/SESSION-1/wda/lock", "/session/SESSION-1/wda/unlock"
      ]);
      expect(deviceCommands.every(item => item.claimed)).toBe(true);
      await panel.getByRole("button", { name: "Copy screenshot" }).click();
      await panel.getByText("Screenshot copied to clipboard.").waitFor();
      expect(screenshots).toEqual([true]);
      expect(await page.evaluate(async () => {
        const item = (await navigator.clipboard.read())[0];
        const blob = await item!.getType("image/png");
        return { type: blob.type, signature: [...new Uint8Array(await blob.slice(0, 8).arrayBuffer())] };
      })).toEqual({ type: "image/png", signature: [137, 80, 78, 71, 13, 10, 26, 10] });
      await panel.getByText("Native video stopped; showing WDA video.").waitFor();
      stopNative = false;
      await panel.getByRole("button", { name: "Retry native video" }).click();
      await panel.getByText("Native video is restored.").waitFor();
      await panel.locator(".simulator-viewer__screen canvas").waitFor({ state: "visible" });
      await page.waitForFunction(() => {
        const canvas = document.querySelector<HTMLCanvasElement>(".simulator-viewer__screen canvas");
        return canvas?.width === 64 && canvas.height === 64 &&
          (canvas.getContext("2d")?.getImageData(1, 1, 1, 1).data[3] ?? 0) > 0;
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await panel.locator(".simulator-viewer__screen canvas").waitFor({ state: "visible" });
      await panel.getByRole("button", { name: "Copy screenshot" }).waitFor({ state: "visible" });
      const deleteButton = panel.getByRole("button", { name: "Delete", exact: true });
      await deleteButton.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("alertdialog", { name: "Delete this Simulator?" });
      await dialog.waitFor({ state: "visible" });
      expect(deletes).toBe(0);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      expect(deletes).toBe(0);
      await deleteButton.click();
      await dialog.getByRole("button", { name: "Delete device" }).click();
      await panel.getByText("No Simulator is attached to this task.").waitFor({ state: "visible" });
      expect(deletes).toBe(1);
      expect(application.simulatorViewer!.ownership.listForTask(
        { sessionId: "viewer-web-task", targetId: target.id,
          generation: application.store.getSession("viewer-web-task").descriptor.binding.generation })).toEqual([]);
    } finally { removePairingListener(); }
  } finally {
    await browser?.close();
    await server?.close();
    await application.close();
    wdaServer.closeAllConnections();
    await new Promise<void>(resolveWda => wdaServer.close(() => resolveWda()));
    mjpegServer.closeAllConnections();
    await new Promise<void>(resolve => mjpegServer.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
