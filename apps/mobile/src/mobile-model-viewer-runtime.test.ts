// @vitest-environment jsdom
import { createHash, webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMobileModelViewerCommand,
  buildMobileModelViewerHtml,
  type MobileModelRuntimeBundle,
  type MobileModelViewerManifest
} from "./mobile-model-viewer";

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.innerHTML = "<head></head><body></body>";
});

describe("offline mobile model viewer runtime", () => {
  it("verifies package and file hashes, rebinds dependencies, renders, controls, and revokes every URL", async () => {
    const posted: Record<string, unknown>[] = [];
    const created: Blob[] = [];
    const revoked: string[] = [];
    const scope = window as unknown as Window & {
      ReactNativeWebView: { postMessage(value: string): void };
      crypto: Crypto;
    };
    scope.ReactNativeWebView = { postMessage(value) { posted.push(JSON.parse(value) as Record<string, unknown>); } };
    Object.defineProperty(window, "crypto", { configurable: true, value: webcrypto });
    Object.defineProperty(window, "TextEncoder", { configurable: true, value: TextEncoder });
    Object.defineProperty(window, "TextDecoder", { configurable: true, value: TextDecoder });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: (blob: Blob) => {
      created.push(blob);
      return `blob:joko-${created.length}`;
    } });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: (url: string) => { revoked.push(url); } });

    class FakeModelViewer extends HTMLElement {
      cameraOrbit = "";
      cameraTarget = "";
      fieldOfView = "";
      getCameraOrbit() { return { theta: 1, phi: 2, radius: 10 }; }
      jumpCameraToGoal = vi.fn();
      resetTurntableRotation = vi.fn();
    }
    if (!customElements.get("model-viewer")) customElements.define("model-viewer", FakeModelViewer);

    const model = new TextEncoder().encode(JSON.stringify({
      asset: { version: "2.0" }, images: [{ uri: "texture.png" }]
    }));
    const image = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Uint8Array(16)]);
    const packageBytes = new Uint8Array(model.byteLength + image.byteLength);
    packageBytes.set(model);
    packageBytes.set(image, model.byteLength);
    const manifest: MobileModelViewerManifest = {
      byteSize: packageBytes.byteLength,
      sha256Hex: digest(packageBytes),
      modelKind: "gltf",
      modelPath: "scene.gltf",
      files: [
        { path: "scene.gltf", mediaType: "model/gltf+json", byteOffset: 0,
          byteSize: model.byteLength, sha256Hex: digest(model) },
        { path: "texture.png", mediaType: "image/png", byteOffset: model.byteLength,
          byteSize: image.byteLength, sha256Hex: digest(image) }
      ],
      references: [{ uri: "texture.png", path: "texture.png", kind: "image", fileIndex: 1 }]
    };
    const html = buildMobileModelViewerHtml({
      instanceId: "runtime-1", title: "Runtime model", background: "#ffffff", surface: "#f5f5f5",
      ink: "#111111", muted: "#666666", accent: "#3366ff", border: "#dddddd"
    }, runtimeBundle());
    document.documentElement.innerHTML = html;
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map((match) => match[1]!);
    new Function(scripts[0]!)();
    new Function(scripts[1]!)();
    await vi.waitFor(() => expect(posted.at(-1)).toMatchObject({
      type: "joko-model-viewer/status", state: "ready"
    }));

    dispatch(buildMobileModelViewerCommand("runtime-1", { command: "begin", manifest }));
    expect(posted.at(-1)).toMatchObject({ type: "joko-model-viewer/ack", command: "begin",
      fileIndex: -1, index: -1, offset: 0, byteSize: packageBytes.byteLength });
    dispatch(buildMobileModelViewerCommand("runtime-1", {
      command: "chunk", fileIndex: 0, index: 0, offset: 0, base64: Buffer.from(model).toString("base64")
    }));
    expect(posted.at(-1)).toMatchObject({ type: "joko-model-viewer/ack", command: "chunk",
      fileIndex: 0, index: 0, offset: 0, byteSize: model.byteLength });
    dispatch(buildMobileModelViewerCommand("runtime-1", {
      command: "chunk", fileIndex: 1, index: 1, offset: model.byteLength,
      base64: Buffer.from(image).toString("base64")
    }));
    expect(posted.at(-1)).toMatchObject({ type: "joko-model-viewer/ack", command: "chunk",
      fileIndex: 1, index: 1, offset: model.byteLength, byteSize: image.byteLength });
    dispatch(buildMobileModelViewerCommand("runtime-1", { command: "commit" }));

    await vi.waitFor(() => expect(document.querySelector("model-viewer")).not.toBeNull());
    const viewer = document.querySelector("model-viewer") as FakeModelViewer;
    expect(viewer.getAttribute("src")).toBe("blob:joko-2");
    expect(viewer.hasAttribute("camera-controls")).toBe(true);
    expect(created).toHaveLength(2);
    viewer.dispatchEvent(new Event("load"));
    await vi.waitFor(() => expect(posted).toContainEqual(expect.objectContaining({
      type: "joko-model-viewer/status", state: "complete", fileCount: 2
    })));
    expect(posted).toContainEqual(expect.objectContaining({
      type: "joko-model-viewer/ack", command: "commit", fileIndex: -1, index: 1,
      offset: packageBytes.byteLength, byteSize: packageBytes.byteLength
    }));

    document.getElementById("zoom-in")!.click();
    expect(viewer.cameraOrbit).toContain("8m");
    document.getElementById("reset")!.click();
    expect(viewer.cameraOrbit).toBe("auto auto auto");

    dispatch(buildMobileModelViewerCommand("runtime-1", { command: "dispose" }));
    expect(document.querySelector("model-viewer")).toBeNull();
    expect(revoked).toEqual(["blob:joko-1", "blob:joko-2"]);
  });
});

function dispatch(data: string): void {
  window.dispatchEvent(new MessageEvent("message", { data }));
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function runtimeBundle(): MobileModelRuntimeBundle {
  return { modelViewerVersion: "4.3.1", threeVersion: "0.183.2",
    script: "window.jokoModelViewerRuntime = { ready: Promise.resolve(true) };" + " ".repeat(100_000),
    scriptSha256Hex: "a".repeat(64) };
}
