import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { JokoError, type AdapterContext, type ArtifactMentionResolver, type BlobRef, type PromptInput } from "@joko/core";
import { claudeCodeError } from "./errors.js";
import {
  resolveClaudeResourceMention,
  type ClaudeRuntimeTextResource
} from "./resources.js";
import type { ClaudeSdkUserMessage } from "./sdk-runtime.js";

export interface ClaudeInputResolvers {
  /** Reads immutable Artifact bytes through the service-owned authority. */
  readonly readBlob?: (blob: BlobRef) => Promise<{ readonly data: Uint8Array; readonly mimeType?: string }>;
  /** Resolves an immutable Artifact to its host-owned regular file. */
  readonly resolveFile?: (blob: BlobRef, context: AdapterContext) => Promise<string>;
  /** Resolves only a committed Artifact in the source task's authority. */
  readonly resolveArtifactMention?: ArtifactMentionResolver;
}

const MAXIMUM_IMAGE_BYTES = 5 * 1024 * 1024;
const MAXIMUM_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const MAXIMUM_FILE_BYTES = 256 * 1024 * 1024;
const MAXIMUM_TEXT_BYTES = 1024 * 1024;
const MAXIMUM_INPUT_ITEMS = 100;

export interface PreparedClaudePrompt {
  readonly content: ClaudeSdkUserMessage["message"]["content"];
  /** Retains the original resource authority until the SDK consumes this input. */
  readonly assertCurrent: () => void;
}

export async function prepareClaudePrompt(
  input: PromptInput,
  context: AdapterContext,
  resolvers: ClaudeInputResolvers,
  signal: AbortSignal,
  resources?: readonly ClaudeRuntimeTextResource[]
): Promise<PreparedClaudePrompt> {
  const itemCount = input.images.length + input.files.length + input.mentions.length + (input.text.length > 0 ? 1 : 0);
  if (itemCount > MAXIMUM_INPUT_ITEMS) throw inputError("INPUT_ITEM_LIMIT", "The prompt contains too many attachments and mentions.");
  const blocks: Readonly<Record<string, unknown>>[] = [];
  const text = input.text.length > 0 ? [input.text] : [];
  const mentionAuthorities: Array<() => void> = [];
  let totalImageBytes = 0;
  for (const { blob } of input.images) {
    if (!Number.isSafeInteger(blob.byteLength) || blob.byteLength < 1 || !/^[a-f0-9]{64}$/iu.test(blob.sha256)) {
      throw inputError("IMAGE_REFERENCE_INVALID", "An image has an invalid immutable Artifact reference.");
    }
    totalImageBytes += blob.byteLength;
    if (blob.byteLength > MAXIMUM_IMAGE_BYTES || totalImageBytes > MAXIMUM_TOTAL_IMAGE_BYTES) {
      throw inputError("IMAGE_TOO_LARGE", "Image attachments exceed the native input size limit.");
    }
  }
  for (const { blob, alt } of input.images) {
    signal.throwIfAborted();
    if (resolvers.readBlob === undefined) throw inputError("IMAGE_RESOLVER_MISSING", "Image input requires an immutable Artifact reader.");
    const loaded = await resolvers.readBlob(blob).catch(() => {
      throw inputError("IMAGE_UNAVAILABLE", "An image attachment could not be read from Artifact storage.");
    });
    signal.throwIfAborted();
    if (loaded.data.byteLength !== blob.byteLength
      || createHash("sha256").update(loaded.data).digest("hex") !== blob.sha256.toLowerCase()) {
      throw inputError("IMAGE_INTEGRITY_FAILED", "An image attachment no longer matches its immutable Artifact reference.");
    }
    const mimeType = (loaded.mimeType ?? blob.mimeType).toLowerCase();
    if (mimeType !== blob.mimeType.toLowerCase() || !/^image\/(?:png|jpeg|gif|webp)$/u.test(mimeType)) {
      throw inputError("IMAGE_TYPE_UNSUPPORTED", "Image input requires PNG, JPEG, GIF, or WebP with a matching Artifact media type.");
    }
    blocks.push({ type: "image", source: { type: "base64", media_type: mimeType, data: Buffer.from(loaded.data).toString("base64") } });
    if (alt !== undefined && alt.length > 0) text.push(`Image description: ${JSON.stringify(alt)}`);
  }
  for (const file of input.files) {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(file.blob.byteLength) || file.blob.byteLength < 0
      || file.blob.byteLength > MAXIMUM_FILE_BYTES || !/^[a-f0-9]{64}$/iu.test(file.blob.sha256)) {
      throw inputError("FILE_REFERENCE_INVALID", "A file has an invalid or oversized immutable Artifact reference.");
    }
    let path: string;
    if (file.workspacePath !== undefined) {
      path = await workspaceFile(context.target.workspaceRoot, file.workspacePath);
    } else {
      if (resolvers.resolveFile === undefined) throw inputError("FILE_RESOLVER_MISSING", "File input requires an immutable Artifact resolver.");
      const resolved = await resolvers.resolveFile(file.blob, context).catch(() => {
        throw inputError("FILE_UNAVAILABLE", "A file attachment could not be resolved from Artifact storage.");
      });
      path = await regularFile(resolved);
    }
    await verifyFileContent(path, file.blob, signal);
    text.push(`Attached file: ${JSON.stringify({ name: file.blob.fileName ?? basename(path), path })}`);
  }
  for (const mention of input.mentions) {
    signal.throwIfAborted();
    if (mention.kind === "resource") {
      const resolved = resolveClaudeResourceMention(mention, resources);
      mentionAuthorities.push(resolved.assertCurrent);
      text.push(resolved.text);
      continue;
    }
    if (mention.kind === "artifact") {
      if (resolvers.resolveArtifactMention === undefined) {
        throw inputError("MENTION_KIND_UNSUPPORTED", "Artifact mentions require a service-owned authority resolver.");
      }
      if (mention.reference.length === 0 || mention.reference.length > 1_024
        || /[\u0000-\u001f\u007f]/u.test(mention.reference) || mention.lineRange !== undefined) {
        throw inputError("ARTIFACT_REFERENCE_INVALID", "An Artifact mention requires a bounded canonical identity.");
      }
      const resolved = await resolvers.resolveArtifactMention(
        mention.reference,
        mention.sourceSessionId,
        context,
        signal
      ).catch(() => {
        signal.throwIfAborted();
        throw inputError("ARTIFACT_UNAVAILABLE", "The referenced Artifact is unavailable in its source task.");
      });
      signal.throwIfAborted();
      const blob = resolved.blob;
      if (blob.id !== mention.reference || !Number.isSafeInteger(blob.byteLength) || blob.byteLength < 0
        || blob.byteLength > MAXIMUM_FILE_BYTES || !/^[a-f0-9]{64}$/iu.test(blob.sha256)) {
        throw inputError("ARTIFACT_REFERENCE_INVALID", "The resolved Artifact does not match its canonical identity or size limit.");
      }
      const path = await regularFile(resolved.path);
      await verifyFileContent(path, blob, signal);
      mentionAuthorities.push(() => {
        try { resolved.assertCurrent(); }
        catch { throw inputError("ARTIFACT_UNAVAILABLE", "The referenced Artifact changed in its source task while input was prepared."); }
      });
      text.push(`Artifact reference: ${JSON.stringify({ name: mention.label, path })}`);
      continue;
    }
    if (mention.kind !== "workspace_file" && mention.kind !== "workspace_directory") {
      throw inputError("MENTION_KIND_UNSUPPORTED", "This native input supports workspace file and directory mentions.");
    }
    if (mention.lineRange !== undefined
      && (mention.kind !== "workspace_file" || !Number.isSafeInteger(mention.lineRange.startLine)
        || !Number.isSafeInteger(mention.lineRange.endLine) || mention.lineRange.startLine < 1
        || mention.lineRange.endLine < mention.lineRange.startLine || mention.lineRange.endLine > 0xffff_ffff)) {
      throw inputError("WORKSPACE_LINE_RANGE_INVALID", "Workspace line ranges require ordered positive source line numbers.");
    }
    const directory = mention.kind === "workspace_directory";
    const path = await workspacePath(context.target.workspaceRoot, mention.reference, directory);
    text.push(`Workspace ${directory ? "directory" : "file"} reference: ${JSON.stringify({
      name: mention.label,
      path,
      ...(mention.lineRange === undefined ? {} : { lineRange: {
        startLine: mention.lineRange.startLine,
        endLine: mention.lineRange.endLine
      } })
    })}`);
  }
  signal.throwIfAborted();
  const combined = text.join("\n\n");
  if (Buffer.byteLength(combined, "utf8") > MAXIMUM_TEXT_BYTES) {
    throw inputError("PROMPT_TOO_LARGE", "The prompt and attachment descriptions exceed the native text limit.");
  }
  const assertCurrent = (): void => {
    signal.throwIfAborted();
    context.signal.throwIfAborted();
    for (const assertMentionCurrent of mentionAuthorities) assertMentionCurrent();
  };
  assertCurrent();
  if (blocks.length === 0) return { content: combined, assertCurrent };
  if (combined.length > 0) blocks.push({ type: "text", text: combined });
  return { content: blocks, assertCurrent };
}

async function workspaceFile(workspaceRoot: string, value: string): Promise<string> {
  return workspacePath(workspaceRoot, value, false);
}

async function workspacePath(workspaceRoot: string, value: string, directory: boolean): Promise<string> {
  if (value.length === 0 || value.length > 4_096 || isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw inputError("WORKSPACE_PATH_DENIED", "Workspace references must use a bounded relative path.");
  }
  const root = await realpath(workspaceRoot).catch(() => {
    throw inputError("WORKSPACE_UNAVAILABLE", "The current workspace is unavailable.");
  });
  if (relative(workspaceRoot, root) !== "") {
    throw inputError("WORKSPACE_PATH_DENIED", "The workspace no longer resolves to its registered canonical directory.");
  }
  const candidate = resolve(root, value);
  if (!inside(root, candidate)) throw inputError("WORKSPACE_PATH_DENIED", "A file reference is outside the current workspace.");
  const path = await regularPath(candidate, directory);
  if (!inside(root, path)) throw inputError("WORKSPACE_PATH_DENIED", "A file reference resolves outside the current workspace.");
  const currentRoot = await realpath(workspaceRoot).catch(() => undefined);
  const currentPath = await realpath(candidate).catch(() => undefined);
  if (currentRoot !== root || currentPath !== path) {
    throw inputError("WORKSPACE_PATH_DENIED", "A workspace reference changed while its path was resolved.");
  }
  return path;
}

async function regularFile(value: string): Promise<string> {
  return regularPath(value, false);
}

async function regularPath(value: string, directory: boolean): Promise<string> {
  if (!isAbsolute(value)) throw inputError("FILE_UNSAFE", "The file resolver did not return an absolute path.");
  const before = await lstat(value).catch(() => {
    throw inputError("FILE_UNAVAILABLE", "A referenced file is unavailable.");
  });
  if (!(directory ? before.isDirectory() : before.isFile()) || before.isSymbolicLink()) {
    throw inputError("FILE_UNSAFE", "A workspace reference does not match its declared file or directory kind.");
  }
  if (!directory && before.size > MAXIMUM_FILE_BYTES) throw inputError("FILE_TOO_LARGE", "A referenced file exceeds the native input size limit.");
  const canonical = await realpath(value).catch(() => {
    throw inputError("FILE_UNAVAILABLE", "A referenced file is unavailable.");
  });
  const after = await lstat(canonical).catch(() => {
    throw inputError("FILE_UNAVAILABLE", "A referenced file is unavailable.");
  });
  if (!(directory ? after.isDirectory() : after.isFile()) || after.isSymbolicLink()
    || before.dev !== after.dev || before.ino !== after.ino) {
    throw inputError("FILE_UNSAFE", "A referenced file changed while its path was resolved.");
  }
  return canonical;
}

async function verifyFileContent(path: string, blob: BlobRef, signal: AbortSignal): Promise<void> {
  const handle = await open(path, "r").catch(() => {
    throw inputError("FILE_UNAVAILABLE", "A referenced file could not be opened for verification.");
  });
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== blob.byteLength) {
      throw inputError("FILE_INTEGRITY_FAILED", "A file attachment no longer matches its immutable Artifact reference.");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    for (;;) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > blob.byteLength) throw inputError("FILE_INTEGRITY_FAILED", "A file attachment changed during verification.");
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    const current = await lstat(path);
    if (total !== blob.byteLength || hash.digest("hex") !== blob.sha256.toLowerCase()
      || current.isSymbolicLink() || !current.isFile()
      || ![after, current].every((info) => info.dev === before.dev && info.ino === before.ino
        && info.size === before.size && info.mtimeMs === before.mtimeMs && info.ctimeMs === before.ctimeMs)) {
      throw inputError("FILE_INTEGRITY_FAILED", "A file attachment no longer matches its immutable Artifact reference.");
    }
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof JokoError) throw error;
    throw inputError("FILE_INTEGRITY_FAILED", "A file attachment could not be verified against its immutable Artifact reference.");
  } finally {
    await handle.close().catch(() => {
      throw inputError("FILE_UNAVAILABLE", "File attachment verification could not finish safely.");
    });
  }
}

function inside(root: string, path: string): boolean {
  const value = relative(root, path);
  return value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function inputError(code: string, message: string) {
  return claudeCodeError(code, message, "input", { recovery: "Choose valid bounded attachments from the current workspace or Artifact storage and retry." });
}
