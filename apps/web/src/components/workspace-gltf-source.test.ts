import { describe, expect, it, vi } from "vitest";

import {
  materializeWorkspaceGlbSource,
  materializeWorkspaceGltfSource,
  resolveWorkspaceGltfResourcePath
} from "./workspace-gltf-source.js";

describe("workspace glTF source", () => {
  it("resolves only relative resources that remain inside the workspace", () => {
    expect(resolveWorkspaceGltfResourcePath("models/robot/scene.gltf", "../shared/body.bin")).toBe("models/shared/body.bin");
    expect(resolveWorkspaceGltfResourcePath("models/scene.gltf", "textures%2Fbase.png?rev=1")).toBe("models/textures/base.png");
    expect(resolveWorkspaceGltfResourcePath("scene.gltf", "../secret.bin")).toBeUndefined();
    expect(resolveWorkspaceGltfResourcePath("scene.gltf", "C:/secret.bin")).toBeUndefined();
    expect(resolveWorkspaceGltfResourcePath("scene.gltf", "https://example.invalid/model.bin")).toBeUndefined();
    expect(resolveWorkspaceGltfResourcePath("scene.gltf", "\\\\server\\share.bin")).toBeUndefined();
  });

  it("rebinds buffers and images to owned blob URLs and revokes every URL", async () => {
    let index = 0;
    const revoked: string[] = [];
    const loadResource = vi.fn(async (path: string) => new Blob([path]));
    const source = await materializeWorkspaceGltfSource({
      sourceUrl: "blob:root",
      modelPath: "models/scene.gltf",
      loadResource,
      fetchSource: vi.fn(async () => new Response(JSON.stringify({
        asset: { version: "2.0" },
        buffers: [{ uri: "scene.bin" }, { uri: "scene.bin" }],
        images: [{ uri: "textures/base.png" }, { uri: "data:image/png;base64,AA==" }]
      }))) as typeof fetch,
      createObjectUrl: () => `blob:owned-${++index}`,
      revokeObjectUrl: (url) => revoked.push(url)
    });
    expect(loadResource.mock.calls.map(([path]) => path)).toEqual(["models/scene.bin", "models/textures/base.png"]);
    expect(source.url).toBe("blob:owned-3");
    source.dispose();
    source.dispose();
    expect(revoked).toEqual(["blob:owned-1", "blob:owned-2", "blob:owned-3"]);
  });

  it("rejects remote resources before asking the workspace loader", async () => {
    const loadResource = vi.fn(async () => new Blob());
    await expect(materializeWorkspaceGltfSource({
      sourceUrl: "blob:root",
      modelPath: "models/scene.gltf",
      loadResource,
      fetchSource: vi.fn(async () => new Response(JSON.stringify({
        asset: { version: "2.0" },
        buffers: [{ uri: "https://example.invalid/scene.bin" }]
      }))) as typeof fetch,
      createObjectUrl: () => "blob:unused",
      revokeObjectUrl: () => undefined
    })).rejects.toThrow(/unavailable resource/u);
    expect(loadResource).not.toHaveBeenCalled();
  });

  it("inspects GLB JSON and blocks external runtime fetches", async () => {
    const loadResource = vi.fn(async () => new Blob());
    const bytes = glbBytes({
      asset: { version: "2.0" },
      images: [{ uri: "https://example.invalid/texture.png" }]
    });
    await expect(materializeWorkspaceGlbSource({
      sourceUrl: "blob:root",
      modelPath: "models/scene.glb",
      loadResource,
      fetchSource: vi.fn(async () => new Response(bytes)) as typeof fetch,
      createObjectUrl: () => "blob:unused",
      revokeObjectUrl: () => undefined
    })).rejects.toThrow(/unavailable resource/u);
    expect(loadResource).not.toHaveBeenCalled();
  });
});

function glbBytes(document: unknown): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode(JSON.stringify(document));
  const paddedLength = Math.ceil(json.byteLength / 4) * 4;
  const output = new Uint8Array(20 + paddedLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, output.byteLength, true);
  view.setUint32(12, paddedLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  output.set(json, 20);
  output.fill(0x20, 20 + json.byteLength);
  return output;
}
