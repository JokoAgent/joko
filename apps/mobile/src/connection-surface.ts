export type ConnectionSurfaceMode = "phone" | "pad-portrait" | "pad-landscape";

export interface ConnectionStageBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ConnectionSurfaceLayout {
  readonly mode: ConnectionSurfaceMode;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly horizontal: boolean;
  readonly stageWidth: number;
  readonly stageHeight: number;
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly hero: ConnectionStageBox;
  readonly lockup: ConnectionStageBox;
  readonly form: ConnectionStageBox;
}

// The connection host follows the fixed mobile baseline's three-stage model.
// The artwork and copy remain Joko-owned; these constants only describe the
// native viewport composition and its scaling behavior.
export const CONNECTION_PAD_LANDSCAPE_MIN_WIDTH = 1000;
export const CONNECTION_PAD_LANDSCAPE_MIN_HEIGHT = 690;
export const CONNECTION_PAD_PORTRAIT_MIN_WIDTH = 700;
export const CONNECTION_PHONE_STAGE_WIDTH = 750;
export const CONNECTION_PHONE_MIN_DESIGN_HEIGHT = 600;
export const CONNECTION_PHONE_MAX_DESIGN_HEIGHT = 1800;
export const CONNECTION_PAD_LANDSCAPE_MIN_SCALE = 0.85;

interface PhoneStageSpec {
  readonly designHeight: number;
  readonly hero: ConnectionStageBox;
  readonly lockup: ConnectionStageBox;
  readonly formY: number;
}

export const CONNECTION_PHONE_SHORT: PhoneStageSpec = {
  designHeight: 1334,
  hero: { x: 75, y: 60, width: 599, height: 720 },
  lockup: { x: 208, y: 487, width: 335, height: 115 },
  formY: 622
};

export const CONNECTION_PHONE_LONG: PhoneStageSpec = {
  designHeight: 1624,
  hero: { x: 0, y: 106, width: 750, height: 902 },
  lockup: { x: 182, y: 669.17, width: 387, height: 132.18 },
  formY: 827
};

interface PadStageSpec {
  readonly width: number;
  readonly height: number;
  readonly hero: ConnectionStageBox;
  readonly lockup: ConnectionStageBox;
  readonly formX: number;
  readonly formY: number;
  readonly formWidth: number;
}

export const CONNECTION_PAD_PORTRAIT_STAGE: PadStageSpec = {
  width: 744,
  height: 1133,
  hero: { x: 99, y: 80, width: 546, height: 656.814514 },
  lockup: { x: 237.6, y: 514.11, width: 269.51, height: 92.05 },
  formX: 105,
  formY: 621,
  formWidth: 680 * 0.794117
};

export const CONNECTION_PAD_LANDSCAPE_STAGE: PadStageSpec = {
  width: 1180,
  height: 820,
  hero: { x: 86, y: 73, width: 481.430176, height: 579.000061 },
  lockup: { x: 736.73, y: 192.57, width: 297.32, height: 101.55 },
  formX: 662,
  formY: 328,
  formWidth: 680 * 0.655357
};

export function resolveConnectionSurfaceMode(
  viewportWidth: number,
  viewportHeight: number
): ConnectionSurfaceMode {
  const width = finiteDimension(viewportWidth);
  const height = finiteDimension(viewportHeight);
  const landscape = width > height;
  if (landscape && width >= CONNECTION_PAD_LANDSCAPE_MIN_WIDTH
    && height >= CONNECTION_PAD_LANDSCAPE_MIN_HEIGHT) {
    return "pad-landscape";
  }
  if (!landscape && width >= CONNECTION_PAD_PORTRAIT_MIN_WIDTH) return "pad-portrait";
  return "phone";
}

export function resolveConnectionSurface(
  viewportWidth: number,
  viewportHeight: number
): ConnectionSurfaceLayout {
  const width = finiteDimension(viewportWidth);
  const height = finiteDimension(viewportHeight);
  const mode = resolveConnectionSurfaceMode(width, height);
  if (mode === "pad-portrait") return padSurface(mode, CONNECTION_PAD_PORTRAIT_STAGE, width, height);
  if (mode === "pad-landscape") return padSurface(mode, CONNECTION_PAD_LANDSCAPE_STAGE, width, height);
  return phoneSurface(width, height);
}

export function connectionStageBoxInViewport(
  surface: ConnectionSurfaceLayout,
  box: ConnectionStageBox
): ConnectionStageBox {
  return {
    x: surface.offsetX + box.x * surface.scale,
    y: surface.offsetY + box.y * surface.scale,
    width: box.width * surface.scale,
    height: box.height * surface.scale
  };
}

function phoneSurface(viewportWidth: number, viewportHeight: number): ConnectionSurfaceLayout {
  const scale = viewportWidth / CONNECTION_PHONE_STAGE_WIDTH;
  const stageHeight = clamp(
    viewportHeight / scale,
    CONNECTION_PHONE_MIN_DESIGN_HEIGHT,
    CONNECTION_PHONE_MAX_DESIGN_HEIGHT
  );
  let hero: ConnectionStageBox;
  let lockup: ConnectionStageBox;
  let formY: number;

  if (stageHeight < CONNECTION_PHONE_SHORT.designHeight) {
    // On short and landscape-phone viewports, preserve the usable form and
    // continuously compress only the decorative brand cluster around x=375.
    const visualScale = Math.max(0.25, (stageHeight - 600) / 734);
    hero = compressPhoneVisual(CONNECTION_PHONE_SHORT.hero, visualScale);
    lockup = compressPhoneVisual(CONNECTION_PHONE_SHORT.lockup, visualScale);
    formY = Math.min(CONNECTION_PHONE_SHORT.formY, Math.max(0, stageHeight - 640));
  } else {
    const progress = clamp(
      (stageHeight - CONNECTION_PHONE_SHORT.designHeight)
        / (CONNECTION_PHONE_LONG.designHeight - CONNECTION_PHONE_SHORT.designHeight),
      0,
      1
    );
    hero = interpolateBox(CONNECTION_PHONE_SHORT.hero, CONNECTION_PHONE_LONG.hero, progress);
    lockup = interpolateBox(CONNECTION_PHONE_SHORT.lockup, CONNECTION_PHONE_LONG.lockup, progress);
    formY = interpolate(CONNECTION_PHONE_SHORT.formY, CONNECTION_PHONE_LONG.formY, progress);
  }

  return {
    mode: "phone",
    viewportWidth,
    viewportHeight,
    horizontal: false,
    stageWidth: CONNECTION_PHONE_STAGE_WIDTH,
    stageHeight,
    scale,
    offsetX: 0,
    offsetY: 0,
    hero,
    lockup,
    form: { x: 35, y: formY, width: 680, height: Math.max(0, stageHeight - formY) }
  };
}

function padSurface(
  mode: "pad-portrait" | "pad-landscape",
  spec: PadStageSpec,
  viewportWidth: number,
  viewportHeight: number
): ConnectionSurfaceLayout {
  const rawScale = Math.min(viewportWidth / spec.width, viewportHeight / spec.height);
  const scale = mode === "pad-landscape"
    ? Math.max(CONNECTION_PAD_LANDSCAPE_MIN_SCALE, rawScale)
    : rawScale;
  return {
    mode,
    viewportWidth,
    viewportHeight,
    horizontal: mode === "pad-landscape",
    stageWidth: spec.width,
    stageHeight: spec.height,
    scale,
    offsetX: (viewportWidth - spec.width * scale) / 2,
    offsetY: (viewportHeight - spec.height * scale) / 2,
    hero: spec.hero,
    lockup: spec.lockup,
    form: {
      x: spec.formX,
      y: spec.formY,
      width: spec.formWidth,
      height: spec.height - spec.formY
    }
  };
}

function compressPhoneVisual(box: ConnectionStageBox, scale: number): ConnectionStageBox {
  return {
    x: 375 + (box.x - 375) * scale,
    y: box.y * scale,
    width: box.width * scale,
    height: box.height * scale
  };
}

function interpolateBox(
  from: ConnectionStageBox,
  to: ConnectionStageBox,
  progress: number
): ConnectionStageBox {
  return {
    x: interpolate(from.x, to.x, progress),
    y: interpolate(from.y, to.y, progress),
    width: interpolate(from.width, to.width, progress),
    height: interpolate(from.height, to.height, progress)
  };
}

function interpolate(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

function finiteDimension(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError("Connection viewport dimensions must be positive and finite.");
  }
  return value;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
