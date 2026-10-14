import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { extract as extractTar, list as listTar } from "tar";

export const LOCAL_CODEX_RUNTIME_VERSION = "0.159.2";

interface RuntimeAsset {
  readonly target: string;
  readonly sha256: string;
  readonly size: number;
  readonly entrypoint: string;
}

// Fixed official complete packages, including the code-mode host and resources.
export const LOCAL_CODEX_RUNTIME_ASSETS: Readonly<Record<string, RuntimeAsset>> = Object.freeze({
  "darwin-arm64": { target: "aarch64-apple-darwin", sha256: "38aaf6dce63099fd10988948d03bbc6c0474253aef6961fcbe60f8d154b39101", size: 129522674, entrypoint: "bin/codex" },
  "darwin-x64": { target: "x86_64-apple-darwin", sha256: "6b9b38bfad6ac8019aa6a243ee3ab11d3e22889eafd5458b0344cf20e797e680", size: 140813958, entrypoint: "bin/codex" },
  "linux-x64": { target: "x86_64-unknown-linux-musl", sha256: "9e2d29a713b94478b240dec2f10e11324cd05fad76dc43e7c639bdf8a1337a6b", size: 159961162, entrypoint: "bin/codex" },
  "linux-arm64": { target: "aarch64-unknown-linux-musl", sha256: "05a524a463cadf7e3e22c7f923539c0d0b74c3e78b1f5f1fab52e50e6fb3312f", size: 150270060, entrypoint: "bin/codex" },
  "win32-x64": { target: "x86_64-pc-windows-msvc", sha256: "a7ab591043d99e8a88d0c2bebf15f810b15599a71148c4af944a755af3c71eef", size: 156614559, entrypoint: "bin/codex.exe" },
  "win32-arm64": { target: "aarch64-pc-windows-msvc", sha256: "f017342f77ec57dffff57e59723738ac9f228ddab4f656c2bdfc65f1d9b87da3", size: 144725539, entrypoint: "bin/codex.exe" }
});

export type LocalBackendRuntimeState = "not_supported" | "not_installed" | "ready" | "downloading" | "extracting" | "validating" | "activating" | "complete" | "failed" | "cancelled";
export interface LocalBackendRuntimeSnapshot {
  readonly backendId: string;
  readonly instanceGeneration: number;
  readonly platform: string;
  readonly expectedVersion: string;
  readonly installedVersion?: string;
  readonly state: LocalBackendRuntimeState;
  readonly canInstall: boolean;
  readonly canRepair: boolean;
  readonly manualOverride: boolean;
  readonly receivedBytes: number;
  readonly totalBytes: number;
  readonly requestId?: string;
  readonly failureCode?: string;
}
export interface LocalBackendRuntimeInstallEvent {
  readonly sequence: bigint;
  readonly runtime: LocalBackendRuntimeSnapshot;
}
export interface LocalBackendRuntimeInstallInput {
  readonly requestId: string;
  readonly backendId: string;
  readonly expectedGeneration: number;
  readonly repair: boolean;
}
interface PackageFile { readonly path: string; readonly size: number; readonly sha256: string }
interface Receipt { readonly version: string; readonly platform: string; readonly archiveSha256: string; readonly directory: string }
interface InstallFlight {
  readonly input: LocalBackendRuntimeInstallInput;
  readonly controller: AbortController;
  readonly events: LocalBackendRuntimeInstallEvent[];
  readonly listeners: Set<() => void>;
  completion: Promise<void>;
  terminal: boolean;
  sequence: bigint;
  readonly assertAuthority: () => void;
  adopted: boolean;
}
export interface LocalCodexRuntimeOptions {
  readonly rootDirectory: string;
  readonly backendId: string;
  readonly manualExecutable?: string;
  readonly fallbackExecutable?: string;
  readonly platform?: string;
  readonly architecture?: string;
  readonly fetch?: typeof fetch;
  readonly currentGeneration: () => number;
  readonly adopt: (expectedGeneration: number) => Promise<void>;
}

/** Complete-package provisioning on the service node; public snapshots contain no paths. */
export class LocalCodexRuntime {
  readonly #options: LocalCodexRuntimeOptions;
  readonly #root: string;
  readonly #platform: string;
  readonly #asset: RuntimeAsset | undefined;
  readonly #fetch: typeof fetch;
  readonly #requests = new Map<string, InstallFlight>();
  #flight?: InstallFlight;
  #closed = false;

  constructor(options: LocalCodexRuntimeOptions) {
    this.#options = options;
    this.#root = resolve(options.rootDirectory);
    this.#platform = `${options.platform ?? process.platform}-${options.architecture ?? process.arch}`;
    this.#asset = LOCAL_CODEX_RUNTIME_ASSETS[this.#platform];
    this.#fetch = options.fetch ?? fetch;
  }

  async resolveExecutable(): Promise<string | undefined> {
    if (this.#options.manualExecutable !== undefined) return this.#options.manualExecutable;
    const published = await this.#readPublished();
    return published?.executable ?? this.#options.fallbackExecutable;
  }

  async probe(backendId: string): Promise<LocalBackendRuntimeSnapshot> {
    if (backendId !== this.#options.backendId || this.#asset === undefined) return this.#snapshot("not_supported", backendId);
    if (this.#flight !== undefined && !this.#flight.terminal) return this.#flight.events.at(-1)!.runtime;
    const published = await this.#readPublished();
    if (published === undefined) return this.#snapshot("not_installed");
    try {
      await probeCodexRuntimeVersion(published.executable);
      return this.#snapshot("ready", undefined, LOCAL_CODEX_RUNTIME_VERSION);
    } catch {
      return { ...this.#snapshot("failed"), failureCode: "probe_failed" };
    }
  }

  install(input: LocalBackendRuntimeInstallInput, observerSignal?: AbortSignal, assertAuthority: () => void = () => undefined): AsyncIterable<LocalBackendRuntimeInstallEvent> {
    if (this.#closed) throw new Error("The local Backend runtime owner is closed.");
    if (input.backendId !== this.#options.backendId || this.#asset === undefined) throw new Error("Local runtime setup is unavailable for this Backend or platform.");
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(input.requestId)) throw new Error("The local runtime request identity is invalid.");
    let flight = this.#requests.get(input.requestId);
    if (flight !== undefined) {
      if (JSON.stringify(flight.input) !== JSON.stringify(input)) throw new Error("The local runtime request identity was reused with different input.");
    } else {
      if (this.#flight !== undefined && !this.#flight.terminal) throw new Error("A local Backend runtime installation is already running.");
      if (input.expectedGeneration !== this.#options.currentGeneration()) throw new Error("The Backend instance changed before runtime setup.");
      assertAuthority();
      flight = { input, controller: new AbortController(), events: [], listeners: new Set(), completion: Promise.resolve(), terminal: false, sequence: 0n, assertAuthority, adopted: false };
      this.#requests.set(input.requestId, flight);
      this.#flight = flight;
      this.#emit(flight, this.#snapshot("validating"));
      flight.completion = this.#run(flight);
      void flight.completion.catch(() => undefined);
      if (this.#requests.size > 32) {
        for (const [key, request] of this.#requests) {
          if (request.terminal) { this.#requests.delete(key); break; }
        }
      }
    }
    return this.#observe(flight, observerSignal);
  }

  cancel(backendId: string, requestId: string): boolean {
    if (backendId !== this.#options.backendId) return false;
    const flight = this.#requests.get(requestId);
    if (flight === undefined || flight.terminal || flight.events.at(-1)?.runtime.state === "activating") return false;
    flight.controller.abort(new Error("The runtime installation was cancelled."));
    return true;
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#flight === undefined || this.#flight.terminal) return;
    this.cancel(this.#options.backendId, this.#flight.input.requestId);
    await this.#flight.completion;
  }

  async #run(flight: InstallFlight): Promise<void> {
    const asset = this.#asset!;
    const signal = flight.controller.signal;
    let stage: string | undefined;
    let previous: string | undefined;
    let published = false;
    try {
      signal.throwIfAborted();
      flight.assertAuthority();
      await this.#prepareRoot();
      const current = await this.#readPublished();
      if (!flight.input.repair && current !== undefined) {
        await probeCodexRuntimeVersion(current.executable, signal);
      } else {
        stage = join(this.#root, `.stage-${randomUUID()}`);
        await mkdir(stage, { mode: 0o700 });
        const archive = join(stage, "archive.tar.gz");
        this.#emit(flight, this.#snapshot("downloading"));
        await this.#download(archive, asset, signal, (receivedBytes) => this.#emit(flight, { ...this.#snapshot("downloading"), receivedBytes }));
        this.#emit(flight, { ...this.#snapshot("extracting"), receivedBytes: asset.size });
        const packageRoot = join(stage, "package");
        await mkdir(packageRoot, { mode: 0o700 });
        await extractCodexPackage(archive, packageRoot, signal);
        this.#emit(flight, { ...this.#snapshot("validating"), receivedBytes: asset.size });
        const executable = await validateCodexPackage(packageRoot, asset, signal);
        if (process.platform !== "win32") {
          for (const path of [executable, join(packageRoot, "bin", "codex-code-mode-host"), join(packageRoot, "codex-path", "rg")]) await chmod(path, 0o755);
        }
        const files = await packageFiles(packageRoot, signal);
        await writeFile(join(packageRoot, ".joko-package.json"), JSON.stringify(files), { flag: "wx", mode: 0o600 });
        await probeCodexRuntimeVersion(executable, signal);
        signal.throwIfAborted();
        flight.assertAuthority();
        if (flight.input.expectedGeneration !== this.#options.currentGeneration()) throw new Error("The Backend instance changed during runtime setup.");
        const directory = `${LOCAL_CODEX_RUNTIME_VERSION}-${this.#platform}-${randomUUID()}`;
        await rename(packageRoot, join(this.#root, directory));
        previous = await readFile(join(this.#root, "current.json"), "utf8").catch(() => undefined);
        await this.#writeReceipt({ version: LOCAL_CODEX_RUNTIME_VERSION, platform: this.#platform, archiveSha256: asset.sha256, directory });
        published = true;
      }
      signal.throwIfAborted();
      flight.assertAuthority();
      this.#emit(flight, { ...this.#snapshot("activating", undefined, LOCAL_CODEX_RUNTIME_VERSION), receivedBytes: asset.size });
      // A manual owner override stays selected. Installation never rewrites it.
      if (this.#options.manualExecutable === undefined) await this.#options.adopt(flight.input.expectedGeneration);
      flight.adopted = true;
      this.#emit(flight, { ...this.#snapshot("complete", undefined, LOCAL_CODEX_RUNTIME_VERSION), receivedBytes: asset.size });
    } catch {
      if (published && !flight.adopted) {
        try {
          if (previous === undefined) await rm(join(this.#root, "current.json"), { force: true });
          else await this.#writeCurrent(previous);
        } catch {
          this.#emit(flight, { ...this.#snapshot("failed"), failureCode: "recovery_required" });
          return;
        }
      }
      this.#emit(flight, { ...this.#snapshot(signal.aborted ? "cancelled" : "failed"), failureCode: signal.aborted ? "cancelled" : "install_failed" });
    } finally {
      if (stage !== undefined) await this.#removeStage(stage).catch(() => undefined);
      flight.terminal = true;
      for (const listener of flight.listeners) listener();
    }
  }

  async #download(path: string, asset: RuntimeAsset, signal: AbortSignal, progress: (received: number) => void): Promise<void> {
    const deadline = AbortSignal.timeout(10 * 60_000);
    const downloadSignal = AbortSignal.any([signal, deadline]);
    const response = await this.#fetch(`https://github.com/openai/codex/releases/download/rust-v${LOCAL_CODEX_RUNTIME_VERSION}/codex-package-${asset.target}.tar.gz`, { signal: downloadSignal });
    if (!response.ok || response.body === null) throw new Error("The fixed runtime archive could not be downloaded.");
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) !== asset.size) { await response.body.cancel(); throw new Error("The runtime archive size does not match its pin."); }
    const destination = await open(path, "wx", 0o600);
    const reader = response.body.getReader();
    const hash = createHash("sha256");
    let received = 0;
    let lastProgress = 0;
    try {
      for (;;) {
        downloadSignal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received > asset.size) throw new Error("The runtime archive exceeds its fixed size.");
        hash.update(chunk.value);
        await destination.writeFile(chunk.value);
        if (Date.now() - lastProgress >= 250 || received === asset.size) { progress(received); lastProgress = Date.now(); }
      }
      if (received !== asset.size || hash.digest("hex") !== asset.sha256) throw new Error("The runtime archive failed integrity verification.");
      await destination.sync();
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      await destination.close();
    }
  }

  async #readPublished(): Promise<{ readonly executable: string } | undefined> {
    if (this.#asset === undefined) return undefined;
    try {
      const receipt = JSON.parse(await readFile(join(this.#root, "current.json"), "utf8")) as Receipt;
      if (receipt.version !== LOCAL_CODEX_RUNTIME_VERSION || receipt.platform !== this.#platform || receipt.archiveSha256 !== this.#asset.sha256
        || !new RegExp(`^${LOCAL_CODEX_RUNTIME_VERSION.replaceAll(".", "\\.")}-${this.#platform}-[0-9a-f-]{36}$`, "u").test(receipt.directory)) return undefined;
      const directory = join(this.#root, receipt.directory);
      await assertOwnedDirectory(this.#root);
      await assertOwnedDirectory(directory);
      const executable = await validateCodexPackage(directory, this.#asset);
      const files = JSON.parse(await readFile(join(directory, ".joko-package.json"), "utf8"));
      if (JSON.stringify(files) !== JSON.stringify(await packageFiles(directory))) return undefined;
      return { executable };
    } catch { return undefined; }
  }

  async #prepareRoot(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await assertOwnedDirectory(this.#root);
  }
  async #writeReceipt(receipt: Receipt): Promise<void> { await this.#writeCurrent(JSON.stringify(receipt)); }
  async #writeCurrent(value: string): Promise<void> {
    const temporary = join(this.#root, `.receipt-${randomUUID()}`);
    await writeFile(temporary, value, { flag: "wx", mode: 0o600 });
    try { await rename(temporary, join(this.#root, "current.json")); }
    finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }
  async #removeStage(stage: string): Promise<void> {
    if (!stage.startsWith(`${this.#root}${sep}.stage-`) || resolve(stage) !== stage) throw new Error("The runtime staging authority changed.");
    await assertOwnedDirectory(this.#root);
    await rm(stage, { recursive: true, force: true });
  }
  #snapshot(state: LocalBackendRuntimeState, backendId = this.#options.backendId, installedVersion?: string): LocalBackendRuntimeSnapshot {
    const supported = backendId === this.#options.backendId && this.#asset !== undefined;
    return { backendId, instanceGeneration: this.#options.currentGeneration(), platform: this.#platform,
      expectedVersion: supported ? LOCAL_CODEX_RUNTIME_VERSION : "", ...(installedVersion === undefined ? {} : { installedVersion }), state,
      canInstall: supported && !this.#closed, canRepair: supported && !this.#closed, manualOverride: this.#options.manualExecutable !== undefined,
      receivedBytes: 0, totalBytes: this.#asset?.size ?? 0 };
  }
  #emit(flight: InstallFlight, runtime: LocalBackendRuntimeSnapshot): void {
    const event = { sequence: ++flight.sequence, runtime: { ...runtime, requestId: flight.input.requestId } };
    // Keep observation replay bounded while retaining the latest progress and terminal.
    if (flight.events.length >= 256) flight.events.splice(1, 1);
    flight.events.push(event);
    for (const listener of flight.listeners) listener();
  }
  async *#observe(flight: InstallFlight, signal?: AbortSignal): AsyncGenerator<LocalBackendRuntimeInstallEvent> {
    let delivered = 0n;
    for (;;) {
      signal?.throwIfAborted();
      for (const event of flight.events) if (event.sequence > delivered) { signal?.throwIfAborted(); delivered = event.sequence; yield event; }
      if (flight.terminal) return;
      await new Promise<void>((resolveWait) => {
        const wake = () => { flight.listeners.delete(wake); signal?.removeEventListener("abort", wake); resolveWait(); };
        flight.listeners.add(wake);
        signal?.addEventListener("abort", wake, { once: true });
        if (flight.terminal || signal?.aborted || flight.events.at(-1)!.sequence > delivered) wake();
      });
    }
  }
}

async function assertOwnedDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== resolve(path)) throw new Error("The runtime directory is not canonical.");
}

async function extractCodexPackage(archive: string, destination: string, signal: AbortSignal): Promise<void> {
  let entries = 0;
  let bytes = 0;
  const seen = new Set<string>();
  const safe = (path: string, type: string, size: number) => {
    signal.throwIfAborted();
    const normalized = path.replace(/\/$/u, "");
    if ((type !== "File" && type !== "OldFile" && type !== "Directory") || normalized === "" || normalized.length > 1024
      || normalized.includes("\\") || normalized.startsWith("/") || /[\u0000-\u001f:]/u.test(normalized)
      || normalized.split("/").some(part => part === "" || part === "." || part === "..")) throw new Error("The runtime archive contains an unsafe entry.");
    const identity = normalized.toLocaleLowerCase("en-US");
    if (seen.has(identity)) throw new Error("The runtime archive contains duplicate entries.");
    seen.add(identity);
    entries++;
    bytes += size;
    if (entries > 20_000 || bytes > 2 * 1024 * 1024 * 1024) throw new Error("The runtime archive exceeds its extraction budget.");
  };
  await listTar({ file: archive, strict: true, onReadEntry: entry => safe(entry.path, entry.type, entry.size) });
  await extractTar({ file: archive, cwd: destination, strict: true, preservePaths: false, maxDepth: 32,
    filter: (_path, entry) => { signal.throwIfAborted(); return "type" in entry && (entry.type === "File" || entry.type === "OldFile" || entry.type === "Directory"); } });
}

export async function validateCodexPackage(directory: string, asset: RuntimeAsset, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const manifest = JSON.parse(await readFile(join(directory, "codex-package.json"), "utf8"));
  const expected = { layoutVersion: 1, version: LOCAL_CODEX_RUNTIME_VERSION, target: asset.target, variant: "codex",
    entrypoint: asset.entrypoint, resourcesDir: "codex-resources", pathDir: "codex-path" };
  for (const [field, value] of Object.entries(expected)) if (manifest[field] !== value) throw new Error("The complete runtime package manifest does not match its pin.");
  const suffix = asset.entrypoint.endsWith(".exe") ? ".exe" : "";
  const executable = join(directory, ...asset.entrypoint.split("/"));
  for (const path of [executable, join(directory, "bin", `codex-code-mode-host${suffix}`), join(directory, "codex-path", `rg${suffix}`)]) {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("The complete runtime package is missing a required executable.");
  }
  await assertOwnedDirectory(join(directory, "codex-resources"));
  return executable;
}

async function packageFiles(directory: string, signal?: AbortSignal): Promise<readonly PackageFile[]> {
  const files: PackageFile[] = [];
  let bytes = 0;
  const walk = async (path: string): Promise<void> => {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      signal?.throwIfAborted();
      const absolute = join(path, entry.name);
      const item = relative(directory, absolute).split(sep).join("/");
      if (entry.isSymbolicLink()) throw new Error("The runtime package contains an unsupported link.");
      if (entry.isDirectory()) { await walk(absolute); continue; }
      if (!entry.isFile()) throw new Error("The runtime package contains an unsupported filesystem entry.");
      if (item === ".joko-package.json") continue;
      const size = (await lstat(absolute)).size;
      bytes += size;
      if (files.length >= 20_000 || bytes > 2 * 1024 * 1024 * 1024) throw new Error("The runtime package exceeds its directory budget.");
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(absolute, signal === undefined ? undefined : { signal })) hash.update(chunk);
      files.push({ path: item, size, sha256: hash.digest("hex") });
    }
  };
  await walk(directory);
  if (files.length === 0) throw new Error("The runtime package is empty.");
  return files;
}

export function probeCodexRuntimeVersion(executable: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveProbe, reject) => {
    const child = spawn(executable, ["--version"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("The runtime version probe timed out.")); }, 10_000);
    const abort = () => { child.kill(); reject(new Error("The runtime version probe was cancelled.")); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", chunk => { output += String(chunk); if (output.length > 4096) child.kill(); });
    child.on("error", reject);
    child.on("close", code => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (code === 0 && output.trim() === `codex-cli ${LOCAL_CODEX_RUNTIME_VERSION}`) resolveProbe();
      else reject(new Error("The runtime executable does not report the fixed version."));
    });
  });
}
