import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  createPlatformSystemFrontmostInput,
  type NativeSystemFrontmostInputHelper
} from "./dedicated-hardware-action/system-frontmost-input.js";
import { DesktopNativeGamepadDocumentAuthority } from "./native-gamepad-document.js";
import {
  MacShortcutVoicePasteTarget,
  captureShortcutVoiceDocumentTarget
} from "./global-voice-paste-target.js";

function nativeHarness() {
  let frontmost = { nativeId: "1001", processId: 2001 };
  const postPaste = vi.fn<NativeSystemFrontmostInputHelper["postPaste"]>(async () => undefined);
  const captureTarget = vi.fn(() => Object.freeze({ ...frontmost }));
  const input = createPlatformSystemFrontmostInput({
    platform: "darwin", currentProcessId: 1,
    macHelper: { captureTarget, postPaste, postReturn: async () => undefined, postScroll: async () => undefined }
  });
  if (input.status !== "available") throw new Error("The native input fixture was not admitted.");
  return { runner: input.runner, captureTarget, postPaste, changeFrontmost: () => { frontmost = { nativeId: "1002", processId: 2002 }; } };
}

describe("macOS shortcut dictation target", () => {
  it("captures the original process instance and original runner before focus changes, then consumes paste once", async () => {
    const first = nativeHarness();
    const second = nativeHarness();
    let runner = first.runner;
    const owner = new MacShortcutVoicePasteTarget(() => runner);
    expect(owner.capture(1)).toBe(true);
    first.changeFrontmost();
    runner = second.runner;
    expect(owner.hasTarget(1)).toBe(true);
    expect(owner.hasTarget(2)).toBe(false);
    await expect(owner.paste(1)).resolves.toBe(true);
    expect(first.postPaste).toHaveBeenCalledExactlyOnceWith({ nativeId: "1001", processId: 2001 });
    expect(first.captureTarget).toHaveBeenCalledOnce();
    expect(second.captureTarget).not.toHaveBeenCalled();
    expect(second.postPaste).not.toHaveBeenCalled();
    expect(owner.hasTarget(1)).toBe(false);
    await expect(owner.paste(1)).resolves.toBe(false);
  });

  it("retires failed capture and invalid targets without choosing another foreground application", async () => {
    const native = nativeHarness();
    const owner = new MacShortcutVoicePasteTarget(() => native.runner);
    expect(owner.capture(1)).toBe(true);
    native.captureTarget.mockImplementation(() => { throw new Error("No approved foreground target."); });
    expect(owner.capture(2)).toBe(false);
    expect(owner.hasTarget(1)).toBe(false);
    await expect(owner.paste(1)).resolves.toBe(false);
    await expect(owner.paste(2)).resolves.toBe(false);
    expect(native.captureTarget).toHaveBeenCalledTimes(2);
    expect(native.postPaste).not.toHaveBeenCalled();
    const unavailable = new MacShortcutVoicePasteTarget(() => undefined);
    expect(unavailable.capture(1)).toBe(false);
    expect(unavailable.capture(0)).toBe(false);
    await expect(unavailable.paste(1)).resolves.toBe(false);
  });

  it("retires the recording after native paste rejection and never recaptures at submission", async () => {
    const native = nativeHarness();
    native.postPaste.mockRejectedValue(new Error("The original process instance terminated."));
    const owner = new MacShortcutVoicePasteTarget(() => native.runner);
    expect(owner.capture(1)).toBe(true);
    await expect(owner.paste(1)).resolves.toBe(false);
    await expect(owner.paste(1)).resolves.toBe(false);
    expect(native.postPaste).toHaveBeenCalledOnce();
    expect(native.captureTarget).toHaveBeenCalledOnce();
  });

  it("does not adopt a late paste result or retire a newer recording after cancellation or replacement", async () => {
    const native = nativeHarness();
    let complete!: () => void;
    native.postPaste.mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve; }));
    const owner = new MacShortcutVoicePasteTarget(() => native.runner);
    expect(owner.capture(1)).toBe(true);
    const first = owner.paste(1);
    await expect(owner.paste(1)).resolves.toBe(false);
    owner.retire(1);
    native.changeFrontmost();
    expect(owner.capture(2)).toBe(true);
    owner.retire(1);
    complete();
    await expect(first).resolves.toBe(false);
    expect(owner.hasTarget(2)).toBe(true);
    await expect(owner.paste(2)).resolves.toBe(true);
    expect(native.postPaste).toHaveBeenLastCalledWith(expect.objectContaining({ nativeId: "1002", processId: 2002 }));
  });

  it("keeps an in-application target bound to its original window and exact preload occurrence", async () => {
    const native = nativeHarness();
    const first = documentHarness();
    const second = documentHarness();
    let focused = first;
    const owner = new MacShortcutVoicePasteTarget(() => native.runner, () => focused.capture());
    expect(owner.capture(1)).toBe(true);
    focused = second;
    await expect(owner.paste(1)).resolves.toBe(true);
    expect(first.focus).toHaveBeenCalledOnce();
    expect(first.contents.paste).toHaveBeenCalledOnce();
    expect(second.contents.paste).not.toHaveBeenCalled();
    expect(native.captureTarget).not.toHaveBeenCalled();
    expect(first.contents.listenerCount("did-navigate")).toBe(0);
  });

  it.each(["did-navigate", "render-process-gone", "destroyed"] as const)("retires an application Document on %s without falling back to another target", async (event) => {
    const native = nativeHarness();
    const document = documentHarness();
    const owner = new MacShortcutVoicePasteTarget(() => native.runner, () => document.capture());
    expect(owner.capture(1)).toBe(true);
    document.contents.emit(event);
    expect(owner.hasTarget(1)).toBe(false);
    await expect(owner.paste(1)).resolves.toBe(false);
    expect(document.contents.paste).not.toHaveBeenCalled();
    expect(native.captureTarget).not.toHaveBeenCalled();
    expect(document.contents.listenerCount("did-navigate")).toBe(0);
  });

  it("rejects a replaced preload occurrence and rechecks the document after focus restoration", async () => {
    const document = documentHarness();
    const owner = new MacShortcutVoicePasteTarget(() => undefined, () => document.capture());
    expect(owner.capture(1)).toBe(true);
    document.replaceDocument();
    expect(owner.hasTarget(1)).toBe(false);
    await expect(owner.paste(1)).resolves.toBe(false);
    expect(document.contents.paste).not.toHaveBeenCalled();

    expect(owner.capture(2)).toBe(true);
    document.focus.mockImplementationOnce(() => document.replaceDocument());
    await expect(owner.paste(2)).resolves.toBe(false);
    expect(document.contents.paste).not.toHaveBeenCalled();
  });
});

function documentHarness() {
  const contents = Object.assign(new EventEmitter(), { paste: vi.fn() });
  let occurrence = 0;
  let claim = 1;
  const authority = new DesktopNativeGamepadDocumentAuthority<object>(() => `document-${++occurrence}`, () => undefined);
  expect(authority.currentFor(contents)).toBeUndefined();
  authority.capture(contents, "00000000-0000-4000-8000-000000000001");
  const focus = vi.fn();
  return {
    contents,
    focus,
    replaceDocument: () => authority.capture(contents, `00000000-0000-4000-8000-${String(++claim).padStart(12, "0")}`),
    capture: () => {
      const capturedOccurrence = authority.currentFor(contents)!;
      return captureShortcutVoiceDocumentTarget({ contents, focus, isCurrentDocument: () => authority.isCurrent(contents, capturedOccurrence) });
    }
  };
}
