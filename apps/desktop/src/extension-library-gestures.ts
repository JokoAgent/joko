import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { crc32 } from "node:zlib";

import {
  isDesktopExtensionId,
  type DesktopExtensionLibraryBeginSaveRequest,
  type DesktopExtensionLibraryClipboardRequest,
  type DesktopExtensionLibraryCommitSaveRequest,
  type DesktopExtensionLibraryRevealRequest
} from "./channels.js";
import { sameFileIdentity, sameStableFile } from "./secure-files.js";

export const EXTENSION_LIBRARY_CLIPBOARD_MAXIMUM_BYTES = 16 * 1024 * 1024;
export const EXTENSION_LIBRARY_NATIVE_SAVE_MAXIMUM_BYTES = 8 * 1024 * 1024 * 1024;
export const EXTENSION_LIBRARY_GESTURE_MINIMUM_INTERVAL_MS = 3_000;
export const EXTENSION_LIBRARY_SAVE_TICKET_TTL_MS = 2 * 60_000;

const PORTABLE_SEGMENT = /^[A-Za-z0-9_@][A-Za-z0-9_@.+ -]*$/u;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const SQLITE_SIDECAR = /\.sqlite-(?:wal|shm|journal)$/iu;
const SAVE_TICKET = /^extension_library_save_[a-f0-9]{32}$/u;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IHDR = Buffer.from("IHDR", "ascii");
const PNG_IEND = Buffer.from("IEND", "ascii");

export class ExtensionLibraryGestureError extends Error {
  constructor(readonly code: "BUSY" | "INVALID_REQUEST" | "RATE_LIMITED" | "STALE", message: string) {
    super(message);
    this.name = "ExtensionLibraryGestureError";
  }
}

interface SaveTicket<Scope extends object> {
  readonly id: string;
  readonly scope: Scope;
  readonly extensionId: string;
  readonly destination: string;
  readonly expiresAt: number;
}

/** Owns native gesture rate limits and one-use, sender-bound save destinations. */
export class ExtensionLibraryGestureCoordinator<Scope extends object> {
  readonly #now: () => number;
  readonly #lastAttempts = new Map<string, number>();
  readonly #saveTickets = new Map<string, SaveTicket<Scope>>();
  #saveDialogInFlight = false;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  attempt(extensionId: string, operation: "reveal" | "saveAs" | "clipboardWrite"): void {
    if (!isDesktopExtensionId(extensionId)) throw invalid("Extension Library gesture identity is invalid.");
    const now = this.#now();
    const key = `${extensionId}:${operation}`;
    const previous = this.#lastAttempts.get(key);
    this.#lastAttempts.set(key, now);
    if (previous !== undefined && now - previous < EXTENSION_LIBRARY_GESTURE_MINIMUM_INTERVAL_MS) {
      throw new ExtensionLibraryGestureError("RATE_LIMITED", "Extension Library native gesture requests are too frequent.");
    }
  }

  beginSaveDialog(): void {
    if (this.#saveDialogInFlight) throw new ExtensionLibraryGestureError("BUSY", "Another Extension Library save dialog is open.");
    this.#saveDialogInFlight = true;
  }

  endSaveDialog(): void {
    this.#saveDialogInFlight = false;
  }

  issueSaveTicket(scope: Scope, extensionId: string, destination: string): string {
    this.#cleanupExpired();
    if (this.#saveTickets.size >= 8) throw new ExtensionLibraryGestureError("BUSY", "Too many Extension Library saves are pending.");
    if (!isDesktopExtensionId(extensionId) || !normalizedAbsolute(destination)) throw invalid("Extension Library save ticket is invalid.");
    const id = `extension_library_save_${randomUUID().replaceAll("-", "")}`;
    this.#saveTickets.set(id, { id, scope, extensionId, destination, expiresAt: this.#now() + EXTENSION_LIBRARY_SAVE_TICKET_TTL_MS });
    return id;
  }

  takeSaveTicket(scope: Scope, extensionId: string, ticketId: string): string {
    this.#cleanupExpired();
    if (!SAVE_TICKET.test(ticketId)) throw invalid("Extension Library save ticket identity is invalid.");
    const ticket = this.#saveTickets.get(ticketId);
    if (ticket === undefined || ticket.scope !== scope || ticket.extensionId !== extensionId) {
      throw new ExtensionLibraryGestureError("STALE", "Extension Library save ticket is unavailable.");
    }
    this.#saveTickets.delete(ticketId);
    return ticket.destination;
  }

  cancelSaveTicket(scope: Scope, ticketId: string): boolean {
    if (!SAVE_TICKET.test(ticketId)) return false;
    const ticket = this.#saveTickets.get(ticketId);
    if (ticket === undefined || ticket.scope !== scope) return false;
    this.#saveTickets.delete(ticketId);
    return true;
  }

  retireScope(scope: Scope): void {
    for (const [id, ticket] of this.#saveTickets) if (ticket.scope === scope) this.#saveTickets.delete(id);
  }

  #cleanupExpired(): void {
    const now = this.#now();
    for (const [id, ticket] of this.#saveTickets) if (ticket.expiresAt <= now) this.#saveTickets.delete(id);
  }
}

export function parseExtensionLibraryRevealRequest(value: unknown): DesktopExtensionLibraryRevealRequest {
  if (!exact(value, ["extensionId", "root", "path"]) || !isDesktopExtensionId(value.extensionId)
    || !normalizedAbsolute(value.root) || portablePath(value.path) === undefined) {
    throw invalid("Extension Library reveal request is invalid.");
  }
  return { extensionId: value.extensionId, root: value.root, path: value.path as string };
}

export function parseExtensionLibraryBeginSaveRequest(value: unknown): DesktopExtensionLibraryBeginSaveRequest {
  if (!exact(value, ["extensionId", "name"]) || !isDesktopExtensionId(value.extensionId) || !safeFileName(value.name)) {
    throw invalid("Extension Library save request is invalid.");
  }
  return { extensionId: value.extensionId, name: value.name as string };
}

export function parseExtensionLibraryCommitSaveRequest(value: unknown): DesktopExtensionLibraryCommitSaveRequest {
  if (!exact(value, ["extensionId", "ticketId", "root", "path"]) || !isDesktopExtensionId(value.extensionId)
    || typeof value.ticketId !== "string" || !SAVE_TICKET.test(value.ticketId)
    || !normalizedAbsolute(value.root) || portablePath(value.path) === undefined) {
    throw invalid("Extension Library save commit request is invalid.");
  }
  return { extensionId: value.extensionId, ticketId: value.ticketId, root: value.root, path: value.path as string };
}

export function parseExtensionLibraryClipboardRequest(value: unknown): DesktopExtensionLibraryClipboardRequest {
  if (!exact(value, ["extensionId", "bytes"]) || !isDesktopExtensionId(value.extensionId)
    || !(value.bytes instanceof Uint8Array) || value.bytes.byteLength === 0
    || value.bytes.byteLength > EXTENSION_LIBRARY_CLIPBOARD_MAXIMUM_BYTES || !isPng(value.bytes)) {
    throw invalid("Extension Library clipboard request must contain one valid bounded PNG image.");
  }
  return { extensionId: value.extensionId, bytes: new Uint8Array(value.bytes) };
}

export async function resolveVerifiedExtensionLibraryFile(root: string, path: string): Promise<{
  readonly absolutePath: string;
  readonly bytes: number;
}> {
  if (!normalizedAbsolute(root)) throw invalid("Extension Library root is invalid.");
  const portable = portablePath(path);
  if (portable === undefined) throw invalid("Extension Library path is invalid.");
  const rootBefore = await lstat(root);
  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink() || !samePath(await realpath(root), root)) {
    throw new ExtensionLibraryGestureError("STALE", "Extension Library root is unavailable.");
  }
  const candidate = resolve(root, ...portable.split("/"));
  if (!inside(root, candidate)) throw invalid("Extension Library path escaped its root.");
  const before = await lstat(candidate);
  assertRegular(before);
  if (!samePath(await realpath(candidate), candidate)) throw new ExtensionLibraryGestureError("STALE", "Extension Library file contains a path alias.");
  const [rootAfter, after] = await Promise.all([lstat(root), lstat(candidate)]);
  if (!sameFileIdentity(rootBefore, rootAfter) || !sameStableFile(before, after)) {
    throw new ExtensionLibraryGestureError("STALE", "Extension Library file changed during validation.");
  }
  return { absolutePath: candidate, bytes: after.size };
}

/** Copies a verified Library file to a user-selected path without exposing that path to the frame. */
export async function atomicCopyExtensionLibraryFile(
  root: string,
  path: string,
  destination: string,
  maximumBytes = EXTENSION_LIBRARY_NATIVE_SAVE_MAXIMUM_BYTES
): Promise<number> {
  if (!normalizedAbsolute(destination) || !Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw invalid("Extension Library save destination is invalid.");
  }
  const source = await resolveVerifiedExtensionLibraryFile(root, path);
  if (inside(root, destination)) throw invalid("Extension Library save destination cannot be inside the active Library.");
  if (source.bytes > maximumBytes) throw new ExtensionLibraryGestureError("INVALID_REQUEST", "Extension Library file exceeds the native save limit.");
  const existing = await missingAsUndefined(() => lstat(destination));
  if (existing !== undefined) assertRegular(existing);
  const sourceBefore = await lstat(source.absolutePath);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  let sourceHandle: Awaited<ReturnType<typeof open>> | undefined;
  let targetHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    sourceHandle = await open(source.absolutePath, constants.O_RDONLY | noFollow);
    const opened = await sourceHandle.stat();
    assertRegular(opened);
    if (!sameStableFile(sourceBefore, opened) || opened.size > maximumBytes) {
      throw new ExtensionLibraryGestureError("STALE", "Extension Library file changed before save.");
    }
    targetHandle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, opened.size)));
    let offset = 0;
    while (offset < opened.size) {
      const read = await sourceHandle.read(buffer, 0, Math.min(buffer.byteLength, opened.size - offset), offset);
      if (read.bytesRead === 0) break;
      let written = 0;
      while (written < read.bytesRead) {
        const result = await targetHandle.write(buffer, written, read.bytesRead - written, offset + written);
        if (result.bytesWritten === 0) throw new Error("Extension Library save stopped making progress.");
        written += result.bytesWritten;
      }
      offset += read.bytesRead;
    }
    const sentinel = Buffer.alloc(1);
    const extra = await sourceHandle.read(sentinel, 0, 1, offset);
    const openedAfter = await sourceHandle.stat();
    const pathAfter = await lstat(source.absolutePath);
    if (offset !== opened.size || extra.bytesRead !== 0 || !sameStableFile(opened, openedAfter)
      || !sameStableFile(openedAfter, pathAfter) || !samePath(await realpath(source.absolutePath), source.absolutePath)) {
      throw new ExtensionLibraryGestureError("STALE", "Extension Library file changed during save.");
    }
    await targetHandle.sync();
    await targetHandle.close();
    targetHandle = undefined;
    await sourceHandle.close();
    sourceHandle = undefined;
    await rename(temporary, destination);
    const committed = await lstat(destination);
    assertRegular(committed);
    if (committed.size !== opened.size) throw new Error("Extension Library native save was not committed completely.");
    await syncDirectory(dirname(destination));
    return committed.size;
  } finally {
    await Promise.all([sourceHandle?.close().catch(() => undefined), targetHandle?.close().catch(() => undefined)]);
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
}

export function isPng(bytes: Uint8Array): boolean {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.byteLength < 45 || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return false;
  let offset = PNG_SIGNATURE.length;
  let index = 0;
  let sawIend = false;
  while (offset + 12 <= buffer.byteLength) {
    if (sawIend) return false;
    const length = buffer.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = typeStart + 4;
    const next = dataStart + length + 4;
    if (next > buffer.byteLength) return false;
    const type = buffer.subarray(typeStart, dataStart);
    const data = buffer.subarray(dataStart, dataStart + length);
    if (!/^[A-Za-z]{4}$/u.test(type.toString("ascii"))) return false;
    if ((crc32(Buffer.concat([type, data])) >>> 0) !== buffer.readUInt32BE(dataStart + length)) return false;
    if (index === 0) {
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      if (!type.equals(PNG_IHDR) || length !== 13 || width === 0 || height === 0
        || width > 16_384 || height > 16_384 || width * height > 100_000_000) return false;
    } else if (type.equals(PNG_IHDR)) return false;
    if (type.equals(PNG_IEND)) {
      if (length !== 0 || next !== buffer.byteLength) return false;
      sawIend = true;
    }
    offset = next;
    index += 1;
  }
  return sawIend && offset === buffer.byteLength;
}

function portablePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value !== value.trim()
    || value.includes("\\") || value.includes(":") || value.startsWith("/")) return undefined;
  const segments = value.split("/");
  return segments.length > 32 || segments.some((segment) => segment === "" || segment === "." || segment === ".."
    || segment.startsWith(".") || segment.endsWith(".") || segment.endsWith(" ") || !PORTABLE_SEGMENT.test(segment)
    || WINDOWS_RESERVED.test(segment) || SQLITE_SIDECAR.test(segment)) ? undefined : value;
}

function safeFileName(value: unknown): boolean {
  return typeof value === "string" && value.length >= 1 && value.length <= 255 && value === value.trim()
    && basename(value) === value && !/[\u0000-\u001f\u007f<>:"\/\\|?*]/u.test(value)
    && !value.startsWith(".") && !value.endsWith(".") && !value.endsWith(" ") && !WINDOWS_RESERVED.test(value);
}

function normalizedAbsolute(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 32_768 && value === value.trim()
    && !value.includes("\0") && isAbsolute(value) && resolve(value) === value;
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function inside(root: string, candidate: string): boolean {
  const suffix = relative(resolve(root), resolve(candidate));
  return suffix === "" || suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function assertRegular(info: Stats): void {
  if (!info.isFile() || info.isSymbolicLink()) throw new ExtensionLibraryGestureError("STALE", "Extension Library file is not a regular file.");
}

async function missingAsUndefined<T>(action: () => Promise<T>): Promise<T | undefined> {
  try {
    return await action();
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const unsupported = process.platform === "win32" && typeof error === "object" && error !== null && "code" in error
      && ["EACCES", "EBADF", "EINVAL", "ENOTSUP", "EPERM"].includes(String(error.code));
    if (!unsupported) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function invalid(message: string): ExtensionLibraryGestureError {
  return new ExtensionLibraryGestureError("INVALID_REQUEST", message);
}
