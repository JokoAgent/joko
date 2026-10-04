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
}

export function mobileMarkdownScriptValue(value: string): string {
  return JSON.stringify(value).replace(/</gu, "\\u003c").replace(/\u2028/gu, "\\u2028").replace(/\u2029/gu, "\\u2029");
}

export function escapeMobileMarkdownHtml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;").replace(/'/gu, "&#39;");
}

export function buildMobileMarkdownRichHtml(input: {
  readonly instanceId: string;
  readonly kind: "math" | "mermaid";
  readonly source: string;
  readonly colors: MobileMarkdownColors;
  readonly zoomable?: boolean;
}, runtime: MobileMarkdownRichRuntime): string {
  if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(input.instanceId) || input.source.length > 100_000
    || Object.values(input.colors).some((color) => !/^#[0-9a-f]{3,8}$/iu.test(color))) {
    throw new Error("The rich Markdown surface is invalid.");
  }
  const { colors, source, instanceId, kind } = input;
  const dark = Number.parseInt(colors.surface.slice(1, 3), 16) < 128;
  const render = kind === "math"
    ? `window.katex.render(source, root, { displayMode: true, throwOnError: true, trust: false, strict: 'ignore', maxExpand: 1000 }); finish('ready');`
    : `var engine = window.jokoMermaid;
      engine.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
        maxTextSize: 100000, theme: ${mobileMarkdownScriptValue(dark ? "dark" : "default")},
        themeVariables: { background: ${mobileMarkdownScriptValue(colors.surface)},
          primaryColor: ${mobileMarkdownScriptValue(colors.background)}, primaryTextColor: ${mobileMarkdownScriptValue(colors.ink)},
          primaryBorderColor: ${mobileMarkdownScriptValue(colors.border)}, lineColor: ${mobileMarkdownScriptValue(colors.muted)} } });
      Promise.resolve(engine.render('diagram', source)).then(function(result) {
        if (settled) return; root.innerHTML = result.svg;
        root.querySelectorAll('a').forEach(function(link) { link.removeAttribute('href'); link.removeAttribute('xlink:href'); });
        root.querySelectorAll('image,script,foreignObject iframe').forEach(function(node) { node.remove(); });
        finish('ready');
      }, function() { finish('error'); });`;
  const runtimeScript = kind === "math" ? runtime.katexScript : runtime.mermaidScript;
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=${input.zoomable ? 5 : 1}">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'">
    <style>html,body{margin:0;background:${colors.surface};color:${colors.ink};font-family:system-ui,sans-serif}
    #root{box-sizing:border-box;padding:8px;overflow-x:auto}#root svg{max-width:100%;height:auto}
    pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 monospace;margin:0;color:${colors.muted}}
    .katex-display{margin:0}${kind === "math" ? runtime.katexCss : ""}</style></head><body>
    <div id="root"><pre>${escapeMobileMarkdownHtml(source)}</pre></div><script>
    var source=${mobileMarkdownScriptValue(source)},instanceId=${mobileMarkdownScriptValue(instanceId)};
    var root=document.getElementById('root'),settled=false;
    function report(state){window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({
      type:'joko-rich-markdown/status',instanceId:instanceId,state:state,
      height:Math.max(24,Math.min(1200,Math.ceil(root.getBoundingClientRect().height)))}));}
    function finish(state){if(settled)return;settled=true;clearTimeout(timer);
      if(state==='error'){root.textContent='';var pre=document.createElement('pre');pre.textContent=source;root.appendChild(pre);}
      report(state);document.fonts && document.fonts.ready.then(function(){report(state);});}
    report('source');var timer=setTimeout(function(){finish('error');},8000);
    try{var script=document.createElement('script');script.textContent=${mobileMarkdownScriptValue(runtimeScript)};
      document.head.appendChild(script);${render}}catch(error){finish('error');}
    </script></body></html>`;
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
