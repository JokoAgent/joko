import type { WorkspaceDiffHunkView, WorkspaceFileDiffView } from "../model.js";
import { reviewImageMimeType } from "@joko/contracts";

export interface ReviewDiffTreeDirectory {
  readonly kind: "directory";
  readonly name: string;
  readonly path: string;
  readonly children: readonly ReviewDiffTreeNode[];
}

export interface ReviewDiffTreeFile {
  readonly kind: "file";
  readonly name: string;
  readonly path: string;
  readonly key: string;
  readonly file: WorkspaceFileDiffView;
}

export type ReviewDiffTreeNode = ReviewDiffTreeDirectory | ReviewDiffTreeFile;

export interface ReviewDiffTreeFlatNode {
  readonly node: ReviewDiffTreeNode;
  readonly depth: number;
}

export interface ReviewFileJumpResult {
  readonly file: WorkspaceFileDiffView;
  readonly key: string;
  readonly fileName: string;
  readonly directory: string;
}

export interface ReviewSplitRow {
  readonly key: string;
  readonly left?: WorkspaceDiffHunkView["lines"][number];
  readonly right?: WorkspaceDiffHunkView["lines"][number];
}

export interface InlineWordSegment {
  readonly text: string;
  readonly changed: boolean;
}

export function reviewFileKey(file: Pick<WorkspaceFileDiffView, "source" | "oldPath" | "path" | "evidenceId">): string {
  return file.evidenceId === undefined
    ? `${file.source}:${file.oldPath ?? ""}:${file.path}`
    : `${file.source}:${file.evidenceId}:${file.oldPath ?? ""}:${file.path}`;
}

export function buildReviewDiffTree(files: readonly WorkspaceFileDiffView[]): readonly ReviewDiffTreeNode[] {
  interface MutableDirectory {
    readonly name: string;
    readonly path: string;
    readonly directories: Map<string, MutableDirectory>;
    readonly files: ReviewDiffTreeFile[];
  }
  const root: MutableDirectory = { name: "", path: "", directories: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      const path = directory.path === "" ? part : `${directory.path}/${part}`;
      let child = directory.directories.get(part);
      if (child === undefined) {
        child = { name: part, path, directories: new Map(), files: [] };
        directory.directories.set(part, child);
      }
      directory = child;
    }
    directory.files.push({
      kind: "file",
      name: parts.at(-1) ?? file.path,
      path: file.path,
      key: reviewFileKey(file),
      file
    });
  }
  const materialize = (directory: MutableDirectory): readonly ReviewDiffTreeNode[] => [
    ...[...directory.directories.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((child): ReviewDiffTreeDirectory => ({
        kind: "directory",
        name: child.name,
        path: child.path,
        children: materialize(child)
      })),
    ...directory.files.sort((left, right) => left.name.localeCompare(right.name))
  ];
  return materialize(root);
}

export function filterReviewFiles(
  files: readonly WorkspaceFileDiffView[],
  query: string
): readonly WorkspaceFileDiffView[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery === "") return files;
  return files.filter((file) => file.path.toLocaleLowerCase().includes(normalizedQuery));
}

export function filterReviewFileJumpResults(
  files: readonly WorkspaceFileDiffView[],
  query: string,
  limit = 50
): { readonly results: readonly ReviewFileJumpResult[]; readonly overflowCount: number } {
  const matched = filterReviewFiles(files, query);
  const results = matched.slice(0, limit).map((file): ReviewFileJumpResult => {
    const parts = file.path.split("/").filter(Boolean);
    const fileName = parts.pop() ?? file.path;
    return {
      file,
      key: reviewFileKey(file),
      fileName,
      directory: parts.join("/")
    };
  });
  return { results, overflowCount: Math.max(0, matched.length - results.length) };
}

export function flattenReviewDiffTree(
  nodes: readonly ReviewDiffTreeNode[],
  collapsedDirectoryPaths: ReadonlySet<string>
): readonly ReviewDiffTreeFlatNode[] {
  const flattened: ReviewDiffTreeFlatNode[] = [];
  const visit = (items: readonly ReviewDiffTreeNode[], depth: number): void => {
    for (const node of items) {
      flattened.push({ node, depth });
      if (node.kind === "directory" && !collapsedDirectoryPaths.has(node.path)) {
        visit(node.children, depth + 1);
      }
    }
  };
  visit(nodes, 0);
  return flattened;
}

export function moveReviewFileJumpSelection(
  currentIndex: number,
  direction: 1 | -1,
  resultCount: number
): number {
  if (resultCount <= 0) return -1;
  if (currentIndex < 0 || currentIndex >= resultCount) return direction > 0 ? 0 : resultCount - 1;
  return (currentIndex + direction + resultCount) % resultCount;
}

export function buildReviewSplitRows(hunk: WorkspaceDiffHunkView): readonly ReviewSplitRow[] {
  const rows: ReviewSplitRow[] = [];
  const lines = hunk.lines;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.kind === "context") {
      rows.push({ key: `context:${index}`, left: line, right: line });
      index += 1;
      continue;
    }
    if (line.kind === "noNewline") {
      rows.push({ key: `marker:${index}`, left: line, right: line });
      index += 1;
      continue;
    }
    const removed: WorkspaceDiffHunkView["lines"][number][] = [];
    const added: WorkspaceDiffHunkView["lines"][number][] = [];
    const start = index;
    while (index < lines.length && lines[index]!.kind !== "context" && lines[index]!.kind !== "noNewline") {
      const changed = lines[index]!;
      if (changed.kind === "removed") removed.push(changed);
      else if (changed.kind === "added") added.push(changed);
      index += 1;
    }
    const count = Math.max(removed.length, added.length);
    for (let offset = 0; offset < count; offset += 1) {
      rows.push({
        key: `change:${start}:${offset}`,
        ...(removed[offset] === undefined ? {} : { left: removed[offset] }),
        ...(added[offset] === undefined ? {} : { right: added[offset] })
      });
    }
  }
  return rows;
}

export function inlineWordDiff(before: string, after: string): {
  readonly before: readonly InlineWordSegment[];
  readonly after: readonly InlineWordSegment[];
} {
  const left = tokenize(before);
  const right = tokenize(after);
  if (left.length === 0 && right.length === 0) return { before: [], after: [] };
  if (left.length > 160 || right.length > 160) {
    return {
      before: before === "" ? [] : [{ text: before, changed: true }],
      after: after === "" ? [] : [{ text: after, changed: true }]
    };
  }
  const width = right.length + 1;
  const table = new Uint16Array((left.length + 1) * width);
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      table[leftIndex * width + rightIndex] = left[leftIndex] === right[rightIndex]
        ? table[(leftIndex + 1) * width + rightIndex + 1]! + 1
        : Math.max(table[(leftIndex + 1) * width + rightIndex]!, table[leftIndex * width + rightIndex + 1]!);
    }
  }
  const beforeSegments: InlineWordSegment[] = [];
  const afterSegments: InlineWordSegment[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length || rightIndex < right.length) {
    if (leftIndex < left.length && rightIndex < right.length && left[leftIndex] === right[rightIndex]) {
      appendSegment(beforeSegments, left[leftIndex]!, false);
      appendSegment(afterSegments, right[rightIndex]!, false);
      leftIndex += 1;
      rightIndex += 1;
    } else if (
      rightIndex < right.length &&
      (leftIndex >= left.length || table[leftIndex * width + rightIndex + 1]! >= table[(leftIndex + 1) * width + rightIndex]!)
    ) {
      appendSegment(afterSegments, right[rightIndex]!, true);
      rightIndex += 1;
    } else {
      appendSegment(beforeSegments, left[leftIndex]!, true);
      leftIndex += 1;
    }
  }
  return { before: beforeSegments, after: afterSegments };
}

export function isReviewMarkdownPath(path: string): boolean {
  return /(?:^|\/)README(?:\.[^/]*)?$|\.(?:md|markdown|mdown|mkd)$/iu.test(path);
}

export function isPreviewableReviewImagePath(path: string | undefined): boolean {
  return path !== undefined && reviewImageMimeType(path) !== undefined;
}

export function isPreviewableReviewImageDiff(
  file: Pick<WorkspaceFileDiffView, "binary" | "oldPath" | "path">
): boolean {
  return file.binary && (
    isPreviewableReviewImagePath(file.path) ||
    isPreviewableReviewImagePath(file.oldPath)
  );
}

export function isSafeReviewRef(value: string, allowHead: boolean): boolean {
  if (value === "" || value.length > 300 || value.startsWith("-") || value === "@") return false;
  if (value === "HEAD") return allowHead;
  if (/^[0-9a-f]{40,64}$/iu.test(value)) return true;
  if (/[\0-\x20\x7f]/u.test(value)) return false;
  if (value.includes("\\") || value.includes("..") || value.includes("@{")) return false;
  if (/[~^:?*\[]/u.test(value) || value.includes("//") || value.endsWith("/") || value.endsWith(".")) return false;
  return true;
}

function tokenize(value: string): readonly string[] {
  return value.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+/gu) ?? [];
}

function appendSegment(target: InlineWordSegment[], text: string, changed: boolean): void {
  const previous = target.at(-1);
  if (previous?.changed === changed) target[target.length - 1] = { text: previous.text + text, changed };
  else target.push({ text, changed });
}
