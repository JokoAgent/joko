import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { crc32 } from "node:zlib";
import type { MessagePortMain } from "electron";

import {
  isDesktopExtensionId,
  type DesktopExtensionLibraryBeginSaveRequest,
  type DesktopExtensionLibraryClipboardRequest,
  type DesktopExtensionLibraryCommitSaveRequest,
  type DesktopExtensionLibraryRevealRequest,
  type DesktopExtensionLibrarySaveSource
} from "./channels.js";
import { sameFileIdentity, sameStableFile, streamUserSelectedFile, type UserSelectedFileDestination, type UserSelectedFileReceipt } from "@joko/device-peer/private-files";

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
  readonly destination: UserSelectedFileDestination;
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

  issueSaveTicket(scope: Scope, extensionId: string, destination: UserSelectedFileDestination): string {
    this.#cleanupExpired();
    if (this.#saveTickets.size >= 8) throw new ExtensionLibraryGestureError("BUSY", "Too many Extension Library saves are pending.");
    if (!isDesktopExtensionId(extensionId) || !normalizedAbsolute(destination.path)) throw invalid("Extension Library save ticket is invalid.");
    const id = `extension_library_save_${randomUUID().replaceAll("-", "")}`;
    this.#saveTickets.set(id, { id, scope, extensionId, destination, expiresAt: this.#now() + EXTENSION_LIBRARY_SAVE_TICKET_TTL_MS });
    return id;
  }

  takeSaveTicket(scope: Scope, extensionId: string, ticketId: string): UserSelectedFileDestination {
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
  const keys = ["extensionId", "ticketId", "totalBytes"];
  if (!(exact(value, keys) || exact(value, [...keys, "localRoot"])) || !isDesktopExtensionId(value.extensionId)
    || typeof value.ticketId !== "string" || !SAVE_TICKET.test(value.ticketId)
    || typeof value.totalBytes !== "number" || !validSaveSize(value.totalBytes)
    || value.localRoot !== undefined && !normalizedAbsolute(value.localRoot)) {
    throw invalid("Extension Library save commit request is invalid.");
  }
  return { extensionId: value.extensionId, ticketId: value.ticketId, totalBytes: value.totalBytes,
    ...(value.localRoot === undefined ? {} : { localRoot: value.localRoot }) };
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

/** Stage bytes from the authenticated source, then ask it to authorize publication. */
export async function saveExtensionLibraryFile(
  request: Pick<DesktopExtensionLibraryCommitSaveRequest, "totalBytes" | "localRoot">,
  destination: UserSelectedFileDestination,
  source: DesktopExtensionLibrarySaveSource,
  assertCurrent?: () => void
): Promise<UserSelectedFileReceipt> {
  if (!normalizedAbsolute(destination.path) || !validSaveSize(request.totalBytes)) {
    throw invalid("Extension Library save destination is invalid.");
  }
  if (request.localRoot !== undefined && (!normalizedAbsolute(request.localRoot) || inside(request.localRoot, destination.path))) {
    throw invalid("Extension Library save destination cannot be inside the active Library.");
  }
  async function* chunks() {
    for (let offset = 0; offset < request.totalBytes;) {
      assertCurrent?.();
      const length = Math.min(1024 * 1024, request.totalBytes - offset);
      const bytes = await source.read(offset, length);
      assertCurrent?.();
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) throw invalid("Extension Library save chunk is invalid.");
      yield bytes;
      offset += length;
    }
  }
  return streamUserSelectedFile(destination, request.totalBytes, chunks(), async () => {
    assertCurrent?.();
    await source.verify();
    assertCurrent?.();
  });
}

export function extensionLibrarySavePortSource(port: MessagePortMain): DesktopExtensionLibrarySaveSource {
  const request = (message: object): Promise<unknown> => new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      port.off("close", unavailable);
      port.off("message", receive);
    };
    const unavailable = () => { cleanup(); reject(new ExtensionLibraryGestureError("STALE", "Extension Library save source is unavailable.")); };
    const receive = (event: { readonly data: unknown }) => { cleanup(); resolve(event.data); };
    const timer = setTimeout(unavailable, 30_000);
    port.once("close", unavailable);
    port.once("message", receive);
    try { port.postMessage(message); } catch { unavailable(); }
  });
  return {
    read: async (offset, length) => {
      const result = await request({ kind: "read", offset, length });
      if (!exact(result, ["offset", "bytes"]) || result.offset !== offset || !(result.bytes instanceof Uint8Array)) {
        throw new ExtensionLibraryGestureError("STALE", "Extension Library save source is unavailable.");
      }
      return result.bytes;
    },
    verify: async () => {
      if (await request({ kind: "verify" }) !== "verified") {
        throw new ExtensionLibraryGestureError("STALE", "Extension Library save source is unavailable.");
      }
    }
  };
}

function validSaveSize(bytes: number): boolean {
  return Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= EXTENSION_LIBRARY_NATIVE_SAVE_MAXIMUM_BYTES;
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

function invalid(message: string): ExtensionLibraryGestureError {
  return new ExtensionLibraryGestureError("INVALID_REQUEST", message);
}
