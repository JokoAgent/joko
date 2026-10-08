import { describe, expect, it, vi } from "vitest";

import {
  MOBILE_REMOTE_CLIPBOARD_TEXT_CHARS,
  MobileRemoteClipboardError,
  createMobileRemoteClipboardSystem,
  parseMobileRemoteClipboardItem,
  serializeMobileRemoteClipboardItem
} from "./mobile-remote-desktop-clipboard";

function legacy() {
  return {
    hasImageAsync: vi.fn(async () => false),
    getStringAsync: vi.fn(async () => "phone text"),
    setStringAsync: vi.fn(async () => true)
  };
}

describe("Mobile Remote Desktop clipboard", () => {
  it("keeps one bounded portable item with exact rich representations", () => {
    const png = "iVBORw0KGgo=";
    const item = parseMobileRemoteClipboardItem(JSON.stringify({
      text: "plain", html: "<b>plain</b>", rtf: "{\\rtf1 plain}",
      url: "https://joko.app/path", png
    }));
    expect(item).toEqual({ text: "plain", html: "<b>plain</b>", rtf: "{\\rtf1 plain}",
      url: "https://joko.app/path", png });
    expect(serializeMobileRemoteClipboardItem(item)).toBe(JSON.stringify(item));
    expect(parseMobileRemoteClipboardItem({ url: "https://example.com" }))
      .toEqual({ url: "https://example.com" });
    expect(() => parseMobileRemoteClipboardItem({ text: "", file: "private" })).toThrow(MobileRemoteClipboardError);
    expect(() => parseMobileRemoteClipboardItem({ url: "file:///private/item" })).toThrow(MobileRemoteClipboardError);
    expect(() => parseMobileRemoteClipboardItem({ png: "not-png" })).toThrow(MobileRemoteClipboardError);
    expect(() => parseMobileRemoteClipboardItem({ text: "x".repeat(MOBILE_REMOTE_CLIPBOARD_TEXT_CHARS + 1) }))
      .not.toThrow();
  });

  it("uses the atomic native item boundary when it is available", async () => {
    const native = {
      readClipboard: vi.fn(async () => JSON.stringify({ text: "plain", html: "<b>plain</b>" })),
      writeClipboard: vi.fn(async () => undefined)
    };
    const fallback = legacy();
    const system = createMobileRemoteClipboardSystem(native, fallback);
    const check = vi.fn();
    expect(system.richAvailable).toBe(true);
    await expect(system.readPortable(check)).resolves.toEqual({ text: "plain", html: "<b>plain</b>" });
    await system.writePortable({ url: "https://joko.app/" }, check);
    expect(native.writeClipboard).toHaveBeenCalledWith('{"url":"https://joko.app/"}');
    expect(fallback.getStringAsync).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledTimes(4);
  });

  it("retains the reference Android text fallback and rejects image downgrade", async () => {
    const fallback = legacy();
    const system = createMobileRemoteClipboardSystem(null, fallback);
    const check = vi.fn();
    expect(system.richAvailable).toBe(false);
    await expect(system.readLegacyText(check)).resolves.toBe("phone text");
    await system.writeLegacyText("desktop text", check);
    expect(fallback.setStringAsync).toHaveBeenCalledWith("desktop text");
    fallback.hasImageAsync.mockResolvedValue(true);
    await expect(system.readLegacyText(check)).rejects.toMatchObject({ code: "unavailable" });
    await expect(system.readPortable(check)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("rechecks the caller fence around every native effect", async () => {
    const native = {
      readClipboard: vi.fn(async () => JSON.stringify({ text: "private" })),
      writeClipboard: vi.fn(async () => undefined)
    };
    const system = createMobileRemoteClipboardSystem(native, legacy());
    const check = vi.fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => { throw new MobileRemoteClipboardError("retired"); });
    await expect(system.readPortable(check)).rejects.toMatchObject({ code: "retired" });
  });
});
