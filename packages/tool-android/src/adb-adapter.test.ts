import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  AdbCliAdapter,
  escapeAdbInputText,
  normalizeAdbEndpoint,
  parseAdbDevices,
  parseAndroidUiNodes,
  type AndroidArtifactFileSystem
} from "./adb-adapter.js";
import type {
  AndroidCommandRequest,
  AndroidCommandResult,
  AndroidCommandRunner
} from "./process-runner.js";

describe("ADB parsers and validators", () => {
  it("parses long device output and drops malformed serials", () => {
    expect(parseAdbDevices([
      "* daemon started successfully",
      "List of devices attached",
      "emulator-5554 device product:sdk model:Pixel_8 device:emu transport_id:4",
      "192.0.2.3:5555 offline transport_id:5",
      "bad/serial device",
      "USB_123 unauthorized usb:3-1"
    ].join("\n"))).toEqual([
      {
        serial: "emulator-5554",
        state: "device",
        product: "sdk",
        model: "Pixel_8",
        device: "emu",
        transportId: "4"
      },
      { serial: "192.0.2.3:5555", state: "offline", transportId: "5" },
      { serial: "USB_123", state: "unauthorized", usb: "3-1" }
    ]);
  });

  it("normalizes network endpoints without accepting URL or shell syntax", () => {
    expect(normalizeAdbEndpoint("Example.test")).toBe("example.test:5555");
    expect(normalizeAdbEndpoint("192.0.2.4:62001")).toBe("192.0.2.4:62001");
    expect(normalizeAdbEndpoint("[2001:db8::1]:5556")).toBe("[2001:db8::1]:5556");
    for (const invalid of [
      "https://example.test:5555",
      "person@example.test:5555",
      "example.test:0",
      "example.test:99999",
      "example.test:5555;whoami",
      "-s"
    ]) expect(() => normalizeAdbEndpoint(invalid)).toThrow(/endpoint/iu);
  });

  it("accepts only the restricted text alphabet and protects the reserved space sequence", () => {
    expect(escapeAdbInputText("hello world@example.test")).toBe("hello%sworld@example.test");
    expect(() => escapeAdbInputText("already%sspace")).toThrow(/unsupported/iu);
    expect(() => escapeAdbInputText("quote'and&shell")).toThrow(/unsupported/iu);
    expect(() => escapeAdbInputText("秘密")).toThrow(/unsupported/iu);
  });

  it("redacts password nodes and bounds the UI tree", () => {
    const passwordNode = '<node text="hunter2" content-desc="Password: hunter2" resource-id="app:id/password" password="true" clickable="true" enabled="true" bounds="[0,0][100,40]"/>';
    const ordinary = Array.from({ length: 205 }, (_value, index) =>
      `<node text="Item ${index}" clickable="true" enabled="true" bounds="[0,${index + 1}][100,${index + 2}]"/>`).join("");
    const parsed = parseAndroidUiNodes(`<hierarchy>${passwordNode}${ordinary}</hierarchy>`);

    expect(parsed.nodes).toHaveLength(200);
    expect(parsed.truncated).toBe(true);
    expect(parsed.nodes[0]).toMatchObject({
      index: 1,
      text: "[REDACTED]",
      contentDescription: "[REDACTED]",
      password: true
    });
    expect(JSON.stringify(parsed)).not.toContain("hunter2");
  });
});

describe("AdbCliAdapter", () => {
  it("probes, lists devices, and runs allowlisted direct actions", async () => {
    const runner = queuedRunner([
      result("Android Debug Bridge version 1.0.41\nVersion 35.0.2\n"),
      result("List of devices attached\nemulator-5554 device model:Pixel\n"),
      result(""),
      result(""),
      result(""),
      result("Starting: Intent")
    ]);
    const adapter = new AdbCliAdapter({ executablePath: "adb", runner });

    await expect(adapter.probe()).resolves.toBe("Android Debug Bridge version 1.0.41");
    await expect(adapter.listDevices()).resolves.toEqual([
      { serial: "emulator-5554", state: "device", model: "Pixel" }
    ]);
    await adapter.tap("emulator-5554", { x: 10, y: 20 });
    await adapter.swipe("emulator-5554", { x: 1, y: 2 }, { x: 3, y: 4 }, 300);
    await expect(adapter.pressKey("emulator-5554", "BACK")).resolves.toBe(4);
    await expect(adapter.launchApp("emulator-5554", "com.example.app", ".MainActivity"))
      .resolves.toBe("Starting: Intent");

    expect(argumentsFor(runner)).toEqual([
      ["version"],
      ["devices", "-l"],
      ["-s", "emulator-5554", "shell", "input", "tap", "10", "20"],
      ["-s", "emulator-5554", "shell", "input", "swipe", "1", "2", "3", "4", "300"],
      ["-s", "emulator-5554", "shell", "input", "keyevent", "4"],
      ["-s", "emulator-5554", "shell", "am", "start", "-n", "com.example.app/.MainActivity"]
    ]);
    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({ command: "adb" }));
  });

  it("captures a PNG snapshot, uses actual PNG dimensions, parses app focus, and redacts UI secrets", async () => {
    const png = pngBuffer(1080, 2400);
    const xml = [
      "UI hierarchy dumped to: /dev/tty",
      "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\" ?>",
      '<hierarchy><node text="typed-value" content-desc="password=typed-value" password="true" clickable="true" enabled="true" bounds="[20,100][220,200]"/></hierarchy>'
    ].join("\n");
    const runner = queuedRunner([
      result("Physical size: 1440x3200\nOverride size: 1080x2400"),
      result("Physical density: 560\nOverride density: 420"),
      result("mCurrentFocus=Window{abc u0 com.example.app/.MainActivity}"),
      result("", "", 0, png),
      result(xml)
    ]);
    const adapter = new AdbCliAdapter({ executablePath: "adb", runner, now: () => 1234 });

    const snapshot = await adapter.snapshot("emulator-5554");

    expect(snapshot).toMatchObject({
      deviceSerial: "emulator-5554",
      screen: { width: 1080, height: 2400, density: 420 },
      currentApp: { packageName: "com.example.app", activity: ".MainActivity" },
      screenshot: { mimeType: "image/png", byteLength: 24 },
      nodes: [{ text: "[REDACTED]", contentDescription: "[REDACTED]", password: true }],
      capturedAt: 1234
    });
    expect(snapshot.screenshot.dataBase64).toBe(png.toString("base64"));
    expect(argumentsFor(runner)[3]).toEqual([
      "-s", "emulator-5554", "exec-out", "screencap", "-p"
    ]);
    expect(runner.run).toHaveBeenNthCalledWith(4, expect.objectContaining({
      stdoutMode: "binary",
      maximumStdoutBytes: 24 * 1024 * 1024
    }));
  });

  it("keeps screenshots usable when UI dump fails", async () => {
    const runner = queuedRunner([
      result("Physical size: 100x200"),
      result("Physical density: 320"),
      result(""),
      result("", "", 0, pngBuffer(100, 200)),
      result("", "password=do-not-return", 1)
    ]);
    const adapter = new AdbCliAdapter({ executablePath: "adb", runner });

    await expect(adapter.snapshot("serial1")).resolves.toMatchObject({
      nodes: [],
      uiDumpError: "password=[REDACTED]"
    });
  });

  it("installs only real APK files under approved roots and does not return their path", async () => {
    const root = resolve("D:\\approved-artifacts");
    const apk = resolve(root, "application.apk");
    const fileSystem: AndroidArtifactFileSystem = {
      realpath: vi.fn(async (path) => resolve(path)),
      stat: vi.fn(async () => ({ size: 1024, isFile: () => true }))
    };
    const runner = queuedRunner([result(`Success ${apk}`)]);
    const adapter = new AdbCliAdapter({
      executablePath: "adb",
      runner,
      artifactRoots: [root],
      fileSystem
    });

    const output = await adapter.installArtifact("serial1", apk, {
      replace: true,
      grantRuntimePermissions: true
    });

    expect(argumentsFor(runner)).toEqual([["-s", "serial1", "install", "-r", "-g", apk]]);
    expect(output).toBe("Success [PATH]");
    expect(output).not.toContain("approved-artifacts");
  });

  it("rejects traversal, symlink escapes, wrong extensions, empty files, and oversized APKs", async () => {
    const root = resolve("D:\\approved-artifacts");
    const runner = queuedRunner([]);
    const outsideAdapter = new AdbCliAdapter({
      executablePath: "adb",
      runner,
      artifactRoots: [root],
      fileSystem: {
        realpath: async (path) => path === root ? root : resolve("D:\\outside\\application.apk"),
        stat: async () => ({ size: 1, isFile: () => true })
      }
    });
    await expect(outsideAdapter.installArtifact("serial1", resolve(root, "link.apk")))
      .rejects.toMatchObject({ code: "artifact_outside_roots" });

    const wrongExtension = new AdbCliAdapter({
      executablePath: "adb",
      runner,
      artifactRoots: [root],
      fileSystem: {
        realpath: async (path) => resolve(path),
        stat: async () => ({ size: 1, isFile: () => true })
      }
    });
    await expect(wrongExtension.installArtifact("serial1", resolve(root, "application.txt")))
      .rejects.toMatchObject({ code: "artifact_invalid" });

    const tooLarge = new AdbCliAdapter({
      executablePath: "adb",
      runner,
      artifactRoots: [root],
      maximumApkBytes: 10,
      fileSystem: {
        realpath: async (path) => resolve(path),
        stat: async () => ({ size: 11, isFile: () => true })
      }
    });
    await expect(tooLarge.installArtifact("serial1", resolve(root, "application.apk")))
      .rejects.toMatchObject({ code: "artifact_too_large" });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("rejects arbitrary packages, activities, keys, serials, and coordinates before spawning", async () => {
    const runner = queuedRunner([]);
    const adapter = new AdbCliAdapter({ executablePath: "adb", runner });

    await expect(adapter.launchApp("serial1", "not-a-package"))
      .rejects.toMatchObject({ code: "unsafe_input" });
    await expect(adapter.launchApp("serial1", "com.example.app", "bad;activity"))
      .rejects.toMatchObject({ code: "unsafe_input" });
    await expect(adapter.pressKey("serial1", "VOLUME_UP" as never))
      .rejects.toMatchObject({ code: "unsupported_key" });
    await expect(adapter.tap("-s", { x: 0, y: 0 }))
      .rejects.toMatchObject({ code: "invalid_device_serial" });
    await expect(adapter.swipe("serial1", { x: -1, y: 0 }, { x: 1, y: 1 }, 300))
      .rejects.toMatchObject({ code: "invalid_coordinate" });
    expect(runner.run).not.toHaveBeenCalled();
  });
});

function queuedRunner(items: readonly AndroidCommandResult[]): AndroidCommandRunner & {
  readonly run: ReturnType<typeof vi.fn<(request: AndroidCommandRequest) => Promise<AndroidCommandResult>>>;
} {
  const queue = [...items];
  return {
    run: vi.fn(async () => {
      const next = queue.shift();
      if (next === undefined) throw new Error("Unexpected ADB invocation.");
      return next;
    })
  };
}

function argumentsFor(runner: AndroidCommandRunner): readonly (readonly string[])[] {
  return (runner.run as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
    (call[0] as AndroidCommandRequest).arguments ?? []);
}

function result(
  stdout: string,
  stderr = "",
  exitCode = 0,
  stdoutBuffer?: Buffer
): AndroidCommandResult {
  return {
    stdout,
    ...(stdoutBuffer === undefined ? {} : { stdoutBuffer }),
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    exitCode,
    signal: null
  };
}

function pngBuffer(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}
