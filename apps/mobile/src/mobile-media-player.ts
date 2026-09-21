import { mobileMediaPreviewKind, type MobileMediaPreviewKind } from "./mobile-media-preview";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import { normalizeMediaType } from "./workspace-files";

export type MobileMediaPlayerCommand = "pause" | "reset";
export type MobileMediaPlayerState = "ready" | "playing" | "paused" | "waiting" | "ended" | "error";

export interface MobileMediaPlayerStatus {
  readonly type: "joko-media-player/status";
  readonly instanceId: string;
  readonly state: MobileMediaPlayerState;
  readonly currentTime: number | null;
  readonly duration: number | null;
  readonly error: string | null;
}

export function buildMobileMediaPlayerCommand(instanceId: string, command: MobileMediaPlayerCommand): string {
  const exactInstanceId = playerInstanceId(instanceId);
  if (command !== "pause" && command !== "reset") throw new Error("The media player command is invalid.");
  return JSON.stringify({ type: "joko-media-player/command", instanceId: exactInstanceId, command });
}

export function parseMobileMediaPlayerStatus(data: string, instanceId: string): MobileMediaPlayerStatus | undefined {
  if (typeof data !== "string" || data.length < 2 || data.length > 4_096) return undefined;
  const exactInstanceId = playerInstanceId(instanceId);
  try {
    const value = JSON.parse(data) as unknown;
    if (!plainObject(value) || !exactKeys(value, ["type", "instanceId", "state", "currentTime", "duration", "error"])
      || value["type"] !== "joko-media-player/status" || value["instanceId"] !== exactInstanceId
      || !playerState(value["state"]) || !finiteTime(value["currentTime"]) || !finiteTime(value["duration"])
      || !playerError(value["error"])) return undefined;
    return {
      type: "joko-media-player/status",
      instanceId: exactInstanceId,
      state: value["state"],
      currentTime: value["currentTime"],
      duration: value["duration"],
      error: value["error"]
    };
  } catch {
    return undefined;
  }
}

export function buildMobileMediaPlayerHtml({
  instanceId,
  kind,
  locale,
  mediaType,
  title,
  uri,
  background,
  surface,
  ink
}: {
  readonly instanceId: string;
  readonly kind: MobileMediaPreviewKind;
  readonly locale: MobileSupportedLocale;
  readonly mediaType: string;
  readonly title: string;
  readonly uri: string;
  readonly background: string;
  readonly surface: string;
  readonly ink: string;
}): string {
  const exactInstanceId = playerInstanceId(instanceId);
  const exactMediaType = normalizeMediaType(mediaType);
  if (mobileMediaPreviewKind(exactMediaType) !== kind) throw new Error("The media player kind does not match its media type.");
  if (typeof uri !== "string" || !uri.startsWith("file://") || uri.length > 4_096
    || /[\u0000-\u001f\u007f]/u.test(uri)) throw new Error("The media player URI is invalid.");
  const exactTitle = boundedText(title, 512) || mobileMessage(locale,
    kind === "video" ? "preview.videoTitle" : "preview.audioTitle");
  const errorLabel = mobileMessage(locale, "preview.mediaError");
  const tag = kind === "video" ? "video" : "audio";
  const videoAttributes = kind === "video" ? " playsinline" : "";
  const safeBackground = cssColor(background);
  const safeSurface = cssColor(surface);
  const safeInk = cssColor(ink);
  return `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; connect-src 'none'; font-src 'none'; form-action 'none'; frame-src 'none'; img-src 'none'; media-src file:; object-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
  <style>
    html, body { background: ${safeBackground}; color: ${safeInk}; height: 100%; margin: 0; width: 100%; }
    body { align-items: center; display: flex; justify-content: center; overflow: hidden; }
    video { background: ${safeSurface}; height: 100%; object-fit: contain; width: 100%; }
    audio { width: min(92vw, 680px); }
  </style>
</head>
<body>
  <${tag} controls${videoAttributes} preload="metadata" aria-label="${escapeHtml(exactTitle)}"><source src="${escapeHtml(uri)}" type="${escapeHtml(exactMediaType)}" /></${tag}>
  <script>
    (function () {
      'use strict';
      var instanceId = ${JSON.stringify(exactInstanceId)};
      var errorLabel = ${JSON.stringify(errorLabel)};
      var media = document.querySelector(${JSON.stringify(tag)});
      var lastTimeUpdate = 0;
      function finite(value) { return Number.isFinite(value) && value >= 0 ? value : null; }
      function cleanError(value) {
        var text = typeof value === 'string' ? value.replace(/[\\u0000-\\u001f\\u007f]/g, ' ').trim() : '';
        return text ? text.slice(0, 512) : null;
      }
      function emit(state, error, force) {
        if (!media) return;
        var now = Date.now();
        if (!force && state === 'playing' && now - lastTimeUpdate < 1000) return;
        if (state === 'playing') lastTimeUpdate = now;
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'joko-media-player/status',
          instanceId: instanceId,
          state: state,
          currentTime: finite(media.currentTime),
          duration: finite(media.duration),
          error: cleanError(error)
        }));
      }
      function command(data) {
        if (typeof data !== 'string' || data.length > 1024) return null;
        try {
          var value = JSON.parse(data);
          if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
          var keys = Object.keys(value).sort().join(',');
          if (keys !== 'command,instanceId,type' || value.type !== 'joko-media-player/command'
            || value.instanceId !== instanceId) return null;
          return value.command === 'pause' || value.command === 'reset' ? value.command : null;
        } catch (_) { return null; }
      }
      function handleCommand(event) {
        var value = command(event && event.data);
        if (!value || !media) return;
        media.pause();
        if (value === 'reset') {
          try { media.currentTime = 0; } catch (_) {}
        }
        emit(media.ended ? 'ended' : 'paused', null, true);
      }
      if (!media || !window.ReactNativeWebView || typeof window.ReactNativeWebView.postMessage !== 'function') return;
      window.addEventListener('message', handleCommand);
      document.addEventListener('message', handleCommand);
      media.addEventListener('loadedmetadata', function () { emit('ready', null, true); });
      media.addEventListener('play', function () { emit('playing', null, true); });
      media.addEventListener('timeupdate', function () { emit(media.paused ? 'paused' : 'playing', null, false); });
      media.addEventListener('pause', function () { emit(media.ended ? 'ended' : 'paused', null, true); });
      media.addEventListener('waiting', function () { emit('waiting', null, true); });
      media.addEventListener('ended', function () { emit('ended', null, true); });
      media.addEventListener('error', function () {
        emit('error', errorLabel, true);
      });
    })();
  </script>
</body>
</html>`;
}

export function createMobileMediaPlayerLifecycle(maximumReloads = 1) {
  if (!Number.isSafeInteger(maximumReloads) || maximumReloads < 0 || maximumReloads > 3) {
    throw new Error("The media player reload budget is invalid.");
  }
  let loading = true;
  let reloadOnActive = false;
  let reloads = 0;
  return {
    onLoadStart() { loading = true; },
    onLoadEnd() { loading = false; },
    onBackground() { reloadOnActive ||= loading; },
    onProcessLost(active: boolean): "reload" | "wait" | "failed" {
      loading = true;
      if (!active) {
        reloadOnActive = true;
        return "wait";
      }
      if (reloads >= maximumReloads) return "failed";
      reloads += 1;
      return "reload";
    },
    consumeReloadOnActive(): "reload" | "failed" | undefined {
      if (!reloadOnActive) return undefined;
      reloadOnActive = false;
      if (reloads >= maximumReloads) return "failed";
      reloads += 1;
      loading = true;
      return "reload";
    },
    reset() {
      loading = true;
      reloadOnActive = false;
      reloads = 0;
    }
  };
}

function playerState(value: unknown): value is MobileMediaPlayerState {
  return value === "ready" || value === "playing" || value === "paused"
    || value === "waiting" || value === "ended" || value === "error";
}

function finiteTime(value: unknown): value is number | null {
  return value === null || typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function playerError(value: unknown): value is string | null {
  return value === null || typeof value === "string" && value.length <= 512
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function playerInstanceId(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128
    || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("The media player instance identity is invalid.");
  return value;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function boundedText(value: string, maximum: number): string {
  if (typeof value !== "string") return "";
  const exact = value.trim();
  return exact.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(exact) ? exact : "";
}

function cssColor(value: string): string {
  return typeof value === "string" && /^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/u.test(value) ? value : "#000000";
}

function escapeHtml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;").replace(/'/gu, "&#39;");
}
