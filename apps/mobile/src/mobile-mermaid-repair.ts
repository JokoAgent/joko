/** Retry only after the original Mermaid source failed to parse. */
/** 单行超过此长度即放弃修复(合法 mermaid 不存在这种行,防 O(n²) 回溯冻结)。 */
const MAX_REPAIR_LINE_LENGTH = 2_000;

/** 整体超过此长度即放弃修复(同上,规模闸)。 */
const MAX_REPAIR_SOURCE_LENGTH = 100_000;

/** LLM 常写的 unicode 右箭头(左箭头无法机械翻译成合法边,留给降级路径)。 */
const UNICODE_ARROW_RE = /[→⟶➔➜⇒⟹]/g; // → ⟶ ➔ ➜ ⇒ ⟹

/**
 * 节点标签含这些字符时补引号。前段是 strict 模式下易炸的结构字符;unicode
 * 箭头也在列——不是因为它炸 parse,而是让含箭头的标签先被引号保护起来,
 * 免遭最后一步箭头替换改写渲染文本(见文件头「内容保真」)。
 */
const NODE_LABEL_DANGER_RE = /[:;=&#<>(){}[\]\\/→⟶➔➜⇒⟹]/;

/** 形状变体开头字符:`[(db)]` `[[x]]` `[/p/]` `{{hex}}` 等,加引号会改变形状语义。 */
const SHAPE_MODIFIER_HEAD = new Set(['(', '{', '[', '/', '\\']);

/** 把行按 `"` 二分,只对引号外片段应用 fn(偶数段在引号外)。 */
function mapOutsideQuotes(line: string, fn: (segment: string) => string): string {
  const parts = line.split('"');
  return parts.map((p, i) => (i % 2 === 0 ? fn(p) : p)).join('"');
}

/** 图类型判定:跳过 YAML frontmatter 与 `%%` 注释后,看首个有效行。 */
function isFlowchartSource(lines: string[]): boolean {
  let start = 0;
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (close > 0) start = close + 1;
  }
  for (let i = start; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith('%%')) continue;
    return /^(flowchart|graph)\b/.test(t);
  }
  return false;
}

/** 未引号边标签 `|text|` → `|"text"|`(仅在引号外片段内成对出现时)。 */
function quoteEdgeLabels(segment: string): string {
  return segment.replace(/\|([^|"]+)\|/g, (full, label: string) => {
    const trimmed = label.trim();
    if (!trimmed) return full;
    return `|"${trimmed}"|`;
  });
}

/**
 * 生成"节点标签加引号"的单形状 pass:`Id<open>label<close>` 且 label 含危险
 * 字符时 → `Id<open>"label"<close>`。三种形状各自独立成 pass,因为每个 pass
 * 都可能插入引号,必须让下一个 pass 重新做引号二分。
 */
function makeNodeLabelQuoter(re: RegExp, open: string, close: string) {
  return (segment: string): string =>
    segment.replace(re, (full, id: string, label: string) => {
      if (SHAPE_MODIFIER_HEAD.has(label[0])) return full;
      if (!NODE_LABEL_DANGER_RE.test(label)) return full;
      return `${id}${open}"${label}"${close}`;
    });
}

const quoteSquareLabels = makeNodeLabelQuoter(/([A-Za-z0-9_-]+)\[([^[\]"|]+)\]/g, '[', ']');
const quoteRoundLabels = makeNodeLabelQuoter(/([A-Za-z0-9_-]+)\(([^()"|]+)\)/g, '(', ')');
const quoteCurlyLabels = makeNodeLabelQuoter(/([A-Za-z0-9_-]+)\{([^{}"|]+)\}/g, '{', '}');

/**
 * 修复一份 parse 失败的 mermaid 源码。无可修项(或触发规模闸)时返回逐字符
 * 相同的字符串,调用方可用 `repaired !== source` 判断是否值得重试 parse。
 */
export function repairMobileMermaidSource(source: string): string {
  if (source.length > MAX_REPAIR_SOURCE_LENGTH) return source;
  const lines = source.split('\n');
  if (lines.some((l) => l.length > MAX_REPAIR_LINE_LENGTH)) return source;
  const flowchart = isFlowchartSource(lines);
  return lines
    .map((line) => {
      if (/^\s*\/\//.test(line)) return line.replace(/^(\s*)\/\//, '$1%%');
      if (!flowchart) return line;
      const t = line.trim();
      if (!t || t.startsWith('%%')) return line;
      let fixed = line.replace(/^(\s*subgraph\s+[A-Za-z0-9_-]+)\[/, '$1 [');
      // 加引号的 pass 全部先跑(不改渲染文本),箭头替换(改文本)压轴——
      // 顺序是内容保真的关键,见文件头。
      fixed = mapOutsideQuotes(fixed, quoteEdgeLabels);
      fixed = mapOutsideQuotes(fixed, quoteSquareLabels);
      fixed = mapOutsideQuotes(fixed, quoteRoundLabels);
      fixed = mapOutsideQuotes(fixed, quoteCurlyLabels);
      fixed = mapOutsideQuotes(fixed, (s) => s.replace(UNICODE_ARROW_RE, '-->'));
      return fixed;
    })
    .join('\n');
}
