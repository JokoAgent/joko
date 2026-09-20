import type { MobileComposerSelection } from "./mobile-composer-document";
import type { MobileComposerRichDocument } from "./mobile-composer-rich-document";

export interface MobileComposerRichInputTheme {
  readonly background: string;
  readonly border: string;
  readonly chip: string;
  readonly focus: string;
  readonly placeholder: string;
  readonly text: string;
  readonly textSecondary: string;
}

export interface MobileComposerRichInputConfig {
  readonly accessibilityLabel: string;
  readonly document: MobileComposerRichDocument;
  readonly documentId: number;
  readonly editable: boolean;
  readonly instanceId: string;
  readonly maxHeight: number;
  readonly placeholder: string;
  readonly selection: MobileComposerSelection;
  readonly theme: MobileComposerRichInputTheme;
}

export type MobileComposerRichRuntimeConfig = Pick<MobileComposerRichInputConfig,
  "accessibilityLabel" | "editable" | "maxHeight" | "placeholder" | "theme">;

const singleLineHeight = 44;

export function mobileComposerRichJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</gu, "\\u003c")
    .replace(/>/gu, "\\u003e")
    .replace(/&/gu, "\\u0026")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
}

export function buildMobileComposerRichApplyScript(input: {
  readonly document: MobileComposerRichDocument;
  readonly documentId: number;
  readonly selection: MobileComposerSelection;
  readonly focus: boolean;
}): string {
  return `window.jokoComposer.applyDocument(${mobileComposerRichJson(input.document)},${input.documentId},${mobileComposerRichJson(input.selection)},${input.focus});`;
}

export function buildMobileComposerRichConfigScript(config: MobileComposerRichRuntimeConfig): string {
  return `window.jokoComposer.setConfig(${mobileComposerRichJson(config)});`;
}

export function buildMobileComposerRichInputHtml(config: MobileComposerRichInputConfig): string {
  const initial = mobileComposerRichJson(config);
  return `<!doctype html>
<html><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'none'; media-src 'none'; connect-src 'none'; font-src 'none'; frame-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<style>
html,body{margin:0;padding:0;background:transparent;overflow:hidden}
*{box-sizing:border-box}
#root{width:100%;min-height:${singleLineHeight}px;overflow-y:auto;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;outline:none;border:0;padding:8px 4px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:16px;line-height:22px;-webkit-text-size-adjust:100%;caret-color:var(--focus);color:var(--text);background:var(--background)}
#root:empty:before{content:attr(data-placeholder);color:var(--placeholder);pointer-events:none}
#root[aria-disabled="true"]{opacity:.62}
.occurrence{display:inline-block;max-width:92%;margin:1px 2px;padding:2px 7px;border:1px solid var(--border);border-radius:9px;background:var(--chip);color:var(--text);font-size:13px;line-height:18px;font-weight:650;vertical-align:baseline;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;-webkit-user-select:all;user-select:all}
.occurrence.quote{display:block;width:max-content;max-width:100%;margin:5px 0;padding:7px 9px;border-left:3px solid var(--focus);border-radius:8px;color:var(--text-secondary)}
.occurrence:focus{outline:2px solid var(--focus);outline-offset:1px}
</style></head><body><div id="root" role="textbox" aria-multiline="true"></div>
<script>
(() => {
  'use strict';
  const initial = ${initial};
  const root = document.getElementById('root');
  const CARET_ANCHOR = '\\u2060';
  let instanceId = initial.instanceId;
  let documentId = initial.documentId;
  let runtime = initial;
  let applying = false;
  let composing = false;
  let lastSignature = '';
  let lastHeight = -1;
  const post = (message) => {
    if (!window.ReactNativeWebView || typeof window.ReactNativeWebView.postMessage !== 'function') return;
    window.ReactNativeWebView.postMessage(JSON.stringify(Object.assign({ instanceId }, message)));
  };
  const safeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
  const applyTheme = (theme) => {
    const style = document.documentElement.style;
    style.setProperty('--background', String(theme.background || 'transparent'));
    style.setProperty('--border', String(theme.border || '#888'));
    style.setProperty('--chip', String(theme.chip || '#eee'));
    style.setProperty('--focus', String(theme.focus || '#777'));
    style.setProperty('--placeholder', String(theme.placeholder || '#777'));
    style.setProperty('--text', String(theme.text || '#111'));
    style.setProperty('--text-secondary', String(theme.textSecondary || '#555'));
  };
  const setConfig = (value) => {
    runtime = Object.assign({}, runtime, value || {});
    applyTheme(runtime.theme || {});
    root.dataset.placeholder = String(runtime.placeholder || '');
    root.setAttribute('aria-label', String(runtime.accessibilityLabel || 'Task message'));
    root.setAttribute('aria-disabled', runtime.editable ? 'false' : 'true');
    root.contentEditable = runtime.editable ? 'true' : 'false';
    const maxHeight = safeInteger(runtime.maxHeight) ? Math.max(${singleLineHeight}, Math.min(4096, runtime.maxHeight)) : 260;
    root.style.maxHeight = maxHeight + 'px';
    reportHeight();
  };
  const makeOccurrence = (node) => {
    const element = document.createElement('span');
    element.className = 'occurrence ' + String(node.kind || '') + (node.block ? ' quote' : '');
    element.contentEditable = 'false';
    element.draggable = false;
    element.tabIndex = 0;
    element.setAttribute('role', 'button');
    element.setAttribute('aria-label', String(node.accessibilityLabel || node.label || 'Structured item'));
    element.dataset.occurrenceKey = String(node.occurrenceKey || '');
    element.dataset.tokenLength = String(String(node.token || '').length);
    element.textContent = String(node.label || node.token || 'Structured item');
    return element;
  };
  const makeNodes = (node) => {
    if (!node || typeof node !== 'object') return [];
    if (node.type === 'text') return node.text ? [document.createTextNode(String(node.text))] : [];
    if (node.type !== 'occurrence') return [];
    return [makeOccurrence(node), document.createTextNode(CARET_ANCHOR)];
  };
  const render = (richDocument, nextDocumentId, selection, focusAfter) => {
    if (!richDocument || richDocument.version !== 1 || !Array.isArray(richDocument.nodes)
      || !Number.isSafeInteger(nextDocumentId) || nextDocumentId < 1) return;
    applying = true;
    composing = false;
    documentId = nextDocumentId;
    const fragment = document.createDocumentFragment();
    richDocument.nodes.forEach((node) => makeNodes(node).forEach((child) => fragment.appendChild(child)));
    while (root.firstChild) root.removeChild(root.firstChild);
    root.appendChild(fragment);
    lastSignature = JSON.stringify(readSegments());
    applying = false;
    if (selection && safeInteger(selection.start) && safeInteger(selection.end)) setSelection(selection.start, selection.end);
    if (focusAfter && runtime.editable) root.focus();
    reportHeight();
  };
  const cleanText = (node) => {
    return String(node.nodeValue || '').split(CARET_ANCHOR).join('');
  };
  const pushText = (segments, text) => {
    if (!text) return;
    const previous = segments[segments.length - 1];
    if (previous && previous.type === 'text') previous.text += text;
    else segments.push({ type: 'text', text });
  };
  const walkSegments = (parent, segments) => {
    const children = Array.from(parent.childNodes);
    children.forEach((child, index) => {
      if (child.nodeType === Node.TEXT_NODE) {
        pushText(segments, cleanText(child));
        return;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      if (child.classList.contains('occurrence')) {
        const occurrenceKey = child.dataset.occurrenceKey;
        if (occurrenceKey) segments.push({ type: 'occurrence', occurrenceKey });
        return;
      }
      if (child.tagName === 'BR') {
        pushText(segments, '\\n');
        return;
      }
      const before = segments.length;
      walkSegments(child, segments);
      if (/^(DIV|P|LI)$/.test(child.tagName) && index < children.length - 1 && segments.length >= before) {
        pushText(segments, '\\n');
      }
    });
  };
  const readSegments = () => {
    const segments = [];
    walkSegments(root, segments);
    return segments;
  };
  const logicalLength = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return cleanText(node).length;
    if (node.nodeType !== Node.ELEMENT_NODE) return 0;
    if (node.classList.contains('occurrence')) return Number(node.dataset.tokenLength) || 0;
    if (node.tagName === 'BR') return 1;
    let length = 0;
    const children = Array.from(node.childNodes);
    children.forEach((child, index) => {
      length += logicalLength(child);
      if (child.nodeType === Node.ELEMENT_NODE && /^(DIV|P|LI)$/.test(child.tagName) && index < children.length - 1) length += 1;
    });
    return length;
  };
  const prefixAt = (container, offset) => {
    let total = 0;
    let found = false;
    const visit = (parent) => {
      const children = Array.from(parent.childNodes);
      for (let index = 0; index < children.length; index += 1) {
        if (parent === container && index === offset) { found = true; return; }
        const child = children[index];
        if (child === container && child.nodeType === Node.TEXT_NODE) {
          const raw = String(child.nodeValue || '').slice(0, offset);
          total += raw.split(CARET_ANCHOR).join('').length;
          found = true;
          return;
        }
        if (child.nodeType === Node.ELEMENT_NODE && !child.classList.contains('occurrence') && child.tagName !== 'BR') {
          visit(child);
          if (found) return;
          total += 0;
          if (/^(DIV|P|LI)$/.test(child.tagName) && index < children.length - 1) total += 1;
        } else {
          total += logicalLength(child);
        }
      }
      if (parent === container) found = true;
    };
    visit(root);
    return found ? total : null;
  };
  const currentSelection = () => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
    const start = prefixAt(range.startContainer, range.startOffset);
    const end = prefixAt(range.endContainer, range.endOffset);
    if (!safeInteger(start) || !safeInteger(end)) return null;
    return { start: Math.min(start, end), end: Math.max(start, end) };
  };
  const boundaryAt = (offset) => {
    let remaining = offset;
    const visit = (parent) => {
      const children = Array.from(parent.childNodes);
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        if (child.nodeType === Node.TEXT_NODE) {
          const text = cleanText(child);
          const raw = String(child.nodeValue || '');
          const anchor = raw.startsWith(CARET_ANCHOR) ? CARET_ANCHOR.length : 0;
          if (remaining <= text.length) return { container: child, offset: Math.min(raw.length, remaining + anchor) };
          remaining -= text.length;
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        if (child.classList.contains('occurrence')) {
          const length = logicalLength(child);
          if (remaining === 0) return { container: parent, offset: index };
          if (remaining <= length) {
            const anchor = child.nextSibling;
            if (anchor && anchor.nodeType === Node.TEXT_NODE && String(anchor.nodeValue || '').startsWith(CARET_ANCHOR)) {
              return { container: anchor, offset: CARET_ANCHOR.length };
            }
            return { container: parent, offset: Math.min(children.length, index + 1) };
          }
          remaining -= length;
          continue;
        }
        if (child.tagName === 'BR') {
          if (remaining === 0) return { container: parent, offset: index };
          remaining -= 1;
          continue;
        }
        const nestedLength = logicalLength(child);
        if (remaining <= nestedLength) {
          const nested = visit(child);
          if (nested) return nested;
        } else remaining -= nestedLength;
        if (/^(DIV|P|LI)$/.test(child.tagName) && index < children.length - 1) {
          if (remaining === 0) return { container: parent, offset: index + 1 };
          remaining -= 1;
        }
      }
      return parent === root ? { container: root, offset: root.childNodes.length } : null;
    };
    return visit(root);
  };
  const setSelection = (start, end) => {
    const first = boundaryAt(Math.min(start, end));
    const last = boundaryAt(Math.max(start, end));
    const selection = window.getSelection();
    if (!first || !last || !selection) return;
    const range = document.createRange();
    try {
      range.setStart(first.container, first.offset);
      range.setEnd(last.container, last.offset);
      selection.removeAllRanges();
      selection.addRange(range);
    } catch (_) {}
  };
  const reportSelection = () => {
    if (applying || composing) return;
    const selection = currentSelection();
    if (selection) post(Object.assign({ type: 'selection', documentId }, selection));
  };
  function reportHeight() {
    const maxHeight = safeInteger(runtime.maxHeight) ? Math.max(${singleLineHeight}, Math.min(4096, runtime.maxHeight)) : 260;
    const height = Math.max(${singleLineHeight}, Math.min(maxHeight, Math.ceil(root.scrollHeight)));
    if (height === lastHeight) return;
    lastHeight = height;
    post({ type: 'height', height });
  }
  const notify = () => {
    if (applying || composing) return;
    const segments = readSegments();
    const signature = JSON.stringify(segments);
    const selection = currentSelection() || { start: 0, end: 0 };
    if (signature !== lastSignature) {
      lastSignature = signature;
      post({ type: 'change', documentId, segments, start: selection.start, end: selection.end });
    } else {
      post({ type: 'selection', documentId, start: selection.start, end: selection.end });
    }
    reportHeight();
  };
  const occurrenceRanges = () => {
    const ranges = [];
    let offset = 0;
    const visit = (parent) => {
      const children = Array.from(parent.childNodes);
      children.forEach((child, index) => {
        if (child.nodeType === Node.ELEMENT_NODE && child.classList.contains('occurrence')) {
          const length = logicalLength(child);
          ranges.push({ element: child, start: offset, end: offset + length });
          offset += length;
        } else if (child.nodeType === Node.ELEMENT_NODE && child.tagName !== 'BR') {
          visit(child);
          if (/^(DIV|P|LI)$/.test(child.tagName) && index < children.length - 1) offset += 1;
        } else offset += logicalLength(child);
      });
    };
    visit(root);
    return ranges;
  };
  const removeOccurrence = (match) => {
    const anchor = match.element.nextSibling;
    match.element.remove();
    if (anchor && anchor.nodeType === Node.TEXT_NODE && String(anchor.nodeValue || '').startsWith(CARET_ANCHOR)) {
      const remainder = String(anchor.nodeValue || '').slice(CARET_ANCHOR.length);
      if (remainder) anchor.nodeValue = remainder;
      else anchor.remove();
    }
    root.focus();
    setSelection(match.start, match.start);
    notify();
  };
  const removeOccurrenceAtCaret = (backward) => {
    const selection = currentSelection();
    if (!selection || selection.start !== selection.end) return false;
    const match = occurrenceRanges().find((range) => backward ? range.end === selection.start : range.start === selection.start);
    if (!match) return false;
    removeOccurrence(match);
    return true;
  };
  root.addEventListener('input', notify);
  root.addEventListener('compositionstart', () => { composing = true; });
  root.addEventListener('compositionend', () => { composing = false; notify(); });
  root.addEventListener('compositioncancel', () => { composing = false; notify(); });
  root.addEventListener('focus', () => post({ type: 'focus' }));
  root.addEventListener('blur', () => { if (!composing) notify(); post({ type: 'blur' }); });
  root.addEventListener('keydown', (event) => {
    if (!runtime.editable) return;
    const focusedOccurrence = event.target && event.target.closest && event.target.closest('.occurrence');
    if (event.key === 'Backspace' || event.key === 'Delete') {
      if (focusedOccurrence) {
        const match = occurrenceRanges().find((range) => range.element === focusedOccurrence);
        if (match) {
          event.preventDefault();
          removeOccurrence(match);
          return;
        }
      }
      if (removeOccurrenceAtCaret(event.key === 'Backspace')) event.preventDefault();
      return;
    }
    if (focusedOccurrence && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      post({ type: 'activate', documentId, occurrenceKey: focusedOccurrence.dataset.occurrenceKey || '' });
    }
  });
  root.addEventListener('paste', (event) => {
    if (!runtime.editable) return;
    event.preventDefault();
    const selection = currentSelection();
    if (!selection) return;
    const clipboardText = (event.clipboardData && event.clipboardData.getData('text/plain') || '').split(CARET_ANCHOR).join('');
    const text = clipboardText && clipboardText.length <= 2000000 ? clipboardText : undefined;
    post(Object.assign({ type: 'paste', documentId, start: selection.start, end: selection.end }, text === undefined ? {} : { text }));
  });
  root.addEventListener('drop', (event) => event.preventDefault());
  const placeCaretAroundOccurrence = (occurrence, clientX) => {
    const match = occurrenceRanges().find((range) => range.element === occurrence);
    if (!match) return;
    const rect = occurrence.getBoundingClientRect();
    root.focus();
    const offset = clientX < rect.left + rect.width / 2 ? match.start : match.end;
    setSelection(offset, offset);
    reportSelection();
  };
  root.addEventListener('mousedown', (event) => {
    const occurrence = event.target && event.target.closest && event.target.closest('.occurrence');
    if (!occurrence) return;
    event.preventDefault();
    placeCaretAroundOccurrence(occurrence, event.clientX);
  });
  root.addEventListener('touchstart', (event) => {
    const occurrence = event.target && event.target.closest && event.target.closest('.occurrence');
    const touch = event.touches && event.touches[0];
    if (!occurrence || !touch) return;
    event.preventDefault();
    placeCaretAroundOccurrence(occurrence, touch.clientX);
  }, { passive: false });
  root.addEventListener('dblclick', (event) => {
    const occurrence = event.target && event.target.closest && event.target.closest('.occurrence');
    if (!occurrence) return;
    event.preventDefault();
    post({ type: 'activate', documentId, occurrenceKey: occurrence.dataset.occurrenceKey || '' });
  });
  document.addEventListener('selectionchange', reportSelection);
  window.jokoComposer = {
    applyDocument(value, nextDocumentId, selection, focusAfter) { render(value, nextDocumentId, selection, focusAfter === true); },
    blur() { root.blur(); },
    focus() { if (runtime.editable) { root.focus(); const selection = currentSelection(); if (!selection) setSelection(logicalLength(root), logicalLength(root)); } },
    ping(id) { post({ type: 'pong', id: String(id || '') }); },
    setConfig(value) { setConfig(value || {}); },
  };
  setConfig(initial);
  render(initial.document, initial.documentId, initial.selection, false);
  if (typeof ResizeObserver === 'function') new ResizeObserver(reportHeight).observe(root);
  post({ type: 'ready' });
})();
</script></body></html>`;
}

export const mobileComposerRichInputHtmlTesting = { singleLineHeight };
