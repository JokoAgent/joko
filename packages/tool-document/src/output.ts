import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MAXIMUM_OUTPUT_BYTES = 64 * 1024 * 1024;
const WRITE_TIMEOUT_MS = 60_000;

export type DocumentOutputErrorCode =
  | "PATH_NOT_ALLOWED"
  | "FILE_EXISTS"
  | "ATOMIC_PUBLISH_UNSUPPORTED"
  | "OUTPUT_TOO_LARGE"
  | "OUTPUT_FAILED";

export class DocumentOutputError extends Error {
  constructor(readonly code: DocumentOutputErrorCode, message: string) {
    super(message);
    this.name = "DocumentOutputError";
  }
}

interface WriterRequest {
  readonly root: string;
  readonly rootDev: string;
  readonly rootIno: string;
  readonly relativeParent: string;
  readonly targetName: string;
  readonly bytesBase64: string;
  readonly overwrite: boolean;
}

type WriterResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: DocumentOutputErrorCode; readonly message: string };

/** Publish completed document bytes through one root-bound writer process. */
export async function publishDocumentOutput(input: {
  readonly root: string;
  readonly outPath: string;
  readonly bytes: Uint8Array;
  readonly overwrite: boolean;
  readonly signal?: AbortSignal;
}): Promise<{ readonly path: string; readonly relativePath: string; readonly bytes: number }> {
  input.signal?.throwIfAborted();
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAXIMUM_OUTPUT_BYTES) {
    throw new DocumentOutputError("OUTPUT_TOO_LARGE", "Document output exceeds the size limit.");
  }
  if (typeof input.outPath !== "string" || input.outPath.length === 0 || input.outPath.length > 4_096 || input.outPath.includes("\0")) {
    throw new DocumentOutputError("PATH_NOT_ALLOWED", "Document output path is invalid.");
  }
  const root = await fs.realpath(input.root).catch(() => {
    throw new DocumentOutputError("PATH_NOT_ALLOWED", "Task working directory is unavailable.");
  });
  const rootInfo = await fs.lstat(root, { bigint: true });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootInfo.dev === 0n || rootInfo.ino === 0n) {
    throw new DocumentOutputError("PATH_NOT_ALLOWED", "Task working directory is not a stable directory.");
  }
  const path = resolve(root, input.outPath);
  const relativePath = relative(root, path);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new DocumentOutputError("PATH_NOT_ALLOWED", "Document output must stay in the task working directory.");
  }
  const targetName = basename(path);
  if (targetName === "." || targetName === ".." || targetName.includes("\0")) {
    throw new DocumentOutputError("PATH_NOT_ALLOWED", "Document output filename is invalid.");
  }
  const request: WriterRequest = {
    root,
    rootDev: String(rootInfo.dev),
    rootIno: String(rootInfo.ino),
    relativeParent: relative(root, dirname(path)),
    targetName,
    bytesBase64: Buffer.from(input.bytes).toString("base64"),
    overwrite: input.overwrite
  };
  const result = await invokeWriter(request, input.signal);
  if (!result.ok) throw new DocumentOutputError(result.code, result.message);
  input.signal?.throwIfAborted();
  const realPath = await fs.realpath(path).catch(() => {
    throw new DocumentOutputError("OUTPUT_FAILED", "Published document could not be read back.");
  });
  if (realPath !== path) {
    throw new DocumentOutputError("PATH_NOT_ALLOWED", "Published document path changed.");
  }
  const readback = await fs.readFile(realPath);
  if (readback.byteLength !== input.bytes.byteLength
    || createHash("sha256").update(readback).digest("hex") !== createHash("sha256").update(input.bytes).digest("hex")) {
    throw new DocumentOutputError("OUTPUT_FAILED", "Published document failed readback verification.");
  }
  return { path, relativePath, bytes: readback.byteLength };
}

async function invokeWriter(request: WriterRequest, signal: AbortSignal | undefined): Promise<WriterResult> {
  const ownFile = fileURLToPath(import.meta.url);
  const sourceMode = ownFile.endsWith(".ts");
  const writerFile = resolve(dirname(ownFile), sourceMode ? "output-child.ts" : "output-child.js");
  const execArgv = sourceMode ? ["--import", import.meta.resolve("tsx")] : [];
  return await new Promise<WriterResult>((resolveResult, reject) => {
    const child = fork(writerFile, [], {
      cwd: request.root,
      execArgv,
      env: {
        PATH: process.env["PATH"],
        SystemRoot: process.env["SystemRoot"],
        WINDIR: process.env["WINDIR"],
        TEMP: process.env["TEMP"],
        TMP: process.env["TMP"]
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"]
    });
    let finished = false;
    const finish = (result: WriterResult | undefined, error?: Error): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      child.kill();
      if (error !== undefined) reject(error);
      else resolveResult(result!);
    };
    const abort = (): void => finish(undefined, new DocumentOutputError("OUTPUT_FAILED", "Document output was cancelled."));
    const timer = setTimeout(() => finish(undefined, new DocumentOutputError("OUTPUT_FAILED", "Document output timed out.")), WRITE_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const result = message as Partial<WriterResult>;
      if (result.ok === true) finish({ ok: true });
      else if (result.ok === false && typeof result.code === "string" && typeof result.message === "string") {
        finish({ ok: false, code: result.code, message: result.message.slice(0, 2_000) });
      }
    });
    child.on("error", () => finish(undefined, new DocumentOutputError("OUTPUT_FAILED", "Document writer could not start.")));
    child.on("exit", () => finish(undefined, new DocumentOutputError("OUTPUT_FAILED", "Document writer exited without a confirmed result.")));
    child.send(request);
  });
}
