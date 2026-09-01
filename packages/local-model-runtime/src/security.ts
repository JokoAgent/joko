import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

import { LocalRuntimeError } from "./errors.js";
import type { RuntimeOwnerGeneration } from "./types.js";

const MODEL_SEGMENT = "[A-Za-z0-9._-]{1,128}";
const MODEL_NAME_RE = new RegExp(
  `^(?:hf\\.co\\/${MODEL_SEGMENT}\\/${MODEL_SEGMENT}|${MODEL_SEGMENT}(?:\\/${MODEL_SEGMENT})?)(?::${MODEL_SEGMENT})?$`,
  "u"
);
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/iu;

export function assertActiveOwner(
  expected: RuntimeOwnerGeneration,
  current: () => RuntimeOwnerGeneration | undefined
): void {
  const active = current();
  if (active?.ownerId !== expected.ownerId || active.generation !== expected.generation) {
    throw new LocalRuntimeError("OWNER_CHANGED", "The runtime owner changed during the operation.");
  }
}

export function isOllamaModelName(value: unknown): value is string {
  if (typeof value !== "string" || !MODEL_NAME_RE.test(value)) return false;
  const withoutTag = value.includes(":") ? value.slice(0, value.lastIndexOf(":")) : value;
  return withoutTag.split("/").every((segment) => segment !== "." && segment !== "..");
}

export function normalizeOllamaModelName(value: string): string {
  const trimmed = value.trim();
  if (isOllamaModelName(trimmed)) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new LocalRuntimeError("MODEL_INVALID", "The model name is invalid.");
  }
  if (url.protocol !== "https:" || !["huggingface.co", "www.huggingface.co", "hf.co"].includes(url.hostname.toLowerCase())) {
    throw new LocalRuntimeError("MODEL_INVALID", "The model name is invalid.");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0]?.toLowerCase() === "models") parts.shift();
  const owner = parts[0];
  const repository = parts[1];
  if (owner === undefined || repository === undefined || !new RegExp(`^${MODEL_SEGMENT}$`, "u").test(owner) || !new RegExp(`^${MODEL_SEGMENT}$`, "u").test(repository)) {
    throw new LocalRuntimeError("MODEL_INVALID", "The model name is invalid.");
  }
  if (["datasets", "spaces", "organizations", "login"].includes(owner.toLowerCase())) {
    throw new LocalRuntimeError("MODEL_INVALID", "The model name is invalid.");
  }
  let quantization: string | undefined;
  const locator = parts.findIndex((part) => part === "blob" || part === "tree" || part === "resolve");
  const fileName = locator < 0 ? undefined : parts[locator + 2];
  const fileMatch = fileName?.match(/[-_.]([Qq]\d[A-Za-z0-9._-]*|UD-[A-Za-z0-9._-]+|iq\d[A-Za-z0-9._-]*)\.gguf$/iu);
  if (fileMatch?.[1] !== undefined) quantization = fileMatch[1];
  const requestedTag = url.searchParams.get("quant") ?? url.searchParams.get("tag");
  if (quantization === undefined && requestedTag !== null && new RegExp(`^${MODEL_SEGMENT}$`, "u").test(requestedTag)) {
    quantization = requestedTag;
  }
  const candidate = `hf.co/${owner}/${repository}${quantization === undefined ? "" : `:${quantization}`}`;
  if (!isOllamaModelName(candidate)) throw new LocalRuntimeError("MODEL_INVALID", "The model name is invalid.");
  return candidate;
}

export function canonicalModelName(value: string): string {
  const slash = value.lastIndexOf("/");
  const finalSegment = slash < 0 ? value : value.slice(slash + 1);
  return finalSegment.includes(":") ? value : `${value}:latest`;
}

export function modelNamesEqual(left: string, right: string): boolean {
  return canonicalModelName(left) === canonicalModelName(right);
}

export function isSafeDigest(value: string): boolean {
  return DIGEST_RE.test(value);
}

export function assertArchiveEntrySafe(entry: string): void {
  const portable = entry.replaceAll("\\", "/");
  if (portable.length === 0 || portable.length > 4096 || portable.includes("\0")) {
    throw new LocalRuntimeError("ARCHIVE_REJECTED", "The runtime archive contains an invalid entry.");
  }
  if (portable.startsWith("/") || /^[A-Za-z]:\//u.test(portable)) {
    throw new LocalRuntimeError("ARCHIVE_REJECTED", "The runtime archive contains an absolute path.");
  }
  const parts = portable.split("/");
  if (parts.some((part) => part === "..")) {
    throw new LocalRuntimeError("ARCHIVE_REJECTED", "The runtime archive escapes its destination.");
  }
}

export function assertPathWithin(root: string, candidate: string): void {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const offset = relative(resolvedRoot, resolvedCandidate);
  if (offset === "" || (!offset.startsWith(`..${sep}`) && offset !== ".." && !isAbsolute(offset))) return;
  throw new LocalRuntimeError("ARCHIVE_REJECTED", "The runtime archive escapes its destination.");
}

export function safeRelativeArchivePath(value: string): string {
  assertArchiveEntrySafe(value);
  return normalize(value.replaceAll("/", sep));
}
