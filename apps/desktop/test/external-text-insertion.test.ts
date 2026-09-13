import type { NativeImage } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  externalPasteCommand,
  insertTextIntoForegroundApplication,
  type ExternalClipboard
} from "../src/external-text-insertion.js";

describe("external text insertion", () => {
  it("uses fixed platform paste commands without interpolating transcript text", () => {
    expect(externalPasteCommand("win32")).toMatchObject({ command: "powershell.exe" });
    expect(externalPasteCommand("darwin")).toMatchObject({ command: "/usr/bin/osascript" });
    expect(externalPasteCommand("linux")).toEqual({ command: "xdotool", args: ["key", "--clearmodifiers", "ctrl+v"] });
    expect(externalPasteCommand("aix")).toBeUndefined();
  });

  it("restores the common clipboard representations after a successful paste", async () => {
    const clipboard = fakeClipboard({ text: "before", html: "<b>before</b>", rtf: "{before}" });
    const runCommand = vi.fn(async () => true);
    const result = await insertTextIntoForegroundApplication("spoken text", {
      clipboard,
      platform: "win32",
      runCommand,
      delay: async () => undefined
    });
    expect(result.inserted).toBe(true);
    await result.restored;
    expect(runCommand).toHaveBeenCalledOnce();
    expect(clipboard.value.text).toBe("before");
    expect(clipboard.value.html).toBe("<b>before</b>");
    expect(clipboard.value.rtf).toBe("{before}");
  });

  it("does not overwrite a clipboard value changed by the user after paste", async () => {
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    const clipboard = fakeClipboard({ text: "before" });
    const result = await insertTextIntoForegroundApplication("spoken text", {
      clipboard,
      platform: "darwin",
      runCommand: async () => true,
      delay: () => delayed
    });
    clipboard.value.text = "new user copy";
    release();
    await result.restored;
    expect(clipboard.value.text).toBe("new user copy");
  });

  it("restores immediately when the host paste command fails and rejects unsafe text", async () => {
    const clipboard = fakeClipboard({ text: "before" });
    const failed = await insertTextIntoForegroundApplication("spoken text", {
      clipboard,
      platform: "linux",
      runCommand: async () => false
    });
    expect(failed.inserted).toBe(false);
    expect(clipboard.value.text).toBe("before");
    expect((await insertTextIntoForegroundApplication("bad\u0000text", {
      clipboard,
      platform: "win32",
      runCommand: async () => true
    })).inserted).toBe(false);
  });

  it("restores app-specific raw formats without rewriting standard text buffers", async () => {
    const customFormat = "application/x-joko-editor-state";
    const clipboard = fakeClipboard({
      text: "before",
      buffers: new Map([
        ["text/plain", Buffer.from("before")],
        [customFormat, Buffer.from([1, 2, 3, 4])]
      ])
    });
    const result = await insertTextIntoForegroundApplication("spoken text", {
      clipboard,
      platform: "win32",
      runCommand: async () => true,
      delay: async () => undefined
    });
    await result.restored;

    expect(clipboard.value.text).toBe("before");
    expect(clipboard.value.buffers.get(customFormat)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(clipboard.writeBufferFormats).toEqual([customFormat]);
  });

  it("prefers exact raw restoration for file clipboard payloads", async () => {
    const fileFormat = "FileNameW";
    const clipboard = fakeClipboard({
      text: "C:\\work\\report.txt",
      buffers: new Map([
        ["text/plain", Buffer.from("C:\\work\\report.txt", "utf16le")],
        [fileFormat, Buffer.from("C:\\work\\report.txt\0", "utf16le")]
      ])
    });
    const result = await insertTextIntoForegroundApplication("spoken text", {
      clipboard,
      platform: "win32",
      runCommand: async () => true,
      delay: async () => undefined
    });
    await result.restored;

    expect(clipboard.value.buffers.get(fileFormat)).toEqual(Buffer.from("C:\\work\\report.txt\0", "utf16le"));
    expect(clipboard.writeBufferFormats).toEqual(["text/plain", fileFormat]);
    expect(clipboard.writeCalls).toBe(0);
  });
});

function fakeClipboard(initial: Partial<{
  text: string;
  html: string;
  rtf: string;
  buffers: ReadonlyMap<string, Buffer>;
}>): ExternalClipboard & {
  readonly value: { text: string; html: string; rtf: string; buffers: Map<string, Buffer> };
  readonly writeBufferFormats: string[];
  readonly writeCalls: number;
} {
  const value = {
    text: initial.text ?? "",
    html: initial.html ?? "",
    rtf: initial.rtf ?? "",
    buffers: new Map(Array.from(initial.buffers ?? [], ([format, buffer]) => [format, Buffer.from(buffer)]))
  };
  const emptyImage = { isEmpty: () => true } as NativeImage;
  const writeBufferFormats: string[] = [];
  let writeCalls = 0;
  return {
    value,
    writeBufferFormats,
    get writeCalls() { return writeCalls; },
    availableFormats: () => [...value.buffers.keys()],
    readText: () => value.text,
    readHTML: () => value.html,
    readRTF: () => value.rtf,
    readBookmark: () => ({ title: "", url: "" }),
    readImage: () => emptyImage,
    readBuffer: (format) => Buffer.from(value.buffers.get(format) ?? []),
    writeText: (text) => {
      value.text = text;
      value.html = "";
      value.rtf = "";
      value.buffers.clear();
      value.buffers.set("text/plain", Buffer.from(text));
    },
    write: (data) => {
      writeCalls += 1;
      value.text = data.text ?? "";
      value.html = data.html ?? "";
      value.rtf = data.rtf ?? "";
      value.buffers.clear();
      if (data.text !== undefined) value.buffers.set("text/plain", Buffer.from(data.text));
      if (data.html !== undefined) value.buffers.set("text/html", Buffer.from(data.html));
      if (data.rtf !== undefined) value.buffers.set("text/rtf", Buffer.from(data.rtf));
    },
    writeBuffer: (format, buffer) => {
      writeBufferFormats.push(format);
      value.buffers.set(format, Buffer.from(buffer));
    },
    clear: () => {
      value.text = "";
      value.html = "";
      value.rtf = "";
      value.buffers.clear();
    }
  };
}
