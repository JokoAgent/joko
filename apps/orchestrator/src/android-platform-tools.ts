import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  rename,
  rm,
  stat
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
  MANAGED_OUTBOUND_PROXY_SNAPSHOT_ENV,
  createManagedOutboundProxyResolver,
  hasManagedOutboundProxyEnvironment
} from "@joko/contracts/managed-outbound-proxy";
import type { AndroidAdbPreparer, AndroidAdbPrepareResult } from "@joko/tool-android";
import { createSocks5Dispatcher } from "@joko/outbound-network";
import { ProxyAgent, fetch as proxyFetch, type Dispatcher } from "undici";

const MAXIMUM_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAXIMUM_EXTRACTED_BYTES = 256 * 1024 * 1024;
const MAXIMUM_ENTRIES = 2_048;
const DOWNLOAD_TIMEOUT_MS = 60_000;

const OFFICIAL_ARCHIVES: Readonly<Record<string, string>> = {
  "darwin-arm64": "https://dl.google.com/android/repository/platform-tools-latest-darwin.zip",
  "darwin-x64": "https://dl.google.com/android/repository/platform-tools-latest-darwin.zip",
  "linux-x64": "https://dl.google.com/android/repository/platform-tools-latest-linux.zip",
  "win32-x64": "https://dl.google.com/android/repository/platform-tools-latest-windows.zip"
};

interface AndroidArchiveDownloadInput {
  readonly url: string;
  readonly destination: string;
  readonly signal: AbortSignal;
}

interface AndroidArchiveExtractInput {
  readonly archivePath: string;
  readonly destination: string;
}

export interface ManagedAndroidAdbPreparerOptions {
  readonly dataDirectory: string;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly downloadArchive?: (input: AndroidArchiveDownloadInput) => Promise<void>;
  readonly extractArchive?: (input: AndroidArchiveExtractInput) => Promise<void>;
}

/** Downloads and atomically promotes the official bounded platform-tools ZIP. */
export class ManagedAndroidAdbPreparer implements AndroidAdbPreparer {
  readonly #platform: NodeJS.Platform;
  readonly #architecture: string;
  readonly #root: string;
  readonly #targetDirectory: string;
  readonly #executablePath: string;
  readonly #downloadArchive: (input: AndroidArchiveDownloadInput) => Promise<void>;
  readonly #extractArchive: (input: AndroidArchiveExtractInput) => Promise<void>;
  #preparing: Promise<AndroidAdbPrepareResult> | undefined;

  constructor(options: ManagedAndroidAdbPreparerOptions) {
    this.#platform = options.platform ?? process.platform;
    this.#architecture = options.architecture ?? process.arch;
    this.#root = resolve(options.dataDirectory, "android");
    this.#targetDirectory = resolve(this.#root, "platform-tools");
    assertWithin(this.#targetDirectory, this.#root);
    this.#executablePath = join(
      this.#targetDirectory,
      this.#platform === "win32" ? "adb.exe" : "adb"
    );
    const environment = options.environment ?? process.env;
    this.#downloadArchive = options.downloadArchive
      ?? ((input) => downloadOfficialArchive(input, environment));
    this.#extractArchive = options.extractArchive ?? extractBoundedArchive;
  }

  preparedExecutablePath(): string {
    return this.#executablePath;
  }

  prepare(signal?: AbortSignal): Promise<AndroidAdbPrepareResult> {
    if (signal?.aborted === true) return Promise.reject(abortError());
    const existing = this.#preparing;
    if (existing !== undefined) return withSignal(existing, signal);
    const preparing = this.#prepareNow(signal);
    this.#preparing = preparing;
    return preparing.finally(() => {
      if (this.#preparing === preparing) this.#preparing = undefined;
    });
  }

  async #prepareNow(signal?: AbortSignal): Promise<AndroidAdbPrepareResult> {
    const archiveUrl = OFFICIAL_ARCHIVES[androidPlatformToolsTarget(this.#platform, this.#architecture)];
    if (archiveUrl === undefined) {
      throw new Error("Automatic ADB preparation is unavailable on this platform or architecture.");
    }
    signal?.throwIfAborted();
    await mkdir(this.#root, { recursive: true });
    const temporaryRoot = await mkdtemp(join(this.#root, ".platform-tools-"));
    assertWithin(temporaryRoot, this.#root);
    const archivePath = join(temporaryRoot, "platform-tools.zip");
    const extractionRoot = join(temporaryRoot, "extracted");
    try {
      const combinedSignal = signal === undefined
        ? AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
        : AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]);
      await this.#downloadArchive({ url: archiveUrl, destination: archivePath, signal: combinedSignal });
      signal?.throwIfAborted();
      await mkdir(extractionRoot, { recursive: true });
      await this.#extractArchive({ archivePath, destination: extractionRoot });
      const extractedDirectory = resolve(extractionRoot, "platform-tools");
      assertWithin(extractedDirectory, extractionRoot);
      await validateExtractedTree(extractedDirectory);
      const extractedExecutable = join(
        extractedDirectory,
        this.#platform === "win32" ? "adb.exe" : "adb"
      );
      if (!await isUsableExecutable(extractedExecutable)) {
        throw new Error("The downloaded platform-tools archive does not contain a usable ADB executable.");
      }
      if (this.#platform !== "win32") await chmod(extractedExecutable, 0o755);
      await this.#promote(extractedDirectory);
      if (!await isUsableExecutable(this.#executablePath)) {
        throw new Error("The prepared ADB executable could not be verified after promotion.");
      }
      return { executablePath: this.#executablePath };
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async #promote(extractedDirectory: string): Promise<void> {
    const backup = resolve(this.#root, `.platform-tools-invalid-${randomUUID()}`);
    assertWithin(backup, this.#root);
    const targetExists = await pathExists(this.#targetDirectory);
    if (targetExists) await rename(this.#targetDirectory, backup);
    try {
      await rename(extractedDirectory, this.#targetDirectory);
    } catch (error) {
      if (targetExists) await rename(backup, this.#targetDirectory).catch(() => undefined);
      throw error;
    }
    if (targetExists) await rm(backup, { recursive: true, force: true });
  }
}

export function managedAndroidAdbPreparationSupported(
  platform: NodeJS.Platform,
  architecture: string
): boolean {
  return OFFICIAL_ARCHIVES[androidPlatformToolsTarget(platform, architecture)] !== undefined;
}

export function androidPlatformToolsTarget(platform: NodeJS.Platform, architecture: string): string {
  return `${platform}-${architecture.toLowerCase()}`;
}

async function downloadOfficialArchive(
  input: AndroidArchiveDownloadInput,
  environment: NodeJS.ProcessEnv
): Promise<void> {
  const requested = new URL(input.url);
  assertOfficialDownloadUrl(requested);
  const proxyUrl = resolveAndroidArchiveProxy(requested, environment);
  let dispatcher: Dispatcher | undefined;
  try {
    let response: Response;
    try {
      if (proxyUrl !== undefined) {
        const protocol = new URL(proxyUrl).protocol;
        dispatcher = protocol === "socks5:" || protocol === "socks5h:"
          ? createSocks5Dispatcher(proxyUrl)
          : new ProxyAgent(proxyUrl);
      }
      const request = {
        method: "GET",
        redirect: "follow" as const,
        credentials: "omit" as const,
        signal: input.signal,
        headers: { accept: "application/zip, application/octet-stream" }
      };
      response = dispatcher === undefined
        ? await fetch(requested, request)
        : await proxyFetch(requested, { ...request, dispatcher }) as unknown as Response;
    } catch {
      if (input.signal.aborted) throw abortError();
      throw new Error("The official platform-tools archive could not be downloaded.");
    }
    try {
      assertOfficialDownloadUrl(new URL(response.url));
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
    if (!response.ok || response.body === null) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("The official platform-tools archive could not be downloaded.");
    }
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAXIMUM_ARCHIVE_BYTES) {
      await response.body.cancel().catch(() => undefined);
      throw new Error("The official platform-tools archive exceeds the download limit.");
    }

    let handle;
    try {
      await mkdir(dirname(input.destination), { recursive: true });
      handle = await open(input.destination, "wx", 0o600);
    } catch {
      await response.body.cancel().catch(() => undefined);
      throw new Error("The official platform-tools archive could not be stored.");
    }
    let total = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        input.signal.throwIfAborted();
        let next: ReadableStreamReadResult<Uint8Array>;
        try {
          next = await reader.read();
        } catch {
          if (input.signal.aborted) throw abortError();
          throw new Error("The official platform-tools archive could not be downloaded.");
        }
        if (next.done) break;
        total += next.value.byteLength;
        if (total > MAXIMUM_ARCHIVE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new Error("The official platform-tools archive exceeds the download limit.");
        }
        await handle.write(next.value);
      }
      await handle.sync();
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      await handle.close();
    }
    if (total === 0) throw new Error("The official platform-tools archive is empty.");
  } finally {
    await dispatcher?.close().catch(() => undefined);
  }
}

export function resolveAndroidArchiveProxy(
  requested: URL,
  environment: NodeJS.ProcessEnv
): string | undefined {
  const environmentConfigured = hasManagedOutboundProxyEnvironment(environment);
  const noProxy = boundedNoProxy(environment["NO_PROXY"] ?? environment["no_proxy"]);
  if (environmentConfigured) {
    if (proxyBypassed(requested, noProxy)) return undefined;
    const candidates = requested.protocol === "https:"
      ? [
        environment["HTTPS_PROXY"],
        environment["https_proxy"],
        environment["ALL_PROXY"],
        environment["all_proxy"]
        ]
      : [
          environment["HTTP_PROXY"],
          environment["http_proxy"],
          environment["ALL_PROXY"],
          environment["all_proxy"]
        ];
    const configured = candidates.find((value): value is string => value !== undefined && value !== "");
    return validAndroidProxy(configured);
  }
  const resolveSnapshot = createManagedOutboundProxyResolver(
    environment[MANAGED_OUTBOUND_PROXY_SNAPSHOT_ENV]
  );
  const snapshotProxy = resolveSnapshot(requested.toString());
  return typeof snapshotProxy === "string" ? validAndroidProxy(snapshotProxy) : undefined;
}

function validAndroidProxy(value: string | undefined): string | undefined {
  if (value === undefined || value.length > 16 * 1024 || /[\0\r\n]/u.test(value)) return undefined;
  try {
    const proxy = new URL(value);
    return proxy.protocol === "http:"
      || proxy.protocol === "https:"
      || proxy.protocol === "socks5:"
      || proxy.protocol === "socks5h:"
      ? proxy.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function boundedNoProxy(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" && value.length <= 16 * 1024 && !/[\0\r\n]/u.test(value)
    ? value
    : undefined;
}

function proxyBypassed(target: URL, noProxy: string | undefined): boolean {
  if (noProxy === undefined) return false;
  const hostname = target.hostname.toLowerCase();
  const port = target.port || (target.protocol === "https:" ? "443" : "80");
  return noProxy.split(",").some((entry) => {
    const value = entry.trim().toLowerCase();
    if (value === "*") return true;
    if (value === "") return false;
    const colon = value.lastIndexOf(":");
    const hasPort = colon > 0 && /^\d+$/u.test(value.slice(colon + 1));
    const host = (hasPort ? value.slice(0, colon) : value).replace(/^\./u, "");
    if (hasPort && value.slice(colon + 1) !== port) return false;
    return hostname === host || hostname.endsWith(`.${host}`);
  });
}

async function extractBoundedArchive(input: AndroidArchiveExtractInput): Promise<void> {
  const moduleValue: unknown = await import("extract-zip");
  const extract = isRecord(moduleValue) && typeof moduleValue["default"] === "function"
    ? moduleValue["default"]
    : moduleValue;
  if (typeof extract !== "function") throw new Error("The platform-tools archive extractor is unavailable.");
  let entries = 0;
  let declaredBytes = 0;
  await (extract as (
    archivePath: string,
    options: { readonly dir: string; readonly onEntry: (entry: ArchiveEntry) => void }
  ) => Promise<void>)(input.archivePath, {
    dir: input.destination,
    onEntry: (entry) => {
      entries += 1;
      if (entries > MAXIMUM_ENTRIES) throw new Error("The platform-tools archive has too many entries.");
      validateArchiveEntry(entry);
      declaredBytes += entry.uncompressedSize;
      if (declaredBytes > MAXIMUM_EXTRACTED_BYTES) {
        throw new Error("The extracted platform-tools archive exceeds the size limit.");
      }
    }
  });
}

interface ArchiveEntry {
  readonly fileName: string;
  readonly uncompressedSize: number;
  readonly externalFileAttributes: number;
}

function validateArchiveEntry(entry: ArchiveEntry): void {
  const name = entry.fileName.replaceAll("\\", "/");
  if (
    name === ""
    || name.length > 4_096
    || name.includes("\0")
    || name.startsWith("/")
    || /^[A-Za-z]:/u.test(name)
  ) throw new Error("The platform-tools archive contains an invalid path.");
  const parts = name.split("/").filter((part) => part !== "");
  if (parts.length === 0 || parts.length > 32 || parts[0] !== "platform-tools" || parts.some((part) => part === "." || part === "..")) {
    throw new Error("The platform-tools archive contains an out-of-scope path.");
  }
  if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
    throw new Error("The platform-tools archive contains an invalid entry size.");
  }
  const unixMode = entry.externalFileAttributes >>> 16;
  const fileType = unixMode & 0o170000;
  if (fileType !== 0 && fileType !== 0o040000 && fileType !== 0o100000) {
    throw new Error("The platform-tools archive contains a link or special file.");
  }
}

async function validateExtractedTree(root: string): Promise<void> {
  const rootState = await lstat(root);
  if (!rootState.isDirectory() || rootState.isSymbolicLink()) {
    throw new Error("The extracted platform-tools root is invalid.");
  }
  let entries = 0;
  let bytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    const handle = await opendir(directory);
    for await (const entry of handle) {
      entries += 1;
      if (entries > MAXIMUM_ENTRIES) throw new Error("The extracted platform-tools tree has too many entries.");
      const candidate = resolve(directory, entry.name);
      assertWithin(candidate, root);
      const state = await lstat(candidate);
      if (state.isSymbolicLink() || (!state.isDirectory() && !state.isFile())) {
        throw new Error("The extracted platform-tools tree contains a link or special file.");
      }
      if (state.isDirectory()) pending.push(candidate);
      else {
        bytes += state.size;
        if (bytes > MAXIMUM_EXTRACTED_BYTES) {
          throw new Error("The extracted platform-tools tree exceeds the size limit.");
        }
      }
    }
  }
}

function assertOfficialDownloadUrl(url: URL): void {
  if (
    url.protocol !== "https:"
    || url.hostname !== "dl.google.com"
    || url.username !== ""
    || url.password !== ""
    || url.port !== ""
    || url.search !== ""
    || url.hash !== ""
    || !/^\/android\/repository\/platform-tools-latest-(?:darwin|linux|windows)\.zip$/u.test(url.pathname)
  ) throw new Error("The platform-tools download URL is not an approved official endpoint.");
}

async function isUsableExecutable(path: string): Promise<boolean> {
  try {
    const value = await stat(path);
    return value.isFile() && value.size > 0;
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function assertWithin(candidate: string, root: string): void {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsoluteRelative(rel))) return;
  throw new Error(`Unsafe managed path: ${basename(candidate)}`);
}

function isAbsoluteRelative(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/u.test(value);
}

function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolvePromise, reject).finally(() => signal.removeEventListener("abort", onAbort)).catch(() => undefined);
  });
}

function abortError(): Error {
  return new DOMException("ADB preparation was cancelled.", "AbortError");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
