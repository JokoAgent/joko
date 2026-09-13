import { realpath as nodeRealpath, stat as nodeStat } from "node:fs/promises";
import { isIP } from "node:net";
import { extname, isAbsolute, relative, resolve } from "node:path";

import {
  AndroidProcessError,
  type AndroidCommandResult,
  type AndroidCommandRunner
} from "./process-runner.js";
import { redactAndroidOutput, redactAndroidUiValue } from "./redaction.js";
import {
  AndroidRuntimeError,
  type AndroidConnectedDevice,
  type AndroidCurrentAppState,
  type AndroidDeviceSnapshot,
  type AndroidInstallOptions,
  type AndroidKey,
  type AndroidPoint,
  type AndroidScreenState,
  type AndroidUiBounds,
  type AndroidUiNode
} from "./types.js";

const DEFAULT_STATUS_TIMEOUT_MS = 3_000;
const DEFAULT_ACTION_TIMEOUT_MS = 20_000;
const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAXIMUM_APK_BYTES = 4 * 1024 * 1024 * 1024;
const MAXIMUM_UI_NODES = 200;
const MAXIMUM_SCREENSHOT_BYTES = 24 * 1024 * 1024;
const SAFE_INPUT_TEXT = /^[A-Za-z0-9 .,:@/_+=%+-]+$/u;
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u;
const ACTIVITY_NAME = /^(?:\.[A-Za-z0-9_.]+|[A-Za-z][A-Za-z0-9_]*\.[A-Za-z0-9_.]+)$/u;

const KEY_CODES: Readonly<Record<AndroidKey, number>> = Object.freeze({
  APP_SWITCH: 187,
  BACK: 4,
  DPAD_CENTER: 23,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  DPAD_UP: 19,
  ENTER: 66,
  HOME: 3,
  POWER: 26
});

export interface AndroidArtifactStat {
  readonly size: number;
  isFile(): boolean;
}

export interface AndroidArtifactFileSystem {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<AndroidArtifactStat>;
}

export interface AndroidAdbAdapter {
  probe(signal?: AbortSignal): Promise<string>;
  listDevices(signal?: AbortSignal): Promise<readonly AndroidConnectedDevice[]>;
  startServer(signal?: AbortSignal): Promise<void>;
  killServer(signal?: AbortSignal): Promise<void>;
  connect(endpoint: string, signal?: AbortSignal): Promise<{ readonly endpoint: string; readonly output: string }>;
  disconnect(endpoint: string, signal?: AbortSignal): Promise<{ readonly endpoint: string; readonly output: string }>;
  snapshot(serial: string, signal?: AbortSignal): Promise<AndroidDeviceSnapshot>;
  tap(serial: string, point: AndroidPoint, signal?: AbortSignal): Promise<void>;
  swipe(
    serial: string,
    start: AndroidPoint,
    end: AndroidPoint,
    durationMs: number,
    signal?: AbortSignal
  ): Promise<void>;
  inputText(serial: string, text: string, signal?: AbortSignal): Promise<void>;
  pressKey(serial: string, key: AndroidKey, signal?: AbortSignal): Promise<number>;
  launchApp(
    serial: string,
    packageName: string,
    activity?: string,
    signal?: AbortSignal
  ): Promise<string>;
  installArtifact(
    serial: string,
    artifactPath: string,
    options?: AndroidInstallOptions,
    signal?: AbortSignal
  ): Promise<string>;
}

export interface AdbCliAdapterOptions {
  readonly executablePath: string;
  readonly runner: AndroidCommandRunner;
  readonly artifactRoots?: readonly string[];
  readonly fileSystem?: AndroidArtifactFileSystem;
  readonly statusTimeoutMs?: number;
  readonly actionTimeoutMs?: number;
  readonly installTimeoutMs?: number;
  readonly maximumApkBytes?: number;
  readonly now?: () => number;
}

export class AdbCliAdapter implements AndroidAdbAdapter {
  readonly #executablePath: string;
  readonly #runner: AndroidCommandRunner;
  readonly #artifactRoots: readonly string[];
  readonly #fileSystem: AndroidArtifactFileSystem;
  readonly #statusTimeoutMs: number;
  readonly #actionTimeoutMs: number;
  readonly #installTimeoutMs: number;
  readonly #maximumApkBytes: number;
  readonly #now: () => number;

  constructor(options: AdbCliAdapterOptions) {
    this.#executablePath = boundedExecutable(options.executablePath);
    this.#runner = options.runner;
    this.#artifactRoots = [...(options.artifactRoots ?? [])].map((root) => resolve(root));
    this.#fileSystem = options.fileSystem ?? {
      realpath: nodeRealpath,
      stat: nodeStat
    };
    this.#statusTimeoutMs = boundedTimeout(options.statusTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS, "Status timeout");
    this.#actionTimeoutMs = boundedTimeout(options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS, "Action timeout");
    this.#installTimeoutMs = boundedTimeout(options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS, "Install timeout");
    this.#maximumApkBytes = boundedApkSize(options.maximumApkBytes ?? DEFAULT_MAXIMUM_APK_BYTES);
    this.#now = options.now ?? Date.now;
  }

  async probe(signal?: AbortSignal): Promise<string> {
    const result = await this.#run(["version"], this.#statusTimeoutMs, signal);
    const line = result.stdout.split(/\r?\n/gu).find((value) => /Android Debug Bridge/iu.test(value));
    const version = (line ?? result.stdout).trim();
    if (version === "") throw new AndroidRuntimeError("adb_not_found", "ADB version output was empty.");
    return version.slice(0, 512);
  }

  async listDevices(signal?: AbortSignal): Promise<readonly AndroidConnectedDevice[]> {
    const result = await this.#run(["devices", "-l"], this.#statusTimeoutMs, signal);
    return parseAdbDevices(result.stdout);
  }

  async startServer(signal?: AbortSignal): Promise<void> {
    await this.#run(["start-server"], this.#actionTimeoutMs, signal);
  }

  async killServer(signal?: AbortSignal): Promise<void> {
    await this.#run(["kill-server"], this.#actionTimeoutMs, signal);
  }

  async connect(endpoint: string, signal?: AbortSignal): Promise<{ readonly endpoint: string; readonly output: string }> {
    const safeEndpoint = normalizeAdbEndpoint(endpoint);
    const result = await this.#run(["connect", safeEndpoint], this.#actionTimeoutMs, signal);
    return { endpoint: safeEndpoint, output: boundedOutput(result) };
  }

  async disconnect(endpoint: string, signal?: AbortSignal): Promise<{ readonly endpoint: string; readonly output: string }> {
    const safeEndpoint = normalizeAdbEndpoint(endpoint);
    const result = await this.#run(["disconnect", safeEndpoint], this.#actionTimeoutMs, signal);
    return { endpoint: safeEndpoint, output: boundedOutput(result) };
  }

  async snapshot(serial: string, signal?: AbortSignal): Promise<AndroidDeviceSnapshot> {
    const safeSerial = validateDeviceSerial(serial);
    const sizeResult = await this.#runDevice(safeSerial, ["shell", "wm", "size"], signal);
    const densityResult = await this.#runDevice(safeSerial, ["shell", "wm", "density"], signal);
    const screen = parseScreenState(sizeResult.stdout, densityResult.stdout);
    const appResult = await this.#runDevice(
      safeSerial,
      ["shell", "dumpsys", "window", "windows"],
      signal
    );
    const screenshotResult = await this.#runDevice(
      safeSerial,
      ["exec-out", "screencap", "-p"],
      signal,
      "binary",
      MAXIMUM_SCREENSHOT_BYTES
    );
    const screenshot = screenshotResult.stdoutBuffer;
    if (screenshot === undefined || screenshotResult.stdoutTruncated || !isPng(screenshot)) {
      throw new AndroidRuntimeError("snapshot_failed", "ADB screenshot did not return a valid PNG payload.");
    }
    const pngSize = readPngSize(screenshot);
    const coordinateScreen = pngSize === undefined ? screen : { ...screen, ...pngSize };

    let nodes: readonly AndroidUiNode[] = [];
    let nodesTruncated = false;
    let uiDumpError: string | undefined;
    try {
      const dumpResult = await this.#runDevice(
        safeSerial,
        ["exec-out", "uiautomator", "dump", "/dev/tty"],
        signal
      );
      const xmlStart = dumpResult.stdout.indexOf("<?xml");
      if (xmlStart < 0) throw new AndroidRuntimeError("snapshot_failed", "ADB UI dump did not return XML.");
      const parsed = parseAndroidUiNodes(dumpResult.stdout.slice(xmlStart));
      nodes = parsed.nodes;
      nodesTruncated = parsed.truncated || dumpResult.stdoutTruncated;
    } catch (error) {
      if (isAbortError(error)) throw error;
      uiDumpError = redactAndroidOutput(error instanceof Error ? error.message : String(error)).slice(0, 1_024);
    }

    return {
      deviceSerial: safeSerial,
      screen: coordinateScreen,
      currentApp: parseFocusedAndroidComponent(appResult.stdout),
      screenshot: {
        mimeType: "image/png",
        dataBase64: screenshot.toString("base64"),
        byteLength: screenshot.byteLength
      },
      nodes,
      nodesTruncated,
      capturedAt: this.#now(),
      ...(uiDumpError === undefined ? {} : { uiDumpError })
    };
  }

  async tap(serial: string, point: AndroidPoint, signal?: AbortSignal): Promise<void> {
    const safeSerial = validateDeviceSerial(serial);
    validatePoint(point);
    await this.#runDevice(safeSerial, ["shell", "input", "tap", String(point.x), String(point.y)], signal);
  }

  async swipe(
    serial: string,
    start: AndroidPoint,
    end: AndroidPoint,
    durationMs: number,
    signal?: AbortSignal
  ): Promise<void> {
    const safeSerial = validateDeviceSerial(serial);
    validatePoint(start);
    validatePoint(end);
    if (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 60_000) {
      throw new AndroidRuntimeError("invalid_coordinate", "Swipe duration must be between zero and 60 seconds.");
    }
    await this.#runDevice(safeSerial, [
      "shell",
      "input",
      "swipe",
      String(start.x),
      String(start.y),
      String(end.x),
      String(end.y),
      String(durationMs)
    ], signal);
  }

  async inputText(serial: string, text: string, signal?: AbortSignal): Promise<void> {
    const safeSerial = validateDeviceSerial(serial);
    const escaped = escapeAdbInputText(text);
    await this.#runDevice(safeSerial, ["shell", "input", "text", escaped], signal);
  }

  async pressKey(serial: string, key: AndroidKey, signal?: AbortSignal): Promise<number> {
    const safeSerial = validateDeviceSerial(serial);
    const keyCode: number | undefined = KEY_CODES[key];
    if (keyCode === undefined) throw new AndroidRuntimeError("unsupported_key", "Android key is not supported.");
    await this.#runDevice(safeSerial, ["shell", "input", "keyevent", String(keyCode)], signal);
    return keyCode;
  }

  async launchApp(
    serial: string,
    packageName: string,
    activity?: string,
    signal?: AbortSignal
  ): Promise<string> {
    const safeSerial = validateDeviceSerial(serial);
    if (!PACKAGE_NAME.test(packageName)) {
      throw new AndroidRuntimeError("unsafe_input", "Android package name is invalid.");
    }
    if (activity !== undefined && !ACTIVITY_NAME.test(activity)) {
      throw new AndroidRuntimeError("unsafe_input", "Android activity name is invalid.");
    }
    const arguments_ = activity === undefined
      ? ["shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"]
      : ["shell", "am", "start", "-n", `${packageName}/${activity}`];
    const result = await this.#runDevice(safeSerial, arguments_, signal);
    return boundedOutput(result);
  }

  async installArtifact(
    serial: string,
    artifactPath: string,
    options: AndroidInstallOptions = {},
    signal?: AbortSignal
  ): Promise<string> {
    const safeSerial = validateDeviceSerial(serial);
    const safeArtifact = await this.#validateArtifact(artifactPath);
    const arguments_ = ["install"];
    if (options.replace === true) arguments_.push("-r");
    if (options.allowDowngrade === true) arguments_.push("-d");
    if (options.grantRuntimePermissions === true) arguments_.push("-g");
    if (options.allowTestPackage === true) arguments_.push("-t");
    arguments_.push(safeArtifact);
    const result = await this.#run(
      ["-s", safeSerial, ...arguments_],
      this.#installTimeoutMs,
      signal,
      "text",
      1024 * 1024
    );
    return boundedOutput(result, [safeArtifact, ...this.#artifactRoots]);
  }

  async #validateArtifact(artifactPath: string): Promise<string> {
    if (!isAbsolute(artifactPath) || artifactPath.length > 32_768 || artifactPath.includes("\0")) {
      throw new AndroidRuntimeError("artifact_invalid", "Android artifact path must be absolute.");
    }
    if (this.#artifactRoots.length === 0) {
      throw new AndroidRuntimeError("artifact_outside_roots", "Android artifact installation has no approved roots.");
    }

    let candidate: string;
    let roots: readonly string[];
    try {
      candidate = await this.#fileSystem.realpath(resolve(artifactPath));
      roots = await Promise.all(this.#artifactRoots.map((root) => this.#fileSystem.realpath(root)));
    } catch {
      throw new AndroidRuntimeError("artifact_invalid", "Android artifact could not be resolved.");
    }
    if (!roots.some((root) => isSameOrChildPath(candidate, root))) {
      throw new AndroidRuntimeError("artifact_outside_roots", "Android artifact is outside approved roots.");
    }
    if (extname(candidate).toLowerCase() !== ".apk") {
      throw new AndroidRuntimeError("artifact_invalid", "Android artifact must be an APK file.");
    }

    let file: AndroidArtifactStat;
    try {
      file = await this.#fileSystem.stat(candidate);
    } catch {
      throw new AndroidRuntimeError("artifact_invalid", "Android artifact could not be read.");
    }
    if (!file.isFile() || !Number.isSafeInteger(file.size) || file.size < 1) {
      throw new AndroidRuntimeError("artifact_invalid", "Android artifact is not a non-empty regular file.");
    }
    if (file.size > this.#maximumApkBytes) {
      throw new AndroidRuntimeError("artifact_too_large", "Android artifact exceeds the configured size limit.");
    }
    return candidate;
  }

  #runDevice(
    serial: string,
    arguments_: readonly string[],
    signal?: AbortSignal,
    stdoutMode: "binary" | "text" = "text",
    maximumStdoutBytes?: number
  ): Promise<AndroidCommandResult> {
    return this.#run(
      ["-s", serial, ...arguments_],
      this.#actionTimeoutMs,
      signal,
      stdoutMode,
      maximumStdoutBytes
    );
  }

  async #run(
    arguments_: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
    stdoutMode: "binary" | "text" = "text",
    maximumStdoutBytes?: number
  ): Promise<AndroidCommandResult> {
    let result: AndroidCommandResult;
    try {
      result = await this.#runner.run({
        command: this.#executablePath,
        arguments: arguments_,
        timeoutMs,
        signal,
        stdoutMode,
        ...(maximumStdoutBytes === undefined ? {} : { maximumStdoutBytes })
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new AndroidRuntimeError(
        error instanceof AndroidProcessError && error.kind === "spawn" ? "adb_not_found" : "command_failed",
        redactAndroidOutput(error instanceof Error ? error.message : String(error), this.#artifactRoots)
      );
    }
    if (result.exitCode !== 0) {
      const output = boundedOutput(result, this.#artifactRoots);
      throw new AndroidRuntimeError(
        "command_failed",
        output === "" ? "ADB command failed." : output,
        {
          exitCode: result.exitCode,
          stdoutTruncated: result.stdoutTruncated,
          stderrTruncated: result.stderrTruncated
        }
      );
    }
    return result;
  }
}

export function parseAdbDevices(output: string): readonly AndroidConnectedDevice[] {
  const lines = output.split(/\r?\n/gu);
  const headerIndex = lines.findIndex((line) => /^List of devices attached\s*$/iu.test(line.trim()));
  const body = headerIndex < 0 ? lines : lines.slice(headerIndex + 1);
  return body
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("*"))
    .flatMap((line): readonly AndroidConnectedDevice[] => {
      const parts = line.split(/\s+/gu);
      const serial = parts[0];
      if (serial === undefined || !isValidDeviceSerial(serial)) return [];
      const rawState = parts[1];
      const state = rawState === "device" || rawState === "offline" || rawState === "unauthorized"
        ? rawState
        : "unknown";
      const metadata = new Map<string, string>();
      for (const part of parts.slice(2)) {
        const separator = part.indexOf(":");
        if (separator <= 0 || separator === part.length - 1) continue;
        metadata.set(part.slice(0, separator), part.slice(separator + 1));
      }
      return [{
        serial,
        state,
        ...(metadata.get("product") === undefined ? {} : { product: metadata.get("product") }),
        ...(metadata.get("model") === undefined ? {} : { model: metadata.get("model") }),
        ...(metadata.get("device") === undefined ? {} : { device: metadata.get("device") }),
        ...(metadata.get("transport_id") === undefined ? {} : { transportId: metadata.get("transport_id") }),
        ...(metadata.get("usb") === undefined ? {} : { usb: metadata.get("usb") })
      }];
    });
}

export function parseAndroidUiNodes(xml: string): {
  readonly nodes: readonly AndroidUiNode[];
  readonly truncated: boolean;
} {
  const nodes: AndroidUiNode[] = [];
  const nodePattern = /<node\b([^>]*?)(?:\/>|>)/giu;
  let match: RegExpExecArray | null;
  let matchedSignals = 0;
  while ((match = nodePattern.exec(xml)) !== null) {
    const attributes = match[1] ?? "";
    const bounds = parseBounds(readXmlAttribute(attributes, "bounds") ?? "");
    if (bounds === undefined) continue;
    const password = readXmlAttribute(attributes, "password") === "true";
    const text = redactAndroidUiValue(readXmlAttribute(attributes, "text") ?? "", password);
    const contentDescription = redactAndroidUiValue(
      readXmlAttribute(attributes, "content-desc") ?? "",
      password
    );
    const resourceId = redactAndroidUiValue(readXmlAttribute(attributes, "resource-id") ?? "");
    const clickable = readXmlAttribute(attributes, "clickable") === "true";
    const scrollable = readXmlAttribute(attributes, "scrollable") === "true";
    if (text === undefined && contentDescription === undefined && resourceId === undefined && !clickable && !scrollable) {
      continue;
    }
    matchedSignals += 1;
    if (nodes.length >= MAXIMUM_UI_NODES) continue;
    nodes.push({
      index: nodes.length + 1,
      ...(text === undefined ? {} : { text }),
      ...(contentDescription === undefined ? {} : { contentDescription }),
      ...(redactAndroidUiValue(readXmlAttribute(attributes, "class") ?? "") === undefined
        ? {}
        : { className: redactAndroidUiValue(readXmlAttribute(attributes, "class") ?? "") }),
      ...(resourceId === undefined ? {} : { resourceId }),
      ...(redactAndroidUiValue(readXmlAttribute(attributes, "package") ?? "") === undefined
        ? {}
        : { packageName: redactAndroidUiValue(readXmlAttribute(attributes, "package") ?? "") }),
      bounds,
      clickable,
      enabled: readXmlAttribute(attributes, "enabled") !== "false",
      ...(readXmlAttribute(attributes, "focusable") === "true" ? { focusable: true } : {}),
      ...(readXmlAttribute(attributes, "long-clickable") === "true" ? { longClickable: true } : {}),
      ...(scrollable ? { scrollable: true } : {}),
      ...(readXmlAttribute(attributes, "checked") === "true" ? { checked: true } : {}),
      ...(readXmlAttribute(attributes, "selected") === "true" ? { selected: true } : {}),
      ...(password ? { password: true } : {})
    });
  }
  return { nodes, truncated: matchedSignals > nodes.length };
}

export function normalizeAdbEndpoint(value: string): string {
  const endpoint = value.trim();
  if (
    endpoint === ""
    || endpoint.length > 512
    || endpoint.includes("\0")
    || /[\s/@?#]/u.test(endpoint)
    || endpoint.startsWith("-")
  ) throw new AndroidRuntimeError("invalid_endpoint", "ADB endpoint is invalid.");

  let host: string;
  let portText: string | undefined;
  if (endpoint.startsWith("[")) {
    const match = /^\[([0-9A-Fa-f:.%]+)\](?::(\d{1,5}))?$/u.exec(endpoint);
    if (match === null || isIP(match[1] ?? "") !== 6) {
      throw new AndroidRuntimeError("invalid_endpoint", "ADB endpoint is invalid.");
    }
    host = `[${match[1]}]`;
    portText = match[2];
  } else {
    const separator = endpoint.lastIndexOf(":");
    const possibleHost = separator > 0 ? endpoint.slice(0, separator) : endpoint;
    const possiblePort = separator > 0 ? endpoint.slice(separator + 1) : undefined;
    if (possibleHost.includes(":")) throw new AndroidRuntimeError("invalid_endpoint", "IPv6 ADB endpoints require brackets.");
    if (isIP(possibleHost) === 0 && !isValidHostname(possibleHost)) {
      throw new AndroidRuntimeError("invalid_endpoint", "ADB endpoint hostname is invalid.");
    }
    host = possibleHost.toLowerCase();
    portText = possiblePort;
  }
  const port = portText === undefined ? 5555 : Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new AndroidRuntimeError("invalid_endpoint", "ADB endpoint port is invalid.");
  }
  return `${host}:${port}`;
}

export function validateDeviceSerial(value: string): string {
  const serial = value.trim();
  if (!isValidDeviceSerial(serial)) {
    throw new AndroidRuntimeError("invalid_device_serial", "ADB device serial is invalid.");
  }
  return serial;
}

export function escapeAdbInputText(value: string): string {
  if (value.length < 1 || value.length > 4_096 || !SAFE_INPUT_TEXT.test(value) || value.includes("%s")) {
    throw new AndroidRuntimeError("unsafe_input", "ADB text contains unsupported characters.");
  }
  return value.replace(/ /gu, "%s");
}

function parseScreenState(sizeOutput: string, densityOutput: string): AndroidScreenState {
  const allSizes = [...sizeOutput.matchAll(/(?:Physical|Override) size:\s*(\d+)x(\d+)/giu)];
  const size = allSizes.at(-1);
  if (size === undefined) {
    throw new AndroidRuntimeError("snapshot_failed", "ADB screen size output could not be parsed.");
  }
  const allDensities = [...densityOutput.matchAll(/(?:Physical|Override) density:\s*(\d+)/giu)];
  const density = allDensities.at(-1);
  return {
    width: Number(size[1]),
    height: Number(size[2]),
    density: density === undefined ? null : Number(density[1])
  };
}

function parseFocusedAndroidComponent(output: string): AndroidCurrentAppState {
  const match = /(?:mCurrentFocus|mFocusedApp|topResumedActivity|ResumedActivity).*?\s([A-Za-z0-9._$]+)\/([A-Za-z0-9._$/]+)/iu.exec(output);
  return match === null
    ? { packageName: null, activity: null }
    : { packageName: match[1] ?? null, activity: match[2] ?? null };
}

function parseBounds(raw: string): AndroidUiBounds | undefined {
  const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/u.exec(raw.trim());
  if (match === null) return undefined;
  const bounds = {
    x1: Number(match[1]),
    y1: Number(match[2]),
    x2: Number(match[3]),
    y2: Number(match[4])
  };
  if (bounds.x2 <= bounds.x1 || bounds.y2 <= bounds.y1) return undefined;
  return bounds;
}

function readXmlAttribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`, "iu").exec(attributes);
  return match?.[1] === undefined ? undefined : decodeXml(match[1]);
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/gu, "\"")
    .replace(/&apos;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&");
}

function isPng(buffer: Buffer): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return buffer.byteLength >= 24 && signature.every((byte, index) => buffer[index] === byte);
}

function readPngSize(buffer: Buffer): Pick<AndroidScreenState, "height" | "width"> | undefined {
  if (!isPng(buffer) || buffer.toString("ascii", 12, 16) !== "IHDR") return undefined;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function validatePoint(point: AndroidPoint): void {
  if (
    !Number.isSafeInteger(point.x)
    || !Number.isSafeInteger(point.y)
    || point.x < 0
    || point.y < 0
    || point.x > 1_000_000
    || point.y > 1_000_000
  ) throw new AndroidRuntimeError("invalid_coordinate", "Android coordinate is invalid.");
}

function isValidDeviceSerial(value: string): boolean {
  return value.length >= 1
    && value.length <= 255
    && !value.startsWith("-")
    && /^[A-Za-z0-9[\]._:%-]+$/u.test(value);
}

function isValidHostname(value: string): boolean {
  if (value.length < 1 || value.length > 253) return false;
  return value.split(".").every((label) =>
    label.length >= 1
    && label.length <= 63
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label));
}

function isSameOrChildPath(candidate: string, root: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function boundedExecutable(value: string): string {
  const executable = value.trim();
  if (executable === "" || executable.length > 32_768 || executable.includes("\0")) {
    throw new TypeError("ADB executable path is invalid.");
  }
  return executable;
}

function boundedTimeout(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60 * 60_000) {
    throw new RangeError(`${label} must be between one millisecond and one hour.`);
  }
  return value;
}

function boundedApkSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 8 * 1024 * 1024 * 1024) {
    throw new RangeError("APK size limit must be between one byte and eight GiB.");
  }
  return value;
}

function boundedOutput(result: AndroidCommandResult, roots: readonly string[] = []): string {
  return redactAndroidOutput((result.stdout.trim() || result.stderr.trim()).slice(0, 16 * 1024), roots);
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === "AbortError";
}
