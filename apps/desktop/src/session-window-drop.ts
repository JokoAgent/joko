export interface DesktopPoint {
  readonly x: number;
  readonly y: number;
}

export interface DesktopRectangle extends DesktopPoint {
  readonly width: number;
  readonly height: number;
}

const DROP_TITLE_BAR_OFFSET: DesktopPoint = Object.freeze({ x: 80, y: 24 });
export const SESSION_DRAG_PREVIEW_SIZE = Object.freeze({ width: 320, height: 68 });
const SESSION_DRAG_PREVIEW_OFFSET: DesktopPoint = Object.freeze({ x: 8, y: 8 });

export function pointIsInsideRectangle(point: DesktopPoint, rectangle: DesktopRectangle): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y)
    && validRectangle(rectangle)
    && point.x >= rectangle.x
    && point.y >= rectangle.y
    && point.x < rectangle.x + rectangle.width
    && point.y < rectangle.y + rectangle.height;
}

export function pointIsInsideAnyRectangle(
  point: DesktopPoint,
  rectangles: readonly DesktopRectangle[]
): boolean {
  return rectangles.some((rectangle) => pointIsInsideRectangle(point, rectangle));
}

/** Keep the detached task title bar near the release point and wholly on-screen. */
export function sessionWindowDropBounds(input: {
  readonly point: DesktopPoint;
  readonly workArea: DesktopRectangle;
  readonly windowSize: Pick<DesktopRectangle, "width" | "height">;
}): DesktopRectangle {
  if (!Number.isFinite(input.point.x) || !Number.isFinite(input.point.y)) {
    throw new TypeError("Task drop point is invalid.");
  }
  if (!validRectangle(input.workArea) || !validSize(input.windowSize)) {
    throw new TypeError("Task drop geometry is invalid.");
  }
  const width = Math.min(Math.max(1, Math.round(input.windowSize.width)), input.workArea.width);
  const height = Math.min(Math.max(1, Math.round(input.windowSize.height)), input.workArea.height);
  const maximumX = input.workArea.x + input.workArea.width - width;
  const maximumY = input.workArea.y + input.workArea.height - height;
  return {
    x: clamp(Math.round(input.point.x - DROP_TITLE_BAR_OFFSET.x), input.workArea.x, maximumX),
    y: clamp(Math.round(input.point.y - DROP_TITLE_BAR_OFFSET.y), input.workArea.y, maximumY),
    width,
    height
  };
}

/** Follow the pointer on its nearest display without crossing that display's work area. */
export function sessionDragPreviewBounds(point: DesktopPoint, workArea: DesktopRectangle): DesktopRectangle {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !validRectangle(workArea)) {
    throw new TypeError("Task drag preview geometry is invalid.");
  }
  const width = Math.min(SESSION_DRAG_PREVIEW_SIZE.width, workArea.width);
  const height = Math.min(SESSION_DRAG_PREVIEW_SIZE.height, workArea.height);
  return {
    x: clamp(Math.round(point.x + SESSION_DRAG_PREVIEW_OFFSET.x), workArea.x, workArea.x + workArea.width - width),
    y: clamp(Math.round(point.y + SESSION_DRAG_PREVIEW_OFFSET.y), workArea.y, workArea.y + workArea.height - height),
    width,
    height
  };
}

function validRectangle(value: DesktopRectangle): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && validSize(value);
}

function validSize(value: Pick<DesktopRectangle, "width" | "height">): boolean {
  return Number.isFinite(value.width) && value.width > 0
    && Number.isFinite(value.height) && value.height > 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
