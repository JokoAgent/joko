import { describe, expect, it } from "vitest";
import {
  assertMobileModelViewerManifest,
  buildMobileModelViewerCommand,
  buildMobileModelViewerHtml,
  createMobileModelViewerLifecycle,
  parseMobileModelViewerMessage,
  type MobileModelRuntimeBundle,
  type MobileModelViewerManifest
} from "./mobile-model-viewer";

describe("mobile model viewer protocol", () => {
  it("serializes only an exact contiguous manifest and bounded chunks", () => {
    const manifest = fixtureManifest();
    expect(JSON.parse(buildMobileModelViewerCommand("model-1", { command: "begin", manifest })))
      .toMatchObject({ type: "joko-model-viewer/command", instanceId: "model-1", command: "begin",
        byteSize: 12, modelPath: "models/scene.gltf" });
    expect(JSON.parse(buildMobileModelViewerCommand("model-1", {
      command: "chunk", fileIndex: 0, index: 0, offset: 0, base64: "AQID"
    }))).toMatchObject({ command: "chunk", fileIndex: 0, index: 0, offset: 0 });
    expect(JSON.parse(buildMobileModelViewerCommand("model-1", { command: "commit" })))
      .toMatchObject({ command: "commit" });
    expect(JSON.parse(buildMobileModelViewerCommand("model-1", { command: "dispose" })))
      .toMatchObject({ command: "dispose" });
    expect(() => assertMobileModelViewerManifest({ ...manifest,
      files: manifest.files.map((file, index) => index === 1 ? { ...file, byteOffset: 7 } : file)
    })).toThrow(/manifest|layout/u);
    expect(() => assertMobileModelViewerManifest({ ...manifest,
      references: [{ ...manifest.references[0]!, fileIndex: 0 }]
    })).toThrow(/reference/u);
  });

  it("accepts exact instance-bound status and acknowledgements only", () => {
    expect(parseMobileModelViewerMessage(JSON.stringify({
      type: "joko-model-viewer/status", instanceId: "model-1", state: "complete", fileCount: 2, error: null
    }), "model-1")).toMatchObject({ state: "complete", fileCount: 2 });
    expect(parseMobileModelViewerMessage(JSON.stringify({
      type: "joko-model-viewer/ack", instanceId: "model-1", command: "chunk",
      fileIndex: 1, index: 2, offset: 8, byteSize: 4
    }), "model-1")).toMatchObject({ command: "chunk", fileIndex: 1, index: 2, offset: 8, byteSize: 4 });
    expect(parseMobileModelViewerMessage(JSON.stringify({
      type: "joko-model-viewer/status", instanceId: "forged", state: "complete", fileCount: 2, error: null
    }), "model-1")).toBeUndefined();
    expect(parseMobileModelViewerMessage(JSON.stringify({
      type: "joko-model-viewer/status", instanceId: "model-1", state: "complete",
      fileCount: 2, error: null, extra: true
    }), "model-1")).toBeUndefined();
  });
});

describe("mobile model viewer HTML", () => {
  it("embeds the pinned runtime in a no-network/no-file interactive viewer", () => {
    const html = buildMobileModelViewerHtml({
      instanceId: "model-1", locale: "en", title: "Scene <final>", background: "#ffffff", surface: "#f5f5f5",
      ink: "#111111", muted: "#666666", accent: "#3366ff", border: "#dddddd"
    }, runtimeBundle());
    expect(html).toContain("Interactive 3D model: Scene &lt;final&gt;");
    expect(html).toContain("connect-src blob: data:");
    expect(html).toContain("worker-src 'none'");
    expect(html).toContain("URL.createObjectURL");
    expect(html).toContain("URL.revokeObjectURL");
    expect(html).toContain("getCameraOrbit");
    expect(html).toContain("Reset 3D model view");
    expect(html).not.toContain("file://");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map((match) => match[1]!);
    expect(scripts).toHaveLength(2);
    expect(() => new Function(scripts[1]!)).not.toThrow();
  });

  it("rejects unpinned or incomplete runtime bundles", () => {
    const runtime = runtimeBundle();
    expect(() => buildMobileModelViewerHtml({
      instanceId: "model-1", locale: "en", title: "Scene", background: "#ffffff", surface: "#f5f5f5",
      ink: "#111111", muted: "#666666", accent: "#3366ff", border: "#dddddd"
    }, { ...runtime, modelViewerVersion: "4.3.0" })).toThrow(/runtime bundle/u);
  });
});

describe("mobile model viewer lifecycle", () => {
  it("retires on background, reloads once, and then fails closed", () => {
    const lifecycle = createMobileModelViewerLifecycle();
    lifecycle.onLoadEnd();
    lifecycle.onBackground();
    expect(lifecycle.consumeReloadOnActive()).toBe("reload");
    expect(lifecycle.onProcessLost(true)).toBe("failed");
    lifecycle.reset();
    expect(lifecycle.onProcessLost(false)).toBe("wait");
    expect(lifecycle.consumeReloadOnActive()).toBe("reload");
  });
});

export function fixtureManifest(): MobileModelViewerManifest {
  return {
    byteSize: 12,
    sha256Hex: "a".repeat(64),
    modelKind: "gltf",
    modelPath: "models/scene.gltf",
    files: [
      { path: "models/scene.gltf", mediaType: "model/gltf+json", byteOffset: 0,
        byteSize: 8, sha256Hex: "b".repeat(64) },
      { path: "models/texture.png", mediaType: "image/png", byteOffset: 8,
        byteSize: 4, sha256Hex: "c".repeat(64) }
    ],
    references: [{ uri: "texture.png", path: "models/texture.png", kind: "image", fileIndex: 1 }]
  };
}

function runtimeBundle(): MobileModelRuntimeBundle {
  return {
    modelViewerVersion: "4.3.1",
    threeVersion: "0.183.2",
    script: "window.jokoModelViewerRuntime = { ready: Promise.resolve(true) };" + " ".repeat(100_000),
    scriptSha256Hex: "d".repeat(64)
  };
}
