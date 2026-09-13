import { cpp } from "@codemirror/lang-cpp";
import { css } from "@codemirror/lang-css";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { php } from "@codemirror/lang-php";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { StreamLanguage, type Language } from "@codemirror/language";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { classHighlighter, highlightTree } from "@lezer/highlight";

export const TIMELINE_CODE_HIGHLIGHT_LIMIT = 100_000;

export interface TimelineCodeHighlightToken {
  readonly from: number;
  readonly to: number;
  readonly className: string;
}

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  c: "cpp",
  "c++": "cpp",
  h: "cpp",
  hpp: "cpp",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  py: "python",
  rb: "ruby",
  rs: "rust",
  md: "markdown",
  html: "html",
  htm: "html",
  svg: "xml",
  vue: "html",
  yml: "yaml",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ps1: "powershell",
  plaintext: "text",
  plain: "text",
  txt: "text"
};

const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  cpp: "C++",
  css: "CSS",
  diff: "Diff",
  go: "Go",
  html: "HTML",
  java: "Java",
  javascript: "JavaScript",
  jsx: "JSX",
  json: "JSON",
  markdown: "Markdown",
  php: "PHP",
  powershell: "PowerShell",
  python: "Python",
  rust: "Rust",
  shell: "Shell",
  sql: "SQL",
  tsx: "TSX",
  typescript: "TypeScript",
  xml: "XML",
  yaml: "YAML"
};

const LANGUAGES: Readonly<Record<string, Language>> = {
  cpp: cpp().language,
  css: css().language,
  diff: StreamLanguage.define(diff),
  go: go().language,
  html: html().language,
  java: java().language,
  javascript: javascript().language,
  jsx: javascript({ jsx: true }).language,
  json: json().language,
  markdown: markdown().language,
  php: php().language,
  powershell: StreamLanguage.define(powerShell),
  python: python().language,
  rust: rust().language,
  shell: StreamLanguage.define(shell),
  sql: sql({ dialect: PostgreSQL }).language,
  tsx: javascript({ jsx: true, typescript: true }).language,
  typescript: javascript({ typescript: true }).language,
  xml: xml().language,
  yaml: yaml().language
};

export function timelineCodeLanguage(className: string | undefined): string | undefined {
  const token = className?.split(/\s+/u).find((part) => part.startsWith("language-"));
  const raw = token?.slice("language-".length).trim().toLowerCase();
  if (raw === undefined || raw === "" || !/^[\w+#.-]{1,32}$/u.test(raw)) return undefined;
  return LANGUAGE_ALIASES[raw] ?? raw;
}

export function timelineCodeLanguageLabel(language: string | undefined, plainTextLabel: string): string {
  if (language === undefined || language === "text") return plainTextLabel;
  return DISPLAY_NAMES[language] ?? language;
}

export function timelineCodeHighlight(source: string, language: string | undefined): readonly TimelineCodeHighlightToken[] {
  if (source.length === 0 || source.length > TIMELINE_CODE_HIGHLIGHT_LIMIT || language === undefined || language === "text") return [];
  const parser = LANGUAGES[language]?.parser;
  if (parser === undefined) return [];
  const tokens: TimelineCodeHighlightToken[] = [];
  try {
    highlightTree(parser.parse(source), classHighlighter, (from, to, className) => {
      if (from < to) tokens.push({ from, to, className });
    });
  } catch {
    return [];
  }
  return tokens;
}
