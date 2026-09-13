const MAX_LINE_LENGTH = 2_000;
const MAX_SOURCE_LENGTH = 100_000;
const UNICODE_ARROW = /[→⟶➔➜⇒⟹]/gu;
const DANGEROUS_LABEL = /[:;=&#<>(){}[\]\\/→⟶➔➜⇒⟹]/u;
const SHAPE_PREFIXES = new Set(["(", "{", "[", "/", "\\"]);

function outsideQuotes(line: string, transform: (segment: string) => string): string {
  return line.split('"').map((segment, index) => index % 2 === 0 ? transform(segment) : segment).join('"');
}

function isFlowchart(lines: readonly string[]): boolean {
  let start = 0;
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (close > 0) start = close + 1;
  }
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line === "" || line.startsWith("%%")) continue;
    return /^(?:flowchart|graph)\b/u.test(line);
  }
  return false;
}

function quoteEdgeLabels(segment: string): string {
  return segment.replace(/\|([^|"]+)\|/gu, (match, label: string) => {
    const trimmed = label.trim();
    return trimmed === "" ? match : `|"${trimmed}"|`;
  });
}

function labelQuoter(pattern: RegExp, open: string, close: string): (segment: string) => string {
  return (segment) => segment.replace(pattern, (match, id: string, label: string) =>
    SHAPE_PREFIXES.has(label[0] ?? "") || !DANGEROUS_LABEL.test(label) ? match : `${id}${open}"${label}"${close}`);
}

const quoteSquare = labelQuoter(/([A-Za-z0-9_-]+)\[([^\[\]"|]+)\]/gu, "[", "]");
const quoteRound = labelQuoter(/([A-Za-z0-9_-]+)\(([^()"|]+)\)/gu, "(", ")");
const quoteCurly = labelQuoter(/([A-Za-z0-9_-]+)\{([^{}"|]+)\}/gu, "{", "}");

/** Deterministic retry used only after Mermaid rejects the original source. */
export function repairTimelineMermaidSource(source: string): string {
  if (source.length > MAX_SOURCE_LENGTH) return source;
  const lines = source.split("\n");
  if (lines.some((line) => line.length > MAX_LINE_LENGTH)) return source;
  const flowchart = isFlowchart(lines);
  return lines.map((line) => {
    if (/^\s*\/\//u.test(line)) return line.replace(/^(\s*)\/\//u, "$1%%");
    if (!flowchart || line.trim() === "" || line.trim().startsWith("%%")) return line;
    let fixed = line.replace(/^(\s*subgraph\s+[A-Za-z0-9_-]+)\[/u, "$1 [");
    fixed = outsideQuotes(fixed, quoteEdgeLabels);
    fixed = outsideQuotes(fixed, quoteSquare);
    fixed = outsideQuotes(fixed, quoteRound);
    fixed = outsideQuotes(fixed, quoteCurly);
    return outsideQuotes(fixed, (segment) => segment.replace(UNICODE_ARROW, "-->"));
  }).join("\n");
}
