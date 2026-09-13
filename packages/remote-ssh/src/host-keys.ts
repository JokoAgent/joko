import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import { dirname } from "node:path";

import { acquireFileLock, writeFileAtomic } from "./config.js";
import { isRemoteSshError, RemoteSshError } from "./errors.js";
import type {
  SshHostKeyPinRequest,
  SshHostKeyPinStorePort,
  SshHostKeyVerification,
  SshHostKeyVerificationRequest,
  SshHostKeyVerifierPort
} from "./types.js";

const STORE_VERSION = 1;
const MAXIMUM_HOST_KEY_BYTES = 64 * 1024;
const MAXIMUM_STORE_BYTES = 4 * 1024 * 1024;
const FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/u;

interface PersistedHostKeys {
  readonly version: 1;
  readonly pins: Readonly<Record<string, string>>;
}

export interface FileSshHostKeyPinStoreOptions {
  readonly filePath: string;
}

export class FileSshHostKeyPinStore implements SshHostKeyPinStorePort {
  readonly #filePath: string;
  readonly #active = new Set<string>();

  constructor(options: FileSshHostKeyPinStoreOptions) {
    if (typeof options.filePath !== "string" || options.filePath.trim() === "") {
      throw new RemoteSshError("INVALID_ARGUMENT", "filePath must not be empty.", false);
    }
    this.#filePath = options.filePath;
  }

  static async initialize(options: FileSshHostKeyPinStoreOptions): Promise<FileSshHostKeyPinStore> {
    const store = new FileSshHostKeyPinStore(options);
    await ensurePrivateStoreDirectory(options.filePath);
    const release = await acquireFileLock(`${options.filePath}.joko.lock`, "HOST_KEY_CONFLICT");
    try {
      try {
        const stat = await fs.lstat(options.filePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
          throw new RemoteSshError(
            "HOST_KEY_STORE_UNREADABLE",
            "The trusted host key store is unsafe.",
            false
          );
        }
        await readPersistedStore(options.filePath);
        await fs.chmod(options.filePath, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await writeFileAtomic(
          options.filePath,
          `${JSON.stringify(emptyStore(), null, 2)}\n`,
          "HOST_KEY_STORE_WRITE_FAILED"
        );
      }
    } finally {
      await release();
    }
    return store;
  }

  async compareAndPin(request: SshHostKeyPinRequest): Promise<"matched" | "pinned"> {
    validatePinRequest(request);
    if (this.#active.has(request.id)) {
      throw new RemoteSshError(
        "HOST_KEY_CONFLICT",
        "Concurrent host key trust could not be established safely.",
        false
      );
    }
    this.#active.add(request.id);
    try {
      await ensureExistingPrivateStoreDirectory(this.#filePath);
      const release = await acquireFileLock(`${this.#filePath}.joko.lock`, "HOST_KEY_CONFLICT");
      try {
        const current = await readPersistedStore(this.#filePath);
        const stored = current.pins[request.id];
        if (stored !== undefined) {
          if (stored !== request.fingerprint) {
            throw new RemoteSshError(
              "HOST_KEY_CHANGED",
              "The remote host key changed. Connection was refused.",
              false
            );
          }
          return "matched";
        }
        const pins = { ...current.pins, [request.id]: request.fingerprint };
        await writeFileAtomic(
          this.#filePath,
          `${JSON.stringify({ version: STORE_VERSION, pins }, null, 2)}\n`,
          "HOST_KEY_STORE_WRITE_FAILED"
        );
        return "pinned";
      } finally {
        await release();
      }
    } finally {
      this.#active.delete(request.id);
    }
  }
}

export class TofuSshHostKeyVerifier implements SshHostKeyVerifierPort {
  readonly #store: SshHostKeyPinStorePort;

  constructor(store: SshHostKeyPinStorePort) {
    if (store === undefined || typeof store.compareAndPin !== "function") {
      throw new RemoteSshError(
        "HOST_KEY_STORE_MISSING",
        "A trusted host key store is required.",
        false
      );
    }
    this.#store = store;
  }

  async verify(request: SshHostKeyVerificationRequest): Promise<SshHostKeyVerification> {
    const hostname = canonicalSshHostname(request.hostname);
    const port = validatePort(request.port);
    const algorithm = validateAlgorithm(request.algorithm);
    const key = validateHostKey(request.key);
    const fingerprint = sshHostKeyFingerprint(key);
    let disposition: "matched" | "pinned";
    try {
      disposition = await this.#store.compareAndPin({
        id: sshHostKeyPinId(hostname, port, algorithm),
        fingerprint
      });
    } catch (error) {
      throw normalizePinStoreFailure(error);
    }
    if (disposition !== "matched" && disposition !== "pinned") {
      throw new RemoteSshError(
        "HOST_KEY_STORE_CORRUPT",
        "The trusted host key store returned an invalid decision.",
        false
      );
    }
    return Object.freeze({ fingerprint, disposition });
  }
}

export function sshHostKeyFingerprint(key: Uint8Array): string {
  const accepted = validateHostKey(key);
  const digest = createHash("sha256").update(accepted).digest("base64").replace(/=+$/u, "");
  return `SHA256:${digest}`;
}

export function sshHostKeyPinId(hostname: string, port: number, algorithm: string): string {
  const acceptedHostname = canonicalSshHostname(hostname);
  const acceptedPort = validatePort(port);
  const acceptedAlgorithm = validateAlgorithm(algorithm);
  const endpoint = acceptedHostname.includes(":") ? `[${acceptedHostname}]:${acceptedPort}` : `${acceptedHostname}:${acceptedPort}`;
  return `${endpoint}|${acceptedAlgorithm}`;
}

function canonicalSshHostname(value: string): string {
  if (typeof value !== "string") {
    throw new RemoteSshError("HOST_KEY_INVALID", "The SSH host key identity is invalid.", false);
  }
  const unwrapped = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  if (
    unwrapped === "" || unwrapped !== unwrapped.trim() || unwrapped.length > 1_024 ||
    /[\u0000-\u0020\u007f|]/u.test(unwrapped)
  ) {
    throw new RemoteSshError("HOST_KEY_INVALID", "The SSH host key identity is invalid.", false);
  }
  return unwrapped.toLocaleLowerCase("en-US");
}

function validatePort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new RemoteSshError("HOST_KEY_INVALID", "The SSH host key port is invalid.", false);
  }
  return value;
}

function validateAlgorithm(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9@._+-]{0,127}$/u.test(value)) {
    throw new RemoteSshError("HOST_KEY_INVALID", "The SSH host key algorithm is invalid.", false);
  }
  return value;
}

function validateHostKey(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new RemoteSshError("HOST_KEY_MISSING", "The SSH server did not present a host key.", false);
  }
  if (value.byteLength > MAXIMUM_HOST_KEY_BYTES) {
    throw new RemoteSshError("HOST_KEY_INVALID", "The SSH host key is invalid.", false);
  }
  return value;
}

function validatePinRequest(request: SshHostKeyPinRequest): void {
  if (
    typeof request !== "object" || request === null ||
    typeof request.id !== "string" || request.id === "" || request.id.length > 2_048 ||
    /[\u0000-\u001f\u007f]/u.test(request.id) || !FINGERPRINT_PATTERN.test(request.fingerprint)
  ) {
    throw new RemoteSshError("HOST_KEY_INVALID", "The SSH host key pin is invalid.", false);
  }
}

function normalizePinStoreFailure(error: unknown): RemoteSshError {
  if (isRemoteSshError(error)) {
    switch (error.code) {
    case "HOST_KEY_CHANGED":
      return new RemoteSshError("HOST_KEY_CHANGED", "The remote host key changed. Connection was refused.", false);
    case "HOST_KEY_CONFLICT":
      return new RemoteSshError("HOST_KEY_CONFLICT", "Concurrent host key trust could not be established safely.", false);
    case "HOST_KEY_INVALID":
      return new RemoteSshError("HOST_KEY_INVALID", "The SSH host key pin is invalid.", false);
    case "HOST_KEY_STORE_CORRUPT":
      return new RemoteSshError("HOST_KEY_STORE_CORRUPT", "The trusted host key store is malformed.", false);
    case "HOST_KEY_STORE_MISSING":
      return new RemoteSshError("HOST_KEY_STORE_MISSING", "The trusted host key store is missing.", false);
    case "HOST_KEY_STORE_UNREADABLE":
      return new RemoteSshError("HOST_KEY_STORE_UNREADABLE", "The trusted host key store could not be read.", false);
    case "HOST_KEY_STORE_WRITE_FAILED":
      return new RemoteSshError("HOST_KEY_STORE_WRITE_FAILED", "The trusted host key store could not be written safely.", false);
    default:
      break;
    }
  }
  return new RemoteSshError(
    "HOST_KEY_STORE_UNREADABLE",
    "The trusted host key store failed safely.",
    false
  );
}

function emptyStore(): PersistedHostKeys {
  return Object.freeze({ version: STORE_VERSION, pins: Object.freeze({}) });
}

async function readPersistedStore(filePath: string): Promise<PersistedHostKeys> {
  let raw: string;
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new RemoteSshError(
        "HOST_KEY_STORE_UNREADABLE",
        "The trusted host key store is unsafe.",
        false
      );
    }
    if (stat.size > MAXIMUM_STORE_BYTES) {
      throw new RemoteSshError(
        "HOST_KEY_STORE_CORRUPT",
        "The trusted host key store is malformed.",
        false
      );
    }
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof RemoteSshError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new RemoteSshError(
        "HOST_KEY_STORE_MISSING",
        "The trusted host key store is missing.",
        false
      );
    }
    throw new RemoteSshError(
      "HOST_KEY_STORE_UNREADABLE",
      "The trusted host key store could not be read.",
      false
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RemoteSshError(
      "HOST_KEY_STORE_CORRUPT",
      "The trusted host key store is malformed.",
      false
    );
  }
  if (!isPersistedHostKeys(parsed)) {
    throw new RemoteSshError(
      "HOST_KEY_STORE_CORRUPT",
      "The trusted host key store is malformed.",
      false
    );
  }
  return parsed;
}

function isPersistedHostKeys(value: unknown): value is PersistedHostKeys {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  if (record["version"] !== STORE_VERSION) return false;
  const pins = record["pins"];
  if (typeof pins !== "object" || pins === null || Array.isArray(pins)) return false;
  const entries = Object.entries(pins);
  if (entries.length > 50_000) return false;
  return entries.every(([id, fingerprint]) =>
    id !== "" && id.length <= 2_048 && !/[\u0000-\u001f\u007f]/u.test(id) &&
    typeof fingerprint === "string" && FINGERPRINT_PATTERN.test(fingerprint)
  );
}

async function ensurePrivateStoreDirectory(filePath: string): Promise<void> {
  const directory = dirname(filePath);
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe directory");
    await fs.chmod(directory, 0o700);
  } catch {
    throw new RemoteSshError(
      "HOST_KEY_STORE_UNREADABLE",
      "The trusted host key store directory could not be secured.",
      false
    );
  }
}

async function ensureExistingPrivateStoreDirectory(filePath: string): Promise<void> {
  const directory = dirname(filePath);
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe directory");
    await fs.chmod(directory, 0o700);
    await fs.access(directory, fsConstants.R_OK | fsConstants.W_OK);
  } catch {
    throw new RemoteSshError(
      "HOST_KEY_STORE_UNREADABLE",
      "The trusted host key store directory is unavailable.",
      false
    );
  }
}
