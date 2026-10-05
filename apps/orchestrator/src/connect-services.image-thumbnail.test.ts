import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { BlobDisposition, BlobRefSchema, GetImageThumbnailRequestSchema } from "@joko/contracts";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import type { OrchestratorApplication } from "./application.js";
import { createConnectServices } from "./connect-services.js";

async function fixture() {
  const bytes = await sharp({ create: { width: 32, height: 16, channels: 3, background: "orange" } }).png().toBuffer();
  const source = { id: "canonical", fileName: "image.png", mimeType: "image/png", byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), storagePath: "service-private-source", createdAt: 1 };
  const expected = create(BlobRefSchema, { blobId: source.id, fileName: source.fileName, mediaType: source.mimeType, byteSize: BigInt(source.byteLength), sha256Hex: source.sha256, disposition: BlobDisposition.ATTACHMENT });
  let active = true; const revoked = new Set<() => void>();
  const authenticate = vi.fn(() => { if (!active) throw new ConnectError("Connection revoked.", Code.Unauthenticated);
    return { id: "connection", deviceId: "device", name: "Phone", state: "active", pairedAt: 1, revision: 1n, authKeyDigest: "fixture-digest" }; });
  const artifacts = { get: vi.fn(async () => source), readBlob: vi.fn(async () => ({ data: Uint8Array.from(bytes), mimeType: source.mimeType })) };
  const application = { config: { publicOrigin: "https://node.example" }, store: {}, connections: { authenticate,
    onRevoked: (_id: string, listener: () => void) => { revoked.add(listener); return () => revoked.delete(listener); } },
    artifacts, blobTransfers: {}, artifactRepository: {}, workspaces: {}, workspaceChanges: {}, sessionHost: {}, sessionWorktrees: {},
    scheduler: {}, adapters: [], browserActivity: [], close: async () => undefined } as unknown as OrchestratorApplication;
  const service = createConnectServices(application).artifact;
  const context = { requestHeader: new Headers({ authorization: "Bearer fixture-key" }), signal: new AbortController().signal } as any;
  const request = create(GetImageThumbnailRequestSchema, { expectedSourceBlob: expected, maximumEdgePixels: 1024 });
  return { service, context, request, source, bytes, artifacts, authenticate, revoke: () => { active = false; revoked.forEach((listener) => listener()); }, revoked };
}

describe("authenticated canonical thumbnail Connect boundary", () => {
  it("reauthenticates cached results, fences source metadata and keeps private source paths out of its generated response", async () => {
    const value = await fixture(); const result = await value.service.getImageThumbnail(value.request, value.context);
    expect(result).toMatchObject({ sourceBlob: value.request.expectedSourceBlob, result: { case: "thumbnail", value: { widthPixels: 32, heightPixels: 16 } } });
    expect(JSON.stringify(result, (_key, item) => typeof item === "bigint" ? item.toString() : item)).not.toContain("service-private-source");
    await value.service.getImageThumbnail(value.request, value.context); expect(value.artifacts.readBlob).toHaveBeenCalledOnce(); expect(value.authenticate).toHaveBeenCalledTimes(4);
    await expect(value.service.getImageThumbnail(create(GetImageThumbnailRequestSchema, { ...value.request,
      expectedSourceBlob: { ...value.request.expectedSourceBlob!, byteSize: 1n } }), value.context)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    value.artifacts.get.mockResolvedValueOnce(value.source).mockResolvedValueOnce({ ...value.source, sha256: "b".repeat(64) });
    await expect(value.service.getImageThumbnail(value.request, value.context)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    value.revoke(); await expect(value.service.getImageThumbnail(value.request, value.context)).rejects.toMatchObject({ code: Code.Unauthenticated });
    expect(value.revoked.size).toBe(0);
  });

  it("cancels a revoked in-flight thumbnail immediately and never publishes the late canonical read", async () => {
    const value = await fixture(); let finish!: () => void;
    value.artifacts.readBlob.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ data: value.bytes, mimeType: "image/png" }); }));
    const loading = value.service.getImageThumbnail(value.request, value.context); const rejected = expect(loading).rejects.toMatchObject({ code: Code.Canceled });
    await vi.waitFor(() => expect(value.artifacts.readBlob).toHaveBeenCalledOnce()); value.revoke(); await rejected;
    finish(); await Promise.resolve(); expect(value.revoked.size).toBe(0); expect(value.artifacts.get).toHaveBeenCalledOnce();
  });
});
