import { useMemo, type CSSProperties, type ReactNode } from "react";
import { TIMELINE_CODE_HIGHLIGHT_LIMIT } from "./timeline-code-highlighting.js";
import "./timeline-markdown-diff.css";

export const TIMELINE_MARKDOWN_DIFF_ROW_LIMIT = 2_000;

interface DiffRow {
  readonly kind: "context" | "added" | "removed";
  readonly text: string;
}

/** Presents already-prefixed source; row numbers do not identify workspace lines. */
export function TimelineMarkdownDiffRows({ source }: { readonly source: string }): ReactNode {
  const rows = useMemo(() => parseRows(source), [source]);
  if (rows === undefined) return source;
  return <span className="timeline-markdown-diff" style={{ "--timeline-diff-number-width": `${String(rows.length).length + 2}ch` } as CSSProperties}>
    {rows.map((row, index) => <span className={`timeline-markdown-diff__row timeline-markdown-diff__row--${row.kind}`} key={index}>
      <span className="timeline-markdown-diff__number" aria-hidden="true">{index + 1}</span>
      <span className="timeline-markdown-diff__sign">{row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " "}</span>
      <span className="timeline-markdown-diff__text">{row.text}{index < rows.length - 1 ? "\n" : ""}</span>
    </span>)}
  </span>;
}

function parseRows(source: string): readonly DiffRow[] | undefined {
  if (source.length > TIMELINE_CODE_HIGHLIGHT_LIMIT) return undefined;
  const text = source.replace(/\r\n/gu, "\n").replace(/^\n+|\n+$/gu, "");
  if (text.length === 0) return [];
  const rows: DiffRow[] = [];
  let start = 0;
  while (start < text.length) {
    if (rows.length === TIMELINE_MARKDOWN_DIFF_ROW_LIMIT) return undefined;
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline;
    const line = text.slice(start, end);
    const header = line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@");
    const kind = header ? "context" : line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : "context";
    rows.push({ kind, text: kind === "context" ? line : line.slice(line[1] === " " ? 2 : 1) });
    start = end + 1;
  }
  return rows;
}
