import { randomUUID } from "node:crypto";
import { constants, promises as fs, type BigIntStats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { documentFileVersion, sameDocumentIdentity } from "./document-path.js";

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

class WriterError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function assertRoot(request: WriterRequest): Promise<void> {
  const info = await fs.lstat(request.root, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || String(info.dev) !== request.rootDev || String(info.ino) !== request.rootIno) {
    throw new WriterError("PATH_NOT_ALLOWED", "Task working directory changed.");
  }
}

async function assertParent(request: WriterRequest, identity?: BigIntStats, parent = request.relativeParent): Promise<void> {
  await assertRoot(request);
  const current = await fs.realpath(".");
  if (!inside(request.root, current) || relative(request.root, current) !== parent ||
      (identity !== undefined && !sameDocumentIdentity(identity, await fs.lstat(".", { bigint: true })))) {
    throw new WriterError("PATH_NOT_ALLOWED", "Document output directory changed.");
  }
}

async function enterParent(request: WriterRequest): Promise<void> {
  const expected = resolve(request.root, request.relativeParent);
  if (!inside(request.root, expected)) throw new WriterError("PATH_NOT_ALLOWED", "Document output directory escapes the task.");
  const segments = request.relativeParent.split(sep).filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === ".." || segment.includes("\0"))) {
    throw new WriterError("PATH_NOT_ALLOWED", "Document output directory is invalid.");
  }
  let current = request.root;
  for (const segment of segments) {
    await assertRoot(request);
    current = join(current, segment);
    let info;
    try {
      info = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.mkdir(current);
      info = await fs.lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new WriterError("PATH_NOT_ALLOWED", "Document output directory contains a link or non-directory.");
    }
    const real = await fs.realpath(current);
    if (!inside(request.root, real) || real !== current) {
      throw new WriterError("PATH_NOT_ALLOWED", "Document output directory left the task.");
    }
  }
  process.chdir(expected);
  await assertParent(request);
}

async function assertApproval(): Promise<void> {
  await new Promise<void>((accept, reject) => {
    process.once("message", (message: unknown) => {
      if (message !== null && typeof message === "object" && "approved" in message && message.approved === true) accept();
      else reject(new WriterError("PATH_NOT_ALLOWED", "The external document approval was retired."));
    });
    process.send?.({ checkApproval: true });
  });
}

async function enterApprovedParent(request: WriterRequest): Promise<BigIntStats> {
  await assertApproval();
  let parent = "";
  let identity = await fs.lstat(".", { bigint: true });
  if (String(identity.dev) !== request.rootDev || String(identity.ino) !== request.rootIno) {
    throw new WriterError("PATH_NOT_ALLOWED", "The approved document directory changed.");
  }
  await assertParent(request, identity, parent);
  for (const segment of request.relativeParent.split(sep).filter(Boolean)) {
    if (segment === "." || segment === "..") throw new WriterError("PATH_NOT_ALLOWED", "Document output directory is invalid.");
    await fs.mkdir(segment).catch(() => {
      throw new WriterError("PATH_NOT_ALLOWED", "An approved output directory could not be created.");
    });
    identity = await fs.lstat(segment, { bigint: true });
    if (!identity.isDirectory() || identity.isSymbolicLink()) {
      throw new WriterError("PATH_NOT_ALLOWED", "The approved document directory changed.");
    }
    process.chdir(segment);
    parent = join(parent, segment);
    await assertParent(request, identity, parent);
  }
  return identity;
}

async function assertApprovedTarget(request: WriterRequest, identity: BigIntStats): Promise<void> {
  await assertApproval();
  await assertParent(request, identity);
  let version: string | null = null;
  try {
    const target = await fs.lstat(request.targetName, { bigint: true });
    if (!target.isFile() || target.isSymbolicLink()) throw new WriterError("PATH_NOT_ALLOWED", "The approved output is no longer a regular file.");
    version = documentFileVersion(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (version !== request.approvedTargetVersion) throw new WriterError("PATH_NOT_ALLOWED", "The approved output changed before publication.");
}

async function write(request: WriterRequest): Promise<boolean> {
  if (!request || typeof request.root !== "string" || typeof request.relativeParent !== "string"
    || typeof request.targetName !== "string" || request.targetName === "." || request.targetName === ".."
    || request.targetName.includes("/") || request.targetName.includes("\\") || request.targetName.includes("\0")
    || typeof request.bytesBase64 !== "string" || typeof request.overwrite !== "boolean") {
    throw new WriterError("PATH_NOT_ALLOWED", "Document writer request is invalid.");
  }
  const bytes = Buffer.from(request.bytesBase64, "base64");
  if (bytes.length === 0 || bytes.length > 64 * 1024 * 1024 || bytes.toString("base64") !== request.bytesBase64) {
    throw new WriterError("OUTPUT_FAILED", "Document writer bytes are invalid.");
  }
  const approvedParent = request.approvedTargetVersion === undefined ? undefined : await enterApprovedParent(request);
  if (approvedParent === undefined) await enterParent(request);
  const staging = `.joko-document-${randomUUID()}.tmp`;
  let stagedIdentity: { dev: bigint; ino: bigint } | undefined;
  let existingTarget = false;
  try {
    const handle = await fs.open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      const info = await handle.stat({ bigint: true });
      stagedIdentity = { dev: info.dev, ino: info.ino };
    } finally {
      await handle.close();
    }
    if (approvedParent === undefined) await assertParent(request);
    else await assertApprovedTarget(request, approvedParent);
    if (request.overwrite && request.approvedTargetVersion !== null) {
      if (request.approvedTargetVersion !== undefined) existingTarget = true;
      else {
        try {
          const target = await fs.lstat(request.targetName);
          if (!target.isFile() || target.isSymbolicLink()) throw new WriterError("PATH_NOT_ALLOWED", "Overwrite target is not a regular file.");
          existingTarget = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      await fs.rename(staging, request.targetName).catch(() => {
        throw new WriterError("ATOMIC_PUBLISH_UNSUPPORTED", "This location cannot atomically replace the document.");
      });
    } else {
      await fs.link(staging, request.targetName).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") throw new WriterError("FILE_EXISTS", "Document output already exists.");
        throw new WriterError("ATOMIC_PUBLISH_UNSUPPORTED", "This location cannot atomically publish a new document.");
      });
    }
    await assertParent(request, approvedParent);
    return existingTarget;
  } finally {
    if (stagedIdentity !== undefined) {
      try {
        const current = await fs.lstat(staging, { bigint: true });
        if (current.isFile() && !current.isSymbolicLink() && current.dev === stagedIdentity.dev && current.ino === stagedIdentity.ino) {
          await fs.unlink(staging);
        }
      } catch {
        // A missing or replaced staging path is not ours to remove.
      }
    }
  }
}

process.once("message", (message: unknown) => {
  void write(message as WriterRequest).then(
    (existingTarget) => process.send?.({ ok: true, existingTarget }),
    (error: unknown) => process.send?.({
      ok: false,
      code: error instanceof WriterError ? error.code : "OUTPUT_FAILED",
      message: error instanceof Error ? error.message.slice(0, 2_000) : "Document writer failed."
    })
  );
});
