import { canonicalWorkspacePath } from "./workspace-files";

// Local references stay inside the known HTML parent; unresolved URLs remain subject to the document CSP.
const RESOURCE_ATTRS_BY_TAG: Readonly<Record<string, readonly string[]>> = {
    img: ['src'],
    script: ['src'],
    link: ['href'],
    source: ['src'],
    video: ['src', 'poster'],
    audio: ['src'],
    image: ['href', 'xlink:href', 'src'],
};
export const HTML_RESOURCE_LIMIT = 32;
export const HTML_RESOURCE_MAX_BYTES = 2 * 1024 * 1024;
export const HTML_RESOURCE_TOTAL_MAX_CHARS = 8 * 1024 * 1024;
const DATA_URI_PREFIX_MAX_CHARS = 64;
export function dataUriCharsForBytes(bytes: number): number {
    if (!Number.isFinite(bytes) || bytes <= 0)
        return DATA_URI_PREFIX_MAX_CHARS;
    return Math.ceil(bytes / 3) * 4 + DATA_URI_PREFIX_MAX_CHARS;
}
export function bytesForDataUriChars(chars: number): number {
    if (!Number.isFinite(chars))
        return 0;
    const payload = Math.floor(chars) - DATA_URI_PREFIX_MAX_CHARS;
    if (payload <= 0)
        return 0;
    return Math.floor(payload / 4) * 3;
}
const RESOURCE_MIME_BY_EXT: Readonly<Record<string, string>> = {
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.wasm': 'application/wasm',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
    '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
};
export function htmlResourceMimeFor(fsPath: string): string | null {
    const dot = fsPath.lastIndexOf('.');
    if (dot < 0)
        return null;
    const lastSep = Math.max(fsPath.lastIndexOf('/'), fsPath.lastIndexOf('\\'));
    if (dot < lastSep)
        return null;
    return RESOURCE_MIME_BY_EXT[fsPath.slice(dot).toLowerCase()] ?? null;
}
export interface HtmlResourceRef {
    start: number;
    end: number;
    raw: string;
    relativePath: string;
    mimeType: string;
    fragment: string;
}
const NAMED_CHAR_REFS: Readonly<Record<string, string>> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
};
export function decodeHtmlCharRefs(value: string): string {
    if (!value.includes('&'))
        return value;
    return value.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
        if (body.startsWith('#')) {
            const hex = body[1] === 'x' || body[1] === 'X';
            const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
            if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff)
                return whole;
            if (code >= 0xd800 && code <= 0xdfff)
                return whole;
            return String.fromCodePoint(code);
        }
        return NAMED_CHAR_REFS[body] ?? whole;
    });
}
export function resolveHtmlResourcePath(baseDirectory: string, raw: string): string | null {
    const trimmed = raw.trim();
    if (!trimmed || /^[\\/]|^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('#'))
        return null;
    const pathOnly = trimmed.split(/[?#]/)[0] ?? '';
    let decoded: string;
    try { decoded = decodeURIComponent(pathOnly); } catch { decoded = pathOnly; }
    if (!decoded || /^[\\/]|^[a-z][a-z0-9+.-]*:/i.test(decoded) || /[\u0000-\u001f\u007f]/u.test(decoded))
        return null;
    const kept: string[] = [];
    for (const segment of decoded.split(/[\\/]/)) {
        if (segment === '..') return null;
        if (segment === '.' || segment === '') continue;
        kept.push(segment);
    }
    if (!kept.length) return null;
    try { return canonicalWorkspacePath([canonicalWorkspacePath(baseDirectory, true), ...kept].filter(Boolean).join('/')); }
    catch { return null; }
}
const RAW_TEXT_CONTENT_TAGS = ['script', 'style', 'textarea', 'title'] as const;
const TAG_SCAN_SKIP_TAGS = RAW_TEXT_CONTENT_TAGS;
const CSS_SCAN_SKIP_TAGS = RAW_TEXT_CONTENT_TAGS.filter((t) => t !== 'style');
function findHtmlSkippedSpans(html: string, tags: readonly string[] = RAW_TEXT_CONTENT_TAGS): Array<{
    start: number;
    end: number;
}> {
    const spans: Array<{
        start: number;
        end: number;
    }> = [];
    const openRe = tags.length ? new RegExp(`<!--|<(${tags.join('|')})\\b[^<>]*>`, 'gi') : /<!--/g;
    let open: RegExpExecArray | null;
    while ((open = openRe.exec(html)) !== null) {
        if (open[0] === '<!--') {
            const close = html.indexOf('-->', open.index + 4);
            const end = close < 0 ? html.length : close + 3;
            spans.push({ start: open.index, end }); openRe.lastIndex = end; continue;
        }
        const tag = open[1].toLowerCase();
        const bodyStart = open.index + open[0].length;
        const rest = html.slice(bodyStart);
        const rel = rest.search(new RegExp(`</${tag}(?=[\\s/>])`, 'i'));
        const bodyEnd = rel < 0 ? html.length : bodyStart + rel;
        if (bodyEnd > bodyStart)
            spans.push({ start: bodyStart, end: bodyEnd });
        openRe.lastIndex = bodyEnd;
    }
    return spans;
}
function isInsideSpans(pos: number, spans: readonly {
    start: number;
    end: number;
}[]): boolean {
    let lo = 0;
    let hi = spans.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const s = spans[mid];
        if (pos < s.start)
            hi = mid - 1;
        else if (pos >= s.end)
            lo = mid + 1;
        else
            return true;
    }
    return false;
}
function findCssUrlRefs(css: string): Array<{
    start: number;
    end: number;
    value: string;
}> {
    const out: Array<{
        start: number;
        end: number;
        value: string;
    }> = [];
    const urlRe = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi;
    let m: RegExpExecArray | null;
    while ((m = urlRe.exec(css)) !== null) {
        const value = m[1] ?? m[2] ?? m[3] ?? '';
        if (!value)
            continue;
        const at = m.index + m[0].indexOf(value);
        out.push({ start: at, end: at + value.length, value });
    }
    return out;
}
export function collectHtmlLocalResourceRefs(html: string, baseDirectory: string): HtmlResourceRef[] {
    if (!html)
        return [];
    const refs: HtmlResourceRef[] = [];
    const push = (start: number, end: number, raw: string): void => {
        const decoded = decodeHtmlCharRefs(raw);
        const relativePath = resolveHtmlResourcePath(baseDirectory, decoded);
        if (!relativePath)
            return;
        const hashAt = decoded.indexOf('#');
        const fragment = hashAt >= 0 ? decoded.slice(hashAt) : '';
        const mimeType = htmlResourceMimeFor(relativePath);
        if (!mimeType)
            return;
        refs.push({ start, end, raw, relativePath, mimeType, fragment });
    };
    const tagScanSkipSpans = findHtmlSkippedSpans(html, TAG_SCAN_SKIP_TAGS);
    const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^<>]*)>/g;
    let tag: RegExpExecArray | null;
    while ((tag = tagRe.exec(html)) !== null) {
        if (isInsideSpans(tag.index, tagScanSkipSpans))
            continue;
        const attrs = RESOURCE_ATTRS_BY_TAG[tag[1].toLowerCase()];
        const attrsText = tag[2];
        const attrsOffset = tag.index + 1 + tag[1].length;
        const attrRe = /([a-zA-Z_:][a-zA-Z0-9:._-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
        let attr: RegExpExecArray | null;
        while ((attr = attrRe.exec(attrsText)) !== null) {
            const attrName = attr[1].toLowerCase();
            const value = attr[2] ?? attr[3] ?? attr[4] ?? '';
            if (!value)
                continue;
            const valueStartOf = (): number => {
                const q = attr![2] !== undefined || attr![3] !== undefined;
                return attrsOffset + attr!.index + attr![0].length - value.length - (q ? 1 : 0);
            };
            if (attrName === 'style') {
                const styleAttrOffset = valueStartOf();
                for (const hit of findCssUrlRefs(value)) {
                    push(styleAttrOffset + hit.start, styleAttrOffset + hit.end, hit.value);
                }
                continue;
            }
            if (!attrs || !attrs.includes(attrName))
                continue;
            const valueStart = valueStartOf();
            push(valueStart, valueStart + value.length, value);
        }
    }
    const cssScanSkipSpans = findHtmlSkippedSpans(html, CSS_SCAN_SKIP_TAGS);
    const styleRe = /<style\b[^<>]*>([\s\S]*?)<\/style\s*>/gi;
    let style: RegExpExecArray | null;
    while ((style = styleRe.exec(html)) !== null) {
        if (isInsideSpans(style.index, cssScanSkipSpans))
            continue;
        const body = style[1];
        const bodyOffset = style.index + style[0].indexOf(body, style[0].indexOf('>'));
        for (const hit of findCssUrlRefs(body)) {
            push(bodyOffset + hit.start, bodyOffset + hit.end, hit.value);
        }
    }
    return refs.sort((a, b) => a.start - b.start);
}
export function applyHtmlResourceUrls(html: string, refs: readonly HtmlResourceRef[], urls: ReadonlyMap<string, string>): string {
    const pieces: string[] = []; let cursor = 0;
    for (const ref of refs) {
        const url = urls.get(ref.relativePath);
        if (!url) continue;
        pieces.push(html.slice(cursor, ref.start), url, ref.fragment.replace(/[&"'<>\\\s]/gu, (value) => encodeURIComponent(value)));
        cursor = ref.end;
    }
    pieces.push(html.slice(cursor));
    return pieces.join('');
}
export interface HtmlResourceFetchTarget {
    relativePath: string;
    mimeType: string;
    refCount: number;
}
export function planHtmlResourceFetches(refs: readonly HtmlResourceRef[]): {
    targets: HtmlResourceFetchTarget[];
    skipped: number;
} {
    const seen = new Map<string, HtmlResourceFetchTarget>();
    const targets: HtmlResourceFetchTarget[] = [];
    let skipped = 0;
    for (const ref of refs) {
        const known = seen.get(ref.relativePath);
        if (known) {
            known.refCount += 1;
            continue;
        }
        if (targets.length >= HTML_RESOURCE_LIMIT) {
            seen.set(ref.relativePath, { relativePath: ref.relativePath, mimeType: ref.mimeType, refCount: 1 });
            skipped += 1;
            continue;
        }
        const target: HtmlResourceFetchTarget = {
            relativePath: ref.relativePath,
            mimeType: ref.mimeType,
            refCount: 1,
        };
        seen.set(ref.relativePath, target);
        targets.push(target);
    }
    return { targets, skipped };
}

const FETCH_CONCURRENCY = 4;
export interface HtmlResourceFetchOutcome {
    urls: Map<string, string>;
    failed: number;
    overBudget: number;
}
export class HtmlResourceBudgetError extends Error {}
export async function fetchHtmlResourceUrls(targets: readonly HtmlResourceFetchTarget[], fetchOne: (target: HtmlResourceFetchTarget, limits: {
    baseDir: string;
    maxBytes: number;
}) => Promise<string>, options: {
    concurrency?: number;
    isCancelled?: () => boolean;
    totalBudgetChars?: number;
    perResourceMaxBytes?: number;
    baseDirectory?: string;
} = {}): Promise<HtmlResourceFetchOutcome> {
    const concurrency = Math.min(FETCH_CONCURRENCY, Math.max(1, Math.floor(options.concurrency ?? FETCH_CONCURRENCY)));
    const isCancelled = options.isCancelled ?? (() => false);
    const totalBudget = Math.min(HTML_RESOURCE_TOTAL_MAX_CHARS, Math.max(0, options.totalBudgetChars ?? HTML_RESOURCE_TOTAL_MAX_CHARS));
    const perResourceMaxBytes = Math.min(HTML_RESOURCE_MAX_BYTES, Math.max(0, options.perResourceMaxBytes ?? HTML_RESOURCE_MAX_BYTES));
    const baseDir = options.baseDirectory ?? '';
    const urls = new Map<string, string>();
    let failed = 0;
    let overBudget = 0;
    let cursor = 0;
    let reservedChars = 0;
    let inFlight = 0;
    let settleGen = 0;
    let waiters: Array<() => void> = [];
    const notifySettled = (): void => {
        settleGen += 1;
        const woken = waiters;
        waiters = [];
        for (const wake of woken)
            wake();
    };
    const waitForSettleSince = (gen: number): Promise<void> => gen !== settleGen ? Promise.resolve() : new Promise<void>((r) => { waiters.push(r); });
    let budgetExhausted = false;
    const worker = async (): Promise<void> => {
        for (;;) {
            if (isCancelled())
                return;
            const index = cursor;
            cursor += 1;
            if (index >= targets.length)
                return;
            const target = targets[index];
            const refCount = Number.isFinite(target.refCount) && target.refCount > 0
                ? target.refCount
                : 1;
            let reserveChars = 0;
            let capBytes = 0;
            for (;;) {
                if (isCancelled())
                    return;
                if (budgetExhausted)
                    break;
                const availableChars = totalBudget - reservedChars;
                capBytes = Math.min(perResourceMaxBytes, bytesForDataUriChars(Math.floor(availableChars / refCount)));
                if (capBytes > 0) {
                    reserveChars = dataUriCharsForBytes(capBytes) * refCount;
                    reservedChars += reserveChars;
                    break;
                }
                const gen = settleGen;
                if (inFlight > 0) {
                    await waitForSettleSince(gen);
                    continue;
                }
                budgetExhausted = true;
                break;
            }
            if (reserveChars === 0) {
                overBudget += 1;
                continue;
            }
            inFlight += 1;
            try {
                const dataUri = await fetchOne(target, { baseDir, maxBytes: capBytes });
                if (!dataUri) {
                    failed += 1;
                    continue;
                }
                if (isCancelled()) return;
                const inlinedChars = dataUri.length * refCount;
                if (inlinedChars > reserveChars) {
                    overBudget += 1;
                    continue;
                }
                urls.set(target.relativePath, dataUri);
                reservedChars -= reserveChars - inlinedChars;
                reserveChars = 0;
            }
            catch (error) {
                if (error instanceof HtmlResourceBudgetError) overBudget += 1;
                else failed += 1;
            }
            finally {
                inFlight -= 1;
                if (reserveChars > 0)
                    reservedChars -= reserveChars;
                notifySettled();
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
    return { urls, failed, overBudget };
}
