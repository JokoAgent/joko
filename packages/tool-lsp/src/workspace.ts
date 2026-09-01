import {
  lstatSync,
  readFileSync,
  realpathSync,
  type Dirent,
  type Stats
} from "node:fs";
import { lstat, opendir, readFile, realpath } from "node:fs/promises";
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep
} from "node:path";
import ts from "typescript";

import { LspToolError } from "./errors.js";
import {
  isGitIgnored,
  isHardExcludedDirectory,
  parseGitIgnore,
  type GitIgnoreRule
} from "./gitignore.js";
import { LspOperationControl } from "./operation.js";
import type { LspPosition, LspRange } from "./types.js";

export const MAXIMUM_LSP_FILE_BYTES = 10 * 1024 * 1024;
export const MAXIMUM_LSP_WORKSPACE_FILES = 100_000;
export const MAXIMUM_LSP_OUTPUT_CHARACTERS = 100_000;

const MAXIMUM_GITIGNORE_BYTES = 1024 * 1024;
const MAXIMUM_PUBLIC_PATH_CHARACTERS = 32_768;
const SUPPORTED_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);

export interface TypeScriptWorkspaceOptions {
  readonly maximumFiles: number;
}

export interface ResolvedLspPosition {
  readonly fileName: string;
  readonly text: string;
  readonly offset: number;
}

interface WorkspaceScan {
  readonly root: string;
  readonly files: readonly string[];
  readonly directories: readonly string[];
}

interface DirectoryWorkItem {
  readonly absolute: string;
  readonly relative: string;
  readonly inheritedRules: readonly GitIgnoreRule[];
}

export class TypeScriptWorkspace {
  readonly root: string;
  readonly #files: readonly string[];
  readonly #fileByKey: ReadonlyMap<string, string>;
  readonly #host: GovernedLanguageServiceHost;
  readonly #service: ts.LanguageService;
  #disposed = false;

  private constructor(scan: WorkspaceScan) {
    this.root = scan.root;
    this.#files = scan.files;
    this.#fileByKey = new Map(scan.files.map((fileName) => [pathKey(fileName), fileName]));
    this.#host = new GovernedLanguageServiceHost(scan);
    this.#service = ts.createLanguageService(this.#host, ts.createDocumentRegistry());
  }

  static async create(
    workspaceRoot: string,
    options: TypeScriptWorkspaceOptions,
    control: LspOperationControl
  ): Promise<TypeScriptWorkspace> {
    const root = await validateWorkspaceRoot(workspaceRoot, control);
    const scan = await scanWorkspace(root, options.maximumFiles, control);
    return new TypeScriptWorkspace(scan);
  }

  run<T>(control: LspOperationControl, operation: (service: ts.LanguageService) => T): T {
    if (this.#disposed) throw new LspToolError("INTERNAL", "The LSP workspace has been disposed.");
    control.check();
    this.#host.touch();
    return this.#host.run(control, () => {
      const result = operation(this.#service);
      control.check();
      return result;
    });
  }

  resolvePosition(
    file: string,
    line: number,
    column: number,
    control: LspOperationControl
  ): ResolvedLspPosition {
    const resolved = this.resolveFile(file, control);
    validateOneBasedCoordinate(line, "line");
    validateOneBasedCoordinate(column, "column");
    const starts = computeLineStarts(resolved.text);
    if (line > starts.length) {
      throw new LspToolError("POSITION_OUT_OF_RANGE", "The requested line is outside the file.", {
        field: "line",
        maximum: starts.length
      });
    }
    const lineStart = starts[line - 1] as number;
    const nextLineStart = starts[line];
    let contentEnd = nextLineStart ?? resolved.text.length;
    while (contentEnd > lineStart && (resolved.text[contentEnd - 1] === "\n" ||
      resolved.text[contentEnd - 1] === "\r" || resolved.text[contentEnd - 1] === "\u2028" ||
      resolved.text[contentEnd - 1] === "\u2029")) {
      contentEnd -= 1;
    }
    const maximumColumn = contentEnd - lineStart + 1;
    if (column > maximumColumn) {
      throw new LspToolError("POSITION_OUT_OF_RANGE", "The requested column is outside the line.", {
        field: "column",
        maximum: maximumColumn
      });
    }
    return Object.freeze({
      ...resolved,
      offset: lineStart + column - 1
    });
  }

  resolveFile(
    file: string,
    control: LspOperationControl
  ): { readonly fileName: string; readonly text: string } {
    control.check();
    const candidate = resolvePublicFilePath(this.root, file);
    let info: Stats;
    try {
      info = lstatSync(candidate);
    } catch (error) {
      if (isMissing(error)) throw new LspToolError("FILE_NOT_FOUND", "The requested source file does not exist.");
      throw new LspToolError("FILE_UNSAFE", "The requested source file could not be inspected safely.");
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new LspToolError("FILE_UNSAFE", "The requested source path must be an ordinary non-symlink file.");
    }
    if (info.size > MAXIMUM_LSP_FILE_BYTES) {
      throw new LspToolError("FILE_TOO_LARGE", "The requested source file exceeds the 10 MiB limit.", {
        maximumBytes: MAXIMUM_LSP_FILE_BYTES
      });
    }
    if (!isSupportedSourceFile(candidate)) {
      throw new LspToolError("UNSUPPORTED_FILE", "The requested file is not a supported TypeScript or JavaScript source file.");
    }
    const canonical = checkedRealpathSync(candidate, this.root, "FILE_UNSAFE");
    const indexed = this.#fileByKey.get(pathKey(canonical));
    if (indexed === undefined) {
      throw new LspToolError("FILE_IGNORED", "The requested source file is excluded from the workspace index.");
    }
    const text = readTrustedRegularFileSync(indexed, this.root, MAXIMUM_LSP_FILE_BYTES, control);
    return Object.freeze({ fileName: indexed, text });
  }

  indexedText(fileName: string, control: LspOperationControl): string | undefined {
    const indexed = this.#fileByKey.get(pathKey(resolve(fileName)));
    if (indexed === undefined) return undefined;
    try {
      return readTrustedRegularFileSync(indexed, this.root, MAXIMUM_LSP_FILE_BYTES, control);
    } catch {
      return undefined;
    }
  }

  publicPath(fileName: string): string | undefined {
    const indexed = this.#fileByKey.get(pathKey(resolve(fileName)));
    if (indexed === undefined) return undefined;
    const result = relative(this.root, indexed).replaceAll("\\", "/");
    return result === "" || result.startsWith("../") ? undefined : result;
  }

  files(): readonly string[] {
    return this.#files;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#service.dispose();
  }
}

export function rangeFromTextSpan(
  text: string,
  span: ts.TextSpan,
  lineStarts: readonly number[] = computeLineStarts(text)
): LspRange | undefined {
  if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.length) ||
    span.start < 0 || span.length < 0 || span.start + span.length > text.length) return undefined;
  return Object.freeze({
    start: positionFromOffset(text, span.start, lineStarts),
    end: positionFromOffset(text, span.start + span.length, lineStarts)
  });
}

export function splitModifiers(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === "") return Object.freeze([]);
  return Object.freeze(value.split(",").map((item) => item.trim()).filter((item) => item !== ""));
}

async function validateWorkspaceRoot(
  workspaceRoot: string,
  control: LspOperationControl
): Promise<string> {
  control.check();
  if (typeof workspaceRoot !== "string" || workspaceRoot.length < 1 ||
    workspaceRoot.length > MAXIMUM_PUBLIC_PATH_CHARACTERS || workspaceRoot.includes("\0") ||
    !isAbsolute(workspaceRoot) || resolve(workspaceRoot) !== workspaceRoot) {
    throw new LspToolError("INVALID_ARGUMENT", "workspaceRoot must be a normalized absolute path.", {
      field: "workspaceRoot"
    });
  }
  let before: Stats;
  try {
    before = await lstat(workspaceRoot);
  } catch (error) {
    if (isMissing(error)) throw new LspToolError("WORKSPACE_NOT_FOUND", "The workspace root does not exist.");
    throw new LspToolError("WORKSPACE_UNSAFE", "The workspace root could not be inspected safely.");
  }
  control.check();
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new LspToolError("WORKSPACE_UNSAFE", "The workspace root must be an ordinary non-symlink directory.");
  }
  let canonical: string;
  try {
    canonical = await realpath(workspaceRoot);
  } catch {
    throw new LspToolError("WORKSPACE_UNSAFE", "The workspace root could not be resolved safely.");
  }
  if (!samePath(canonical, workspaceRoot)) {
    throw new LspToolError("WORKSPACE_UNSAFE", "The workspace root must not contain path aliases or symlinks.");
  }
  const after = await lstat(workspaceRoot).catch(() => undefined);
  if (after === undefined || !after.isDirectory() || after.isSymbolicLink() || !sameFile(before, after)) {
    throw new LspToolError("WORKSPACE_UNSAFE", "The workspace root changed during validation.");
  }
  control.check();
  return canonical;
}

async function scanWorkspace(
  root: string,
  maximumFiles: number,
  control: LspOperationControl
): Promise<WorkspaceScan> {
  const files: string[] = [];
  const directories: string[] = [root];
  const queue: DirectoryWorkItem[] = [{ absolute: root, relative: "", inheritedRules: [] }];
  let sourceFileCount = 0;
  let cursor = 0;
  while (cursor < queue.length) {
    control.check();
    const item = queue[cursor] as DirectoryWorkItem;
    cursor += 1;
    const localRules = await readDirectoryIgnoreRules(item, root, control);
    const rules = localRules.length === 0
      ? item.inheritedRules
      : Object.freeze([...item.inheritedRules, ...localRules]);
    for await (const entry of readWorkspaceDirectoryEntries(item.absolute, control)) {
      if (entry.name === ".gitignore") continue;
      const absolute = resolve(item.absolute, entry.name);
      if (!isWithin(absolute, root)) {
        throw new LspToolError("WORKSPACE_UNSAFE", "A workspace entry escaped its root.");
      }
      const relativePath = relative(root, absolute).replaceAll("\\", "/");
      let info: Stats;
      try {
        info = await lstat(absolute);
      } catch (error) {
        if (isMissing(error)) continue;
        throw new LspToolError("WORKSPACE_UNSAFE", "A workspace entry could not be inspected safely.");
      }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        if (isHardExcludedDirectory(entry.name) || isGitIgnored(relativePath, true, rules)) continue;
        const canonical = await realpath(absolute).catch(() => undefined);
        if (canonical === undefined || !samePath(canonical, absolute) || !isWithin(canonical, root)) {
          throw new LspToolError("WORKSPACE_UNSAFE", "A workspace directory contains an unsafe path alias.");
        }
        directories.push(canonical);
        if (directories.length > maximumFiles) {
          throw new LspToolError("FILE_LIMIT_EXCEEDED", "The workspace directory count exceeds its safe limit.", {
            maximum: maximumFiles
          });
        }
        queue.push({ absolute: canonical, relative: relativePath, inheritedRules: rules });
        continue;
      }
      if (!info.isFile() || isGitIgnored(relativePath, false, rules) || !isSupportedSourceFile(absolute)) continue;
      sourceFileCount += 1;
      if (sourceFileCount > maximumFiles) {
        throw new LspToolError("FILE_LIMIT_EXCEEDED", "The workspace source-file count exceeds its safe limit.", {
          maximum: maximumFiles
        });
      }
      if (info.size > MAXIMUM_LSP_FILE_BYTES) continue;
      const canonical = await realpath(absolute).catch(() => undefined);
      if (canonical === undefined || !samePath(canonical, absolute) || !isWithin(canonical, root)) {
        throw new LspToolError("WORKSPACE_UNSAFE", "A workspace file contains an unsafe path alias.");
      }
      const after = await lstat(absolute).catch(() => undefined);
      if (after === undefined || !after.isFile() || after.isSymbolicLink() || !sameStableFile(info, after)) {
        throw new LspToolError("WORKSPACE_UNSAFE", "A workspace file changed during indexing.");
      }
      files.push(canonical);
    }
  }
  files.sort(comparePaths);
  directories.sort(comparePaths);
  return Object.freeze({ root, files: Object.freeze(files), directories: Object.freeze(directories) });
}

async function* readWorkspaceDirectoryEntries(
  path: string,
  control: LspOperationControl
): AsyncGenerator<Dirent> {
  try {
    const directory = await opendir(path);
    for await (const entry of directory) {
      control.check();
      yield entry;
    }
  } catch (error) {
    if (error instanceof LspToolError) throw error;
    throw new LspToolError("WORKSPACE_UNSAFE", "A workspace directory could not be read safely.");
  }
}

async function readDirectoryIgnoreRules(
  item: DirectoryWorkItem,
  root: string,
  control: LspOperationControl
): Promise<readonly GitIgnoreRule[]> {
  const path = resolve(item.absolute, ".gitignore");
  let before: Stats;
  try {
    before = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return Object.freeze([]);
    throw new LspToolError("WORKSPACE_UNSAFE", "A .gitignore file could not be inspected safely.");
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAXIMUM_GITIGNORE_BYTES) {
    throw new LspToolError("WORKSPACE_UNSAFE", "A .gitignore entry is not a bounded ordinary file.");
  }
  const canonical = await realpath(path).catch(() => undefined);
  if (canonical === undefined || !samePath(canonical, path) || !isWithin(canonical, root)) {
    throw new LspToolError("WORKSPACE_UNSAFE", "A .gitignore file contains an unsafe path alias.");
  }
  const bytes = await readFile(path).catch(() => undefined);
  control.check();
  if (bytes === undefined || bytes.byteLength > MAXIMUM_GITIGNORE_BYTES) {
    throw new LspToolError("WORKSPACE_UNSAFE", "A .gitignore file could not be read within its size limit.");
  }
  const after = await lstat(path).catch(() => undefined);
  if (after === undefined || !after.isFile() || after.isSymbolicLink() || !sameStableFile(before, after)) {
    throw new LspToolError("WORKSPACE_UNSAFE", "A .gitignore file changed during indexing.");
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new LspToolError("WORKSPACE_UNSAFE", "A .gitignore file is not valid UTF-8.");
  } finally {
    bytes.fill(0);
  }
  return parseGitIgnore(source, item.relative);
}

class GovernedLanguageServiceHost implements ts.LanguageServiceHost {
  readonly #root: string;
  readonly #files: readonly string[];
  readonly #fileByKey: ReadonlyMap<string, string>;
  readonly #directoryByKey: ReadonlyMap<string, string>;
  readonly #compilerOptions: ts.CompilerOptions;
  readonly #libraryRoot: string;
  #activeControl: LspOperationControl | undefined;
  #projectVersion = 0;

  constructor(scan: WorkspaceScan) {
    this.#root = scan.root;
    this.#files = scan.files;
    this.#fileByKey = new Map(scan.files.map((fileName) => [pathKey(fileName), fileName]));
    this.#directoryByKey = new Map(scan.directories.map((directory) => [pathKey(directory), directory]));
    this.#compilerOptions = Object.freeze({
      allowJs: true,
      allowNonTsExtensions: false,
      checkJs: false,
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.NodeNext,
      moduleDetection: ts.ModuleDetectionKind.Force,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      resolveJsonModule: false,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2023,
      types: []
    });
    this.#libraryRoot = dirname(ts.getDefaultLibFilePath(this.#compilerOptions));
  }

  run<T>(control: LspOperationControl, operation: () => T): T {
    if (this.#activeControl !== undefined) {
      throw new LspToolError("INTERNAL", "Concurrent operations are not allowed on one LSP workspace.");
    }
    this.#activeControl = control;
    try {
      return operation();
    } finally {
      this.#activeControl = undefined;
    }
  }

  touch(): void {
    this.#projectVersion += 1;
  }

  getCompilationSettings(): ts.CompilerOptions {
    return this.#compilerOptions;
  }

  getScriptFileNames(): string[] {
    this.check();
    return [...this.#files];
  }

  getScriptVersion(fileName: string): string {
    this.check();
    const accepted = this.acceptedFile(fileName);
    if (accepted === undefined) return "missing";
    try {
      const info = lstatSync(accepted);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAXIMUM_LSP_FILE_BYTES) return "unsafe";
      return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    } catch {
      return "missing";
    }
  }

  getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
    this.check();
    const accepted = this.acceptedFile(fileName);
    if (accepted === undefined) return undefined;
    try {
      const boundary = this.#fileByKey.has(pathKey(accepted)) ? this.#root : this.#libraryRoot;
      return ts.ScriptSnapshot.fromString(
        readTrustedRegularFileSync(accepted, boundary, MAXIMUM_LSP_FILE_BYTES, this.#activeControl)
      );
    } catch {
      return undefined;
    }
  }

  getCurrentDirectory(): string {
    return this.#root;
  }

  getDefaultLibFileName(options: ts.CompilerOptions): string {
    return ts.getDefaultLibFilePath(options);
  }

  getProjectVersion(): string {
    return String(this.#projectVersion);
  }

  getCancellationToken(): ts.HostCancellationToken {
    return { isCancellationRequested: () => this.#activeControl?.cancellationRequested() ?? false };
  }

  useCaseSensitiveFileNames(): boolean {
    return ts.sys.useCaseSensitiveFileNames;
  }

  getScriptKind(fileName: string): ts.ScriptKind {
    switch (extname(fileName).toLowerCase()) {
    case ".js":
    case ".mjs":
    case ".cjs": return ts.ScriptKind.JS;
    case ".jsx": return ts.ScriptKind.JSX;
    case ".tsx": return ts.ScriptKind.TSX;
    default: return ts.ScriptKind.TS;
    }
  }

  fileExists(fileName: string): boolean {
    this.check();
    return this.acceptedFile(fileName) !== undefined;
  }

  readFile(fileName: string): string | undefined {
    const snapshot = this.getScriptSnapshot(fileName);
    return snapshot?.getText(0, snapshot.getLength());
  }

  directoryExists(directoryName: string): boolean {
    this.check();
    const candidate = resolve(directoryName);
    if (this.#directoryByKey.has(pathKey(candidate))) return isOrdinaryDirectorySync(candidate, this.#root);
    return isWithin(candidate, this.#libraryRoot) && isOrdinaryDirectorySync(candidate, this.#libraryRoot);
  }

  getDirectories(directoryName: string): string[] {
    this.check();
    const candidate = resolve(directoryName);
    if (!this.directoryExists(candidate)) return [];
    const result: string[] = [];
    for (const directory of this.#directoryByKey.values()) {
      if (samePath(dirname(directory), candidate)) result.push(directory);
    }
    return result.sort(comparePaths);
  }

  readDirectory(
    path: string,
    extensions?: readonly string[],
    _exclude?: readonly string[],
    _include?: readonly string[],
    depth?: number
  ): string[] {
    this.check();
    const root = resolve(path);
    if (!isWithin(root, this.#root)) return [];
    const maximumDepth = depth ?? Number.POSITIVE_INFINITY;
    return this.#files.filter((fileName) => {
      if (!isWithin(fileName, root)) return false;
      const relativeName = relative(root, fileName);
      const fileDepth = relativeName.split(sep).length - 1;
      return fileDepth <= maximumDepth &&
        (extensions === undefined || extensions.some((extension) => fileName.endsWith(extension)));
    });
  }

  realpath(path: string): string {
    const accepted = this.acceptedFile(path);
    return accepted ?? resolve(path);
  }

  private acceptedFile(fileName: string): string | undefined {
    const candidate = resolve(fileName);
    const indexed = this.#fileByKey.get(pathKey(candidate));
    if (indexed !== undefined && isOrdinaryFileSync(indexed, this.#root)) return indexed;
    if (!isWithin(candidate, this.#libraryRoot) || !candidate.toLowerCase().endsWith(".d.ts")) return undefined;
    return isOrdinaryFileSync(candidate, this.#libraryRoot) ? candidate : undefined;
  }

  private check(): void {
    this.#activeControl?.check();
  }
}

function resolvePublicFilePath(root: string, file: string): string {
  if (typeof file !== "string" || file.length < 1 || file.length > MAXIMUM_PUBLIC_PATH_CHARACTERS || file.includes("\0")) {
    throw new LspToolError("INVALID_ARGUMENT", "file must be a non-empty bounded path.", { field: "file" });
  }
  const candidate = isAbsolute(file) ? resolve(file) : resolve(root, file);
  if (!isWithin(candidate, root) || samePath(candidate, root)) {
    throw new LspToolError("PATH_OUTSIDE_WORKSPACE", "The requested file must stay inside the workspace root.");
  }
  return candidate;
}

function validateOneBasedCoordinate(value: number, field: "column" | "line"): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new LspToolError("INVALID_ARGUMENT", `${field} must be a positive one-based integer.`, { field });
  }
}

function positionFromOffset(text: string, offset: number, starts: readonly number[]): LspPosition {
  let lower = 0;
  let upper = starts.length - 1;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const start = starts[middle] as number;
    const next = starts[middle + 1] ?? Number.POSITIVE_INFINITY;
    if (offset < start) upper = middle - 1;
    else if (offset >= next) lower = middle + 1;
    else return Object.freeze({ line: middle + 1, column: offset - start + 1 });
  }
  const last = starts.at(-1) ?? 0;
  return Object.freeze({ line: starts.length, column: offset - last + 1 });
}

function readTrustedRegularFileSync(
  path: string,
  boundary: string,
  maximumBytes: number,
  control?: LspOperationControl
): string {
  control?.check();
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("unsafe file");
  if (before.size > maximumBytes) throw new Error("oversized file");
  const canonical = realpathSync(path);
  if (!samePath(canonical, path) || !isWithin(canonical, boundary)) throw new Error("unsafe path");
  const bytes = readFileSync(path);
  control?.check();
  const after = lstatSync(path);
  if (bytes.byteLength !== before.size || !after.isFile() || after.isSymbolicLink() ||
    !sameStableFile(before, after) || !samePath(realpathSync(path), path)) throw new Error("unstable file");
  return decodeSource(bytes);
}

export function computeLineStarts(text: string): readonly number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charCodeAt(index);
    if (character === 13) {
      if (text.charCodeAt(index + 1) === 10) index += 1;
      starts.push(index + 1);
    } else if (character === 10 || character === 0x2028 || character === 0x2029) {
      starts.push(index + 1);
    }
  }
  return starts;
}

function decodeSource(bytes: Buffer): string {
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString("utf16le");
  }
  if (bytes.byteLength >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const copy = Buffer.from(bytes.subarray(2));
    for (let index = 0; index + 1 < copy.length; index += 2) {
      const first = copy[index] as number;
      copy[index] = copy[index + 1] as number;
      copy[index + 1] = first;
    }
    return copy.toString("utf16le");
  }
  const source = bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    ? bytes.subarray(3)
    : bytes;
  return new TextDecoder("utf-8", { fatal: true }).decode(source);
}

function isOrdinaryFileSync(path: string, boundary: string): boolean {
  try {
    const info = lstatSync(path);
    return info.isFile() && !info.isSymbolicLink() && info.size <= MAXIMUM_LSP_FILE_BYTES &&
      samePath(realpathSync(path), path) && isWithin(path, boundary);
  } catch {
    return false;
  }
}

function isOrdinaryDirectorySync(path: string, boundary: string): boolean {
  try {
    const info = lstatSync(path);
    return info.isDirectory() && !info.isSymbolicLink() && samePath(realpathSync(path), path) && isWithin(path, boundary);
  } catch {
    return false;
  }
}

function checkedRealpathSync(path: string, root: string, code: "FILE_UNSAFE"): string {
  try {
    const canonical = realpathSync(path);
    if (!samePath(canonical, path) || !isWithin(canonical, root)) throw new Error("unsafe alias");
    return canonical;
  } catch {
    throw new LspToolError(code, "The requested source file contains an unsafe path alias.");
  }
}

function isSupportedSourceFile(path: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(path).toLowerCase());
}

function sameStableFile(left: Stats, right: Stats): boolean {
  return sameFile(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function sameFile(left: Stats, right: Stats): boolean {
  if (left.dev !== right.dev) return false;
  if (left.ino !== 0 || right.ino !== 0) return left.ino === right.ino;
  return left.birthtimeMs === right.birthtimeMs && left.ctimeMs === right.ctimeMs;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function pathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isWithin(candidate: string, root: string): boolean {
  const candidateKey = pathKey(candidate);
  const rootKey = pathKey(root);
  return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}${sep}`);
}

function comparePaths(left: string, right: string): number {
  return pathKey(left).localeCompare(pathKey(right), "en");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
