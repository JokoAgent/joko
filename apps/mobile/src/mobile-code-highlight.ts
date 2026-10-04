import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import sql from "highlight.js/lib/languages/sql";
import rust from "highlight.js/lib/languages/rust";
import cpp from "highlight.js/lib/languages/cpp";
import go from "highlight.js/lib/languages/go";

for (const [name, grammar] of Object.entries({ javascript, typescript, python, json, bash, css, xml, sql, rust, cpp, go })) {
  hljs.registerLanguage(name, grammar);
}

export interface MobileCodeRun { readonly text: string; readonly kind?: string }

export function mobileCodeHighlight(source: string, language: string | undefined): readonly MobileCodeRun[] {
  if (!language || source.length > 60_000 || !hljs.getLanguage(language)) return [{ text: source }];
  try {
    const html = hljs.highlight(source, { language, ignoreIllegals: true }).value;
    const runs: MobileCodeRun[] = [];
    const stack: string[] = [];
    for (const token of html.split(/(<span class="[A-Za-z0-9_ -]+">|<\/span>)/gu)) {
      if (token.startsWith('<span class="')) { stack.push(token.slice(13, -2)); continue; }
      if (token === "</span>") { stack.pop(); continue; }
      if (!token) continue;
      const text = token.replace(/&(amp|lt|gt|quot|#x27|#39);/gu, (_match, name: string) => ({
        amp: "&", lt: "<", gt: ">", quot: '"', "#x27": "'", "#39": "'"
      })[name]!);
      runs.push({ text, ...(stack.length ? { kind: stack[stack.length - 1] } : {}) });
    }
    return runs.map((run) => run.text).join("") === source ? runs : [{ text: source }];
  } catch { return [{ text: source }]; }
}
