import { describe, expect, it, vi } from "vitest";

import { clipboardAttachmentFiles } from "./composer-clipboard.js";

describe("composer clipboard attachments", () => {
  it("prefers item files so an in-memory screenshot enters the attachment chain once", () => {
    const image = new File([new Uint8Array([1, 2, 3])], "screenshot.png", { type: "image/png" });
    const getAsFile = vi.fn(() => image);

    expect(clipboardAttachmentFiles({
      items: [{ kind: "file", type: "image/png", getAsFile, webkitGetAsEntry: () => null }] as unknown as DataTransferItemList,
      files: [image] as unknown as FileList
    })).toEqual([image]);
    expect(getAsFile).toHaveBeenCalledOnce();
  });

  it("falls back to the clipboard file list and ignores text and directory items", () => {
    const document = new File(["notes"], "notes.txt", { type: "text/plain" });
    const directoryFile = new File([], "folder", { type: "" });

    expect(clipboardAttachmentFiles({
      items: [
        { kind: "string", type: "text/plain", getAsFile: () => null } as unknown as DataTransferItem,
        { kind: "file", type: "", getAsFile: () => directoryFile, webkitGetAsEntry: () => ({ isDirectory: true }) } as unknown as DataTransferItem
      ] as unknown as DataTransferItemList,
      files: [directoryFile, document] as unknown as FileList
    })).toEqual([document]);
  });
});
