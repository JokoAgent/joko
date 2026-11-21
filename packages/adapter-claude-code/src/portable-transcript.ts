import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, opendir, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { PortableNativeSession } from "@joko/core";
import { claudeCodeError } from "./errors.js";
import { record } from "./projection.js";
import { repairClaudeTranscriptText } from "./transcript-tool-ids.js";

const MAXIMUM_BYTES = 96 * 1024 * 1024;
const MAXIMUM_PROJECT_KEY_LENGTH = 200;
const MAXIMUM_PROJECTS = 10_000;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface ClaudeTranscriptSource {
  readonly profile: string;
  readonly workspace: string;
  readonly sessionId: string;
  readonly projectDirectoryName?: string;
  readonly assertCurrent: () => void;
}

export async function readClaudePortableTranscript(input: ClaudeTranscriptSource): Promise<PortableNativeSession | undefined> {
  const path = await locateClaudeTranscript(input);
  if (!path) return undefined;
  const bytes = await readStableTranscript(path);
  const result = portableClaudeTranscript(bytes, input.sessionId);
  input.assertCurrent();
  return result;
}

/** Prepare the CLI's confirmed local transcript for resume. */
export async function repairClaudeStoredTranscript(input: ClaudeTranscriptSource): Promise<void> {
  const path = await locateClaudeTranscript(input);
  if (path === undefined) return;
  const { bytes, identity } = await readTranscriptSnapshot(path);
  const original = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const repaired = repairClaudeTranscriptText(original);
  if (repaired === original) return;
  if (Buffer.byteLength(repaired) > MAXIMUM_BYTES) throw invalidTranscript();
  const directory = dirname(path);
  const temporary = join(directory, `.${randomUUID()}.claude-resume.tmp`);
  input.assertCurrent();
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(repaired, "utf8");
      if (process.platform !== "win32") await handle.chmod(identity.mode & 0o777);
      await handle.sync();
    } finally { await handle.close(); }
    await assertDirectory(directory);
    if (await realpath(path) !== resolve(path) || !sameFile(identity, await lstat(path))) throw invalidTranscript();
    input.assertCurrent();
    await rename(temporary, path);
    input.assertCurrent();
  } finally {
    await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  }
}

async function locateClaudeTranscript(input: ClaudeTranscriptSource): Promise<string | undefined> {
  input.assertCurrent();
  if (!SESSION_ID.test(input.sessionId)) throw invalidTranscript();
  const profile = await realpath(input.profile);
  const workplace = await realpath(input.workspace);
  const projects = join(profile, "projects");
  if (await optionalStat(projects) === undefined) return undefined;
  await assertDirectory(projects);
  const filename = `${input.sessionId}.jsonl`;
  const key = projectKey(workplace, input.projectDirectoryName);
  let path = join(projects, key, filename);
  if (key.length > MAXIMUM_PROJECT_KEY_LENGTH || await optionalStat(path) === undefined) {
    let match: string | undefined;
    let count = 0;
    const entries = await opendir(projects);
    for await (const entry of entries) {
      input.assertCurrent();
      if (++count > MAXIMUM_PROJECTS) throw invalidTranscript();
      if (!entry.isDirectory() || !entry.name.startsWith(key.slice(0, MAXIMUM_PROJECT_KEY_LENGTH))) continue;
      const candidate = join(projects, entry.name, filename);
      if (await optionalStat(candidate) === undefined) continue;
      if (match !== undefined) throw invalidTranscript();
      match = candidate;
    }
    if (match === undefined) return undefined;
    path = match;
  }
  await assertDirectory(dirname(path));
  input.assertCurrent();
  return path;
}

export function portableClaudeTranscript(bytes: Uint8Array, sessionId: string): PortableNativeSession {
  if (parseTranscript(bytes).sessionId !== sessionId) throw invalidTranscript();
  return { bytes, sha256: digest(bytes), nativeSessionId: sessionId };
}

export async function stageClaudePortableTranscript(input: {
  readonly profile: string;
  readonly workspace: string;
  readonly bytes: Uint8Array;
  readonly projectDirectoryName?: string;
  readonly operationIdentity?: string;
  readonly assertCurrent: () => void;
}): Promise<{ readonly sessionId: string; readonly rollback: () => Promise<void> }> {
  input.assertCurrent();
  const { sessionId: source, rows } = parseTranscript(input.bytes);
  const workspace = await realpath(input.workspace);
  const key = projectKey(workspace, input.projectDirectoryName);
  if (key.length > MAXIMUM_PROJECT_KEY_LENGTH) {
    throw claudeCodeError("CLAUDE_PORTABLE_PROJECT_PATH_UNSUPPORTED", "The destination path is too long for a portable Claude session.",
      "session", { recovery: "Choose a destination with a shorter workspace path." });
  }
  const profile = await realpath(input.profile);
  const target = createHash("sha256").update(JSON.stringify([
    "claude-native-portable-session-v1", input.operationIdentity ?? randomUUID(), source, digest(input.bytes)
  ])).digest("hex");
  const sessionId = `${target.slice(0, 8)}-${target.slice(8, 12)}-4${target.slice(13, 16)}-a${target.slice(17, 20)}-${target.slice(20, 32)}`;
  const bytes = Buffer.from(rows.map(row => {
    if (row["sessionId"] !== undefined) row["sessionId"] = sessionId;
    if (row["cwd"] !== undefined) row["cwd"] = workspace;
    return JSON.stringify(row);
  }).join("\n") + "\n");
  if (bytes.byteLength > MAXIMUM_BYTES) throw invalidTranscript();
  const projects = join(profile, "projects");
  const directory = join(projects, key);
  for (const path of [projects, directory]) {
    await mkdir(path, { mode: 0o700 }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    await assertDirectory(path);
  }
  const path = join(directory, `${sessionId}.jsonl`);
  const staging = join(directory, `.${randomUUID()}.portable.tmp`);
  let published: Stats | undefined;
  const rollback = async (): Promise<void> => {
    if (published === undefined) return;
    const current = await optionalStat(path);
    if (current !== undefined && sameFile(published, current) && await realpath(path) === path) await unlink(path);
  };
  const handle = await open(staging, "wx", 0o600);
  try {
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    await assertDirectory(directory);
    input.assertCurrent();
    try { await link(staging, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await readStableTranscript(path)).equals(bytes)) throw invalidTranscript();
      input.assertCurrent();
      return { sessionId, rollback };
    }
    published = await lstat(path);
    await unlink(staging);
    published = await lstat(path);
    input.assertCurrent();
    return { sessionId, rollback };
  } catch (error) {
    try { await rollback(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "The receiving Claude transcript could not be retired."); }
    throw error;
  } finally {
    await unlink(staging).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  }
}

function parseTranscript(bytes: Uint8Array): { readonly sessionId: string; readonly rows: Record<string, unknown>[] } {
  if (bytes.byteLength < 1 || bytes.byteLength > MAXIMUM_BYTES) throw invalidTranscript();
  let sessionId: string | undefined;
  const rows: Record<string, unknown>[] = [];
  for (const line of new TextDecoder("utf-8", { fatal: true }).decode(bytes).split("\n")) {
    if (line.trim() === "") continue;
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { throw invalidTranscript(); }
    const row = record(value);
    if (row === undefined || typeof row["type"] !== "string") throw invalidTranscript();
    const id = row["sessionId"];
    if (id !== undefined) {
      if (typeof id !== "string" || !SESSION_ID.test(id) || (sessionId !== undefined && id !== sessionId)) throw invalidTranscript();
      sessionId = id;
    }
    rows.push(row);
  }
  if (sessionId === undefined || !rows.some(row => (row["type"] === "user" || row["type"] === "assistant")
    && row["sessionId"] === sessionId)) throw invalidTranscript();
  return { sessionId, rows };
}

async function readStableTranscript(path: string): Promise<Buffer> {
  return (await readTranscriptSnapshot(path)).bytes;
}

async function readTranscriptSnapshot(path: string): Promise<{ readonly bytes: Buffer; readonly identity: Stats }> {
  if (await realpath(path) !== resolve(path)) throw invalidTranscript();
  const observed = await lstat(path);
  if (!observed.isFile() || observed.isSymbolicLink() || observed.nlink !== 1 || observed.size < 1 || observed.size > MAXIMUM_BYTES) {
    throw invalidTranscript();
  }
  const flags = process.platform === "win32" ? "r" : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(path, flags);
  try {
    const before = await handle.stat();
    if (!sameFile(observed, before)) throw invalidTranscript();
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw invalidTranscript();
      offset += bytesRead;
    }
    if (!sameFile(before, await handle.stat()) || !sameFile(before, await lstat(path)) || await realpath(path) !== resolve(path)) {
      throw invalidTranscript();
    }
    return { bytes, identity: before };
  } finally {
    await handle.close();
  }
}

async function optionalStat(path: string): Promise<Stats | undefined> {
  return lstat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
}

async function assertDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw invalidTranscript();
}

function sameFile(before: Stats, after: Stats): boolean {
  return after.isFile() && !after.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino
    && before.size === after.size && before.nlink === after.nlink && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

function projectKey(path: string, configured?: string): string {
  if (configured === undefined) return path.normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(configured)) throw invalidTranscript();
  return configured;
}

function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

function invalidTranscript(): Error {
  return claudeCodeError("CLAUDE_PORTABLE_TRANSCRIPT_INVALID", "The Claude session transcript is invalid or exceeds its bounds.", "session",
    { recovery: "Export the original task again after its native history has settled." });
}
