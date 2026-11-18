import type { MobileMarkdownInlineMark } from "./mobile-markdown";
import { repairMobileMermaidSource } from "./mobile-mermaid-repair";

export interface MobileMarkdownRichRuntime {
  readonly mermaidScript: string;
  readonly katexScript: string;
  readonly katexCss: string;
}

export interface MobileMarkdownColors {
  readonly surface: string;
  readonly background: string;
  readonly ink: string;
  readonly muted: string;
  readonly accent: string;
  readonly border: string;
  readonly negative: string;
  readonly positive?: string;
  readonly warning?: string;
}

export function mobileMarkdownScriptValue(value: string): string {
  return JSON.stringify(value).replace(/</gu, "\\u003c").replace(/\u2028/gu, "\\u2028").replace(/\u2029/gu, "\\u2029");
}

export function escapeMobileMarkdownHtml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;").replace(/'/gu, "&#39;");
}

const markTags = { strong: "strong", emphasis: "em", strikethrough: "del" } as const;
export const MOBILE_MARKDOWN_DIAGRAM_PNG_MAXIMUM_BYTES = 8 * 1024 * 1024;
export const MOBILE_MARKDOWN_DIAGRAM_PNG_MAXIMUM_SIDE = 4_096;
export const MOBILE_MARKDOWN_DIAGRAM_PNG_MAXIMUM_PIXELS = 12_000_000;
const maximumDiagramPngBase64 = Math.ceil(MOBILE_MARKDOWN_DIAGRAM_PNG_MAXIMUM_BYTES / 3) * 4;

export function wrapMobileMarkdownHtmlMarks(html: string, marks: readonly MobileMarkdownInlineMark[] | undefined): string {
  return marks?.reduceRight((inner, mark) => `<${markTags[mark]}>${inner}</${markTags[mark]}>`, html) ?? html;
}

export function buildMobileMarkdownRichHtml(input: {
  readonly instanceId: string;
  readonly kind: "math" | "mermaid";
  readonly source: string;
  readonly colors: MobileMarkdownColors;
  readonly zoomable?: boolean;
}, runtime: MobileMarkdownRichRuntime): string {
  const { background, surface, ink, muted, accent, border, negative } = input.colors;
  if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(input.instanceId) || input.source.length > 100_000
    || [background, surface, ink, muted, accent, border, negative].some((color) => !/^#[0-9a-f]{3,8}$/iu.test(color))) {
    throw new Error("The rich Markdown surface is invalid.");
  }
  const { colors, source, instanceId, kind } = input;
  const dark = Number.parseInt(colors.surface.slice(1, 3), 16) < 128;
  const repaired = kind === "mermaid" ? repairMobileMermaidSource(source) : source;
  const fillsViewport = kind === "mermaid" && input.zoomable === true;
  const render = kind === "math"
    ? `window.katex.render(source, root, { displayMode: true, throwOnError: true, trust: false, strict: 'ignore', maxExpand: 1000 }); finish('ready');`
    : `var engine = window.jokoMermaid;
      engine.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
        maxTextSize: 100000, theme: ${mobileMarkdownScriptValue(dark ? "dark" : "default")},
        gantt: { useWidth: 760 },
        ${fillsViewport ? "htmlLabels: false, flowchart: { htmlLabels: false }," : ""}
        themeVariables: { background: ${mobileMarkdownScriptValue(colors.surface)},
          primaryColor: ${mobileMarkdownScriptValue(colors.background)}, primaryTextColor: ${mobileMarkdownScriptValue(colors.ink)},
          primaryBorderColor: ${mobileMarkdownScriptValue(colors.border)}, lineColor: ${mobileMarkdownScriptValue(colors.muted)} } });
      async function drawDiagram() {
        try { return await engine.render('diagram', source); }
        catch (error) {
          if (settled || !repairedSource) throw error;
          return engine.render('diagram-repaired', repairedSource);
        }
      }
      drawDiagram().then(function(result) {
        if (settled) return; root.innerHTML = result.svg;
        root.querySelectorAll('a').forEach(function(link) { link.removeAttribute('href'); link.removeAttribute('xlink:href'); });
        root.querySelectorAll('image,script,foreignObject iframe').forEach(function(node) { node.remove(); });
        root.classList.add('diagram');
        finish('ready');
      }, function() { finish('error'); });`;
  const runtimeScript = kind === "math" ? runtime.katexScript : runtime.mermaidScript;
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=${input.zoomable ? 5 : 1}">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'">
    <style>html,body{margin:0;background:${colors.surface};color:${colors.ink};font-family:system-ui,sans-serif}
    #root{box-sizing:border-box;padding:8px;overflow-x:auto}#root svg{max-width:100%;height:auto}
    ${fillsViewport ? "#root.diagram{min-height:100vh;display:flex;align-items:center;justify-content:center}#root.diagram>svg{width:100%!important;max-width:100%!important;height:calc(100vh - 16px)!important}" : ""}
    pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 monospace;margin:0;color:${colors.muted}}
    .katex-display{margin:0}${kind === "math" ? runtime.katexCss : ""}</style></head><body>
    <div id="root"><pre>${escapeMobileMarkdownHtml(source)}</pre></div><script>
    var source=${mobileMarkdownScriptValue(source)},instanceId=${mobileMarkdownScriptValue(instanceId)};
    var repairedSource=${mobileMarkdownScriptValue(repaired === source ? "" : repaired)};
    var root=document.getElementById('root'),settled=false;
    function report(state){window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({
      type:'joko-rich-markdown/status',instanceId:instanceId,state:state,
      height:Math.max(24,Math.min(1200,Math.ceil(root.getBoundingClientRect().height)))}));}
    function finish(state){if(settled)return;settled=true;clearTimeout(timer);
      if(state==='error'){root.textContent='';var pre=document.createElement('pre');pre.textContent=source;root.appendChild(pre);}
      report(state);document.fonts && document.fonts.ready.then(function(){report(state);});}
    ${fillsViewport ? mobileMarkdownDiagramEncoder(colors.surface) : ""}
    report('source');var timer=setTimeout(function(){finish('error');},8000);
    try{var script=document.createElement('script');script.textContent=${mobileMarkdownScriptValue(runtimeScript)};
      document.head.appendChild(script);${render}}catch(error){finish('error');}
    </script></body></html>`;
}

function mobileMarkdownDiagramEncoder(surface: string): string {
  return `window.jokoExportMarkdownDiagram = function(requestId) {
    function send(base64) {
      var payload = { type: 'joko-rich-markdown/png', instanceId: instanceId, requestId: requestId };
      if (base64) payload.base64 = base64;
      if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    }
    try {
      var svg = root.classList.contains('diagram') && root.querySelector(':scope > svg');
      var bounds = svg && (svg.getAttribute('viewBox') || '').trim().split(/[\\s,]+/).map(Number);
      if (!bounds || bounds.length !== 4 || bounds.some(function(value) { return !Number.isFinite(value); })
        || bounds[2] <= 0 || bounds[3] <= 0) return send();
      var width = bounds[2], height = bounds[3];
      var scale = Math.min(3, ${MOBILE_MARKDOWN_DIAGRAM_PNG_MAXIMUM_SIDE} / width, ${MOBILE_MARKDOWN_DIAGRAM_PNG_MAXIMUM_SIDE} / height, Math.sqrt(${MOBILE_MARKDOWN_DIAGRAM_PNG_MAXIMUM_PIXELS} / (width * height)));
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(width * scale));
      canvas.height = Math.max(1, Math.floor(height * scale));
      var context = canvas.getContext('2d');
      if (!context) return send();
      var clone = svg.cloneNode(true);
      clone.removeAttribute('style');
      clone.setAttribute('width', String(canvas.width));
      clone.setAttribute('height', String(canvas.height));
      clone.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      var data = encodeURIComponent(new XMLSerializer().serializeToString(clone));
      if (!data || data.length > 6000000) return send();
      var image = new Image();
      image.onerror = function() { send(); };
      image.onload = function() {
        try {
          context.fillStyle = ${mobileMarkdownScriptValue(surface)};
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          var prefix = 'data:image/png;base64,';
          var png = canvas.toDataURL('image/png');
          send(png.startsWith(prefix) && png.length - prefix.length <= ${maximumDiagramPngBase64}
            ? png.slice(prefix.length) : undefined);
        } catch (error) { send(); }
      };
      image.src = 'data:image/svg+xml;charset=utf-8,' + data;
    } catch (error) { send(); }
  };`;
}

export function requestMobileMarkdownDiagramPngScript(requestId: string): string {
  return `window.jokoExportMarkdownDiagram && window.jokoExportMarkdownDiagram(${mobileMarkdownScriptValue(requestId)});true;`;
}

export function parseMobileMarkdownDiagramPng(raw: string, instanceId: string, requestId: string):
  { readonly base64: string } | { readonly failed: true } | undefined {
  if (raw.length > maximumDiagramPngBase64 + 512) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)
      || value.type !== "joko-rich-markdown/png" || value.instanceId !== instanceId || value.requestId !== requestId) return undefined;
    const fields = Object.keys(value);
    if (fields.length === 3) return { failed: true };
    if (fields.length === 4 && typeof value.base64 === "string" && value.base64.length > 0 && value.base64.length <= maximumDiagramPngBase64) {
      return { base64: value.base64 };
    }
  } catch { /* The renderer must provide a bounded receipt for this request. */ }
  return undefined;
}

export function parseMobileMarkdownRichStatus(raw: string, instanceId: string): {
  readonly state: "source" | "ready" | "error"; readonly height: number;
} | undefined {
  if (raw.length > 512) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "height,instanceId,state,type"
      || value.type !== "joko-rich-markdown/status" || value.instanceId !== instanceId
      || !["source", "ready", "error"].includes(String(value.state))
      || typeof value.height !== "number" || !Number.isInteger(value.height) || value.height < 24 || value.height > 1200) return undefined;
    return { state: value.state as "source" | "ready" | "error", height: value.height };
  } catch { return undefined; }
}
