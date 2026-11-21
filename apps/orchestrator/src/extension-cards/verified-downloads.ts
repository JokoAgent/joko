import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { request } from "node:https";
import { join } from "node:path";
import { isPublicAudioResultAddress } from "../mcp-audio-result-mapping.js";
import { extensionNetworkUrl } from "./network-manifest.js";

const MAXIMUM_BYTES = 8 * 1024 ** 3;
const MAXIMUM_RECEIPTS = 32;
const RECEIPT_LIFETIME_MS = 30 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const REDIRECTS = [301, 302, 303, 307, 308];

export interface VerifiedDownloadOwner {
  readonly key: string;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
}

export interface DownloadResponse {
  readonly status: number;
  readonly location?: string;
  readonly contentLength?: string;
  readonly body: AsyncIterable<Uint8Array>;
  readonly close: () => void;
}

type OpenDownload = (url: URL, signal: AbortSignal) => Promise<DownloadResponse>;
type DownloadIdentity = Awaited<ReturnType<typeof captureFile>>;

interface DownloadRequest {
  readonly id: string;
  readonly url: URL;
  readonly sha256: string;
  readonly bytes: number;
}

interface Receipt {
  readonly key: string;
  readonly ownerKey: string;
  readonly token: string;
  readonly fingerprint: string;
  readonly path: string;
  readonly bytes: number;
  readonly file: DownloadIdentity;
  readonly expiresAt: number;
  readonly lifetime: AbortController;
  readonly expiration: ReturnType<typeof setTimeout>;
  leases: number;
}

interface ActiveDownload {
  readonly ownerKey: string;
  readonly fingerprint: string;
  readonly controller: AbortController;
  readonly result: Promise<{ token: string; bytes: number }>;
}

/** Receipts are private to one live installation. A retired file can only be
 * disposed after every consumer has released its lease. */
export class VerifiedExtensionDownloads {
  private readonly active = new Map<string, ActiveDownload>();
  private readonly issued = new Map<string, Receipt>();
  private readonly tokens = new Map<string, Receipt>();
  private readonly cleanup = new Map<string, number>();
  private readonly disposing = new Map<string, Promise<void>>();
  private bytes = 0;
  private directory: Promise<string> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly root: string, private readonly openDownload: OpenDownload = openPublicDownload,
    private readonly now: () => number = Date.now) {}

  async start(owner: VerifiedDownloadOwner, hosts: readonly string[], value: Record<string, unknown>): Promise<{ token: string; bytes: number }> {
    const input = parseDownload(value, hosts);
    checkpoint(owner);
    this.expire();
    const key = `${owner.key}\0${input.id}`;
    const fingerprint = JSON.stringify([input.url.href, input.sha256, input.bytes]);
    const prior = this.issued.get(key);
    const active = this.active.get(key);
    const previousFingerprint = (prior ?? active)?.fingerprint;
    if (previousFingerprint !== undefined && previousFingerprint !== fingerprint) {
      throw new Error("Download ID already belongs to a different artifact.");
    }
    if (prior !== undefined) {
      await this.assertFile(prior);
      checkpoint(owner);
      if (this.tokens.get(prior.token) !== prior) throw new Error("Download receipt expired.");
      return { token: prior.token, bytes: prior.bytes };
    }
    if (active !== undefined) {
      const result = await active.result;
      checkpoint(owner);
      return result;
    }
    if (this.active.size >= 8 || this.active.size + this.issued.size + this.cleanup.size >= MAXIMUM_RECEIPTS
      || this.bytes + input.bytes > MAXIMUM_BYTES) throw new Error("Verified download capacity is in use.");
    this.bytes += input.bytes;
    const controller = new AbortController();
    const signal = AbortSignal.any([owner.signal, controller.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]);
    const authority = { ...owner, signal };
    const result = this.receive(authority, key, fingerprint, input, hosts).finally(() => this.active.delete(key));
    this.active.set(key, { ownerKey: owner.key, fingerprint, controller, result });
    this.timer ??= setInterval(() => this.expire(), 60_000).unref();
    return result;
  }

  async cancel(owner: VerifiedDownloadOwner, id: unknown): Promise<void> {
    checkpoint(owner);
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/u.test(id)) throw new Error("Invalid download ID.");
    const key = `${owner.key}\0${id}`;
    const active = this.active.get(key);
    active?.controller.abort();
    await active?.result.catch(() => undefined);
    const receipt = this.issued.get(key);
    if (receipt !== undefined) this.retireReceipt(receipt);
  }

  async acquire(owner: VerifiedDownloadOwner, token: string): Promise<{
    readonly path: string;
    readonly signal: AbortSignal;
    readonly assertCurrent: () => Promise<void>;
    readonly release: () => void;
  }> {
    checkpoint(owner);
    this.expire();
    const receipt = this.tokens.get(token);
    if (receipt === undefined || receipt.ownerKey !== owner.key) throw new Error("Download receipt is unavailable.");
    receipt.leases += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      receipt.leases -= 1;
      if (receipt.leases === 0 && !this.tokens.has(token)) this.remove(receipt.path, receipt.bytes);
    };
    const assertCurrent = async () => {
      if (released || receipt.expiresAt <= this.now() || this.tokens.get(token) !== receipt) throw new Error("Download receipt expired.");
      checkpoint(owner);
      await this.assertFile(receipt);
      checkpoint(owner);
      if (released || receipt.expiresAt <= this.now() || this.tokens.get(token) !== receipt) throw new Error("Download receipt expired.");
    };
    try {
      await assertCurrent();
      return { path: receipt.path, signal: receipt.lifetime.signal, assertCurrent, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  retire(ownerKey: string): void {
    for (const item of this.active.values()) if (item.ownerKey === ownerKey) item.controller.abort();
    for (const receipt of this.issued.values()) if (receipt.ownerKey === ownerKey) this.retireReceipt(receipt);
  }

  async drain(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const item of this.active.values()) item.controller.abort();
    await Promise.allSettled([...this.active.values()].map(item => item.result));
    for (const receipt of this.issued.values()) this.retireReceipt(receipt);
    this.expire();
    await Promise.all(this.disposing.values());
  }

  private async receive(owner: VerifiedDownloadOwner, key: string, fingerprint: string, input: DownloadRequest, hosts: readonly string[]) {
    let path: string | undefined;
    try {
      this.directory ??= mkdir(this.root, { recursive: true, mode: 0o700 }).then(() => realpath(this.root)).catch(error => {
        this.directory = undefined;
        throw error;
      });
      const directory = await this.directory;
      checkpoint(owner);
      const token = randomUUID();
      const filePath = join(directory, `${token}.blob`);
      const output = await open(filePath, "wx", 0o600);
      path = filePath;
      try { await this.write(owner, input, hosts, output); await output.sync(); }
      finally { await output.close(); }
      const file = await captureFile(filePath);
      if (file.size !== BigInt(input.bytes)) throw new Error("Verified download size changed.");
      checkpoint(owner);
      const expiration = setTimeout(() => {
        const receipt = this.tokens.get(token);
        if (receipt !== undefined) this.retireReceipt(receipt);
      }, RECEIPT_LIFETIME_MS).unref();
      const receipt: Receipt = { key, ownerKey: owner.key, token, fingerprint, path: filePath, bytes: input.bytes,
        file, expiresAt: this.now() + RECEIPT_LIFETIME_MS, lifetime: new AbortController(), expiration, leases: 0 };
      this.issued.set(key, receipt);
      this.tokens.set(token, receipt);
      return { token, bytes: input.bytes };
    } catch (error) {
      if (path === undefined) this.bytes -= input.bytes;
      else await this.remove(path, input.bytes);
      throw error;
    }
  }

  private async write(owner: VerifiedDownloadOwner, input: DownloadRequest, hosts: readonly string[], output: Awaited<ReturnType<typeof open>>): Promise<void> {
    let url = input.url;
    for (let hop = 0; hop <= 5; hop += 1) {
      checkpoint(owner);
      const response = await this.openDownload(url, owner.signal);
      try {
        checkpoint(owner);
        if (REDIRECTS.includes(response.status)) {
          if (hop === 5 || response.location === undefined) throw new Error("Download redirected too many times.");
          url = extensionNetworkUrl(new URL(response.location, url).href, hosts);
          continue;
        }
        if (response.status !== 200 || (response.contentLength !== undefined && Number(response.contentLength) !== input.bytes)) {
          throw new Error("Download response does not match the expected size.");
        }
        const hash = createHash("sha256");
        let total = 0;
        for await (const chunk of response.body) {
          checkpoint(owner);
          total += chunk.byteLength;
          if (total > input.bytes) throw new Error("Download response exceeds the expected size.");
          hash.update(chunk);
          for (let offset = 0; offset < chunk.byteLength;) {
            checkpoint(owner);
            const { bytesWritten } = await output.write(chunk, offset, chunk.byteLength - offset, null);
            if (bytesWritten === 0) throw new Error("Verified download could not be saved.");
            offset += bytesWritten;
          }
        }
        if (total !== input.bytes || hash.digest("hex") !== input.sha256) throw new Error("Download failed size or SHA-256 verification.");
        return;
      } finally { response.close(); }
    }
  }

  private expire(): void {
    for (const receipt of this.issued.values()) if (receipt.expiresAt <= this.now()) this.retireReceipt(receipt);
    for (const [path, bytes] of this.cleanup) this.remove(path, bytes);
  }

  private retireReceipt(receipt: Receipt): void {
    this.issued.delete(receipt.key);
    this.tokens.delete(receipt.token);
    clearTimeout(receipt.expiration);
    receipt.lifetime.abort(new Error("Download receipt expired or was retired."));
    if (receipt.leases === 0) this.remove(receipt.path, receipt.bytes);
  }

  private remove(path: string, bytes: number): Promise<void> {
    const existing = this.disposing.get(path);
    if (existing !== undefined) return existing;
    this.cleanup.set(path, bytes);
    const disposal = rm(path, { force: true }).then(() => {
      this.bytes -= bytes;
      this.cleanup.delete(path);
    }).catch(() => undefined).finally(() => this.disposing.delete(path));
    this.disposing.set(path, disposal);
    return disposal;
  }

  private async assertFile(receipt: Receipt): Promise<void> {
    const current = await captureFile(receipt.path);
    if (current.dev !== receipt.file.dev || current.ino !== receipt.file.ino || current.size !== receipt.file.size ||
      current.mtimeNs !== receipt.file.mtimeNs || current.ctimeNs !== receipt.file.ctimeNs) throw new Error("Verified download changed after receipt issuance.");
  }
}

function parseDownload(value: Record<string, unknown>, hosts: readonly string[]): DownloadRequest {
  const { id, sha256, bytes } = value;
  if (Object.keys(value).some(key => !["id", "url", "sha256", "bytes"].includes(key)) ||
    typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/u.test(id) || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256) ||
    typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAXIMUM_BYTES) {
    throw new Error("A download ID, HTTPS URL, SHA-256, and exact byte length are required.");
  }
  return { id, url: extensionNetworkUrl(value.url, hosts), sha256, bytes };
}

function checkpoint(owner: VerifiedDownloadOwner): void {
  owner.signal.throwIfAborted();
  owner.assertCurrent();
}

async function captureFile(path: string) {
  const file = await lstat(path, { bigint: true });
  if (!file.isFile() || file.isSymbolicLink() || await realpath(path) !== path) throw new Error("Verified download is not a regular cache file.");
  return file;
}

async function openPublicDownload(url: URL, signal: AbortSignal): Promise<DownloadResponse> {
  signal.throwIfAborted();
  const addresses = await lookup(url.hostname, { all: true });
  signal.throwIfAborted();
  if (addresses.length === 0 || addresses.some(item => !isPublicAudioResultAddress(item.address))) throw new Error("Download destination is not a public address.");
  return await new Promise<DownloadResponse>((resolve, reject) => {
    const outbound = request({ hostname: addresses[0]!.address, port: 443, servername: url.hostname,
      path: `${url.pathname}${url.search}`, method: "GET", agent: false, rejectUnauthorized: true, signal,
      headers: { host: url.hostname, accept: "*/*", "accept-encoding": "identity" } }, response => resolve({
      status: response.statusCode ?? 500, location: response.headers.location, contentLength: response.headers["content-length"],
      body: response, close: () => response.destroy()
    }));
    outbound.once("error", reject);
    outbound.end();
  });
}
