import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { NativeSystemFrontmostInputHelper } from "./dedicated-hardware-action/system-frontmost-input.js";

const require = createRequire(import.meta.url);
const WINDOWS_HELPER = "joko-windows-frontmost-input.node";
const MACOS_HELPER = "joko-macos-frontmost-input.node";
const LINUX_HELPER = "joko-linux-frontmost-input.node";
const MAX_HELPER_BYTES = 2 * 1024 * 1024;

export interface NativeSystemFrontmostInputOptions {
  readonly directory: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly loadNative?: (path: string) => unknown;
}

/** Loads the current artifact once; sampling and fixed effects never start another process. */
export function loadNativeSystemFrontmostInput(
  options: NativeSystemFrontmostInputOptions
): NativeSystemFrontmostInputHelper | undefined {
  const helper = options.platform === "win32" ? WINDOWS_HELPER
    : options.platform === "darwin" ? MACOS_HELPER : options.platform === "linux" ? LINUX_HELPER : undefined;
  if (helper === undefined) return undefined;
  try {
    const directory = resolve(options.directory);
    const root = lstatSync(directory);
    if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(directory) !== directory) return undefined;
    const entries = readdirSync(directory).sort();
    if (entries.length !== 2 || entries[0] !== helper || entries[1] !== "manifest.json") return undefined;
    const manifestPath = resolve(directory, "manifest.json");
    if (!regularFile(manifestPath, 4_096)) return undefined;
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!record(manifest) || Object.keys(manifest).sort().join(",") !== "architecture,helper,platform,protocolVersion,sha256"
      || manifest.platform !== options.platform || manifest.architecture !== options.architecture
      || manifest.protocolVersion !== 1 || manifest.helper !== helper
      || typeof manifest.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(manifest.sha256)) return undefined;
    const helperPath = resolve(directory, helper);
    if (!regularFile(helperPath, MAX_HELPER_BYTES)) return undefined;
    if (createHash("sha256").update(readFileSync(helperPath)).digest("hex") !== manifest.sha256) return undefined;
    const native = (options.loadNative ?? require)(helperPath);
    if (!record(native) || Object.keys(native).sort().join(",") !== "captureTarget,postPaste,postReturn,postScroll,protocolVersion"
      || native.protocolVersion !== 1 || typeof native.captureTarget !== "function"
      || typeof native.postReturn !== "function" || typeof native.postPaste !== "function"
      || typeof native.postScroll !== "function") return undefined;
    const capture = native.captureTarget as () => unknown;
    const postReturn = native.postReturn as (nativeId: string, processId: number) => void;
    const postPaste = native.postPaste as (nativeId: string, processId: number) => void;
    const postScroll = native.postScroll as (nativeId: string, processId: number, deltaY: number) => void;
    const captureTarget = () => {
      const value = capture();
      if (!record(value) || Object.keys(value).sort().join(",") !== "nativeId,processId"
        || typeof value.nativeId !== "string" || !/^[1-9][0-9]{0,18}$/u.test(value.nativeId)
        || BigInt(value.nativeId) > 9_223_372_036_854_775_807n
        || typeof value.processId !== "number" || !Number.isSafeInteger(value.processId)
        || value.processId <= 0 || value.processId > 0xffff_ffff) {
        throw new TypeError("Native foreground identity is invalid.");
      }
      return Object.freeze({ nativeId: value.nativeId, processId: value.processId });
    };
    return Object.freeze({
      captureTarget,
      postReturn: async (target) => postReturn(target.nativeId, target.processId),
      postPaste: async (target) => postPaste(target.nativeId, target.processId),
      postScroll: async (target, deltaY) => postScroll(target.nativeId, target.processId, deltaY)
    } satisfies NativeSystemFrontmostInputHelper);
  } catch {
    return undefined;
  }
}

function regularFile(path: string, maximumBytes: number): boolean {
  const info = lstatSync(path);
  return info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= maximumBytes
    && realpathSync(path) === path;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
