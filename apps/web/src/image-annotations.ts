export interface ImageAnnotationPoint {
  readonly x: number;
  readonly y: number;
}

export interface ImageAnnotationStroke {
  readonly points: readonly ImageAnnotationPoint[];
}

/** Undefined is an unmarked image; null rejects a malformed draft. */
export function normalizeImageAnnotationStrokes(value: unknown): readonly ImageAnnotationStroke[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const strokes: ImageAnnotationStroke[] = [];
  for (const candidate of value as readonly unknown[]) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const rawPoints = (candidate as Record<string, unknown>)["points"];
    if (!Array.isArray(rawPoints) || rawPoints.length === 0) return null;
    const points: ImageAnnotationPoint[] = [];
    for (const point of rawPoints as readonly unknown[]) {
      if (point === null || typeof point !== "object" || Array.isArray(point)) return null;
      const { x, y } = point as Record<string, unknown>;
      if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)
        || x < 0 || x > 1 || y < 0 || y > 1) return null;
      points.push({ x, y });
    }
    strokes.push({ points });
  }
  return strokes.length === 0 ? undefined : strokes;
}

export function sameImageAnnotationStrokes(left: readonly ImageAnnotationStroke[] | undefined, right: readonly ImageAnnotationStroke[] | undefined): boolean {
  return (left?.length ?? 0) === (right?.length ?? 0) && (left ?? []).every((stroke, index) => {
    const candidate = right?.[index];
    return candidate !== undefined && stroke.points.length === candidate.points.length
      && stroke.points.every((point, pointIndex) => point.x === candidate.points[pointIndex]?.x && point.y === candidate.points[pointIndex]?.y);
  });
}
