import { isAbsolute, resolve } from "node:path";
import { Worker } from "node:worker_threads";

import {
  ExtensionLibrarySqlCore,
  type ExtensionLibrarySqlWorkerReply,
  type ExtensionLibrarySqlWorkerRequest,
  type ExtensionLibrarySqlWorkerStartup
} from "./extension-library-sql.js";
import { ExtensionLibraryError, ExtensionLibraryVault } from "./extension-library-vault.js";

if (!process.send) throw new Error("Extension Library SQL worker requires an owning process.");
const parentPid = Number(process.env["JOKO_PARENT_PROCESS_ID"]);
if (!Number.isSafeInteger(parentPid) || parentPid <= 1 || process.ppid !== parentPid) throw new Error("Library SQL owner process is unavailable.");
// IPC disconnect cannot run while SQLite occupies this main thread. This pure
// JS isolate remains schedulable and may terminate only its own OS process.
const parentWatchdog = new Worker(`
  const { workerData } = require('node:worker_threads');
  const check = () => {
    try {
      if (process.ppid !== workerData.parentPid) throw new Error('Owner changed');
      process.kill(workerData.parentPid, 0);
    } catch { process.kill(process.pid, 'SIGKILL'); }
  };
  check(); setInterval(check, 250);
`, { eval: true, execArgv: [], env: {}, workerData: { parentPid },
  resourceLimits: { maxOldGenerationSizeMb: 8, maxYoungGenerationSizeMb: 1 } });
parentWatchdog.on("error", () => process.kill(process.pid, "SIGKILL"));
parentWatchdog.unref();
const fences = new Map<number, (allowed: boolean) => void>();
let nextFenceId = 1;
let initialized = false;
let acceptStartup!: (value: ExtensionLibrarySqlWorkerStartup) => void;
const core = new Promise<ExtensionLibrarySqlWorkerStartup>((accept) => { acceptStartup = accept; }).then(initialize);
let tail: Promise<void> = Promise.resolve();

process.once("disconnect", () => process.exit(1));
process.on("message", (value: unknown) => {
  if (value !== null && typeof value === "object" && "kind" in value) {
    if (value.kind === "startup" && !initialized) {
      initialized = true; acceptStartup(validateStartup(value)); return;
    }
    if (value.kind === "mutation_fence" && "id" in value && typeof value.id === "number") {
      const accept = fences.get(value.id);
      fences.delete(value.id);
      accept?.("allowed" in value && value.allowed === true);
      return;
    }
  }
  tail = tail.then(async () => {
    const request = validateRequest(value);
    if (request === undefined) throw new ExtensionLibraryError("PATH_INVALID", "Library SQL worker request is invalid.");
    try {
      const owner = await core;
      const result = await dispatch(owner, request);
      process.send?.({ id: request.id, ok: true, value: result } satisfies ExtensionLibrarySqlWorkerReply);
    } catch (error) {
      const failure = error instanceof ExtensionLibraryError
        ? error
        : new ExtensionLibraryError("SQL_FAILED", "Library SQL worker operation failed.", { cause: error });
      process.send?.({
        id: request.id,
        ok: false,
        error: { code: failure.code, message: boundedMessage(failure.message) }
      } satisfies ExtensionLibrarySqlWorkerReply);
    }
  }).catch(() => {
    process.exitCode = 1;
    process.disconnect?.();
  });
});

async function initialize(input: ExtensionLibrarySqlWorkerStartup): Promise<ExtensionLibrarySqlCore> {
  const assertAuthorityCurrent = async (): Promise<void> => {
    const id = nextFenceId++;
    const allowed = await new Promise<boolean>((accept) => {
      fences.set(id, accept);
      process.send?.({ kind: "mutation_fence", id }, (error) => {
        if (error) { fences.delete(id); accept(false); }
      });
    });
    if (!allowed) {
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
    || input["limits"] === null || typeof input["limits"] !== "object" || Array.isArray(input["limits"])) {
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
