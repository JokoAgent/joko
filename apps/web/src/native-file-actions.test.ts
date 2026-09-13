// @vitest-environment jsdom
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, expect, it, vi } from "vitest";
import { copyNativeArtifactFile, NATIVE_FILE_COPY_MAXIMUM_BYTES } from "./native-file-actions.js";

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
const host = () => ({ copyFile: vi.fn().mockResolvedValue({ status: "copied" }), cancelFileCopy: vi.fn().mockResolvedValue(undefined) });
const context = () => ({ ownerDocument: document, signal: new AbortController().signal });
const blob = () => new NodeBlob([new Uint8Array([1, 2])], { type: "video/mp4" }) as unknown as Blob;

it("passes only authorized bytes to the captured host and preserves post-dispatch results and unknown rejection", async () => {
  const native = host(); const result = deferred<JokoDesktopCopyFileResult>();
  native.copyFile.mockImplementationOnce(() => result.promise).mockRejectedValueOnce(new Error("IPC acknowledgement lost"));
  const request = new AbortController();
  const pending = copyNativeArtifactFile(blob(), "video.mp4", { ownerDocument: document, signal: request.signal }, native);
  await vi.waitFor(() => expect(native.copyFile).toHaveBeenCalledOnce());
  const value = native.copyFile.mock.calls[0]![0];
  expect(value.file).toEqual({ name: "video.mp4", mediaType: "video/mp4", bytes: new Uint8Array([1, 2]) });
  request.abort(); expect(native.cancelFileCopy).toHaveBeenCalledExactlyOnceWith(value.requestId);
  result.resolve({ status: "copied" });
  await expect(pending).resolves.toEqual({ status: "copied" });
  await expect(copyNativeArtifactFile(blob(), "video.mp4", context(), native)).resolves.toEqual({ status: "unknown" });
  expect(native.copyFile).toHaveBeenCalledTimes(2);
});

it.each(["signal", "document"] as const)("does not dispatch after byte encoding outlives its %s", async (retired) => {
  const native = host(); const request = new AbortController(); const bytes = deferred<ArrayBuffer>();
  const frame = document.createElement("iframe"); document.body.append(frame);
  const doc = frame.contentDocument!;
  const owner = retired === "document" ? doc : document;
  const pending = copyNativeArtifactFile({ size: 2, type: "video/mp4", arrayBuffer: () => bytes.promise } as Blob, "video.mp4", { ownerDocument: owner, signal: request.signal }, native);
  const failed = expect(pending).rejects.toThrow();
  if (retired === "signal") request.abort(); else Object.defineProperty(doc, "defaultView", { value: null });
  bytes.resolve(new Uint8Array([1, 2]).buffer);
  await failed; expect(native.copyFile).not.toHaveBeenCalled();
});

it("does not prepare unsupported or oversized files", async () => {
  const native = host(); const arrayBuffer = vi.fn();
  await expect(copyNativeArtifactFile(blob(), "video.mp4", context(), undefined)).resolves.toEqual({ status: "unavailable" });
  await expect(copyNativeArtifactFile({ size: NATIVE_FILE_COPY_MAXIMUM_BYTES + 1, arrayBuffer } as unknown as Blob, "video.mp4", context(), native)).resolves.toEqual({ status: "failed", reason: "capacity" });
  expect(arrayBuffer).not.toHaveBeenCalled(); expect(native.copyFile).not.toHaveBeenCalled();
});

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((accept) => { resolve = accept; }); return { promise, resolve }; }
