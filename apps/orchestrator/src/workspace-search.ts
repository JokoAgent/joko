import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";

/** Hard project-file index ceiling. */
export const WORKSPACE_FILE_INDEX_CAP = 30_000;
/** Count ripgrep JSON match records (matching lines), not submatches. */
export const WORKSPACE_SEARCH_MAX_MATCHES = 1_000;
const WORKSPACE_SEARCH_MAX_MATCHES_PER_FILE = 200;
const KILL_GRACE_MS = 200;

// This whitelist is the single product-owned text-file surface. Search is a product capability,
// not an arbitrary ripgrep pass over PDFs, Office documents, or binaries.
export const WORKSPACE_SUPPORTED_TEXT_EXTENSIONS = [
  ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java",
  ".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hh", ".cs", ".rb", ".php",
  ".swift", ".kt", ".kts", ".scala", ".groovy", ".coffee",
  ".lua", ".dart", ".r", ".pl", ".pm", ".ex", ".exs", ".elm",
  ".clj", ".cljs", ".cljc", ".fs", ".fsi", ".fsx", ".ml", ".mli",
  ".hs", ".erl", ".hrl", ".zig", ".nim", ".vim", ".applescript",
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".psm1", ".bat", ".cmd",
  ".html", ".htm", ".xhtml", ".css", ".scss", ".sass", ".less", ".styl",
  ".vue", ".svelte", ".astro", ".svg",
  ".json", ".json5", ".jsonc", ".jsonl", ".ndjson", ".geojson",
  ".yaml", ".yml", ".xml", ".toml", ".ini", ".conf", ".cfg", ".properties",
  ".plist", ".tf", ".tfvars", ".hcl", ".gradle", ".cmake", ".mk", ".mak",
  ".lock", ".csv", ".tsv",
  ".md", ".markdown", ".mdx", ".rst", ".tex", ".bib", ".cls", ".sty",
  ".adoc", ".asciidoc", ".org", ".txt", ".text",
  ".log", ".diff", ".patch", ".srt", ".vtt", ".po", ".pot",
  ".sln", ".csproj", ".vbproj", ".fsproj", ".gemspec", ".podspec", ".cabal",
  ".sql", ".graphql", ".proto", ".dockerfile", ".rss", ".atom",
  ".gitignore", ".gitattributes", ".gitconfig", ".gitmodules", ".gitkeep",
  ".dockerignore", ".eslintignore", ".prettierignore", ".npmignore",
  ".editorconfig", ".env", ".env.local", ".env.development", ".env.production", ".env.example",
  ".prettierrc", ".eslintrc", ".babelrc", ".npmrc", ".yarnrc",
  ".stylelintrc", ".huskyrc", ".lintstagedrc", ".browserslistrc",
  ".nvmrc", ".node-version", ".python-version", ".ruby-version", ".tool-versions"
] as const;

export const WORKSPACE_KNOWN_TEXT_FILENAMES = [
  "dockerfile", "makefile", "gemfile", "rakefile", "procfile", "vagrantfile", "jenkinsfile", "cmakelists"
] as const;

export interface WorkspaceFileIndex {
  readonly paths: readonly string[];
  readonly truncated: boolean;
  readonly revision: string;
}

export interface WorkspaceRipgrepMatch {
  readonly type: "match";
  readonly data: {
    readonly path: { readonly text: string };
    readonly lines: { readonly text: string };
    readonly line_number: number;
    readonly absolute_offset: number;
    readonly submatches: readonly { readonly start: number; readonly end: number }[];
  };
}

export type WorkspaceSearchProcessEvent =
  | { readonly kind: "match"; readonly match: WorkspaceRipgrepMatch }
  | {
      readonly kind: "end";
      readonly truncated: boolean;
      readonly totalMatches: number;
      readonly totalFiles: number;
    };

export function workspaceFileIndexArguments(): readonly string[] {
  return ["--files", "--hidden", "--no-messages", "--", "."];
}

export function workspaceTextSearchArguments(query: string, caseSensitive: boolean): readonly string[] {
  const args: string[] = [
    "--json",
    "-F",
    `--max-count=${WORKSPACE_SEARCH_MAX_MATCHES_PER_FILE}`,
    "--hidden"
  ];
  for (const extension of WORKSPACE_SUPPORTED_TEXT_EXTENSIONS) args.push("--glob", `*${extension}`);
  for (const filename of WORKSPACE_KNOWN_TEXT_FILENAMES) args.push("--iglob", filename);
  if (!caseSensitive) args.push("-i");
  args.push("--", query, ".");
  return args;
}

export async function runWorkspaceFileIndex(input: {
  readonly executable: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly cap?: number;
}): Promise<WorkspaceFileIndex> {
  throwIfAborted(input.signal);
  const cap = input.cap ?? WORKSPACE_FILE_INDEX_CAP;
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > WORKSPACE_FILE_INDEX_CAP) {
    throw new Error(`Workspace file-index cap must be between 1 and ${WORKSPACE_FILE_INDEX_CAP}.`);
  }
  const process = openLineProcess(input.executable, workspaceFileIndexArguments(), input.cwd, input.signal);
  const paths: string[] = [];
  let truncated = false;
  try {
    for await (const raw of process.reader) {
      throwIfAborted(input.signal);
      const path = canonicalRipgrepRelativePath(raw);
      if (path === undefined) continue;
      paths.push(path);
      if (paths.length >= cap) {
        truncated = true;
        process.kill();
        break;
      }
    }
    const result = await process.completion;
    throwIfAborted(input.signal);
    if (!truncated) assertRipgrepExit(result);
    return {
      paths,
      truncated,
      revision: workspaceFileIndexRevision(paths, truncated)
    };
  } finally {
    await process.dispose();
  }
}

export async function* streamWorkspaceTextSearch(input: {
  readonly executable: string;
  readonly cwd: string;
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly signal?: AbortSignal;
  readonly maximumMatches?: number;
}): AsyncGenerator<WorkspaceSearchProcessEvent> {
  throwIfAborted(input.signal);
  const maximumMatches = input.maximumMatches ?? WORKSPACE_SEARCH_MAX_MATCHES;
  if (!Number.isSafeInteger(maximumMatches) || maximumMatches < 1 || maximumMatches > WORKSPACE_SEARCH_MAX_MATCHES) {
    throw new Error(`Workspace search maximumMatches must be between 1 and ${WORKSPACE_SEARCH_MAX_MATCHES}.`);
  }
  const process = openLineProcess(
    input.executable,
    workspaceTextSearchArguments(input.query, input.caseSensitive),
    input.cwd,
    input.signal
  );
  const seenFiles = new Set<string>();
  let matchCount = 0;
  let truncated = false;
  try {
    for await (const line of process.reader) {
      throwIfAborted(input.signal);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Treat non-JSON stdout as noise; rg diagnostics use stderr.
        continue;
      }
      const beginPath = ripgrepBeginPath(parsed);
      if (beginPath !== undefined) seenFiles.add(beginPath);
      if (!isWorkspaceRipgrepMatch(parsed)) continue;
      const matchPath = canonicalRipgrepRelativePath(parsed.data.path.text);
      if (matchPath !== undefined) seenFiles.add(matchPath);
      matchCount += 1;
      yield { kind: "match", match: parsed };
      if (matchCount >= maximumMatches) {
        truncated = true;
        process.kill();
        break;
      }
    }
    const result = await process.completion;
    throwIfAborted(input.signal);
    if (!truncated) assertRipgrepExit(result);
    yield {
      kind: "end",
      truncated,
      totalMatches: matchCount,
      totalFiles: seenFiles.size
    };
  } finally {
    await process.dispose();
  }
}

export function isWorkspaceRipgrepMatch(value: unknown): value is WorkspaceRipgrepMatch {
  if (!isUnknownRecord(value) || value["type"] !== "match" || !isUnknownRecord(value["data"])) return false;
  const data = value["data"];
  const path = data["path"];
  const lines = data["lines"];
  const submatches = data["submatches"];
  return isUnknownRecord(path)
    && typeof path["text"] === "string"
    && isUnknownRecord(lines)
    && typeof lines["text"] === "string"
    && typeof data["line_number"] === "number"
    && typeof data["absolute_offset"] === "number"
    && Array.isArray(submatches)
    && submatches.every((item) => isUnknownRecord(item) && typeof item["start"] === "number" && typeof item["end"] === "number");
}

function workspaceFileIndexRevision(paths: readonly string[], truncated: boolean): string {
  const hash = createHash("sha256");
  hash.update(truncated ? "truncated\0" : "complete\0");
  // Preserve ripgrep parallel traversal order for incremental filtering, but do not
  // let the same complete set acquire a new fence.
  for (const path of [...paths].sort(compareCodeUnits)) {
    hash.update(path);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalRipgrepRelativePath(raw: string): string | undefined {
  const normalized = raw.replace(/\\/gu, "/").replace(/^(?:\.\/)+/u, "");
  if (normalized === "" || normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)) return undefined;
  const parts = normalized.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || part.includes("\0"))) return undefined;
  return normalized;
}

function ripgrepBeginPath(value: unknown): string | undefined {
  if (!isUnknownRecord(value) || value["type"] !== "begin" || !isUnknownRecord(value["data"])) return undefined;
  const path = value["data"]["path"];
  return isUnknownRecord(path) && typeof path["text"] === "string"
    ? canonicalRipgrepRelativePath(path["text"])
    : undefined;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface LineProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}

interface LineProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly reader: ReadlineInterface;
  readonly completion: Promise<LineProcessResult>;
  readonly kill: () => void;
  readonly dispose: () => Promise<void>;
}

function openLineProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal | undefined
): LineProcess {
  const child = spawn(executable, [...args], { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end();
  const reader = createInterface({ input: child.stdout });
  const stderr: Buffer[] = [];
  let stderrBytes = 0;
  let settled = false;
  let killTimer: NodeJS.Timeout | undefined;
  let resolveCompletion: (result: LineProcessResult) => void = () => undefined;
  let rejectCompletion: (error: unknown) => void = () => undefined;
  const completion = new Promise<LineProcessResult>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderrBytes >= 1024 * 1024) return;
    stderr.push(chunk);
    stderrBytes += chunk.byteLength;
  });
  child.once("error", (error) => {
    if (settled) return;
    settled = true;
    rejectCompletion(error);
  });
  child.once("close", (exitCode, exitSignal) => {
    if (settled) return;
    settled = true;
    resolveCompletion({ exitCode, signal: exitSignal, stderr: Buffer.concat(stderr).toString("utf8") });
  });
  // An AsyncGenerator consumer may return immediately after a match. The
  // generator still owns and kills the child in finally; marking this branch
  // observed prevents a late spawn error becoming an unhandled rejection.
  void completion.catch(() => undefined);
  const kill = (): void => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { child.kill("SIGTERM"); } catch { /* best effort */ }
    killTimer ??= setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGKILL"); } catch { /* best effort */ }
      }
    }, KILL_GRACE_MS);
    killTimer.unref();
  };
  const abort = (): void => kill();
  signal?.addEventListener("abort", abort, { once: true });
  return {
    child,
    reader,
    completion,
    kill,
    dispose: async () => {
      signal?.removeEventListener("abort", abort);
      try { reader.close(); } catch { /* already closed */ }
      if (!settled) kill();
      try { await completion; } catch { /* the caller observes the primary failure */ }
      if (killTimer !== undefined) clearTimeout(killTimer);
    }
  };
}

function assertRipgrepExit(result: LineProcessResult): void {
  if (result.signal !== null) throw new Error(`ripgrep was terminated by ${result.signal}.`);
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    const details = result.stderr.trim();
    throw new Error(`ripgrep failed (${result.exitCode ?? "unknown"})${details === "" ? "" : `: ${details}`}`);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The operation was aborted.", "AbortError");
}
