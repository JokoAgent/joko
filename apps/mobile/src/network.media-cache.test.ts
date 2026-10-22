import { create, toBinary } from "@bufbuild/protobuf";
import { BeginBlobUploadResponseSchema, BlobDisposition, BlobRefSchema, CompleteBlobUploadResponseSchema, GetBlobDownloadTicketResponseSchema, GetImageThumbnailResponseSchema, ImageThumbnailSchema, TransferDirection } from "@joko/contracts";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { mobileMediaByteCache } from "./mobile-media-byte-cache";
import { mobileNetwork, type PairedCredential } from "./network";

vi.mock("expo-crypto", async () => {
  const { createHash } = await import("node:crypto");
  return { CryptoDigestAlgorithm: { SHA256: "SHA256" }, digest: async (_algorithm: string, input: Uint8Array) => Uint8Array.from(createHash("sha256").update(input).digest()).buffer };
});
const local = vi.hoisted(() => ({ bytes: new Uint8Array([1, 2, 3]), upload: vi.fn(async () => ({ status: 200 })) }));
vi.mock("expo-file-system", () => ({ UploadType: { BINARY_CONTENT: 0 }, File: class {
  readonly exists = true;
  get size() { return local.bytes.length; }
  async bytes() { return local.bytes.slice(); }
  upload = local.upload;
} }));
afterEach(() => vi.restoreAllMocks());
const owner: PairedCredential = { profileId: "profile", origin: "https://node.example", serverId: "server", connectionId: "connection", deviceId: "phone", displayName: "Node", authKey: "fixture-only" };
const bytes = new Uint8Array([1, 2, 3]);
const blob = create(BlobRefSchema, { blobId: "image", mediaType: "image/png", fileName: "image.png", byteSize: 3n, sha256Hex: createHash("sha256").update(bytes).digest("hex") });
const ticket = { ticketId: "download", blobId: "image", direction: TransferDirection.DOWNLOAD, maximumBytes: 3n, requiredMediaType: "image/png", relativeEndpoint: "/v1/blobs/download" };
const response = () => new Response(toBinary(GetBlobDownloadTicketResponseSchema, create(GetBlobDownloadTicketResponseSchema, { ticket })), { headers: { "content-type": "application/proto" } });

it("reauthorizes cached original bytes and preserves an explicit server denial", async () => {
  const cached = vi.spyOn(mobileMediaByteCache, "get").mockResolvedValue({ bytes, mediaType: "image/png" });
  const put = vi.spyOn(mobileMediaByteCache, "put").mockResolvedValue();
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => response());
  expect(await mobileNetwork.downloadBlob(owner, blob)).toEqual({ bytes, mediaType: "image/png" });
  expect(fetcher).toHaveBeenCalledOnce(); expect(String(fetcher.mock.calls[0]![0])).toContain("/GetBlobDownloadTicket");
  expect(put).not.toHaveBeenCalled(); expect(cached).toHaveBeenCalledOnce();
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ code: "permission_denied", message: "revoked" }), { status: 403, headers: { "content-type": "application/json" } }));
  await expect(mobileNetwork.downloadBlob(owner, blob)).rejects.toThrow(/revoked/u); expect(cached).toHaveBeenCalledOnce();
});

it("uses a cached thumbnail only after authorization and saves an authenticated new thumbnail", async () => {
  const thumbnail = create(ImageThumbnailSchema, { data: bytes, sha256Hex: blob.sha256Hex, mediaType: "image/webp", widthPixels: 1, heightPixels: 1, sourceWidthPixels: 2, sourceHeightPixels: 2 });
  const get = vi.spyOn(mobileMediaByteCache, "getThumbnail").mockResolvedValue(thumbnail);
  const put = vi.spyOn(mobileMediaByteCache, "putThumbnail").mockResolvedValue();
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => response());
  expect(await mobileNetwork.readImageThumbnail(owner, blob, 1024)).toEqual(thumbnail);
  expect(fetcher).toHaveBeenCalledOnce(); expect(String(fetcher.mock.calls[0]![0])).toContain("/GetBlobDownloadTicket");
  get.mockResolvedValueOnce(undefined);
  fetcher.mockResolvedValueOnce(new Response(toBinary(GetImageThumbnailResponseSchema, create(GetImageThumbnailResponseSchema, { sourceBlob: blob, result: { case: "thumbnail", value: thumbnail } })),
    { headers: { "content-type": "application/proto" } }));
  expect(await mobileNetwork.readImageThumbnail(owner, blob, 1024)).toEqual(thumbnail);
  expect(put).toHaveBeenCalledExactlyOnceWith(owner, blob, 1024, thumbnail, expect.any(Function));
});

it("does not let a download that outlives profile cleanup recreate the media cache", async () => {
  vi.spyOn(mobileMediaByteCache, "get").mockResolvedValue(undefined);
  const put = vi.spyOn(mobileMediaByteCache, "put").mockResolvedValue();
  let retire!: () => void;
  vi.spyOn(mobileMediaByteCache, "captureOwner").mockImplementation(() => { let retired = false; retire = () => { retired = true; }; return () => { if (retired) throw new Error("owner cleared"); }; });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (String(url).includes("GetBlobDownloadTicket")) return response();
    retire(); return new Response(bytes, { headers: { "content-type": "image/png", "content-length": "3" } });
  });
  await expect(mobileNetwork.downloadBlob(owner, blob)).rejects.toThrow(/cleared/u);
  expect(put).not.toHaveBeenCalled();
});

it("retains the exact committed image bytes after upload so its sent message can be viewed offline", async () => {
  const committed = create(BlobRefSchema, { ...blob, disposition: BlobDisposition.ATTACHMENT });
  const put = vi.spyOn(mobileMediaByteCache, "put").mockResolvedValue();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => String(url).includes("BeginBlobUpload")
    ? new Response(toBinary(BeginBlobUploadResponseSchema, create(BeginBlobUploadResponseSchema, { upload: { uploadId: "upload", expectedSha256Hex: blob.sha256Hex, expectedByteSize: 3n,
      ticket: { ...ticket, blobId: "", direction: TransferDirection.UPLOAD, relativeEndpoint: "/v1/blobs/upload" } } })), { headers: { "content-type": "application/proto" } })
    : new Response(toBinary(CompleteBlobUploadResponseSchema, create(CompleteBlobUploadResponseSchema, { blob: committed })), { headers: { "content-type": "application/proto" } }));
  expect(await mobileNetwork.uploadBlob(owner, { uri: "file:///private/image.png", fileName: blob.fileName, mediaType: blob.mediaType, byteSize: 3, sha256Hex: blob.sha256Hex })).toEqual(committed);
  expect(local.upload).toHaveBeenCalledOnce(); expect(put).toHaveBeenCalledExactlyOnceWith(owner, committed, bytes, expect.any(Function));
});
