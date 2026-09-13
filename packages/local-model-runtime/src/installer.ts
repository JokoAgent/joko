import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import { basename, dirname, join, relative, resolve } from "node:path";

import { LocalRuntimeError } from "./errors.js";
import { assertArchiveEntrySafe, assertPathWithin } from "./security.js";
import type { RuntimeInstallProgress, RuntimePreflight } from "./types.js";

export const OFFICIAL_RELEASE_API = "https://api.github.com/repos/ollama/ollama/releases/latest";
export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MS = 60_000;
export const EXTRACT_TIMEOUT_MS = 60_000;
export const MIN_RUNTIME_INSTALL_FREE_BYTES = 1536 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_ARCHIVE_ENTRIES = 8_192;

const ASSET_BY_TARGET = new Map<string, string>([
  ["darwin-arm64", "ollama-darwin.tgz"],
  ["darwin-x64", "ollama-darwin.tgz"],
  ["win32-arm64", "ollama-windows-arm64.zip"],
  ["win32-x64", "ollama-windows-amd64.zip"],
  ["linux-arm64", "ollama-linux-arm64.tgz"],
  ["linux-x64", "ollama-linux-amd64.tgz"]
]);
const DOWNLOAD_HOSTS = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "github-releases.githubusercontent.com"
]);
const VERSION_RE = /^v?(\d+\.\d+\.\d+)$/u;
const DIGEST_RE = /^sha256:([a-f0-9]{64})$/iu;

export interface OfficialRuntimeAsset {
  readonly version: string;
  readonly assetName: string;
  readonly url: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface ManagedRuntimeManifest {
  readonly format: 1;
  readonly version: string;
  readonly binaryRelativePath: string;
  readonly archiveSha256: string;
}

export function runtimeAssetName(platform: NodeJS.Platform, arch: NodeJS.Architecture): string | undefined {
  return ASSET_BY_TARGET.get(`${platform}-${arch}`);
}

export function supportsManagedRuntimeInstall(platform: NodeJS.Platform, arch: NodeJS.Architecture): boolean {
  return runtimeAssetName(platform, arch) !== undefined;
}

export function runtimeInstallPreflight(input: {
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
  readonly freeDiskBytes?: number;
}): RuntimePreflight {
  const supported = supportsManagedRuntimeInstall(input.platform, input.arch);
  const disk = input.freeDiskBytes === undefined
    ? "unknown" as const
    : input.freeDiskBytes >= MIN_RUNTIME_INSTALL_FREE_BYTES
      ? "sufficient" as const
      : "insufficient" as const;
  return {
    allowed: supported && disk !== "insufficient",
    memory: "unknown",
    disk,
    requiredDiskBytes: MIN_RUNTIME_INSTALL_FREE_BYTES,
    ...(!supported
      ? { publicErrorCode: "UNSUPPORTED_PLATFORM" as const }
      : disk === "insufficient"
        ? { publicErrorCode: "DISK_SPACE_LOW" as const }
        : {})
  };
}

export function isAllowedDownloadUrl(value: string, expectedAssetName?: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || !DOWNLOAD_HOSTS.has(url.hostname.toLowerCase())) return false;
  if (url.hostname.toLowerCase() !== "github.com") return true;
  const expected = expectedAssetName === undefined
    ? "(?:ollama-(?:darwin|linux-(?:amd64|arm64))\\.tgz|ollama-windows-(?:amd64|arm64)\\.zip)"
    : expectedAssetName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^/ollama/ollama/releases/download/v\\d+\\.\\d+\\.\\d+/${expected}$`, "u").test(url.pathname);
}

export function selectOfficialAsset(
  release: unknown,
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture
): OfficialRuntimeAsset | undefined {
  const assetName = runtimeAssetName(platform, arch);
  if (assetName === undefined || release === null || typeof release !== "object") return undefined;
  const root = release as Record<string, unknown>;
  const match = typeof root["tag_name"] === "string" ? VERSION_RE.exec(root["tag_name"].trim()) : null;
  if (match?.[1] === undefined || !Array.isArray(root["assets"])) return undefined;
  const found = root["assets"].find((value) => value !== null && typeof value === "object" && (value as Record<string, unknown>)["name"] === assetName);
  if (found === undefined || found === null || typeof found !== "object") return undefined;
  const item = found as Record<string, unknown>;
  const digest = typeof item["digest"] === "string" ? DIGEST_RE.exec(item["digest"].trim()) : null;
  const sizeBytes = item["size"];
  const url = item["browser_download_url"];
  if (digest?.[1] === undefined || typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_ARCHIVE_BYTES) return undefined;
  if (typeof url !== "string" || !isAllowedDownloadUrl(url, assetName)) return undefined;
  return { version: match[1], assetName, url, sha256: digest[1].toLowerCase(), sizeBytes };
}

async function boundedReleaseJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > 2 * 1024 * 1024) throw new LocalRuntimeError("DOWNLOAD_REJECTED", "The official release response is too large.");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024) throw new LocalRuntimeError("DOWNLOAD_REJECTED", "The official release response is too large.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LocalRuntimeError("DOWNLOAD_REJECTED", "The official release response is invalid.");
  }
}

export async function resolveOfficialAsset(input: {
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<OfficialRuntimeAsset> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const onAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await (input.fetchImpl ?? fetch)(OFFICIAL_RELEASE_API, {
      method: "GET",
      redirect: "error",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "Joko-Orchestrator",
        "x-github-api-version": "2022-11-28"
      },
      signal: controller.signal
    });
    if (!response.ok) throw new LocalRuntimeError("DOWNLOAD_REJECTED", "The official release could not be resolved.");
    const asset = selectOfficialAsset(await boundedReleaseJson(response), input.platform, input.arch);
    if (asset === undefined) throw new LocalRuntimeError(runtimeAssetName(input.platform, input.arch) === undefined ? "UNSUPPORTED_PLATFORM" : "DOWNLOAD_REJECTED", "No verified runtime asset is available for this platform.");
    return asset;
  } catch (error) {
    if (input.signal?.aborted) throw new LocalRuntimeError("OPERATION_CANCELLED", "The operation was cancelled.");
    if (controller.signal.aborted) throw new LocalRuntimeError("DOWNLOAD_TIMEOUT", "The official release lookup timed out.");
    if (error instanceof LocalRuntimeError) throw error;
    throw new LocalRuntimeError("DOWNLOAD_REJECTED", "The official release could not be resolved.");
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onAbort);
  }
}

export async function downloadOfficialAsset(input: {
  readonly asset: OfficialRuntimeAsset;
  readonly destination: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (completedBytes: number, totalBytes: number) => void;
  readonly get?: typeof https.get;
}): Promise<void> {
  if (!isAllowedDownloadUrl(input.asset.url, input.asset.assetName) || input.asset.sizeBytes > MAX_ARCHIVE_BYTES) {
    throw new LocalRuntimeError("DOWNLOAD_REJECTED", "The runtime asset is not allowlisted.");
  }
  await mkdir(dirname(input.destination), { recursive: true });
  const temporary = `${input.destination}.${randomUUID()}.part`;
  const digest = createHash("sha256");
  let completed = 0;
  const get = input.get ?? https.get;
  const timeout = setTimeout(() => abort(new LocalRuntimeError("DOWNLOAD_TIMEOUT", "The runtime download timed out.")), DOWNLOAD_TIMEOUT_MS);
  let abort: (error: LocalRuntimeError) => void = () => undefined;
  try {
    await new Promise<void>((resolvePromise, reject) => {
      let settled = false;
      let activeRequest: ReturnType<typeof https.get> | undefined;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        error === undefined ? resolvePromise() : reject(error);
      };
      abort = (error) => {
        activeRequest?.destroy();
        finish(error);
      };
      const follow = (url: string, redirects: number) => {
        if (redirects > MAX_REDIRECTS || !isAllowedDownloadUrl(url, redirects === 0 ? input.asset.assetName : undefined)) {
          finish(new LocalRuntimeError("DOWNLOAD_REJECTED", "The runtime download redirected to a blocked location."));
          return;
        }
        activeRequest = get(url, { headers: { "user-agent": "Joko-Orchestrator" } }, (response) => {
          const status = response.statusCode ?? 0;
          if (status >= 300 && status < 400 && response.headers.location !== undefined) {
            response.resume();
            follow(new URL(response.headers.location, url).toString(), redirects + 1);
            return;
          }
          const declared = Number(response.headers["content-length"] ?? input.asset.sizeBytes);
          if (status !== 200 || !Number.isFinite(declared) || declared <= 0 || declared > MAX_ARCHIVE_BYTES) {
            response.resume();
            finish(new LocalRuntimeError(declared > MAX_ARCHIVE_BYTES ? "DOWNLOAD_TOO_LARGE" : "DOWNLOAD_REJECTED", "The runtime download was rejected."));
            return;
          }
          const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
          const fail = () => finish(new LocalRuntimeError("DOWNLOAD_REJECTED", "The runtime download failed."));
          response.on("data", (chunk: Buffer) => {
            completed += chunk.byteLength;
            if (completed > MAX_ARCHIVE_BYTES || completed > input.asset.sizeBytes) {
              response.destroy();
              output.destroy();
              finish(new LocalRuntimeError("DOWNLOAD_TOO_LARGE", "The runtime download exceeded its verified size."));
              return;
            }
            digest.update(chunk);
            input.onProgress?.(completed, input.asset.sizeBytes);
          });
          response.on("error", fail);
          output.on("error", fail);
          response.pipe(output);
          output.on("close", () => finish());
        });
        activeRequest.on("error", () => finish(new LocalRuntimeError("DOWNLOAD_REJECTED", "The runtime download failed.")));
      };
      if (input.signal?.aborted) {
        finish(new LocalRuntimeError("OPERATION_CANCELLED", "The operation was cancelled."));
        return;
      }
      input.signal?.addEventListener("abort", () => abort(new LocalRuntimeError("OPERATION_CANCELLED", "The operation was cancelled.")), { once: true });
      follow(input.asset.url, 0);
    });
    if (completed !== input.asset.sizeBytes || digest.digest("hex") !== input.asset.sha256) {
      throw new LocalRuntimeError("CHECKSUM_MISMATCH", "The runtime download did not match the official checksum.");
    }
    await rename(temporary, input.destination);
  } finally {
    clearTimeout(timeout);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function tarBinary(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): string {
  if (platform === "win32") return join(environment["SystemRoot"] ?? environment["windir"] ?? "C:\\Windows", "System32", "tar.exe");
  return "/usr/bin/tar";
}

function execFileText(binary: string, arguments_: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(binary, [...arguments_], { timeout: timeoutMs, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error !== null) reject(new LocalRuntimeError("ARCHIVE_REJECTED", "The runtime archive could not be inspected or extracted."));
      else resolvePromise(stdout);
    });
    const abort = () => {
      child.kill();
      reject(new LocalRuntimeError("OPERATION_CANCELLED", "The operation was cancelled."));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

async function validateExtractedTree(root: string, depth = 0): Promise<string[]> {
  if (depth > 8) throw new LocalRuntimeError("ARCHIVE_REJECTED", "The runtime archive is nested too deeply.");
  const binaries: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = join(root, entry.name);
    assertPathWithin(root, candidate);
    const stat = await lstat(candidate);
    if (stat.isSymbolicLink()) throw new LocalRuntimeError("ARCHIVE_REJECTED", "The runtime archive contains a symbolic link.");
    if (stat.isDirectory()) binaries.push(...await validateExtractedTree(candidate, depth + 1));
    else if (stat.isFile() && (entry.name === "ollama" || entry.name === "ollama.exe")) binaries.push(candidate);
  }
  return binaries;
}

export async function extractOfficialArchive(input: {
  readonly archivePath: string;
  readonly destination: string;
  readonly platform: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}): Promise<string> {
  const tar = tarBinary(input.platform, input.environment ?? process.env);
  const entries = (await execFileText(tar, ["-tf", input.archivePath], EXTRACT_TIMEOUT_MS, input.signal)).split(/\r?\n/u).filter(Boolean);
  if (entries.length === 0 || entries.length > MAX_ARCHIVE_ENTRIES) throw new LocalRuntimeError("ARCHIVE_REJECTED", "The runtime archive has an invalid entry count.");
  for (const entry of entries) assertArchiveEntrySafe(entry);
  const verbose = await execFileText(tar, ["-tvf", input.archivePath], EXTRACT_TIMEOUT_MS, input.signal);
  if (verbose.split(/\r?\n/u).some((line) => /^[lh]/u.test(line))) {
    throw new LocalRuntimeError("ARCHIVE_REJECTED", "The runtime archive contains links.");
  }
  await mkdir(input.destination, { recursive: true, mode: 0o700 });
  await execFileText(tar, ["-xf", input.archivePath, "-C", input.destination, "--no-same-owner", "--no-same-permissions"], EXTRACT_TIMEOUT_MS, input.signal);
  const realDestination = await realpath(input.destination);
  const binaries = await validateExtractedTree(realDestination);
  if (binaries.length !== 1) throw new LocalRuntimeError("ARCHIVE_REJECTED", "The runtime archive must contain exactly one executable.");
  const binary = binaries[0]!;
  assertPathWithin(realDestination, await realpath(binary));
  if (input.platform !== "win32") await chmod(binary, 0o755);
  return binary;
}

export function runtimeRoot(dataRoot: string): string {
  return join(dataRoot, "local-model-runtime", "ollama");
}

export function runtimeManifestPath(dataRoot: string): string {
  return join(runtimeRoot(dataRoot), "current.json");
}

export async function readManagedRuntimeManifest(dataRoot: string): Promise<ManagedRuntimeManifest | undefined> {
  try {
    const root = runtimeRoot(dataRoot);
    const parsed = JSON.parse(await readFile(runtimeManifestPath(dataRoot), "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object") return undefined;
    const value = parsed as Record<string, unknown>;
    if (value["format"] !== 1 || typeof value["version"] !== "string" || typeof value["binaryRelativePath"] !== "string" || typeof value["archiveSha256"] !== "string") return undefined;
    assertArchiveEntrySafe(value["binaryRelativePath"]);
    const binary = resolve(root, value["binaryRelativePath"]);
    assertPathWithin(root, binary);
    if (!existsSync(binary)) return undefined;
    return value as unknown as ManagedRuntimeManifest;
  } catch {
    return undefined;
  }
}

export async function managedRuntimeBinary(dataRoot: string): Promise<string | undefined> {
  const manifest = await readManagedRuntimeManifest(dataRoot);
  if (manifest === undefined) return undefined;
  const root = runtimeRoot(dataRoot);
  const binary = resolve(root, manifest.binaryRelativePath);
  try {
    const stat = await lstat(binary);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    assertPathWithin(await realpath(root), await realpath(binary));
    return binary;
  } catch {
    return undefined;
  }
}

export async function installManagedRuntime(input: {
  readonly dataRoot: string;
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: RuntimeInstallProgress) => void;
  readonly resolveAsset?: typeof resolveOfficialAsset;
  readonly downloadAsset?: typeof downloadOfficialAsset;
  readonly extractArchive?: typeof extractOfficialArchive;
}): Promise<{ readonly version: string; readonly binary: string; readonly archiveSha256: string }> {
  const emit = (progress: RuntimeInstallProgress) => input.onProgress?.(progress);
  emit({ phase: "resolving", done: false });
  const asset = await (input.resolveAsset ?? resolveOfficialAsset)({ platform: input.platform, arch: input.arch, signal: input.signal });
  const root = runtimeRoot(input.dataRoot);
  const downloads = join(root, "downloads");
  const archive = join(downloads, `${asset.version}-${asset.assetName}`);
  const stage = join(root, `.stage-${randomUUID()}`);
  const versionDirectory = join(root, `v${asset.version}`);
  try {
    await mkdir(downloads, { recursive: true, mode: 0o700 });
    emit({ phase: "downloading", version: asset.version, completedBytes: 0, totalBytes: asset.sizeBytes, percent: 0, done: false });
    await (input.downloadAsset ?? downloadOfficialAsset)({
      asset,
      destination: archive,
      signal: input.signal,
      onProgress: (completedBytes, totalBytes) => emit({
        phase: "downloading",
        version: asset.version,
        completedBytes,
        totalBytes,
        percent: Math.min(100, Math.round(completedBytes / totalBytes * 100)),
        done: false
      })
    });
    emit({ phase: "verifying", version: asset.version, percent: 100, done: false });
    emit({ phase: "extracting", version: asset.version, done: false });
    const stagedBinary = await (input.extractArchive ?? extractOfficialArchive)({ archivePath: archive, destination: stage, platform: input.platform, signal: input.signal });
    const binaryRelativeToStage = relative(stage, stagedBinary);
    assertArchiveEntrySafe(binaryRelativeToStage);
    emit({ phase: "promoting", version: asset.version, done: false });
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (!existsSync(versionDirectory)) await rename(stage, versionDirectory);
    else await rm(stage, { recursive: true, force: true });
    const binary = join(versionDirectory, binaryRelativeToStage);
    assertPathWithin(versionDirectory, binary);
    const promotedStat = await lstat(binary);
    if (!promotedStat.isFile() || promotedStat.isSymbolicLink()) {
      throw new LocalRuntimeError("ARCHIVE_REJECTED", "The promoted runtime executable is invalid.");
    }
    assertPathWithin(await realpath(versionDirectory), await realpath(binary));
    const manifest: ManagedRuntimeManifest = {
      format: 1,
      version: asset.version,
      binaryRelativePath: relative(root, binary),
      archiveSha256: asset.sha256
    };
    const manifestPath = runtimeManifestPath(input.dataRoot);
    const temporaryManifest = `${manifestPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryManifest, `${JSON.stringify(manifest)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryManifest, manifestPath);
    await rm(archive, { force: true });
    return { version: asset.version, binary, archiveSha256: asset.sha256 };
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    await rm(archive, { force: true }).catch(() => undefined);
    throw error;
  }
}
