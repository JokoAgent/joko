import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationalStore } from "@joko/store";
import { stageExtensionMessageImages, withExtensionMessageImages } from "./extension-message-attachments.js";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";

const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=";
it("stages real plugin bytes as portable BlobRefs without returning the host storage path", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-plugin-image-ref-")), store = new OperationalStore(join(root, "store.db"));
  const artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root] });
  try {
    await artifacts.initialize();
    const staged = await withExtensionMessageImages([{ base64: pixel, name: "report.png" }], images => stageExtensionMessageImages(images, artifacts, store, () => {}));
    const blob = staged.images[0]!.blob;
    expect(blob).toMatchObject({ mimeType: "image/png", fileName: "report.png", byteLength: Buffer.from(pixel, "base64").length });
    expect(blob).toEqual(store.getArtifact(blob.id).blob); expect(Object.keys(blob).sort()).toEqual(["byteLength", "fileName", "id", "mimeType", "sha256"]);
    expect(JSON.stringify(staged.images)).not.toContain(root); staged.release();
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
it("accepts only bounded canonical plugin image bytes and portable names", async () => {
  expect(await withExtensionMessageImages([{ base64: pixel, name: "preview.png" }], async images => images.map(image => ({ mimeType: image.mimeType, name: image.name, bytes: image.data.length })))).toEqual([
    { mimeType: "image/png", name: "preview.png", bytes: Buffer.from(pixel, "base64").length }
  ]);
  for (const value of [[{ path: "C:/private.png" }], [{ base64: pixel, name: "../private.png" }], [{ base64: pixel, url: "file:///private.png" }],
    [{ base64: `${pixel}\n` }], [{ base64: Buffer.from("<svg/>").toString("base64") }], new Array(5).fill({ base64: pixel })]) {
    await expect(withExtensionMessageImages(value, async () => true)).rejects.toMatchObject({ code: "INVALID_ATTACHMENTS" });
  }
});
