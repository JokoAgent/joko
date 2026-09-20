import { MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES } from "./network";
import {
  MOBILE_MODEL_PREVIEW_MAXIMUM_FILES,
  MOBILE_MODEL_PREVIEW_MAXIMUM_REFERENCES,
  mobileModelPreviewKind,
  type MobileModelFileDescriptor,
  type MobileModelPreviewKind,
  type MobileModelReference
} from "./mobile-model-preview";

export const mobileModelViewerLimits = {
  maximumChunkBytes: 128 * 1024,
  maximumCommandCharacters: 786_432,
  modelViewerVersion: "4.3.1",
  threeVersion: "0.183.2"
} as const;

export type MobileModelViewerState = "ready" | "receiving" | "loading" | "complete" | "error";

export interface MobileModelViewerStatus {
  readonly type: "joko-model-viewer/status";
  readonly instanceId: string;
  readonly state: MobileModelViewerState;
  readonly fileCount: number;
  readonly error: string | null;
}

export interface MobileModelViewerAck {
  readonly type: "joko-model-viewer/ack";
  readonly instanceId: string;
  readonly command: "begin" | "chunk" | "commit";
  readonly fileIndex: number;
  readonly index: number;
  readonly offset: number;
  readonly byteSize: number;
}

export type MobileModelViewerMessage = MobileModelViewerStatus | MobileModelViewerAck;

export interface MobileModelRuntimeBundle {
  readonly modelViewerVersion: string;
  readonly threeVersion: string;
  readonly script: string;
  readonly scriptSha256Hex: string;
}

export interface MobileModelViewerManifest {
  readonly byteSize: number;
  readonly sha256Hex: string;
  readonly modelKind: MobileModelPreviewKind;
  readonly modelPath: string;
  readonly files: readonly MobileModelFileDescriptor[];
  readonly references: readonly MobileModelReference[];
}

export type MobileModelViewerCommand =
  | { readonly command: "begin"; readonly manifest: MobileModelViewerManifest }
  | { readonly command: "chunk"; readonly fileIndex: number; readonly index: number;
      readonly offset: number; readonly base64: string }
  | { readonly command: "commit" }
  | { readonly command: "dispose" };

export function buildMobileModelViewerCommand(instanceId: string, command: MobileModelViewerCommand): string {
  const exactInstanceId = viewerInstanceId(instanceId);
  if (command.command === "begin") {
    assertMobileModelViewerManifest(command.manifest);
    const message = JSON.stringify({
      type: "joko-model-viewer/command",
      instanceId: exactInstanceId,
      command: "begin",
      ...command.manifest
    });
    if (message.length > mobileModelViewerLimits.maximumCommandCharacters) {
      throw new Error("The model transfer manifest exceeds the viewer protocol budget.");
    }
    return message;
  }
  if (command.command === "chunk") {
    const maximumBase64 = Math.ceil(mobileModelViewerLimits.maximumChunkBytes / 3) * 4;
    if (!Number.isSafeInteger(command.fileIndex) || command.fileIndex < 0
      || command.fileIndex >= MOBILE_MODEL_PREVIEW_MAXIMUM_FILES
      || !Number.isSafeInteger(command.index) || command.index < 0 || command.index > 262_144
      || !Number.isSafeInteger(command.offset) || command.offset < 0
      || typeof command.base64 !== "string" || command.base64.length < 4
      || command.base64.length > maximumBase64 || command.base64.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/u.test(command.base64)) {
      throw new Error("The model transfer chunk is invalid.");
    }
    return JSON.stringify({ type: "joko-model-viewer/command", instanceId: exactInstanceId,
      command: "chunk", fileIndex: command.fileIndex, index: command.index,
      offset: command.offset, base64: command.base64 });
  }
  if (command.command !== "commit" && command.command !== "dispose") {
    throw new Error("The model viewer command is invalid.");
  }
  return JSON.stringify({ type: "joko-model-viewer/command", instanceId: exactInstanceId,
    command: command.command });
}

export function parseMobileModelViewerMessage(
  data: string,
  instanceId: string
): MobileModelViewerMessage | undefined {
  if (typeof data !== "string" || data.length < 2 || data.length > 8_192) return undefined;
  const exactInstanceId = viewerInstanceId(instanceId);
  try {
    const value = JSON.parse(data) as unknown;
    if (!plainObject(value) || value["instanceId"] !== exactInstanceId) return undefined;
    if (value["type"] === "joko-model-viewer/ack") {
      if (!exactKeys(value, ["type", "instanceId", "command", "fileIndex", "index", "offset", "byteSize"])
        || !modelAckCommand(value["command"]) || !Number.isSafeInteger(value["index"])
        || (value["index"] as number) < -1 || (value["index"] as number) > 262_144
        || !Number.isSafeInteger(value["fileIndex"]) || (value["fileIndex"] as number) < -1
        || (value["fileIndex"] as number) >= MOBILE_MODEL_PREVIEW_MAXIMUM_FILES
        || !Number.isSafeInteger(value["offset"]) || (value["offset"] as number) < 0
        || (value["offset"] as number) > MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES
        || !Number.isSafeInteger(value["byteSize"]) || (value["byteSize"] as number) < 1
        || (value["byteSize"] as number) > MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES) return undefined;
      return { type: "joko-model-viewer/ack", instanceId: exactInstanceId,
        command: value["command"], fileIndex: value["fileIndex"] as number,
        index: value["index"] as number, offset: value["offset"] as number,
        byteSize: value["byteSize"] as number };
    }
    if (value["type"] !== "joko-model-viewer/status"
      || !exactKeys(value, ["type", "instanceId", "state", "fileCount", "error"])
      || !modelViewerState(value["state"])
      || !Number.isSafeInteger(value["fileCount"]) || (value["fileCount"] as number) < 0
      || (value["fileCount"] as number) > MOBILE_MODEL_PREVIEW_MAXIMUM_FILES
      || !viewerError(value["error"])) return undefined;
    return {
      type: "joko-model-viewer/status",
      instanceId: exactInstanceId,
      state: value["state"],
      fileCount: value["fileCount"] as number,
      error: value["error"]
    };
  } catch {
    return undefined;
  }
}

export function assertMobileModelViewerManifest(
  manifest: MobileModelViewerManifest
): MobileModelViewerManifest {
  if (!plainObject(manifest)
    || !exactKeys(manifest, ["byteSize", "sha256Hex", "modelKind", "modelPath", "files", "references"])
    || !Number.isSafeInteger(manifest.byteSize) || manifest.byteSize < 2
    || manifest.byteSize > MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES
    || !sha256(manifest.sha256Hex)
    || (manifest.modelKind !== "glb" && manifest.modelKind !== "gltf")
    || !safeModelPath(manifest.modelPath)
    || !Array.isArray(manifest.files) || manifest.files.length < 1
    || manifest.files.length > MOBILE_MODEL_PREVIEW_MAXIMUM_FILES
    || !Array.isArray(manifest.references)
    || manifest.references.length > MOBILE_MODEL_PREVIEW_MAXIMUM_REFERENCES) {
    throw new Error("The model transfer manifest is invalid.");
  }
  let offset = 0;
  const paths = new Set<string>();
  for (const [index, descriptor] of manifest.files.entries()) {
    if (!plainObject(descriptor as unknown)
      || !exactKeys(descriptor as unknown as Record<string, unknown>,
        ["path", "mediaType", "byteOffset", "byteSize", "sha256Hex"])
      || !safeModelPath(descriptor.path) || paths.has(descriptor.path)
      || typeof descriptor.mediaType !== "string" || descriptor.mediaType.length < 1
      || descriptor.mediaType.length > 128 || descriptor.mediaType !== descriptor.mediaType.toLowerCase()
      || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(descriptor.mediaType)
      || descriptor.byteOffset !== offset || !Number.isSafeInteger(descriptor.byteSize)
      || descriptor.byteSize < 1 || descriptor.byteSize > MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES
      || !sha256(descriptor.sha256Hex)) {
      throw new Error("The model transfer file manifest is invalid.");
    }
    if (index === 0 && (descriptor.path !== manifest.modelPath
      || mobileModelPreviewKind(descriptor.mediaType, descriptor.path) !== manifest.modelKind)) {
      throw new Error("The model transfer main-file identity is invalid.");
    }
    paths.add(descriptor.path);
    offset += descriptor.byteSize;
  }
  if (offset !== manifest.byteSize) throw new Error("The model transfer byte layout is invalid.");

  const referencedFiles = new Set<number>();
  const referenceKeys = new Set<string>();
  for (const reference of manifest.references) {
    if (!plainObject(reference as unknown)
      || !exactKeys(reference as unknown as Record<string, unknown>, ["uri", "path", "kind", "fileIndex"])
      || typeof reference.uri !== "string" || reference.uri.length < 1 || reference.uri.length > 2_048
      || reference.uri.startsWith("data:") || /[\u0000-\u001f\u007f]/u.test(reference.uri)
      || !safeModelPath(reference.path)
      || (reference.kind !== "buffer" && reference.kind !== "image")
      || !Number.isSafeInteger(reference.fileIndex) || reference.fileIndex < 1
      || reference.fileIndex >= manifest.files.length
      || manifest.files[reference.fileIndex]?.path !== reference.path) {
      throw new Error("The model transfer reference manifest is invalid.");
    }
    const mediaType = manifest.files[reference.fileIndex]!.mediaType;
    if (reference.kind === "buffer"
      ? mediaType !== "application/octet-stream" && mediaType !== "application/gltf-buffer"
      : mediaType !== "image/png" && mediaType !== "image/jpeg") {
      throw new Error("The model transfer reference type is invalid.");
    }
    const key = `${reference.kind}\u0000${reference.uri}`;
    if (referenceKeys.has(key)) throw new Error("The model transfer reference identity is duplicated.");
    referenceKeys.add(key);
    referencedFiles.add(reference.fileIndex);
  }
  for (let index = 1; index < manifest.files.length; index += 1) {
    if (!referencedFiles.has(index)) throw new Error("The model transfer contains an unreferenced dependency.");
  }
  return manifest;
}

export function buildMobileModelViewerHtml({
  instanceId,
  title,
  background,
  surface,
  ink,
  muted,
  accent,
  border
}: {
  readonly instanceId: string;
  readonly title: string;
  readonly background: string;
  readonly surface: string;
  readonly ink: string;
  readonly muted: string;
  readonly accent: string;
  readonly border: string;
}, runtime: MobileModelRuntimeBundle): string {
  const exactInstanceId = viewerInstanceId(instanceId);
  const exactTitle = boundedText(title, 512) || "3D model preview";
  assertRuntimeBundle(runtime);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; connect-src blob: data:; font-src 'none'; form-action 'none'; frame-src 'none'; img-src blob: data:; media-src blob: data:; object-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; worker-src 'none'" />
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    html, body { background: ${cssColor(background)}; color: ${cssColor(ink)}; height: 100%; margin: 0; width: 100%; }
    body { display: flex; flex-direction: column; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; overflow: hidden; }
    #toolbar { align-items: center; background: ${cssColor(surface)}; border-bottom: 1px solid ${cssColor(border)}; display: flex; flex: 0 0 auto; gap: 8px; min-height: 48px; padding: 6px 10px; }
    #status { color: ${cssColor(muted)}; flex: 1; font-size: 13px; line-height: 18px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    button { background: ${cssColor(background)}; border: 1px solid ${cssColor(border)}; border-radius: 10px; color: ${cssColor(ink)}; font: inherit; font-weight: 650; min-height: 34px; min-width: 38px; padding: 6px 10px; }
    button:focus-visible { outline: 3px solid ${cssColor(accent)}; outline-offset: 1px; }
    #stage { align-items: center; display: flex; flex: 1 1 auto; justify-content: center; min-height: 0; overflow: hidden; position: relative; touch-action: none; }
    model-viewer { background: ${cssColor(background)}; height: 100%; width: 100%; }
    #empty { color: ${cssColor(muted)}; max-width: 80%; text-align: center; }
  </style>
</head>
<body aria-label="${escapeHtml(exactTitle)}">
  <div id="toolbar" role="toolbar" aria-label="3D model preview controls">
    <span id="status" role="status" aria-live="polite">Preparing verified 3D model…</span>
    <button id="zoom-out" type="button" aria-label="Zoom 3D model out">−</button>
    <button id="reset" type="button" aria-label="Reset 3D model view">Reset</button>
    <button id="zoom-in" type="button" aria-label="Zoom 3D model in">+</button>
  </div>
  <main id="stage" aria-label="Interactive 3D model: ${escapeHtml(exactTitle)}"><span id="empty">Preparing verified 3D model…</span></main>
  <script>${runtime.script}</script>
  <script>
    (function () {
      'use strict';
      var instanceId = ${JSON.stringify(exactInstanceId)};
      var title = ${JSON.stringify(exactTitle)};
      var bytes = null;
      var manifest = null;
      var received = 0;
      var expectedChunk = 0;
      var committing = false;
      var disposed = false;
      var viewer = null;
      var viewerTimer = 0;
      var ownedUrls = [];
      var stage = document.getElementById('stage');
      var statusNode = document.getElementById('status');
      var MAX_BYTES = ${MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES};
      var MAX_CHUNK = ${mobileModelViewerLimits.maximumChunkBytes};
      var MAX_FILES = ${MOBILE_MODEL_PREVIEW_MAXIMUM_FILES};
      var MAX_REFERENCES = ${MOBILE_MODEL_PREVIEW_MAXIMUM_REFERENCES};

      function post(value) {
        if (!disposed && window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
          window.ReactNativeWebView.postMessage(JSON.stringify(value));
        }
      }
      function cleanError(value) {
        var text = String(value && value.message ? value.message : value || '3D model preview failed')
          .replace(/[\\u0000-\\u001f\\u007f]/g, ' ').trim();
        return (text || '3D model preview failed').slice(0, 512);
      }
      function emit(state, error) {
        var count = manifest && Array.isArray(manifest.files) ? manifest.files.length : 0;
        var label = state === 'ready' ? 'Ready for verified 3D model bytes'
          : state === 'receiving' ? 'Receiving verified 3D model…'
          : state === 'loading' ? 'Loading interactive 3D model…'
          : state === 'complete' ? 'Interactive 3D model ready'
          : cleanError(error);
        statusNode.textContent = label;
        statusNode.setAttribute('role', state === 'error' ? 'alert' : 'status');
        post({ type: 'joko-model-viewer/status', instanceId: instanceId,
          state: state, fileCount: count, error: state === 'error' ? cleanError(error) : null });
      }
      function ack(command, fileIndex, index, offset, byteSize) {
        post({ type: 'joko-model-viewer/ack', instanceId: instanceId, command: command,
          fileIndex: fileIndex, index: index, offset: offset, byteSize: byteSize });
      }
      function exactKeys(value, expected) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        var keys = Object.keys(value).sort(); expected = expected.slice().sort();
        return keys.length === expected.length && keys.every(function (key, index) { return key === expected[index]; });
      }
      function hash(value) { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value); }
      function safePath(value) {
        return typeof value === 'string' && value.length >= 1 && value.length <= 1024
          && value[0] !== '/' && value[value.length - 1] !== '/' && value.indexOf('\\\\') < 0
          && !/[\\u0000-\\u001f\\u007f:]/.test(value)
          && value.split('/').every(function (part) { return part && part !== '.' && part !== '..' && part.length <= 255; });
      }
      function validateManifest(value) {
        if (!Number.isSafeInteger(value.byteSize) || value.byteSize < 2 || value.byteSize > MAX_BYTES
          || !hash(value.sha256Hex) || (value.modelKind !== 'glb' && value.modelKind !== 'gltf')
          || !safePath(value.modelPath) || !Array.isArray(value.files) || value.files.length < 1
          || value.files.length > MAX_FILES || !Array.isArray(value.references)
          || value.references.length > MAX_REFERENCES) return false;
        var lowerPath = value.modelPath.toLowerCase();
        if (value.modelKind === 'glb' ? lowerPath.slice(-4) !== '.glb' : lowerPath.slice(-5) !== '.gltf') return false;
        var offset = 0; var paths = new Set(); var used = new Set(); var referenceKeys = new Set();
        for (var index = 0; index < value.files.length; index += 1) {
          var file = value.files[index];
          if (!exactKeys(file, ['path','mediaType','byteOffset','byteSize','sha256Hex'])
            || !safePath(file.path) || paths.has(file.path) || typeof file.mediaType !== 'string'
            || file.mediaType.length < 1 || file.mediaType.length > 128 || file.mediaType !== file.mediaType.toLowerCase()
            || !/^[a-z0-9!#$&^_.+-]+\\/[a-z0-9!#$&^_.+-]+$/.test(file.mediaType)
            || file.byteOffset !== offset || !Number.isSafeInteger(file.byteSize) || file.byteSize < 1
            || file.byteSize > MAX_BYTES || !hash(file.sha256Hex)) return false;
          if (index === 0 && (file.path !== value.modelPath
            || value.modelKind === 'glb' && file.mediaType !== 'model/gltf-binary'
            || value.modelKind === 'gltf' && file.mediaType !== 'model/gltf+json')) return false;
          paths.add(file.path); offset += file.byteSize;
        }
        if (offset !== value.byteSize) return false;
        for (var referenceIndex = 0; referenceIndex < value.references.length; referenceIndex += 1) {
          var reference = value.references[referenceIndex];
          if (!exactKeys(reference, ['uri','path','kind','fileIndex']) || typeof reference.uri !== 'string'
            || reference.uri.length < 1 || reference.uri.length > 2048 || reference.uri.indexOf('data:') === 0
            || /[\\u0000-\\u001f\\u007f]/.test(reference.uri) || !safePath(reference.path)
            || (reference.kind !== 'buffer' && reference.kind !== 'image')
            || !Number.isSafeInteger(reference.fileIndex) || reference.fileIndex < 1
            || reference.fileIndex >= value.files.length || value.files[reference.fileIndex].path !== reference.path) return false;
          var mediaType = value.files[reference.fileIndex].mediaType;
          if (reference.kind === 'buffer'
            ? mediaType !== 'application/octet-stream' && mediaType !== 'application/gltf-buffer'
            : mediaType !== 'image/png' && mediaType !== 'image/jpeg') return false;
          var key = reference.kind + '\\u0000' + reference.uri;
          if (referenceKeys.has(key)) return false;
          referenceKeys.add(key); used.add(reference.fileIndex);
        }
        for (var fileIndex = 1; fileIndex < value.files.length; fileIndex += 1) if (!used.has(fileIndex)) return false;
        return true;
      }
      function parseCommand(data) {
        if (typeof data !== 'string' || data.length < 2 || data.length > ${mobileModelViewerLimits.maximumCommandCharacters}) return null;
        try {
          var value = JSON.parse(data);
          if (!value || value.type !== 'joko-model-viewer/command' || value.instanceId !== instanceId) return null;
          if (value.command === 'begin' && exactKeys(value, ['type','instanceId','command','byteSize','sha256Hex','modelKind','modelPath','files','references'])
            && validateManifest(value)) return value;
          if (value.command === 'chunk' && exactKeys(value, ['type','instanceId','command','fileIndex','index','offset','base64'])
            && Number.isSafeInteger(value.fileIndex) && value.fileIndex >= 0 && value.fileIndex < MAX_FILES
            && Number.isSafeInteger(value.index) && value.index >= 0 && value.index <= 262144
            && Number.isSafeInteger(value.offset) && value.offset >= 0 && typeof value.base64 === 'string'
            && value.base64.length >= 4 && value.base64.length <= Math.ceil(MAX_CHUNK / 3) * 4
            && value.base64.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value.base64)) return value;
          if ((value.command === 'commit' || value.command === 'dispose')
            && exactKeys(value, ['type','instanceId','command'])) return value;
        } catch (_) {}
        return null;
      }
      function decodeBase64(value) {
        var binary = atob(value);
        if (binary.length < 1 || binary.length > MAX_CHUNK) throw new Error('The model chunk exceeds its byte budget.');
        var output = new Uint8Array(binary.length);
        for (var index = 0; index < binary.length; index += 1) output[index] = binary.charCodeAt(index);
        return output;
      }
      async function sha256Hex(data) {
        if (!window.crypto || !window.crypto.subtle || typeof window.crypto.subtle.digest !== 'function') {
          throw new Error('Secure model verification is unavailable.');
        }
        var digest = new Uint8Array(await window.crypto.subtle.digest('SHA-256', data));
        return Array.from(digest).map(function (value) { return value.toString(16).padStart(2, '0'); }).join('');
      }
      function clearViewer() {
        if (viewerTimer) { window.clearTimeout(viewerTimer); viewerTimer = 0; }
        if (viewer) {
          viewer.removeAttribute('autoplay'); viewer.removeAttribute('src'); viewer.remove(); viewer = null;
        }
        for (var index = 0; index < ownedUrls.length; index += 1) URL.revokeObjectURL(ownedUrls[index]);
        ownedUrls = [];
        while (stage.firstChild) stage.removeChild(stage.firstChild);
      }
      function retireBytes() { if (bytes) bytes.fill(0); bytes = null; received = 0; expectedChunk = 0; }
      function fail(error) { clearViewer(); retireBytes(); committing = false; emit('error', error); }
      function parseJson(data) {
        var text = new TextDecoder('utf-8', { fatal: true }).decode(data);
        var value = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value) || !value.asset
          || value.asset.version !== '2.0') throw new Error('The transferred glTF document is invalid.');
        return value;
      }
      function parseModel(data, kind) {
        if (kind === 'gltf') return { document: parseJson(data), tail: null };
        if (data.byteLength < 20) throw new Error('The transferred GLB is truncated.');
        var view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2
          || view.getUint32(8, true) !== data.byteLength) throw new Error('The transferred GLB header is invalid.');
        var offset = 12; var json = null; var jsonEnd = 0; var binaryCount = 0;
        while (offset < data.byteLength) {
          if (offset + 8 > data.byteLength) throw new Error('The transferred GLB chunk is truncated.');
          var length = view.getUint32(offset, true); var type = view.getUint32(offset + 4, true); var end = offset + 8 + length;
          if (length < 1 || length % 4 !== 0 || end > data.byteLength) throw new Error('The transferred GLB chunk boundary is invalid.');
          if (!json) {
            if (type !== 0x4e4f534a) throw new Error('The transferred GLB JSON chunk is not first.');
            var trimmed = end;
            while (trimmed > offset + 8 && data[trimmed - 1] === 0x20) trimmed -= 1;
            json = parseJson(data.subarray(offset + 8, trimmed)); jsonEnd = end;
          } else if (type === 0x004e4942 && binaryCount === 0) binaryCount += 1;
          else throw new Error('The transferred GLB contains unsupported chunks.');
          offset = end;
        }
        if (!json || offset !== data.byteLength) throw new Error('The transferred GLB JSON chunk is missing.');
        return { document: json, tail: data.slice(jsonEnd) };
      }
      function resourceSlots(documentValue) {
        var slots = [];
        [['buffers','buffer'], ['images','image']].forEach(function (entry) {
          var table = documentValue[entry[0]];
          if (table === undefined) return;
          if (!Array.isArray(table) || table.length > 16384) throw new Error('The transferred glTF resource table is invalid.');
          table.forEach(function (item) {
            if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('The transferred glTF resource entry is invalid.');
            if (item.uri !== undefined) slots.push({ item: item, kind: entry[1], uri: item.uri });
          });
        });
        return slots;
      }
      function createSource(packageBytes) {
        var slices = [];
        for (var index = 0; index < manifest.files.length; index += 1) {
          var file = manifest.files[index];
          slices.push(packageBytes.slice(file.byteOffset, file.byteOffset + file.byteSize));
        }
        return Promise.all(slices.map(function (slice, index) { return sha256Hex(slice).then(function (digest) {
          if (digest !== manifest.files[index].sha256Hex) throw new Error('A transferred model file failed SHA-256 verification.');
        }); })).then(function () {
          var parsed = parseModel(slices[0], manifest.modelKind);
          var references = new Map();
          manifest.references.forEach(function (reference) { references.set(reference.kind + '\\u0000' + reference.uri, reference); });
          var resourceUrls = new Map(); var seen = new Set();
          resourceSlots(parsed.document).forEach(function (slot) {
            if (typeof slot.uri !== 'string' || !slot.uri) throw new Error('The transferred glTF resource URI is invalid.');
            if (slot.uri.indexOf('data:') === 0) return;
            var key = slot.kind + '\\u0000' + slot.uri; var reference = references.get(key);
            if (!reference) throw new Error('The transferred glTF reference is not in the verified manifest.');
            var url = resourceUrls.get(reference.fileIndex);
            if (!url) {
              var descriptor = manifest.files[reference.fileIndex];
              url = URL.createObjectURL(new Blob([slices[reference.fileIndex]], { type: descriptor.mediaType }));
              ownedUrls.push(url); resourceUrls.set(reference.fileIndex, url);
            }
            slot.item.uri = url; seen.add(key);
          });
          if (seen.size !== references.size) throw new Error('The verified model reference manifest is incomplete.');
          var sourceBytes;
          if (manifest.modelKind === 'gltf') sourceBytes = new TextEncoder().encode(JSON.stringify(parsed.document));
          else {
            var json = new TextEncoder().encode(JSON.stringify(parsed.document));
            var padded = Math.ceil(json.byteLength / 4) * 4; var tail = parsed.tail || new Uint8Array(0);
            sourceBytes = new Uint8Array(20 + padded + tail.byteLength); var outputView = new DataView(sourceBytes.buffer);
            outputView.setUint32(0, 0x46546c67, true); outputView.setUint32(4, 2, true);
            outputView.setUint32(8, sourceBytes.byteLength, true); outputView.setUint32(12, padded, true);
            outputView.setUint32(16, 0x4e4f534a, true); sourceBytes.set(json, 20);
            sourceBytes.fill(0x20, 20 + json.byteLength, 20 + padded); sourceBytes.set(tail, 20 + padded);
          }
          var sourceUrl = URL.createObjectURL(new Blob([sourceBytes], { type: manifest.files[0].mediaType }));
          ownedUrls.push(sourceUrl); return sourceUrl;
        });
      }
      function installViewer(sourceUrl) {
        if (!window.customElements || !window.customElements.get('model-viewer')) throw new Error('The offline 3D runtime did not initialize.');
        while (stage.firstChild) stage.removeChild(stage.firstChild);
        viewer = document.createElement('model-viewer');
        viewer.setAttribute('src', sourceUrl); viewer.setAttribute('alt', title); viewer.setAttribute('aria-label', title);
        viewer.setAttribute('autoplay', ''); viewer.setAttribute('camera-controls', ''); viewer.setAttribute('touch-action', 'none');
        viewer.setAttribute('interaction-prompt', 'none'); viewer.setAttribute('loading', 'eager'); viewer.setAttribute('reveal', 'auto');
        viewer.setAttribute('shadow-intensity', '0.8'); viewer.setAttribute('exposure', '1'); viewer.tabIndex = 0;
        viewer.addEventListener('load', function () {
          if (disposed || !viewer) return;
          if (viewerTimer) { window.clearTimeout(viewerTimer); viewerTimer = 0; }
          emit('complete', null);
        }, { once: true });
        viewer.addEventListener('error', function () { if (!disposed) fail('The verified 3D model could not be rendered.'); }, { once: true });
        stage.appendChild(viewer);
        viewerTimer = window.setTimeout(function () { if (!disposed && viewer) fail('The verified 3D model did not finish loading.'); }, 30000);
      }
      function zoom(factor) {
        if (!viewer || typeof viewer.getCameraOrbit !== 'function') return;
        var orbit = viewer.getCameraOrbit();
        if (!orbit || !Number.isFinite(orbit.theta) || !Number.isFinite(orbit.phi)
          || !Number.isFinite(orbit.radius) || orbit.radius <= 0) return;
        var radius = Math.max(0.001, Math.min(1000000, orbit.radius * factor));
        viewer.cameraOrbit = String(orbit.theta) + 'rad ' + String(orbit.phi) + 'rad ' + String(radius) + 'm';
        if (typeof viewer.jumpCameraToGoal === 'function') viewer.jumpCameraToGoal();
      }
      function reset() {
        if (!viewer) return;
        viewer.cameraOrbit = 'auto auto auto'; viewer.cameraTarget = 'auto auto auto'; viewer.fieldOfView = 'auto';
        if (typeof viewer.resetTurntableRotation === 'function') viewer.resetTurntableRotation();
        if (typeof viewer.jumpCameraToGoal === 'function') viewer.jumpCameraToGoal();
      }
      function dispose() {
        if (disposed) return;
        disposed = true; clearViewer(); retireBytes(); manifest = null;
        window.removeEventListener('message', onMessage); document.removeEventListener('message', onMessage);
      }
      function receive(value) {
        if (value.command === 'dispose') { dispose(); return; }
        if (disposed || committing) return;
        if (value.command === 'begin') {
          if (manifest || bytes) { fail('The model transfer was started more than once.'); return; }
          manifest = { byteSize: value.byteSize, sha256Hex: value.sha256Hex, modelKind: value.modelKind,
            modelPath: value.modelPath, files: value.files, references: value.references };
          bytes = new Uint8Array(value.byteSize); received = 0; expectedChunk = 0; emit('receiving', null);
          ack('begin', -1, -1, 0, value.byteSize); return;
        }
        if (!manifest || !bytes) { fail('The model transfer is inactive.'); return; }
        if (value.command === 'chunk') {
          if (value.index !== expectedChunk || value.offset !== received) { fail('The model transfer chunk is out of order.'); return; }
          try {
            var chunk = decodeBase64(value.base64);
            var descriptor = manifest.files[value.fileIndex];
            if (!descriptor || value.offset < descriptor.byteOffset
              || value.offset >= descriptor.byteOffset + descriptor.byteSize
              || value.offset + chunk.byteLength > descriptor.byteOffset + descriptor.byteSize
              || received + chunk.byteLength > bytes.byteLength) {
              throw new Error('The model transfer chunk exceeds its declared file boundary.');
            }
            bytes.set(chunk, received); received += chunk.byteLength; expectedChunk += 1;
            ack('chunk', value.fileIndex, value.index, value.offset, chunk.byteLength);
          } catch (error) { fail(error); }
          return;
        }
        if (value.command === 'commit') {
          if (received !== bytes.byteLength) { fail('The model transfer ended before all bytes arrived.'); return; }
          committing = true; var packageBytes = bytes; bytes = null;
          void sha256Hex(packageBytes).then(function (digest) {
            if (digest !== manifest.sha256Hex) throw new Error('The model package failed SHA-256 verification.');
            return createSource(packageBytes);
          }).then(function (sourceUrl) {
            if (disposed) { clearViewer(); return; }
            emit('loading', null); installViewer(sourceUrl);
            ack('commit', -1, expectedChunk - 1, manifest.byteSize, manifest.byteSize);
          }).catch(function (error) { if (!disposed) fail(error); }).finally(function () {
            packageBytes.fill(0); committing = false; if (disposed) clearViewer();
          });
        }
      }
      function onMessage(event) { var value = parseCommand(event && event.data); if (value) receive(value); }
      document.getElementById('zoom-out').addEventListener('click', function () { zoom(1.25); });
      document.getElementById('reset').addEventListener('click', reset);
      document.getElementById('zoom-in').addEventListener('click', function () { zoom(0.8); });
      window.addEventListener('message', onMessage); document.addEventListener('message', onMessage);
      var runtime = window.jokoModelViewerRuntime;
      if (!window.ReactNativeWebView || typeof window.ReactNativeWebView.postMessage !== 'function'
        || !runtime || !runtime.ready || typeof runtime.ready.then !== 'function') {
        emit('error', 'The offline 3D runtime is unavailable.');
      } else {
        Promise.resolve(runtime.ready).then(function () {
          if (!disposed && window.customElements && window.customElements.get('model-viewer')) emit('ready', null);
          else if (!disposed) emit('error', 'The offline 3D runtime is unavailable.');
        }).catch(function (error) { if (!disposed) emit('error', error); });
      }
    })();
  </script>
</body>
</html>`;
}

export function createMobileModelViewerLifecycle(maximumReloads = 1) {
  if (!Number.isSafeInteger(maximumReloads) || maximumReloads < 0 || maximumReloads > 3) {
    throw new Error("The model viewer reload budget is invalid.");
  }
  let reloadOnActive = false;
  let reloads = 0;
  return {
    onLoadStart() {},
    onLoadEnd() {},
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

function assertRuntimeBundle(runtime: MobileModelRuntimeBundle): void {
  if (!plainObject(runtime)
    || !exactKeys(runtime, ["modelViewerVersion", "threeVersion", "script", "scriptSha256Hex"])
    || runtime.modelViewerVersion !== mobileModelViewerLimits.modelViewerVersion
    || runtime.threeVersion !== mobileModelViewerLimits.threeVersion
    || typeof runtime.script !== "string" || runtime.script.length < 100_000
    || /<\/script/iu.test(runtime.script) || !runtime.script.includes("jokoModelViewerRuntime")
    || !sha256(runtime.scriptSha256Hex)) {
    throw new Error("The offline model-viewer runtime bundle is invalid.");
  }
}

function modelAckCommand(value: unknown): value is MobileModelViewerAck["command"] {
  return value === "begin" || value === "chunk" || value === "commit";
}

function modelViewerState(value: unknown): value is MobileModelViewerState {
  return value === "ready" || value === "receiving" || value === "loading"
    || value === "complete" || value === "error";
}

function viewerError(value: unknown): value is string | null {
  return value === null || typeof value === "string" && value.length >= 1 && value.length <= 512
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function viewerInstanceId(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128
    || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("The model viewer instance identity is invalid.");
  return value;
}

function safeModelPath(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 1_024
    && !value.startsWith("/") && !value.endsWith("/") && !value.includes("\\")
    && !/[\u0000-\u001f\u007f:]/u.test(value)
    && value.split("/").every((part) => Boolean(part && part !== "." && part !== ".." && part.length <= 255));
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
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
