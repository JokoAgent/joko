import { randomBytes } from "node:crypto";

import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import type { AndroidAdbAdapter } from "./adb-adapter.js";
import {
  ANDROID_TOOL_NAMES,
  AndroidToolProvider,
  type AndroidToolCallResult
} from "./provider.js";
import { AndroidAutomationRuntime } from "./runtime.js";
import type { AndroidConnectedDevice, AndroidDeviceSnapshot } from "./types.js";

const READY_DEVICE: AndroidConnectedDevice = {
  serial: "emulator-5554",
  state: "device",
  model: "Pixel"
};

describe("AndroidToolProvider", () => {
  it("publishes exactly the eight reference tools and no host-management operations", () => {
    const provider = providerWith();

    expect(ANDROID_TOOL_NAMES).toEqual([
      "status",
      "list_devices",
      "get_device_state",
      "tap",
      "swipe",
      "input_text",
      "press_key",
      "launch_app"
    ]);
    expect(provider.listTools().map((tool) => tool.name)).toEqual(ANDROID_TOOL_NAMES);
    expect(provider.listTools()).toHaveLength(8);
    expect(provider.listTools().every((tool) => tool.annotations.openWorldHint === false)).toBe(true);
  });

  it("projects status and device lists to the snake-case protocol", async () => {
    const provider = providerWith();

    const status = textPayload(await provider.callTool("session-a", "status", {}));
    expect(status).toEqual({
      ok: true,
      data: {
        adb_available: true,
        adb_path: "adb",
        adb_path_source: "fallback",
        adb_preparation: {
          supported: true,
          ready: true,
          platform: `linux-${process.arch}`,
          path: "adb",
          source: "fallback"
        },
        version: "Android Debug Bridge 35",
        devices: [{ device_serial: READY_DEVICE.serial, state: "device", model: "Pixel" }],
        default_device_serial: READY_DEVICE.serial,
        configured_default_device_serial: null,
        issue: null
      }
    });

    expect(textPayload(await provider.callTool("session-a", "list_devices", {}))).toEqual({
      ok: true,
      data: [{ device_serial: READY_DEVICE.serial, state: "device", model: "Pixel" }]
    });
  });

  it("returns projected snapshot text plus an image without paths or duplicated base64", async () => {
    const provider = providerWith();

    const result = await provider.callTool("session-a", "get_device_state", {});
    const payload = textPayload(result);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toEqual({ type: "image", data: "iVBORw==", mimeType: "image/png" });
    expect(payload).toEqual({
      ok: true,
      data: {
        device_serial: READY_DEVICE.serial,
        screen: { width: 1080, height: 2400, density: 420 },
        current_app: { package: "com.example.app", activity: ".MainActivity" },
        nodes: [{
          index: 1,
          text: "Continue",
          content_desc: "Continue action",
          class_name: "android.widget.Button",
          resource_id: "com.example.app:id/continue",
          package: "com.example.app",
          bounds: { x1: 10, y1: 100, x2: 110, y2: 140 },
          clickable: true,
          enabled: true,
          long_clickable: false
        }]
      }
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain("iVBORw==");
    expect(text).not.toContain("screenshot_file_path");
    expect(text).not.toContain("raw_ui_dump_file_path");
    expect(text).not.toContain("deviceSerial");
  });

  it("uses uppercase error codes and nests safe messages in data", async () => {
    const provider = providerWith();

    const unknown = await provider.callTool("session-a", "connect_device", { endpoint: "example.test:5555" });
    expect(unknown.isError).toBe(true);
    expect(textPayload(unknown)).toMatchObject({
      ok: false,
      errorCode: "UNKNOWN_TOOL",
      data: { message: "Android automation tool is unavailable." }
    });
    expect(textPayload(unknown)).not.toHaveProperty("message");

    const unsupported = await provider.callTool("session-a", "status", { unexpected: true });
    expect(textPayload(unsupported)).toMatchObject({
      ok: false,
      errorCode: "ANDROID_DRIVER_ERROR",
      data: { message: expect.any(String) }
    });
    const incompleteTap = await provider.callTool("session-a", "tap", { x: 1 });
    expect(textPayload(incompleteTap)).toMatchObject({
      ok: false,
      errorCode: "ANDROID_DRIVER_ERROR",
      data: { message: expect.any(String) }
    });
  });

  it("returns missing ADB status as a business error with preparation context", async () => {
    const provider = providerWith({
      probe: vi.fn(async () => { throw new Error("adb executable was not found"); })
    });

    const result = await provider.callTool("session-a", "status", {});
    expect(result.isError).toBe(true);
    expect(textPayload(result)).toEqual({
      ok: false,
      errorCode: "ADB_NOT_FOUND",
      data: {
        adb_preparation: {
          supported: true,
          ready: false,
          platform: `linux-${process.arch}`,
          path: null,
          source: null
        },
        adb_path_source: "fallback",
        configured_default_device_serial: null,
        message: "adb executable was not found"
      }
    });
  });

  it("accepts zero in the public node-index schema and reports it as INVALID_NODE", async () => {
    const provider = providerWith();
    const tap = provider.listTools().find(({ name }) => name === "tap");
    expect(tap?.inputSchema).toMatchObject({
      properties: { element_index: { type: "integer", minimum: 0 } }
    });

    const result = await provider.callTool("session-a", "tap", { element_index: 0 });
    expect(textPayload(result)).toMatchObject({
      ok: false,
      errorCode: "INVALID_NODE",
      data: { message: expect.any(String) }
    });
  });

  it("projects action results without echoing input text", async () => {
    const provider = providerWith();

    expect(textPayload(await provider.callTool("session-a", "tap", { x: 10, y: 20 }))).toEqual({
      ok: true,
      data: { device_serial: READY_DEVICE.serial, x: 10, y: 20 }
    });
    expect(textPayload(await provider.callTool("session-a", "swipe", {
      start: { x: 10, y: 20 },
      end: { x: 30, y: 40 },
      duration_ms: 250
    }))).toEqual({
      ok: true,
      data: {
        device_serial: READY_DEVICE.serial,
        start: { x: 10, y: 20 },
        end: { x: 30, y: 40 },
        duration_ms: 250
      }
    });

    const input = await provider.callTool("session-a", "input_text", { text: "private value" });
    expect(JSON.stringify(input)).not.toContain("private value");
    expect(textPayload(input)).toEqual({
      ok: true,
      data: { device_serial: READY_DEVICE.serial, character_count: 13 }
    });
    expect(textPayload(await provider.callTool("session-a", "press_key", { key: "BACK" }))).toEqual({
      ok: true,
      data: { device_serial: READY_DEVICE.serial, key: "BACK", key_code: 4 }
    });
    expect(textPayload(await provider.callTool("session-a", "launch_app", {
      package: "com.example.app"
    }))).toEqual({
      ok: true,
      data: {
        device_serial: READY_DEVICE.serial,
        package: "com.example.app",
        activity: null,
        output: "started"
      }
    });
  });

  it("keeps node-index taps session-scoped and closeSession invalidates the cache", async () => {
    const provider = providerWith();
    await provider.callTool("session-a", "get_device_state", {});

    expect(textPayload(await provider.callTool("session-b", "tap", { element_index: 1 })))
      .toMatchObject({ ok: false, errorCode: "INVALID_NODE" });
    provider.closeSession("session-a");
    expect(textPayload(await provider.callTool("session-a", "tap", { element_index: 1 })))
      .toMatchObject({ ok: false, errorCode: "INVALID_NODE" });
  });

  it("compresses large screenshots and bounds the entire streamed result", async () => {
    const width = 900;
    const height = 900;
    const png = await sharp(randomBytes(width * height * 3), {
      raw: { width, height, channels: 3 }
    }).png().toBuffer();
    expect(png.byteLength).toBeGreaterThan(140_000);
    const nodes = verboseNodes(200);
    const provider = providerWith({
      snapshot: {
        ...snapshot(),
        screen: { width, height, density: 420 },
        screenshot: {
          mimeType: "image/png",
          dataBase64: png.toString("base64"),
          byteLength: png.byteLength
        },
        nodes
      }
    });

    const result = await provider.callTool("session-a", "get_device_state", {});
    const image = result.content[1] as { type: string; data: string; mimeType: string };
    const payload = textPayload(result) as {
      data: { nodes: Array<{ text?: string; content_desc?: string }>; nodes_truncated?: boolean }
    };

    expect(result.isError).toBeUndefined();
    expect(image.type).toBe("image");
    expect(image.mimeType).toBe("image/jpeg");
    expect(Buffer.from(image.data, "base64").byteLength).toBeLessThanOrEqual(140_000);
    expect(Buffer.byteLength(JSON.stringify(result.content), "utf8")).toBeLessThanOrEqual(240_000);
    expect(payload.data.nodes_truncated).toBe(true);
    expect(payload.data.nodes.length).toBeLessThan(nodes.length);
    expect(payload.data.nodes[0]?.text?.length).toBeLessThan(nodes[0]?.text?.length ?? 0);
    expect(payload.data.nodes[0]?.content_desc?.length)
      .toBeLessThan(nodes[0]?.contentDescription?.length ?? 0);
  });

  it("shares the stream budget between a near-limit image and node text", async () => {
    const image = randomBytes(139_999);
    const provider = providerWith({
      snapshot: {
        ...snapshot(),
        screenshot: {
          mimeType: "image/png",
          dataBase64: image.toString("base64"),
          byteLength: image.byteLength
        },
        nodes: verboseNodes(200)
      }
    });

    const result = await provider.callTool("session-a", "get_device_state", {});
    const payload = textPayload(result) as { data: { nodes: unknown[]; nodes_truncated?: boolean } };
    expect(Buffer.byteLength(JSON.stringify(result.content), "utf8")).toBeLessThanOrEqual(240_000);
    expect(payload.data.nodes_truncated).toBe(true);
    expect(payload.data.nodes.length).toBeLessThan(200);
  });

  it("fails closed when an oversized screenshot cannot be decoded", async () => {
    const invalid = randomBytes(140_001);
    const provider = providerWith({
      snapshot: {
        ...snapshot(),
        screenshot: {
          mimeType: "image/png",
          dataBase64: invalid.toString("base64"),
          byteLength: invalid.byteLength
        }
      }
    });

    const result = await provider.callTool("session-a", "get_device_state", {});
    expect(result.content).toHaveLength(1);
    expect(textPayload(result)).toEqual({
      ok: false,
      errorCode: "SCREENSHOT_FAILED",
      data: { message: "Android screenshot could not be prepared for inline delivery." }
    });
  });
});

function textPayload(result: AndroidToolCallResult): any {
  const first = result.content[0];
  if (first?.type !== "text") throw new Error("Android result is missing its text payload.");
  return JSON.parse(first.text);
}

function providerWith(options: {
  readonly snapshot?: AndroidDeviceSnapshot;
  readonly probe?: AndroidAdbAdapter["probe"];
  readonly listDevices?: AndroidAdbAdapter["listDevices"];
} = {}): AndroidToolProvider {
  const adapter: AndroidAdbAdapter = {
    probe: options.probe ?? vi.fn(async () => "Android Debug Bridge 35"),
    listDevices: options.listDevices ?? vi.fn(async () => [READY_DEVICE]),
    startServer: vi.fn(async () => undefined),
    killServer: vi.fn(async () => undefined),
    connect: vi.fn(async (endpoint) => ({ endpoint, output: "connected" })),
    disconnect: vi.fn(async (endpoint) => ({ endpoint, output: "disconnected" })),
    snapshot: vi.fn(async () => options.snapshot ?? snapshot()),
    tap: vi.fn(async () => undefined),
    swipe: vi.fn(async () => undefined),
    inputText: vi.fn(async () => undefined),
    pressKey: vi.fn(async () => 4),
    launchApp: vi.fn(async () => "started"),
    installArtifact: vi.fn(async () => "Success")
  };
  return new AndroidToolProvider({
    runtime: new AndroidAutomationRuntime({
      platform: "linux",
      executablePath: "adb",
      pathSource: "fallback",
      environment: {},
      adapter,
      portProbe: async () => true
    })
  });
}

function snapshot(): AndroidDeviceSnapshot {
  return {
    deviceSerial: READY_DEVICE.serial,
    screen: { width: 1080, height: 2400, density: 420 },
    currentApp: { packageName: "com.example.app", activity: ".MainActivity" },
    screenshot: { mimeType: "image/png", dataBase64: "iVBORw==", byteLength: 4 },
    nodes: [{
      index: 1,
      text: "Continue",
      contentDescription: "Continue action",
      className: "android.widget.Button",
      resourceId: "com.example.app:id/continue",
      packageName: "com.example.app",
      bounds: { x1: 10, y1: 100, x2: 110, y2: 140 },
      clickable: true,
      enabled: true,
      longClickable: false
    }],
    nodesTruncated: false,
    capturedAt: 0
  };
}

function verboseNodes(count: number): AndroidDeviceSnapshot["nodes"] {
  const longText = "node-text-".repeat(1_200);
  return Array.from({ length: count }, (_, index) => ({
    index: index + 1,
    text: longText,
    contentDescription: longText,
    resourceId: `com.example.app:id/${longText}`,
    className: `android.widget.${longText}`,
    packageName: `com.example.app.${longText}`,
    bounds: { x1: 0, y1: index, x2: 100, y2: index + 10 },
    clickable: true,
    enabled: true
  }));
}
