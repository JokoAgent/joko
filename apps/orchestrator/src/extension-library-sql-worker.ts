import { isAbsolute, resolve } from "node:path";
import { parentPort, workerData } from "node:worker_threads";

import {
  ExtensionLibrarySqlCore,
  type ExtensionLibrarySqlWorkerReply,
  type ExtensionLibrarySqlWorkerRequest,
  type ExtensionLibrarySqlWorkerStartup
} from "./extension-library-sql.js";
import { ExtensionLibraryError, ExtensionLibraryVault } from "./extension-library-vault.js";

const port = parentPort;
if (port === null) throw new Error("Extension Library SQL worker requires a parent port.");

const startup = validateStartup(workerData);
const core = initialize(startup);
let tail: Promise<void> = Promise.resolve();

port.on("message", (value: unknown) => {
  tail = tail.then(async () => {
    const request = validateRequest(value);
    if (request === undefined) throw new ExtensionLibraryError("PATH_INVALID", "Library SQL worker request is invalid.");
    try {
      const owner = await core;
      const result = await dispatch(owner, request);
      port.postMessage({ id: request.id, ok: true, value: result } satisfies ExtensionLibrarySqlWorkerReply);
    } catch (error) {
      const failure = error instanceof ExtensionLibraryError
        ? error
        : new ExtensionLibraryError("SQL_FAILED", "Library SQL worker operation failed.", { cause: error });
      port.postMessage({
        id: request.id,
        ok: false,
        error: { code: failure.code, message: boundedMessage(failure.message) }
      } satisfies ExtensionLibrarySqlWorkerReply);
    }
  }).catch(() => {
    process.exitCode = 1;
    port.close();
  });
});

async function initialize(input: ExtensionLibrarySqlWorkerStartup): Promise<ExtensionLibrarySqlCore> {
  const authorityState = new Int32Array(input.authorityState);
  const assertAuthorityCurrent = (): void => {
    if (Atomics.load(authorityState, 0) !== 0) {
      throw new ExtensionLibraryError("UNAVAILABLE", "Extension Library session authority was revoked.");
    }
  };
  const vault = new ExtensionLibraryVault({
    root: input.root,
    extensionId: input.extensionId,
    beforeFilesystemMutation: assertAuthorityCurrent
  });
  const status = await vault.open({ create: false });
  if (status.state === "unavailable") {
    throw new ExtensionLibraryError("UNAVAILABLE", "Extension Library is unavailable to its SQL worker.");
  }
  return new ExtensionLibrarySqlCore(vault, { limits: input.limits });
}

async function dispatch(owner: ExtensionLibrarySqlCore, request: ExtensionLibrarySqlWorkerRequest): Promise<unknown> {
  switch (request.operation) {
    case "open": return owner.open(request.input);
    case "close": return owner.close(request.handleId);
    case "closeAll": return owner.closeAll();
    case "execute": return owner.execute(request.handleId, request.sql, request.parameters);
    case "batch": return owner.batch(request.handleId, request.statements);
    case "migrate": return owner.migrate(request.handleId, request.migrations);
    case "backup": return owner.backup(request.handleId, request.targetPath);
    case "check": return owner.check(request.handleId);
    case "userVersion": return owner.userVersion(request.handleId);
  }
}

function validateStartup(value: unknown): ExtensionLibrarySqlWorkerStartup {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Extension Library SQL worker startup.");
  const input = value as Record<string, unknown>;
  if (typeof input["root"] !== "string" || !isAbsolute(input["root"]) || resolve(input["root"]) !== input["root"]
    || typeof input["extensionId"] !== "string" || !/^extension_[a-f0-9]{32}$/u.test(input["extensionId"])
    || input["limits"] === null || typeof input["limits"] !== "object" || Array.isArray(input["limits"])
    || !(input["authorityState"] instanceof SharedArrayBuffer)
    || input["authorityState"].byteLength !== Int32Array.BYTES_PER_ELEMENT) {
    throw new Error("Invalid Extension Library SQL worker startup.");
  }
  return value as ExtensionLibrarySqlWorkerStartup;
}

function validateRequest(value: unknown): ExtensionLibrarySqlWorkerRequest | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const request = value as Record<string, unknown>;
  return Number.isSafeInteger(request["id"]) && (request["id"] as number) >= 1
    && typeof request["operation"] === "string"
    ? value as ExtensionLibrarySqlWorkerRequest
    : undefined;
}

function boundedMessage(value: string): string {
  return Buffer.byteLength(value) <= 4_096 ? value : "Library SQL worker operation failed.";
}
