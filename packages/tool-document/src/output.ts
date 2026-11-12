import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  approveExternalDocumentPath, documentFileVersion, documentPathInside,
  type DocumentPathAuthorizer
} from "./document-path.js";
import { readPreparedDocumentInput } from "./input.js";

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
  readonly approvedTargetVersion?: string | null;
}

type WriterResult =
  | { readonly ok: true; readonly existingTarget: boolean }
  | { readonly ok: false; readonly code: DocumentOutputErrorCode; readonly message: string };

/** Publish completed document bytes through one root-bound writer process. */
export async function publishDocumentOutput(input: {
  readonly root: string;
  readonly outPath: string;
  readonly bytes: Uint8Array;
  readonly overwrite: boolean;
  readonly signal?: AbortSignal;
  readonly assertCurrent?: () => void;
  readonly authorizePath?: DocumentPathAuthorizer;
}): Promise<{
  readonly path: string;
  readonly relativePath?: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly existingTarget: boolean;
}> {
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
  const requested = resolve(root, input.outPath);
  const inTask = documentPathInside(root, requested);
  if (!inTask && (input.authorizePath === undefined || requested === root)) {
    throw new DocumentOutputError("PATH_NOT_ALLOWED", "Document output must stay in the task working directory.");
  }
  const approved = inTask || input.authorizePath === undefined ? undefined : await approveExternalDocumentPath({
    path: requested, operation: "write", overwrite: input.overwrite,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  }, input.authorizePath);
  const path = approved?.path ?? requested;
  const writerRoot = approved?.root ?? root;
  const writerRootIdentity = approved?.rootIdentity ?? rootInfo;
  const targetName = basename(path);
  if (targetName === "." || targetName === ".." || targetName.includes("\0")) {
    throw new DocumentOutputError("PATH_NOT_ALLOWED", "Document output filename is invalid.");
  }
  const request: WriterRequest = {
    root: writerRoot,
    rootDev: String(writerRootIdentity.dev),
    rootIno: String(writerRootIdentity.ino),
    relativeParent: relative(writerRoot, dirname(path)),
    targetName,
    bytesBase64: Buffer.from(input.bytes).toString("base64"),
    overwrite: input.overwrite,
    ...(approved === undefined ? {} : {
      approvedTargetVersion: approved.fileIdentity === null ? null : documentFileVersion(approved.fileIdentity)
    })
  };
  const assertCurrent = (): void => {
    input.signal?.throwIfAborted();
    input.assertCurrent?.();
    approved?.assertCurrent();
  };
  assertCurrent();
  const result = await invokeWriter(request, input.signal, approved === undefined ? undefined : assertCurrent);
  if (!result.ok) throw new DocumentOutputError(result.code, result.message);
  assertCurrent();
  const realPath = await fs.realpath(path).catch(() => {
    throw new DocumentOutputError("OUTPUT_FAILED", "Published document could not be read back.");
  });
  if (realPath !== path) {
    throw new DocumentOutputError("PATH_NOT_ALLOWED", "Published document path changed.");
  }
  const readback = approved === undefined ? await fs.readFile(realPath) : await readPreparedDocumentInput({
    root: writerRoot, path: realPath, expected: await fs.lstat(realPath, { bigint: true }), approved
  }, MAXIMUM_OUTPUT_BYTES, input.signal);
  const sha256 = createHash("sha256").update(readback).digest("hex");
  if (readback.byteLength !== input.bytes.byteLength
    || sha256 !== createHash("sha256").update(input.bytes).digest("hex")) {
    throw new DocumentOutputError("OUTPUT_FAILED", "Published document failed readback verification.");
  }
  assertCurrent();
  return { path, ...(inTask ? { relativePath: relative(root, path) } : {}),
    bytes: readback.byteLength, sha256, existingTarget: result.existingTarget };
}

async function invokeWriter(request: WriterRequest, signal: AbortSignal | undefined, authorizeCommit?: () => void): Promise<WriterResult> {
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
      const settle = (): void => {
        if (error !== undefined) reject(error);
        else resolveResult(result!);
      };
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
        settle();
        return;
      }
      // The writer's cwd retains the task directory until OS exit, including
      // after kill() succeeds. Do not return while that owner still holds it.
      const retirementDeadline = setTimeout(() => reject(new DocumentOutputError(
        "OUTPUT_FAILED", "Document writer exit could not be confirmed."
      )), 1_000);
      child.once("exit", () => { clearTimeout(retirementDeadline); settle(); });
      try { child.kill("SIGKILL"); } catch { /* An actual exit receipt is still required. */ }
    };
    const abort = (): void => finish(undefined, new DocumentOutputError("OUTPUT_FAILED", "Document output was cancelled."));
    const timer = setTimeout(() => finish(undefined, new DocumentOutputError("OUTPUT_FAILED", "Document output timed out.")), WRITE_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object") return;
      if ("checkApproval" in message && message.checkApproval === true) {
        let approved = false;
        if (authorizeCommit !== undefined) {
          try { authorizeCommit(); approved = true; } catch { /* The writer retires its staging file. */ }
        }
        if (!finished && child.connected) child.send({ approved }, error => {
          if (error) finish(undefined, new DocumentOutputError("OUTPUT_FAILED", "Document writer approval could not be delivered."));
        });
        return;
      }
      const result = message as Partial<WriterResult>;
      if (result.ok === true && typeof result.existingTarget === "boolean") finish({ ok: true, existingTarget: result.existingTarget });
      else if (result.ok === false && typeof result.code === "string" && typeof result.message === "string") {
        finish({ ok: false, code: result.code, message: result.message.slice(0, 2_000) });
      }
    });
    child.on("error", () => finish(undefined, new DocumentOutputError("OUTPUT_FAILED", "Document writer could not start.")));
    child.on("exit", () => finish(undefined, new DocumentOutputError("OUTPUT_FAILED", "Document writer exited without a confirmed result.")));
    child.send(request);
  });
}
