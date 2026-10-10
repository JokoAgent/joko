import { create } from "@bufbuild/protobuf";
import { PartnerAvatarSchema } from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mobilePartnerPhotoValid, pickMobilePartnerPhoto, projectMobilePartnerAvatar } from "./mobile-partner-avatar";

const native = vi.hoisted(() => ({ picker: vi.fn(), save: vi.fn(), render: vi.fn(), resize: vi.fn(), releaseImage: vi.fn(), releaseContext: vi.fn(), remove: vi.fn() }));
vi.mock("expo-image-picker", () => ({ launchImageLibraryAsync: native.picker }));
vi.mock("expo-image-manipulator", () => ({ SaveFormat: { JPEG: "jpeg" }, ImageManipulator: { manipulate: () => ({ resize: native.resize,
  renderAsync: native.render, release: native.releaseContext }) } }));
vi.mock("expo-file-system", () => ({ File: class { constructor(readonly uri: string) {} delete() { native.remove(this.uri); } } }));
afterEach(() => vi.resetAllMocks());

describe("Partner photo boundary", () => {
  it("projects only the current preset or bounded image descriptor, not bytes or unknown shapes", () => {
    expect(projectMobilePartnerAvatar(create(PartnerAvatarSchema, { value: { case: "presetId", value: "orbit" } }))).toBe("orbit");
    expect(projectMobilePartnerAvatar(create(PartnerAvatarSchema, { value: { case: "image", value: {
      sha256: "a".repeat(64), mimeType: "image/jpeg", byteLength: 42n } } }))).toEqual({ sha256: "a".repeat(64), mimeType: "image/jpeg", byteLength: 42 });
    expect(() => projectMobilePartnerAvatar(create(PartnerAvatarSchema))).toThrow();
    expect(() => projectMobilePartnerAvatar(create(PartnerAvatarSchema, { value: { case: "image", value: {
      sha256: "a".repeat(64), mimeType: "image/svg+xml", byteLength: 42n } } }))).toThrow();
    expect(mobilePartnerPhotoValid("/9j/2w==")).toBe(true);
    expect(mobilePartnerPhotoValid("/9j/2w=")).toBe(false);
  });

  it("crops to 256px, lowers JPEG quality within the exact budget and releases only generated thumbnails", async () => {
    native.picker.mockResolvedValue({ canceled: false, assets: [{ uri: "file:///original-photo" }] });
    native.render.mockResolvedValue({ saveAsync: native.save, release: native.releaseImage });
    native.save.mockResolvedValueOnce({ uri: "file:///generated-one", base64: "A".repeat(55_004) })
      .mockResolvedValueOnce({ uri: "file:///generated-two", base64: "/9j/2w==" });
    expect(await pickMobilePartnerPhoto(new AbortController().signal)).toEqual({ base64: "/9j/2w==" });
    expect(native.picker).toHaveBeenCalledWith({ mediaTypes: ["images"], allowsEditing: true, aspect: [1, 1], quality: 1 });
    expect(native.resize).toHaveBeenCalledWith({ width: 256, height: 256 });
    expect(native.save.mock.calls.map((call) => call[0].compress)).toEqual([0.85, 0.65]);
    expect(native.remove.mock.calls).toEqual([["file:///generated-one"], ["file:///generated-two"]]);
    expect(native.releaseImage).toHaveBeenCalledOnce(); expect(native.releaseContext).toHaveBeenCalledOnce();
  });

  it("keeps cancellation empty and retires a late picker before decoding or releasing the original photo", async () => {
    native.picker.mockResolvedValueOnce({ canceled: true, assets: [] });
    expect(await pickMobilePartnerPhoto(new AbortController().signal)).toBeUndefined();
    const abort = new AbortController(); let finish!: (value: unknown) => void;
    native.picker.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const result = pickMobilePartnerPhoto(abort.signal); await vi.waitFor(() => expect(native.picker).toHaveBeenCalledTimes(2));
    abort.abort(); finish({ canceled: false, assets: [{ uri: "file:///original-photo" }] });
    await expect(result).rejects.toThrow(); expect(native.render).not.toHaveBeenCalled(); expect(native.remove).not.toHaveBeenCalled();
  });
});
