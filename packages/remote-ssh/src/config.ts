import { constants as fsConstants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { RemoteSshError } from "./errors.js";
import type { RemoteSshConfigHost, RemoteSshOwnerScope } from "./types.js";

const DEFAULT_SSH_PORT = 22;
const MAXIMUM_CONFIG_BYTES = 8 * 1024 * 1024;

interface ParsedLine {
  readonly raw: string;
  readonly content: string;
  readonly eol: string;
  readonly start: number;
  readonly end: number;
  readonly directive?: ParsedDirective;
}

interface ParsedDirective {
  readonly name: string;
  readonly value: string;
  readonly indent: string;
  readonly spelling: string;
  readonly separator: string;
  readonly suffix: string;
}

interface HostBlock {
  readonly startLine: number;
  readonly endLine: number;
  readonly aliases: readonly string[];
}

interface ParsedDocument {
  readonly source: string;
  readonly newline: "\n" | "\r\n";
  readonly lines: readonly ParsedLine[];
  readonly blocks: readonly HostBlock[];
}

export interface ImportSshConfigOptions extends RemoteSshOwnerScope {
  readonly defaultUser: string;
}

export class SshConfigDocument {
  readonly #parsed: ParsedDocument;

  constructor(parsed: ParsedDocument) {
    this.#parsed = parsed;
  }

  toString(): string {
    return this.#parsed.source;
  }

  concreteHosts(options: ImportSshConfigOptions): readonly RemoteSshConfigHost[] {
    const scope = validateOwnerScope(options);
    const defaultUser = validateField(options.defaultUser, "defaultUser", 256);
    const hosts: RemoteSshConfigHost[] = [];
    for (const block of this.#parsed.blocks) {
      const directives = blockDirectives(this.#parsed, block);
      for (const alias of block.aliases) {
        if (!isConcreteAlias(alias)) continue;
        const hostname = firstDirective(directives, "hostname") ?? alias;
        const user = firstDirective(directives, "user") ?? defaultUser;
        const port = parseImportedPort(firstDirective(directives, "port"));
        hosts.push(Object.freeze({
          ...scope,
          id: alias,
          hostname,
          port,
          user,
          source: "ssh_config" as const
        }));
      }
    }
    return Object.freeze(hosts);
  }

  withHost(host: RemoteSshConfigHost): SshConfigDocument {
    const accepted = validateConfigHost(host);
    const matching = this.#parsed.blocks.filter((block) => block.aliases.includes(accepted.id));
    let source = this.#parsed.source;
    if (matching.length === 1 && matching[0]?.aliases.length === 1) {
      source = rewriteSingleHostBlock(this.#parsed, matching[0], accepted);
    } else {
      for (const block of [...matching].reverse()) {
        source = removeAliasFromBlock(parseDocument(source), blockAliasKey(block, accepted.id), accepted.id);
      }
      source = appendHostBlock(source, accepted, this.#parsed.newline);
    }
    return parseSshConfig(source);
  }

  withoutHost(alias: string): SshConfigDocument {
    const accepted = validateAlias(alias);
    let source = this.#parsed.source;
    while (true) {
      const parsed = parseDocument(source);
      const block = parsed.blocks.find((candidate) => candidate.aliases.includes(accepted));
      if (block === undefined) return parseSshConfig(parsed.source);
      source = removeAliasFromBlock(parsed, blockAliasKey(block, accepted), accepted);
    }
  }
}

export function defaultSshConfigPath(): string {
  return join(homedir(), ".ssh", "config");
}

export function parseSshConfig(source: string): SshConfigDocument {
  if (typeof source !== "string") {
    throw new RemoteSshError("CONFIG_INVALID", "The SSH config must be text.", false);
  }
  if (Buffer.byteLength(source, "utf8") > MAXIMUM_CONFIG_BYTES) {
    throw new RemoteSshError("CONFIG_INVALID", "The SSH config exceeds the supported size.", false);
  }
  return new SshConfigDocument(parseDocument(source));
}

export function serializeSshConfig(document: SshConfigDocument): string {
  if (!(document instanceof SshConfigDocument)) {
    throw new RemoteSshError("CONFIG_INVALID", "The SSH config document is invalid.", false);
  }
  return document.toString();
}

export interface SshConfigFilePort {
  read(): Promise<SshConfigDocument>;
  importHosts(options: ImportSshConfigOptions): Promise<readonly RemoteSshConfigHost[]>;
  upsert(host: RemoteSshConfigHost): Promise<void>;
  remove(alias: string): Promise<void>;
}

export interface FileSshConfigPortOptions {
  readonly filePath?: string;
}

export class FileSshConfigPort implements SshConfigFilePort {
  readonly #filePath: string;
  #mutation: Promise<void> = Promise.resolve();

  constructor(options: FileSshConfigPortOptions = {}) {
    this.#filePath = options.filePath ?? defaultSshConfigPath();
    if (this.#filePath.trim() === "") {
      throw new RemoteSshError("INVALID_ARGUMENT", "filePath must not be empty.", false);
    }
  }

  async read(): Promise<SshConfigDocument> {
    return parseSshConfig(await readConfigText(this.#filePath));
  }

  async importHosts(options: ImportSshConfigOptions): Promise<readonly RemoteSshConfigHost[]> {
    return (await this.read()).concreteHosts(options);
  }

  async upsert(host: RemoteSshConfigHost): Promise<void> {
    await this.mutate((document) => document.withHost(host));
  }

  async remove(alias: string): Promise<void> {
    await this.mutate((document) => document.withoutHost(alias));
  }

  private async mutate(transform: (document: SshConfigDocument) => SshConfigDocument): Promise<void> {
    const operation = this.#mutation.catch(() => undefined).then(async () => {
      await ensurePrivateParent(this.#filePath);
      const release = await acquireFileLock(`${this.#filePath}.joko.lock`, "CONFIG_CONFLICT");
      try {
        await assertSafeConfigTarget(this.#filePath);
        const current = parseSshConfig(await readConfigText(this.#filePath));
        const next = transform(current);
        if (next.toString() === current.toString()) return;
        await writeFileAtomic(this.#filePath, next.toString(), "CONFIG_IO");
      } finally {
        await release();
      }
    });
    this.#mutation = operation;
    await operation;
  }
}

function parseDocument(source: string): ParsedDocument {
  const lines = splitLines(source);
  const blocks: HostBlock[] = [];
  let open: { startLine: number; aliases: readonly string[] } | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const directive = lines[index]?.directive;
    if (directive === undefined) continue;
    const name = directive.name.toLowerCase();
    if (name === "host") {
      if (open !== undefined) blocks.push({ ...open, endLine: index });
      const aliases = tokenizeDirectiveValue(directive.value, "Host");
      if (aliases.length === 0) {
        throw new RemoteSshError("CONFIG_INVALID", "A Host directive has no patterns.", false);
      }
      open = { startLine: index, aliases };
    } else if (name === "match" && open !== undefined) {
      blocks.push({ ...open, endLine: index });
      open = undefined;
    }
  }
  if (open !== undefined) blocks.push({ ...open, endLine: lines.length });
  return {
    source,
    newline: source.includes("\r\n") ? "\r\n" : "\n",
    lines,
    blocks
  };
}

function splitLines(source: string): readonly ParsedLine[] {
  const lines: ParsedLine[] = [];
  let start = 0;
  while (start < source.length) {
    const newline = source.indexOf("\n", start);
    const end = newline === -1 ? source.length : newline + 1;
    const raw = source.slice(start, end);
    const eol = raw.endsWith("\r\n") ? "\r\n" : raw.endsWith("\n") ? "\n" : "";
    const content = eol === "" ? raw : raw.slice(0, -eol.length);
    const directive = parseDirectiveLine(content);
    lines.push({
      raw,
      content,
      eol,
      start,
      end,
      ...(directive === undefined ? {} : { directive })
    });
    start = end;
  }
  return lines;
}

function parseDirectiveLine(content: string): ParsedDirective | undefined {
  const match = /^(\s*)([A-Za-z][A-Za-z0-9-]*)(\s*=\s*|\s+)(.*)$/u.exec(content);
  if (match === null) return undefined;
  const parsedValue = splitDirectiveValue(match[4] ?? "");
  return {
    indent: match[1] ?? "",
    spelling: match[2] ?? "",
    name: match[2] ?? "",
    separator: match[3] ?? " ",
    value: parsedValue.value,
    suffix: parsedValue.suffix
  };
}

function splitDirectiveValue(value: string): { readonly value: string; readonly suffix: string } {
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }
    if (character === "#" && (index === 0 || /\s/u.test(value[index - 1] ?? ""))) {
      const before = value.slice(0, index);
      const trimmed = before.trim();
      return { value: trimmed, suffix: `${before.slice(before.trimEnd().length)}${value.slice(index)}` };
    }
  }
  return { value: value.trim(), suffix: value.slice(value.trimEnd().length) };
}

function tokenizeDirectiveValue(value: string, directiveName: string): readonly string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  let active = false;
  for (const character of value) {
    if (escaped) {
      token += character;
      active = true;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      active = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else token += character;
      active = true;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      active = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (active) {
        tokens.push(token);
        token = "";
        active = false;
      }
      continue;
    }
    token += character;
    active = true;
  }
  if (escaped || quote !== undefined) {
    throw new RemoteSshError(
      "CONFIG_INVALID",
      `The ${directiveName} directive contains an unterminated escape or quote.`,
      false
    );
  }
  if (active) tokens.push(token);
  return Object.freeze(tokens);
}

function blockDirectives(parsed: ParsedDocument, block: HostBlock): readonly ParsedDirective[] {
  const directives: ParsedDirective[] = [];
  for (let index = block.startLine + 1; index < block.endLine; index += 1) {
    const directive = parsed.lines[index]?.directive;
    if (directive !== undefined) directives.push(directive);
  }
  return directives;
}

function firstDirective(directives: readonly ParsedDirective[], name: string): string | undefined {
  return directives.find((directive) => directive.name.toLowerCase() === name)?.value;
}

function rewriteSingleHostBlock(
  parsed: ParsedDocument,
  block: HostBlock | undefined,
  host: RemoteSshConfigHost
): string {
  if (block === undefined) return appendHostBlock(parsed.source, host, parsed.newline);
  const blockLines = parsed.lines.slice(block.startLine, block.endLine);
  const desired = new Map<string, string | undefined>([
    ["hostname", host.hostname],
    ["user", host.user],
    ["port", host.port === DEFAULT_SSH_PORT ? undefined : String(host.port)]
  ]);
  const found = new Set<string>();
  const output: string[] = [];
  for (const [offset, line] of blockLines.entries()) {
    if (offset === 0) {
      output.push(line.raw);
      continue;
    }
    const directive = line.directive;
    const name = directive?.name.toLowerCase();
    if (directive === undefined || name === undefined || !desired.has(name)) {
      output.push(line.raw);
      continue;
    }
    if (found.has(name)) continue;
    found.add(name);
    const value = desired.get(name);
    if (value === undefined) continue;
    output.push(
      `${directive.indent}${directive.spelling}${directive.separator}${value}${directive.suffix}` +
      `${line.eol || parsed.newline}`
    );
  }
  const indentation = inferIndent(blockLines);
  for (const [name, value] of desired) {
    if (value === undefined || found.has(name)) continue;
    if (output.length > 0 && !output[output.length - 1]?.endsWith("\n")) output.push(parsed.newline);
    output.push(`${indentation}${canonicalDirectiveName(name)} ${value}${parsed.newline}`);
  }
  const start = parsed.lines[block.startLine]?.start ?? parsed.source.length;
  const end = block.endLine >= parsed.lines.length
    ? parsed.source.length
    : parsed.lines[block.endLine]?.start ?? parsed.source.length;
  return `${parsed.source.slice(0, start)}${output.join("")}${parsed.source.slice(end)}`;
}

function removeAliasFromBlock(parsed: ParsedDocument, key: string, alias: string): string {
  const block = parsed.blocks.find((candidate) => blockAliasKey(candidate, alias) === key);
  if (block === undefined) return parsed.source;
  const remaining = block.aliases.filter((candidate) => candidate !== alias);
  const start = parsed.lines[block.startLine]?.start ?? 0;
  const end = block.endLine >= parsed.lines.length
    ? parsed.source.length
    : parsed.lines[block.endLine]?.start ?? parsed.source.length;
  if (remaining.length === 0) return `${parsed.source.slice(0, start)}${parsed.source.slice(end)}`;
  const header = parsed.lines[block.startLine];
  if (header?.directive === undefined) return parsed.source;
  const replacement = `${header.directive.indent}${header.directive.spelling}${header.directive.separator}` +
    `${remaining.map(formatPattern).join(" ")}${header.directive.suffix}${header.eol || parsed.newline}`;
  return `${parsed.source.slice(0, start)}${replacement}${parsed.source.slice(header.end)}`;
}

function blockAliasKey(block: HostBlock, alias: string): string {
  return `${block.startLine}:${block.endLine}:${block.aliases.indexOf(alias)}`;
}

function appendHostBlock(source: string, host: RemoteSshConfigHost, newline: string): string {
  const prefix = source === "" ? "" : source.endsWith("\n") ? newline : `${newline}${newline}`;
  const lines = [
    `Host ${host.id}`,
    `  HostName ${host.hostname}`,
    `  User ${host.user}`,
    ...(host.port === DEFAULT_SSH_PORT ? [] : [`  Port ${host.port}`])
  ];
  return `${source}${prefix}${lines.join(newline)}${newline}`;
}

function inferIndent(lines: readonly ParsedLine[]): string {
  for (const line of lines.slice(1)) {
    if (line.directive !== undefined) return line.directive.indent || "  ";
  }
  return "  ";
}

function canonicalDirectiveName(name: string): string {
  if (name === "hostname") return "HostName";
  if (name === "user") return "User";
  return "Port";
}

function formatPattern(value: string): string {
  if (/^[^\s'"\\#]+$/u.test(value)) return value;
  return `"${value.replace(/["\\]/gu, (character) => `\\${character}`)}"`;
}

function parseImportedPort(value: string | undefined): number {
  if (value === undefined || !/^\d+$/u.test(value)) return DEFAULT_SSH_PORT;
  const port = Number(value);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : DEFAULT_SSH_PORT;
}

function validateConfigHost(host: RemoteSshConfigHost): RemoteSshConfigHost {
  const scope = validateOwnerScope(host);
  const id = validateAlias(host.id);
  const hostname = validateField(host.hostname, "hostname", 1_024);
  const user = validateField(host.user, "user", 256);
  if (!Number.isSafeInteger(host.port) || host.port < 1 || host.port > 65_535) {
    throw new RemoteSshError("INVALID_ARGUMENT", "port must be from 1 through 65535.", false);
  }
  if (host.source !== "manual" && host.source !== "ssh_config") {
    throw new RemoteSshError("INVALID_ARGUMENT", "source is invalid.", false);
  }
  return Object.freeze({ ...scope, id, hostname, port: host.port, user, source: host.source });
}

function validateOwnerScope(scope: RemoteSshOwnerScope): RemoteSshOwnerScope {
  return Object.freeze({
    ownerId: validateField(scope.ownerId, "ownerId", 256),
    targetId: validateField(scope.targetId, "targetId", 256)
  });
}

function validateAlias(value: string): string {
  const alias = validateField(value, "id", 256);
  if (!isConcreteAlias(alias) || /\s|["'\\#]/u.test(alias)) {
    throw new RemoteSshError("INVALID_ARGUMENT", "id must be a concrete SSH host alias.", false);
  }
  return alias;
}

function isConcreteAlias(value: string): boolean {
  return value !== "" && !value.startsWith("!") && !value.includes("*") && !value.includes("?");
}

function validateField(value: string, field: string, maximum: number): string {
  if (
    typeof value !== "string" || value.trim() === "" || value !== value.trim() ||
    value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new RemoteSshError("INVALID_ARGUMENT", `${field} is invalid.`, false, { field });
  }
  return value;
}

async function readConfigText(filePath: string): Promise<string> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new RemoteSshError("CONFIG_IO", "The SSH config path is not a regular file.", false);
    }
    if (stat.size > MAXIMUM_CONFIG_BYTES) {
      throw new RemoteSshError("CONFIG_INVALID", "The SSH config exceeds the supported size.", false);
    }
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    if (error instanceof RemoteSshError) throw error;
    throw new RemoteSshError("CONFIG_IO", "The SSH config could not be read safely.", false);
  }
}

async function ensurePrivateParent(filePath: string): Promise<void> {
  const parent = dirname(filePath);
  try {
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new RemoteSshError("CONFIG_IO", "The SSH config directory is unsafe.", false);
    }
    await fs.chmod(parent, 0o700);
  } catch (error) {
    if (error instanceof RemoteSshError) throw error;
    throw new RemoteSshError("CONFIG_IO", "The SSH config directory could not be secured.", false);
  }
}

async function assertSafeConfigTarget(filePath: string): Promise<void> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new RemoteSshError("CONFIG_IO", "The SSH config path is unsafe.", false);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (error instanceof RemoteSshError) throw error;
    throw new RemoteSshError("CONFIG_IO", "The SSH config path could not be inspected safely.", false);
  }
}

export async function writeFileAtomic(
  filePath: string,
  content: string,
  failureCode: "CONFIG_IO" | "HOST_KEY_STORE_WRITE_FAILED"
): Promise<void> {
  const temporary = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, 0o600);
    await syncDirectory(dirname(filePath));
  } catch {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
    throw new RemoteSshError(
      failureCode,
      failureCode === "CONFIG_IO"
        ? "The SSH config could not be written safely."
        : "The trusted host key store could not be written safely.",
      false
    );
  }
}

export async function acquireFileLock(
  lockPath: string,
  conflictCode: "CONFIG_CONFLICT" | "HOST_KEY_CONFLICT"
): Promise<() => Promise<void>> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(`${process.pid}\n`, "utf8");
    await handle.sync();
  } catch {
    await handle?.close().catch(() => undefined);
    if (handle !== undefined) await fs.unlink(lockPath).catch(() => undefined);
    throw new RemoteSshError(
      conflictCode,
      conflictCode === "CONFIG_CONFLICT"
        ? "Another SSH config mutation is in progress."
        : "Concurrent host key trust could not be established safely.",
      false
    );
  }
  const acquired = handle;
  return async () => {
    await acquired.close().catch(() => undefined);
    await fs.unlink(lockPath).catch(() => undefined);
  };
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
