import sharp from "sharp";

import { redactAndroidOutput } from "./redaction.js";
import {
  AndroidAutomationRuntime,
  type AndroidLaunchAppInput,
  type AndroidPressKeyInput,
  type AndroidSwipeInput,
  type AndroidTapInput
} from "./runtime.js";
import {
  AndroidRuntimeError,
  type AndroidAdbPathSource,
  type AndroidConnectedDevice,
  type AndroidDeviceSnapshot,
  type AndroidKey,
  type AndroidPoint,
  type AndroidRuntimeErrorCode,
  type AndroidRuntimeIssue,
  type AndroidRuntimeStatus,
  type AndroidUiNode
} from "./types.js";

const INLINE_IMAGE_TARGET_BYTES = 140_000;
const MAXIMUM_STATE_TEXT_BYTES = INLINE_IMAGE_TARGET_BYTES;
const MAXIMUM_TOOL_RESULT_STREAM_BYTES = 240_000;
const TOOL_RESULT_ENVELOPE_BYTES = 4_096;
const MAXIMUM_NODE_STRING_CHARACTERS = 160;
const INLINE_SCREENSHOT_SIDES = [1280, 1024, 800, 640, 480, 360, 240] as const;
const INLINE_SCREENSHOT_QUALITIES = [72, 60, 48, 36, 28, 20] as const;

export const ANDROID_TOOL_NAMES = [
  "status",
  "list_devices",
  "get_device_state",
  "tap",
  "swipe",
  "input_text",
  "press_key",
  "launch_app"
] as const;

export type AndroidToolName = (typeof ANDROID_TOOL_NAMES)[number];

export interface AndroidToolDescriptor {
  readonly name: AndroidToolName;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly openWorldHint: false;
  };
}

export type AndroidToolContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: "image/png" | "image/jpeg" };

export interface AndroidToolCallResult {
  readonly content: readonly AndroidToolContent[];
  readonly isError?: boolean;
  readonly structuredContent?: Readonly<Record<string, unknown>>;
}

export class AndroidToolProvider {
  readonly #runtime: AndroidAutomationRuntime;

  constructor(options: { readonly runtime: AndroidAutomationRuntime }) {
    this.#runtime = options.runtime;
  }

  listTools(): readonly AndroidToolDescriptor[] {
    return TOOL_DESCRIPTORS;
  }

  async callTool(
    sessionId: string,
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
    signal?: AbortSignal
  ): Promise<AndroidToolCallResult> {
    if (!isAndroidToolName(name)) {
      return errorResult("Android automation tool is unavailable.", "UNKNOWN_TOOL", {
        requested: name,
        available: ANDROID_TOOL_NAMES
      });
    }
    try {
      switch (name) {
        case "status": {
          assertNoArguments(arguments_);
          const status = await this.#runtime.status(signal);
          if (status.installation.state !== "installed") {
            return errorResult(
              status.error ?? (status.installation.state === "unsupported"
                ? "Android automation is unavailable on this platform."
                : "ADB is unavailable."),
              mapRuntimeIssue(status.issue),
              {
                adb_preparation: projectAdbPreparation(status),
                adb_path_source: projectAdbPathSource(status.installation.pathSource),
                configured_default_device_serial: status.configuredDefaultDeviceSerial ?? null
              }
            );
          }
          return textResult(projectStatus(status));
        }
        case "list_devices":
          assertNoArguments(arguments_);
          return textResult((await this.#runtime.listDevices(signal)).map(projectDevice));
        case "get_device_state": {
          assertOnlyKeys(arguments_, ["device_serial"]);
          const snapshot = await this.#runtime.snapshot({
            sessionId,
            ...optionalDeviceSerial(arguments_),
            signal
          });
          return stateResult(snapshot);
        }
        case "tap": {
          assertOnlyKeys(arguments_, ["device_serial", "element_index", "x", "y"]);
          const input: AndroidTapInput = {
            sessionId,
            ...optionalDeviceSerial(arguments_),
            ...tapTarget(arguments_),
            signal
          };
          const result = await this.#runtime.tap(input);
          return textResult({
            device_serial: result.deviceSerial,
            x: result.point.x,
            y: result.point.y
          });
        }
        case "swipe": {
          assertOnlyKeys(arguments_, ["device_serial", "start", "end", "duration_ms"]);
          const input: AndroidSwipeInput = {
            sessionId,
            ...optionalDeviceSerial(arguments_),
            start: requiredPoint(arguments_, "start"),
            end: requiredPoint(arguments_, "end"),
            ...(arguments_["duration_ms"] === undefined ? {} : {
              durationMs: requiredInteger(arguments_, "duration_ms", 0, 60_000)
            }),
            signal
          };
          const result = await this.#runtime.swipe(input);
          return textResult({
            device_serial: result.deviceSerial,
            start: result.start,
            end: result.end,
            duration_ms: result.durationMs
          });
        }
        case "input_text": {
          assertOnlyKeys(arguments_, ["device_serial", "text"]);
          const text = requiredString(arguments_, "text", 4_096);
          const result = await this.#runtime.inputText({
            sessionId,
            ...optionalDeviceSerial(arguments_),
            text,
            signal
          });
          return textResult({
            device_serial: result.deviceSerial,
            character_count: result.characterCount
          });
        }
        case "press_key": {
          assertOnlyKeys(arguments_, ["device_serial", "key"]);
          const input: AndroidPressKeyInput = {
            sessionId,
            ...optionalDeviceSerial(arguments_),
            key: requiredKey(arguments_),
            signal
          };
          const result = await this.#runtime.pressKey(input);
          return textResult({
            device_serial: result.deviceSerial,
            key: result.key,
            key_code: result.keyCode
          });
        }
        case "launch_app": {
          assertOnlyKeys(arguments_, ["device_serial", "package", "activity"]);
          const input: AndroidLaunchAppInput = {
            sessionId,
            ...optionalDeviceSerial(arguments_),
            packageName: requiredString(arguments_, "package", 512),
            ...(arguments_["activity"] === undefined ? {} : {
              activity: requiredString(arguments_, "activity", 512)
            }),
            signal
          };
          const result = await this.#runtime.launchApp(input);
          const output = result.output.trim();
          return textResult({
            device_serial: result.deviceSerial,
            package: result.packageName,
            activity: result.activity ?? null,
            output: output === "" ? null : redactAndroidOutput(output)
          });
        }
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      return errorResult(
        redactAndroidOutput(error instanceof Error ? error.message : String(error)).slice(0, 2_048),
        error instanceof AndroidRuntimeError ? mapRuntimeError(error.code) : "ANDROID_DRIVER_ERROR"
      );
    }
  }

  closeSession(sessionId: string): void {
    this.#runtime.closeSession(sessionId);
  }
}

const TOOL_DESCRIPTORS: readonly AndroidToolDescriptor[] = Object.freeze([
  descriptor("status", "Check whether adb is installed and summarize current Android device availability.", {}, true),
  descriptor("list_devices", "List all adb-visible Android devices and emulators with their current states.", {}, true),
  descriptor(
    "get_device_state",
    "Capture a screenshot, current app, screen size, and compact UI node list for one Android device.",
    objectSchema({ device_serial: stringSchema(1, 255) }),
    true
  ),
  descriptor(
    "tap",
    "Tap by element_index from the latest device snapshot or by absolute screen coordinates.",
    objectSchema({
      device_serial: stringSchema(1, 255),
      element_index: integerSchema(0),
      x: integerSchema(0),
      y: integerSchema(0)
    }),
    false
  ),
  descriptor(
    "swipe",
    "Swipe between absolute screen coordinates on one Android device.",
    objectSchema({
      device_serial: stringSchema(1, 255),
      start: pointSchema(),
      end: pointSchema(),
      duration_ms: integerSchema(0, 60_000)
    }, ["start", "end"]),
    false
  ),
  descriptor(
    "input_text",
    "Enter restricted plain text into the focused field; text is never echoed in results.",
    objectSchema({ device_serial: stringSchema(1, 255), text: stringSchema(1, 4_096) }, ["text"]),
    false
  ),
  descriptor(
    "press_key",
    "Send one Android keyevent such as BACK, HOME, ENTER, or APP_SWITCH.",
    objectSchema({
      device_serial: stringSchema(1, 255),
      key: { type: "string", enum: [
        "BACK",
        "HOME",
        "ENTER",
        "APP_SWITCH",
        "POWER",
        "DPAD_UP",
        "DPAD_DOWN",
        "DPAD_LEFT",
        "DPAD_RIGHT",
        "DPAD_CENTER"
      ] }
    }, ["key"]),
    false
  ),
  descriptor(
    "launch_app",
    "Launch an Android app by package name and optional activity. Arbitrary intents are not supported.",
    objectSchema({
      device_serial: stringSchema(1, 255),
      package: stringSchema(1, 512),
      activity: stringSchema(1, 512)
    }, ["package"]),
    false
  )
]);

function descriptor(
  name: AndroidToolName,
  description: string,
  inputSchema: Readonly<Record<string, unknown>>,
  readOnlyHint: boolean
): AndroidToolDescriptor {
  return {
    name,
    description,
    inputSchema: Object.keys(inputSchema).length === 0 ? objectSchema({}) : inputSchema,
    annotations: { readOnlyHint, destructiveHint: false, openWorldHint: false }
  };
}

function textResult(value: unknown): AndroidToolCallResult {
  const payload = { ok: true, data: value };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }]
  };
}

type AndroidProviderErrorCode =
  | "ADB_NOT_FOUND"
  | "ANDROID_DRIVER_ERROR"
  | "DEVICE_OFFLINE"
  | "DEVICE_UNAUTHORIZED"
  | "INVALID_ARGS"
  | "INVALID_NODE"
  | "MULTIPLE_DEVICES"
  | "NO_DEVICE"
  | "SCREENSHOT_FAILED"
  | "UNKNOWN_TOOL";

function errorResult(
  message: string,
  code: AndroidProviderErrorCode,
  details: Readonly<Record<string, unknown>> = {}
): AndroidToolCallResult {
  const payload = {
    ok: false,
    errorCode: code,
    data: { ...details, message }
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: true
  };
}

function projectStatus(status: AndroidRuntimeStatus): Readonly<Record<string, unknown>> {
  return {
    adb_available: status.installation.state === "installed",
    adb_path: status.installation.executablePath ?? null,
    adb_path_source: projectAdbPathSource(status.installation.pathSource),
    adb_preparation: projectAdbPreparation(status),
    version: status.installation.version ?? null,
    devices: status.devices.map(projectDevice),
    default_device_serial: status.selectedDeviceSerial ?? null,
    configured_default_device_serial: status.configuredDefaultDeviceSerial ?? null,
    issue: status.issue === undefined ? null : mapRuntimeIssue(status.issue),
    ...(status.error === undefined ? {} : { error: status.error })
  };
}

function projectAdbPreparation(status: AndroidRuntimeStatus): Readonly<Record<string, unknown>> {
  const preparation = status.installation.preparation;
  const ready = preparation?.ready ?? status.installation.state === "installed";
  return {
    supported: preparation?.supported ?? status.supported,
    ready,
    platform: `${status.platform}-${status.architecture}`,
    path: ready
      ? preparation?.executablePath ?? status.installation.executablePath ?? null
      : null,
    source: ready ? projectAdbPathSource(status.installation.pathSource) : null,
    ...(preparation?.error === undefined ? {} : { error: preparation.error })
  };
}

function projectAdbPathSource(source: AndroidAdbPathSource): string {
  return source === "environment" ? "env" : source;
}

function projectDevice(device: AndroidConnectedDevice): Readonly<Record<string, unknown>> {
  return {
    device_serial: device.serial,
    state: device.state,
    ...(device.product === undefined ? {} : { product: device.product }),
    ...(device.model === undefined ? {} : { model: device.model }),
    ...(device.device === undefined ? {} : { device: device.device }),
    ...(device.transportId === undefined ? {} : { transport_id: device.transportId }),
    ...(device.usb === undefined ? {} : { usb: device.usb })
  };
}

function mapRuntimeIssue(issue: AndroidRuntimeIssue | undefined): AndroidProviderErrorCode {
  switch (issue) {
    case "adb_not_found": return "ADB_NOT_FOUND";
    case "device_offline": return "DEVICE_OFFLINE";
    case "device_unauthorized": return "DEVICE_UNAUTHORIZED";
    case "multiple_devices": return "MULTIPLE_DEVICES";
    case "no_device": return "NO_DEVICE";
    case "unsupported_platform":
    case undefined:
      return "ANDROID_DRIVER_ERROR";
  }
}

function mapRuntimeError(code: AndroidRuntimeErrorCode): AndroidProviderErrorCode {
  switch (code) {
    case "adb_not_found": return "ADB_NOT_FOUND";
    case "device_offline": return "DEVICE_OFFLINE";
    case "device_unauthorized": return "DEVICE_UNAUTHORIZED";
    case "invalid_node": return "INVALID_NODE";
    case "multiple_devices": return "MULTIPLE_DEVICES";
    case "no_device": return "NO_DEVICE";
    case "snapshot_failed": return "SCREENSHOT_FAILED";
    case "artifact_invalid":
    case "artifact_outside_roots":
    case "artifact_too_large":
    case "command_failed":
    case "invalid_coordinate":
    case "invalid_device_serial":
    case "invalid_endpoint":
    case "invalid_session":
    case "server_not_owned":
    case "unsafe_input":
    case "unsupported_key":
    case "unsupported_platform":
      return "ANDROID_DRIVER_ERROR";
  }
}

interface ProjectedUiNode {
  readonly index: number;
  readonly text?: string;
  readonly content_desc?: string;
  readonly class_name?: string;
  readonly resource_id?: string;
  readonly package?: string;
  readonly bounds: AndroidUiNode["bounds"];
  readonly clickable: boolean;
  readonly enabled: boolean;
  readonly focusable?: boolean;
  readonly long_clickable?: boolean;
  readonly scrollable?: boolean;
  readonly checked?: boolean;
  readonly selected?: boolean;
}

interface AndroidStatePayload {
  readonly ok: true;
  readonly data: {
    readonly device_serial: string;
    readonly screen: AndroidDeviceSnapshot["screen"];
    readonly current_app: {
      readonly package: string | null;
      readonly activity: string | null;
    };
    readonly nodes: readonly ProjectedUiNode[];
    readonly nodes_truncated?: true;
    readonly ui_dump_error?: string;
  };
}

interface InlineScreenshot {
  readonly data: string;
  readonly mimeType: "image/png" | "image/jpeg";
}

async function stateResult(snapshot: AndroidDeviceSnapshot): Promise<AndroidToolCallResult> {
  let screenshot: InlineScreenshot;
  try {
    screenshot = await compressInlineScreenshot(snapshot);
  } catch {
    return errorResult(
      "Android screenshot could not be prepared for inline delivery.",
      "SCREENSHOT_FAILED"
    );
  }
  const payload = buildBoundedStatePayload(snapshot, stateTextBudgetFor(screenshot));
  return {
    content: [
      { type: "text", text: JSON.stringify(payload) },
      { type: "image", data: screenshot.data, mimeType: screenshot.mimeType }
    ]
  };
}

async function compressInlineScreenshot(snapshot: AndroidDeviceSnapshot): Promise<InlineScreenshot> {
  const original = Buffer.from(snapshot.screenshot.dataBase64, "base64");
  if (original.byteLength === 0) throw new Error("empty screenshot");
  if (original.byteLength <= INLINE_IMAGE_TARGET_BYTES) {
    return { data: snapshot.screenshot.dataBase64, mimeType: snapshot.screenshot.mimeType };
  }

  let smallest: Buffer | undefined;
  for (const side of INLINE_SCREENSHOT_SIDES) {
    for (const quality of INLINE_SCREENSHOT_QUALITIES) {
      const resized = await sharp(original, { failOn: "none", limitInputPixels: 40_000_000 })
        .rotate()
        .resize({
          width: side,
          height: side,
          fit: "inside",
          withoutEnlargement: true
        })
        .jpeg({ quality })
        .toBuffer();
      if (smallest === undefined || resized.byteLength < smallest.byteLength) smallest = resized;
      if (resized.byteLength <= INLINE_IMAGE_TARGET_BYTES) {
        return { data: resized.toString("base64"), mimeType: "image/jpeg" };
      }
    }
  }
  if (smallest === undefined || smallest.byteLength > INLINE_IMAGE_TARGET_BYTES) {
    throw new Error("screenshot exceeds inline budget");
  }
  return { data: smallest.toString("base64"), mimeType: "image/jpeg" };
}

function buildBoundedStatePayload(
  snapshot: AndroidDeviceSnapshot,
  maximumTextBytes = MAXIMUM_STATE_TEXT_BYTES
): AndroidStatePayload {
  const compacted = snapshot.nodes.map(compactUiNode);
  const nodes = compacted.map(({ node }) => node);
  const baseTruncated = snapshot.nodesTruncated || compacted.some(({ truncated }) => truncated);
  const full = buildStatePayload(snapshot, nodes, baseTruncated);
  if (payloadBytes(full) <= maximumTextBytes) return full;

  let low = 0;
  let high = nodes.length;
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = buildStatePayload(snapshot, nodes.slice(0, middle), true);
    if (payloadBytes(candidate) <= maximumTextBytes) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return buildStatePayload(snapshot, nodes.slice(0, best), true);
}

function buildStatePayload(
  snapshot: AndroidDeviceSnapshot,
  nodes: readonly ProjectedUiNode[],
  nodesTruncated: boolean
): AndroidStatePayload {
  return {
    ok: true,
    data: {
      device_serial: snapshot.deviceSerial,
      screen: snapshot.screen,
      current_app: {
        package: snapshot.currentApp.packageName,
        activity: snapshot.currentApp.activity
      },
      nodes,
      ...(nodesTruncated ? { nodes_truncated: true as const } : {}),
      ...(snapshot.uiDumpError === undefined ? {} : {
        ui_dump_error: redactAndroidOutput(snapshot.uiDumpError).slice(0, 2_048)
      })
    }
  };
}

function compactUiNode(node: AndroidUiNode): { readonly node: ProjectedUiNode; readonly truncated: boolean } {
  const text = truncateNodeString(node.text);
  const contentDescription = truncateNodeString(node.contentDescription);
  const className = truncateNodeString(node.className);
  const resourceId = truncateNodeString(node.resourceId);
  const packageName = truncateNodeString(node.packageName);
  return {
    node: {
      index: node.index,
      ...(text.value === undefined ? {} : { text: text.value }),
      ...(contentDescription.value === undefined ? {} : { content_desc: contentDescription.value }),
      ...(className.value === undefined ? {} : { class_name: className.value }),
      ...(resourceId.value === undefined ? {} : { resource_id: resourceId.value }),
      ...(packageName.value === undefined ? {} : { package: packageName.value }),
      bounds: node.bounds,
      clickable: node.clickable,
      enabled: node.enabled,
      ...(node.focusable === undefined ? {} : { focusable: node.focusable }),
      ...(node.longClickable === undefined ? {} : { long_clickable: node.longClickable }),
      ...(node.scrollable === undefined ? {} : { scrollable: node.scrollable }),
      ...(node.checked === undefined ? {} : { checked: node.checked }),
      ...(node.selected === undefined ? {} : { selected: node.selected })
    },
    truncated: text.truncated
      || contentDescription.truncated
      || className.truncated
      || resourceId.truncated
      || packageName.truncated
  };
}

function truncateNodeString(value: string | undefined): { readonly value?: string; readonly truncated: boolean } {
  if (value === undefined || value.length <= MAXIMUM_NODE_STRING_CHARACTERS) {
    return { value, truncated: false };
  }
  return {
    value: `${value.slice(0, MAXIMUM_NODE_STRING_CHARACTERS)}...`,
    truncated: true
  };
}

function payloadBytes(payload: AndroidStatePayload): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

function stateTextBudgetFor(screenshot: InlineScreenshot): number {
  const imageBlockBytes = Buffer.byteLength(screenshot.data, "utf8")
    + Buffer.byteLength(screenshot.mimeType, "utf8");
  return Math.max(
    0,
    Math.min(
      MAXIMUM_STATE_TEXT_BYTES,
      MAXIMUM_TOOL_RESULT_STREAM_BYTES - TOOL_RESULT_ENVELOPE_BYTES - imageBlockBytes
    )
  );
}

function isAndroidToolName(value: string): value is AndroidToolName {
  return (ANDROID_TOOL_NAMES as readonly string[]).includes(value);
}

function assertNoArguments(value: Readonly<Record<string, unknown>>): void {
  assertOnlyKeys(value, []);
}

function assertOnlyKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new AndroidRuntimeError("unsafe_input", "Android tool arguments contain an unsupported field.");
  }
}

function optionalDeviceSerial(value: Readonly<Record<string, unknown>>): { readonly deviceSerial?: string } {
  return value["device_serial"] === undefined
    ? {}
    : { deviceSerial: requiredString(value, "device_serial", 255) };
}

function tapTarget(value: Readonly<Record<string, unknown>>): Pick<AndroidTapInput, "elementIndex" | "point"> {
  const hasIndex = value["element_index"] !== undefined;
  const hasX = value["x"] !== undefined;
  const hasY = value["y"] !== undefined;
  if (hasIndex && !hasX && !hasY) return { elementIndex: requiredInteger(value, "element_index", 0) };
  if (!hasIndex && hasX && hasY) {
    return { point: { x: requiredInteger(value, "x", 0), y: requiredInteger(value, "y", 0) } };
  }
  throw new AndroidRuntimeError("invalid_coordinate", "Tap requires a node index or both x and y.");
}

function requiredPoint(value: Readonly<Record<string, unknown>>, key: string): AndroidPoint {
  const point = value[key];
  if (!isRecord(point)) throw new AndroidRuntimeError("invalid_coordinate", `Android ${key} point is invalid.`);
  assertOnlyKeys(point, ["x", "y"]);
  return { x: requiredInteger(point, "x", 0), y: requiredInteger(point, "y", 0) };
}

function requiredString(value: Readonly<Record<string, unknown>>, key: string, maximumLength: number): string {
  const item = value[key];
  if (typeof item !== "string" || item.trim() === "" || item.length > maximumLength || item.includes("\0")) {
    throw new AndroidRuntimeError("unsafe_input", `Android ${key} argument is invalid.`);
  }
  return item;
}

function requiredInteger(
  value: Readonly<Record<string, unknown>>,
  key: string,
  minimum: number,
  maximum = 1_000_000
): number {
  const item = value[key];
  if (!Number.isSafeInteger(item) || (item as number) < minimum || (item as number) > maximum) {
    throw new AndroidRuntimeError("unsafe_input", `Android ${key} argument is invalid.`);
  }
  return item as number;
}

function requiredKey(value: Readonly<Record<string, unknown>>): AndroidKey {
  const key = requiredString(value, "key", 32);
  const allowed: readonly AndroidKey[] = [
    "BACK", "HOME", "ENTER", "APP_SWITCH", "POWER", "DPAD_UP",
    "DPAD_DOWN", "DPAD_LEFT", "DPAD_RIGHT", "DPAD_CENTER"
  ];
  if (!(allowed as readonly string[]).includes(key)) {
    throw new AndroidRuntimeError("unsupported_key", "Android key is not supported.");
  }
  return key as AndroidKey;
}

function objectSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = []
): Readonly<Record<string, unknown>> {
  return {
    type: "object",
    properties,
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: false
  };
}

function stringSchema(minLength: number, maxLength: number): Readonly<Record<string, unknown>> {
  return { type: "string", minLength, maxLength };
}

function integerSchema(minimum: number, maximum?: number): Readonly<Record<string, unknown>> {
  return { type: "integer", minimum, ...(maximum === undefined ? {} : { maximum }) };
}

function pointSchema(): Readonly<Record<string, unknown>> {
  return objectSchema({ x: integerSchema(0), y: integerSchema(0) }, ["x", "y"]);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === "AbortError";
}
