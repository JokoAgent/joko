export interface ToolPayloadSection {
  readonly id: "input" | "output";
  readonly label: string;
  readonly text: string;
}

export interface ToolPayloadDiffFile {
  readonly id: string;
  readonly path: string;
  readonly text: string;
}

const STRUCTURED_SCAN_LIMIT = 1_048_576;
export const TOOL_PAYLOAD_DIFF_SCAN_LIMIT = 4_194_304;
const MAX_STRUCTURED_NODES = 4_096;
const PATH_KEYS = ["path", "filePath", "file_path", "relativePath", "relative_path"] as const;
const DIFF_KEYS = ["diff", "patch", "rawDiff", "raw_diff", "unifiedDiff", "unified_diff"] as const;
const OLD_KEYS = ["oldString", "old_string", "oldText", "old_text"] as const;
const NEW_KEYS = ["newString", "new_string", "newText", "new_text"] as const;

/**
 * Finds file-oriented diff payloads without changing the raw payload shown to
 * the user. Scanning is bounded; the full value always remains available in
 * the native text control even when structured discovery is skipped.
 */
export function toolPayloadDiffFiles(text: string): readonly ToolPayloadDiffFile[] {
  if (text.length > TOOL_PAYLOAD_DIFF_SCAN_LIMIT) return [];
  const candidates = [
    ...parsePatchEnvelope(text),
    ...parseUnifiedDiff(text),
    ...(text.length <= STRUCTURED_SCAN_LIMIT ? parseStructuredDiff(text) : [])
  ];
  const seen = new Set<string>();
  return candidates.filter((file) => {
    const key = `${file.path}\u0000${file.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return file.path.trim() !== "" && file.text.trim() !== "";
  }).map((file, index) => ({ ...file, id: `${index}:${file.path}` }));
}

function parsePatchEnvelope(text: string): readonly Omit<ToolPayloadDiffFile, "id">[] {
  const header = /^\*\*\* (?:Update|Add|Delete) File: (.+)\r?$/gmu;
  const matches = [...text.matchAll(header)];
  return matches.map((match, index) => ({
    path: match[1]?.trim() ?? "",
    text: text.slice(match.index, matches[index + 1]?.index ?? text.length).trimEnd()
  }));
}

function parseUnifiedDiff(text: string): readonly Omit<ToolPayloadDiffFile, "id">[] {
  const gitHeader = /^diff --git (?:"?a\/)?(.+?)"? (?:"?b\/)?(.+?)"?\r?$/gmu;
  const gitMatches = [...text.matchAll(gitHeader)];
  if (gitMatches.length > 0) {
    return gitMatches.map((match, index) => ({
      path: cleanDiffPath(match[2] ?? match[1] ?? ""),
      text: text.slice(match.index, gitMatches[index + 1]?.index ?? text.length).trimEnd()
    }));
  }

  const pairHeader = /^---\s+(.+)\r?\n\+\+\+\s+(.+)\r?$/gmu;
  const pairMatches = [...text.matchAll(pairHeader)];
  if (pairMatches.length < 2) return [];
  return pairMatches.map((match, index) => ({
    path: cleanDiffPath(match[2] ?? match[1] ?? ""),
    text: text.slice(match.index, pairMatches[index + 1]?.index ?? text.length).trimEnd()
  }));
}

function parseStructuredDiff(text: string): readonly Omit<ToolPayloadDiffFile, "id">[] {
  let root: unknown;
  try {
    root = JSON.parse(text) as unknown;
  } catch {
    return [];
  }

  const files: Omit<ToolPayloadDiffFile, "id">[] = [];
  const queue: unknown[] = [root];
  let visited = 0;
  while (queue.length > 0 && visited < MAX_STRUCTURED_NODES) {
    const value = queue.shift();
    visited += 1;
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    if (!isRecord(value)) continue;

    const path = firstString(value, PATH_KEYS);
    const directDiff = firstString(value, DIFF_KEYS);
    const oldText = firstString(value, OLD_KEYS);
    const newText = firstString(value, NEW_KEYS);
    if (path !== undefined && directDiff !== undefined) {
      files.push({ path, text: directDiff });
    } else if (path !== undefined && oldText !== undefined && newText !== undefined) {
      files.push({ path, text: `--- old\n${oldText}\n+++ new\n${newText}` });
    }
    queue.push(...Object.values(value));
  }
  return files;
}

function cleanDiffPath(value: string): string {
  const withoutMetadata = value.trim().replace(/^"|"$/gu, "").split(/\t/u, 1)[0] ?? "";
  return withoutMetadata.replace(/^[ab]\//u, "");
}

function firstString(record: Readonly<Record<string, unknown>>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}
