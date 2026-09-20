export interface MobileImageAnnotationPoint {
  readonly x: number;
  readonly y: number;
}

export interface MobileImageAnnotationStroke {
  readonly points: readonly MobileImageAnnotationPoint[];
}

export interface MobileImageAnnotationRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export const MOBILE_ANNOTATION_STROKE_COLOR = "#ff3b30";
export const MOBILE_ANNOTATION_OUTLINE_COLOR = "rgba(255,255,255,0.9)";
export const MOBILE_ANNOTATION_OUTLINE_RATIO = 1.8;
export const MOBILE_ANNOTATION_MAX_BURN_DIMENSION = 4096;
export const MOBILE_ANNOTATION_MAX_STROKES = 256;
export const MOBILE_ANNOTATION_MAX_POINTS = 8_192;
export const MOBILE_ANNOTATION_MIN_POINT_DISTANCE = 0.002;

export interface MobileAnnotationBurnRequest {
  readonly id: string;
  readonly base64: string;
  readonly mediaType: string;
  readonly strokes: readonly MobileImageAnnotationStroke[];
}

export type MobileAnnotationBurnResponse =
  | { readonly ready: true }
  | {
      readonly id: string;
      readonly ok: true;
      readonly base64: string;
      readonly mediaType: "image/jpeg" | "image/png";
      readonly width: number;
      readonly height: number;
    }
  | { readonly id: string; readonly ok: false; readonly error: string };

export function normalizeMobileAnnotationStrokes(
  strokes: readonly MobileImageAnnotationStroke[]
): readonly MobileImageAnnotationStroke[] {
  if (!Array.isArray(strokes) || strokes.length > MOBILE_ANNOTATION_MAX_STROKES) {
    throw new Error("The image annotation has too many strokes.");
  }
  let pointCount = 0;
  return strokes.map((stroke) => {
    if (!stroke || typeof stroke !== "object" || !Array.isArray(stroke.points) || stroke.points.length === 0) {
      throw new Error("The image annotation contains an empty stroke.");
    }
    pointCount += stroke.points.length;
    if (pointCount > MOBILE_ANNOTATION_MAX_POINTS) {
      throw new Error("The image annotation has too many points.");
    }
    return {
      points: stroke.points.map((point: MobileImageAnnotationPoint) => {
        if (!point || typeof point !== "object" || !Number.isFinite(point.x) || !Number.isFinite(point.y)
          || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) {
          throw new Error("The image annotation contains an invalid point.");
        }
        return { x: point.x, y: point.y };
      })
    };
  });
}

export function mobileAnnotationDisplayRect(input: {
  readonly containerWidth: number;
  readonly containerHeight: number;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
  readonly translateX: number;
  readonly translateY: number;
  readonly scale: number;
}): MobileImageAnnotationRect | undefined {
  if (![input.containerWidth, input.containerHeight, input.naturalWidth, input.naturalHeight, input.scale]
    .every((value) => Number.isFinite(value) && value > 0)) return undefined;
  const fit = Math.min(input.containerWidth / input.naturalWidth, input.containerHeight / input.naturalHeight);
  const width = input.naturalWidth * fit * input.scale;
  const height = input.naturalHeight * fit * input.scale;
  return {
    left: input.containerWidth / 2 + input.translateX - width / 2,
    top: input.containerHeight / 2 + input.translateY - height / 2,
    width,
    height
  };
}

export function normalizeMobileAnnotationPoint(
  point: MobileImageAnnotationPoint,
  rect: MobileImageAnnotationRect
): MobileImageAnnotationPoint | undefined {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)
    || !Number.isFinite(rect.width) || rect.width <= 0
    || !Number.isFinite(rect.height) || rect.height <= 0) return undefined;
  return {
    x: clamp01((point.x - rect.left) / rect.width),
    y: clamp01((point.y - rect.top) / rect.height)
  };
}

export function shouldAppendMobileAnnotationPoint(
  stroke: MobileImageAnnotationStroke,
  point: MobileImageAnnotationPoint,
  minimumDistance = MOBILE_ANNOTATION_MIN_POINT_DISTANCE
): boolean {
  const last = stroke.points.at(-1);
  if (!last) return true;
  return Math.hypot(point.x - last.x, point.y - last.y) >= minimumDistance;
}

export function mobileAnnotationStrokeWidth(naturalWidth: number, naturalHeight: number): number {
  const shorter = Math.min(naturalWidth, naturalHeight);
  if (!Number.isFinite(shorter) || shorter <= 0) return 4;
  return Math.min(24, Math.max(4, Math.round(shorter * 0.005)));
}

export function mobileAnnotationStrokePath(
  stroke: MobileImageAnnotationStroke,
  width: number,
  height: number
): string {
  const points = stroke.points;
  if (points.length === 0) return "";
  const format = (point: MobileImageAnnotationPoint) =>
    `${(point.x * width).toFixed(1)} ${(point.y * height).toFixed(1)}`;
  if (points.length === 1) {
    const x = points[0]!.x * width;
    const y = points[0]!.y * height;
    return `M ${x.toFixed(1)} ${y.toFixed(1)} L ${(x + 0.1).toFixed(1)} ${y.toFixed(1)}`;
  }
  return `M ${format(points[0]!)} ${points.slice(1).map((point) => `L ${format(point)}`).join(" ")}`;
}

export function canAnnotateMobileImage(mediaType: string): boolean {
  const normalized = mediaType.trim().toLowerCase();
  return normalized.startsWith("image/") && normalized !== "image/gif" && normalized !== "image/svg+xml";
}

export function mobileAnnotationOutputMediaType(sourceMediaType: string): "image/jpeg" | "image/png" {
  return sourceMediaType.trim().toLowerCase() === "image/jpeg" ? "image/jpeg" : "image/png";
}

export function buildMobileAnnotationBurnInvocation(request: MobileAnnotationBurnRequest): string {
  if (!/^burn-[a-zA-Z0-9_-]{1,64}$/u.test(request.id)) throw new Error("The image burn job identity is invalid.");
  const strokes = normalizeMobileAnnotationStrokes(request.strokes);
  const mediaType = request.mediaType.trim().toLowerCase();
  if (!canAnnotateMobileImage(mediaType) || !/^[A-Za-z0-9+/]*={0,2}$/u.test(request.base64)) {
    throw new Error("The image burn input is invalid.");
  }
  return `window.__jokoBurnIn(${JSON.stringify({ ...request, mediaType, strokes })}); true;`;
}

export function parseMobileAnnotationBurnMessage(raw: string): MobileAnnotationBurnResponse | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return undefined;
    if (value["ready"] === true) return { ready: true };
    const id = value["id"];
    if (typeof id !== "string" || !/^burn-[a-zA-Z0-9_-]{1,64}$/u.test(id)) return undefined;
    if (value["ok"] === false) {
      return { id, ok: false, error: typeof value["error"] === "string" ? value["error"].slice(0, 512) : "unknown" };
    }
    if (value["ok"] !== true || typeof value["base64"] !== "string"
      || value["mediaType"] !== "image/jpeg" && value["mediaType"] !== "image/png"
      || !Number.isSafeInteger(value["width"]) || (value["width"] as number) < 1
      || !Number.isSafeInteger(value["height"]) || (value["height"] as number) < 1
      || (value["width"] as number) > MOBILE_ANNOTATION_MAX_BURN_DIMENSION
      || (value["height"] as number) > MOBILE_ANNOTATION_MAX_BURN_DIMENSION) return undefined;
    return {
      id,
      ok: true,
      base64: value["base64"],
      mediaType: value["mediaType"],
      width: value["width"] as number,
      height: value["height"] as number
    };
  } catch {
    return undefined;
  }
}

export function buildMobileAnnotationBurnHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; script-src 'unsafe-inline'"></head><body><script>
(function () {
  'use strict';
  var COLOR = ${JSON.stringify(MOBILE_ANNOTATION_STROKE_COLOR)};
  var OUTLINE = ${JSON.stringify(MOBILE_ANNOTATION_OUTLINE_COLOR)};
  var OUTLINE_RATIO = ${MOBILE_ANNOTATION_OUTLINE_RATIO};
  var MAX_DIMENSION = ${MOBILE_ANNOTATION_MAX_BURN_DIMENSION};
  function post(value) { window.ReactNativeWebView.postMessage(JSON.stringify(value)); }
  function lineWidth(width, height) { return Math.min(24, Math.max(4, Math.round(Math.min(width, height) * 0.005))); }
  function draw(ctx, strokes, width, height, color, size) {
    ctx.strokeStyle = color; ctx.lineWidth = size; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (var index = 0; index < strokes.length; index += 1) {
      var points = strokes[index].points; if (!points || points.length === 0) continue;
      ctx.beginPath(); ctx.moveTo(points[0].x * width, points[0].y * height);
      if (points.length === 1) ctx.lineTo(points[0].x * width + 0.1, points[0].y * height);
      else for (var point = 1; point < points.length; point += 1) ctx.lineTo(points[point].x * width, points[point].y * height);
      ctx.stroke();
    }
  }
  window.__jokoBurnIn = function (request) {
    try {
      var image = new Image();
      image.onload = function () {
        try {
          var naturalWidth = image.naturalWidth || image.width;
          var naturalHeight = image.naturalHeight || image.height;
          if (!naturalWidth || !naturalHeight) { post({ id: request.id, ok: false, error: 'image has no dimensions' }); return; }
          var ratio = Math.min(1, MAX_DIMENSION / Math.max(naturalWidth, naturalHeight));
          var width = Math.max(1, Math.round(naturalWidth * ratio));
          var height = Math.max(1, Math.round(naturalHeight * ratio));
          var canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
          var context = canvas.getContext('2d');
          if (!context) { post({ id: request.id, ok: false, error: 'canvas unavailable' }); return; }
          context.drawImage(image, 0, 0, width, height);
          var size = lineWidth(width, height);
          draw(context, request.strokes, width, height, OUTLINE, Math.round(size * OUTLINE_RATIO));
          draw(context, request.strokes, width, height, COLOR, size);
          var outputType = request.mediaType === 'image/jpeg' ? 'image/jpeg' : 'image/png';
          var dataUrl = canvas.toDataURL(outputType, 0.92); var comma = dataUrl.indexOf(',');
          if (comma < 0) { post({ id: request.id, ok: false, error: 'encode failed' }); return; }
          post({ id: request.id, ok: true, base64: dataUrl.slice(comma + 1), mediaType: outputType, width: width, height: height });
          canvas.width = 1; canvas.height = 1; image.src = '';
        } catch (error) { post({ id: request.id, ok: false, error: String(error) }); }
      };
      image.onerror = function () { post({ id: request.id, ok: false, error: 'image decode failed' }); };
      image.src = 'data:' + request.mediaType + ';base64,' + request.base64;
    } catch (error) { post({ id: request.id, ok: false, error: String(error) }); }
  };
  post({ ready: true });
})();
</script></body></html>`;
}

export function encodeMobileBase64(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) throw new Error("The image bytes are invalid.");
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const first = bytes[offset]!;
    const second = bytes[offset + 1];
    const third = bytes[offset + 2];
    const group = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    result += BASE64[(group >>> 18) & 63]!;
    result += BASE64[(group >>> 12) & 63]!;
    result += second === undefined ? "=" : BASE64[(group >>> 6) & 63]!;
    result += third === undefined ? "=" : BASE64[group & 63]!;
  }
  return result;
}

export function decodeMobileBase64(value: string, maximumBytes: number): Uint8Array {
  if (typeof value !== "string" || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1
    || value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw new Error("The burned image encoding is invalid.");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const byteLength = value.length / 4 * 3 - padding;
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > maximumBytes) {
    throw new Error("The burned image exceeds the current attachment byte limit.");
  }
  const bytes = new Uint8Array(byteLength);
  let output = 0;
  for (let offset = 0; offset < value.length; offset += 4) {
    const first = base64Index(value.charCodeAt(offset));
    const second = base64Index(value.charCodeAt(offset + 1));
    const third = value[offset + 2] === "=" ? 0 : base64Index(value.charCodeAt(offset + 2));
    const fourth = value[offset + 3] === "=" ? 0 : base64Index(value.charCodeAt(offset + 3));
    if (first < 0 || second < 0 || third < 0 || fourth < 0) throw new Error("The burned image encoding is invalid.");
    const group = (first << 18) | (second << 12) | (third << 6) | fourth;
    if (output < byteLength) bytes[output++] = (group >>> 16) & 255;
    if (output < byteLength) bytes[output++] = (group >>> 8) & 255;
    if (output < byteLength) bytes[output++] = group & 255;
  }
  return bytes;
}

export function sniffMobileImageMediaType(bytes: Uint8Array): "image/jpeg" | "image/png" | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return undefined;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Index(characterCode: number): number {
  if (characterCode >= 65 && characterCode <= 90) return characterCode - 65;
  if (characterCode >= 97 && characterCode <= 122) return characterCode - 71;
  if (characterCode >= 48 && characterCode <= 57) return characterCode + 4;
  if (characterCode === 43) return 62;
  if (characterCode === 47) return 63;
  return -1;
}
