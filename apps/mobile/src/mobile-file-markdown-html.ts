import { mobileCodeHighlight } from "./mobile-code-highlight";
import { parseMobileMarkdown, type MobileMarkdownBlock, type MobileMarkdownInline } from "./mobile-markdown";
import { escapeMobileMarkdownHtml as escapeHtml, mobileMarkdownScriptValue, type MobileMarkdownColors, type MobileMarkdownRichRuntime } from "./mobile-markdown-rich-html";
import { mobileMarkdownResourceKey, type MobileMarkdownResourceDescriptor } from "./mobile-markdown-resources";

/** A scrolling document, using the same parser and highlighting as task messages. */
export function buildMobileFileMarkdownHtml(input: {
  readonly text: string; readonly colors: MobileMarkdownColors; readonly label: string;
  readonly focusLine?: number; readonly resources?: MobileMarkdownResourceDescriptor;
}, runtime: MobileMarkdownRichRuntime): string {
  if (input.text.length > 2_097_152 || Object.values(input.colors).some((value) => !/^#[0-9a-f]{6}$/iu.test(value))) {
    throw new Error("The Markdown file preview is too large or has invalid colors.");
  }
  const blocks = parseMobileMarkdown(input.text, { srcLines: true });
  const inlines = (values: readonly MobileMarkdownInline[]): string => values.map(inline).join("");
  const inline = (value: MobileMarkdownInline): string => {
    if (value.type === "image") {
      const key = mobileMarkdownResourceKey(value); const image = key ? input.resources?.references.get(key)?.image : undefined;
      const attributes = ' data-image-key="' + escapeHtml(key!) + '" data-image-alt="' + escapeHtml(value.alt) + '"';
      if (!validImage(image)) return '<span class="image-fallback"' + attributes + '>' + escapeHtml(value.alt) + "</span>";
      return '<img' + attributes + ' src="' + escapeHtml(image.uri) + '" alt="' + escapeHtml(value.alt) + '" width="' + image.width + '" height="' + image.height + '">';
    }
    if (value.type === "link") {
      try {
        const url = new URL(value.url);
        if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) {
          return '<a href="' + escapeHtml(value.url) + '">' + escapeHtml(value.text) + "</a>";
        }
      } catch { /* Non-actionable paths retain their label. */ }
      return escapeHtml(value.text);
    }
    if (value.type === "math") return '<span data-latex="' + escapeHtml(value.text) + '"><em>' + escapeHtml(value.text) + "</em></span>";
    const tag = value.type === "strong" ? "strong" : value.type === "emphasis" ? "em" : value.type === "code" ? "code" : value.type === "strikethrough" ? "del" : undefined;
    return tag ? `<${tag}>${escapeHtml(value.text)}</${tag}>` : escapeHtml(value.text);
  };
  const block = (value: MobileMarkdownBlock): string => {
    if (value.type === "code") return '<pre><code>' + mobileCodeHighlight(value.text, value.language).map((run) =>
      run.kind ? '<span class="syntax-' + escapeHtml(run.kind) + '">' + escapeHtml(run.text) + "</span>" : escapeHtml(run.text)).join("") + "</code></pre>";
    if (value.type === "mermaid") return '<pre><code>' + escapeHtml("// mermaid\n" + value.text) + "</code></pre>";
    if (value.type === "math") return '<div data-display="1" data-latex="' + escapeHtml(value.text) + '"><pre>' + escapeHtml(value.text) + "</pre></div>";
    if (value.type === "table") return '<div class="table-scroll"><table><thead><tr>' + value.header.map((cell) => '<th>' + inlines(cell) + "</th>").join("")
      + '</tr></thead><tbody>' + value.rows.map((row) => '<tr>' + row.cells.map((cell) => '<td>' + inlines(cell) + "</td>").join("") + "</tr>").join("") + "</tbody></table></div>";
    if (value.type === "list_item") return '<div class="list-row"><span class="list-marker">' + escapeHtml(value.checked === true ? "✓" : value.checked === false ? "□" : value.ordered ? value.marker : "•")
      + '</span><span>' + inlines(value.inlines) + "</span></div>";
    const tag = value.type === "heading" ? "h" + Math.min(6, Math.max(1, value.level)) : value.type === "blockquote" ? "blockquote" : "p";
    return `<${tag}>${inlines(value.inlines)}</${tag}>`;
  };
  const markup = blocks.map((value) => '<div data-source-line="' + value.srcLine + '">' + block(value) + "</div>").join("");
  const c = input.colors; const hasMath = markup.includes("data-latex=");
  const target = input.focusLine && Number.isSafeInteger(input.focusLine) && input.focusLine > 0 ? input.focusLine - 1 : -1;
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; font-src data:; img-src data:; connect-src \'none\'; base-uri \'none\'; form-action \'none\'">'
    + `<style>html,body{margin:0;background:${c.background};color:${c.ink};font:16px/24px system-ui,sans-serif}main{padding:16px 16px 36px;display:flex;flex-direction:column;gap:10px;overflow-wrap:anywhere}
      p,h1,h2,h3,h4,h5,h6,blockquote,pre{margin:0}h1,h2{font-size:20px;line-height:28px}h3,h4,h5,h6{font-size:18px;line-height:28px}
      blockquote{border-left:3px solid ${c.accent};padding-left:12px;color:${c.muted}}a{color:${c.accent};text-decoration:underline}
      code,pre{font:13px/20px ui-monospace,Menlo,monospace}pre{background:${c.surface};border:1px solid ${c.border};border-radius:8px;padding:12px;white-space:pre;overflow-x:auto}
      code{background:${c.surface}}.syntax-keyword,.syntax-number,.syntax-literal{color:${c.accent}}.syntax-comment,.syntax-meta{color:${c.muted}}
      .list-row{display:flex;gap:8px}.list-marker{min-width:24px}.table-scroll{overflow-x:auto}table{border-collapse:collapse}th,td{min-width:112px;border:1px solid ${c.border};padding:8px;text-align:left}th{background:${c.surface}}
      img{max-width:100%;height:auto}.image-fallback{color:${c.muted}}.line-focus{animation:line-flash .7s ease-out 2}@keyframes line-flash{from{background:${c.surface}}to{background:transparent}}
      @media(prefers-reduced-motion:reduce){.line-focus{animation:none;outline:1px solid ${c.accent}}}${hasMath ? runtime.katexCss : ""}</style></head><body><main role="article" aria-label="${escapeHtml(input.label)}">`
    + markup + '</main><script>(function(){'
    + (hasMath ? `try{var script=document.createElement('script');script.textContent=${mobileMarkdownScriptValue(runtime.katexScript)};document.head.appendChild(script);
      var engine=window.katex;if(engine)document.querySelectorAll('[data-latex]').forEach(function(node){try{engine.render(node.getAttribute('data-latex'),node,{displayMode:node.hasAttribute('data-display'),throwOnError:true,strict:'error',trust:false,maxExpand:1000});}catch(error){}});}catch(error){}` : "")
    + `var best=null,bestLine=-1;document.querySelectorAll('[data-source-line]').forEach(function(node){var line=Number(node.getAttribute('data-source-line'));if(line<=${target}&&line>=bestLine){best=node;bestLine=line;}});
      if(best){var scroll=function(){best.scrollIntoView({block:'center'});};scroll();window.addEventListener('load',scroll,{once:true});best.classList.add('line-focus');best.addEventListener('animationend',function(){best.classList.remove('line-focus');},{once:true});}
      document.querySelectorAll('img').forEach(function(image){image.addEventListener('error',function(){var label=document.createElement('span');label.className='image-fallback';label.textContent=image.alt;image.replaceWith(label);},{once:true});});
      })();</script></body></html>`;
}

function validImage(image: { readonly uri: string; readonly width: number; readonly height: number } | undefined): image is { readonly uri: string; readonly width: number; readonly height: number } {
  return !!image && /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/u.test(image.uri)
    && Number.isSafeInteger(image.width) && Number.isSafeInteger(image.height) && image.width > 0 && image.height > 0 && image.width * image.height <= 12_000_000;
}

/** Adopt authenticated images in place; loading an image must not reload the reading document. */
export function mobileFileMarkdownImagesScript(resources?: MobileMarkdownResourceDescriptor): string {
  const bindings = [...(resources?.references.values() ?? [])].filter((reference) => validImage(reference.image))
    .map((reference) => [reference.key, [reference.image!.uri, reference.image!.width, reference.image!.height]]);
  return `(function(){var bindings=new Map(JSON.parse(${mobileMarkdownScriptValue(JSON.stringify(bindings))}));
    document.querySelectorAll('[data-image-key]').forEach(function(node){var key=node.getAttribute('data-image-key'),alt=node.getAttribute('data-image-alt')||'',binding=bindings.get(key);
      if(binding&&node.tagName==='IMG'&&node.getAttribute('src')===binding[0])return;
      var replacement=document.createElement(binding?'img':'span');replacement.setAttribute('data-image-key',key);replacement.setAttribute('data-image-alt',alt);
      if(binding){replacement.src=binding[0];replacement.alt=alt;replacement.width=binding[1];replacement.height=binding[2];replacement.addEventListener('error',function(){
        var label=document.createElement('span');label.className='image-fallback';label.textContent=alt;label.setAttribute('data-image-key',key);label.setAttribute('data-image-alt',alt);replacement.replaceWith(label);},{once:true});}
      else{replacement.className='image-fallback';replacement.textContent=alt;}node.replaceWith(replacement);
    });})();true;`;
}
