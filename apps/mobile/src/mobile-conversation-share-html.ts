import { mobileConnectionAppIcon } from "./connection-artwork";
import { mobileCodeHighlight } from "./mobile-code-highlight";
import { parseMobileMarkdown, type MobileMarkdownBlock, type MobileMarkdownInline } from "./mobile-markdown";
import { repairMobileMermaidSource } from "./mobile-mermaid-repair";
import { escapeMobileMarkdownHtml as escapeHtml, mobileMarkdownScriptValue, type MobileMarkdownRichRuntime } from "./mobile-markdown-rich-html";
import { redactShareMessageText } from "./mobile-share-redaction";
import type { MobileConversationShareMessage, MobileConversationShareSnapshot } from "./mobile-conversation-share";
import type { MobileConversationShareColors } from "./mobile-conversation-share-layout";

export function buildMobileConversationShareHtml(input: {
  readonly snapshot: MobileConversationShareSnapshot;
  readonly colors: MobileConversationShareColors;
  readonly width: number;
  readonly dark: boolean;
}, runtime: MobileMarkdownRichRuntime): string {
  if (!Number.isFinite(input.width) || Object.values(input.colors).some((color) => !/^#[0-9a-f]{6}$/iu.test(color))
    || input.snapshot.messages.length === 0 || input.snapshot.messages.length > 200) throw new Error("The message image export is invalid.");
  const width = Math.max(280, Math.min(720, Math.round(input.width)));
  const order = new Map(input.snapshot.allShareableIds.map((id, index) => [id, index]));
  let previous: number | undefined;
  const markup = input.snapshot.messages.map((message) => {
    const index = order.get(message.clientId);
    if (index === undefined || (previous !== undefined && index <= previous)) throw new Error("The message image source order changed.");
    const gap = previous !== undefined && index - previous > 1 ? '<div class="share-gap">⋯</div>' : "";
    previous = index;
    const texts = message.bodyParts.filter((part) => part.kind === "text").map((part) => part.text).join("\n");
    // A secret can span content boundaries. The text-only SVG redaction owns that case.
    if (redactShareMessageText(texts) !== texts) throw new Error("The message image requires text redaction.");
    const attachments = message.attachments.map((attachment) => {
      const image = attachment.kind === "image" && attachment.uri ? imageHtml(message, attachment.uri, attachment.name) : undefined;
      return image ?? '<div class="share-attachment">' + escapeHtml(redactShareMessageText(attachment.name)) + "</div>";
    }).join("");
    const body = message.bodyParts.map((part) => {
      if (part.kind === "image") return imageHtml(message, part.key, part.label) ?? imageFallback(part.label);
      return renderBlocks(parseMobileMarkdown(redactShareMessageText(part.text)), message);
    }).join("");
    return gap + '<article class="share-message share-message-' + message.kind + '">'
      + (attachments ? '<div class="share-attachments">' + attachments + "</div>" : "")
      + '<div class="share-bubble share-bubble-' + message.kind + '">' + body + "</div></article>";
  }).join("");
  const includeMath = markup.includes("data-latex=");
  const includeMermaid = markup.includes("data-mermaid-source=");
  const html = '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; font-src data:; img-src data:; connect-src \'none\'; base-uri \'none\'; form-action \'none\'">'
    + "<style>" + shareCss(width, input.colors, input.dark) + (includeMath ? runtime.katexCss : "") + "</style></head><body>"
    + '<main id="joko-share-stage">' + markup + '<footer class="share-footer">'
    + mobileConnectionAppIcon(input.dark ? "dark" : "light") + "<span>Joko</span></footer></main>"
    + richPreparationScript(runtime, includeMath, includeMermaid, input.dark, input.colors) + "</body></html>";
  if (html.length > 40 * 1_024 * 1_024) throw new Error("The selected messages are too large. Select fewer messages.");
  return html;
}

function imageHtml(message: MobileConversationShareMessage, key: string, label: string): string | undefined {
  const image = message.images?.get(key);
  if (!image || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u.test(image.uri)
    || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)
    || image.width <= 0 || image.height <= 0 || image.width * image.height > 12_000_000) return undefined;
  return '<img class="share-image" src="' + image.uri + '" width="' + image.width + '" height="' + image.height
    + '" alt="' + escapeHtml(redactShareMessageText(label)) + '">';
}

function imageFallback(label: string): string {
  return '<span class="share-image-fallback">' + escapeHtml(redactShareMessageText(label || "[Image]")) + "</span>";
}

function fit(content: string, inline = false): string {
  return '<' + (inline ? "span" : "div") + ' class="share-fit' + (inline ? " share-fit-inline" : "") + '">'
    + '<' + (inline ? "span" : "div") + ' class="share-fit-content">' + content + "</" + (inline ? "span" : "div") + "></" + (inline ? "span" : "div") + ">";
}

function renderBlocks(blocks: readonly MobileMarkdownBlock[], message: MobileConversationShareMessage): string {
  return blocks.map((block) => {
    if (block.type === "code") {
      const code = mobileCodeHighlight(block.text, block.language).map((run) => run.kind
        ? '<span class="' + escapeHtml(run.kind) + '">' + escapeHtml(run.text) + "</span>" : escapeHtml(run.text)).join("");
      return fit("<pre><code>" + code + "</code></pre>");
    }
    if (block.type === "mermaid") return fit('<div data-mermaid-source="' + escapeHtml(block.text) + '" data-mermaid-repaired-source="'
      + escapeHtml(repairMobileMermaidSource(block.text)) + '"><pre>' + escapeHtml(block.text) + "</pre></div>");
    if (block.type === "math") return fit('<div class="share-math" data-latex="' + escapeHtml(block.text)
      + '" data-math-display="true"><pre>' + escapeHtml(block.text) + "</pre></div>");
    if (block.type === "table") {
      const row = (cells: readonly MobileMarkdownInline[][], tag: "th" | "td") => "<tr>" + cells
        .map((cell) => "<" + tag + ">" + renderInlines(cell, message) + "</" + tag + ">").join("") + "</tr>";
      return fit("<table><thead>" + row(block.header, "th") + "</thead><tbody>"
        + block.rows.map((item) => row(item.cells, "td")).join("") + "</tbody></table>");
    }
    const content = renderInlines(block.inlines, message);
    if (block.type === "heading") return "<h" + block.level + ">" + content + "</h" + block.level + ">";
    if (block.type === "blockquote") return "<blockquote>" + content + "</blockquote>";
    if (block.type === "list_item") return '<div class="share-list-row"><span class="share-list-marker">'
      + escapeHtml(block.checked === undefined ? block.marker : block.checked ? "☑" : "☐")
      + '</span><span class="share-list-text">' + content + "</span></div>";
    return "<p>" + content + "</p>";
  }).join("");
}

function renderInlines(inlines: readonly MobileMarkdownInline[], message: MobileConversationShareMessage): string {
  return inlines.map((inline) => {
    if (inline.type === "image") return imageHtml(message, inline.url, inline.alt) ?? imageFallback(inline.alt);
    if (inline.type === "math") return fit('<span data-latex="' + escapeHtml(inline.text) + '">' + escapeHtml(inline.text) + "</span>", true);
    const text = escapeHtml(redactShareMessageText(inline.text)).replace(/\n/gu, "<br>");
    if (inline.type === "link") return '<span class="share-link">' + text + "</span>";
    const tag = { strong: "strong", emphasis: "em", code: "code", strikethrough: "del", text: "span" }[inline.type];
    return "<" + tag + ">" + text + "</" + tag + ">";
  }).join("");
}

function shareCss(width: number, c: MobileConversationShareColors, dark: boolean): string {
  const keyword = dark ? "#ff7b72" : "#cf222e";
  const string = dark ? "#a5d6ff" : "#0a3069";
  const number = dark ? "#79c0ff" : "#0550ae";
  const fn = dark ? "#d2a8ff" : "#8250df";
  return `
    html,body{margin:0;padding:0;background:${c.background};color:${c.textPrimary};
      font-family:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif;font-size:16px;line-height:23px;
      overflow-wrap:anywhere;-webkit-text-size-adjust:100%}
    #joko-share-stage{box-sizing:border-box;display:flex;flex-direction:column;width:${width}px;min-width:${width}px;
      padding:28px;background:${c.background};gap:16px}
    .share-message{display:flex;flex-direction:column;width:100%;min-width:0}
    .share-message-user{align-items:flex-end}.share-message-assistant{align-items:flex-start}
    .share-bubble{box-sizing:border-box;min-width:0;display:flex;flex-direction:column;gap:${width <= 360 ? 12 : 14}px}
    .share-bubble-user{max-width:86%;padding:12px;border:1px solid ${c.textSecondary};border-radius:12px;background:${c.surfaceElevated}}
    .share-bubble-assistant{width:100%;padding:4px 0}
    p,h1,h2,h3,h4,h5,h6,blockquote,pre,table{margin:0}h1,h2,h3,h4,h5,h6{font-size:16px;font-weight:500;line-height:23px}
    h1{font-size:20px;line-height:28px}h2{font-size:18px;line-height:28px}
    blockquote{border-left:2px solid ${c.textTertiary};padding-left:8px}
    .share-list-row{display:flex;gap:8px}.share-list-marker{flex:0 0 24px;text-align:right}.share-list-text{flex:1;min-width:0}
    pre{box-sizing:border-box;padding:10px 12px;border-radius:12px;background:${c.surfaceElevated};white-space:pre;
      font-family:Menlo,Monaco,Consolas,monospace;font-size:13px;line-height:21px;min-width:100%;width:max-content;overflow-wrap:normal}
    code{font-family:Menlo,Monaco,Consolas,monospace;font-size:13px;color:${c.textSecondary}}
    pre code{color:${c.textPrimary};background:transparent;font-size:inherit}
    pre code .hljs-keyword,pre code .hljs-doctag,pre code .hljs-literal{color:${keyword}}
    pre code .hljs-string,pre code .hljs-regexp{color:${string}}pre code .hljs-comment{color:${c.textSecondary}}
    pre code .hljs-number,pre code .hljs-attr,pre code .hljs-attribute{color:${number}}pre code .hljs-title{color:${fn}}
    .share-link{text-decoration:underline;color:inherit}
    .share-attachments{display:flex;flex-direction:column;gap:8px;max-width:86%;margin-bottom:4px}
    .share-message-user .share-attachments{align-items:flex-end}
    .share-attachment{padding:5px 10px;border:1px solid ${c.textTertiary};border-radius:9999px;background:${c.surfaceElevated};
      font-size:12px;line-height:18px;max-width:228px;box-sizing:border-box}
    .share-image{display:block;align-self:flex-start;max-width:100%;max-height:320px;width:auto;height:auto;object-fit:contain;border-radius:12px}
    .share-image-fallback{padding:1px 8px;border-radius:6px;background:${c.surfaceElevated};font-size:13px}
    table{border-collapse:separate;border-spacing:0;border-left:1px solid ${c.textTertiary};border-top:1px solid ${c.textTertiary};
      width:max-content;overflow:visible}
    th,td{border-right:1px solid ${c.textTertiary};border-bottom:1px solid ${c.textTertiary};padding:4px 8px;
      min-width:${width <= 360 ? 96 : 112}px;box-sizing:border-box;text-align:left;vertical-align:top}
    th{font-weight:500;color:${c.textSecondary}}
    .share-fit{position:relative;max-width:100%;min-width:0;overflow:hidden}
    .share-fit-content{display:inline-block;width:max-content;min-width:100%;vertical-align:top;transform-origin:top left}
    .share-fit-inline{display:inline-block;vertical-align:middle}.share-fit-inline .share-fit-content{min-width:0}
    .share-fit-content:has(pre code){width:100%}
    pre:has(code){width:100%;white-space:pre-wrap;overflow-wrap:anywhere}
    .share-math{text-align:center}.share-math pre{text-align:left}.katex-display{margin:0}
    .share-gap{text-align:center;color:${c.textTertiary};font-size:16px;line-height:16px;letter-spacing:4px;opacity:.58}
    .share-footer{display:flex;align-items:center;justify-content:center;gap:6px;padding-top:36px;font-size:18px;font-weight:500}
    .share-footer svg{width:24px;height:24px;flex:0 0 24px}
    #joko-share-stage [data-mermaid-source] svg{max-width:none;height:auto}
  `;
}

function richPreparationScript(runtime: MobileMarkdownRichRuntime, math: boolean, mermaid: boolean, dark: boolean, c: MobileConversationShareColors): string {
  return `<script>
    window.jokoConversationShareReady=(async function(){
      var stage=document.getElementById('joko-share-stage');
      function install(source){var script=document.createElement('script');script.textContent=source;document.head.appendChild(script);}
      var active=true;
      function bounded(promise,ms){return new Promise(function(resolve,reject){
        var timer=setTimeout(function(){reject(new Error('share-resource-timeout'));},ms);
        Promise.resolve(promise).then(function(value){clearTimeout(timer);resolve(value);},function(error){clearTimeout(timer);reject(error);});
      });}
      ${math ? `try{install(${mobileMarkdownScriptValue(runtime.katexScript)});
        stage.querySelectorAll('[data-latex]').forEach(function(node){try{
          var original=node.innerHTML;
          window.katex.render(node.getAttribute('data-latex'),node,{displayMode:node.hasAttribute('data-math-display'),
            throwOnError:true,trust:false,strict:'ignore',maxExpand:1000});
        }catch(error){node.innerHTML=original;}});
      }catch(error){}` : ""}
      ${mermaid ? `var scratch=document.createElement('div');scratch.style.cssText='position:absolute;left:-100000px;top:0;width:720px;height:1px;overflow:hidden';
        document.body.appendChild(scratch);
        try{install(${mobileMarkdownScriptValue(runtime.mermaidScript)});
          var engine=window.jokoMermaid;
          engine.initialize({startOnLoad:false,securityLevel:'strict',suppressErrorRendering:true,maxTextSize:100000,
            theme:${mobileMarkdownScriptValue(dark ? "dark" : "default")},fontFamily:'inherit',
            themeVariables:{background:${mobileMarkdownScriptValue(c.background)},primaryColor:${mobileMarkdownScriptValue(c.surfaceElevated)},
              primaryTextColor:${mobileMarkdownScriptValue(c.textPrimary)},lineColor:${mobileMarkdownScriptValue(c.textSecondary)}},
            flowchart:{useMaxWidth:false,htmlLabels:false},sequence:{useMaxWidth:false},class:{useMaxWidth:false},
            state:{useMaxWidth:false},er:{useMaxWidth:false},gantt:{useMaxWidth:false,useWidth:760},journey:{useMaxWidth:false},pie:{useMaxWidth:false}});
          var nodes=Array.from(stage.querySelectorAll('[data-mermaid-source]'));
          await bounded(Promise.all(nodes.map(async function(node,index){
            async function render(source){await engine.parse(source);return await engine.render('joko-share-diagram-'+index,source,scratch);}
            try{var result;try{result=await render(node.getAttribute('data-mermaid-source'));}
              catch(error){var repaired=node.getAttribute('data-mermaid-repaired-source');if(!repaired)throw error;result=await render(repaired);}
              if(!active)return;var fragment=document.createElement('div');fragment.innerHTML=result.svg;
              fragment.querySelectorAll('script,image,iframe,object,embed').forEach(function(element){element.remove();});
              fragment.querySelectorAll('[href],[xlink\\\\:href]').forEach(function(element){element.removeAttribute('href');element.removeAttribute('xlink:href');});
              var svg=fragment.querySelector('svg');if(!svg)return;
              var viewBox=svg.viewBox.baseVal;if(viewBox.width>0){svg.setAttribute('width',String(viewBox.width));svg.setAttribute('height',String(viewBox.height));}
              node.replaceChildren(svg);
            }catch(error){}
          })),12000);
        }catch(error){}finally{active=false;scratch.remove();}` : ""}
      await bounded(Promise.all(Array.from(stage.querySelectorAll('img')).map(async function(image){
        try{if(!image.complete)await new Promise(function(resolve){
          image.addEventListener('load',resolve,{once:true});image.addEventListener('error',resolve,{once:true});});
          if(image.decode)await image.decode();
          if(image.naturalWidth<=0)throw new Error('image-not-decoded');
        }catch(error){var label=document.createElement('span');label.className='share-image-fallback';label.textContent=image.alt||'[Image]';image.replaceWith(label);}
      })),5000);
      if(document.fonts&&document.fonts.ready)await bounded(document.fonts.ready,3000);
      await new Promise(function(resolve){requestAnimationFrame(function(){requestAnimationFrame(resolve);});});
      Array.from(stage.querySelectorAll('.share-fit')).reverse().forEach(function(wrapper){
        var content=wrapper.firstElementChild;if(!content)return;
        var maximum=wrapper.classList.contains('share-fit-inline')?wrapper.parentElement.clientWidth:wrapper.clientWidth;
        var naturalWidth=Math.max(content.scrollWidth,content.getBoundingClientRect().width);
        var height=content.getBoundingClientRect().height;
        var scale=Math.min(1,maximum/Math.max(1,naturalWidth));
        content.style.transform='scale('+scale+')';wrapper.style.height=Math.ceil(height*scale)+'px';
        if(wrapper.classList.contains('share-fit-inline'))wrapper.style.width=Math.ceil(naturalWidth*scale)+'px';
      });
      await new Promise(function(resolve){requestAnimationFrame(function(){requestAnimationFrame(resolve);});});
      var rect=stage.getBoundingClientRect(),width=Math.max(stage.scrollWidth,Math.ceil(rect.width)),height=Math.max(stage.scrollHeight,Math.ceil(rect.height));
      if(width*height>12000000)throw new Error('share-content-too-large');
      return {width:width,height:height};
    })();window.jokoConversationShareReady.catch(function(){});
  </script>`;
}
