import { createHash } from "node:crypto";

export const REMOTE_PI_SESSION_SOURCE = String.raw`
import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

const MAX_REQUEST_BYTES = 90 * 1024 * 1024;
const MAX_CONTENT_BYTES = 64 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 32 * 1024;
const ERROR_MESSAGE = "Remote Pi Session file request failed.\n";
let finished = false;
function fail() { throw new Error(ERROR_MESSAGE); }
function reject() {
  if (finished) return;
  finished = true;
  process.stderr.write(ERROR_MESSAGE, () => process.exit(1));
}
const timeout = setTimeout(reject, 10_000);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value, maximum = MAX_PATH_BYTES) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || Buffer.byteLength(value) > maximum) fail();
  return value;
}
function normalizedPath(value) {
  text(value);
  if (!isAbsolute(value) || resolve(value) !== value) fail();
  return value;
}
function samePath(left, right) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function sameOwner(info) {
  return typeof process.getuid !== "function" || info.uid === BigInt(process.getuid());
}
function privateMode(info) {
  return process.platform === "win32" || (info.mode & 0o077n) === 0n;
}
function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.uid === right.uid && left.gid === right.gid;
}
function sameFile(left, right) {
  return sameIdentity(left, right) && left.nlink === right.nlink && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
async function directory(path, privateRequired) {
  const before = await lstat(path, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()
    || (privateRequired && (!privateMode(before) || !sameOwner(before)))) fail();
  if (!samePath(await realpath(path), path)) fail();
  const after = await lstat(path, { bigint: true });
  if (!after.isDirectory() || after.isSymbolicLink() || !sameIdentity(before, after)) fail();
  return { path, info: after, privateRequired };
}
async function recheckDirectories(snapshots) {
  for (const snapshot of snapshots) {
    const current = await directory(snapshot.path, snapshot.privateRequired);
    if (!sameIdentity(snapshot.info, current.info)) fail();
  }
}
async function pathParents(root, path, action) {
  const snapshots = [await directory(root, true)];
  const parent = dirname(path);
  const suffix = relative(root, parent);
  if (suffix === "") return { snapshots };
  const parts = suffix.split(sep);
  if (parts.length > 64) fail();
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    try { snapshots.push(await directory(current, true)); }
    catch (error) {
      if (action !== "remove" || error?.code !== "ENOENT") throw error;
      return { snapshots, missingParent: current };
    }
  }
  return { snapshots };
}
async function stillAbsent(path) {
  try { await lstat(path); }
  catch (error) { if (error?.code === "ENOENT") return; throw error; }
  fail();
}
function header(bytes, request) {
  const newline = bytes.indexOf(10);
  if (newline < 1 || newline > MAX_HEADER_BYTES) fail();
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, newline)));
  if (!record(value) || value.type !== "session" || value.version !== 3
    || value.id !== request.nativeSessionId || value.cwd !== request.cwd) fail();
  if (value.parentSession !== undefined) text(value.parentSession);
  return value;
}
function requestValue(value) {
  if (!record(value) || !["materialize", "confirm", "remove"].includes(value.action)) fail();
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "action,cwd,nativeSessionId,path,root" && keys !== "action,content,cwd,nativeSessionId,path,root") fail();
  const root = normalizedPath(value.root);
  const path = normalizedPath(value.path);
  normalizedPath(value.cwd);
  text(value.nativeSessionId, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.nativeSessionId)) fail();
  const suffix = relative(root, path);
  if (suffix === "" || suffix === ".." || suffix.startsWith(".." + sep) || isAbsolute(suffix) || extname(path) !== ".jsonl") fail();
  let content;
  let expectedHeader;
  if (value.content !== undefined) {
    text(value.content, Math.ceil(MAX_CONTENT_BYTES / 3) * 4);
    content = Buffer.from(value.content, "base64");
    if (content.byteLength === 0 || content.byteLength > MAX_CONTENT_BYTES || content.toString("base64") !== value.content) fail();
    expectedHeader = header(content, value);
  }
  if (value.action !== "remove" && content === undefined) fail();
  return { ...value, content, expectedHeader };
}
async function checkedFile(handle, path) {
  const info = await handle.stat({ bigint: true });
  const pathInfo = await lstat(path, { bigint: true });
  if (!info.isFile() || !pathInfo.isFile() || pathInfo.isSymbolicLink() || info.nlink !== 1n
    || !privateMode(info) || !sameOwner(info) || !sameFile(info, pathInfo)
    || !samePath(await realpath(path), path)) fail();
  return info;
}
async function confirmedHeader(handle, request) {
  const before = await checkedFile(handle, request.path);
  const buffer = Buffer.alloc(Math.min(Number(before.size), MAX_HEADER_BYTES + 1));
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
    if (buffer.subarray(0, offset).includes(10)) break;
  }
  const value = header(buffer.subarray(0, offset), request);
  if (request.expectedHeader !== undefined && value.parentSession !== request.expectedHeader.parentSession) fail();
  const after = await checkedFile(handle, request.path);
  if (!sameFile(before, after)) fail();
  return after;
}
async function confirmExisting(request, snapshots) {
  const handle = await open(request.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await confirmedHeader(handle, request);
    await recheckDirectories(snapshots);
    return { ok: true, created: false };
  } finally { await handle.close(); }
}
async function execute(request) {
  const cwd = await directory(request.cwd, false);
  const parents = await pathParents(request.root, request.path, request.action);
  const snapshots = [cwd, ...parents.snapshots];
  if (parents.missingParent !== undefined) {
    await recheckDirectories(snapshots);
    await stillAbsent(parents.missingParent);
    return { ok: true, removed: false };
  }
  if (request.action === "confirm") return confirmExisting(request, snapshots);
  if (request.action === "materialize") {
    await recheckDirectories(snapshots);
    let handle;
    try { handle = await open(request.path, "wx", 0o600); }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      return confirmExisting(request, snapshots);
    }
    try {
      await handle.writeFile(request.content);
      await handle.sync();
      const written = await checkedFile(handle, request.path);
      if (written.size !== BigInt(request.content.byteLength)) fail();
      await recheckDirectories(snapshots);
      const after = await checkedFile(handle, request.path);
      if (!sameFile(written, after)) fail();
      return { ok: true, created: true };
    } finally { await handle.close(); }
  }
  let handle;
  try { handle = await open(request.path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await recheckDirectories(snapshots);
    await stillAbsent(request.path);
    return { ok: true, removed: false };
  }
  try {
    const confirmed = await confirmedHeader(handle, request);
    await recheckDirectories(snapshots);
    if (!sameFile(confirmed, await checkedFile(handle, request.path))) fail();
    await unlink(request.path);
    await recheckDirectories(snapshots);
    await stillAbsent(request.path);
    return { ok: true, removed: true };
  } finally { await handle.close(); }
}
async function main() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.byteLength;
    if (size > MAX_REQUEST_BYTES) fail();
    chunks.push(chunk);
  }
  if (size === 0) fail();
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)));
  const result = await execute(requestValue(value));
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  process.stdout.write(JSON.stringify(result) + "\n");
}
main().catch(() => { clearTimeout(timeout); reject(); });
`;

export const REMOTE_PI_SESSION_SOURCE_SHA256 = createHash("sha256")
  .update(REMOTE_PI_SESSION_SOURCE)
  .digest("hex");
