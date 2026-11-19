import { canonicalWorkspacePath, workspaceParentPath } from "./workspace-files";

// Top-realm hardening precedes every author script. Child browsing contexts and actual OS permissions still require native acceptance.
export const HTML_PREVIEW_CSP = [
    "default-src 'none'",
    "img-src data:",
    "media-src data:",
    "font-src data:",
    "style-src 'unsafe-inline' data:",
    "script-src 'unsafe-inline' data:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    // Engines may ignore this directive; the first script strips the top-realm constructors.
    "webrtc 'block'",
].join('; ');
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`;
const DEVICE_SURFACE_GUARD = '<script>(function(){'
    + 'var freeze=function(o,k){try{Object.defineProperty(o,k,'
    + '{value:undefined,writable:false,configurable:false});}catch(e){}};'
    + 'var both=function(k){freeze(navigator,k);'
    + 'try{freeze(Navigator.prototype,k);}catch(e){}};'
    + 'try{'
    + "['mediaDevices','getUserMedia','webkitGetUserMedia','mozGetUserMedia']"
    + '.forEach(both);'
    + "['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel']"
    + '.forEach(function(k){freeze(window,k);});'
    + "if(typeof MediaDevices!=='undefined'&&MediaDevices.prototype)"
    + "{freeze(MediaDevices.prototype,'getUserMedia');}"
    + "['HTMLIFrameElement','HTMLFrameElement','HTMLObjectElement','HTMLEmbedElement']"
    + '.forEach(function(n){try{var C=window[n];if(C&&C.prototype){'
    + "['contentWindow','contentDocument'].forEach(function(k){"
    + 'try{Object.defineProperty(C.prototype,k,'
    + '{get:function(){return null;},configurable:false});}catch(e){}});'
    + '}}catch(e){}});'
    + '}catch(e){}})();</scr' + 'ipt>';
const CSP_PROLOG = `<!doctype html>${CSP_META}${DEVICE_SURFACE_GUARD}`;
export function withHtmlPreviewCsp(html: string, navigation?: { readonly token: string; readonly fragment: string }): string {
    const navigationScript = navigation ? htmlNavigationScript(navigation.token, navigation.fragment) : "";
    // A decoded transport BOM must not precede our doctype in string-based HTML loaders.
    return `${CSP_PROLOG}${navigationScript}${html.charCodeAt(0) === 0xfeff ? html.slice(1) : html}`;
}

function htmlNavigationScript(token: string, fragment: string): string {
    const encoded = JSON.stringify([token, fragment]).replace(/</gu, "\\u003c");
    return `<script>(function(config){
        var script = document.currentScript;
        if (script) script.remove();
        var bridge = window.ReactNativeWebView;
        if (!bridge || typeof bridge.postMessage !== 'function') return;
        var post = bridge.postMessage.bind(bridge);
        var stringify = JSON.stringify;
        var path = Function.call.bind(Event.prototype.composedPath);
        var get = Function.call.bind(Element.prototype.getAttribute);
        var prevent = Function.call.bind(Event.prototype.preventDefault);
        window.addEventListener('click', function(event) {
            var nodes = path(event);
            for (var i = 0; i < nodes.length; i++) {
                var node = nodes[i];
                if (!node || node.localName !== 'a') continue;
                var href = get(node, 'href');
                if (href === null || /^\\s*#/.test(href)) return;
                prevent(event);
                var target = get(node, 'target');
                if (event.isTrusted && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
                    && (!target || /^_self$/i.test(target)) && get(node, 'download') === null && href.length <= 4096) {
                    post(stringify([config[0], href]));
                }
                return;
            }
        }, true);
        if (config[1]) window.addEventListener('load', function() { location.hash = config[1]; }, { once: true });
    })(${encoded});</script>`;
}

export function allowMobileHtmlNavigation(url: string, documentSettled: boolean): boolean {
    if (/^about:blank#/i.test(url)) return true;
    return !documentSettled && (url === '' || url === 'about:blank');
}

export interface MobileHtmlDocumentLocation {
    readonly path: string;
    readonly fragment: string;
}

export function isMobileHtmlDocumentPath(sourcePath: string, path: string): boolean {
    try {
        const directory = workspaceParentPath(sourcePath);
        return path.length <= 4096 && canonicalWorkspacePath(path) === path && /\.html?$/iu.test(path)
            && (path === sourcePath || (!directory || path.startsWith(`${directory}/`))
                && path.slice(directory ? directory.length + 1 : 0).split("/").every((name) => !name.startsWith(".") && !name.includes(":")));
    } catch { return false; }
}

export function resolveMobileHtmlDocumentLink(sourcePath: string, currentPath: string, href: string): MobileHtmlDocumentLocation | undefined {
    const link = href.trim();
    if (!link || link.length > 4096 || /^[#/?\\]|^[a-z][a-z\d+.-]*:/iu.test(link) || /[\\\u0000-\u001f\u007f]/u.test(link)
        || !isMobileHtmlDocumentPath(sourcePath, currentPath)) return undefined;
    try {
        const base = `https://html-preview.invalid/${currentPath.split("/").map(encodeURIComponent).join("/")}`;
        const url = new URL(link, base);
        if (url.origin !== "https://html-preview.invalid" || url.username || url.password) return undefined;
        const parts = url.pathname.slice(1).split("/").map(decodeURIComponent);
        if (parts.some((part) => /[/\\:\u0000-\u001f\u007f]/u.test(part))) return undefined;
        if (parts.at(-1) === "") parts[parts.length - 1] = "index.html";
        const path = parts.join("/");
        return isMobileHtmlDocumentPath(sourcePath, path) ? { path, fragment: url.hash } : undefined;
    } catch { return undefined; }
}

/** Only a native address-field submission starts a website visit. */
export function mobileHtmlWebsiteAddress(input: string): string | undefined {
    const value = input.trim();
    if (!value || value.length > 4096 || /[\s\\\u0000-\u001f\u007f]/u.test(value)) return undefined;
    const hostWithPort = /^(?:localhost|[^/?#:@]+\.[^/?#:@]+|\[[\da-f:]+\]):\d+(?:[/?#]|$)/iu.test(value);
    const explicitScheme = !hostWithPort && /^[a-z][a-z\d+.-]*:/iu.test(value);
    try {
        if (explicitScheme && !/^https?:\/\//iu.test(value)) return undefined;
        const url = new URL(explicitScheme ? value : `https://${value}`);
        if (!url.hostname || url.username || url.password) return undefined;
        if (!explicitScheme && !url.hostname.includes(".") && url.hostname !== "localhost" && !hostWithPort) return undefined;
        return url.href;
    } catch { return undefined; }
}

export function allowMobileHtmlWebsiteNavigation(url: string): boolean {
    return /^https?:\/\//iu.test(url) && mobileHtmlWebsiteAddress(url) !== undefined;
}

export function mobileFileHtmlComplete(preview: { readonly text: string; readonly byteSize: bigint; readonly startByte: bigint; readonly endByte: bigint; readonly truncated: boolean }): boolean {
    return !preview.truncated && preview.startByte === 0n && preview.endByte === preview.byteSize
        && preview.byteSize <= 2_097_152n && BigInt(new TextEncoder().encode(preview.text).byteLength) === preview.byteSize;
}
