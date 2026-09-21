import { MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES } from "./network";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";

export const mobilePdfViewerLimits = {
  maximumChunkBytes: 128 * 1024,
  maximumPageCount: 20_000,
  maximumResidentCanvases: 6,
  pdfJsVersion: "5.7.284",
  cMapResourceCount: 169,
  standardFontResourceCount: 16
} as const;

export type MobilePdfViewerState = "ready" | "receiving" | "document" | "rendering" | "complete" | "error";

export interface MobilePdfViewerStatus {
  readonly type: "joko-pdf-viewer/status";
  readonly instanceId: string;
  readonly state: MobilePdfViewerState;
  readonly pageCount: number;
  readonly renderedPages: number;
  readonly zoomPercent: number;
  readonly error: string | null;
}

export interface MobilePdfViewerAck {
  readonly type: "joko-pdf-viewer/ack";
  readonly instanceId: string;
  readonly command: "begin" | "chunk" | "commit";
  readonly index: number;
}

export type MobilePdfViewerMessage = MobilePdfViewerStatus | MobilePdfViewerAck;

export interface MobilePdfJsRuntimeBundle {
  readonly version: string;
  readonly script: string;
  readonly scriptSha256Hex: string;
  readonly cMaps: Readonly<Record<string, string>>;
  readonly cMapByteSize: number;
  readonly cMapSha256Hex: string;
  readonly standardFonts: Readonly<Record<string, string>>;
  readonly standardFontByteSize: number;
  readonly standardFontSha256Hex: string;
}

export type MobilePdfViewerCommand =
  | { readonly command: "begin"; readonly byteSize: number; readonly sha256Hex: string }
  | { readonly command: "chunk"; readonly index: number; readonly offset: number; readonly base64: string }
  | { readonly command: "commit" }
  | { readonly command: "dispose" };

export function buildMobilePdfViewerCommand(instanceId: string, command: MobilePdfViewerCommand): string {
  const exactInstanceId = viewerInstanceId(instanceId);
  if (command.command === "begin") {
    if (!Number.isSafeInteger(command.byteSize) || command.byteSize < 64
      || command.byteSize > MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES
      || !/^[0-9a-f]{64}$/u.test(command.sha256Hex)) throw new Error("The PDF transfer identity is invalid.");
    return JSON.stringify({ type: "joko-pdf-viewer/command", instanceId: exactInstanceId,
      command: "begin", byteSize: command.byteSize, sha256Hex: command.sha256Hex });
  }
  if (command.command === "chunk") {
    const maximumBase64 = Math.ceil(mobilePdfViewerLimits.maximumChunkBytes / 3) * 4;
    if (!Number.isSafeInteger(command.index) || command.index < 0 || command.index > 262_144
      || !Number.isSafeInteger(command.offset) || command.offset < 0
      || typeof command.base64 !== "string" || command.base64.length < 4
      || command.base64.length > maximumBase64 || command.base64.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/u.test(command.base64)) {
      throw new Error("The PDF transfer chunk is invalid.");
    }
    return JSON.stringify({ type: "joko-pdf-viewer/command", instanceId: exactInstanceId,
      command: "chunk", index: command.index, offset: command.offset, base64: command.base64 });
  }
  if (command.command !== "commit" && command.command !== "dispose") {
    throw new Error("The PDF viewer command is invalid.");
  }
  return JSON.stringify({ type: "joko-pdf-viewer/command", instanceId: exactInstanceId, command: command.command });
}

export function parseMobilePdfViewerMessage(data: string, instanceId: string): MobilePdfViewerMessage | undefined {
  if (typeof data !== "string" || data.length < 2 || data.length > 8_192) return undefined;
  const exactInstanceId = viewerInstanceId(instanceId);
  try {
    const value = JSON.parse(data) as unknown;
    if (!plainObject(value) || value["instanceId"] !== exactInstanceId) return undefined;
    if (value["type"] === "joko-pdf-viewer/ack") {
      if (!exactKeys(value, ["type", "instanceId", "command", "index"])
        || !pdfAckCommand(value["command"]) || !Number.isSafeInteger(value["index"])
        || (value["index"] as number) < -1 || (value["index"] as number) > 262_144) return undefined;
      return { type: "joko-pdf-viewer/ack", instanceId: exactInstanceId,
        command: value["command"], index: value["index"] as number };
    }
    if (value["type"] !== "joko-pdf-viewer/status"
      || !exactKeys(value, ["type", "instanceId", "state", "pageCount", "renderedPages", "zoomPercent", "error"])
      || !pdfViewerState(value["state"]) || !safeCount(value["pageCount"], mobilePdfViewerLimits.maximumPageCount)
      || !safeCount(value["renderedPages"], value["pageCount"] as number)
      || !Number.isSafeInteger(value["zoomPercent"]) || (value["zoomPercent"] as number) < 25
      || (value["zoomPercent"] as number) > 400 || !viewerError(value["error"])) return undefined;
    return {
      type: "joko-pdf-viewer/status",
      instanceId: exactInstanceId,
      state: value["state"],
      pageCount: value["pageCount"] as number,
      renderedPages: value["renderedPages"] as number,
      zoomPercent: value["zoomPercent"] as number,
      error: value["error"]
    };
  } catch {
    return undefined;
  }
}

export function buildMobilePdfViewerHtml({
  instanceId,
  locale,
  title,
  background,
  surface,
  ink,
  muted,
  accent,
  border
}: {
  readonly instanceId: string;
  readonly locale: MobileSupportedLocale;
  readonly title: string;
  readonly background: string;
  readonly surface: string;
  readonly ink: string;
  readonly muted: string;
  readonly accent: string;
  readonly border: string;
}, runtime: MobilePdfJsRuntimeBundle): string {
  const exactInstanceId = viewerInstanceId(instanceId);
  const exactTitle = boundedText(title, 512) || mobileMessage(locale, "preview.pdfTitle");
  assertRuntimeBundle(runtime);
  const cMaps = JSON.stringify(runtime.cMaps);
  const standardFonts = JSON.stringify(runtime.standardFonts);
  const labels = {
    error: mobileMessage(locale, "preview.pdfError"),
    ready: mobileMessage(locale, "preview.status.pdfReady"),
    receiving: mobileMessage(locale, "preview.status.receivingPdf"),
    preparing: mobileMessage(locale, "preview.status.preparingPdf"),
    pageCount: mobileMessage(locale, "preview.pdfPageCount", { pages: "{pages}" }),
    allRendered: mobileMessage(locale, "preview.pdfAllRendered", { pages: "{pages}" }),
    renderedProgress: mobileMessage(locale, "preview.pdfRenderedProgress", {
      rendered: "{rendered}", pages: "{pages}"
    }),
    renderedPage: mobileMessage(locale, "preview.pdfRenderedPage", { page: "{page}", pages: "{pages}" }),
    page: mobileMessage(locale, "preview.pdfPage", { page: "{page}", pages: "{pages}" }),
    pageError: mobileMessage(locale, "preview.pdfPageError", { page: "{page}" })
  };
  return `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; connect-src 'none'; font-src blob: data:; form-action 'none'; frame-src 'none'; img-src blob: data:; media-src 'none'; object-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; worker-src 'none'" />
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    html, body { background: ${cssColor(background)}; color: ${cssColor(ink)}; height: 100%; margin: 0; width: 100%; }
    body { display: flex; flex-direction: column; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; overflow: hidden; }
    #toolbar { align-items: center; background: ${cssColor(surface)}; border-bottom: 1px solid ${cssColor(border)}; display: flex; flex: 0 0 auto; gap: 8px; min-height: 48px; padding: 6px 10px; }
    #status { color: ${cssColor(muted)}; flex: 1; font-size: 13px; line-height: 18px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    button { background: ${cssColor(background)}; border: 1px solid ${cssColor(border)}; border-radius: 10px; color: ${cssColor(ink)}; font: inherit; font-weight: 650; min-height: 34px; min-width: 38px; padding: 6px 10px; }
    button:focus-visible { outline: 3px solid ${cssColor(accent)}; outline-offset: 1px; }
    #pages { align-items: center; display: flex; flex: 1 1 auto; flex-direction: column; gap: 16px; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 16px; }
    .page { align-items: center; background: ${cssColor(surface)}; border: 1px solid ${cssColor(border)}; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.12); display: flex; flex: 0 0 auto; justify-content: center; min-height: 320px; overflow: hidden; position: relative; width: min(100%, 760px); }
    .page-label { color: ${cssColor(muted)}; font-size: 13px; left: 12px; position: absolute; top: 10px; z-index: 1; }
    canvas { display: block; max-width: 100%; }
    .page-error { color: #b42318; max-width: 80%; text-align: center; }
  </style>
</head>
<body aria-label="${escapeHtml(exactTitle)}">
  <div id="toolbar" role="toolbar" aria-label="${escapeHtml(mobileMessage(locale, "preview.pdfControls"))}">
    <span id="status" role="status" aria-live="polite">${escapeHtml(labels.preparing)}</span>
    <button id="fit" type="button" aria-label="${escapeHtml(mobileMessage(locale, "preview.pdfFitLabel"))}">${escapeHtml(mobileMessage(locale, "preview.pdfFit"))}</button>
    <button id="zoom-out" type="button" aria-label="${escapeHtml(mobileMessage(locale, "preview.pdfZoomOut"))}">−</button>
    <button id="zoom-in" type="button" aria-label="${escapeHtml(mobileMessage(locale, "preview.pdfZoomIn"))}">+</button>
  </div>
  <main id="pages" aria-label="${escapeHtml(mobileMessage(locale, "preview.pdfPagesOf", { title: exactTitle }))}"></main>
  <script>${runtime.script}</script>
  <script>
    (function () {
      'use strict';
      var instanceId = ${JSON.stringify(exactInstanceId)};
      var labels = ${JSON.stringify(labels)};
      var cMaps = ${cMaps};
      var standardFonts = ${standardFonts};
      var resourceCache = Object.create(null);
      var bytes = null;
      var byteSize = 0;
      var expectedHash = '';
      var expectedChunk = 0;
      var received = 0;
      var disposed = false;
      var loadingTask = null;
      var pdfDocument = null;
      var observer = null;
      var renderGeneration = 0;
      var renderTasks = new Map();
      var rendered = new Map();
      var resident = [];
      var seen = new Set();
      var pageCount = 0;
      var zoom = 1;
      var fit = true;
      var pages = document.getElementById('pages');
      var statusNode = document.getElementById('status');
      var MAX_BYTES = ${MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES};
      var MAX_CHUNK = ${mobilePdfViewerLimits.maximumChunkBytes};
      var MAX_PAGES = ${mobilePdfViewerLimits.maximumPageCount};
      var MAX_RESIDENT = ${mobilePdfViewerLimits.maximumResidentCanvases};

      function post(value) {
        if (!disposed && window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
          window.ReactNativeWebView.postMessage(JSON.stringify(value));
        }
      }
      function text(template, values) {
        return Object.keys(values || {}).reduce(function (result, key) {
          return result.split('{' + key + '}').join(String(values[key]));
        }, template);
      }
      function cleanError(_) {
        return labels.error;
      }
      function emit(state, error) {
        var label = state === 'ready' ? labels.ready
          : state === 'receiving' ? labels.receiving
          : state === 'document' ? text(labels.pageCount, { pages: pageCount })
          : state === 'complete' ? text(labels.allRendered, { pages: pageCount })
          : state === 'error' ? cleanError(error)
          : text(labels.renderedProgress, { rendered: seen.size, pages: pageCount });
        statusNode.textContent = label;
        post({ type: 'joko-pdf-viewer/status', instanceId: instanceId, state: state,
          pageCount: pageCount, renderedPages: seen.size, zoomPercent: Math.round(zoom * 100),
          error: state === 'error' ? cleanError(error) : null });
      }
      function ack(command, index) {
        post({ type: 'joko-pdf-viewer/ack', instanceId: instanceId, command: command, index: index });
      }
      function exactKeys(value, expected) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        var keys = Object.keys(value).sort(); expected = expected.slice().sort();
        return keys.length === expected.length && keys.every(function (key, index) { return key === expected[index]; });
      }
      function parseCommand(data) {
        if (typeof data !== 'string' || data.length < 2 || data.length > 180000) return null;
        try {
          var value = JSON.parse(data);
          if (!value || value.type !== 'joko-pdf-viewer/command' || value.instanceId !== instanceId) return null;
          if (value.command === 'begin' && exactKeys(value, ['type','instanceId','command','byteSize','sha256Hex'])
            && Number.isSafeInteger(value.byteSize) && value.byteSize >= 64 && value.byteSize <= MAX_BYTES
            && typeof value.sha256Hex === 'string' && /^[0-9a-f]{64}$/.test(value.sha256Hex)) return value;
          if (value.command === 'chunk' && exactKeys(value, ['type','instanceId','command','index','offset','base64'])
            && Number.isSafeInteger(value.index) && value.index >= 0 && value.index <= 262144
            && Number.isSafeInteger(value.offset) && value.offset >= 0 && typeof value.base64 === 'string'
            && value.base64.length >= 4 && value.base64.length <= Math.ceil(MAX_CHUNK / 3) * 4
            && value.base64.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value.base64)) return value;
          if ((value.command === 'commit' || value.command === 'dispose')
            && exactKeys(value, ['type','instanceId','command'])) return value;
        } catch (_) {}
        return null;
      }
      function decodeBase64(value, maximum) {
        var binary = atob(value);
        if (binary.length < 1 || binary.length > maximum) throw new Error('The PDF base64 payload is outside its byte budget.');
        var output = new Uint8Array(binary.length);
        for (var index = 0; index < binary.length; index += 1) output[index] = binary.charCodeAt(index);
        return output;
      }
      function embeddedBytes(kind, filename) {
        if (typeof filename !== 'string' || filename.length < 1 || filename.length > 128
          || filename.indexOf('/') >= 0 || filename.indexOf('\\\\') >= 0) return null;
        var source = kind === 'cMapUrl' ? cMaps : kind === 'standardFontDataUrl' ? standardFonts : null;
        if (!source || !Object.prototype.hasOwnProperty.call(source, filename)) return null;
        var cacheKey = kind + ':' + filename;
        if (resourceCache[cacheKey]) return resourceCache[cacheKey];
        var decoded = decodeBase64(source[filename], 262144);
        resourceCache[cacheKey] = decoded;
        return decoded;
      }
      function EmbeddedBinaryDataFactory() {}
      EmbeddedBinaryDataFactory.prototype.fetch = async function (request) {
        var value = embeddedBytes(request && request.kind, request && request.filename);
        if (!value) throw new Error('The requested embedded PDF resource is unavailable.');
        return value;
      };

      function rotateRight(value, count) { return (value >>> count) | (value << (32 - count)); }
      function fallbackSha256(data) {
        var constants = [
          0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
          0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
          0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
          0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
          0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
          0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
          0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
          0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
        ];
        var state = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
        var paddedLength = Math.ceil((data.length + 9) / 64) * 64;
        var padded = new Uint8Array(paddedLength); padded.set(data); padded[data.length] = 0x80;
        var view = new DataView(padded.buffer); var bitLength = data.length * 8;
        view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
        view.setUint32(paddedLength - 4, bitLength >>> 0);
        var words = new Uint32Array(64);
        for (var offset = 0; offset < paddedLength; offset += 64) {
          for (var word = 0; word < 16; word += 1) words[word] = view.getUint32(offset + word * 4);
          for (var expand = 16; expand < 64; expand += 1) {
            var s0 = rotateRight(words[expand - 15], 7) ^ rotateRight(words[expand - 15], 18) ^ (words[expand - 15] >>> 3);
            var s1 = rotateRight(words[expand - 2], 17) ^ rotateRight(words[expand - 2], 19) ^ (words[expand - 2] >>> 10);
            words[expand] = (words[expand - 16] + s0 + words[expand - 7] + s1) >>> 0;
          }
          var a=state[0],b=state[1],c=state[2],d=state[3],e=state[4],f=state[5],g=state[6],h=state[7];
          for (var round = 0; round < 64; round += 1) {
            var upper = rotateRight(e,6) ^ rotateRight(e,11) ^ rotateRight(e,25);
            var choose = (e & f) ^ (~e & g);
            var temporary1 = (h + upper + choose + constants[round] + words[round]) >>> 0;
            var lower = rotateRight(a,2) ^ rotateRight(a,13) ^ rotateRight(a,22);
            var majority = (a & b) ^ (a & c) ^ (b & c);
            var temporary2 = (lower + majority) >>> 0;
            h=g;g=f;f=e;e=(d+temporary1)>>>0;d=c;c=b;b=a;a=(temporary1+temporary2)>>>0;
          }
          state[0]=(state[0]+a)>>>0;state[1]=(state[1]+b)>>>0;state[2]=(state[2]+c)>>>0;state[3]=(state[3]+d)>>>0;
          state[4]=(state[4]+e)>>>0;state[5]=(state[5]+f)>>>0;state[6]=(state[6]+g)>>>0;state[7]=(state[7]+h)>>>0;
        }
        return state.map(function (value) { return value.toString(16).padStart(8,'0'); }).join('');
      }
      async function sha256(data) {
        if (window.crypto && window.crypto.subtle && typeof window.crypto.subtle.digest === 'function') {
          try {
            var digest = new Uint8Array(await window.crypto.subtle.digest('SHA-256', data));
            return Array.from(digest).map(function (value) { return value.toString(16).padStart(2,'0'); }).join('');
          } catch (_) {}
        }
        return fallbackSha256(data);
      }

      function visible(section) {
        var root = pages.getBoundingClientRect(); var rect = section.getBoundingClientRect();
        return rect.bottom >= root.top - root.height && rect.top <= root.bottom + root.height;
      }
      function touchResident(pageNumber, section) {
        resident = resident.filter(function (value) { return value !== pageNumber; }); resident.push(pageNumber);
        while (resident.length > MAX_RESIDENT) {
          var retired = resident.shift(); var retiredSection = document.getElementById('page-' + String(retired));
          if (!retiredSection || visible(retiredSection)) { if (retired !== undefined) resident.push(retired); break; }
          var canvas = retiredSection.querySelector('canvas');
          if (canvas) { canvas.width = 1; canvas.height = 1; canvas.remove(); }
          rendered.delete(retired);
        }
      }
      async function renderPage(pageNumber) {
        if (disposed || !pdfDocument || renderTasks.has(pageNumber) || rendered.get(pageNumber) === renderGeneration) return;
        var section = document.getElementById('page-' + String(pageNumber)); if (!section) return;
        var generation = renderGeneration;
        var holder = { cancel: function () {} }; renderTasks.set(pageNumber, holder);
        try {
          var page = await pdfDocument.getPage(pageNumber); if (disposed || generation !== renderGeneration) return;
          var base = page.getViewport({ scale: 1 });
          var available = Math.max(240, pages.clientWidth - 34);
          var scale = fit ? Math.min(2.5, Math.max(0.25, available / base.width)) * zoom : zoom;
          var viewport = page.getViewport({ scale: scale });
          var dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
          var pixelWidth = Math.ceil(viewport.width * dpr); var pixelHeight = Math.ceil(viewport.height * dpr);
          var safety = Math.min(1, 4096 / Math.max(pixelWidth, pixelHeight), Math.sqrt(16777216 / Math.max(1, pixelWidth * pixelHeight)));
          if (safety < 1) { scale *= safety; viewport = page.getViewport({ scale: scale }); pixelWidth = Math.ceil(viewport.width * dpr); pixelHeight = Math.ceil(viewport.height * dpr); }
          var prior = section.querySelector('canvas'); if (prior) prior.remove();
          var error = section.querySelector('.page-error'); if (error) error.remove();
          var canvas = document.createElement('canvas'); canvas.width = pixelWidth; canvas.height = pixelHeight;
          canvas.style.width = String(Math.ceil(viewport.width)) + 'px'; canvas.style.height = String(Math.ceil(viewport.height)) + 'px';
          canvas.setAttribute('aria-label', text(labels.renderedPage, { page: pageNumber, pages: pageCount }));
          section.style.height = String(Math.ceil(viewport.height)) + 'px'; section.appendChild(canvas);
          var context = canvas.getContext('2d', { alpha: false }); if (!context) throw new Error('Canvas rendering is unavailable.');
          var task = page.render({ canvasContext: context, viewport: viewport, transform: dpr === 1 ? null : [dpr,0,0,dpr,0,0] });
          holder.cancel = function () { try { task.cancel(); } catch (_) {} };
          await task.promise; if (disposed || generation !== renderGeneration) return;
          rendered.set(pageNumber, generation); seen.add(pageNumber); touchResident(pageNumber, section);
          emit(seen.size === pageCount ? 'complete' : 'rendering', null);
        } catch (error) {
          if (disposed || generation !== renderGeneration || (error && error.name === 'RenderingCancelledException')) return;
          var priorCanvas = section.querySelector('canvas'); if (priorCanvas) priorCanvas.remove();
          var message = document.createElement('p'); message.className = 'page-error'; message.setAttribute('role','alert');
          message.textContent = text(labels.pageError, { page: pageNumber }); section.appendChild(message);
          emit('error', error);
        } finally { renderTasks.delete(pageNumber); }
      }
      function renderVisiblePages() {
        if (disposed || !pdfDocument) return;
        document.querySelectorAll('.page').forEach(function (section) { if (visible(section)) void renderPage(Number(section.dataset.page)); });
      }
      function resetRenderedPages() {
        renderGeneration += 1; renderTasks.forEach(function (task) { task.cancel(); }); renderTasks.clear();
        rendered.clear(); resident = [];
        document.querySelectorAll('.page canvas').forEach(function (canvas) { canvas.width = 1; canvas.height = 1; canvas.remove(); });
        renderVisiblePages(); emit(seen.size === pageCount ? 'complete' : 'rendering', null);
      }
      async function openDocument(data) {
        loadingTask = window.pdfjsLib.getDocument({ data: data, cMapUrl: 'embedded-cmaps/', cMapPacked: true,
          standardFontDataUrl: 'embedded-fonts/', BinaryDataFactory: EmbeddedBinaryDataFactory,
          useWorkerFetch: false, useSystemFonts: false, useWasm: false, isOffscreenCanvasSupported: false,
          isImageDecoderSupported: false, enableHWA: false, canvasMaxAreaInBytes: 33554432 });
        pdfDocument = await loadingTask.promise;
        pageCount = pdfDocument.numPages;
        if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > MAX_PAGES) throw new Error('The PDF page count exceeds the mobile preview budget.');
        var fragment = document.createDocumentFragment();
        for (var pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
          var section = document.createElement('section'); section.className = 'page'; section.id = 'page-' + String(pageNumber);
          section.dataset.page = String(pageNumber); section.setAttribute('aria-label', text(labels.page, { page: pageNumber, pages: pageCount }));
          var label = document.createElement('span'); label.className = 'page-label'; label.textContent = String(pageNumber) + ' / ' + String(pageCount); section.appendChild(label); fragment.appendChild(section);
        }
        pages.replaceChildren(fragment); emit('document', null);
        if (typeof IntersectionObserver === 'function') {
          observer = new IntersectionObserver(function (entries) { entries.forEach(function (entry) { if (entry.isIntersecting) void renderPage(Number(entry.target.dataset.page)); }); },
            { root: pages, rootMargin: '100% 0px', threshold: 0.01 });
          document.querySelectorAll('.page').forEach(function (section) { observer.observe(section); });
        }
        renderVisiblePages();
      }
      async function commitBytes() {
        if (!bytes || received !== byteSize) throw new Error('The PDF transfer is incomplete.');
        var data = bytes; var digest = await sha256(data);
        if (disposed) return;
        if (digest !== expectedHash) throw new Error('The PDF transfer SHA-256 identity changed in the renderer bridge.');
        ack('commit', expectedChunk - 1); bytes = null; await openDocument(data);
      }
      async function dispose() {
        if (disposed) return; disposed = true; bytes = null; resourceCache = Object.create(null);
        if (observer) observer.disconnect(); observer = null; renderTasks.forEach(function (task) { task.cancel(); }); renderTasks.clear();
        document.querySelectorAll('canvas').forEach(function (canvas) { canvas.width = 1; canvas.height = 1; });
        try { if (loadingTask) await loadingTask.destroy(); else if (pdfDocument) await pdfDocument.destroy(); } catch (_) {}
        loadingTask = null; pdfDocument = null; pages.replaceChildren();
      }
      function handleCommand(event) {
        var command = parseCommand(event && event.data); if (!command || disposed) return;
        try {
          if (command.command === 'dispose') { void dispose(); return; }
          if (command.command === 'begin') {
            if (bytes || loadingTask || received !== 0) throw new Error('The PDF transfer has already started.');
            byteSize = command.byteSize; expectedHash = command.sha256Hex; bytes = new Uint8Array(byteSize);
            expectedChunk = 0; received = 0; emit('receiving', null); ack('begin', -1); return;
          }
          if (command.command === 'chunk') {
            if (!bytes || command.index !== expectedChunk || command.offset !== received) throw new Error('The PDF transfer chunk is out of order.');
            var chunk = decodeBase64(command.base64, MAX_CHUNK); if (received + chunk.length > byteSize) throw new Error('The PDF transfer exceeds its declared byte size.');
            bytes.set(chunk, received); received += chunk.length; expectedChunk += 1; ack('chunk', command.index); return;
          }
          if (command.command === 'commit') { void commitBytes().catch(function (error) { emit('error', error); }); }
        } catch (error) { emit('error', error); }
      }

      window.addEventListener('message', handleCommand); document.addEventListener('message', handleCommand);
      pages.addEventListener('scroll', renderVisiblePages, { passive: true });
      document.getElementById('fit').addEventListener('click', function () { fit = true; zoom = 1; resetRenderedPages(); });
      document.getElementById('zoom-out').addEventListener('click', function () { fit = false; zoom = Math.max(0.5, Math.round((zoom - 0.25) * 100) / 100); resetRenderedPages(); });
      document.getElementById('zoom-in').addEventListener('click', function () { fit = false; zoom = Math.min(3, Math.round((zoom + 0.25) * 100) / 100); resetRenderedPages(); });
      if (!window.pdfjsLib || !window.pdfjsWorker || !window.ReactNativeWebView) { emit('error', 'The offline PDF runtime is unavailable.'); return; }
      emit('ready', null);
    })();
  </script>
</body>
</html>`;
}

export function createMobilePdfViewerLifecycle(maximumReloads = 1) {
  if (!Number.isSafeInteger(maximumReloads) || maximumReloads < 0 || maximumReloads > 3) {
    throw new Error("The PDF viewer reload budget is invalid.");
  }
  let reloadOnActive = false;
  let reloads = 0;
  return {
    onBackground() { reloadOnActive = true; },
    onProcessLost(active: boolean): "reload" | "wait" | "failed" {
      if (!active) { reloadOnActive = true; return "wait"; }
      if (reloads >= maximumReloads) return "failed";
      reloads += 1;
      return "reload";
    },
    consumeReloadOnActive(): "reload" | "failed" | undefined {
      if (!reloadOnActive) return undefined;
      reloadOnActive = false;
      if (reloads >= maximumReloads) return "failed";
      reloads += 1;
      return "reload";
    },
    reset() { reloadOnActive = false; reloads = 0; }
  };
}

function assertRuntimeBundle(runtime: MobilePdfJsRuntimeBundle): void {
  const cMapNames = Object.keys(runtime?.cMaps ?? {}).sort();
  const fontNames = Object.keys(runtime?.standardFonts ?? {}).sort();
  if (!runtime || runtime.version !== mobilePdfViewerLimits.pdfJsVersion || typeof runtime.script !== "string"
    || runtime.script.length < 500_000 || /<\/script/iu.test(runtime.script)
    || !/^[0-9a-f]{64}$/u.test(runtime.scriptSha256Hex)
    || !Number.isSafeInteger(runtime.cMapByteSize) || runtime.cMapByteSize < 1_000_000
    || !/^[0-9a-f]{64}$/u.test(runtime.cMapSha256Hex)
    || !Number.isSafeInteger(runtime.standardFontByteSize) || runtime.standardFontByteSize < 700_000
    || !/^[0-9a-f]{64}$/u.test(runtime.standardFontSha256Hex)
    || cMapNames.length !== mobilePdfViewerLimits.cMapResourceCount
    || !cMapNames.includes("UniGB-UTF16-H.bcmap") || !cMapNames.includes("LICENSE")
    || fontNames.length !== mobilePdfViewerLimits.standardFontResourceCount
    || !fontNames.includes("FoxitSymbol.pfb") || !fontNames.includes("FoxitDingbats.pfb")
    || !fontNames.includes("LICENSE_FOXIT") || !fontNames.includes("LICENSE_LIBERATION")) {
    throw new Error("The audited offline PDF.js runtime bundle is invalid.");
  }
  for (const value of [...Object.values(runtime.cMaps), ...Object.values(runtime.standardFonts)]) {
    if (typeof value !== "string" || value.length < 4 || value.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) throw new Error("The embedded PDF.js resource is invalid.");
  }
}

function pdfViewerState(value: unknown): value is MobilePdfViewerState {
  return value === "ready" || value === "receiving" || value === "document"
    || value === "rendering" || value === "complete" || value === "error";
}

function pdfAckCommand(value: unknown): value is MobilePdfViewerAck["command"] {
  return value === "begin" || value === "chunk" || value === "commit";
}

function safeCount(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function viewerError(value: unknown): value is string | null {
  return value === null || typeof value === "string" && value.length <= 512
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function viewerInstanceId(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128
    || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("The PDF viewer instance identity is invalid.");
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
