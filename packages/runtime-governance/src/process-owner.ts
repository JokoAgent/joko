import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  unlink
} from "node:fs/promises";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export type ProcessRetirementOutcome = "not_running" | "terminated" | "identity_mismatch" | "unconfirmed";

export interface ProcessIdentitySupervisor {
  capture(pid: number): Promise<string | undefined>;
  captureSync(pid: number): string | undefined;
  terminate(pid: number, expectedIdentity: string, timeoutMs: number): Promise<ProcessRetirementOutcome>;
}

export interface DurableProcessOwnerOptions {
  readonly rootDirectory: string;
  readonly instanceId: string;
  readonly generation: number;
  readonly recoverStale: boolean;
  readonly supervisor: ProcessIdentitySupervisor;
}

export interface DurableProcessLease {
  readonly ownerToken: string;
  readonly pid: number;
  readonly processIdentity: string;
}

interface ProcessOwnerManifest extends DurableProcessLease {
  readonly format: 1;
  readonly instanceId: string;
  readonly generation: number;
}

const MAXIMUM_OWNER_BYTES = 16 * 1024;
const OWNER_FILE_PATTERN = /^owner-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/u;
const EMPTY_DIRECTORY_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320, 640] as const;

/**
 * Adapter-private durable authority for exact local child cleanup. One
 * generation may own many simultaneous process leases; every lease has its
 * own immutable manifest and is released only by token, PID and birth proof.
 */
export class DurableProcessOwner {
  #rootDirectory: string;
  readonly #instanceId: string;
  readonly #generation: number;
  readonly #recoverStale: boolean;
  readonly #supervisor: ProcessIdentitySupervisor;
  readonly #leases = new Map<string, ProcessOwnerManifest>();
  readonly #releaseFlights = new Map<string, {
    readonly manifest: ProcessOwnerManifest;
    readonly promise: Promise<void>;
  }>();
  #prepareFlight: Promise<void> | undefined;
  #prepared = false;

  constructor(options: DurableProcessOwnerOptions) {
    this.#rootDirectory = resolve(options.rootDirectory);
    this.#instanceId = normalizedIdentity(options.instanceId);
    this.#generation = positiveSafeInteger(options.generation, "Process owner generation");
    this.#recoverStale = options.recoverStale;
    this.#supervisor = options.supervisor;
  }

  prepare(timeoutMs: number): Promise<void> {
    if (this.#prepared) return Promise.resolve();
    this.#prepareFlight ??= this.#prepareOnce(timeoutMs).then(() => {
      this.#prepared = true;
    }).catch((error: unknown) => {
      this.#prepareFlight = undefined;
      throw error;
    });
    return this.#prepareFlight;
  }

  /**
   * Capture and persist a child before a custom spawner returns it to its
   * caller. There is deliberately no await between birth-identity capture and
   * atomic manifest publication.
   */
  claimSync(pid: number): DurableProcessLease {
    if (!this.#prepared) throw new Error("Process owner storage was not prepared before spawn.");
    const processIdentity = this.#supervisor.captureSync(pid);
    if (processIdentity === undefined || processIdentity.length < 1 || processIdentity.length > 1_024) {
      throw new Error("Child process identity could not be captured.");
    }
    const ownerToken = randomUUID();
    const manifest: ProcessOwnerManifest = {
      format: 1,
      instanceId: this.#instanceId,
      generation: this.#generation,
      ownerToken,
      pid: positiveSafeInteger(pid, "Child process PID"),
      processIdentity
    };
    const directory = this.#generationDirectory(this.#generation);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertSafeDirectorySync(directory);
    chmodSync(directory, 0o700);
    const path = manifestPath(directory, ownerToken);
    const temporary = join(directory, `.${ownerToken}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify(manifest), { encoding: "utf8", flag: "wx", mode: 0o600 });
      renameSync(temporary, path);
      chmodSync(path, 0o600);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* No temporary file was published. */ }
      throw error;
    }
    this.#leases.set(ownerToken, manifest);
    return leaseOf(manifest);
  }

  async releaseAfterExit(lease: DurableProcessLease): Promise<void> {
    const existing = this.#releaseFlights.get(lease.ownerToken);
    if (existing !== undefined) {
      if (!sameLease(existing.manifest, lease)) return;
      return existing.promise;
    }
    const current = this.#leases.get(lease.ownerToken);
    if (current === undefined || !sameLease(current, lease)) return;
    const flight = this.#releaseManifest(current).finally(() => {
      if (this.#releaseFlights.get(current.ownerToken)?.promise === flight) {
        this.#releaseFlights.delete(current.ownerToken);
      }
    });
    this.#releaseFlights.set(current.ownerToken, { manifest: current, promise: flight });
    return flight;
  }

  async #releaseManifest(current: ProcessOwnerManifest): Promise<void> {
    const directory = this.#generationDirectory(current.generation);
    const path = manifestPath(directory, current.ownerToken);
    const retained = await readManifest(path, this.#instanceId, current.generation, current.ownerToken);
    if (!sameManifest(current, retained)) throw new Error("Process-owner lease changed before release.");
    await unlink(path);
    if (this.#leases.get(current.ownerToken) === current) this.#leases.delete(current.ownerToken);
    if (![...this.#leases.values()].some((lease) => lease.generation === current.generation)) {
      await removeEmptyDirectory(directory, () =>
        ![...this.#leases.values()].some((lease) => lease.generation === current.generation));
    }
  }

  async retireLease(lease: DurableProcessLease, timeoutMs: number): Promise<void> {
    const releasing = this.#releaseFlights.get(lease.ownerToken);
    if (releasing !== undefined) {
      if (!sameLease(releasing.manifest, lease)) return;
      return releasing.promise;
    }
    const current = this.#leases.get(lease.ownerToken);
    if (current === undefined || !sameLease(current, lease)) return;
    const outcome = await this.#supervisor.terminate(current.pid, current.processIdentity, timeoutMs);
    if (outcome === "unconfirmed") {
      throw new Error("The exact child process did not confirm hard retirement.");
    }
    await this.releaseAfterExit(current);
  }

  async retireAll(timeoutMs: number): Promise<void> {
    const results = await Promise.allSettled(
      [
        ...[...this.#releaseFlights.values()].map((release) => release.promise),
        ...[...this.#leases.values()].map((lease) => this.retireLease(lease, timeoutMs))
      ]
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more exact child processes remained unconfirmed.");
    }
    const cleanup = await removeEmptyDirectory(this.#generationDirectory(this.#generation));
    if (cleanup === "not_empty") {
      throw new Error("Process-owner generation changed while retiring its children.");
    }
  }

  async #prepareOnce(timeoutMs: number): Promise<void> {
    positiveSafeInteger(timeoutMs, "Process retirement timeout");
    await mkdir(this.#rootDirectory, { recursive: true, mode: 0o700 });
    this.#rootDirectory = await canonicalProcessOwnerRoot(this.#rootDirectory);
    await assertSafeDirectory(this.#rootDirectory);
    await chmod(this.#rootDirectory, 0o700);
    const entries = (await readdir(this.#rootDirectory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[1-9][0-9]*$/u.test(entry.name)) {
        throw new Error("Process-owner storage contains an unsafe entry.");
      }
      const generation = Number(entry.name);
      if (!Number.isSafeInteger(generation)) throw new Error("Process-owner generation is invalid.");
      await assertSafeDirectory(this.#generationDirectory(generation));
      if (!this.#recoverStale && generation === this.#generation) {
        throw new Error("The reserved process generation already has owner records.");
      }
    }
    if (!this.#recoverStale) return;

    const stale: Array<{
      readonly directory: string;
      readonly path: string;
      readonly manifest: ProcessOwnerManifest;
    }> = [];
    for (const entry of entries) {
      const generation = Number(entry.name);
      const directory = this.#generationDirectory(generation);
      const files = (await readdir(directory, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name, "en"));
      if (files.length === 0) {
        const cleanup = await removeEmptyDirectory(directory);
        if (cleanup === "not_empty") {
          throw new Error("Process-owner generation changed during empty-directory recovery.");
        }
        continue;
      }
      for (const file of files) {
        const match = file.name.match(OWNER_FILE_PATTERN);
        if (!file.isFile() || file.isSymbolicLink() || match === null) {
          throw new Error("Process-owner generation contains an unsafe entry.");
        }
        const ownerToken = match[1]!;
        const path = join(directory, file.name);
        stale.push({
          directory,
          path,
          manifest: await readManifest(path, this.#instanceId, generation, ownerToken)
        });
      }
    }

    const outcomes = await Promise.all(stale.map(({ manifest }) => this.#supervisor.terminate(
      manifest.pid,
      manifest.processIdentity,
      timeoutMs
    )));
    if (outcomes.some((outcome) => outcome === "unconfirmed")) {
      throw new Error("A stale child process could not be retired with exact identity proof.");
    }
    for (const { path } of stale) await unlink(path);
    for (const directory of new Set(stale.map((entry) => entry.directory))) {
      const cleanup = await removeEmptyDirectory(directory);
      if (cleanup === "not_empty") {
        throw new Error("Process-owner storage changed during stale-child recovery.");
      }
    }
  }

  #generationDirectory(generation: number): string {
    return join(this.#rootDirectory, String(generation));
  }
}

async function canonicalProcessOwnerRoot(path: string): Promise<string> {
  if (process.platform !== "win32") return path;
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const component of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, component);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Process-owner directory is unsafe.");
    }
  }
  return realpath(absolute);
}

async function readManifest(
  path: string,
  expectedInstanceId: string,
  expectedGeneration: number,
  expectedOwnerToken: string
): Promise<ProcessOwnerManifest> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > MAXIMUM_OWNER_BYTES
    || !samePath(await realpath(path), path)) {
    throw new Error("Process-owner manifest is unsafe.");
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error("Process-owner manifest is malformed.", { cause: error });
  }
  if (!isRecord(value)
    || value["format"] !== 1
    || value["instanceId"] !== expectedInstanceId
    || value["generation"] !== expectedGeneration
    || value["ownerToken"] !== expectedOwnerToken
    || !Number.isSafeInteger(value["pid"]) || Number(value["pid"]) < 1
    || typeof value["processIdentity"] !== "string"
    || value["processIdentity"].length < 1 || value["processIdentity"].length > 1_024
    || Object.keys(value).some((key) => ![
      "format", "instanceId", "generation", "ownerToken", "pid", "processIdentity"
    ].includes(key))) {
    throw new Error("Process-owner manifest failed exact identity validation.");
  }
  return value as unknown as ProcessOwnerManifest;
}

async function assertSafeDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(path), path)) {
    throw new Error("Process-owner directory is unsafe.");
  }
  if (dirname(path) === path) throw new Error("Process-owner directory cannot be a filesystem root.");
}

function assertSafeDirectorySync(path: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(realpathSync(path), path)) {
    throw new Error("Process-owner directory is unsafe.");
  }
  if (dirname(path) === path) throw new Error("Process-owner directory cannot be a filesystem root.");
}

async function removeEmptyDirectory(
  directory: string,
  stillEmpty: () => boolean = () => true
): Promise<"removed" | "missing" | "not_empty" | "active"> {
  for (let attempt = 0; ; attempt += 1) {
    if (!stillEmpty()) return "active";
    try {
      rmdirSync(directory);
      return "removed";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return "missing";
      if (code === "ENOTEMPTY" || code === "EEXIST") return "not_empty";
      const retryDelay = EMPTY_DIRECTORY_RETRY_DELAYS_MS[attempt];
      if ((code !== "EPERM" && code !== "EBUSY") || retryDelay === undefined) throw error;
      await delay(retryDelay);
    }
  }
}

function manifestPath(directory: string, ownerToken: string): string {
  return join(directory, `owner-${ownerToken}.json`);
}

function leaseOf(manifest: ProcessOwnerManifest): DurableProcessLease {
  return {
    ownerToken: manifest.ownerToken,
    pid: manifest.pid,
    processIdentity: manifest.processIdentity
  };
}

function sameLease(left: DurableProcessLease, right: DurableProcessLease): boolean {
  return left.ownerToken === right.ownerToken
    && left.pid === right.pid
    && left.processIdentity === right.processIdentity;
}

function sameManifest(left: ProcessOwnerManifest, right: ProcessOwnerManifest): boolean {
  return left.format === right.format
    && left.instanceId === right.instanceId
    && left.generation === right.generation
    && sameLease(left, right);
}

function normalizedIdentity(value: string): string {
  if (value.trim() === "" || value !== value.trim() || value.length > 512) {
    throw new TypeError("Process owner instance identity must be normalized.");
  }
  return value;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive safe integer.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
