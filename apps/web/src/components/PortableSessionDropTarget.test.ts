// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  portableSessionDragHint,
  portableSessionDropFile
} from "./PortableSessionDropTarget.js";

describe("portable session window drop policy", () => {
  it("takes over only a single package during hover", () => {
    expect(portableSessionDragHint(transfer({ itemType: "application/vnd.joko.session" }))).toBe(true);
    expect(portableSessionDragHint(transfer({ itemType: "application/octet-stream" }))).toBe(false);
    expect(portableSessionDragHint(transfer({ itemType: "application/vnd.joko.session", itemCount: 2 }))).toBe(false);
  });

  it("routes one package by its exact extension at drop time", () => {
    const packageFile = new File(["package"], "Task.JSHARE");
    expect(portableSessionDropFile(transfer({ files: [packageFile] }))).toBe(packageFile);
    expect(portableSessionDropFile(transfer({ files: [new File(["x"], "Task.jshare.zip")] }))).toBeUndefined();
    expect(portableSessionDropFile(transfer({ files: [packageFile, packageFile] }))).toBeUndefined();
  });
});

function transfer(options: {
  readonly itemType?: string;
  readonly itemCount?: number;
  readonly files?: readonly File[];
}): DataTransfer {
  const items = Array.from({ length: options.itemCount ?? 1 }, () => ({
    kind: "file",
    type: options.itemType ?? ""
  }));
  return {
    items,
    files: options.files ?? [],
    dropEffect: "none"
  } as unknown as DataTransfer;
}
