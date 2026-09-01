import { afterEach, describe, expect, it } from "vitest";

import {
  configureWorkspaceModelViewerRuntime,
  resetWorkspaceModelCamera,
  workspaceModelViewerSupported,
  zoomWorkspaceModelCamera,
  type WorkspaceModelViewerElement
} from "./workspace-model-runtime.js";

afterEach(() => {
  Reflect.deleteProperty(globalThis, "ModelViewerElement");
});

describe("workspace model runtime", () => {
  it("self-hosts optional decoders and never configures an executable CDN", () => {
    const configuration = configureWorkspaceModelViewerRuntime("https://app.invalid/index.html");
    expect(configuration).toEqual({
      dracoDecoderLocation: "https://app.invalid/model-viewer-assets/draco/",
      ktx2TranscoderLocation: "https://app.invalid/model-viewer-assets/basis/",
      lottieLoaderLocation: "https://app.invalid/model-viewer-assets/unsupported-lottie-loader.js"
    });
    expect(JSON.stringify(configuration)).not.toMatch(/gstatic|jsdelivr|unpkg/iu);
  });

  it("fails closed without the browser's custom-element or WebGL capability", () => {
    expect(workspaceModelViewerSupported({} as typeof globalThis)).toBe(false);
  });

  it("zooms from the authoritative camera orbit and restores the automatic view", () => {
    const viewer = {
      cameraOrbit: "",
      cameraTarget: "",
      fieldOfView: "",
      getCameraOrbit: () => ({ theta: 1, phi: 0.5, radius: 10 }),
      jumpCameraToGoal: () => { viewer.jumps += 1; },
      resetTurntableRotation: () => { viewer.resets += 1; },
      jumps: 0,
      resets: 0
    } as unknown as WorkspaceModelViewerElement & { jumps: number; resets: number };
    expect(zoomWorkspaceModelCamera(viewer, 0.8)).toBe(true);
    expect(viewer.cameraOrbit).toBe("1rad 0.5rad 8m");
    expect(resetWorkspaceModelCamera(viewer)).toBe(true);
    expect(viewer.cameraOrbit).toBe("auto auto auto");
    expect(viewer.cameraTarget).toBe("auto auto auto");
    expect(viewer.fieldOfView).toBe("auto");
    expect(viewer.jumps).toBe(2);
    expect(viewer.resets).toBe(1);
  });
});
