import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes, createHash } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const scope = args.length === 0 ? "full" : args.length === 2 && args[0] === "--scope" && args[1] === "viewer-lifecycle" ? "viewer-lifecycle" : undefined;
if (!scope) throw new Error("Expected no arguments or --scope viewer-lifecycle.");
const command = `node apps/desktop/scripts/smoke-remote-desktop-viewer.mjs${scope === "full" ? "" : " --scope viewer-lifecycle"}`;
const evidenceRoot = process.env.JOKO_REMOTE_DESKTOP_VIEWER_EVIDENCE_DIR
  ? resolve(process.env.JOKO_REMOTE_DESKTOP_VIEWER_EVIDENCE_DIR)
  : resolve(root, "../../.runtime/validation/c102/viewer-smoke");
const output = resolve(evidenceRoot, scope === "full" ? "." : "lifecycle");
mkdirSync(output, { recursive: true });
if (!process.versions.electron) {
  const electron = createRequire(import.meta.url)("electron");
  const child = spawn(electron, [fileURLToPath(import.meta.url), ...args], { cwd: root, windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, stdio: "inherit" });
  const timeout = setTimeout(() => { child.kill(); }, 90000);
  child.once("exit", (code) => { clearTimeout(timeout); process.exitCode = code ?? 1; });
} else {
  void runHost().catch((error) => {
    process.stderr.write(`Remote desktop viewer Electron host initialization failed: ${error instanceof Error ? error.message : "unknown"}\n`);
    createRequire(import.meta.url)("electron").app.exit(1);
  });
}

async function runHost() {
  const { app, BrowserWindow, ipcMain, protocol, net, nativeImage, screen } = createRequire(import.meta.url)("electron");
  const identity = (relativePath) => {
    const path = resolve(root, relativePath), content = readFileSync(path);
    return { path, bytes: content.byteLength, sha256: createHash("sha256").update(content).digest("hex") };
  };
  writeFileSync(resolve(output, "identity.json"), JSON.stringify({ command, scope,
    cwd: resolve(root, "../.."), startedAt: new Date().toISOString(), platform: process.platform,
    node: process.versions.node, electron: process.versions.electron,
    sources: ["scripts/smoke-remote-desktop-viewer.mjs", "src/remote-desktop-viewer-windows.ts",
      "src/remote-desktop-viewer-presentation.ts", "src/remote-desktop-viewer-preload.cts",
      "../web/src/components/DesktopRemoteDesktopViewerWindow.tsx", "../web/src/remote-desktop-viewer-controller.ts"].map(identity),
    consumedArtifacts: ["dist/remote-desktop-viewer-windows.js", "dist/remote-desktop-viewer-presentation.js",
      "dist/remote-desktop-viewer-preload.cjs", "dist/web/index.html"].map(identity) }, null, 2));
  protocol.registerSchemesAsPrivileged([{ scheme: "joko", privileges: { standard: true, secure: true, supportFetchAPI: true,
    corsEnabled: true, stream: true } }]);
  app.setPath("userData", resolve(output, "user-data"));
  const { createServer } = await import("node:http");
  const { connectNodeAdapter } = await import("@connectrpc/connect-node");
  const { Code, ConnectError } = await import("@connectrpc/connect");
  const { create } = await import("@bufbuild/protobuf");
  const contracts = await import("@joko/contracts");
  const { DesktopRemoteDesktopViewerWindows, REMOTE_DESKTOP_VIEWER_CHANNELS: C } = await import("../dist/remote-desktop-viewer-windows.js");
  const { createDesktopRemoteDesktopViewerPreferencesStore } = await import("../dist/remote-desktop-viewer-preferences.js");
  const { createNavigationPolicy, resolvePackagedAppResource } = await import("../dist/security.js");
  await app.whenReady();
  const key = randomBytes(32).toString("base64url");
  const peer = create(contracts.DevicePeerRouteIdentitySchema, { targetDeviceId: "synthetic-host", relationId: "synthetic-relation",
    relationRevision: { value: 1n }, targetDeviceRevision: { value: 1n }, routeGeneration: 1n });
  // Synthetic pixels exercise the real image decoder and mounted viewport; no physical screen is captured.
  const bitmap = Buffer.alloc(160 * 100 * 4);
  for (let pixel = 0; pixel < bitmap.length; pixel += 4) {
    bitmap[pixel] = 224; bitmap[pixel + 1] = 208; bitmap[pixel + 2] = 192; bitmap[pixel + 3] = 255;
  }
  const jpeg = nativeImage.createFromBitmap(bitmap, { width: 160, height: 100 }).toJPEG(80);
  const cursorPng = nativeImage.createFromBitmap(Buffer.alloc(8 * 8 * 4, 255), { width: 8, height: 8 }).toPNG();
  if (!jpeg.length) throw new Error("Synthetic frame could not be encoded.");
  let control = false, controlGeneration = 1n, starts = 0, stops = 0, frames = 0;
  let httpRequests = 0, authReads = 0, preferenceReads = 0, credentialFactories = 0, credentialNativeRequests = 0;
  let clipboardFactories = 0, clipboardNativeReads = 0, clipboardNativeWrites = 0;
  let inputRequests = 0, inputAcks = 0, inputSequence = 0n;
  const controlCalls = [];
  let hostMute = false, muteRequests = 0, failNextMute = true;
  let privacyScreen = false, privacyLockOnExit = false, privacyRequests = 0, failNextPrivacy = true;
  let locked = false, lockRequests = 0, lockCalls = 0, expiredLockReplies = 0, locks = 0, failNextLock = true;
  let activeLeaseId = "";
  let deferViewerStart = false, pendingViewerStart;
  const viewerRequests = [], viewerFocus = [], viewerReadiness = [], viewerGeometry = [];
  const retainReceipt = (receipts, receipt) => { receipts.push(receipt); if (receipts.length > 64) receipts.shift(); };
  let fixtureFlavor = "mac", portalConsent = "pending", portalPickers = 0, portalOffers = 0, portalFrames = 0, portalHeartbeats = 0, portalLateFrames = 0;
  let deferPortalFrame = false, deferredPortalFrame;
  let linuxAudioFailures = 0;
  const linuxAudioOffers = [];
  const portalPickerLeases = new Set();
  let clipboardSync = false, clipboardSyncGeneration = 0n, clipboardVersion = 1, localClipboardVersion = 1;
  let remoteClipboard = JSON.stringify({ text: "synthetic host baseline" }), localClipboard = JSON.stringify({ text: "synthetic controller baseline" });
  let clipboardSyncEnables = 0, clipboardCopies = 0, clipboardRemoteWrites = 0, clipboardLocalWrites = 0, failNextClipboardVersion = true;
  let linuxClipboardLocalWriteCalls = 0, linuxClipboardExplicitCopies = 0, linuxClipboardExplicitPastes = 0;
  let deferLinuxClipboardWrite = false, failLinuxClipboardWriteUnknown = false, pendingLinuxClipboardWrite;
  const clipboardTransfers = new Map();
  const clipboardTransferId = "22222222-2222-4222-8222-222222222222";
  const clipboardToken = (json, counter) => fixtureFlavor === "linux-clipboard" ? createHash("sha256").update(json).digest("hex") : String(counter);
  const remoteClipboardToken = () => clipboardToken(remoteClipboard, clipboardVersion);
  const localClipboardToken = () => clipboardToken(localClipboard, localClipboardVersion);
  let credentialSaved = false, credentialBiometric = false, credentialLocked = false, failNextCredential = true;
  let credentialPrepares = 0, credentialBegins = 0, credentialPasswords = 0, credentialReceipts = 0, credentialEnds = 0, credentialSettings = 0;
  let credentialDropAck = false, credentialWantedBiometric = false;
  const credentialHandle = "11111111-1111-4111-8111-111111111111";
  const rpc = (ctx) => { if (ctx.requestHeader.get("authorization") !== `Bearer ${key}`) throw new ConnectError("Unauthorized", Code.Unauthenticated); };
  const display = { displayId: "synthetic-display", name: "Synthetic display", width: 1280, height: 800 };
  let currentMode = "10", originalMode, modeRequests = 0, modeRestores = 0, modeRestoreRefusals = 0;
  let failNextMode = false, failNextModeRestore = false;
  const restoreMode = () => {
    if (!originalMode) return;
    display.width = originalMode.width; display.height = originalMode.height; currentMode = originalMode.modeId;
    originalMode = undefined; modeRestores++;
  };
  const lease = () => ({ leaseId: activeLeaseId, display, controlling: control, controlGeneration });
  const failure = (reason, message) => new ConnectError(message, Code.FailedPrecondition, undefined,
    [{ desc: contracts.RemoteDesktopFailureSchema, value: create(contracts.RemoteDesktopFailureSchema, { reason }) }]);
  const portalCapture = (leaseId) => {
    if (!activeLeaseId || leaseId !== activeLeaseId) throw failure(contracts.RemoteDesktopFailureReason.STOPPED, "Portal lease retired");
    if (!portalPickerLeases.has(leaseId)) { portalPickerLeases.add(leaseId); portalPickers++; }
    if (portalConsent === "denied") throw failure(contracts.RemoteDesktopFailureReason.SCREEN_PERMISSION_REQUIRED, "Local screen sharing declined");
    if (portalConsent !== "granted") throw failure(contracts.RemoteDesktopFailureReason.CAPTURE_PENDING, "Local screen sharing approval pending");
  };
  const server = createServer(connectNodeAdapter({ routes: (router) => {
    router.service(contracts.ConnectionService, { getServerInfo: () => ({ server: { serverId: "synthetic-node", apiVersion: "joko.v1" } }) });
    router.service(contracts.RemoteDesktopService, {
      listRemoteDesktopHosts: (_input, ctx) => { rpc(ctx); return { hosts: [{ route: peer, displayName: "Synthetic desktop", kind: 2, presence: 1, capabilities: [5] }] }; },
      getRemoteDesktopCapabilities: (_input, ctx) => {
        rpc(ctx);
        if (fixtureFlavor !== "mac") return { peer, capabilities: { protocolVersion: 1, enabled: true, canControl: fixtureFlavor !== "linux-portal",
          platform: "linux", displays: [lease().display], automaticReconnect: true, connectionTakeover: true,
          webrtcVideo: fixtureFlavor === "linux-portal" || fixtureFlavor === "linux-audio", trickleIce: true, jpegFallback: true, videoSettings: true,
          systemAudio: fixtureFlavor === "linux-audio",
          cursorOverlay: fixtureFlavor !== "linux-portal", clipboardText: fixtureFlavor === "linux-clipboard",
          clipboardContent: fixtureFlavor === "linux-clipboard", clipboardSync: fixtureFlavor === "linux-clipboard",
          clipboardInline: fixtureFlavor === "linux-clipboard" } };
        return { peer, capabilities: { protocolVersion: 1, enabled: true, canControl: !credentialLocked,
        platform: "darwin", displays: [lease().display], automaticReconnect: true, connectionTakeover: true,
        webrtcVideo: false, jpegFallback: true, videoSettings: true, clipboardText: true, clipboardContent: true,
        systemAudio: true, hostMute: true, lockOnExit: true, clipboardSync: true, clipboardInline: true, privacyScreen: true, nativeCredentials: true,
        displayModes: true, resolutionRestore: true } }; },
      // Reopening is a fresh synthetic unlocked host occurrence, not a physical unlock operation.
      startRemoteDesktop: async (_input, ctx) => {
        rpc(ctx);
        if (deferViewerStart) {
          deferViewerStart = false;
          await new Promise(accept => { pendingViewerStart = accept; });
          pendingViewerStart = undefined;
        }
        if (originalMode && !activeLeaseId) {
          if (failNextModeRestore) { failNextModeRestore = false; modeRestoreRefusals++; throw failure(contracts.RemoteDesktopFailureReason.DISPLAY_RESTORE_UNAVAILABLE, "Original mode restoration is pending"); }
          restoreMode();
        }
        starts++; activeLeaseId = `synthetic-lease-${starts}`; inputSequence = 0n; control = false; locked = false; privacyScreen = false; privacyLockOnExit = false; clipboardSync = false; clipboardSyncGeneration++; clipboardTransfers.clear();
        if (fixtureFlavor === "linux-portal") portalConsent = "pending";
        return { peer, lease: lease() };
      },
      listRemoteDesktopDisplayModes: (input, ctx) => {
        rpc(ctx); if (!activeLeaseId || input.leaseId !== activeLeaseId) throw failure(contracts.RemoteDesktopFailureReason.STOPPED, "Mode lease retired");
        return { peer, modes: [
          { modeId: "10", width: workArea.width + 256, height: workArea.height + 256, native: true, current: currentMode === "10" },
          { modeId: "20", width: 1000, height: 700, current: currentMode === "20" },
          { modeId: "30", width: 800, height: 600, current: currentMode === "30" }
        ] };
      },
      setRemoteDesktopDisplayMode: (input, ctx) => {
        rpc(ctx); modeRequests++;
        if (!control || input.leaseId !== activeLeaseId || input.controlGeneration !== controlGeneration) throw failure(contracts.RemoteDesktopFailureReason.VIEW_ONLY, "Mode control retired");
        if (!input.temporary || !["20", "30"].includes(input.modeId)) throw failure(contracts.RemoteDesktopFailureReason.DISPLAY_MODE_MISSING, "Mode unavailable");
        originalMode ??= { modeId: currentMode, width: display.width, height: display.height };
        currentMode = input.modeId; display.width = currentMode === "20" ? 1000 : 800; display.height = currentMode === "20" ? 700 : 600;
        control = false; controlGeneration++; hostMute = false; privacyScreen = false; privacyLockOnExit = false; clipboardSync = false; clipboardSyncGeneration++;
        if (failNextMode) {
          failNextMode = false; failNextModeRestore = true; activeLeaseId = "";
          throw failure(contracts.RemoteDesktopFailureReason.DISPLAY_RESTORE_UNAVAILABLE, "Mode effect is unconfirmed and original restoration is pending");
        }
        return { peer, result: { lease: lease() } };
      },
      setRemoteDesktopControl: (input, ctx) => {
        rpc(ctx); const current = !!activeLeaseId && input.leaseId === activeLeaseId;
        controlCalls.push({ current, enabled: input.enabled });
        if (!current) throw failure(contracts.RemoteDesktopFailureReason.STOPPED, "Control lease retired");
        if (fixtureFlavor === "linux-portal" && input.enabled) throw failure(contracts.RemoteDesktopFailureReason.VIEW_ONLY, "Portal is view only");
        control = input.enabled; controlGeneration++; hostMute = false; privacyScreen = false; privacyLockOnExit = false; clipboardSync = false; clipboardSyncGeneration++;
        return { peer, state: { controlling: control, controlGeneration } };
      },
      sendRemoteDesktopInput: (input, ctx) => {
        rpc(ctx); inputRequests++;
        if (!control || input.leaseId !== activeLeaseId || input.sequence <= inputSequence || !input.events.length || input.events.length > 64) {
          throw failure(contracts.RemoteDesktopFailureReason.STOPPED, "Input authority retired");
        }
        // ACK generated input only; this fixture never injects physical OS input.
        inputSequence = input.sequence; inputAcks++; return { peer };
      },
      setRemoteDesktopPrivacyScreen: (input, ctx) => {
        rpc(ctx); privacyRequests++;
        if (!control || input.request?.leaseId !== activeLeaseId || input.request.controlGeneration !== controlGeneration) {
          throw failure(contracts.RemoteDesktopFailureReason.PRIVACY_EXPIRED, "Privacy authority retired");
        }
        if (input.request.enabled && failNextPrivacy) {
          failNextPrivacy = false; throw failure(contracts.RemoteDesktopFailureReason.PRIVACY_UNAVAILABLE, "Privacy unavailable");
        }
        privacyScreen = input.request.enabled; privacyLockOnExit = input.request.lockOnExit;
        return { peer, result: { enabled: privacyScreen } };
      },
      setRemoteDesktopClipboardSync: (input, ctx) => {
        rpc(ctx); const request = input.request;
        if (!request || request.leaseId !== activeLeaseId || request.controlGeneration !== controlGeneration || (request.enabled && !control)) {
          throw failure(contracts.RemoteDesktopFailureReason.CLIPBOARD_EXPIRED, "Clipboard sync retired");
        }
        clipboardSync = request.enabled; clipboardSyncGeneration++;
        if (clipboardSync) clipboardSyncEnables++;
        return { peer, result: { enabled: clipboardSync, syncGeneration: clipboardSyncGeneration } };
      },
      getRemoteDesktopClipboardVersion: (input, ctx) => {
        rpc(ctx); const request = input.request;
        if (!clipboardSync || !control || request?.leaseId !== activeLeaseId || request.controlGeneration !== controlGeneration || request.syncGeneration !== clipboardSyncGeneration) {
          throw failure(contracts.RemoteDesktopFailureReason.CLIPBOARD_EXPIRED, "Clipboard sync retired");
        }
        if (failNextClipboardVersion) { failNextClipboardVersion = false; throw new ConnectError("Clipboard access denied", Code.PermissionDenied); }
        return { peer, result: { version: remoteClipboardToken() } };
      },
      transferRemoteDesktopClipboardContent: (input, ctx) => {
        rpc(ctx); const transfer = input.transfer;
        if (!control || !transfer || transfer.leaseId !== activeLeaseId || transfer.controlGeneration !== controlGeneration ||
          (transfer.sync && (!clipboardSync || transfer.syncGeneration !== clipboardSyncGeneration)) || (!transfer.sync && fixtureFlavor !== "linux-clipboard")) {
          throw failure(contracts.RemoteDesktopFailureReason.CLIPBOARD_EXPIRED, "Clipboard sync retired");
        }
        if (transfer.sync && transfer.version !== undefined && transfer.version !== remoteClipboardToken()) throw failure(contracts.RemoteDesktopFailureReason.CLIPBOARD_CHANGED, "Clipboard changed");
        if (transfer.action.case === "copy" && transfer.inline) { clipboardCopies++; return { peer, result: { length: remoteClipboard.length, data: remoteClipboard } }; }
        if (transfer.action.case === "paste" && transfer.inline) {
          const content = JSON.parse(transfer.action.value.data);
          if (Object.keys(content).join(",") !== "text" || typeof content.text !== "string") throw failure(contracts.RemoteDesktopFailureReason.CLIPBOARD_UNSUPPORTED, "Synthetic clipboard item unavailable");
          remoteClipboard = JSON.stringify(content); clipboardVersion++; clipboardRemoteWrites++;
          return { peer, result: { version: remoteClipboardToken() } };
        }
        if (transfer.action.case === "copy") {
          clipboardCopies++; if (!transfer.sync) linuxClipboardExplicitCopies++;
          clipboardTransfers.set(clipboardTransferId, { data: remoteClipboard });
          return { peer, result: { transferId: clipboardTransferId, length: remoteClipboard.length } };
        }
        if (transfer.action.case === "begin") {
          clipboardTransfers.set(clipboardTransferId, { data: "", length: transfer.action.value.length });
          return { peer, result: { transferId: clipboardTransferId } };
        }
        const entry = clipboardTransfers.get(transfer.action.value.transferId);
        if (transfer.action.case === "cancel") { clipboardTransfers.delete(transfer.action.value.transferId); return { peer, result: {} }; }
        if (!entry) throw failure(contracts.RemoteDesktopFailureReason.CLIPBOARD_EXPIRED, "Clipboard transfer retired");
        if (transfer.action.case === "read") return { peer, result: { data: entry.data.slice(transfer.action.value.offset, transfer.action.value.offset + 65536) } };
        if (transfer.action.case === "write") {
          if (transfer.action.value.offset !== entry.data.length) throw failure(contracts.RemoteDesktopFailureReason.CLIPBOARD_UNSUPPORTED, "Clipboard chunk out of order");
          entry.data += transfer.action.value.data; return { peer, result: {} };
        }
        if (transfer.action.case === "commit") {
          if (entry.data.length !== entry.length) throw failure(contracts.RemoteDesktopFailureReason.CLIPBOARD_UNSUPPORTED, "Clipboard length unconfirmed");
          remoteClipboard = JSON.stringify(JSON.parse(entry.data)); clipboardVersion++; clipboardRemoteWrites++;
          if (!transfer.sync) linuxClipboardExplicitPastes++;
          clipboardTransfers.delete(transfer.action.value.transferId);
          return { peer, result: { version: remoteClipboardToken() } };
        }
        throw failure(contracts.RemoteDesktopFailureReason.CLIPBOARD_UNSUPPORTED, "Synthetic clipboard operation unavailable");
      },
      setRemoteDesktopHostMute: (input, ctx) => {
        rpc(ctx); muteRequests++;
        if (!control || input.request?.leaseId !== lease().leaseId || input.request.controlGeneration !== controlGeneration) {
          throw new ConnectError("Control retired", Code.FailedPrecondition);
        }
        if (failNextMute) { failNextMute = false; throw new ConnectError("Host mute unavailable", Code.FailedPrecondition, undefined,
          [{ desc: contracts.RemoteDesktopFailureSchema, value: create(contracts.RemoteDesktopFailureSchema, { reason: contracts.RemoteDesktopFailureReason.HOST_MUTE_UNAVAILABLE }) }]); }
        hostMute = input.request.enabled; return { peer, result: { enabled: hostMute } };
      },
      heartbeatRemoteDesktop: (_input, ctx) => { rpc(ctx); if (fixtureFlavor === "linux-portal") portalHeartbeats++; return { peer, state: { controlling: control, controlGeneration } }; },
      getRemoteDesktopIceConfiguration: (_input, ctx) => { rpc(ctx); return { peer, iceServers: [] }; },
      createRemoteDesktopOffer: (input, ctx) => {
        rpc(ctx); if (fixtureFlavor === "linux-portal") { portalOffers++; portalCapture(input.leaseId); }
        if (fixtureFlavor === "linux-audio") {
          if (input.leaseId !== activeLeaseId) throw failure(contracts.RemoteDesktopFailureReason.STOPPED, "Audio lease retired");
          linuxAudioOffers.push({ leaseId: input.leaseId, attemptId: input.attemptId, audio: input.settings?.audio === true });
          if (input.settings?.audio) {
            linuxAudioFailures++;
            throw failure(contracts.RemoteDesktopFailureReason.AUDIO_UNAVAILABLE, "Synthetic system output unavailable");
          }
        }
        throw failure(contracts.RemoteDesktopFailureReason.UNSUPPORTED, "Synthetic host uses JPEG after consent");
      },
      getRemoteDesktopLockState: (_input, ctx) => { rpc(ctx); return { peer, result: { state: credentialLocked ? contracts.RemoteDesktopLockState.LOCKED : contracts.RemoteDesktopLockState.UNLOCKED } }; },
      requestRemoteDesktopCredentials: (input, ctx) => {
        rpc(ctx); const request = input.request?.request;
        if (request?.case === "prepare") { credentialPrepares++; return { peer, result: { result: { case: "prepared", value: { descriptor: "synthetic-public-host" } } } }; }
        if (request?.case === "open") return { peer, result: { result: { case: "opened", value: { handle: credentialHandle, offer: "synthetic-host-offer" } } } };
        if (request?.case !== "exchange" || request.value.handle !== credentialHandle) throw failure(contracts.RemoteDesktopFailureReason.CREDENTIAL_EXPIRED, "Credential occurrence retired");
        const ciphertext = request.value.ciphertext;
        if (ciphertext === "synthetic-revoke") { credentialEnds++; return { peer, result: { result: { case: "closed", value: {} } } }; }
        if (ciphertext === "synthetic-password") {
          credentialPasswords++; credentialLocked = false;
          if (credentialDropAck) {
            credentialDropAck = false; throw new ConnectError("Credential receipt unknown", Code.Aborted, undefined,
              [{ desc: contracts.RemoteDesktopFailureSchema, value: create(contracts.RemoteDesktopFailureSchema, { reason: contracts.RemoteDesktopFailureReason.CREDENTIAL_OUTCOME_UNKNOWN }) }]);
          }
        }
        if (ciphertext === "synthetic-new-receipt") credentialReceipts++;
        return { peer, result: { result: { case: "exchanged", value: { ciphertext: ciphertext === "synthetic-ready" ? "ready" : "authenticated" } } } };
      },
      stopRemoteDesktop: (input, ctx) => {
        rpc(ctx);
        if (input.lockScreen) lockCalls++;
        if (!activeLeaseId || input.leaseId !== activeLeaseId || (input.lockScreen && input.controlGeneration !== controlGeneration)) {
          if (input.lockScreen) expiredLockReplies++;
          throw failure(input.lockScreen ? contracts.RemoteDesktopFailureReason.LOCK_EXPIRED : contracts.RemoteDesktopFailureReason.STOPPED, "Exit retired");
        }
        activeLeaseId = ""; control = false; hostMute = false; privacyScreen = false; privacyLockOnExit = false; clipboardSync = false; clipboardSyncGeneration++; clipboardTransfers.clear();
        restoreMode();
        if (input.lockScreen) {
          lockRequests++;
          if (failNextLock) { failNextLock = false; throw failure(contracts.RemoteDesktopFailureReason.LOCK_FAILED, "Lock failed"); }
          locked = true; locks++;
        }
        stops++; return { peer };
      },
      getRemoteDesktopFrame: (input, ctx) => {
        rpc(ctx); frames++;
        if (fixtureFlavor === "linux-portal") {
          portalFrames++;
          if (deferPortalFrame) {
            deferPortalFrame = false;
            return new Promise(resolveReply => { deferredPortalFrame = { leaseId: input.leaseId, resolve: resolveReply }; });
          }
          portalCapture(input.leaseId);
        }
        return { peer, result: { frame: { jpeg, ...(fixtureFlavor === "linux-native" || fixtureFlavor === "linux-clipboard" ? {
          cursor: { visible: true, x: 0.5, y: 0.5, width: 8, height: 8, hotX: 0, hotY: 0, png: cursorPng }
        } : {}) } } };
      }
    });
  } }));
  server.on("request", () => { httpRequests++; });
  await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const owner = { profileId: "synthetic-profile", deviceId: "synthetic-controller", serverId: "synthetic-node", origin, connectionGeneration: 1 };
  const policy = createNavigationPolicy(resolve(root, "dist/web/index.html"));
  protocol.handle("joko", async (request) => {
    const path = resolvePackagedAppResource(request.url, policy);
    if (!path) return new Response("Unavailable", { status: 403 });
    return net.fetch(pathToFileURL(path).href);
  });
  const sourcePreload = resolve(output, "source-preload.cjs");
  writeFileSync(sourcePreload, `const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('smokeSource',{invoke:(channel,...args)=>ipcRenderer.invoke(channel,'synthetic-document',...args)});`);
  const source = new BrowserWindow({ show: true, webPreferences: { preload: sourcePreload, contextIsolation: true, sandbox: true, nodeIntegration: false } });
  await source.loadURL("data:text/html,<title>Remote desktop source</title>");
  // Oversize synthetic geometry exercises the actual toolbar action's native work-area clamp.
  const workArea = screen.getDisplayMatching(source.getBounds()).workArea;
  display.width = workArea.width + 256; display.height = workArea.height + 256;
  const preferencePath = resolve(app.getPath("userData"), `viewer-preferences-${randomBytes(8).toString("hex")}.json`);
  const preferences = createDesktopRemoteDesktopViewerPreferencesStore(preferencePath);
  await preferences.initialize();
  let quitting = false;
  // A copied preload changes only the controlled fixture platform. Production keeps the real OS gate.
  const credentialPreload = resolve(output, "viewer-mac-fixture-preload.cjs");
  const productionPreload = readFileSync(resolve(root, "dist/remote-desktop-viewer-preload.cjs"), "utf8");
  if (!productionPreload.includes("platform: process.platform")) throw new Error("Compiled platform entry unavailable for the fixture.");
  writeFileSync(credentialPreload, productionPreload.replace("platform: process.platform", 'platform: "darwin"'));
  const manager = new DesktopRemoteDesktopViewerWindows({ sourceDirectory: resolve(root, "dist"), entryUrl: "joko://app/index.html", navigation: policy,
    preferences: { ...preferences, get: (...parameters) => { preferenceReads++; return preferences.get(...parameters); } },
    locale: () => "en", quitting: () => quitting, readAuthKey: async (id) => { authReads++; return id === owner.profileId ? key : undefined; },
    credentialPlatform: "darwin", preloadPath: credentialPreload,
    credentialNative: () => { credentialFactories++; return { close: async () => undefined, request: async (method, args) => {
      credentialNativeRequests++;
      if (method === "viewerSettings") { credentialSettings++; return { autoUnlock: credentialSaved, biometricVerification: credentialBiometric, biometricAvailable: true, biometricPreferred: true }; }
      if (method === "viewerConfigure") return "synthetic-public-controller";
      if (method === "viewerBegin") {
        credentialBegins++; if (failNextCredential) { failNextCredential = false; throw new Error("CREDENTIAL_UNAVAILABLE"); }
        credentialWantedBiometric = args.biometric;
        return { handle: credentialHandle, offer: "synthetic-controller-offer", descriptor: "synthetic-public-controller" };
      }
      if (method === "viewerAccept") return "synthetic-ready";
      if (method === "viewerPassword") return "synthetic-password";
      if (method === "viewerAuthenticationStatus") return "synthetic-new-receipt";
      if (method === "viewerReceive") {
        if (args.ciphertext === "ready") return JSON.stringify({ kind: "ready", saved: credentialSaved });
        credentialSaved = true; credentialBiometric = credentialWantedBiometric;
        return JSON.stringify({ kind: "authenticated", accepted: true });
      }
      if (method === "viewerEnd") return "synthetic-revoke";
      if (method === "viewerForget") { credentialSaved = false; credentialBiometric = false; return true; }
      if (method === "viewerBiometric") { credentialBiometric = args.enabled; return true; }
      throw new Error("CREDENTIAL_INVALID_MESSAGE");
    } }; },
    // The real Main sync owner receives a controlled system-only clipboard adapter.
    syncClipboard: () => { clipboardFactories++; return { available: true, ...(fixtureFlavor === "linux-clipboard" ? { platform: "linux" } : {}),
      version: async () => { clipboardNativeReads++; return localClipboardToken(); },
      read: async (current, signal) => {
        clipboardNativeReads++;
        if (signal.aborted || !current()) throw new Error("REMOTE_DESKTOP_CLIPBOARD_EXPIRED"); return localClipboard;
      },
      write: async (json, version, current, signal) => {
        clipboardNativeWrites++;
        if (signal.aborted || !current()) throw new Error("REMOTE_DESKTOP_CLIPBOARD_EXPIRED");
        if (version !== localClipboardToken()) throw new Error("REMOTE_DESKTOP_CLIPBOARD_CHANGED");
        localClipboard = json; clipboardLocalWrites++; localClipboardVersion++;
        if (fixtureFlavor === "linux-clipboard") {
          linuxClipboardLocalWriteCalls++;
          if (deferLinuxClipboardWrite) {
            deferLinuxClipboardWrite = false;
            await new Promise(resolveWrite => { pendingLinuxClipboardWrite = { signal, finish: resolveWrite }; });
            throw Object.assign(new Error("REMOTE_DESKTOP_CLIPBOARD_OUTCOME_UNKNOWN"), { outcomeUnknown: true });
          }
          if (failLinuxClipboardWriteUnknown) {
            failLinuxClipboardWriteUnknown = false;
            throw Object.assign(new Error("REMOTE_DESKTOP_CLIPBOARD_OUTCOME_UNKNOWN"), { outcomeUnknown: true });
          }
        }
        return localClipboardToken();
      }, stop: () => undefined }; },
    assertSource: (event, occurrence) => {
      if (event.sender !== source.webContents || event.senderFrame !== source.webContents.mainFrame || occurrence !== "synthetic-document") throw new Error("Wrong source document.");
    } });
  // Record only finite request outcomes, never generated bodies or credentials.
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => handle(channel, channel === C.ready ? async (event, generation) => {
    const receipt = { generation, windowId: BrowserWindow.fromWebContents(event.sender)?.id, at: Date.now() };
    try {
      const result = await listener(event, generation);
      retainReceipt(viewerReadiness, { ...receipt, completedAt: Date.now(), ok: true }); return result;
    } catch (error) {
      retainReceipt(viewerReadiness, { ...receipt, completedAt: Date.now(), rejected: true }); throw error;
    }
  } : channel === C.resize ? (event, generation, width, height) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const receipt = { generation: Number.isSafeInteger(generation) ? generation : undefined,
      width: Number.isSafeInteger(width) ? width : undefined, height: Number.isSafeInteger(height) ? height : undefined };
    recordGeometry(window, "resize-request", receipt);
    try {
      const result = listener(event, generation, width, height);
      recordGeometry(window, "resize-handler-returned", receipt); return result;
    } catch (error) { recordGeometry(window, "resize-handler-rejected", receipt); throw error; }
  } : channel !== C.request ? listener : async (event, generation, name, bytes) => {
    const observed = ["getRemoteDesktopFrame", "heartbeatRemoteDesktop", "setRemoteDesktopControl", "startRemoteDesktop"].includes(name);
    const receipt = { name, generation, at: Date.now(), controlGeneration: String(controlGeneration) };
    try {
      const reply = await listener(event, generation, name, bytes);
      if (observed) retainReceipt(viewerRequests, { ...receipt, completedAt: Date.now(), completedControlGeneration: String(controlGeneration),
        ok: reply.ok, code: reply.code, reason: reply.reason });
      return reply;
    } catch (error) {
      if (observed) retainReceipt(viewerRequests, { ...receipt, completedAt: Date.now(), completedControlGeneration: String(controlGeneration), rejected: true });
      throw error;
    }
  });
  try { manager.register(); } finally { ipcMain.handle = handle; }
  const observeFocus = (_event, window) => {
    if (window === source) return;
    const windowId = window.id;
    for (const type of ["show", "focus", "blur", "hide"]) window.on(type, () => {
      retainReceipt(viewerFocus, { type, windowId, at: Date.now(), controlGeneration: String(controlGeneration) });
    });
    for (const type of ["show", "hide", "resize", "enter-full-screen", "leave-full-screen"]) {
      window.on(type, () => recordGeometry(window, type));
    }
    const setBounds = window.setBounds;
    window.setBounds = function(bounds, ...args) {
      recordGeometry(window, "set-bounds-request", { requested: Object.fromEntries(
        ["x", "y", "width", "height"].filter(field => Number.isFinite(bounds[field])).map(field => [field, bounds[field]])) });
      return setBounds.call(this, bounds, ...args);
    };
  };
  app.on("browser-window-created", observeFocus);
  const sourceCall = (channel, ...args) => source.webContents.executeJavaScript(`window.smokeSource.invoke(${JSON.stringify(channel)},...${JSON.stringify(args)})`);
  const viewerWindows = async (windows = BrowserWindow.getAllWindows()) => Promise.all(windows.filter(window => window !== source && !window.isDestroyed())
    .map(async window => ({ window, state: await window.webContents.executeJavaScript("window.jokoRemoteDesktopViewer.state()").catch(() => undefined) })));
  const boundViewer = async () => (await viewerWindows()).find(item => item.state?.target?.deviceId === peer.targetDeviceId)?.window;
  const windowInventory = async (bound) => {
    let inventory;
    await until(async () => {
      inventory = await viewerWindows();
      return inventory.every(item => item.state !== undefined);
    });
    const boundWindows = inventory.filter(item => item.state.target !== null), spares = inventory.filter(item => item.state.target === null);
    if (inventory.length !== 2 || boundWindows.length !== 1 || boundWindows[0].window !== bound || spares.length !== 1 ||
      spares[0].state.generation !== 0 || spares[0].state.active || spares[0].window.isVisible() || spares[0].window.isFocused()) {
      throw new Error("Viewer inventory did not retain one bound window and one hidden unbound spare.");
    }
    return spares[0];
  };
  const prewarmEffects = () => ({ starts, stops, frames, inputRequests, control, controlCalls: controlCalls.length, httpRequests, authReads,
    preferenceReads, credentialFactories, credentialNativeRequests, clipboardFactories, clipboardNativeReads, clipboardNativeWrites });
  let stage = "open", viewer, cachedWindowEvidence, rendererRecoveryEvidence, prewarmEvidence;
  function recordGeometry(window, phase, details = {}) {
    if (stage !== "actual size from fullscreen" || !window || window.isDestroyed()) return;
    retainReceipt(viewerGeometry, { phase, at: Date.now(), windowId: window.id,
      readyGeneration: viewerReadiness.findLast(receipt => receipt.windowId === window.id && receipt.ok)?.generation,
      ...details, fullscreen: window.isFullScreen(), maximized: window.isMaximized(), visible: window.isVisible(),
      bounds: window.getBounds(), content: window.getContentBounds(), workArea: screen.getDisplayMatching(window.getBounds()).workArea });
  }
  const deadline = setTimeout(() => {
    writeFileSync(resolve(output, "failure.json"), JSON.stringify({ scope, stage, deadline: true, starts, stops, frames,
      cachedWindowEvidence, rendererRecoveryEvidence, prewarmEvidence, prewarmEffects: prewarmEffects(), activeLeaseId, control, viewerRequests, viewerFocus, viewerReadiness, viewerGeometry,
      viewerDestroyed: viewer?.isDestroyed() ?? true, pendingViewerStart: pendingViewerStart !== undefined }, null, 2));
    process.stderr.write(`Remote desktop viewer Electron smoke deadline exceeded at ${stage}.\n`);
    quitting = true; manager.dispose(); app.exit(1);
  }, 80000);
  const focusInteraction = async () => {
    const current = viewer;
    if (!current || current.isDestroyed() || !current.isVisible()) throw new Error("Interactive viewer window is unavailable.");
    current.focus();
    await until(async () => current === viewer && !current.isDestroyed() && current.isFocused() &&
      current.webContents.executeJavaScript("document.hasFocus()"));
    return current;
  };
  const interact = async (script) => {
    const current = await focusInteraction();
    if (current !== viewer) throw new Error("Interactive viewer window changed.");
    return current.webContents.executeJavaScript(script);
  };
  try {
    let prewarmedWindow, prewarmedContents;
    if (scope === "viewer-lifecycle") {
      stage = "hidden unbound spare mounts without authority or focus";
      const focusedBefore = BrowserWindow.getFocusedWindow()?.id ?? null;
      manager.prewarm();
      const inventory = BrowserWindow.getAllWindows().filter(window => window !== source);
      if (inventory.length !== 1) throw new Error("Prewarm did not create exactly one local spare.");
      prewarmedWindow = inventory[0]; prewarmedContents = prewarmedWindow.webContents;
      let shell;
      await until(async () => {
        shell = await prewarmedContents.executeJavaScript(`(async()=>({broad:typeof window.jokoDesktop,
          dedicated:typeof window.jokoRemoteDesktopViewer?.request,state:await window.jokoRemoteDesktopViewer.state(),
          heading:document.querySelector('.remote-viewer-heading')?.textContent,imageWidth:document.querySelector('#image')?.naturalWidth??0,
          controlDisabled:document.querySelector('.remote-viewer-toolbar .button')?.disabled}))()`).catch(() => undefined);
        return shell?.state.target === null && shell.state.generation === 0 && shell.heading?.includes("Window inactive") &&
          viewerReadiness.some(receipt => receipt.windowId === prewarmedWindow.id && receipt.generation === 0 && receipt.ok);
      });
      const effects = prewarmEffects(), focusedAfter = BrowserWindow.getFocusedWindow()?.id ?? null;
      if (shell.broad !== "undefined" || shell.dedicated !== "function" || shell.state.active || shell.imageWidth !== 0 || !shell.controlDisabled ||
        prewarmedWindow.isVisible() || prewarmedWindow.isFocused() || focusedBefore !== focusedAfter ||
        Object.values(effects).some(value => value !== 0 && value !== false) || viewerFocus.some(receipt => ["show", "focus"].includes(receipt.type))) {
        throw new Error("Unbound prewarm obtained authority, produced an effect or changed native focus.");
      }
      manager.prewarm();
      if (BrowserWindow.getAllWindows().filter(window => window !== source).length !== 1 ||
        Object.values(prewarmEffects()).some(value => value !== 0 && value !== false)) throw new Error("Repeated prewarm created another shell or effect.");
      prewarmEvidence = { windowId: prewarmedWindow.id, webContentsId: prewarmedContents.id, shell, effects,
        hidden: true, focusUnchanged: true, focusedWindowId: focusedAfter, quietReady: true, repeatedPrewarmBounded: true };
    }
    stage = "authorized open adopts the spare";
    await sourceCall(C.bind, owner);
    const opened = await sourceCall(C.open, owner, { deviceId: peer.targetDeviceId, name: "Synthetic desktop" });
    viewer = await boundViewer();
    if (!viewer) throw new Error("Viewer window missing.");
    const refill = await windowInventory(viewer);
    if (prewarmEvidence) {
      if (!opened.focusedExisting || viewer !== prewarmedWindow || viewer.webContents !== prewarmedContents) {
        throw new Error("Authorized open did not adopt the exact prewarmed BrowserWindow and renderer.");
      }
      prewarmEvidence.adoptedSameWindow = true; prewarmEvidence.adoptedSameWebContents = true;
      prewarmEvidence.refilledSpareWindowId = refill.window.id; prewarmEvidence.refilledSpareState = refill.state;
    }
    stage = "present JPEG";
    await until(async () => {
      const presented = await viewer.webContents.executeJavaScript(`document.querySelector('#image')?.naturalWidth===160 && document.querySelector('.remote-viewer-heading')?.textContent.includes('Connected')`);
      if (!presented && viewerRequests.some(receipt => receipt.name === "getRemoteDesktopFrame" && receipt.ok === false) &&
        await viewer.webContents.executeJavaScript(`document.querySelector('.remote-viewer-heading')?.textContent.includes('Connection interrupted')`)) {
        throw new Error("Initial frame request failed before presentation.");
      }
      return presented;
    });
    stage = "preload and control";
    const boundary = await viewer.webContents.executeJavaScript(`(async()=>({broad:typeof window.jokoDesktop, dedicated:typeof window.jokoRemoteDesktopViewer?.request,
      state:await window.jokoRemoteDesktopViewer.state(), control:document.querySelector('.remote-viewer-toolbar .button')?.getAttribute('aria-pressed')}))()`);
    if (boundary.broad !== "undefined" || boundary.dedicated !== "function" || !boundary.state.active || boundary.state.generation < 1 || boundary.control !== "true") throw new Error("Viewer preload or control boundary failed.");
    stage = "target reuse";
    const reusedStarts = starts, reusedLeaseId = activeLeaseId;
    const reused = await sourceCall(C.open, owner, { deviceId: peer.targetDeviceId, name: "Synthetic desktop" });
    const reusedSpare = await windowInventory(viewer);
    if (!reused.focusedExisting || await boundViewer() !== viewer || reusedSpare.window !== refill.window || starts !== reusedStarts || activeLeaseId !== reusedLeaseId) {
      throw new Error("Same-target reuse consumed its spare or changed its existing bound connection.");
    }
    if (prewarmEvidence) { prewarmEvidence.boundGeneration = boundary.state.generation; prewarmEvidence.sameTargetPreservedSpare = true; }
    stage = "visible renderer crash and quiet replacement shell";
    const crashedViewer = viewer, crashedContents = viewer.webContents, crashedWindowId = viewer.id;
    const crashedLeaseId = activeLeaseId, crashedGeneration = boundary.state.generation;
    const crashStarts = starts, crashStops = stops, crashAt = Date.now();
    const createdWindows = [];
    let replacements = [];
    const created = (_event, replacement) => {
      if (replacement !== source) {
        const occurrence = { window: replacement, createdAt: Date.now() };
        replacement.once("show", () => { occurrence.shownAt = Date.now(); occurrence.bound = true; });
        createdWindows.push(occurrence);
      }
    };
    app.on("browser-window-created", created);
    deferViewerStart = true;
    crashedContents.forcefullyCrashRenderer();
    await until(async () => {
      const inventory = await viewerWindows(createdWindows.map(occurrence => occurrence.window));
      for (const occurrence of createdWindows) {
        if (inventory.some(item => item.window === occurrence.window && item.state?.target?.deviceId === peer.targetDeviceId)) occurrence.bound = true;
      }
      replacements = createdWindows.filter(occurrence => occurrence.bound);
      return replacements.length > 0;
    });
    viewer = replacements[0].window;
    await until(() => viewer.isVisible() && pendingViewerStart !== undefined && !activeLeaseId);
    app.removeListener("browser-window-created", created);
    const quietShell = await viewer.webContents.executeJavaScript(`(async()=>({broad:typeof window.jokoDesktop,
      dedicated:typeof window.jokoRemoteDesktopViewer?.request,state:await window.jokoRemoteDesktopViewer.state(),
      heading:document.querySelector('.remote-viewer-heading')?.textContent,imageWidth:document.querySelector('#image')?.naturalWidth??0}))()`);
    if (replacements.length !== 1 || viewer === crashedViewer || !crashedViewer.isDestroyed() || !crashedContents.isDestroyed() ||
      starts !== crashStarts || stops !== crashStops + 1 || control || quietShell.broad !== "undefined" ||
      quietShell.dedicated !== "function" || !quietShell.state.active || quietShell.state.generation <= crashedGeneration ||
      !quietShell.heading?.includes("Connecting") || quietShell.imageWidth !== 0) {
      throw new Error("Renderer recovery did not show one fresh quiet shell before the deferred network start.");
    }
    const retiredCrashRequest = await viewer.webContents.executeJavaScript(`window.jokoRemoteDesktopViewer.request(${crashedGeneration},'getRemoteDesktopFrame',new Uint8Array()).then(()=>false,()=>true)`);
    if (!retiredCrashRequest) throw new Error("The replacement renderer accepted the crashed generation.");
    writeFileSync(resolve(output, "viewer-recovery-quiet.png"), (await captureViewport(viewer)).toPNG());
    pendingViewerStart();
    stage = "replacement fresh lease after quiet readiness";
    await until(async () => starts === crashStarts + 1 && control && viewer.webContents.executeJavaScript(`document.querySelector('#image')?.naturalWidth===160 && document.querySelector('.remote-viewer-heading')?.textContent.includes('Connected')`));
    await windowInventory(viewer);
    if (!activeLeaseId || activeLeaseId === crashedLeaseId) {
      throw new Error("Renderer recovery reused a retired lease or created another replacement window.");
    }
    rendererRecoveryEvidence = { crashedWindowId, replacementWindowId: viewer.id,
      crashedLeaseId, replacementLeaseId: activeLeaseId, crashedGeneration, replacementGeneration: quietShell.state.generation,
      replacements: replacements.length, shellShownBeforeStart: true, retiredGenerationRejected: true,
      replacementCreatedMs: replacements[0].createdAt - crashAt,
      replacementShownMs: replacements[0].shownAt - replacements[0].createdAt, quietShell };
    writeFileSync(resolve(output, "viewer-recovery-connected.png"), (await captureViewport(viewer)).toPNG());
    if (scope === "viewer-lifecycle") {
      stage = "lifecycle memory bounds before successful close";
      const area = screen.getDisplayMatching(viewer.getBounds()).workArea;
      const width = Math.min(area.width, 900), height = Math.min(area.height, 620);
      viewer.setBounds({ x: area.x + Math.floor((area.width - width) / 2), y: area.y + Math.floor((area.height - height) / 2), width, height });
      await viewer.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      const cachedViewer = viewer, cachedBounds = viewer.getBounds(), closingLeaseId = activeLeaseId;
      const closingGeneration = (await viewer.webContents.executeJavaScript("window.jokoRemoteDesktopViewer.state()")).generation;
      const closeStarts = starts, closeStops = stops;
      writeFileSync(resolve(output, "viewer-before-close.png"), (await captureViewport(viewer)).toPNG());
      stage = "lifecycle explicit successful disconnect";
      await interact(`document.querySelector('.remote-viewer-toolbar button[aria-label="Disconnect"]').click()`);
      await until(async () => viewer.webContents.executeJavaScript(`document.querySelector('.remote-viewer-close-dialog')?.open===true &&
        [...document.querySelectorAll('.remote-viewer-close-dialog button')].some(item=>item.textContent==='Disconnect' && !item.disabled)`));
      await interact(`([...document.querySelectorAll('.remote-viewer-close-dialog button')].find(item=>item.textContent==='Disconnect')).click()`);
      await until(() => !viewer.isDestroyed() && !viewer.isVisible() && !activeLeaseId && stops === closeStops + 1);
      const closedScope = await viewer.webContents.executeJavaScript("window.jokoRemoteDesktopViewer.state()");
      if (closedScope.active || closedScope.generation <= closingGeneration || control || starts !== closeStarts ||
        lockCalls !== 0) {
        throw new Error("Successful disconnect did not retire authority and hide the same BrowserWindow.");
      }
      await windowInventory(viewer);
      stage = "lifecycle old closed generation request and close rejection";
      const retiredCloseRequest = await viewer.webContents.executeJavaScript(`window.jokoRemoteDesktopViewer.request(${closingGeneration},'getRemoteDesktopFrame',new Uint8Array()).then(()=>false,()=>true)`);
      const retiredClose = await viewer.webContents.executeJavaScript(`window.jokoRemoteDesktopViewer.close(${closingGeneration}).then(()=>false,()=>true)`);
      if (!retiredCloseRequest || !retiredClose) throw new Error("The cached window accepted a closed generation request or close.");
      stage = "lifecycle explicit same-window reopen with fresh lease";
      const reopened = await sourceCall(C.open, owner, { deviceId: peer.targetDeviceId, name: "Synthetic desktop" });
      viewer = await boundViewer();
      if (!viewer || viewer !== cachedViewer || !reopened.focusedExisting) throw new Error("Explicit reopen did not reuse the same cached BrowserWindow.");
      await until(async () => starts === closeStarts + 1 && viewer.webContents.executeJavaScript(`document.querySelector('#image')?.naturalWidth===160 && document.querySelector('.remote-viewer-heading')?.textContent.includes('Connected')`));
      const reopenedBounds = viewer.getBounds(), reopenedScope = await viewer.webContents.executeJavaScript("window.jokoRemoteDesktopViewer.state()");
      if (!viewer.isVisible() || !activeLeaseId || activeLeaseId === closingLeaseId || reopenedScope.generation < closedScope.generation ||
        stops !== closeStops + 1 ||
        ["x", "y", "width", "height"].some(field => reopenedBounds[field] !== cachedBounds[field])) {
        throw new Error("Cached target reopen did not preserve memory bounds and establish exactly one fresh lease.");
      }
      const retiringSpare = await windowInventory(viewer);
      await focusInteraction();
      await until(async () => viewer.webContents.executeJavaScript(`(()=> {
        const button=document.querySelector('.remote-viewer-toolbar .button');
        if(!button || button.disabled) return false;
        if(button.getAttribute('aria-pressed')==='false') button.click();
        return true;
      })()`));
      await until(async () => control && viewer.webContents.executeJavaScript(`document.querySelector('.remote-viewer-toolbar .button')?.getAttribute('aria-pressed')==='true'`));
      cachedWindowEvidence = { windowId: viewer.id, sameBrowserWindow: true, cachedBounds, reopenedBounds,
        closingLeaseId, reopenedLeaseId: activeLeaseId, closingGeneration, closedGeneration: closedScope.generation,
        reopenedGeneration: reopenedScope.generation, retiredGenerationRejected: true, retiredCloseRejected: true };
      writeFileSync(resolve(output, "viewer-cached-reopen.png"), (await captureViewport(viewer)).toPNG());
      stage = "lifecycle source retirement destroys viewer";
      const retirementWindowId = viewer.id, retiringSpareWindowId = retiringSpare.window.id, retirementLeaseId = activeLeaseId, retirementStops = stops;
      await sourceCall(C.retire, owner);
      await until(() => viewer.isDestroyed() && retiringSpare.window.isDestroyed() && !activeLeaseId && !control && stops === retirementStops + 1);
      if (starts !== 3 || stops !== 3 || BrowserWindow.getAllWindows().length !== 1) throw new Error("Source retirement did not destroy the viewer and retire all three lifecycle leases.");
      writeFileSync(resolve(output, "result.json"), JSON.stringify({ passed: true, scope, command, platform: process.platform,
        electron: process.versions.electron, starts, stops, frames, controlCalls, boundary, reused,
        cachedWindowEvidence, rendererRecoveryEvidence, prewarmEvidence,
        sourceRetirement: { windowId: retirementWindowId, spareWindowId: retiringSpareWindowId, leaseId: retirementLeaseId, destroyed: true, spareDestroyed: true, stops },
        viewerRequests, viewerFocus, viewerReadiness, evidence: "E2",
        checks: ["standalone preload", "generated HTTP RPC", "presented first JPEG", "confirmed initial control", "same-target reuse",
          "visible renderer crash creates exactly one replacement", "replacement quiet shell is visible while generated start is blocked",
          "replacement establishes fresh lease and confirmed control", "crashed generation request rejected",
          "successful stop hides the same BrowserWindow", "explicit reopen preserves memory bounds and establishes one fresh lease",
          "closed generation request rejected", "closed generation close rejected", "source retirement destroys viewer and retires lease",
          "hidden null-target generation-zero shell mounts and reports quiet readiness without focus or effects",
          "repeated prewarm retains exactly one unbound spare", "authorized open adopts the same BrowserWindow and webContents with fresh binding",
          "authorized open refills exactly one hidden unbound spare", "same-target reuse preserves the spare and original lease",
          "source retirement destroys the remaining unbound spare"],
        limits: ["selected viewer lifecycle scope; full runner attempts remain failed or timed out and are preserved separately",
          "real Windows Electron with staged production Web and controlled generated HTTP host, pixels and display geometry",
          "no physical capture/input, paired reference pixels, real macOS fullscreen, Linux/macOS native window proof or signature/install"] }, null, 2));
      process.stdout.write("Remote desktop viewer Electron lifecycle smoke passed (20 checks).\n");
      app.removeListener("browser-window-created", observeFocus);
      quitting = true; manager.dispose(); source.destroy(); server.close(); clearTimeout(deadline); app.exit(0);
      return;
    }
    stage = "actual size from fullscreen";
    const fullscreenViewer = viewer;
    let fullscreenEntered = process.platform !== "darwin";
    const enteredFullscreen = () => { fullscreenEntered = true; };
    fullscreenViewer.once("enter-full-screen", enteredFullscreen);
    try {
      await interact(`document.querySelector('.remote-viewer-toolbar button[aria-label="Full screen"]').click()`);
      // macOS reports its fullscreen flag before the native transition and a
      // resulting renderer readiness/control update have finished.
      await until(async () => viewer === fullscreenViewer && fullscreenEntered && viewer.isFullScreen()
        && viewer.webContents.executeJavaScript(`(() => {
          const button=[...document.querySelectorAll('.remote-viewer-toolbar button')].find(item=>item.textContent==='Actual size');
          return button && !button.disabled && document.querySelector('.remote-viewer-heading')?.textContent.includes('Connected');
        })()`));
    } finally { fullscreenViewer.removeListener("enter-full-screen", enteredFullscreen); }
    await interact(`(() => {
      const button=[...document.querySelectorAll('.remote-viewer-toolbar button')].find(item=>item.textContent==='Actual size');
      if(!button || button.disabled) throw new Error('Actual size is unavailable.'); button.click();
    })()`);
    await until(async () => {
      if (viewer.isFullScreen() || viewer.isMaximized()) return false;
      const bounds = viewer.getBounds(), display = screen.getDisplayMatching(bounds), area = display.workArea;
      // Windows round-trips fractional physical-pixel edges through integer DIP bounds.
      const tolerance = process.platform === "win32" && display.scaleFactor !== 1 ? 1 : 0;
      return Math.abs(bounds.width - area.width) <= tolerance && Math.abs(bounds.height - area.height) <= tolerance &&
        Math.abs(bounds.x - area.x) <= tolerance && Math.abs(bounds.y - area.y) <= tolerance;
    });
    const resizedBounds = viewer.getBounds();
    writeFileSync(resolve(output, "viewer-actual-size.png"), (await captureViewport(viewer)).toPNG());
    if (!await viewer.webContents.executeJavaScript(`([...document.querySelectorAll('.remote-viewer-toolbar button')].find(item=>item.textContent==='Actual size'))?.getAttribute('aria-pressed')==='true'`)) {
      throw new Error("Actual size was not adopted by the viewer.");
    }
    stage = "audio preference persistence";
    await interact(`document.querySelector('.remote-viewer-toolbar button[aria-label="Display settings"]').click()`);
    await until(async () => viewer.webContents.executeJavaScript(`(() => {
      const input=document.querySelector('.remote-viewer-check input'); return input?.checked===true && !input.disabled;
    })()`));
    await interact(`document.querySelector('.remote-viewer-check input').click()`);
    await until(async () => viewer.webContents.executeJavaScript(`(async()=>{
      const input=document.querySelector('.remote-viewer-check input');
      return input?.checked===false && !input.disabled && (await window.jokoRemoteDesktopViewer.state()).audio===false;
    })()`));
    const diskPreferences = createDesktopRemoteDesktopViewerPreferencesStore(preferencePath);
    await diskPreferences.initialize();
    if (diskPreferences.get(owner, peer.targetDeviceId).audio !== false) throw new Error("Saved audio preference was not readable from disk.");
    stage = "host mute control after native resize";
    // Fullscreen restoration may retire control when native focus is released.
    viewer.focus();
    await until(async () => viewer.isFocused() && viewer.webContents.executeJavaScript(`(() => {
      const button=document.querySelector('.remote-viewer-toolbar .button');
      return button && !button.disabled && button.getAttribute('aria-pressed')===${JSON.stringify(String(control))};
    })()`));
    await interact(`(() => {
      const button=document.querySelector('.remote-viewer-toolbar .button');
      if(button?.getAttribute('aria-pressed')==='false' && !button.disabled) button.click();
    })()`);
    await until(async () => control && viewer.webContents.executeJavaScript(`(() => {
      const button=document.querySelector('.remote-viewer-toolbar .button');
      const input=[...document.querySelectorAll('.remote-viewer-check')].find(item=>item.textContent.includes('Mute host speakers'))?.querySelector('input');
      return button?.getAttribute('aria-pressed')==='true' && input && !input.disabled;
    })()`));
    stage = "host mute default and failure";
    await interact(`(() => {
      const input=[...document.querySelectorAll('.remote-viewer-check')].find(item=>item.textContent.includes('Mute host speakers'))?.querySelector('input');
      if(!input || input.checked || input.disabled) throw new Error('Host mute default is unavailable.'); input.click();
    })()`);
    await until(async () => viewer.webContents.executeJavaScript(`(async()=>{
      const input=[...document.querySelectorAll('.remote-viewer-check')].find(item=>item.textContent.includes('Mute host speakers'))?.querySelector('input');
      return input?.checked===true && !input.disabled && (await window.jokoRemoteDesktopViewer.state()).hostMute===true &&
        document.querySelector('.remote-viewer-panel')?.textContent.includes('could not be confirmed') &&
        document.querySelector('.remote-viewer-heading')?.textContent.includes('Connected');
    })()`));
    if (hostMute || muteRequests !== 1) throw new Error("Failed host mute was adopted or automatically retried.");
    stage = "host mute explicit retry";
    await interact(`([...document.querySelectorAll('.remote-viewer-panel button')].find(item=>item.textContent==='Retry')).click()`);
    await until(async () => hostMute && viewer.webContents.executeJavaScript(`document.querySelector('.remote-viewer-panel')?.textContent.includes('Host speakers are muted for this connection.')`));
    if (muteRequests !== 2) throw new Error("Host mute did not use one explicit retry.");
    const savedMute = createDesktopRemoteDesktopViewerPreferencesStore(preferencePath); await savedMute.initialize();
    if (!savedMute.get(owner, peer.targetDeviceId).hostMute) throw new Error("Saved host mute intent was not readable from disk.");
    stage = "privacy default and typed failure";
    await until(async () => control && viewer.webContents.executeJavaScript(`(() => {
      const input=[...document.querySelectorAll('.remote-viewer-check')].find(item=>item.textContent.includes('Privacy screen'))?.querySelector('input');
      return input && !input.checked && !input.disabled;
    })()`));
    await interact(`(() => {
      const input=[...document.querySelectorAll('.remote-viewer-check')].find(item=>item.textContent.includes('Privacy screen'))?.querySelector('input');
      input.scrollIntoView({block:'nearest'}); input.click();
    })()`);
    await until(async () => viewer.webContents.executeJavaScript(`(async()=> {
      const state=await window.jokoRemoteDesktopViewer.state();
      return state.privacyScreen && document.querySelector('.remote-viewer-panel')?.textContent.includes('Privacy screen could not be confirmed.') &&
        document.querySelector('.remote-viewer-heading')?.textContent.includes('Connected');
    })()`));
    const failedPrivacyRequests = privacyRequests;
    await new Promise(accept => setTimeout(accept, 3100));
    if (privacyScreen || privacyRequests !== failedPrivacyRequests) throw new Error("Privacy failure was adopted or retried by heartbeat.");
    writeFileSync(resolve(output, "viewer-privacy-failure.png"), (await captureViewport(viewer)).toPNG());
    const savedPrivacy = createDesktopRemoteDesktopViewerPreferencesStore(preferencePath); await savedPrivacy.initialize();
    if (!savedPrivacy.get(owner, peer.targetDeviceId).privacyScreen) throw new Error("Saved privacy intent was not readable from disk.");
    stage = "privacy explicit retry";
    await interact(`([...document.querySelectorAll('.remote-viewer-panel button')].find(item=>item.textContent==='Retry')).click()`);
    await until(async () => privacyScreen && viewer.webContents.executeJavaScript(`document.querySelector('.remote-viewer-panel')?.textContent.includes('The host screens are private for this connection.')`));
    if (privacyRequests !== failedPrivacyRequests + 1) throw new Error("Privacy retry did not produce one confirmed effect.");
    stage = "privacy saved lock dependency";
    await interact(`([...document.querySelectorAll('.remote-viewer-check')].find(item=>item.textContent.includes('Lock host on disconnect'))?.querySelector('input')).click()`);
    await until(async () => privacyScreen && privacyLockOnExit);
    await focusInteraction();
    await until(async () => viewer.webContents.executeJavaScript(`(()=> {
      const input=[...document.querySelectorAll('.remote-viewer-check')].find(item=>item.textContent.includes('Lock host on disconnect'))?.querySelector('input');
      if(!input || input.disabled || !input.checked) return false; input.click(); return true;
    })()`));
    await until(async () => privacyScreen && !privacyLockOnExit);
    stage = "clipboard sync default and permission";
    await until(async () => control && viewer.webContents.executeJavaScript(`(() => {
      const button=document.querySelector('.remote-viewer-toolbar .button');
      const input=[...document.querySelectorAll('.remote-viewer-check')].find(item=>item.textContent.includes('Sync clipboard'))?.querySelector('input');
      return button?.getAttribute('aria-pressed')==='true' && input && !input.disabled;
    })()`));
    await interact(`(() => {
      const button=document.querySelector('.remote-viewer-toolbar .button');
      const input=[...document.querySelectorAll('.remote-viewer-check')].find(item=>item.textContent.includes('Sync clipboard'))?.querySelector('input');
      if(button?.getAttribute('aria-pressed')!=='true' || !input || input.checked || input.disabled) throw new Error('Clipboard sync default is unavailable.'); input.scrollIntoView({block:'nearest'}); input.click();
    })()`);
    await until(async () => viewer.webContents.executeJavaScript(`(async()=> {
      const state=await window.jokoRemoteDesktopViewer.state();
      return state.clipboardSync && state.clipboardSyncState.notice==='permission' && !state.clipboardSyncState.pending &&
        document.querySelector('.remote-viewer-panel')?.textContent.includes('Clipboard access was denied.') &&
        document.querySelector('.remote-viewer-heading')?.textContent.includes('Connected');
    })()`));
    if (clipboardCopies || clipboardRemoteWrites || clipboardLocalWrites) throw new Error("Unconfirmed clipboard permission caused an effect.");
    await interact(`document.querySelector('.remote-viewer-panel').scrollTop=document.querySelector('.remote-viewer-panel').scrollHeight`);
    writeFileSync(resolve(output, "viewer-clipboard-permission.png"), (await captureViewport(viewer)).toPNG());
    stage = "clipboard sync explicit retry and baseline";
    await interact(`([...document.querySelectorAll('.remote-viewer-panel button')].find(item=>item.textContent==='Retry')).click()`);
    await until(async () => clipboardCopies > 0 && viewer.webContents.executeJavaScript(`(async()=> {
      const state=await window.jokoRemoteDesktopViewer.state(); return state.clipboardSyncState.active && !state.clipboardSyncState.pending &&
        document.querySelector('.remote-viewer-panel')?.textContent.includes('Clipboard sync is active');
    })()`));
    if (clipboardRemoteWrites || clipboardLocalWrites) throw new Error("Clipboard baseline overwrote existing contents.");
    const savedSync = createDesktopRemoteDesktopViewerPreferencesStore(preferencePath); await savedSync.initialize();
    if (!savedSync.get(owner, peer.targetDeviceId).clipboardSync) throw new Error("Clipboard sync intent was not readable from disk.");
    stage = "bidirectional clipboard sync";
    localClipboard = JSON.stringify({ text: "synthetic controller change" }); localClipboardVersion++;
    await until(async () => clipboardRemoteWrites === 1 && remoteClipboard === localClipboard);
    await until(async () => !(await viewer.webContents.executeJavaScript("window.jokoRemoteDesktopViewer.state()")).clipboardSyncState.pending);
    remoteClipboard = JSON.stringify({ text: "synthetic host change" }); clipboardVersion++;
    await until(async () => clipboardLocalWrites === 1 && localClipboard === remoteClipboard);
    stage = "clipboard sync off";
    await focusInteraction();
    await until(async () => viewer.webContents.executeJavaScript(`(()=> {
      const input=[...document.querySelectorAll('.remote-viewer-check')].find(item=>item.textContent.includes('Sync clipboard'))?.querySelector('input');
      if(!input || input.disabled || !input.checked) return false; input.click(); return true;
    })()`));
    await until(async () => !clipboardSync && !(await viewer.webContents.executeJavaScript("window.jokoRemoteDesktopViewer.state()")).clipboardSync);
    localClipboard = JSON.stringify({ text: "synthetic disabled controller change" }); localClipboardVersion++;
    await new Promise((accept) => setTimeout(accept, 1700));
    if (clipboardLocalWrites !== 1 || clipboardRemoteWrites !== 1) throw new Error("Clipboard sync continued after disabling or echoed a write.");
    stage = "clipboard sync saved reopen intent";
    await focusInteraction();
    await until(async () => viewer.webContents.executeJavaScript(`(() => {
      const input=[...document.querySelectorAll('.remote-viewer-check')].find(item=>item.textContent.includes('Sync clipboard'))?.querySelector('input');
      if(!input || input.disabled || input.checked) return false; input.click(); return true;
    })()`));
    await until(async () => clipboardSync && (await viewer.webContents.executeJavaScript("window.jokoRemoteDesktopViewer.state()")).clipboardSyncState.active);
    stage = "lock on exit view-only preference";
    await interact(`document.querySelector('.remote-viewer-toolbar .button').click()`);
    await until(async () => !control && viewer.webContents.executeJavaScript(`document.querySelector('.remote-viewer-toolbar .button')?.getAttribute('aria-pressed')==='false'`));
    await interact(`(() => {
      const input=[...document.querySelectorAll('.remote-viewer-check')].find(item=>item.textContent.includes('Lock host on disconnect'))?.querySelector('input');
      if(!input || input.checked || input.disabled) throw new Error('Lock on exit default is unavailable.'); input.click();
    })()`);
    await until(async () => viewer.webContents.executeJavaScript(`(async()=>{
      const input=[...document.querySelectorAll('.remote-viewer-check')].find(item=>item.textContent.includes('Lock host on disconnect'))?.querySelector('input');
      return input?.checked===true && !input.disabled && (await window.jokoRemoteDesktopViewer.state()).lockOnExit===true;
    })()`));
    const savedExit = createDesktopRemoteDesktopViewerPreferencesStore(preferencePath); await savedExit.initialize();
    if (!savedExit.get(owner, peer.targetDeviceId).lockOnExit || lockRequests !== 0) throw new Error("Exit preference was not saved without effect.");
    writeFileSync(resolve(output, "viewer-preferences.png"), (await captureViewport(viewer)).toPNG());
    stage = "explicit lock exit failure";
    const stopsBeforeClose = stops;
    await interact(`document.querySelector('.remote-viewer-toolbar button[aria-label="Disconnect"]').click()`);
    await until(async () => viewer.webContents.executeJavaScript(`document.querySelector('.remote-viewer-close-dialog')?.open===true &&
      [...document.querySelectorAll('.remote-viewer-close-dialog button')].some(item=>item.textContent==='Disconnect' && !item.disabled)`));
    await interact(`([...document.querySelectorAll('.remote-viewer-close-dialog button')].find(item=>item.textContent==='Disconnect')).click()`);
    await until(async () => viewer.webContents.executeJavaScript(`document.querySelector('.remote-viewer-close-dialog')?.textContent.includes('Locking and disconnecting could not be confirmed.')`));
    if (viewer.isDestroyed() || locked || lockRequests !== 1) throw new Error("Failed lock exit was adopted or retried.");
    writeFileSync(resolve(output, "viewer-exit-failure.png"), (await captureViewport(viewer)).toPNG());
    stage = "explicit lock exit retry";
    await interact(`([...document.querySelectorAll('.remote-viewer-close-dialog button')].find(item=>item.textContent==='Retry disconnect')).click()`);
    await until(async () => expiredLockReplies === 1 && viewer.webContents.executeJavaScript(`document.querySelector('.remote-viewer-close-dialog')?.textContent.includes('Locking and disconnecting could not be confirmed.')`));
    if (viewer.isDestroyed() || locked || locks !== 0 || lockRequests !== 1 || lockCalls !== 2) throw new Error("Expired exit retried the lock effect or produced a false acknowledgement.");
    stage = "explicit recovery to a fresh lease";
    const startsBeforeRecovery = starts;
    await interact(`([...document.querySelectorAll('.remote-viewer-close-dialog button')].find(item=>item.textContent==='Cancel')).click()`);
    await interact(`([...document.querySelectorAll('.remote-viewer-connection button')].find(item=>item.textContent==='Reconnect')).click()`);
    await until(async () => starts > startsBeforeRecovery && viewer.webContents.executeJavaScript(`document.querySelector('#image')?.naturalWidth===160 && document.querySelector('.remote-viewer-heading')?.textContent.includes('Connected')`));
    stage = "normal memory bounds before successful lock exit";
    // Actual size already proved the fullscreen exit and work-area clamp above.
    // Test cached window geometry separately from a WM remapping a window that
    // fills its whole work area (including its native frame constraints).
    const memoryWindow = viewer, memoryArea = screen.getDisplayMatching(viewer.getBounds()).workArea;
    const [minimumWidth, minimumHeight] = memoryWindow.getMinimumSize();
    const memoryWidth = Math.min(memoryArea.width, Math.max(minimumWidth, Math.min(900, memoryArea.width - 64)));
    const memoryHeight = Math.min(memoryArea.height, Math.max(minimumHeight, Math.min(620, memoryArea.height - 64)));
    const requestedMemoryBounds = { x: memoryArea.x + Math.floor((memoryArea.width - memoryWidth) / 2),
      y: memoryArea.y + Math.floor((memoryArea.height - memoryHeight) / 2), width: memoryWidth, height: memoryHeight };
    let geometryRevision = 0;
    const geometryChanged = () => { geometryRevision++; };
    memoryWindow.on("move", geometryChanged); memoryWindow.on("resize", geometryChanged);
    try {
      memoryWindow.setBounds(requestedMemoryBounds);
      await until(async () => {
        if (["x", "y", "width", "height"].some(field => memoryWindow.getBounds()[field] !== requestedMemoryBounds[field])) return false;
        const revision = geometryRevision;
        await memoryWindow.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
        return revision === geometryRevision &&
          ["x", "y", "width", "height"].every(field => memoryWindow.getBounds()[field] === requestedMemoryBounds[field]);
      });
    } finally {
      memoryWindow.removeListener("move", geometryChanged); memoryWindow.removeListener("resize", geometryChanged);
    }
    stage = "explicit lock exit on fresh lease";
    const cachedViewer = viewer, cachedBounds = viewer.getBounds(), closingLeaseId = activeLeaseId;
    const closingGeneration = (await viewer.webContents.executeJavaScript("window.jokoRemoteDesktopViewer.state()")).generation;
    await interact(`document.querySelector('.remote-viewer-toolbar button[aria-label="Disconnect"]').click()`);
    await focusInteraction();
    await until(async () => viewer.webContents.executeJavaScript(`(()=> {
      const button=[...document.querySelectorAll('.remote-viewer-close-dialog button')].find(item=>item.textContent==='Disconnect');
      if(!document.querySelector('.remote-viewer-close-dialog')?.open || !button || button.disabled) return false;
      let delivered=false; button.addEventListener('click',()=>{delivered=true},{once:true}); button.click();
      return delivered;
    })()`));
    await until(async () => !viewer.isDestroyed() && !viewer.isVisible() && !activeLeaseId && stops > stopsBeforeClose);
    if (hostMute || !locked || locks !== 1 || lockRequests !== 2 || lockCalls !== 3) throw new Error("Fresh lease lock exit was not confirmed.");
    const closedScope = await viewer.webContents.executeJavaScript("window.jokoRemoteDesktopViewer.state()");
    if (closedScope.active || closedScope.generation <= closingGeneration) {
      throw new Error("Confirmed close did not retire authority while retaining its hidden window.");
    }
    await windowInventory(viewer);
    const retiredCloseRequest = await viewer.webContents.executeJavaScript(`window.jokoRemoteDesktopViewer.request(${closingGeneration},'getRemoteDesktopFrame',new Uint8Array()).then(()=>false,()=>true)`);
    if (!retiredCloseRequest) throw new Error("The hidden cached window accepted its closed generation.");
    stage = "same target preference restore";
    const startsBeforeReopen = starts;
    const reopened = await sourceCall(C.open, owner, { deviceId: peer.targetDeviceId, name: "Synthetic desktop" });
    viewer = await boundViewer();
    if (!viewer || viewer !== cachedViewer || !reopened.focusedExisting) throw new Error("Confirmed close did not reuse the same target window.");
    await until(async () => starts === startsBeforeReopen + 1 && viewer.webContents.executeJavaScript(`document.querySelector('#image')?.naturalWidth===160 && document.querySelector('.remote-viewer-heading')?.textContent.includes('Connected')`));
    const reopenedBounds = viewer.getBounds(), reopenedScope = await viewer.webContents.executeJavaScript("window.jokoRemoteDesktopViewer.state()");
    cachedWindowEvidence = { windowId: viewer.id, sameBrowserWindow: true, cachedBounds, reopenedBounds,
      closingLeaseId, reopenedLeaseId: activeLeaseId, closingGeneration, closedGeneration: closedScope.generation,
      reopenedGeneration: reopenedScope.generation, retiredGenerationRejected: true };
    if (!viewer.isVisible() || !activeLeaseId || activeLeaseId === closingLeaseId || reopenedScope.generation < closedScope.generation ||
      ["x", "y", "width", "height"].some(field => reopenedBounds[field] !== cachedBounds[field])) {
      throw new Error("Cached target reopen did not preserve memory bounds and establish a fresh lease.");
    }
    writeFileSync(resolve(output, "viewer-cached-reopen.png"), (await captureViewport(viewer)).toPNG());
    stage = "reopened viewer control";
    // A new native window may receive focus after its fast synthetic start ACK.
    // Request control explicitly before expecting control-scoped saved effects.
    await focusInteraction();
    await until(async () => viewer.webContents.executeJavaScript(`(()=> {
      const button=document.querySelector('.remote-viewer-toolbar .button');
      if(!button || button.disabled) return false;
      if(button.getAttribute('aria-pressed')==='false') button.click();
      return true;
    })()`));
    await until(async () => control && viewer.webContents.executeJavaScript(`document.querySelector('.remote-viewer-toolbar .button')?.getAttribute('aria-pressed')==='true'`));
    stage = "reopened viewer audio intent";
    await interact(`document.querySelector('.remote-viewer-toolbar button[aria-label="Display settings"]').click()`);
    await until(async () => viewer.webContents.executeJavaScript(`(async()=>{
      const input=document.querySelector('.remote-viewer-check input');
      return input?.checked===false && !input.disabled && (await window.jokoRemoteDesktopViewer.state()).audio===false;
    })()`));
    stage = "reopened viewer mute intent";
    await until(async () => hostMute && viewer.webContents.executeJavaScript(`document.querySelector('.remote-viewer-panel')?.textContent.includes('Host speakers are muted for this connection.')`));
    if (!await viewer.webContents.executeJavaScript(`[...document.querySelectorAll('.remote-viewer-check')].find(item=>item.textContent.includes('Lock host on disconnect'))?.querySelector('input')?.checked===true`)) throw new Error("Exit intent did not restore on reopen.");
    stage = "reopened viewer sync intent";
    await until(async () => viewer.webContents.executeJavaScript(`(async()=> {
      const state=await window.jokoRemoteDesktopViewer.state(); return state.clipboardSync && state.clipboardSyncState.active &&
        [...document.querySelectorAll('.remote-viewer-check')].find(item=>item.textContent.includes('Sync clipboard'))?.querySelector('input')?.checked;
    })()`));
    stage = "reopened viewer privacy intent";
    await until(async () => privacyScreen && privacyLockOnExit && viewer.webContents.executeJavaScript(`(async()=> {
      const state=await window.jokoRemoteDesktopViewer.state(); return state.privacyScreen &&
        [...document.querySelectorAll('.remote-viewer-check')].find(item=>item.textContent.includes('Privacy screen'))?.querySelector('input')?.checked &&
        document.querySelector('.remote-viewer-panel')?.textContent.includes('The host screens are private for this connection.');
    })()`));
    stage = "native credentials default and view-only setup";
    await interact(`document.querySelector('.remote-viewer-toolbar .button').click()`);
    await until(async () => !control && viewer.webContents.executeJavaScript(`(()=> {
      const input=[...document.querySelectorAll('.remote-viewer-check')].find(item=>item.textContent.includes('Auto unlock'))?.querySelector('input');
      return input && !input.checked && !input.disabled;
    })()`));
    if (credentialPasswords || credentialBegins) throw new Error("Native password prompt occurred before explicit enable.");
    await interact(`(()=> {
      const input=[...document.querySelectorAll('.remote-viewer-check')].find(item=>item.textContent.includes('Auto unlock'))?.querySelector('input');
      input.scrollIntoView({block:'nearest'}); input.click();
    })()`);
    await until(async () => credentialBegins === 1 && viewer.webContents.executeJavaScript(`document.querySelector('.remote-viewer-panel')?.textContent.includes('Native unlock is unavailable.')`));
    if (credentialPasswords || credentialSaved) throw new Error("Failed native setup was adopted or retried.");
    writeFileSync(resolve(output, "viewer-credential-failure.png"), (await captureViewport(viewer)).toPNG());
    stage = "explicit native credential retry and fresh lease";
    const startsBeforeCredential = starts;
    await interact(`[...document.querySelectorAll('.remote-viewer-panel [role="alert"]')].find(item=>item.textContent.includes('Native unlock is unavailable.'))?.querySelector('button').click()`);
    await until(async () => credentialSaved && credentialEnds === 1 && starts > startsBeforeCredential && viewer.webContents.executeJavaScript(`(()=> {
      const input=[...document.querySelectorAll('.remote-viewer-check')].find(item=>item.textContent.includes('Auto unlock'))?.querySelector('input');
      return input?.checked && !input.disabled && document.querySelector('#image')?.naturalWidth===160;
    })()`));
    if (credentialPasswords !== 1 || credentialReceipts) throw new Error("Native setup prompted more than once.");
    stage = "native biometric confirmed setting";
    await focusInteraction();
    await until(async () => viewer.webContents.executeJavaScript(`(()=> {
      const input=[...document.querySelectorAll('.remote-viewer-check')].find(item=>item.textContent.includes('Biometric verification'))?.querySelector('input');
      if(!input || input.disabled || !input.checked) return false; input.click(); return true;
    })()`));
    await until(async () => !credentialBiometric && viewer.webContents.executeJavaScript(`[...document.querySelectorAll('.remote-viewer-check')].find(item=>item.textContent.includes('Biometric verification'))?.querySelector('input')?.checked===false`));
    writeFileSync(resolve(output, "viewer-credential-settings.png"), (await captureViewport(viewer)).toPNG());
    stage = "native saved intent on new window and lost password receipt";
    viewer.destroy(); await until(async () => activeLeaseId === "");
    credentialLocked = true; credentialDropAck = true;
    const beforeNativeReopen = starts;
    await sourceCall(C.open, owner, { deviceId: peer.targetDeviceId, name: "Synthetic desktop" });
    viewer = await boundViewer();
    if (!viewer) throw new Error("Native credential reopen missing.");
    await until(async () => credentialPasswords === 2 && credentialReceipts === 1 && credentialEnds === 2 && starts >= beforeNativeReopen + 2 && viewer.webContents.executeJavaScript(`document.querySelector('.remote-viewer-heading')?.textContent.includes('Connected')`));
    await interact(`document.querySelector('.remote-viewer-toolbar button[aria-label="Display settings"]').click()`);
    await until(async () => viewer.webContents.executeJavaScript(`(()=> {
      const input=[...document.querySelectorAll('.remote-viewer-check')].find(item=>item.textContent.includes('Auto unlock'))?.querySelector('input');
      return input?.checked && !input.disabled;
    })()`));
    stage = "native saved setting disable";
    await interact(`[...document.querySelectorAll('.remote-viewer-check')].find(item=>item.textContent.includes('Auto unlock'))?.querySelector('input').click()`);
    await until(async () => !credentialSaved && viewer.webContents.executeJavaScript(`[...document.querySelectorAll('.remote-viewer-check')].find(item=>item.textContent.includes('Auto unlock'))?.querySelector('input')?.checked===false`));
    const selectMode = async (modeId) => {
      await interact(`(()=> {
        if(!document.querySelector('.remote-viewer-panel[aria-label="Display settings"]'))
          document.querySelector('.remote-viewer-toolbar button[aria-label="Display settings"]').click();
      })()`);
      await until(async () => control && viewer.webContents.executeJavaScript(`(()=> {
        const select=document.querySelector('select[aria-label="Resolution"]');
        return select && !select.disabled && [...select.options].some(option=>option.value===${JSON.stringify(modeId)});
      })()`));
      await interact(`(()=> {
        const select=document.querySelector('select[aria-label="Resolution"]'); select.value=${JSON.stringify(modeId)};
        select.dispatchEvent(new Event('change',{bubbles:true}));
      })()`);
    };
    const usableMode = async (modeId, width, height) => control && viewer.webContents.executeJavaScript(`(()=> {
      const select=document.querySelector('select[aria-label="Resolution"]'),image=document.querySelector('#image');
      const renderedWidth=parseFloat(image?.style.width),renderedHeight=parseFloat(image?.style.height);
      return select?.value===${JSON.stringify(modeId)} && !select.disabled && image?.naturalWidth===160 &&
        Math.abs(renderedWidth/renderedHeight-${width}/${height})<0.001 &&
        document.querySelector('.remote-viewer-heading')?.textContent.includes('Connected');
    })()`);
    stage = "temporary mode same lease and actual geometry";
    const modeLeaseId = activeLeaseId, startsBeforeMode = starts, generationBeforeMode = controlGeneration;
    await selectMode("20"); await until(async () => modeRequests === 1 && await usableMode("20", 1000, 700));
    if (activeLeaseId !== modeLeaseId || starts !== startsBeforeMode || controlGeneration <= generationBeforeMode || originalMode?.modeId !== "10") throw new Error("Temporary mode replaced its captured lease or original mode.");
    await interact(`document.querySelector('.remote-viewer-panel').scrollTop=document.querySelector('.remote-viewer-panel').scrollHeight`);
    writeFileSync(resolve(output, "viewer-temporary-mode.png"), (await captureViewport(viewer)).toPNG());
    stage = "continuous temporary mode preserves first original";
    await selectMode("30"); await until(async () => modeRequests === 2 && await usableMode("30", 800, 600));
    if (activeLeaseId !== modeLeaseId || starts !== startsBeforeMode || originalMode?.modeId !== "10") throw new Error("Continuous temporary mode overwrote its original capture.");
    stage = "temporary mode effect and unconfirmed restore";
    failNextMode = true; await selectMode("20");
    await until(async () => modeRequests === 3 && viewer.webContents.executeJavaScript(`document.querySelector('.remote-viewer-panel')?.textContent.includes('The original resolution could not be restored.') &&
      [...document.querySelectorAll('.remote-viewer-connection button')].some(button=>button.textContent==='Retry' && !button.disabled)`));
    if (starts !== startsBeforeMode || activeLeaseId || !originalMode || control) throw new Error("Unconfirmed restore admitted a replacement or control.");
    await interact(`document.querySelector('.remote-viewer-panel').scrollTop=document.querySelector('.remote-viewer-panel').scrollHeight`);
    writeFileSync(resolve(output, "viewer-mode-restore-failure.png"), (await captureViewport(viewer)).toPNG());
    stage = "explicit mode recovery waits for original restore";
    await interact(`[...document.querySelectorAll('.remote-viewer-connection button')].find(button=>button.textContent==='Retry').click()`);
    await until(async () => modeRestoreRefusals === 1 && viewer.webContents.executeJavaScript(`document.querySelector('.remote-viewer-connection button')?.textContent==='Retry' &&
      document.querySelector('.remote-viewer-panel')?.textContent.includes('The original resolution could not be restored.')`));
    if (starts !== startsBeforeMode || modeRequests !== 3 || !originalMode || activeLeaseId) throw new Error("Failed original restoration started or replayed a mode.");
    stage = "second explicit Retry confirms original-mode recovery";
    await interact(`document.querySelector('.remote-viewer-connection button').click()`);
    await until(async () => starts === startsBeforeMode + 1 && modeRestores === 1 && await usableMode("10", workArea.width + 256, workArea.height + 256));
    if (originalMode || modeRequests !== 3 || display.width !== workArea.width + 256) throw new Error("Explicit recovery did not restore the captured mode before NEW.");
    stage = "temporary mode before hidden retirement";
    await selectMode("20"); await until(async () => modeRequests === 4 && await usableMode("20", 1000, 700));
    const activeBoundary = await viewer.webContents.executeJavaScript("window.jokoRemoteDesktopViewer.state()");
    const generation = activeBoundary.generation;
    stage = "hidden retirement"; viewer.hide();
    await until(async () => !(await viewer.webContents.executeJavaScript("window.jokoRemoteDesktopViewer.state()")).active && modeRestores === 2 && currentMode === "10" && !originalMode);
    const stale = await viewer.webContents.executeJavaScript(`window.jokoRemoteDesktopViewer.request(${generation},'getRemoteDesktopFrame',new Uint8Array()).then(()=>false,()=>true)`);
    if (!stale) throw new Error("Retired generation remained active.");
    stage = "foreground reconnect";
    const startsBeforeReconnect = starts; viewer.show(); viewer.focus();
    await until(async () => starts > startsBeforeReconnect && viewer.webContents.executeJavaScript(`document.querySelector('.remote-viewer-heading')?.textContent.includes('Connected')`));
    stage = "temporary mode before source retirement";
    await selectMode("30"); await until(async () => modeRequests === 5 && await usableMode("30", 800, 600));
    const screenshot = await captureViewport(viewer);
    writeFileSync(resolve(output, "viewer.png"), screenshot.toPNG());
    stage = "source retirement"; await sourceCall(C.retire, owner);
    await until(async () => viewer.isDestroyed() && stops >= 1 && modeRestores === 3 && currentMode === "10" && !originalMode);
    if (lockRequests !== 2 || locks !== 1 || lockCalls !== 3) throw new Error("Ordinary retirement locked the host.");

    const openLinux = async (flavor) => {
      fixtureFlavor = flavor;
      await sourceCall(C.bind, owner);
      await sourceCall(C.open, owner, { deviceId: peer.targetDeviceId, name: "Synthetic Linux desktop" });
      viewer = await boundViewer();
      if (!viewer) throw new Error("Linux viewer was not created.");
      viewer.show(); viewer.focus();
    };
    const retireLinux = async () => {
      await sourceCall(C.retire, owner);
      await until(() => viewer.isDestroyed() && !activeLeaseId && !control);
    };
    const headingIncludes = (text) => viewer.webContents.executeJavaScript(`document.querySelector('.remote-viewer-heading')?.textContent.includes(${JSON.stringify(text)})`);
    const pendingHeading = "Waiting for screen sharing approval on the host";

    stage = "Linux native capabilities, cursor and confirmed control";
    await openLinux("linux-native");
    await until(async () => control && await headingIncludes("Connected") && viewer.webContents.executeJavaScript(`document.querySelector('#cursor-image')?.naturalWidth===8`));
    const nativeInputBefore = inputAcks;
    await interact(`document.querySelector('button[aria-label="All windows"]').click()`);
    await until(() => inputAcks > nativeInputBefore);
    writeFileSync(resolve(output, "viewer-linux-native.png"), (await captureViewport(viewer)).toPNG());
    await retireLinux();

    stage = "portal awaits local screen sharing approval";
    await openLinux("linux-portal");
    await until(async () => portalPickers === 1 && portalOffers >= 1 && portalFrames >= 1 && await headingIncludes(pendingHeading));
    const approvalLeaseId = activeLeaseId, portalStartsBeforeApproval = starts;
    if (control || starts !== portalStartsBeforeApproval || await viewer.webContents.executeJavaScript(`!![...document.querySelectorAll('.remote-viewer-connection button')].find(button=>button.textContent==='Retry')`)) {
      throw new Error("Pending portal capture consumed its lease or presented a reconnect action.");
    }
    writeFileSync(resolve(output, "viewer-portal-capture-pending.png"), (await captureViewport(viewer)).toPNG());
    const heartbeatBeforeApproval = portalHeartbeats;
    await until(() => portalHeartbeats > heartbeatBeforeApproval);

    stage = "portal approval presents same-lease view-only pixels";
    portalConsent = "granted";
    await until(async () => await headingIncludes("Connected") && viewer.webContents.executeJavaScript(`document.querySelector('#image')?.naturalWidth===160 &&
      document.querySelector('.remote-viewer-toolbar .button')?.textContent==='View only' && document.querySelector('.remote-viewer-toolbar .button')?.disabled`));
    if (activeLeaseId !== approvalLeaseId || starts !== portalStartsBeforeApproval || portalPickers !== 1 || control) {
      throw new Error("Portal approval replaced its lease, repeated the picker or admitted control.");
    }
    writeFileSync(resolve(output, "viewer-portal-approved.png"), (await captureViewport(viewer)).toPNG());
    await retireLinux();

    stage = "portal denial is terminal without a repeated picker";
    await openLinux("linux-portal");
    await until(async () => portalPickers === 2 && await headingIncludes(pendingHeading));
    const deniedStarts = starts, deniedLeaseId = activeLeaseId;
    portalConsent = "denied";
    await until(async () => await headingIncludes("Connection interrupted") && viewer.webContents.executeJavaScript(`document.querySelector('.remote-viewer-connection')?.textContent.includes('Screen or input permission is required on the host.')`));
    writeFileSync(resolve(output, "viewer-portal-denied.png"), (await captureViewport(viewer)).toPNG());
    await new Promise(resolveDelay => setTimeout(resolveDelay, 1000));
    if (portalPickers !== 2 || starts !== deniedStarts || activeLeaseId !== deniedLeaseId || control) {
      throw new Error("Denied portal capture automatically opened a replacement or repeated its picker.");
    }
    await retireLinux();

    stage = "retired pending capture reply cannot reach replacement viewer";
    await openLinux("linux-portal");
    await until(async () => portalPickers === 3 && await headingIncludes(pendingHeading));
    deferPortalFrame = true;
    await until(() => deferredPortalFrame !== undefined);
    const retiredPortal = deferredPortalFrame;
    await retireLinux();
    await openLinux("linux-native");
    await until(async () => control && await headingIncludes("Connected"));
    const replacementLeaseId = activeLeaseId, replacementStarts = starts;
    retiredPortal.resolve({ peer, result: { frame: { jpeg } } }); portalLateFrames++;
    deferredPortalFrame = undefined;
    await viewer.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    if (retiredPortal.leaseId === activeLeaseId || activeLeaseId !== replacementLeaseId || starts !== replacementStarts || !control || !await headingIncludes("Connected")) {
      throw new Error("A retired capture reply changed the replacement viewer.");
    }
    await retireLinux();

    stage = "Linux clipboard explicit Copy and Paste use the injected system-only port";
    peer.targetDeviceId = "synthetic-linux-clipboard-host";
    localClipboard = JSON.stringify({ text: "synthetic Linux local baseline" }); localClipboardVersion++;
    remoteClipboard = JSON.stringify({ text: "synthetic Linux remote baseline" }); clipboardVersion++;
    await openLinux("linux-clipboard");
    await until(async () => control && await headingIncludes("Connected"));
    await interact(`document.querySelector('button[aria-label="Clipboard"]').click()`);
    const clipboardAction = async (label) => {
      await until(async () => viewer.webContents.executeJavaScript(`(()=> {
        const button=[...document.querySelectorAll('.remote-viewer-panel button')].find(button=>button.textContent===${JSON.stringify(label)});
        return button && !button.disabled;
      })()`));
      await interact(`[...document.querySelectorAll('.remote-viewer-panel button')].find(button=>button.textContent===${JSON.stringify(label)}).click()`);
    };
    await clipboardAction("Copy from remote");
    await until(() => linuxClipboardExplicitCopies === 1 && linuxClipboardLocalWriteCalls === 1 && localClipboard === remoteClipboard);
    localClipboard = JSON.stringify({ text: "synthetic Linux explicit paste" }); localClipboardVersion++;
    await clipboardAction("Paste to remote");
    await until(() => linuxClipboardExplicitPastes === 1 && remoteClipboard === localClipboard);
    writeFileSync(resolve(output, "viewer-linux-clipboard-explicit.png"), (await captureViewport(viewer)).toPNG());

    stage = "Linux clipboard sync defaults off and captures opaque baselines";
    await interact(`document.querySelector('button[aria-label="Display settings"]').click()`);
    const syncChecked = (desired) => viewer.webContents.executeJavaScript(`(()=> {
      const input=[...document.querySelectorAll('.remote-viewer-check')].find(item=>item.textContent.includes('Sync clipboard'))?.querySelector('input');
      return input && input.checked===${desired} && !input.disabled;
    })()`);
    const toggleSync = async (desired) => {
      await until(async () => await syncChecked(!desired));
      await interact(`(()=> {
        const input=[...document.querySelectorAll('.remote-viewer-check')].find(item=>item.textContent.includes('Sync clipboard')).querySelector('input');
        input.scrollIntoView({block:'nearest'}); input.click();
      })()`);
    };
    await until(async () => await syncChecked(false));
    const linuxWritesBeforeBaseline = clipboardLocalWrites + clipboardRemoteWrites;
    localClipboard = JSON.stringify({ text: "synthetic Linux local sync baseline" }); localClipboardVersion++;
    remoteClipboard = JSON.stringify({ text: "synthetic Linux remote sync baseline" }); clipboardVersion++;
    if (!/^[0-9a-f]{64}$/u.test(localClipboardToken()) || !/^[0-9a-f]{64}$/u.test(remoteClipboardToken())) throw new Error("Linux clipboard version was not an opaque fingerprint.");
    await toggleSync(true);
    await until(async () => {
      const state = await viewer.webContents.executeJavaScript("window.jokoRemoteDesktopViewer.state()");
      return state.clipboardSync && state.clipboardSyncState.active && !state.clipboardSyncState.pending;
    });
    if (clipboardLocalWrites + clipboardRemoteWrites !== linuxWritesBeforeBaseline) throw new Error("Linux baseline overwrote a system item.");
    const savedLinuxSync = createDesktopRemoteDesktopViewerPreferencesStore(preferencePath); await savedLinuxSync.initialize();
    if (!savedLinuxSync.get(owner, peer.targetDeviceId).clipboardSync) throw new Error("Linux sync intent was not saved.");

    stage = "Linux opaque versions sync both directions without echo";
    const linuxRemoteWritesBefore = clipboardRemoteWrites, linuxLocalWritesBefore = clipboardLocalWrites;
    localClipboard = JSON.stringify({ text: "synthetic Linux local sync change" }); localClipboardVersion++;
    await until(() => clipboardRemoteWrites === linuxRemoteWritesBefore + 1 && remoteClipboard === localClipboard);
    await until(async () => !(await viewer.webContents.executeJavaScript("window.jokoRemoteDesktopViewer.state()")).clipboardSyncState.pending);
    remoteClipboard = JSON.stringify({ text: "synthetic Linux remote sync change" }); clipboardVersion++;
    await until(() => clipboardLocalWrites === linuxLocalWritesBefore + 1 && localClipboard === remoteClipboard);
    await new Promise(resolveDelay => setTimeout(resolveDelay, 1700));
    if (clipboardRemoteWrites !== linuxRemoteWritesBefore + 1 || clipboardLocalWrites !== linuxLocalWritesBefore + 1) throw new Error("Linux clipboard sync echoed a write.");
    writeFileSync(resolve(output, "viewer-linux-clipboard-sync.png"), (await captureViewport(viewer)).toPNG());

    stage = "Linux unknown clipboard effect requires explicit new-baseline Retry";
    failLinuxClipboardWriteUnknown = true;
    remoteClipboard = JSON.stringify({ text: "synthetic Linux unconfirmed write" }); clipboardVersion++;
    await until(async () => viewer.webContents.executeJavaScript(`(async()=> {
      const state=await window.jokoRemoteDesktopViewer.state();
      return state.clipboardSyncState.notice==='unknown' && !state.clipboardSyncState.pending &&
        document.querySelector('.remote-viewer-panel')?.textContent.includes('The clipboard write could not be confirmed. Retry to establish a new baseline') &&
        !document.querySelector('.remote-viewer-panel')?.textContent.includes('It will retry shortly') &&
        document.querySelector('.remote-viewer-heading')?.textContent.includes('Connected');
    })()`));
    const unknownWriteCount = linuxClipboardLocalWriteCalls;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 2000));
    if (linuxClipboardLocalWriteCalls !== unknownWriteCount) throw new Error("An unknown Linux clipboard write was retried automatically.");
    await interact(`document.querySelector('.remote-viewer-panel').scrollTop=document.querySelector('.remote-viewer-panel').scrollHeight`);
    writeFileSync(resolve(output, "viewer-linux-clipboard-unknown.png"), (await captureViewport(viewer)).toPNG());
    await interact(`[...document.querySelectorAll('.remote-viewer-panel button')].find(button=>button.textContent==='Retry'&&!button.disabled).click()`);
    await until(async () => {
      const state = await viewer.webContents.executeJavaScript("window.jokoRemoteDesktopViewer.state()");
      return state.clipboardSyncState.active && !state.clipboardSyncState.pending && !state.clipboardSyncState.notice;
    });
    await new Promise(resolveDelay => setTimeout(resolveDelay, 1700));
    if (linuxClipboardLocalWriteCalls !== unknownWriteCount) throw new Error("Explicit Retry replayed an unknown clipboard write.");

    stage = "Linux clipboard off cancels waiting but holds the actual effect slot";
    deferLinuxClipboardWrite = true;
    remoteClipboard = JSON.stringify({ text: "synthetic Linux canceled effect" }); clipboardVersion++;
    await until(() => pendingLinuxClipboardWrite !== undefined);
    await toggleSync(false);
    await until(async () => pendingLinuxClipboardWrite.signal.aborted && viewer.webContents.executeJavaScript(`(async()=> {
      const state=await window.jokoRemoteDesktopViewer.state(); return !state.clipboardSync && state.clipboardSyncState.pending;
    })()`));
    const canceledWriteCount = linuxClipboardLocalWriteCalls;
    writeFileSync(resolve(output, "viewer-linux-clipboard-pending-cancel.png"), (await captureViewport(viewer)).toPNG());
    await new Promise(resolveDelay => setTimeout(resolveDelay, 1700));
    if (linuxClipboardLocalWriteCalls !== canceledWriteCount) throw new Error("Canceled Linux clipboard effect released its slot early.");
    pendingLinuxClipboardWrite.finish(); pendingLinuxClipboardWrite = undefined;
    await until(async () => !(await viewer.webContents.executeJavaScript("window.jokoRemoteDesktopViewer.state()")).clipboardSyncState.pending);
    await toggleSync(true);
    await until(async () => {
      const state = await viewer.webContents.executeJavaScript("window.jokoRemoteDesktopViewer.state()");
      return state.clipboardSyncState.active && !state.clipboardSyncState.pending;
    });
    if (linuxClipboardLocalWriteCalls !== canceledWriteCount) throw new Error("Canceled clipboard receipt was adopted or replayed on re-enable.");
    await toggleSync(false);
    await until(async () => !clipboardSync && !(await viewer.webContents.executeJavaScript("window.jokoRemoteDesktopViewer.state()")).clipboardSyncState.pending);
    await retireLinux();

    stage = "Linux audio capability and unavailable offer preserve connected JPEG and control";
    peer.targetDeviceId = "synthetic-linux-audio-host";
    const audioStartsBefore = starts, audioStopsBefore = stops;
    await openLinux("linux-audio");
    await until(async () => linuxAudioFailures === 1 && control && await headingIncludes("Connected") &&
      viewer.webContents.executeJavaScript(`document.querySelector('.remote-viewer-heading')?.textContent.includes('Compatibility mode') &&
        document.querySelector('#image')?.naturalWidth===160 && document.querySelector('.remote-viewer-toolbar .button')?.getAttribute('aria-pressed')==='true'`));
    const audioLeaseId = activeLeaseId;
    if (starts !== audioStartsBefore + 1 || stops !== audioStopsBefore || linuxAudioOffers[0]?.audio !== true) {
      throw new Error("An optional audio failure retired its lease or omitted the requested audio.");
    }
    await interact(`document.querySelector('button[aria-label="Display settings"]').click()`);
    const audioReady = (desired) => viewer.webContents.executeJavaScript(`(async()=> {
      const input=[...document.querySelectorAll('.remote-viewer-check')].find(item=>item.textContent.includes('Remote audio'))?.querySelector('input');
      const state=await window.jokoRemoteDesktopViewer.state();
      return input && input.checked===${desired} && !input.disabled && state.audio===${desired} &&
        document.querySelector('.remote-viewer-heading')?.textContent.includes('Connected') &&
        document.querySelector('.remote-viewer-heading')?.textContent.includes('Compatibility mode');
    })()`);
    await until(async () => await audioReady(true));
    const unavailableOffers = linuxAudioOffers.length;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 1700));
    if (linuxAudioOffers.length !== unavailableOffers || activeLeaseId !== audioLeaseId || starts !== audioStartsBefore + 1 || !control) {
      throw new Error("Unavailable audio automatically repeated its offer or changed the connected lease.");
    }
    writeFileSync(resolve(output, "viewer-linux-audio-fallback.png"), (await captureViewport(viewer)).toPNG());

    stage = "Linux audio setting saves before a muted offer on the same lease";
    await interact(`[...document.querySelectorAll('.remote-viewer-check')].find(item=>item.textContent.includes('Remote audio')).querySelector('input').click()`);
    await until(async () => linuxAudioOffers.length === unavailableOffers + 1 && linuxAudioOffers.at(-1)?.audio === false && control && await audioReady(false));
    const savedLinuxAudio = createDesktopRemoteDesktopViewerPreferencesStore(preferencePath); await savedLinuxAudio.initialize();
    if (savedLinuxAudio.get(owner, peer.targetDeviceId).audio !== false || activeLeaseId !== audioLeaseId ||
      starts !== audioStartsBefore + 1 || stops !== audioStopsBefore || linuxAudioFailures !== 1) {
      throw new Error("The muted audio setting was not confirmed on disk and applied to the same lease.");
    }
    await retireLinux();

    stage = "Linux audio same-target reopen uses the confirmed muted intent in its first offer";
    const reopenOffers = linuxAudioOffers.length, reopenStarts = starts;
    await openLinux("linux-audio");
    await until(async () => linuxAudioOffers.length === reopenOffers + 1 && control && await headingIncludes("Connected"));
    if (linuxAudioOffers[reopenOffers]?.audio !== false || linuxAudioFailures !== 1 || starts !== reopenStarts + 1 || activeLeaseId === audioLeaseId) {
      throw new Error("Same-target reopen did not use its saved audio intent in the first fresh offer.");
    }
    await interact(`document.querySelector('button[aria-label="Display settings"]').click()`);
    await until(async () => await audioReady(false));
    writeFileSync(resolve(output, "viewer-linux-audio-preference.png"), (await captureViewport(viewer)).toPNG());
    await retireLinux();

    writeFileSync(resolve(output, "result.json"), JSON.stringify({ passed: true, scope, platform: process.platform, electron: process.versions.electron,
      starts, stops, frames, muteRequests, lockRequests, lockCalls, expiredLockReplies, locks, inputRequests, inputAcks, controlCalls,
      privacyRequests, clipboardSyncEnables, clipboardCopies, clipboardRemoteWrites, clipboardLocalWrites, resizedBounds, workArea: screen.getDisplayMatching(resizedBounds).workArea,
      credentialPrepares, credentialBegins, credentialPasswords, credentialReceipts, credentialEnds, credentialSettings,
      modeRequests, modeRestores, modeRestoreRefusals, currentMode, display,
      portalPickers, portalOffers, portalFrames, portalHeartbeats, portalLateFrames,
      linuxClipboardLocalWriteCalls, linuxClipboardExplicitCopies, linuxClipboardExplicitPastes,
      linuxAudioOffers, linuxAudioFailures, cachedWindowEvidence, rendererRecoveryEvidence, viewerRequests, viewerFocus, viewerReadiness, viewerGeometry,
      scaleFactor: screen.getDisplayMatching(resizedBounds).scaleFactor, preferencePath,
      checks: ["standalone preload", "generated HTTP RPC", "presented JPEG", "confirmed control", "target reuse",
        "confirmed close retires authority and hides the same BrowserWindow", "cached same-target reopen preserves memory bounds with one fresh lease",
        "closed generation cannot request through the cached renderer", "actual visible renderer crash creates one replacement",
        "replacement quiet shell is visible before its deferred generated HTTP start", "crashed generation cannot request through the replacement renderer",
        "replacement establishes fresh lease and confirmed control after network release",
        "Actual size toolbar action", "fullscreen exit and current work-area clamp", "audio preference UI adoption after save",
        "host mute default off and persisted desired intent", "typed host mute failure preserves view", "explicit host mute retry and actual ACK", "host mute same-target reopen and control retirement",
        "privacy default off and persisted desired intent", "typed privacy failure preserves view without heartbeat replay", "explicit privacy retry and actual ACK",
        "privacy request adopts latest saved lock on exit", "same-target privacy intent and control-scoped effect restore",
        "clipboard sync default off and saved intent", "clipboard permission failure preserves view and needs explicit retry",
        "initial clipboard baseline without overwrite", "bidirectional generated clipboard sync", "clipboard sync off and no echo", "same-target clipboard sync intent restore",
        "view-only lock on exit default off and saved intent", "typed exit failure retains window", "expired exit retry does not repeat lock effect", "explicit reconnect to fresh lease and confirmed lock exit", "reopened exit preference and ordinary retirement without lock",
        "fresh preference store disk load", "explicit disconnect", "same-target reopen audio restore",
        "native settings default off and view-only setup", "native unavailable preserves view and explicit Retry", "native confirmed saved settings and biometric change",
        "native authenticated fresh lease", "saved native auto unlock after first frame on reopen", "lost password ACK recovers via new receipt query without replay", "native saved setting disable",
        "capability-default temporary mode via generated HTTP", "same-lease actual geometry and fresh control generation", "continuous temporary modes retain first original capture",
        "unconfirmed native mode effect preserves explicit recovery UI", "original restore refusal blocks NEW without mode replay", "explicit retry restores original before fresh lease",
        "hidden retirement restores captured original mode", "source retirement restores captured original mode",
        "hidden retirement", "stale generation", "foreground reconnect", "source retirement",
        "Linux host capabilities enable confirmed control from another viewer platform", "Linux generated cursor pixels reach the real image decoder",
        "portal typed capture pending exposes local-approval waiting UI without reconnect", "pending portal capture keeps heartbeat and one captured lease",
        "portal approval presents same-lease view-only JPEG pixels", "portal denial remains terminal without a repeated picker",
        "retired pending frame reply cannot affect a replacement viewer",
        "Linux explicit Copy uses the injected system-only local clipboard port", "Linux explicit Paste uses generated chunks and confirmed commit",
        "Linux clipboard sync default off and persisted intent", "opaque Linux fingerprint versions establish a no-write baseline",
        "Linux clipboard sync propagates both directions without echo", "unknown Linux clipboard write has visible explicit Retry and no automatic replay",
        "explicit unknown Retry establishes a fresh baseline without repeating a write", "clipboard off retains the pending native effect slot until actual receipt",
        "late canceled clipboard receipt cannot resume or replay the old sync effect",
        "Linux system audio capability exposes the saved setting from another viewer platform",
        "typed unavailable audio keeps same-lease connected JPEG and control without an automatic offer replay",
        "confirmed audio preference saves to disk before the muted same-lease offer",
        "same-target Linux reopen uses the saved muted intent in its first fresh offer"],
      evidence: "E2", limits: ["synthetic host, display geometry and pixels", "Windows scaled native bounds allow one DIP of round-trip rounding",
        "real Windows Electron renderer crash/replacement and cached BrowserWindow bounds; no actual macOS fullscreen exit or other operating system window recovery",
        "synthetic Linux systemAudio capability and typed offer failure with real settings, JPEG fallback and saved intent; no real Linux PCM, PipeWire sink, playback, WebRTC audio track or replaceTrack proof",
        "synthetic lock acknowledgement only; no physical OS lock or unlock",
        "synthetic privacy acknowledgement only; no physical screens, native input gate, local confirmation dialog or capture filter",
        "injected system-only clipboard adapter and synthetic remote clipboard; no physical OS clipboard contents were read or written",
        "Windows Electron with injected macOS viewer platform and synthetic native credential port; no real macOS Keychain, Secure Enclave, password dialog or OS unlock",
        "synthetic physical-mode enumeration, native mode effects and restoration; no real CoreGraphics, macOS HiDPI, hotplug, original-mode restoration or physical control proof",
        "Windows Electron with synthetic Linux native/portal capabilities, consent decisions and late JPEG receipt; no real Hyprland, Wayland portal, Linux helper, OS input, consent picker or MediaStream track disposal proof",
        "synthetic Linux local clipboard port and controlled remote clipboard with SHA256 content versions; no user OS clipboard, real wl-paste, PRIMARY selection, native writer ready/roundtrip or Linux session proof",
        "no physical capture/input", "no WebRTC NAT/TURN", "no system clipboard/audio", "no signature/install or paired reference pixels"] }, null, 2));
    process.stdout.write("Remote desktop viewer Electron smoke passed.\n");
    app.removeListener("browser-window-created", observeFocus);
    quitting = true; manager.dispose(); source.destroy(); server.close(); clearTimeout(deadline); app.exit(0);
  } catch (error) {
    process.stderr.write(`Remote desktop viewer Electron smoke failed at ${stage}: ${error instanceof Error ? error.message : "unknown"}\n`);
    writeFileSync(resolve(output, "failure.json"), JSON.stringify({ scope, stage, starts, stops, frames,
      cachedWindowEvidence, rendererRecoveryEvidence, prewarmEvidence, prewarmEffects: prewarmEffects(), activeLeaseId, control, viewerRequests, viewerFocus, viewerReadiness, viewerGeometry,
      viewerDestroyed: viewer?.isDestroyed() ?? true, pendingViewerStart: pendingViewerStart !== undefined }, null, 2));
    if (viewer && !viewer.isDestroyed()) {
      const state = await viewer.webContents.executeJavaScript("window.jokoRemoteDesktopViewer.state()").catch(() => undefined);
      const renderer = await viewer.webContents.executeJavaScript(`({focused:document.hasFocus(),heading:document.querySelector('.remote-viewer-heading')?.textContent,
        control:document.querySelector('.remote-viewer-toolbar .button')?.getAttribute('aria-pressed'),
        controlDisabled:document.querySelector('.remote-viewer-toolbar .button')?.disabled})`).catch(() => undefined);
      writeFileSync(resolve(output, "failure.json"), JSON.stringify({ scope, stage, starts, stops, frames, muteRequests, lockCalls, lockRequests, expiredLockReplies, locks, state,
        renderer, control, controlGeneration: String(controlGeneration), controlCalls, inputRequests, inputAcks, hostMute, privacyScreen, privacyLockOnExit, privacyRequests, clipboardSync, clipboardSyncEnables,
        modeRequests, modeRestores, modeRestoreRefusals, currentMode, display, originalMode,
        fixtureFlavor, portalConsent, portalPickers, portalOffers, portalFrames, portalHeartbeats, portalLateFrames,
        deferredPortalLeaseId: deferredPortalFrame?.leaseId,
        linuxClipboardLocalWriteCalls, linuxClipboardExplicitCopies, linuxClipboardExplicitPastes,
        linuxAudioOffers, linuxAudioFailures, cachedWindowEvidence, rendererRecoveryEvidence, prewarmEvidence, prewarmEffects: prewarmEffects(), viewerRequests, viewerFocus, viewerReadiness, viewerGeometry,
        pendingViewerStart: pendingViewerStart !== undefined,
        linuxClipboardWritePending: pendingLinuxClipboardWrite !== undefined,
        visible: viewer.isVisible(), minimized: viewer.isMinimized(), focused: viewer.isFocused(),
        fullscreen: viewer.isFullScreen(), maximized: viewer.isMaximized(), bounds: viewer.getBounds(),
        content: viewer.getContentBounds(), workArea: screen.getDisplayMatching(viewer.getBounds()).workArea }, null, 2));
      const failureImage = await Promise.race([captureViewport(viewer).catch(() => undefined),
        new Promise(resolveCapture => setTimeout(() => resolveCapture(undefined), 2000))]);
      if (failureImage) writeFileSync(resolve(output, "failure.png"), failureImage.toPNG());
    }
    app.removeListener("browser-window-created", observeFocus);
    quitting = true; manager.dispose(); if (!source.isDestroyed()) source.destroy(); server.close(); clearTimeout(deadline); app.exit(1);
  }
}

async function captureViewport(window) {
  // Native bounds can settle before the compositor publishes its restored surface.
  for (let attempt = 0; attempt < 3; attempt++) {
    await window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    try { return await window.webContents.capturePage(); }
    catch (error) {
      if (attempt === 2 || !(error instanceof Error) || error.message !== "UnknownVizError") throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error("Viewport capture did not settle.");
}

async function until(probe) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await probe()) return; await new Promise((accept) => setTimeout(accept, 100)); }
  throw new Error("Viewer smoke deadline exceeded.");
}
