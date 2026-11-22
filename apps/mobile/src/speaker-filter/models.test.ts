import { beforeEach, expect, it, vi } from "vitest";
import { downloadMobileSpeakerModels, mobileSpeakerModelsPresent, prepareMobileSpeakerModels, SPEAKER_DOWNLOAD_BYTES } from "./models";

const fixture = vi.hoisted(() => ({
  files: new Map<string, { size: number; hash?: string; bytes?: Uint8Array }>(),
  download: vi.fn(), load: vi.fn(async () => undefined)
}));

vi.mock("expo-file-system", () => {
  class File {
    constructor(_directory: unknown, readonly uri: string) {}
    get exists() { return fixture.files.has(this.uri); }
    get size() { return fixture.files.get(this.uri)?.size ?? 0; }
    create() { fixture.files.set(this.uri, { size: 0 }); }
    write(bytes: Uint8Array) {
      fixture.files.set(this.uri, { size: bytes.length, hash: bytes[15] === 46
        ? "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2" : undefined });
    }
    bytes() { return fixture.files.get(this.uri)!.bytes; }
    delete() { fixture.files.delete(this.uri); }
    move(destination: File) {
      fixture.files.set(destination.uri, fixture.files.get(this.uri)!);
      this.delete();
    }
    static downloadFileAsync = fixture.download;
  }
  return { File, Directory: class { create() {} }, Paths: { cache: "" } };
});
vi.mock("./native", () => ({
  sha256File: async (uri: string) => fixture.files.get(uri)?.hash,
  loadSpeakerModels: fixture.load
}));

const vadName = "silero-vad.onnx";
const embeddingName = "campplus-zh-en-advanced.onnx";
const vad = { size: 643_854, hash: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6" };
const uploadHash = "53cab20ba8f2eb2f6e2d89ecc18e88ef3222169b61b4419cbc13666744a4574b";

beforeEach(() => { fixture.files.clear(); fixture.files.set(vadName, vad); fixture.download.mockReset(); fixture.load.mockClear(); });

it("reports cumulative byte progress, cancels its transfer and only loads verified models after retry", async () => {
  const cancel = new AbortController(), progress = vi.fn();
  fixture.download.mockImplementationOnce(async (_url, target, options) => {
    options.onProgress({ bytesWritten: 2048 });
    expect(progress).toHaveBeenLastCalledWith(vad.size + 2048);
    fixture.files.set(target.uri, { size: 2048 });
    cancel.abort();
    expect(options.signal.aborted).toBe(true);
    return target;
  });
  await expect(downloadMobileSpeakerModels(cancel.signal, progress)).rejects.toMatchObject({ name: "AbortError" });
  expect([...fixture.files]).toEqual([[vadName, vad]]);
  await expect(mobileSpeakerModelsPresent()).resolves.toBe(false);

  fixture.download.mockImplementationOnce(async (_url, target) => {
    fixture.files.set(target.uri, { size: 28_281_165, hash: "incorrect" });
    return target;
  });
  await expect(downloadMobileSpeakerModels(new AbortController().signal, progress)).rejects.toThrow(/integrity/u);
  expect([...fixture.files]).toEqual([[vadName, vad]]);

  fixture.download.mockImplementationOnce(async (_url, target, options) => {
    const bytes = new Uint8Array(28_281_165);
    bytes[16] = 46;
    const attribute = [10, 17, ...new TextEncoder().encode("count_include_pad"), 24, 0, 160, 1, 2];
    for (let index = 0; index < 52; index++) bytes.set(attribute, 64 + index * 32);
    fixture.files.set(target.uri, { size: bytes.length, hash: uploadHash, bytes });
    options.onProgress({ bytesWritten: bytes.length });
    return target;
  });
  await downloadMobileSpeakerModels(new AbortController().signal, progress);
  expect(progress).toHaveBeenLastCalledWith(SPEAKER_DOWNLOAD_BYTES);
  expect([...fixture.files.keys()]).toEqual([vadName, embeddingName]);
  await expect(mobileSpeakerModelsPresent()).resolves.toBe(true);
  await prepareMobileSpeakerModels();
  expect(fixture.load).toHaveBeenCalledExactlyOnceWith({ vad: vadName, embedding: embeddingName });
  fixture.files.delete(embeddingName);
  await expect(prepareMobileSpeakerModels()).rejects.toThrow(/download verified/iu);
});
