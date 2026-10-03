/// <reference types="node" />

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface DesktopManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, string>>;
}

interface DesktopTsConfig {
  readonly include?: readonly string[];
  readonly compilerOptions?: {
    readonly outDir?: string;
    readonly tsBuildInfoFile?: string;
  };
}

interface BuilderFileSet {
  readonly from: string;
  readonly to: string;
  readonly filter?: readonly string[];
}

interface BuilderConfig {
  readonly asar: boolean;
  readonly electronVersion: string;
  readonly publish: unknown;
  readonly directories: { readonly output: string; readonly buildResources: string };
  readonly files: readonly string[];
  readonly extraResources: readonly BuilderFileSet[];
  readonly afterPack: string;
  readonly win: { readonly icon: string; readonly forceCodeSigning: boolean; readonly target: readonly string[] };
  readonly mac: { readonly icon: string; readonly identity: unknown; readonly target: readonly string[] };
  readonly linux: { readonly icon: string; readonly target: readonly string[] };
}

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as DesktopManifest;
const tsconfig = JSON.parse(readFileSync(new URL("../tsconfig.json", import.meta.url), "utf8")) as DesktopTsConfig;
const config = JSON.parse(readFileSync(new URL("../electron-builder.json", import.meta.url), "utf8")) as BuilderConfig;
const workspace = readFileSync(new URL("../../../pnpm-workspace.yaml", import.meta.url), "utf8");
const packagedAudit = readFileSync(new URL("../scripts/audit-packaged.cjs", import.meta.url), "utf8");
const packagedSmoke = readFileSync(new URL("../scripts/smoke-packaged.mjs", import.meta.url), "utf8");
const packagedSmokeHelpers = readFileSync(new URL("../scripts/smoke-packaged-helpers.mjs", import.meta.url), "utf8");
const desktopMain = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const runtimeProcessMonitorPreload = readFileSync(
  new URL("../src/runtime-process-monitor-preload.cts", import.meta.url),
  "utf8"
);

describe("Desktop distribution", () => {
  it("invalidates incremental state whenever compiled Desktop output is removed", () => {
    expect(tsconfig.compilerOptions).toMatchObject({
      outDir: "dist",
      tsBuildInfoFile: "dist/tsconfig.tsbuildinfo"
    });
    expect(manifest.scripts?.["build:runtime-stager"]).toBe("tsc -b tsconfig.json --force");
  });

  it("pins an inert builder toolchain and keeps build-only packages out of production dependencies", () => {
    expect(manifest.dependencies).toEqual({
      "@bufbuild/protobuf": "2.14.0",
      "@connectrpc/connect": "2.1.2",
      "@connectrpc/connect-node": "2.1.2",
      "@joko/contracts": "workspace:*",
      "@joko/device-peer": "workspace:*",
      "electron-updater": "6.8.9",
      "electron-window-state": "5.0.3",
      loudness: "0.4.2",
      yaml: "2.9.0"
    });
    expect(manifest.devDependencies).toMatchObject({
      "@joko/web": "workspace:*",
      electron: "43.6.0",
      "electron-builder": "26.15.3"
    });
    expect(manifest.scripts?.["package:dir"]).toContain("--dir --publish never");
    expect(manifest.scripts?.["package:artifacts"]).toContain("--publish never");
    expect(config.electronVersion).toBe("43.6.0");
    expect(config.publish).toBeNull();
    expect(workspace).toContain("electron-winstaller: false");
    expect(workspace).not.toContain("electron-winstaller: true");
  });

  it("packages only compiled host/web inputs and an external sanitized Orchestrator runtime", () => {
    expect(config.asar).toBe(false);
    expect(config.files).toEqual(expect.arrayContaining([
      "dist/**/*.js",
      "dist/**/*.cjs",
      "dist/web/**/*",
      "!dist/orchestrator-runtime/**",
      expect.stringContaining("map,ts,tsx,cts,mts,proto,tsbuildinfo,c,cc,cpp"),
      "!**/{test,tests,__tests__,coverage,fixtures,workspace}/**",
      "!**/*.test.*",
      "!**/WORKSPACE",
      "!**/WORKSPACE/**",
      "!**/{.env,.env.*,*.db,*.db-shm,*.db-wal,*.log}"
    ]));
    expect(config.extraResources.map(({ from, to }) => ({ from, to }))).toEqual([
      { from: "resources/ios-simulator", to: "ios-simulator" },
      { from: "resources/app-update.yml", to: "app-update.yml" },
      { from: "resources/native-task-status-sounds", to: "native-task-status-sounds" },
      { from: "dist/native-voice-shortcut", to: "native-voice-shortcut" },
      { from: "dist/native-system-frontmost-input", to: "native-system-frontmost-input" },
      { from: "dist/native-simulator-hid", to: "native-simulator-hid" },
      { from: "dist/native-simulator-h264", to: "native-simulator-h264" },
      { from: "dist/orchestrator-runtime", to: "orchestrator-runtime" },
      { from: "dist/orchestrator-runtime/node_modules", to: "orchestrator-runtime/node_modules" }
    ]);
    expect(config.extraResources.find(item => item.to === "ios-simulator")?.filter).toEqual([
      "manifest.json", "LICENSE.appium-webdriveragent", "WebDriverAgent-v15.1.6.tar.gz"
    ]);
    expect(config.extraResources.find(item => item.to === "native-simulator-hid")?.filter).toEqual([
      "manifest.json", "joko-simulator-hid"
    ]);
    expect(config.extraResources.find(item => item.to === "native-simulator-h264")?.filter).toEqual([
      "manifest.json", "joko-simulator-h264"
    ]);
    expect(config.extraResources.filter(item => item.to.startsWith("orchestrator-runtime")))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ from: "dist/orchestrator-runtime", filter: expect.arrayContaining([
          "!node_modules/**", "!**/*.test.*",
          expect.stringContaining("map,ts,tsx,cts,mts,proto,tsbuildinfo,c,cc,cpp")
        ]) }),
        expect.objectContaining({ from: "dist/orchestrator-runtime/node_modules",
          filter: expect.arrayContaining(["!**/*.test.*", "!**/WORKSPACE", "!**/WORKSPACE/**",
            "!**/{.env,.env.*,*.db,*.db-shm,*.db-wal,*.log}"]) })
      ]));
    expect(config.afterPack).toBe("scripts/audit-packaged.cjs");
  });

  it("compiles, packages, audits, and smoke-checks the isolated hardware utility entry", () => {
    expect(existsSync(new URL("../src/dedicated-hardware/utility-entry.ts", import.meta.url))).toBe(true);
    expect(tsconfig.include).toContain("src/**/*.ts");
    expect(config.files).toContain("dist/**/*.js");
    expect(packagedAudit).toContain('join("dist", "dedicated-hardware", "utility-entry.js")');
    expect(packagedSmoke).toContain('resolve(applicationRoot, "dist", "dedicated-hardware", "utility-entry.js")');
    expect(packagedSmoke).toContain("canonicalRegularFileExists(entry)");
    expect(packagedSmoke).toContain("function canonicalRegularFileExists(path)");
  });

  it("requires the full system-handoff journey unless Inspector scope is explicit", () => {
    expect(packagedSmoke).toContain('JOKO_DESKTOP_SMOKE_SCOPE: smokeScope');
    expect(packagedSmoke).toContain('value !== "--inspector"');
    expect(packagedSmoke).toContain('"system_handoff_cold_argv_ingress"');
    expect(packagedSmoke).toContain('"system_handoff_cancelled_navigation_preserved"');
    expect(packagedSmoke).toContain('"system_handoff_failed_document_request_injected"');
    expect(packagedSmoke).toContain('"system_handoff_failed_document_load_stopped"');
    expect(packagedSmoke).toContain('"system_handoff_failed_navigation_preserved"');
    expect(packagedSmoke).toContain('"system_handoff_second_instance_delivery_acknowledged"');
    expect(packagedSmoke).toContain('"system_handoff_second_instance_acknowledged"');
    expect(packagedSmoke).toContain('"system_handoff_tray_reopened"');
    expect(packagedSmoke).toContain('"JOKO_DESKTOP_SYSTEM_HANDOFF_SMOKE_OK"');
  });

  it("ships the preload-captured main Document occurrence lifecycle", () => {
    expect(config.files).toContain("dist/**/*.js");
    expect(desktopMain).toContain("DesktopMainDocumentOccurrenceAuthority");
    expect(desktopMain).toContain('from "./main-document-occurrence.js";');
    expect(desktopMain).toContain("captureMainApplicationDocumentOccurrenceForSender(event, parameters[0])");
    expect(desktopMain).toContain("const capture = mainWindowDocuments.capture(contents, claim);");
    const captureComposition = desktopMain.slice(
      desktopMain.indexOf("const capture = mainWindowDocuments.capture(contents, claim);"),
      desktopMain.indexOf("return capture.current.occurrence;")
    );
    expect(captureComposition).toContain("if (capture.created)");
    expect(captureComposition.indexOf("desktopDeepLinkDelivery.resetRenderer();"))
      .toBeGreaterThan(captureComposition.indexOf("if (capture.created)"));
    expect(desktopMain).not.toContain(
      "window.webContents.isDestroyed() || window.webContents.isLoading()"
    );
    const failedDocumentProbe = desktopMain.slice(
      desktopMain.indexOf("const originalUrl = contents.getURL();"),
      desktopMain.indexOf('recordPackagedSmokeProgress("system_handoff_failed_navigation_preserved");')
    );
    expect(failedDocumentProbe).not.toContain("contents.session.clearCache()");
    expect(failedDocumentProbe).toContain("contents.loadURL(originalUrl, {");
    expect(failedDocumentProbe).toContain("extraHeaders: `${PACKAGED_SMOKE_FAILED_DOCUMENT_HEADER}: 1\\n");
    expect(failedDocumentProbe).toContain('postData: [{ type: "rawData", bytes: Buffer.from([0]) }]');
    expect(failedDocumentProbe).toContain("failedDocumentRequestInjected,");
    expect(failedDocumentProbe).toContain("if (!loadRejected ||");
    expect(failedDocumentProbe).toContain("await waitForPackagedSmokeFailedDocumentLoadStop(contents);");
    expect(failedDocumentProbe).not.toContain('"did-fail-provisional-load"');
    expect(failedDocumentProbe.indexOf("armPackagedSmokeFailedMainDocumentRequest()"))
      .toBeLessThan(failedDocumentProbe.indexOf("contents.loadURL(originalUrl, {"));
    expect(failedDocumentProbe.indexOf("failedDocumentRequestInjected,"))
      .toBeLessThan(failedDocumentProbe.indexOf("const loadRejected ="));
    expect(desktopMain).toContain("resolvePackagedSmokeFailedMainDocumentRequest");
    expect(desktopMain).toContain('request.method === "POST"');
    expect(desktopMain).toContain('request.headers.get(PACKAGED_SMOKE_FAILED_DOCUMENT_HEADER) === "1"');
    expect(desktopMain).toContain("return new Response(null, {");
    expect(desktopMain).toContain("status: 204,");
    expect(desktopMain).toContain("resolveRequest?.();");
    expect(desktopMain).toContain('removeListener("did-fail-load", failInitialPackagedSmokeLoad)');

    const runtimeMonitorRetirement = desktopMain.slice(
      desktopMain.indexOf("async function destroyRuntimeProcessMonitorWindowAndWait("),
      desktopMain.indexOf("function waitForRuntimeProcessMonitorIpcTurn()")
    );
    expect(runtimeMonitorRetirement).toContain("const expectedContents = expectedWindow.webContents;");
    expect(runtimeMonitorRetirement).toContain("beginRuntimeProcessMonitorWindowRetirementObservation(");
    expect(runtimeMonitorRetirement).toContain("destroyRetiredRuntimeProcessMonitorWindow(retirement)");
    expect(runtimeMonitorRetirement).toContain("await nativeRetirement.wait();");
    expect(runtimeMonitorRetirement).not.toContain("expectedContents.close(");
    expect(runtimeMonitorRetirement).not.toContain("forcefullyCrashRenderer");
    expect(desktopMain).toContain("const monitorContents = window.webContents;");
    expect(desktopMain).toContain("runtimeProcessMonitorBroker.retireEndpoint(monitorContents);");
    expect(desktopMain).not.toContain("runtimeProcessMonitorBroker.retireEndpoint(window.webContents);");

    const documentCapture = desktopMain.slice(
      desktopMain.indexOf("function captureMainApplicationDocumentOccurrenceForSender("),
      desktopMain.indexOf("function assertCurrentMainApplicationDocumentSender(")
    );
    expect(documentCapture).toContain("if (!isTrustedDesktopIpcSender(event)) {");
    expect(documentCapture).toContain("retireMainWindowDocument(window, event.sender);");
    expect(documentCapture).toContain("releaseDesktopAttentionSource(event.sender.id);");
  });

  it("bounds and cleans every smoke process while rejecting stale unpacked app code", () => {
    expect(packagedSmoke).toContain("JOKO_DESKTOP_SMOKE_TIMEOUT_MS: String(timeoutMs)");
    expect(desktopMain).toContain('process.env["JOKO_DESKTOP_SMOKE_TIMEOUT_MS"]');
    expect(desktopMain).toContain("}, packagedSmokeTimeoutMs);");
    expect(desktopMain).toContain("Math.max(30_000, packagedSmokeTimeoutMs - 30_000)");
    expect(desktopMain).toContain("Date.now() + ${packagedSmokeManagedReadyTimeoutMs}");
    expect(packagedSmoke).toContain("const smokeDeadline = Date.now() + timeoutMs");
    expect(packagedSmoke).toContain("async function terminateChildTree(child, options = {})");
    expect(packagedSmoke).toContain("await Promise.allSettled([secondInstance])");
    expect(packagedSmoke).toContain("function removeMarkerDirectory(directory)");
    expect(packagedSmoke).toContain("assertUnpackedArtifactFresh(executable)");
    expect(packagedSmoke).toContain("comparePackagedApplicationMirror(sourceRoot, artifactRoot)");
    expect(packagedSmoke).toContain("compareConfiguredExtraResourceMirrors({");
    expect(packagedSmokeHelpers).toContain("function collectOwnedArtifactFiles(");
    expect(packagedSmokeHelpers).toContain('new Set([".DS_Store", ".gitkeep"])');
    expect(packagedSmokeHelpers).toContain("function filesHaveEqualContents(");
    expect(packagedSmokeHelpers).toContain("readExact(leftDescriptor");
    expect(packagedSmokeHelpers).toContain("await options.cleanupTemporaryDirectory()");
    expect(packagedSmokeHelpers.indexOf("await options.cleanupTemporaryDirectory()"))
      .toBeLessThan(packagedSmokeHelpers.indexOf("await options.emitSuccess(payload)"));
    expect(packagedSmoke).toContain("readManagedConnectionMetadata(managedConnectionPath)");
    expect(packagedSmoke).toContain("readManagedRuntimeProcessMarker(managedRuntimeProcessPath)");
    expect(packagedSmoke).toContain("managedRuntimeProcessStopped");
    expect(desktopMain).toContain('`${packagedSmokeResultPath}.managed-process.json`');
    expect(desktopMain.indexOf("writePackagedSmokeManagedRuntimeProcess(runtime)"))
      .toBeLessThan(desktopMain.indexOf("authKey = runtime.takeAuthKey()"));
    expect(packagedSmoke).toContain("pnpm build:desktop:unpacked");
    expect(packagedSmoke).toContain('"JOKO_DESKTOP_INSPECTOR_SMOKE_OK"');
  });

  it("builds and audits the minimal standalone runtime-diagnostics preload", () => {
    expect(manifest.scripts?.build).toContain("node --check dist/runtime-process-monitor-preload.cjs");
    expect(config.files).toContain("dist/**/*.cjs");
    expect(packagedAudit).toContain('join("dist", "runtime-process-monitor-preload.cjs")');
    expect(runtimeProcessMonitorPreload).toContain(
      'contextBridge.exposeInMainWorld("jokoRuntimeProcessDiagnostics", api)'
    );
    expect(runtimeProcessMonitorPreload).not.toContain('exposeInMainWorld("jokoDesktop"');
    expect(runtimeProcessMonitorPreload).not.toContain("sendSync(");
    expect([...runtimeProcessMonitorPreload.matchAll(/"(joko:[^"]+)"/gu)].map((match) => match[1]).sort())
      .toEqual([
        "joko:runtime-process-diagnostics:owner:get",
        "joko:runtime-process-diagnostics:request",
        "joko:runtime-process-diagnostics:response",
        "joko:runtime-process-diagnostics:retired",
        "joko:runtime-process-diagnostics:retired:acknowledge",
        "joko:runtime-process-monitor:sample-desktop",
        "joko:window:close",
        "joko:window:minimize",
        "joko:window:set-zoom-factor",
        "joko:window:toggle-maximize"
      ]);
  });

  it("has no redistributable hardware SDK input and audits only its fixed resources directory", () => {
    expect(existsSync(new URL("../resources/dedicated-hardware-sdk", import.meta.url))).toBe(false);
    expect(config.extraResources.some(({ from, to }) =>
      from.includes("dedicated-hardware-sdk") || to.includes("dedicated-hardware-sdk")
    )).toBe(false);
    expect(packagedAudit).toContain("const APPROVED_DEDICATED_HARDWARE_SDK_ARTIFACTS = Object.freeze([])");
    expect(packagedAudit).toContain("resolve(resourcesRoot, DEDICATED_HARDWARE_SDK_DIRECTORY)");
  });

  it("uses the existing Joko-owned vector and emits installable plus unpackable platform targets", () => {
    expect(config.directories).toEqual({ output: "release", buildResources: "../../packages/brand-assets/src" });
    expect(existsSync(new URL("../../../packages/brand-assets/src/icon-light.svg", import.meta.url))).toBe(true);
    expect(config.win).toMatchObject({ icon: "icon-light.svg", forceCodeSigning: false, target: ["nsis", "zip"] });
    expect(config.mac).toMatchObject({ icon: "icon-light.svg", identity: null, target: ["dmg", "zip"] });
    expect(config.linux).toMatchObject({ icon: "icon-light.svg", target: ["AppImage", "tar.gz"] });
  });
});
