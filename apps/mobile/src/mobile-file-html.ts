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
export function withHtmlPreviewCsp(html: string): string {
    // A decoded transport BOM must not precede our doctype in string-based HTML loaders.
    if (html.charCodeAt(0) === 0xfeff)
        return `${CSP_PROLOG}${html.slice(1)}`;
    return `${CSP_PROLOG}${html}`;
}
export function allowMobileHtmlNavigation(url: string, documentSettled: boolean): boolean {
    if (/^about:blank#/i.test(url)) return true;
    return !documentSettled && (url === '' || url === 'about:blank');
}
export function mobileFileHtmlComplete(preview: { readonly text: string; readonly byteSize: bigint; readonly startByte: bigint; readonly endByte: bigint; readonly truncated: boolean }): boolean {
    return !preview.truncated && preview.startByte === 0n && preview.endByte === preview.byteSize
        && preview.byteSize <= 2_097_152n && BigInt(new TextEncoder().encode(preview.text).byteLength) === preview.byteSize;
}
