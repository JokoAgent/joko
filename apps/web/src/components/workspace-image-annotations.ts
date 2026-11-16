export interface WorkspaceImagePoint {
  readonly x: number;
  readonly y: number;
}

export interface WorkspaceImageStroke {
  readonly points: readonly WorkspaceImagePoint[];
}

export const WORKSPACE_IMAGE_ANNOTATION_COLOR = "#FF3B30";
export const WORKSPACE_IMAGE_ANNOTATION_OUTLINE = "rgba(255,255,255,0.9)";
export const WORKSPACE_IMAGE_MIN_POINT_DISTANCE = 0.002;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function normalizeWorkspaceImagePoint(
  clientX: number,
  clientY: number,
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">
): WorkspaceImagePoint | undefined {
  if (rect.width <= 0 || rect.height <= 0) return undefined;
  return {
    x: clamp01((clientX - rect.left) / rect.width),
    y: clamp01((clientY - rect.top) / rect.height)
  };
}

export function shouldAppendWorkspaceImagePoint(
  stroke: WorkspaceImageStroke,
  point: WorkspaceImagePoint,
  minimumDistance = WORKSPACE_IMAGE_MIN_POINT_DISTANCE
): boolean {
  const last = stroke.points.at(-1);
  return last === undefined || Math.hypot(point.x - last.x, point.y - last.y) >= minimumDistance;
}

export function workspaceImageStrokeWidth(width: number, height: number): number {
  return Math.min(24, Math.max(4, Math.round(Math.min(width, height) * 0.005)));
}

export function workspaceImageStrokePath(stroke: WorkspaceImageStroke, width: number, height: number): string {
  const [first, ...rest] = stroke.points;
  if (first === undefined) return "";
  const position = (point: WorkspaceImagePoint): string => `${(point.x * width).toFixed(1)} ${(point.y * height).toFixed(1)}`;
  if (rest.length === 0) {
    const x = first.x * width;
    const y = first.y * height;
    return `M ${x.toFixed(1)} ${y.toFixed(1)} L ${(x + 0.1).toFixed(1)} ${y.toFixed(1)}`;
  }
  return `M ${position(first)} ${rest.map((point) => `L ${position(point)}`).join(" ")}`;
}

export function drawWorkspaceImageStrokes(
  context: Pick<CanvasRenderingContext2D,
    "lineCap" | "lineJoin" | "strokeStyle" | "lineWidth" | "beginPath" | "moveTo" | "lineTo" | "stroke"
  >,
  strokes: readonly WorkspaceImageStroke[],
  width: number,
  height: number
): void {
  const strokeWidth = workspaceImageStrokeWidth(width, height);
  context.lineCap = "round";
  context.lineJoin = "round";
  const drawPass = (color: string, lineWidth: number): void => {
    context.strokeStyle = color;
    context.lineWidth = lineWidth;
    for (const stroke of strokes) {
      const [first, ...rest] = stroke.points;
      if (first === undefined) continue;
      context.beginPath();
      context.moveTo(first.x * width, first.y * height);
      if (rest.length === 0) context.lineTo(first.x * width + 0.1, first.y * height);
      else for (const point of rest) context.lineTo(point.x * width, point.y * height);
      context.stroke();
    }
  };
  drawPass(WORKSPACE_IMAGE_ANNOTATION_OUTLINE, Math.round(strokeWidth * 1.8));
  drawPass(WORKSPACE_IMAGE_ANNOTATION_COLOR, strokeWidth);
}

export function clampWorkspaceImageScale(scale: number): number {
  return Math.min(8, Math.max(1, scale));
}

export function workspaceImageWheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const pixels = normalizeWorkspaceImageWheelDelta(deltaY, deltaMode);
  const clamped = Math.min(40, Math.max(-40, pixels));
  return Math.exp(-clamped * 0.01);
}

export function normalizeWorkspaceImageWheelDelta(delta: number, deltaMode = 0): number {
  return deltaMode === 1 ? delta * 16 : deltaMode === 2 ? delta * 800 : delta;
}

interface WorkspaceImageWheelSample {
  readonly deltaMode: number;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly shiftKey: boolean;
  readonly wheelDeltaY?: number;
}

type WorkspaceImageWheelSource = "mouse" | "trackpad";

function classifyWorkspaceImageWheel(sample: WorkspaceImageWheelSample): WorkspaceImageWheelSource {
  if (sample.deltaMode !== 0) return "mouse";
  if (sample.deltaX !== 0 && !sample.shiftKey) return "trackpad";
  if (!Number.isInteger(sample.deltaY)) return "mouse";
  const legacy = sample.wheelDeltaY;
  if (typeof legacy === "number" && legacy !== 0) {
    if (legacy % 120 === 0) return "mouse";
    if (legacy === -3 * sample.deltaY) return "trackpad";
  }
  return "mouse";
}

/** Keep the same device interpretation through a gesture's momentum tail. */
export function createWorkspaceImageWheelSourceTracker(idleMs = 250): (sample: WorkspaceImageWheelSample, now: number) => WorkspaceImageWheelSource {
  let source: WorkspaceImageWheelSource | undefined;
  let lastAt = Number.NEGATIVE_INFINITY;
  return (sample, now) => {
    if (source === undefined || now - lastAt > idleMs) source = classifyWorkspaceImageWheel(sample);
    else if (source === "mouse" && sample.deltaMode === 0 && sample.deltaX !== 0 && !sample.shiftKey) source = "trackpad";
    lastAt = now;
    return source;
  };
}

export function workspaceImageWheelIntent(event: { readonly ctrlKey: boolean; readonly metaKey: boolean; readonly deltaX: number; readonly deltaY: number },
  source: WorkspaceImageWheelSource, scale: number): "zoom" | "pan" | "none" {
  if (event.ctrlKey || event.metaKey || source === "mouse") return event.deltaY === 0 ? "none" : "zoom";
  return scale <= 1 || event.deltaX === 0 && event.deltaY === 0 ? "none" : "pan";
}

export function zoomWorkspaceImageAtPoint(
  viewport: { readonly scale: number; readonly x: number; readonly y: number },
  point: { readonly x: number; readonly y: number },
  nextScale: number
): { readonly scale: number; readonly x: number; readonly y: number } {
  const scale = clampWorkspaceImageScale(nextScale);
  if (scale === 1) return { scale, x: 0, y: 0 };
  const ratio = scale / viewport.scale;
  return {
    scale,
    x: point.x - (point.x - viewport.x) * ratio,
    y: point.y - (point.y - viewport.y) * ratio
  };
}
