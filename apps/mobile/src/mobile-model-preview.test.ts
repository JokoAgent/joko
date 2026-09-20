import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  MobileModelPreviewFiles,
  inspectMobileModelPreviewBytes,
  mobileModelPreviewKind,
  resolveMobileModelResourcePath,
  type MobileModelPreviewFileSnapshot
} from "./mobile-model-preview";

describe("mobile model preview", () => {
  it("accepts exact glTF 2.0 MIME/extension pairs and projects bounded dependencies", () => {
    const gltf = utf8(JSON.stringify({
      asset: { version: "2.0" },
      buffers: [{ uri: "mesh.bin" }, { uri: "mesh.bin" }, {
        uri: "data:application/octet-stream;base64,AAAA"
      }],
      images: [{ uri: "textures/base.png?revision=one" }, {
        uri: "data:image/jpeg;base64,/9j/2Q=="
      }]
    }));
    expect(mobileModelPreviewKind("model/gltf+json; charset=utf-8", "models/scene.GLTF")).toBe("gltf");
    expect(inspectMobileModelPreviewBytes(gltf, "model/gltf+json", "models/scene.gltf"))
      .toMatchObject({
        kind: "gltf",
        references: [
          { uri: "mesh.bin", path: "models/mesh.bin", kind: "buffer" },
          { uri: "textures/base.png?revision=one", path: "models/textures/base.png", kind: "image" }
        ]
      });

    const glb = glbBytes({ asset: { version: "2.0" }, buffers: [{ byteLength: 4 }] }, Uint8Array.of(1, 2, 3, 4));
    expect(inspectMobileModelPreviewBytes(glb, "model/gltf-binary", "scene.glb"))
      .toMatchObject({ kind: "glb", references: [] });
  });

  it("resolves only relative dependency paths that remain under the model Workspace root", () => {
    expect(resolveMobileModelResourcePath("models/robot/scene.gltf", "../shared/body.bin"))
      .toBe("models/shared/body.bin");
    expect(resolveMobileModelResourcePath("models/scene.gltf", "textures%2Fbase.png?rev=1"))
      .toBe("models/textures/base.png");
    expect(resolveMobileModelResourcePath("scene.gltf", "../secret.bin")).toBeUndefined();
    expect(resolveMobileModelResourcePath("scene.gltf", "C:/secret.bin")).toBeUndefined();
    expect(resolveMobileModelResourcePath("scene.gltf", "https://example.invalid/model.bin")).toBeUndefined();
    expect(resolveMobileModelResourcePath("scene.gltf", "\\\\server\\share.bin")).toBeUndefined();
  });

  it("rejects malformed containers, unsafe resources and unavailable offline decoders", () => {
    expect(() => inspectMobileModelPreviewBytes(
      utf8(JSON.stringify({ asset: { version: "1.0" } })), "model/gltf+json", "scene.gltf"
    )).toThrow(/version 2\.0/u);
    expect(() => inspectMobileModelPreviewBytes(
      utf8(JSON.stringify({ asset: { version: "2.0" }, buffers: [{ uri: "https://example.invalid/a.bin" }] })),
      "model/gltf+json", "scene.gltf"
    )).toThrow(/unsafe resource/u);
    expect(() => inspectMobileModelPreviewBytes(
      utf8(JSON.stringify({ asset: { version: "2.0" }, extensionsRequired: ["KHR_draco_mesh_compression"] })),
      "model/gltf+json", "scene.gltf"
    )).toThrow(/decoder/u);
    expect(() => inspectMobileModelPreviewBytes(
      utf8(JSON.stringify({ asset: { version: "2.0" }, images: [{
        uri: "data:image/jpeg;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
      }] })),
      "model/gltf+json", "scene.gltf"
    )).toThrow(/declared PNG\/JPEG type/u);
    const glb = glbBytes({ asset: { version: "2.0" } });
    glb[4] = 1;
    expect(() => inspectMobileModelPreviewBytes(glb, "model/gltf-binary", "scene.glb"))
      .toThrow(/header/u);
    expect(mobileModelPreviewKind("application/octet-stream", "scene.glb")).toBeUndefined();
  });

  it("stages one verified package, de-duplicates dependency files and removes its lease", async () => {
    const source = utf8(JSON.stringify({
      asset: { version: "2.0" },
      buffers: [{ uri: "mesh.bin" }, { uri: "mesh.bin" }],
      images: [{ uri: "textures/base.png" }]
    }));
    const buffer = Uint8Array.of(1, 2, 3, 4);
    const image = pngBytes();
    const removed: string[] = [];
    const driver = {
      prepare: vi.fn(async () => undefined),
      write: vi.fn(async (fileName: string, bytes: Uint8Array): Promise<MobileModelPreviewFileSnapshot> => ({
        uri: `file:///models/${fileName}`,
        fileName,
        byteSize: bytes.byteLength,
        bytes: Uint8Array.from(bytes)
      })),
      remove: vi.fn(async (snapshot: Pick<MobileModelPreviewFileSnapshot, "fileName">) => { removed.push(snapshot.fileName); })
    };
    const files = new MobileModelPreviewFiles(driver, digest);
    const loadResource = vi.fn(async (path: string) => path.endsWith(".bin")
      ? { path, mediaType: "application/octet-stream", sha256Hex: await digest(buffer), bytes: buffer }
      : { path, mediaType: "image/png", sha256Hex: await digest(image), bytes: image });

    const lease = await files.stage({
      profileId: "profile",
      leaseId: "lease",
      modelPath: "models/scene.gltf",
      mediaType: "model/gltf+json",
      expectedSha256Hex: await digest(source),
      bytes: source,
      loadResource
    });

    expect(loadResource.mock.calls.map(([path]) => path)).toEqual([
      "models/mesh.bin", "models/textures/base.png"
    ]);
    expect(lease.files.map((file) => file.path)).toEqual([
      "models/scene.gltf", "models/mesh.bin", "models/textures/base.png"
    ]);
    expect(lease.references.map(({ uri, fileIndex }) => ({ uri, fileIndex }))).toEqual([
      { uri: "mesh.bin", fileIndex: 1 },
      { uri: "textures/base.png", fileIndex: 2 }
    ]);
    expect(driver.write).toHaveBeenCalledWith("preview-lease.joko-model", expect.any(Uint8Array));

    await files.remove(lease);
    expect(removed).toEqual(["preview-lease.joko-model"]);
  });

  it("fails closed when dependencies are unavailable or do not match their declared kind", async () => {
    const source = utf8(JSON.stringify({
      asset: { version: "2.0" }, images: [{ uri: "texture.png" }]
    }));
    const files = new MobileModelPreviewFiles({
      prepare: async () => undefined,
      write: async () => { throw new Error("must not write"); },
      remove: async () => undefined
    }, digest);
    const input = {
      profileId: "profile",
      leaseId: "lease",
      modelPath: "scene.gltf",
      mediaType: "model/gltf+json",
      expectedSha256Hex: await digest(source),
      bytes: source
    };
    await expect(files.stage(input)).rejects.toThrow(/unavailable/u);
    await expect(files.stage({ ...input, loadResource: async (path) => ({
      path, mediaType: "image/png", sha256Hex: await digest(Uint8Array.of(1, 2, 3)),
      bytes: Uint8Array.of(1, 2, 3)
    }) })).rejects.toThrow(/does not match/u);
  });
});

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function glbBytes(document: unknown, binary?: Uint8Array): Uint8Array {
  const json = utf8(JSON.stringify(document));
  const jsonLength = Math.ceil(json.byteLength / 4) * 4;
  const binaryLength = binary ? Math.ceil(binary.byteLength / 4) * 4 : 0;
  const output = new Uint8Array(20 + jsonLength + (binary ? 8 + binaryLength : 0));
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, output.byteLength, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  output.set(json, 20);
  output.fill(0x20, 20 + json.byteLength, 20 + jsonLength);
  if (binary) {
    const offset = 20 + jsonLength;
    view.setUint32(offset, binaryLength, true);
    view.setUint32(offset + 4, 0x004e4942, true);
    output.set(binary, offset + 8);
  }
  return output;
}

function pngBytes(): Uint8Array {
  return Uint8Array.of(
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    0, 0, 0, 1, 0, 0, 0, 1
  );
}

async function digest(bytes: Uint8Array): Promise<string> {
  return createHash("sha256").update(bytes).digest("hex");
}
