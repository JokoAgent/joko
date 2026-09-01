import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import type { WorkspaceFilePreviewView } from "../model.js";
import {
  formatWorkspaceFileBytes,
  formatWorkspaceFileMtime,
  WorkspaceFileBody,
  workspaceDocumentShortcutAction,
  workspaceFileBodyKind
} from "./WorkspaceFileBody.js";

const controller = {
  state: { preferences: { locale: "en" } },
  readWorkspaceFile: vi.fn(),
  writeWorkspaceTextFile: vi.fn(),
  getArtifactUrl: vi.fn(),
  releaseArtifactUrl: vi.fn(),
  downloadArtifact: vi.fn()
} as unknown as AppController;

describe("WorkspaceFileBody", () => {
  it("dispatches the formal raster, model, PDF, Drawio, Markdown, and text surfaces", () => {
    expect(workspaceFileBodyKind("README.md", textPreview("README.md"))).toBe("markdown");
    expect(workspaceFileBodyKind("diagram.svg", textPreview("diagram.svg"))).toBe("text");
    expect(workspaceFileBodyKind("diagram.svg", binaryPreview("diagram.svg", "image", "image/svg+xml"))).toBe("binary");
    expect(workspaceFileBodyKind("diagram.drawio", textPreview("diagram.drawio"))).toBe("drawio");
    expect(workspaceFileBodyKind("src/main.ts", textPreview("src/main.ts"))).toBe("text");
    expect(workspaceFileBodyKind("photo.PNG", binaryPreview("photo.PNG", "image", "image/png"))).toBe("image");
    expect(workspaceFileBodyKind("scene.GLB", binaryPreview("scene.GLB", "blob", "model/gltf-binary"))).toBe("model");
    expect(workspaceFileBodyKind("scene.gltf", textPreview("scene.gltf"))).toBe("model");
    expect(workspaceFileBodyKind("manual.bin", binaryPreview("manual.bin", "blob", "application/pdf"))).toBe("pdf");
    expect(workspaceFileBodyKind("demo.MOV", binaryPreview("demo.MOV", "blob", "video/quicktime"))).toBe("video");
    expect(workspaceFileBodyKind("archive.zip", binaryPreview("archive.zip", "binary", "application/zip"))).toBe("binary");
  });

  it("routes glb and gltf through the authenticated path-free model surface", () => {
    const markup = renderToStaticMarkup(<WorkspaceFileBody
      controller={controller}
      sessionId="session-1"
      workspaceId="workspace-1"
      path="models/robot.glb"
      preview={{ ...binaryPreview("models/robot.glb", "blob", "model/gltf-binary"), blobId: "model-blob" }}
      canWrite={false}
    />);
    expect(markup).not.toContain("models/robot.glb");
  });

  it("reserves unmodified Mod+F/Mod+S for the document surface", () => {
    const base = { code: "KeyF", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, defaultPrevented: false };
    expect(workspaceDocumentShortcutAction(base, {}, "win32")).toBe("find");
    expect(workspaceDocumentShortcutAction({ ...base, code: "KeyS" }, {}, "win32")).toBe("save");
    expect(workspaceDocumentShortcutAction({ ...base, shiftKey: true }, {}, "win32")).toBeUndefined();
    expect(workspaceDocumentShortcutAction({ ...base, defaultPrevented: true }, {}, "win32")).toBeUndefined();
    expect(workspaceDocumentShortcutAction(base, { "find-in-page": null }, "win32")).toBeUndefined();
    expect(workspaceDocumentShortcutAction(
      { ...base, code: "KeyG", altKey: true },
      { "find-in-page": { code: "KeyG", ctrl: true, meta: false, alt: true, shift: false } },
      "win32"
    )).toBe("find");
  });

  it("keeps truncated text read-only and shows the non-destructive warning", () => {
    const markup = renderToStaticMarkup(<WorkspaceFileBody
      controller={controller}
      sessionId="session-1"
      workspaceId="workspace-1"
      path="large.ts"
      preview={{ ...textPreview("large.ts"), truncated: true }}
      canWrite
    />);
    expect(markup).toContain("Preview truncated");
  });

  it("always renders a download affordance for unsupported binary previews", () => {
    const markup = renderToStaticMarkup(<WorkspaceFileBody
      controller={controller}
      sessionId="session-1"
      workspaceId="workspace-1"
      path="archive.zip"
      preview={binaryPreview("archive.zip", "binary", "application/zip")}
      canWrite={false}
    />);
    expect(markup).toContain("Download file");
    expect(markup).toContain("disabled=\"\"");
  });

  it("renders metadata as name, size, and mtime without preferring the media type", () => {
    const modifiedAt = new Date(2024, 0, 2, 3, 4).getTime();
    const markup = renderToStaticMarkup(<WorkspaceFileBody
      controller={controller}
      sessionId="session-1"
      workspaceId="workspace-1"
      path="archive.zip"
      preview={{ ...binaryPreview("archive.zip", "binary", "application/zip"), byteSize: 1_536, modifiedAt }}
      canWrite={false}
    />);
    expect(markup).toContain("1.5 KB");
    expect(markup).toContain(`Modified at ${formatWorkspaceFileMtime(modifiedAt)}`);
    expect(markup).not.toContain("application/zip");
    expect(formatWorkspaceFileBytes(1_073_741_824)).toBe("1.00 GB");
  });
});

function textPreview(path: string): WorkspaceFilePreviewView {
  return {
    path,
    name: path.split("/").at(-1) ?? path,
    kind: "text",
    text: "# Hello\n",
    language: "markdown",
    revision: "revision-1",
    truncated: false
  };
}

function binaryPreview(path: string, kind: WorkspaceFilePreviewView["kind"], mediaType: string): WorkspaceFilePreviewView {
  return {
    path,
    name: path.split("/").at(-1) ?? path,
    kind,
    mediaType,
    truncated: false
  };
}
