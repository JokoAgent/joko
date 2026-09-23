import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodeHTMLAttribute } from "entities";
import { readDocumentInput, DocumentInputError } from "./input.js";
import { decodeCssText, PdfResourceError } from "./pdfText.js";

async function prepareInputPath(root: string, inPath: string): Promise<string> {
  const target = path.resolve(root, inPath);
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new PdfResourceError("PATH_NOT_ALLOWED", "PDF resource must stay within the task working directory.");
  }
  const real = await fs.realpath(target).catch(() => { throw new PdfResourceError("PATH_NOT_ALLOWED", "PDF resource is unavailable."); });
  if (real !== target) throw new PdfResourceError("PATH_NOT_ALLOWED", "PDF resource path changed or contains a link.");
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new PdfResourceError("PATH_NOT_ALLOWED", "PDF resource is not a regular file.");
  return target;
}

async function readInputFileWithinLimit(root: string, inPath: string, maxBytes: number, tooLarge: (bytes: number) => PdfResourceError, signal?: AbortSignal): Promise<Buffer> {
  try {
    return await readDocumentInput({ root, inPath, maxBytes, ...(signal ? { signal } : {}) });
  } catch (error) {
    if (error instanceof DocumentInputError && error.code === "FILE_TOO_LARGE") throw tooLarge(maxBytes + 1);
    throw error;
  }
}

const MAX_LOCAL_RESOURCE_BYTES = 8 * 1024 * 1024;
/** 一个 HTML 快照允许带入的本地资源总量。 */
const MAX_LOCAL_RESOURCE_TOTAL_BYTES = 32 * 1024 * 1024;
/** 资源展开成 data URI 后的 HTML 硬上限,防止重复引用放大主进程字符串。 */
const MAX_SNAPSHOT_HTML_BYTES = 64 * 1024 * 1024;
/** 单次 HTML 快照允许处理的本地资源引用次数,防止重复 token 拖垮主进程。 */
const MAX_LOCAL_RESOURCE_REFERENCES = 4_096;

const DEFAULT_MARGIN_INCHES = 0.4;

const LOCAL_RESOURCE_MIME_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.css': 'text/css',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

interface ResourceSnapshotContext {
  root: string;
  signal?: AbortSignal;
  totalBytes: number;
  resourceReferences: number;
  cache: Map<string, string>;
  lexicalCache: Map<string, string>;
  cssStack: Set<string>;
  directorySnapshots: Map<string, DirectorySnapshot>;
}

export interface DirectorySnapshot {
  path: string;
  realPath: string;
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

function resourceDirectoryChanged(directory: string): PdfResourceError {
  return new PdfResourceError(
    'PATH_NOT_ALLOWED',
    `HTML 快照期间资源目录发生变化: ${directory}`,
    'HTML 与相对资源不再来自同一份任务目录快照，请确认资源目录未被并发修改后重试。',
  );
}

export async function captureDirectorySnapshot(directory: string): Promise<DirectorySnapshot> {
  try {
    const [realPath, stat] = await Promise.all([
      fs.realpath(directory),
      fs.stat(directory, { bigint: true }),
    ]);
    if (!stat.isDirectory()) throw resourceDirectoryChanged(directory);
    return {
      path: directory,
      realPath,
      dev: stat.dev,
      ino: stat.ino,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
    };
  } catch (error) {
    if (error instanceof PdfResourceError) throw error;
    throw resourceDirectoryChanged(directory);
  }
}

export function sameDirectorySnapshot(left: DirectorySnapshot, right: DirectorySnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.realPath === right.realPath &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function recordDirectorySnapshot(
  context: ResourceSnapshotContext,
  directory: string,
  expected?: DirectorySnapshot,
): Promise<void> {
  context.signal?.throwIfAborted();
  const key = path.resolve(directory);
  const current = await captureDirectorySnapshot(directory);
  if (expected && !sameDirectorySnapshot(expected, current)) {
    throw resourceDirectoryChanged(directory);
  }
  const previous = context.directorySnapshots.get(key);
  if (previous && !sameDirectorySnapshot(previous, current)) {
    throw resourceDirectoryChanged(directory);
  }
  context.directorySnapshots.set(key, current);
}

async function verifyDirectorySnapshots(context: ResourceSnapshotContext): Promise<void> {
  for (const snapshot of context.directorySnapshots.values()) {
    context.signal?.throwIfAborted();
    const current = await captureDirectorySnapshot(snapshot.path);
    if (!sameDirectorySnapshot(snapshot, current)) {
      throw resourceDirectoryChanged(snapshot.path);
    }
  }
}

function dataUri(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

function isLocalResourceReference(reference: string): boolean {
  const value = reference.trim();
  if (!value || value.startsWith('#') || value.startsWith('//')) return false;
  try {
    return new URL(value).protocol === '';
  } catch {
    return !/^[a-z][a-z\d+.-]*:/i.test(value);
  }
}

function assertNotExplicitFileUrl(reference: string): void {
  const value = reference.trim();
  if (!value) return;
  try {
    if (new URL(value).protocol !== 'file:') return;
  } catch {
    return;
  }
  throw new PdfResourceError(
    'PATH_NOT_ALLOWED',
    `HTML 不允许显式 file: URL: ${reference}`,
    '请改用任务工作目录内的相对路径或 data URI。',
  );
}

function assertNotBlockedRemoteUrl(reference: string): void {
  const value = reference.trim();
  if (!value) return;
  if (value.startsWith('//')) {
    throw new PdfResourceError(
      'PATH_NOT_ALLOWED',
      `HTML 不允许公网资源 URL: ${reference}`,
      '渲染器会阻断 http(s) 请求。请先把图片、字体或样式表放进任务工作目录，或改成 data URI。',
    );
  }
  let protocol = '';
  try {
    protocol = new URL(value).protocol;
  } catch {
    return;
  }
  if (protocol !== 'http:' && protocol !== 'https:') return;
  throw new PdfResourceError(
    'PATH_NOT_ALLOWED',
    `HTML 不允许公网资源 URL: ${reference}`,
    '渲染器会阻断 http(s) 请求。请先把图片、字体或样式表放进任务工作目录，或改成 data URI。',
  );
}

function resolveLocalResourcePath(baseUrl: URL, reference: string): string | undefined {
  let resolved: URL;
  try {
    resolved = new URL(reference.trim(), baseUrl);
  } catch {
    throw new PdfResourceError(
      'PATH_NOT_ALLOWED',
      `本地资源 URL 无法解码: ${reference}`,
      '请把图片、字体或样式表改成有效的相对路径或 data URI。',
    );
  }
  if (resolved.protocol !== 'file:') return undefined;
  resolved.hash = '';
  resolved.search = '';
  try {
    return fileURLToPath(resolved);
  } catch {
    throw new PdfResourceError(
      'PATH_NOT_ALLOWED',
      `本地资源 URL 无法解析: ${reference}`,
      '请把图片、字体或样式表改成有效的相对路径或 data URI。',
    );
  }
}

function resourceMime(absPath: string): string {
  return (
    LOCAL_RESOURCE_MIME_TYPES[path.extname(absPath).toLowerCase()] ?? 'application/octet-stream'
  );
}

function assertSnapshotHtmlSize(bytes: number): void {
  if (bytes > MAX_SNAPSHOT_HTML_BYTES) {
    throw new PdfResourceError(
      'FILE_TOO_LARGE',
      'HTML 引用的本地资源展开后过大',
      '这份 HTML 的本地资源在转换成 data URI 后超过 64 MB。请减少重复引用、压缩资源或拆分文档后重试。',
    );
  }
}

async function replaceAsync(
  input: string,
  pattern: RegExp,
  replacer: (match: string, ...groups: string[]) => Promise<string>,
): Promise<string> {
  const matches = Array.from(input.matchAll(pattern));
  if (matches.length === 0) return input;
  const parts: string[] = [];
  let outputBytes = 0;
  const pushPart = (part: string): void => {
    outputBytes += Buffer.byteLength(part, 'utf8');
    assertSnapshotHtmlSize(outputBytes);
    parts.push(part);
  };
  let cursor = 0;
  for (const match of matches) {
    const index = match.index ?? 0;
    pushPart(input.slice(cursor, index));
    pushPart(await replacer(match[0]!, ...match.slice(1).map((group) => group ?? '')));
    cursor = index + match[0]!.length;
  }
  pushPart(input.slice(cursor));
  return parts.join('');
}

function findHtmlTagEnd(input: string, start: number): number {
  let quote: string | undefined;
  for (let end = start + 1; end < input.length; end += 1) {
    const ch = input[end]!;
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return end;
  }
  return -1;
}

const HTML_RAW_TEXT_TAGS = new Set([
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
]);

function findTemplateSubtreeEnd(input: string, contentStart: number): number {
  let depth = 1;
  let index = contentStart;
  while (index < input.length) {
    const start = input.indexOf('<', index);
    if (start < 0) return input.length;
    if (input.startsWith('<!--', start)) {
      const endComment = input.indexOf('-->', start + 4);
      index = endComment < 0 ? input.length : endComment + 3;
      continue;
    }
    const end = findHtmlTagEnd(input, start);
    if (end < 0) return input.length;
    const tag = input.slice(start, end + 1);
    const rawText = tag.match(/^<\s*([A-Za-z][\w:-]*)\b/i);
    if (rawText && HTML_RAW_TEXT_TAGS.has(rawText[1]!.toLowerCase())) {
      const closing = new RegExp(`<\\/\\s*${rawText[1]}\\s*>`, 'ig');
      closing.lastIndex = end + 1;
      const closingMatch = closing.exec(input);
      index = closingMatch ? closingMatch.index + closingMatch[0].length : input.length;
      continue;
    }
    if (/^<\s*template\b/i.test(tag) && !/\/\s*>$/.test(tag)) depth += 1;
    else if (/^<\s*\/\s*template\s*>/i.test(tag)) {
      depth -= 1;
      if (depth === 0) return end + 1;
    }
    index = end + 1;
  }
  return input.length;
}

/** HTML tag scanner that does not terminate on `>` inside a quoted attribute. */
async function replaceHtmlTagsAsync(
  input: string,
  predicate: (tag: string) => boolean,
  replacer: (tag: string) => Promise<string>,
): Promise<string> {
  const parts: string[] = [];
  let outputBytes = 0;
  const pushPart = (part: string): void => {
    outputBytes += Buffer.byteLength(part, 'utf8');
    assertSnapshotHtmlSize(outputBytes);
    parts.push(part);
  };
  let cursor = 0;
  let index = 0;
  while (index < input.length) {
    const start = input.indexOf('<', index);
    if (start < 0) break;
    if (input.startsWith('<!--', start)) {
      const endComment = input.indexOf('-->', start + 4);
      index = endComment < 0 ? input.length : endComment + 3;
      continue;
    }
    const end = findHtmlTagEnd(input, start);
    if (end < 0) break;
    const tag = input.slice(start, end + 1);
    if (/^<\s*template\b/i.test(tag) && !/\/\s*>$/.test(tag)) {
      index = findTemplateSubtreeEnd(input, end + 1);
      continue;
    }
    const rawTextMatch = tag.match(/^<\s*([A-Za-z][\w:-]*)\b/i);
    if (rawTextMatch && HTML_RAW_TEXT_TAGS.has(rawTextMatch[1]!.toLowerCase())) {
      if (predicate(tag)) {
        pushPart(input.slice(cursor, start));
        pushPart(await replacer(tag));
        cursor = end + 1;
      }
      const name = rawTextMatch[1]!;
      const closing = new RegExp(`<\\/\\s*${name}\\s*>`, 'ig');
      closing.lastIndex = end + 1;
      const closingMatch = closing.exec(input);
      index = closingMatch ? closingMatch.index + closingMatch[0].length : input.length;
      continue;
    }
    if (predicate(tag)) {
      pushPart(input.slice(cursor, start));
      pushPart(await replacer(tag));
      cursor = end + 1;
    }
    index = end + 1;
  }
  pushPart(input.slice(cursor));
  return parts.join('');
}

async function inlineCssImports(
  css: string,
  baseUrl: URL,
  context: ResourceSnapshotContext,
): Promise<string> {
  return rewriteCssResources(css, baseUrl, context);
}

async function inlineCssUrls(
  css: string,
  baseUrl: URL,
  context: ResourceSnapshotContext,
  decodeReference: (reference: string) => string = (reference) => reference,
): Promise<string> {
  return rewriteCssResources(css, baseUrl, context, decodeReference);
}

function isCssHexDigit(value: string | undefined): boolean {
  return value !== undefined && /^[\da-f]$/i.test(value);
}

function isCssWhitespace(value: string | undefined): boolean {
  return value === ' ' || value === '\t' || value === '\r' || value === '\n' || value === '\f';
}

function skipCssWhitespaceAndComments(css: string, start: number): number {
  let cursor = start;
  while (cursor < css.length) {
    while (isCssWhitespace(css[cursor])) cursor += 1;
    if (!css.startsWith('/*', cursor)) break;
    const end = css.indexOf('*/', cursor + 2);
    cursor = end < 0 ? css.length : end + 2;
  }
  return cursor;
}

function isCssIdentifierContinuation(value: string | undefined): boolean {
  if (value === undefined) return false;
  const codePoint = value.codePointAt(0)!;
  return (
    value === '-' ||
    value === '_' ||
    value === '\\' ||
    /^[a-z\d]$/i.test(value) ||
    codePoint >= 0x80
  );
}

function cssEscapeEnd(value: string, start: number): number {
  const next = value[start + 1];
  if (next === undefined) return start + 1;
  if (next === '\r' && value[start + 2] === '\n') return start + 3;
  if (next === '\r' || next === '\n' || next === '\f') return start + 2;
  if (!isCssHexDigit(next)) return start + 2;
  let end = start + 1;
  let digits = 0;
  while (digits < 6 && isCssHexDigit(value[end])) {
    end += 1;
    digits += 1;
  }
  if (value[end] === '\r' && value[end + 1] === '\n') return end + 2;
  if (isCssWhitespace(value[end])) return end + 1;
  return end;
}

/** Decode CSS escapes after the containing HTML attribute has been decoded. */
function decodeCssResourceReference(value: string): string {
  let decoded = '';
  let index = 0;
  while (index < value.length) {
    if (value[index] !== '\\') {
      decoded += value[index]!;
      index += 1;
      continue;
    }
    const escapeEnd = cssEscapeEnd(value, index);
    const escaped = value.slice(index + 1, escapeEnd);
    if (escaped === '\n' || escaped === '\r' || escaped === '\f' || escaped === '\r\n') {
      index = escapeEnd;
      continue;
    }
    const hex = escaped.match(/^[\da-f]{1,6}/i)?.[0];
    if (hex) {
      const codePoint = Number.parseInt(hex, 16);
      decoded +=
        codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)
          ? '\ufffd'
          : String.fromCodePoint(codePoint);
    } else if (escaped.length > 0) {
      decoded += escaped[0]!;
    } else {
      decoded += '\ufffd';
    }
    index = escapeEnd;
  }
  return decoded;
}

function parseCssIdentifier(css: string, index: number): { value: string; end: number } | null {
  let value = '';
  let cursor = index;
  while (isCssIdentifierContinuation(css[cursor])) {
    if (css[cursor] === '\\') {
      const end = cssEscapeEnd(css, cursor);
      value += decodeCssResourceReference(css.slice(cursor, end));
      cursor = end;
    } else {
      value += css[cursor]!;
      cursor += 1;
    }
  }
  return cursor > index ? { value, end: cursor } : null;
}

function parseCssUrlToken(
  css: string,
  index: number,
): { reference: string; end: number } | null {
  if (isCssIdentifierContinuation(css[index - 1])) return null;
  const identifier = parseCssIdentifier(css, index);
  if (identifier?.value.toLowerCase() !== 'url') return null;
  const open = skipCssWhitespaceAndComments(css, identifier.end);
  if (css[open] !== '(') return null;
  let cursor = open + 1;
  cursor = skipCssWhitespaceAndComments(css, cursor);
  let reference = '';
  if (css[cursor] === '"' || css[cursor] === "'") {
    const quote = css[cursor]!;
    cursor += 1;
    const start = cursor;
    while (cursor < css.length && css[cursor] !== quote) {
      if (css[cursor] === '\\') cursor = cssEscapeEnd(css, cursor);
      else cursor += 1;
    }
    reference = css.slice(start, cursor);
    cursor += 1;
  } else {
    const start = cursor;
    while (cursor < css.length && css[cursor] !== ')') {
      if (css[cursor] === '\\') cursor = cssEscapeEnd(css, cursor);
      else cursor += 1;
    }
    reference = css.slice(start, cursor).trim();
  }
  while (isCssWhitespace(css[cursor])) cursor += 1;
  return css[cursor] === ')' ? { reference, end: cursor + 1 } : null;
}

async function rewriteCssResources(
  css: string,
  baseUrl: URL,
  context: ResourceSnapshotContext,
  decodeReference: (reference: string) => string = (reference) => reference,
): Promise<string> {
  const out: string[] = [];
  let index = 0;
  while (index < css.length) {
    if (css.startsWith('/*', index)) {
      const end = css.indexOf('*/', index + 2);
      const stop = end < 0 ? css.length : end + 2;
      out.push(css.slice(index, stop));
      index = stop;
      continue;
    }
    const current = css[index]!;
    if (current === '"' || current === "'") {
      const quote = current;
      let end = index + 1;
      while (end < css.length) {
        if (css[end] === '\\') end = cssEscapeEnd(css, end);
        else if (css[end] === quote) {
          end += 1;
          break;
        } else end += 1;
      }
      out.push(css.slice(index, end));
      index = end;
      continue;
    }
    const importMatch = css.slice(index).match(/^@import\b/i);
    if (importMatch) {
      let cursor = index + importMatch[0].length;
      cursor = skipCssWhitespaceAndComments(css, cursor);
      if (css[cursor] === '"' || css[cursor] === "'") {
        const quote = css[cursor]!;
        const start = cursor;
        cursor += 1;
        while (cursor < css.length && css[cursor] !== quote) {
          if (css[cursor] === '\\') cursor = cssEscapeEnd(css, cursor);
          else cursor += 1;
        }
        const reference = css.slice(start + 1, cursor);
        const snapshot = await snapshotLocalResource(
          context,
          baseUrl,
          decodeCssResourceReference(decodeReference(reference.trim())),
          'text/css',
        );
        out.push(css.slice(index, start));
        out.push(snapshot ? `url("${snapshot}")` : css.slice(start, cursor + 1));
        index = Math.min(css.length, cursor + 1);
        continue;
      }
      const importUrl = parseCssUrlToken(css, cursor);
      if (importUrl) {
        const snapshot = await snapshotLocalResource(
          context,
          baseUrl,
          decodeCssResourceReference(decodeReference(importUrl.reference)),
          'text/css',
        );
        out.push(css.slice(index, cursor));
        out.push(snapshot ? `url("${snapshot}")` : css.slice(cursor, importUrl.end));
        index = importUrl.end;
        continue;
      }
    }
    const urlToken = parseCssUrlToken(css, index);
    if (urlToken) {
      const original = css.slice(index, urlToken.end);
      const snapshot = await snapshotLocalResource(
        context,
        baseUrl,
        decodeCssResourceReference(decodeReference(urlToken.reference)),
      );
      out.push(snapshot ? `url("${snapshot}")` : original);
      index = urlToken.end;
      continue;
    }
    out.push(current);
    index += 1;
  }
  const rewritten = out.join('');
  assertSnapshotHtmlSize(Buffer.byteLength(rewritten, 'utf8'));
  return rewritten;
}

function splitSrcset(value: string): string[] {
  const candidates: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length - 1; index += 1) {
    if (value[index] !== ',') continue;
    const segment = value.slice(start, index).trimStart();
    const insideDataUrl = /^data:/i.test(segment) && !/\s/.test(segment);
    if (insideDataUrl) continue;
    candidates.push(value.slice(start, index));
    start = index + 1;
  }
  candidates.push(value.slice(start));
  return candidates.map((candidate) => candidate.trim()).filter(Boolean);
}

/**
 * Read the small subset of HTML attributes whose values may point at local
 * task resources.  HTML permits these values to be either quoted or
 * unquoted; keeping one parser for both forms prevents the resource policy
 * from silently dropping valid markup such as `<img src=./chart.png>`.
 */
const HTML_ATTRIBUTE_PATTERN =
  /(\s+)([A-Za-z_:][\w:.-]*)(\s*=\s*)(?:(['"])([\s\S]*?)\4|([^\s"'=<>\x60]+))/gi;

function readHtmlAttribute(tag: string, attributeName: string): string | undefined {
  const wanted = attributeName.toLowerCase();
  for (const match of tag.matchAll(HTML_ATTRIBUTE_PATTERN)) {
    if (match[2]!.toLowerCase() !== wanted) continue;
    return match[4] ? match[5] : match[6];
  }
  return undefined;
}

async function rewriteHtmlAttributes(
  tag: string,
  attributeNames: readonly string[],
  replacer: (value: string, attributeName: string) => Promise<string>,
): Promise<string> {
  const wanted = new Set(attributeNames.map((name) => name.toLowerCase()));
  return replaceAsync(
    tag,
    HTML_ATTRIBUTE_PATTERN,
    async (match, leading, attributeName, equals, quote, quoted, bare) => {
      const normalizedName = attributeName.toLowerCase();
      if (!wanted.has(normalizedName)) return match;
      const value = quote ? quoted : bare;
      const rewritten = await replacer(value, normalizedName);
      if (rewritten === value) return match;
      if (quote) {
        const escaped = rewritten
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(quote === '"' ? /"/g : /'/g, quote === '"' ? '&quot;' : '&#39;');
        return `${leading}${attributeName}${equals}${quote}${escaped}${quote}`;
      }
      if (/^[^\s"'=<>\x60]+$/.test(rewritten)) {
        return `${leading}${attributeName}${equals}${rewritten}`;
      }
      const escaped = rewritten
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/"/g, '&quot;');
      return `${leading}${attributeName}${equals}"${escaped}"`;
    },
  );
}

async function inlineSrcset(
  value: string,
  baseUrl: URL,
  context: ResourceSnapshotContext,
): Promise<string> {
  const candidates = splitSrcset(value);
  const rewritten = await Promise.all(
    candidates.map(async (candidate) => {
      const match = candidate.match(/^(\S+)(?:\s+(.+))?$/);
      if (!match) return candidate;
      const snapshot = await snapshotLocalResource(
        context,
        baseUrl,
        decodeHTMLAttribute(match[1]!),
      );
      return `${snapshot ?? match[1]}${match[2] ? ` ${match[2]}` : ''}`;
    }),
  );
  return rewritten.join(', ');
}

async function rewriteHtmlStyleElementsAsync(
  input: string,
  baseUrl: URL,
  context: ResourceSnapshotContext,
): Promise<string> {
  const parts: string[] = [];
  let cursor = 0;
  let index = 0;
  let outputBytes = 0;
  const push = (part: string): void => {
    outputBytes += Buffer.byteLength(part, 'utf8');
    assertSnapshotHtmlSize(outputBytes);
    parts.push(part);
  };
  while (index < input.length) {
    const start = input.indexOf('<', index);
    if (start < 0) break;
    if (input.startsWith('<!--', start)) {
      const endComment = input.indexOf('-->', start + 4);
      index = endComment < 0 ? input.length : endComment + 3;
      continue;
    }
    const end = findHtmlTagEnd(input, start);
    if (end < 0) break;
    const tag = input.slice(start, end + 1);
    if (/^<\s*template\b/i.test(tag) && !/\/\s*>$/.test(tag)) {
      index = findTemplateSubtreeEnd(input, end + 1);
      continue;
    }
    const opening = /^<\s*style\b/i.test(tag) && !/^<\s*\/style\b/i.test(tag);
    if (!opening) {
      const raw = tag.match(/^<\s*([A-Za-z][\w:-]*)\b/i);
      if (raw && HTML_RAW_TEXT_TAGS.has(raw[1]!.toLowerCase())) {
        const closing = new RegExp(`<\\/\\s*${raw[1]}\\s*>`, 'ig');
        closing.lastIndex = end + 1;
        const closingMatch = closing.exec(input);
        index = closingMatch ? closingMatch.index + closingMatch[0].length : input.length;
        continue;
      }
      index = end + 1;
      continue;
    }
    const closing = /<\/\s*style\s*>/gi;
    closing.lastIndex = end + 1;
    const closingMatch = closing.exec(input);
    if (!closingMatch) break;
    push(input.slice(cursor, start));
    push(tag);
    const css = input.slice(end + 1, closingMatch.index);
    const imported = await inlineCssImports(css, baseUrl, context);
    push(await inlineCssUrls(imported, baseUrl, context));
    push(closingMatch[0]);
    cursor = closingMatch.index + closingMatch[0].length;
    index = cursor;
  }
  push(input.slice(cursor));
  return parts.join('');
}

async function snapshotLocalResource(
  context: ResourceSnapshotContext,
  baseUrl: URL,
  reference: string,
  mimeOverride?: string,
): Promise<string | undefined> {
  context.signal?.throwIfAborted();
  assertNotExplicitFileUrl(reference);
  assertNotBlockedRemoteUrl(reference);
  if (!isLocalResourceReference(reference)) return undefined;
  let fragment = '';
  try {
    fragment = new URL(reference.trim(), baseUrl).hash;
  } catch {
    // resolveLocalResourcePath below returns the user-facing validation error.
  }
  const absPath = resolveLocalResourcePath(baseUrl, reference);
  if (!absPath) return undefined;
  context.resourceReferences += 1;
  if (context.resourceReferences > MAX_LOCAL_RESOURCE_REFERENCES) {
    throw new PdfResourceError(
      'FILE_TOO_LARGE',
      'HTML 引用的本地资源次数过多',
      `这份 HTML 的本地图片、字体和样式表引用超过 ${MAX_LOCAL_RESOURCE_REFERENCES} 次。请减少重复引用或改用 data URI。`,
    );
  }
  const lexicalCacheKey = `${path.resolve(absPath)}\0${mimeOverride ?? ''}`;
  const lexicalCached = context.lexicalCache.get(lexicalCacheKey);
  if (lexicalCached) return `${lexicalCached}${fragment}`;
  const preparedPath = await prepareInputPath(context.root, absPath);
  const cacheKey = `${path.resolve(preparedPath)}\0${mimeOverride ?? ''}`;
  const cached = context.cache.get(cacheKey);
  if (cached) return `${cached}${fragment}`;

  const resourceDirectory = path.dirname(preparedPath);
  const beforeDirectory = await captureDirectorySnapshot(resourceDirectory);
  await recordDirectorySnapshot(context, resourceDirectory, beforeDirectory);

  const bytes = await readInputFileWithinLimit(
    context.root,
    preparedPath,
    MAX_LOCAL_RESOURCE_BYTES,
    (size) =>
      new PdfResourceError(
        'FILE_TOO_LARGE',
        `本地资源过大: ${preparedPath}`,
        `这份本地资源有 ${(size / 1024 / 1024).toFixed(1)} MB,超过单个资源上限(8 MB)。请压缩或改成更小的 data URI。`,
      ),
    context.signal,
  );
  const afterDirectory = await captureDirectorySnapshot(resourceDirectory);
  if (!sameDirectorySnapshot(beforeDirectory, afterDirectory)) {
    throw resourceDirectoryChanged(resourceDirectory);
  }
  context.totalBytes += bytes.byteLength;
  if (context.totalBytes > MAX_LOCAL_RESOURCE_TOTAL_BYTES) {
    throw new PdfResourceError(
      'FILE_TOO_LARGE',
      'HTML 引用的本地资源总量过大',
      '这份 HTML 引用的本地图片、字体和样式表总量超过 32 MB。请压缩资源或拆分文档后重试。',
    );
  }

  const mime = mimeOverride ?? resourceMime(preparedPath);
  let snapshotBytes = bytes;
  if (mime === 'text/css') {
    const decodedCss = decodeCssText(bytes);
    if (context.cssStack.has(cacheKey)) {
      return dataUri(mime, Buffer.from(decodedCss, 'utf8'));
    }
    context.cssStack.add(cacheKey);
    try {
      const imported = await inlineCssImports(decodedCss, pathToFileURL(preparedPath), context);
      const rewritten = await inlineCssUrls(imported, pathToFileURL(preparedPath), context);
      snapshotBytes = Buffer.from(rewritten, 'utf8');
    } finally {
      context.cssStack.delete(cacheKey);
    }
  }
  const snapshot = dataUri(mime, snapshotBytes);
  context.cache.set(cacheKey, snapshot);
  context.lexicalCache.set(lexicalCacheKey, snapshot);
  return `${snapshot}${fragment}`;
}

export async function inlineLocalResources(
  root: string,
  sourcePath: string,
  html: string,
  expectedSourceDirectory?: DirectorySnapshot,
  initialDirectorySnapshots?: Map<string, DirectorySnapshot>,
  signal?: AbortSignal,
): Promise<string> {
  const context: ResourceSnapshotContext = {
    root,
    ...(signal ? { signal } : {}),
    totalBytes: 0,
    resourceReferences: 0,
    cache: new Map(),
    lexicalCache: new Map(),
    cssStack: new Set(),
    directorySnapshots: new Map(initialDirectorySnapshots),
  };
  await recordDirectorySnapshot(
    context,
    path.dirname(sourcePath),
    expectedSourceDirectory
      ? { ...expectedSourceDirectory, path: path.dirname(sourcePath) }
      : undefined,
  );
  const documentUrl = pathToFileURL(sourcePath);
  let baseUrl = documentUrl;
  let baseTag: string | undefined;
  await replaceHtmlTagsAsync(
    html,
    (tag) => /^<base\b/i.test(tag),
    async (tag) => {
      baseTag ??= tag;
      return tag;
    },
  );
  const rawBaseHref = baseTag ? readHtmlAttribute(baseTag, 'href') : undefined;
  const baseHref = rawBaseHref ? decodeHTMLAttribute(rawBaseHref) : undefined;
  if (baseHref) {
    assertNotExplicitFileUrl(baseHref);
    assertNotBlockedRemoteUrl(baseHref);
    try {
      baseUrl = new URL(baseHref, documentUrl);
    } catch {
      throw new PdfResourceError(
        'PATH_NOT_ALLOWED',
        `HTML 的 base href 无法解析: ${baseHref}`,
        '请把 <base href> 改成有效的本地相对路径。',
      );
    }
  }
  let rewritten = await replaceHtmlTagsAsync(
    html,
    (tag) => /^<link\b/i.test(tag),
    async (tag) => {
      const href = readHtmlAttribute(tag, 'href');
      if (!href) return tag;
      assertNotBlockedRemoteUrl(decodeHTMLAttribute(href));
      const rel = decodeHTMLAttribute(readHtmlAttribute(tag, 'rel') ?? '');
      const isStylesheet = rel
        .split(/\s+/)
        .some((token) => token.toLowerCase() === 'stylesheet');
      if (!isStylesheet && !/\.css(?:[?#]|$)/i.test(href)) return tag;
      return rewriteHtmlAttributes(tag, ['href'], async (reference) => {
        return (
          (await snapshotLocalResource(
            context,
            baseUrl,
            decodeHTMLAttribute(reference),
            'text/css',
          )) ?? reference
        );
      });
    },
  );
  rewritten = await replaceHtmlTagsAsync(
    rewritten,
    (tag) => /^<(?:img|source|audio|video|track|object|input|image|use)\b/i.test(tag),
    async (tag) => {
      const withSources = await rewriteHtmlAttributes(
        tag,
        ['src', 'poster', 'data', 'href', 'xlink:href'],
        async (reference) =>
          (await snapshotLocalResource(context, baseUrl, decodeHTMLAttribute(reference))) ??
          reference,
      );
      return rewriteHtmlAttributes(withSources, ['srcset'], async (value) =>
        inlineSrcset(value, baseUrl, context),
      );
    },
  );
  rewritten = await rewriteHtmlStyleElementsAsync(rewritten, baseUrl, context);
  const result = await replaceHtmlTagsAsync(
    rewritten,
    (tag) => tag[1] !== '/' && /\bstyle\s*=/i.test(tag),
    (tag) =>
      rewriteHtmlAttributes(tag, ['style'], async (css) => {
        const rewrittenCss = await inlineCssUrls(decodeHTMLAttribute(css), baseUrl, context);
        return rewrittenCss;
      }),
  );
  await verifyDirectorySnapshots(context);
  return result;
}
