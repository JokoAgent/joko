export const MOBILE_LIGHTBOX_MIN_SCALE = 1;
export const MOBILE_LIGHTBOX_MAX_SCALE = 4;
export const MOBILE_LIGHTBOX_DOUBLE_TAP_SCALE = 2.5;
export const MOBILE_LIGHTBOX_ZOOM_EPSILON = 0.01;
export const MOBILE_LIGHTBOX_TAP_DISTANCE = 12;
export const MOBILE_LIGHTBOX_TAP_MILLISECONDS = 500;
export const MOBILE_LIGHTBOX_DOUBLE_TAP_MILLISECONDS = 280;

export interface MobileImageTransform {
  readonly scale: number;
  readonly translateX: number;
  readonly translateY: number;
}

export interface MobileImageSize {
  readonly width: number;
  readonly height: number;
}

export interface MobileTouchPoint {
  readonly x: number;
  readonly y: number;
}

export type MobileLightboxPointerIntent = "idle" | "pan" | "draw" | "transform";

export function mobileLightboxPointerIntent(
  annotating: boolean,
  touchCount: number
): MobileLightboxPointerIntent {
  if (!Number.isSafeInteger(touchCount) || touchCount < 1) return "idle";
  if (touchCount >= 2) return "transform";
  return annotating ? "draw" : "pan";
}

export function clampMobileLightboxScale(scale: number): number {
  if (!Number.isFinite(scale)) return MOBILE_LIGHTBOX_MIN_SCALE;
  return Math.min(MOBILE_LIGHTBOX_MAX_SCALE, Math.max(MOBILE_LIGHTBOX_MIN_SCALE, scale));
}

export function mobileLightboxIsZoomed(scale: number): boolean {
  return scale > MOBILE_LIGHTBOX_MIN_SCALE + MOBILE_LIGHTBOX_ZOOM_EPSILON;
}

export function mobileLightboxIsTap(startedAt: number, releasedAt: number, distance: number): boolean {
  const duration = releasedAt - startedAt;
  return Number.isFinite(duration) && duration >= 0 && duration <= MOBILE_LIGHTBOX_TAP_MILLISECONDS
    && Number.isFinite(distance) && distance >= 0 && distance <= MOBILE_LIGHTBOX_TAP_DISTANCE;
}

export function mobileContainedImageSize(
  container: MobileImageSize,
  natural: MobileImageSize
): MobileImageSize {
  if (!validSize(container)) return { width: 0, height: 0 };
  if (!validSize(natural)) return { ...container };
  const fit = Math.min(container.width / natural.width, container.height / natural.height);
  return { width: natural.width * fit, height: natural.height * fit };
}

export function clampMobileLightboxTranslation(
  value: number,
  containerSize: number,
  displayedSize: number,
  scale: number
): number {
  if (!Number.isFinite(value) || !Number.isFinite(containerSize) || containerSize <= 0) return 0;
  const exactScale = clampMobileLightboxScale(scale);
  const exactDisplayed = Number.isFinite(displayedSize) && displayedSize > 0 ? displayedSize : containerSize;
  const overflow = Math.max(0, (exactDisplayed * exactScale - containerSize) / 2);
  return Math.min(overflow, Math.max(-overflow, value));
}

export function clampMobileImageTransform(
  transform: MobileImageTransform,
  container: MobileImageSize,
  natural: MobileImageSize
): MobileImageTransform {
  const scale = clampMobileLightboxScale(transform.scale);
  const displayed = mobileContainedImageSize(container, natural);
  return {
    scale,
    translateX: clampMobileLightboxTranslation(transform.translateX, container.width, displayed.width, scale),
    translateY: clampMobileLightboxTranslation(transform.translateY, container.height, displayed.height, scale)
  };
}

export function mobileTouchCentroid(points: readonly MobileTouchPoint[]): MobileTouchPoint {
  if (points.length === 0) return { x: 0, y: 0 };
  const sum = points.reduce((current, point) => ({
    x: current.x + finiteCoordinate(point.x),
    y: current.y + finiteCoordinate(point.y)
  }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

export function mobileTouchDistance(first: MobileTouchPoint, second: MobileTouchPoint): number {
  return Math.hypot(
    finiteCoordinate(second.x) - finiteCoordinate(first.x),
    finiteCoordinate(second.y) - finiteCoordinate(first.y)
  );
}

export function mobilePinchTransform(input: {
  readonly initial: MobileImageTransform;
  readonly initialCentroid: MobileTouchPoint;
  readonly initialDistance: number;
  readonly centroid: MobileTouchPoint;
  readonly distance: number;
  readonly container: MobileImageSize;
  readonly natural: MobileImageSize;
}): MobileImageTransform {
  const initialScale = clampMobileLightboxScale(input.initial.scale);
  const ratio = Number.isFinite(input.initialDistance) && input.initialDistance > 0
    && Number.isFinite(input.distance) && input.distance > 0
    ? input.distance / input.initialDistance
    : 1;
  const scale = clampMobileLightboxScale(initialScale * ratio);
  const centerX = input.container.width / 2;
  const centerY = input.container.height / 2;
  const imageX = (finiteCoordinate(input.initialCentroid.x) - centerX - input.initial.translateX) / initialScale;
  const imageY = (finiteCoordinate(input.initialCentroid.y) - centerY - input.initial.translateY) / initialScale;
  return clampMobileImageTransform({
    scale,
    translateX: finiteCoordinate(input.centroid.x) - centerX - imageX * scale,
    translateY: finiteCoordinate(input.centroid.y) - centerY - imageY * scale
  }, input.container, input.natural);
}

export function mobileDoubleTapTransform(
  current: MobileImageTransform,
  tap: MobileTouchPoint,
  container: MobileImageSize,
  natural: MobileImageSize
): MobileImageTransform {
  if (mobileLightboxIsZoomed(current.scale)) {
    return { scale: MOBILE_LIGHTBOX_MIN_SCALE, translateX: 0, translateY: 0 };
  }
  const scale = MOBILE_LIGHTBOX_DOUBLE_TAP_SCALE;
  return clampMobileImageTransform({
    scale,
    translateX: (finiteCoordinate(tap.x) - container.width / 2) * (1 - scale),
    translateY: (finiteCoordinate(tap.y) - container.height / 2) * (1 - scale)
  }, container, natural);
}

export function mobileAccessibleZoomTransform(
  current: MobileImageTransform,
  delta: number,
  container: MobileImageSize,
  natural: MobileImageSize
): MobileImageTransform {
  const scale = clampMobileLightboxScale(current.scale + delta);
  if (!mobileLightboxIsZoomed(scale)) {
    return { scale: MOBILE_LIGHTBOX_MIN_SCALE, translateX: 0, translateY: 0 };
  }
  const ratio = scale / clampMobileLightboxScale(current.scale);
  return clampMobileImageTransform({
    scale,
    translateX: current.translateX * ratio,
    translateY: current.translateY * ratio
  }, container, natural);
}

function validSize(value: MobileImageSize): boolean {
  return Number.isFinite(value.width) && value.width > 0
    && Number.isFinite(value.height) && value.height > 0;
}

function finiteCoordinate(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
