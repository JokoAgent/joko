import { describe, expect, it, vi } from "vitest";

import {
  cleanupPackagedSmokeClipboard,
  hasOnlyEmptyPackagedSmokeClipboardFormats,
  isPackagedSmokeRestorableClipboardFormat,
  isPackagedSmokeClipboardObservationOwned,
  packagedSmokeSystemClipboardText
} from "./packaged-smoke-clipboard-cleanup.js";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("packaged smoke clipboard cleanup", () => {
  it("matches the native Windows clipboard line-ending boundary exactly", () => {
    expect(packagedSmokeSystemClipboardText("one\ntwo\nthree", "win32")).toBe("one\r\ntwo\r\nthree");
    expect(packagedSmokeSystemClipboardText("one\r\ntwo\rthree", "win32")).toBe("one\r\ntwo\r\nthree");
    expect(packagedSmokeSystemClipboardText("one\r\ntwo", "darwin")).toBe("one\ntwo");
  });

  it("treats Chromium markhtml as the HTML snapshot companion but rejects unknown custom data", () => {
    expect(isPackagedSmokeRestorableClipboardFormat("text/markhtml")).toBe(true);
    expect(isPackagedSmokeRestorableClipboardFormat("text/html")).toBe(true);
    expect(isPackagedSmokeRestorableClipboardFormat("application/x-private-owner-token")).toBe(false);
  });

  it("normalizes format-only zero-byte clipboard placeholders as semantically empty", () => {
    expect(hasOnlyEmptyPackagedSmokeClipboardFormats(["image/png"], () => 0)).toBe(true);
    expect(hasOnlyEmptyPackagedSmokeClipboardFormats(["image/png"], () => 1)).toBe(false);
    expect(hasOnlyEmptyPackagedSmokeClipboardFormats(["application/x-private-owner-token"], () => 0)).toBe(false);
    expect(hasOnlyEmptyPackagedSmokeClipboardFormats([], () => 0)).toBe(false);
  });

  it("restores immediately after both renderer writes are known to have settled", async () => {
    const waitForWritesToSettle = vi.fn(async () => false);
    const retireWriter = vi.fn();
    const restorePreviousClipboard = vi.fn();

    await cleanupPackagedSmokeClipboard({
      writesKnownSettled: true,
      waitForWritesToSettle,
      retireWriter,
      ownsCurrentClipboard: () => true,
      restorePreviousClipboard
    });

    expect(waitForWritesToSettle).not.toHaveBeenCalled();
    expect(retireWriter).not.toHaveBeenCalled();
    expect(restorePreviousClipboard).toHaveBeenCalledOnce();
  });

  it("waits for an in-flight write before restoring the owned clipboard", async () => {
    const order: string[] = [];

    await cleanupPackagedSmokeClipboard({
      writesKnownSettled: false,
      waitForWritesToSettle: async () => { order.push("settled"); return true; },
      retireWriter: () => { order.push("retired"); },
      ownsCurrentClipboard: () => { order.push("owned"); return true; },
      restorePreviousClipboard: () => { order.push("restored"); }
    });

    expect(order).toEqual(["settled", "owned", "restored"]);
  });

  it("retires a stuck writer before restoring its sentinel or output", async () => {
    const order: string[] = [];

    await cleanupPackagedSmokeClipboard({
      writesKnownSettled: false,
      waitForWritesToSettle: async () => { order.push("pending"); return false; },
      retireWriter: () => { order.push("retired"); },
      ownsCurrentClipboard: () => { order.push("owned"); return true; },
      restorePreviousClipboard: () => { order.push("restored"); }
    });

    expect(order).toEqual(["pending", "retired", "owned", "restored"]);
  });

  it("does not restore before exact writer retirement fences a late owned output", async () => {
    const retirement = deferred();
    const restorePreviousClipboard = vi.fn();
    let current = "sentinel";
    const cleanup = cleanupPackagedSmokeClipboard({
      writesKnownSettled: false,
      waitForWritesToSettle: async () => false,
      retireWriter: () => retirement.promise,
      ownsCurrentClipboard: () => current === "sentinel" || current === "nonce output",
      restorePreviousClipboard
    });

    current = "nonce output";
    await Promise.resolve();
    expect(restorePreviousClipboard).not.toHaveBeenCalled();
    retirement.resolve();
    await cleanup;
    expect(restorePreviousClipboard).toHaveBeenCalledOnce();
  });

  it("preserves an external owner that replaces the clipboard during retirement", async () => {
    const retirement = deferred();
    const restorePreviousClipboard = vi.fn();
    let current = "sentinel";
    const cleanup = cleanupPackagedSmokeClipboard({
      writesKnownSettled: false,
      waitForWritesToSettle: async () => false,
      retireWriter: () => retirement.promise,
      ownsCurrentClipboard: () => current === "sentinel" || current === "nonce output",
      restorePreviousClipboard
    });

    current = "external";
    retirement.resolve();
    await cleanup;
    expect(restorePreviousClipboard).not.toHaveBeenCalled();
    expect(current).toBe("external");
  });

  it("retires after a settlement probe failure but preserves a newer clipboard owner", async () => {
    const retireWriter = vi.fn();
    const restorePreviousClipboard = vi.fn();

    await cleanupPackagedSmokeClipboard({
      writesKnownSettled: false,
      waitForWritesToSettle: async () => { throw new Error("Document retired"); },
      retireWriter,
      ownsCurrentClipboard: () => false,
      restorePreviousClipboard
    });

    expect(retireWriter).toHaveBeenCalledOnce();
    expect(restorePreviousClipboard).not.toHaveBeenCalled();
  });

  it("adopts a nonce-bound output even when UI settlement never recorded its fingerprint", () => {
    expect(isPackagedSmokeClipboardObservationOwned(
      { text: "table nonce", imageSha256: "png-sha" },
      "sentinel",
      ["table nonce", "math nonce"]
    )).toBe(true);
    expect(isPackagedSmokeClipboardObservationOwned(
      { text: "table nonce" },
      "sentinel",
      ["table nonce", "math nonce"]
    )).toBe(false);
    expect(isPackagedSmokeClipboardObservationOwned(
      { text: "code nonce" },
      "sentinel",
      ["table nonce", "math nonce"],
      ["code nonce"]
    )).toBe(true);
    expect(isPackagedSmokeClipboardObservationOwned(
      { text: "code nonce", imageSha256: "stale-png" },
      "sentinel",
      ["table nonce", "math nonce"],
      ["code nonce"]
    )).toBe(false);
    expect(isPackagedSmokeClipboardObservationOwned(
      { text: "external", imageSha256: "png-sha" },
      "sentinel",
      ["table nonce", "math nonce"]
    )).toBe(false);
  });
});
