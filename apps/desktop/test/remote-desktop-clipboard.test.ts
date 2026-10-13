import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ clipboard: {}, nativeImage: {} }));

import {
  DesktopRemoteDesktopClipboard,
  REMOTE_DESKTOP_CLIPBOARD_TEXT_CODE_UNITS,
  parseClipboardContent,
  type DesktopRemoteDesktopClipboardImage,
  type DesktopRemoteDesktopClipboardRuntime,
  type DesktopRemoteDesktopLinuxClipboardPort
} from "../src/remote-desktop-clipboard.js";

const SIGNAL = new AbortController().signal;

describe("Desktop Remote Desktop clipboard", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prefers an exact selected text value and falls back only after confirmed empty", async () => {
    const selected = fixture({ selection: "selected text", text: "unrelated clipboard" });
    await expect(selected.clipboard.copyText(() => true, SIGNAL)).resolves.toBe("selected text");
    expect(selected.runtime.writeText).toHaveBeenCalledWith("selected text");
    expect(selected.runtime.readVersion).not.toHaveBeenCalled();
    expect(selected.runtime.readText).not.toHaveBeenCalled();

    const empty = fixture({ selection: "", text: "clipboard text", versions: ["7", "7"] });
    await expect(empty.clipboard.copyText(() => true, SIGNAL)).resolves.toBe("clipboard text");
    expect(empty.runtime.readVersion).toHaveBeenCalledTimes(2);
    expect(empty.runtime.readText).toHaveBeenCalledOnce();

    const protectedField = fixture({ selection: "", text: "must not leak" });
    vi.mocked(protectedField.runtime.readSelection)
      .mockRejectedValueOnce(new Error("REMOTE_DESKTOP_CLIPBOARD_COPY_FAILED"));
    await expect(protectedField.clipboard.copyText(() => true, SIGNAL))
      .rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_COPY_FAILED");
    expect(protectedField.runtime.readVersion).not.toHaveBeenCalled();
    expect(protectedField.runtime.readText).not.toHaveBeenCalled();
  });

  it("bounds legacy UTF-16 text and injects Paste once after the current fence", async () => {
    const value = fixture({ text: "before" });
    await value.clipboard.pasteText("paste me", () => true, SIGNAL);
    expect(value.inputs).toEqual([
      [{ kind: "release" }],
      [
        { kind: "release" },
        { kind: "key", code: "ControlLeft", down: true },
        { kind: "key", code: "KeyV", down: true },
        { kind: "key", code: "KeyV", down: false },
        { kind: "key", code: "ControlLeft", down: false }
      ]
    ]);

    await expect(value.clipboard.pasteText(
      "x".repeat(REMOTE_DESKTOP_CLIPBOARD_TEXT_CODE_UNITS + 1),
      () => true,
      SIGNAL
    )).rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_TOO_LARGE");

    const retired = fixture({ text: "before" });
    let checks = 0;
    await expect(retired.clipboard.pasteText("stale", () => ++checks < 3, SIGNAL))
      .rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_EXPIRED");
    expect(retired.inputs).toEqual([[{ kind: "release" }]]);
  });

  it("copies one portable item without exposing file flavors or local paths", async () => {
    const image = pngImage(2, 3);
    const value = fixture({
      selection: "",
      text: "C:\\private\\image.png",
      html: "<a href=\"file:///private/image.png\">private</a>",
      rtf: "private path",
      formats: ["CF_HDROP", "image/png", "text/plain"],
      image,
      versions: ["4", "4"]
    });
    await expect(value.clipboard.copyContent(() => true, SIGNAL)).resolves.toEqual({
      png: image.toPNG().toString("base64")
    });
    expect(value.runtime.readText).not.toHaveBeenCalled();
    expect(value.runtime.readHtml).not.toHaveBeenCalled();
    expect(value.runtime.readRtf).not.toHaveBeenCalled();

    const fileOnly = fixture({
      selection: "",
      text: "C:\\private\\document.txt",
      formats: ["CF_HDROP", "text/plain"],
      image: emptyImage()
    });
    await expect(fileOnly.clipboard.copyContent(() => true, SIGNAL))
      .rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED");
    expect(fileOnly.runtime.readText).not.toHaveBeenCalled();
  });

  it("keeps portable alternatives together and rejects a clipboard changed during capture", async () => {
    const value = fixture({
      selection: "",
      text: "caption",
      html: "<p>caption</p>",
      rtf: "{\\rtf1 caption}",
      formats: ["text/plain", "text/html", "text/rtf"],
      image: emptyImage(),
      versions: ["9", "9"]
    });
    await expect(value.clipboard.copyContent(() => true, SIGNAL)).resolves.toEqual({
      text: "caption",
      html: "<p>caption</p>",
      rtf: "{\\rtf1 caption}"
    });

    const changed = fixture({
      selection: "",
      text: "old",
      formats: ["text/plain"],
      image: emptyImage(),
      versions: ["10", "11"]
    });
    await expect(changed.clipboard.copyContent(() => true, SIGNAL))
      .rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_CHANGED");
  });

  it("writes only admitted portable representations and never fetches a URL", async () => {
    const value = fixture({ text: "before", image: emptyImage() });
    await value.clipboard.pasteContent({
      html: "<strong>Joko</strong>",
      rtf: "{\\rtf1 Joko}",
      url: "https://example.test/path"
    }, () => true, SIGNAL);
    expect(value.runtime.write).toHaveBeenCalledWith({
      text: "https://example.test/path",
      html: "<strong>Joko</strong>",
      rtf: "{\\rtf1 Joko}"
    });
    expect(value.inputs).toHaveLength(2);

    expect(() => parseClipboardContent({ url: "file:///private/report.txt" }))
      .toThrowError("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED");
    expect(() => parseClipboardContent({ privateFormat: "secret" } as never))
      .toThrowError("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED");
  });

  it("rejects oversized or malformed PNG before native decoding", async () => {
    const malformed = fixture();
    await expect(malformed.clipboard.pasteContent({ png: "iVBORw0KGgo=" }, () => true, SIGNAL))
      .rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED");
    expect(malformed.runtime.imageFromBuffer).not.toHaveBeenCalled();

    const bytes = pngBytes(10_000, 10_000);
    await expect(malformed.clipboard.pasteContent({
      png: bytes.toString("base64")
    }, () => true, SIGNAL)).rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_TOO_LARGE");
    expect(malformed.runtime.imageFromBuffer).not.toHaveBeenCalled();
  });

  it("reads the system snapshot without selection or releasing keys and compares its expected counter", async () => {
    const value = fixture({ selection: "selection", text: "system", versions: ["5", "5"] });
    await expect(value.clipboard.readSystemContent(() => true, SIGNAL, "5")).resolves.toEqual({ text: "system" });
    expect(value.runtime.readSelection).not.toHaveBeenCalled();
    expect(value.inputs).toHaveLength(0);
    const changed = fixture({ versions: ["6"] });
    await expect(changed.clipboard.readSystemContent(() => true, SIGNAL, "5"))
      .rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_CHANGED");
    expect(changed.runtime.readText).not.toHaveBeenCalled();
  });

  it("writes a version-conditioned system item once and confirms its actual new counter without Paste", async () => {
    const value = fixture({ versions: ["4", "5"] });
    await expect(value.clipboard.writeSystemContent({ text: "new" }, "4", () => true, SIGNAL)).resolves.toBe("5");
    expect(value.runtime.write).toHaveBeenCalledOnce();
    expect(value.inputs).toHaveLength(0);
    const changed = fixture({ versions: ["6"] });
    await expect(changed.clipboard.writeSystemContent({ text: "stale" }, "4", () => true, SIGNAL))
      .rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_CHANGED");
    expect(changed.runtime.write).not.toHaveBeenCalled();
  });

  it("refuses a stale occurrence and a concurrent rewrite during post-write counter confirmation", async () => {
    const retired = fixture();
    let current = true;
    vi.mocked(retired.runtime.readVersion).mockImplementationOnce(async () => { current = false; return "1"; });
    await expect(retired.clipboard.writeSystemContent({ text: "stale" }, "1", () => current, SIGNAL))
      .rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_EXPIRED");
    expect(retired.runtime.write).not.toHaveBeenCalled();
    const raced = fixture();
    vi.mocked(raced.runtime.readVersion).mockResolvedValueOnce("1").mockImplementationOnce(async () => {
      raced.runtime.writeText("another local copy");
      return "3";
    });
    await expect(raced.clipboard.writeSystemContent({ text: "new" }, "1", () => true, SIGNAL))
      .rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_CHANGED");
    expect(raced.runtime.write).toHaveBeenCalledOnce();
    expect(raced.inputs).toHaveLength(0);
  });

  it("Linux explicit Copy uses PRIMARY text and only a confirmed empty PRIMARY falls back to system", async () => {
    const lower = linuxPort();
    lower.snapshot.mockResolvedValueOnce({ formats: ["text/plain"], content: { text: "selected" } });
    const value = fixture({ platform: "linux", linux: lower });
    expect(value.clipboard.available).toBe(true);
    await expect(value.clipboard.copyText(() => true, SIGNAL)).resolves.toBe("selected");
    expect(lower.snapshot).toHaveBeenCalledWith(true, expect.any(Function), SIGNAL);
    expect(lower.write).toHaveBeenCalledExactlyOnceWith({ text: "selected" }, expect.any(Function), SIGNAL);
    expect(value.runtime.readSelection).not.toHaveBeenCalled();
    expect(value.runtime.writeText).not.toHaveBeenCalled();
    lower.snapshot.mockResolvedValueOnce({ formats: [], content: {} });
    await expect(value.clipboard.copyText(() => true, SIGNAL)).resolves.toBe("system");
    expect(lower.snapshot.mock.calls.slice(1).map(call => call[0])).toEqual([true, false]);
    lower.snapshot.mockRejectedValueOnce(new Error("REMOTE_DESKTOP_CLIPBOARD_UNAVAILABLE"));
    const reads = lower.version.mock.calls.length;
    await expect(value.clipboard.copyText(() => true, SIGNAL)).rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_UNAVAILABLE");
    expect(lower.version).toHaveBeenCalledTimes(reads);
  });

  it("Linux explicit Paste waits for actual system readback and refuses late authority before input", async () => {
    const lower = linuxPort(); const value = fixture({ platform: "linux", linux: lower });
    lower.snapshot.mockResolvedValueOnce({ formats: ["text/plain"], content: { text: "paste" } });
    await value.clipboard.pasteText("paste", () => true, SIGNAL);
    expect(lower.write).toHaveBeenCalledWith({ text: "paste" }, expect.any(Function), SIGNAL);
    expect(value.inputs).toHaveLength(2);
    let current = true;
    lower.write.mockImplementationOnce(async () => { current = false; });
    lower.snapshot.mockResolvedValueOnce({ formats: ["text/plain"], content: { text: "late" } });
    await expect(value.clipboard.pasteText("late", () => current, SIGNAL)).rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_EXPIRED");
    expect(value.inputs).toHaveLength(3);
    expect(value.runtime.writeText).not.toHaveBeenCalled();
  });

  it("Linux system sync compares opaque fingerprints without PRIMARY, selection or input", async () => {
    const lower = linuxPort(); const value = fixture({ platform: "linux", linux: lower });
    const fingerprint = "a".repeat(64);
    await expect(value.clipboard.readSystemContent(() => true, SIGNAL, fingerprint)).resolves.toEqual({ text: "system" });
    lower.version.mockResolvedValueOnce(fingerprint).mockResolvedValueOnce("b".repeat(64));
    await expect(value.clipboard.writeSystemContent({ url: "https://example.test/" }, fingerprint, () => true, SIGNAL)).resolves.toBe("b".repeat(64));
    expect(lower.write).toHaveBeenCalledExactlyOnceWith({ url: "https://example.test/" }, expect.any(Function), SIGNAL);
    expect(lower.snapshot.mock.calls.every(call => call[0] === false)).toBe(true);
    expect(value.runtime.readSelection).not.toHaveBeenCalled();
    expect(value.inputs).toHaveLength(0);
    await expect(value.clipboard.writeSystemContent({ text: "bad" }, "A".repeat(64), () => true, SIGNAL)).rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_CHANGED");
    expect(lower.write).toHaveBeenCalledOnce();
  });

  it("Linux preserves settled unknown-write metadata without replay and detects post-write snapshot races", async () => {
    const lower = linuxPort(); const value = fixture({ platform: "linux", linux: lower });
    const unknown = Object.assign(new Error("REMOTE_DESKTOP_CLIPBOARD_OUTCOME_UNKNOWN"), { outcomeUnknown: true });
    lower.write.mockRejectedValueOnce(unknown);
    await expect(value.clipboard.writeSystemContent({ text: "once" }, "a".repeat(64), () => true, SIGNAL)).rejects.toBe(unknown);
    expect(lower.write).toHaveBeenCalledOnce();
    lower.snapshot.mockResolvedValueOnce({ formats: ["text/plain"], content: { text: "new" } })
      .mockResolvedValueOnce({ formats: ["text/plain"], content: { text: "another" } });
    await expect(value.clipboard.writeSystemContent({ text: "new" }, "a".repeat(64), () => true, SIGNAL)).rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_CHANGED");
    expect(value.inputs).toHaveLength(0);
  });
});

function linuxPort() {
  return {
    supports: vi.fn(() => true),
    snapshot: vi.fn<DesktopRemoteDesktopLinuxClipboardPort["snapshot"]>(async () => ({ formats: ["text/plain"], content: { text: "system" } })),
    write: vi.fn<DesktopRemoteDesktopLinuxClipboardPort["write"]>(async () => undefined),
    version: vi.fn<DesktopRemoteDesktopLinuxClipboardPort["version"]>(async () => "a".repeat(64))
  };
}

function fixture(options: {
  readonly selection?: string;
  readonly text?: string;
  readonly html?: string;
  readonly rtf?: string;
  readonly formats?: readonly string[];
  readonly image?: DesktopRemoteDesktopClipboardImage;
  readonly versions?: readonly string[];
  readonly platform?: NodeJS.Platform;
  readonly linux?: DesktopRemoteDesktopLinuxClipboardPort;
} = {}) {
  let text = options.text ?? "clipboard text";
  let image = options.image ?? emptyImage();
  const versions = [...(options.versions ?? ["1", "1"])];
  const inputs: unknown[][] = [];
  const runtime: DesktopRemoteDesktopClipboardRuntime = {
    platform: options.platform ?? "win32",
    releaseInput: vi.fn(() => { inputs.push([{ kind: "release" }]); }),
    pasteInput: vi.fn(() => {
      inputs.push([
        { kind: "release" },
        { kind: "key", code: "ControlLeft", down: true },
        { kind: "key", code: "KeyV", down: true },
        { kind: "key", code: "KeyV", down: false },
        { kind: "key", code: "ControlLeft", down: false }
      ]);
    }),
    readSelection: vi.fn(async () => options.selection ?? ""),
    readVersion: vi.fn(async () => versions.shift() ?? "1"),
    availableFormats: vi.fn(() => options.formats ?? ["text/plain"]),
    readText: vi.fn(() => text),
    readHtml: vi.fn(() => options.html ?? ""),
    readRtf: vi.fn(() => options.rtf ?? ""),
    readImage: vi.fn(() => image),
    writeText: vi.fn((value) => { text = value; }),
    write: vi.fn((value) => {
      if (value.text !== undefined) text = value.text;
      if (value.image !== undefined) image = value.image;
    }),
    imageFromBuffer: vi.fn((bytes) => ({
      isEmpty: () => false,
      getSize: () => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }),
      toPNG: () => bytes
    }) as never)
  };
  return {
    runtime,
    inputs,
    clipboard: new DesktopRemoteDesktopClipboard(() => undefined, runtime, options.linux)
  };
}

function emptyImage(): DesktopRemoteDesktopClipboardImage {
  return {
    isEmpty: () => true,
    getSize: () => ({ width: 0, height: 0 }),
    toPNG: () => Buffer.alloc(0)
  };
}

function pngImage(width: number, height: number): DesktopRemoteDesktopClipboardImage {
  const bytes = pngBytes(width, height);
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toPNG: () => bytes
  };
}

function pngBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
