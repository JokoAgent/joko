import type { NativeSystemFrontmostInputHelper } from "./dedicated-hardware-action/system-frontmost-input.js";
import { loadHashedNativeHelper, nativeHelperRecord as record, type NativeHelperModuleOptions } from "./native-helper-module.js";

const WINDOWS_HELPER = "joko-windows-frontmost-input.node";
const MACOS_HELPER = "joko-macos-frontmost-input.node";
const LINUX_HELPER = "joko-linux-frontmost-input.node";
const MAX_HELPER_BYTES = 2 * 1024 * 1024;

export type NativeSystemFrontmostInputOptions = NativeHelperModuleOptions;

/** Loads the current artifact once; sampling and fixed effects never start another process. */
export function loadNativeSystemFrontmostInput(
  options: NativeSystemFrontmostInputOptions
): NativeSystemFrontmostInputHelper | undefined {
  const helper = options.platform === "win32" ? WINDOWS_HELPER
    : options.platform === "darwin" ? MACOS_HELPER : options.platform === "linux" ? LINUX_HELPER : undefined;
  if (helper === undefined) return undefined;
  try {
    const native = loadHashedNativeHelper(options, helper, MAX_HELPER_BYTES);
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
