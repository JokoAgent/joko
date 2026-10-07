import { create } from "@bufbuild/protobuf";
import { createRequire } from "node:module";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { BlobRefSchema, FileKind, FilePreviewSchema, FileRevisionSchema, WorkspaceEntrySchema, type WorkspaceEntry } from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { collectMobileMarkdownResourceCandidates, MobileMarkdownResourceReader, type MobileMarkdownResourceContext } from "./mobile-markdown-resources";
import { installMobileAbortSignalRuntime } from "./mobile-abort-runtime";
import { paddedPngBytes } from "./test/image-formats";

const sdkRequire = createRequire(createRequire(import.meta.url).resolve("react-native/package.json"));
const nativeSignals = sdkRequire("abort-controller") as { AbortController: typeof AbortController; AbortSignal: typeof AbortSignal };

const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lTQAAAAASUVORK5CYII=", "base64"));
const revision = create(FileRevisionSchema, { opaqueRevision: "image-r1", sha256Hex: bytesToHex(sha256(png)), byteSize: BigInt(png.length) });
const image = create(WorkspaceEntrySchema, { workspaceId: "workspace", relativePath: "images/a.png", kind: FileKind.REGULAR,
  displayName: "a.png", mediaType: "image/png", revision });
const file = create(WorkspaceEntrySchema, { workspaceId: "workspace", relativePath: "README.md", kind: FileKind.REGULAR,
  displayName: "README.md", mediaType: "text/markdown", revision: create(FileRevisionSchema, { ...revision, opaqueRevision: "readme-r1" }) });
const folder = create(WorkspaceEntrySchema, { workspaceId: "workspace", relativePath: "src", kind: FileKind.DIRECTORY });
const blob = create(BlobRefSchema, { blobId: "canonical-image", fileName: "a.png", mediaType: "image/png",
  byteSize: revision.byteSize, sha256Hex: revision.sha256Hex });
function context(entries: readonly WorkspaceEntry[] = [image, file, folder]): MobileMarkdownResourceContext {
  return {
    workspaceId: "workspace", workdir: "D:\\repo",
    assertCurrent: vi.fn((signal?: AbortSignal) => signal?.throwIfAborted()),
    revalidateSource: vi.fn(async () => undefined),
    listDirectory: vi.fn(async (parent) => ({ entries: entries.filter((entry) => entry.relativePath.split("/").slice(0, -1).join("/") === parent), revision: "directory-r1" })),
    readFile: vi.fn(async (entry) => create(FilePreviewSchema, { entry, content: { case: "image", value: { blob, widthPixels: 1, heightPixels: 1 } } })),
    download: vi.fn(async () => ({ bytes: png, mediaType: "image/png" }))
  };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("canonical message Markdown resources", () => {
  it.each(["png", "webp"] as const)("retains original EXIF %s bytes and bounded native canvas choices", async (format) => {
    const bytes = await sharp({ create: { width: 6, height: 4, channels: 3, background: "orange" } })
      .withMetadata({ orientation: 6 }).toFormat(format).toBuffer();
    const exactRevision = create(FileRevisionSchema, { opaqueRevision: "portrait-r1", sha256Hex: bytesToHex(sha256(bytes)), byteSize: BigInt(bytes.length) });
    const entry = create(WorkspaceEntrySchema, { ...image, relativePath: "images/portrait." + format, displayName: "portrait." + format,
      mediaType: "image/" + format, revision: exactRevision });
    const exactBlob = create(BlobRefSchema, { ...blob, fileName: entry.displayName, mediaType: entry.mediaType,
      byteSize: exactRevision.byteSize, sha256Hex: exactRevision.sha256Hex });
    const source = context([entry]);
    vi.mocked(source.readFile).mockResolvedValue(create(FilePreviewSchema, { entry,
      content: { case: "image", value: { blob: exactBlob, widthPixels: 4, heightPixels: 6 } } }));
    vi.mocked(source.download).mockResolvedValue({ bytes, mediaType: entry.mediaType });
    const reader = new MobileMarkdownResourceReader();
    const descriptor = await reader.prepare("portrait", "![portrait](" + entry.relativePath + ")", source, new AbortController().signal);
    expect([...descriptor.references.values()][0]?.image).toEqual({ width: 6, height: 4, nativeQuarterTurn: true,
      uri: "data:" + entry.mediaType + ";base64," + bytes.toString("base64") });
    reader.releaseAll();
  });

  it("resolves code, explicit, bare and file-URI paths inside the exact Workspace and retains line targets", () => {
    const candidates = collectMobileMarkdownResourceCandidates(
      '`README.md:7:3` [source](src/)\nD:\\repo\\README.md:8\n\n![one](images/a.png) ![two](file:///D:/repo/images/a.png)\n\n'
      + '![outside](../a.png) ![remote](https://example.invalid/a.png) [outside](D:/elsewhere/a.txt) `ordinary word`', "D:\\repo");
    expect(candidates.map((candidate) => candidate.relativePath)).toEqual(["README.md", "src", "README.md", "images/a.png", "images/a.png"]);
    expect(candidates[0]).toMatchObject({ line: 7, column: 3 });
    expect(candidates[2]).toMatchObject({ line: 8 });
    expect(collectMobileMarkdownResourceCandidates("![x](file://other-host/repo/a.png) ![x](data:image/png;base64,AAAA)", "/repo")).toEqual([]);
  });

  it.each(["standard", "native"] as const)("adopts exact-version image bytes and revalidates their source with %s cancellation signals", async (runtime) => {
    if (runtime === "native") {
      vi.stubGlobal("AbortController", nativeSignals.AbortController);
      vi.stubGlobal("AbortSignal", nativeSignals.AbortSignal);
      vi.stubGlobal("btoa", undefined);
      installMobileAbortSignalRuntime();
    }
    const reader = new MobileMarkdownResourceReader();
    const source = context();
    const descriptor = await reader.prepare("message-1", "![one](images/a.png) `README.md:7:3` [src](src/)", source, new AbortController().signal);
    const [imageKey, fileKey, folderKey] = [...descriptor.references.keys()];
    expect(descriptor.references.get(imageKey!)).toMatchObject({ kind: "image", image: { width: 1, height: 1, uri: expect.stringMatching(/^data:image\/png;base64,/u) } });
    expect(source.download).toHaveBeenCalledWith(blob, expect.any(AbortSignal));
    expect(await reader.revalidate("message-1", fileKey!, new AbortController().signal)).toMatchObject({ candidate: { line: 7, column: 3 }, entry: file });
    expect(await reader.revalidate("message-1", folderKey!, new AbortController().signal)).toMatchObject({ entry: folder });
    expect(source.revalidateSource).toHaveBeenCalledTimes(2);
    reader.retain("message-1"); reader.release("message-1");
    expect(reader.imagePages("message-1")).toHaveLength(1);
    vi.mocked(source.listDirectory).mockResolvedValue({ entries: [create(WorkspaceEntrySchema, { ...image,
      revision: create(FileRevisionSchema, { ...revision, opaqueRevision: "image-r2" }) })], revision: "directory-r2" });
    await expect(reader.revalidate("message-1", imageKey!, new AbortController().signal)).rejects.toThrow(/changed/u);
    reader.release("message-1");
    expect(() => reader.imagePages("message-1")).toThrow(/released/u);
  });

  it("keeps failed, ambiguous, foreign and over-budget resources as labels without adopting bytes", async () => {
    for (const failure of ["hash", "mime", "dimensions", "partialDimensions", "preview", "directory", "size", "duplicate"] as const) {
      const entry = failure === "size" ? create(WorkspaceEntrySchema, { ...image,
        revision: create(FileRevisionSchema, { ...revision, byteSize: 8n * 1_024n * 1_024n + 1n }) }) : image;
      const source = context([entry]);
      if (failure === "hash") vi.mocked(source.download).mockResolvedValue({ bytes: Uint8Array.from([1, 2]), mediaType: "image/png" });
      if (failure === "mime") vi.mocked(source.download).mockResolvedValue({ bytes: png, mediaType: "image/jpeg" });
      if (failure === "dimensions") vi.mocked(source.readFile).mockResolvedValue(create(FilePreviewSchema, { entry, content: { case: "image", value: { blob, widthPixels: 4, heightPixels: 3 } } }));
      if (failure === "partialDimensions") vi.mocked(source.readFile).mockResolvedValue(create(FilePreviewSchema, { entry, content: { case: "image", value: { blob, widthPixels: 1, heightPixels: 0 } } }));
      if (failure === "preview") vi.mocked(source.readFile).mockResolvedValue(create(FilePreviewSchema, { entry: create(WorkspaceEntrySchema, { ...entry, workspaceId: "foreign" }), content: { case: "blob", value: blob } }));
      if (failure === "directory") vi.mocked(source.listDirectory).mockResolvedValue({ entries: [create(WorkspaceEntrySchema, { ...entry, workspaceId: "foreign" })], revision: "directory" });
      if (failure === "duplicate") vi.mocked(source.listDirectory).mockResolvedValue({ entries: [entry, entry], revision: "directory" });
      const reader = new MobileMarkdownResourceReader();
      const prepared = await reader.prepare("failure", "![one](images/a.png) `missing` [unknown](absent.txt) ![external](https://example.invalid/a.png)", source, new AbortController().signal);
      expect([...prepared.references.values()].some((reference) => reference.image !== undefined), failure).toBe(false);
      expect(() => reader.imagePages("failure"), failure).toThrow(/released/u);
      if (failure === "size" || failure === "directory" || failure === "duplicate") expect(source.download).not.toHaveBeenCalled();
      reader.releaseAll();
    }
  });

  it("reserves two actual reads, removes a cancelled waiter and fences late bytes until the original read settles", async () => {
    const reader = new MobileMarkdownResourceReader();
    const source = context();
    const pending: ((value: { entries: readonly WorkspaceEntry[]; revision: string }) => void)[] = [];
    let active = 0; let peak = 0;
    vi.mocked(source.listDirectory).mockImplementation(() => {
      active += 1; peak = Math.max(peak, active);
      return new Promise((resolve) => pending.push((value) => { active -= 1; resolve(value); }));
    });
    const one = reader.prepare("one", "`README.md`", source, new AbortController().signal);
    const two = reader.prepare("two", "`README.md`", source, new AbortController().signal);
    const cancel = new AbortController();
    const three = reader.prepare("three", "`README.md`", source, cancel.signal);
    const retired = expect(three).rejects.toThrow(/abort|cancel/u);
    const four = reader.prepare("four", "`README.md`", source, new AbortController().signal);
    await vi.waitFor(() => expect(source.listDirectory).toHaveBeenCalledTimes(2));
    cancel.abort(); await retired;
    pending[0]!({ entries: [file], revision: "one" }); await one;
    await vi.waitFor(() => expect(source.listDirectory).toHaveBeenCalledTimes(3));
    pending[1]!({ entries: [file], revision: "two" }); pending[2]!({ entries: [file], revision: "four" });
    await Promise.all([two, four]); expect(peak).toBe(2);
    reader.releaseAll();
  });

  it("bounds cached image bytes across mounted messages and restores capacity when the owner releases them", async () => {
    const reader = new MobileMarkdownResourceReader();
    const bytes = paddedPngBytes(png, 8 * 1_024 * 1_024);
    const largeRevision = create(FileRevisionSchema, { ...revision, byteSize: BigInt(bytes.length), sha256Hex: bytesToHex(sha256(bytes)) });
    const largeImage = create(WorkspaceEntrySchema, { ...image, revision: largeRevision });
    const largeBlob = create(BlobRefSchema, { ...blob, byteSize: largeRevision.byteSize, sha256Hex: largeRevision.sha256Hex });
    const source = context([largeImage]);
    for (let index = 0; index < 70; index += 1) {
      expect((await reader.prepare("plain-" + index, "An ordinary answer", source, new AbortController().signal)).references.size).toBe(0);
    }
    expect(source.listDirectory).not.toHaveBeenCalled();
    vi.mocked(source.readFile).mockResolvedValue(create(FilePreviewSchema, { entry: largeImage,
      content: { case: "image", value: { blob: largeBlob, widthPixels: 1, heightPixels: 1 } } }));
    vi.mocked(source.download).mockResolvedValue({ bytes, mediaType: "image/png" });
    for (const id of ["one", "two", "three"]) await reader.prepare(id, "![one](images/a.png)", source, new AbortController().signal);
    expect(reader.imagePages("one")).toHaveLength(1); expect(reader.imagePages("two")).toHaveLength(1);
    expect(() => reader.imagePages("three")).toThrow(/released/u); expect(source.download).toHaveBeenCalledTimes(2);
    reader.release("one");
    await reader.prepare("four", "![one](images/a.png)", source, new AbortController().signal);
    expect(reader.imagePages("four")).toHaveLength(1); expect(source.download).toHaveBeenCalledTimes(3);
    reader.releaseAll();
  });

  it("retires source drift and the preparation deadline without adopting late downloads", async () => {
    for (const reason of ["source", "deadline"] as const) {
      const reader = new MobileMarkdownResourceReader(); const source = context();
      let current = true;
      vi.mocked(source.assertCurrent).mockImplementation((signal) => { signal?.throwIfAborted(); if (!current) throw new Error("source changed"); });
      let finish!: (value: { bytes: Uint8Array; mediaType: string }) => void;
      if (reason === "deadline") vi.useFakeTimers();
      vi.mocked(source.download).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
      const prepared = reader.prepare(reason, "![one](images/a.png)", source, new AbortController().signal);
      const retired = expect(prepared).rejects.toThrow(/source|abort|cancel/u);
      for (let index = 0; index < 12 && !finish; index += 1) await Promise.resolve();
      expect(source.download).toHaveBeenCalledTimes(1);
      if (reason === "source") { current = false; reader.retireStale(); }
      else await vi.advanceTimersByTimeAsync(15_001);
      await retired; finish({ bytes: png, mediaType: "image/png" });
      await Promise.resolve();
      expect(() => reader.imagePages(reason)).toThrow(/released/u);
      vi.useRealTimers();
    }
  });
});
