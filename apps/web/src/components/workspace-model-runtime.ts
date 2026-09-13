export interface WorkspaceModelViewerElement extends HTMLElement {
  loaded?: boolean;
  cameraOrbit: string;
  cameraTarget: string;
  fieldOfView: string;
  getCameraOrbit?: () => { readonly theta: number; readonly phi: number; readonly radius: number };
  jumpCameraToGoal?: () => void;
  resetTurntableRotation?: () => void;
}

interface ModelViewerRuntimeConfiguration {
  dracoDecoderLocation: string;
  ktx2TranscoderLocation: string;
  lottieLoaderLocation: string;
}

type ModelViewerRuntimeGlobal = typeof globalThis & {
  ModelViewerElement?: ModelViewerRuntimeConfiguration | (CustomElementConstructor & ModelViewerRuntimeConfiguration);
};

let runtimePromise: Promise<void> | undefined;

/** The viewer is a progressive browser capability. Missing WebGL fails closed. */
export function workspaceModelViewerSupported(scope: typeof globalThis = globalThis): boolean {
  const candidate = scope as typeof globalThis & {
    customElements?: CustomElementRegistry;
    HTMLElement?: typeof HTMLElement;
    HTMLCanvasElement?: typeof HTMLCanvasElement;
    WebGLRenderingContext?: typeof WebGLRenderingContext;
    WebGL2RenderingContext?: typeof WebGL2RenderingContext;
  };
  return candidate.customElements !== undefined
    && candidate.HTMLElement !== undefined
    && candidate.HTMLCanvasElement !== undefined
    && (candidate.WebGLRenderingContext !== undefined || candidate.WebGL2RenderingContext !== undefined);
}

export async function ensureWorkspaceModelViewer(): Promise<void> {
  if (!workspaceModelViewerSupported()) throw new Error("Interactive model preview is unavailable.");
  if (customElements.get("model-viewer") !== undefined) return;
  if (runtimePromise !== undefined) return runtimePromise;
  configureWorkspaceModelViewerRuntime();
  runtimePromise = import("@google/model-viewer").then(() => {
    if (customElements.get("model-viewer") === undefined) {
      throw new Error("Interactive model preview did not initialize.");
    }
  }).catch((error: unknown) => {
    runtimePromise = undefined;
    throw error;
  });
  return runtimePromise;
}

/** Configure all optional runtime loaders before the custom element is imported. */
export function configureWorkspaceModelViewerRuntime(baseUri = document.baseURI): ModelViewerRuntimeConfiguration {
  const root = new URL("./model-viewer-assets/", baseUri).href;
  const configuration: ModelViewerRuntimeConfiguration = {
    dracoDecoderLocation: `${root}draco/`,
    ktx2TranscoderLocation: `${root}basis/`,
    // Unsupported animation-texture models fail on a same-origin URL instead
    // of silently side-loading executable code from a third-party host.
    lottieLoaderLocation: `${root}unsupported-lottie-loader.js`
  };
  const scope = globalThis as ModelViewerRuntimeGlobal;
  const current = scope.ModelViewerElement;
  if (typeof current === "function") {
    current.dracoDecoderLocation = configuration.dracoDecoderLocation;
    current.ktx2TranscoderLocation = configuration.ktx2TranscoderLocation;
    current.lottieLoaderLocation = configuration.lottieLoaderLocation;
  } else {
    scope.ModelViewerElement = configuration;
  }
  return configuration;
}

export function resetWorkspaceModelCamera(viewer: WorkspaceModelViewerElement | null): boolean {
  if (viewer === null) return false;
  viewer.cameraOrbit = "auto auto auto";
  viewer.cameraTarget = "auto auto auto";
  viewer.fieldOfView = "auto";
  viewer.resetTurntableRotation?.();
  viewer.jumpCameraToGoal?.();
  return true;
}

export function zoomWorkspaceModelCamera(viewer: WorkspaceModelViewerElement | null, factor: number): boolean {
  const orbit = viewer?.getCameraOrbit?.();
  if (
    viewer === null || orbit === undefined || !Number.isFinite(factor) || factor <= 0
    || !Number.isFinite(orbit.theta) || !Number.isFinite(orbit.phi)
    || !Number.isFinite(orbit.radius) || orbit.radius <= 0
  ) return false;
  const radius = Math.max(0.001, Math.min(1_000_000, orbit.radius * factor));
  viewer.cameraOrbit = `${orbit.theta}rad ${orbit.phi}rad ${radius}m`;
  viewer.jumpCameraToGoal?.();
  return true;
}
