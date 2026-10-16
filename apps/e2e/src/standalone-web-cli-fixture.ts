import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createE2eClients, type PairedClient } from "./connect-clients.js";

export const STANDALONE_WORKSPACE_ID = "workspace-standalone-web";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const standaloneCliEntry = join(repositoryRoot, "apps", "orchestrator", "dist", "main.js");
// Workspace package exports point at TypeScript sources. This is the same
// dependency loader used by the existing real managed-child integration test;
// the service entry itself is the built, unmodified production CLI.

interface ChildObservation {
  readonly pid: number;
  readonly generation: number;
  readonly dependencyLoader: "workspace-tsx" | "none";
  exited: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderrBytes: number;
  retirement?: "production-sigterm" | "windows-owned-tree" | "forced-root";
  treeRetirementSucceeded?: boolean;
}

/** A separate production CLI, never an in-process application/server fixture. */
export class StandaloneWebCliFixture {
  readonly root: string;
  readonly publicPort: number;
  readonly internalPort: number;
  readonly baseUrl: string;
  readonly cliEntry: string;
  readonly dependencyLoader: "workspace-tsx" | "none";
  readonly observations: ChildObservation[] = [];
  readonly #environment: NodeJS.ProcessEnv;
  #child: ChildProcessWithoutNullStreams | undefined;
  #pairingCode: string | undefined;
  #pairingRevision = 0;
  #closed = false;

  private constructor(root: string, publicPort: number, internalPort: number, webDirectory: string,
    cliEntry: string, staged: boolean) {
    this.root = root;
    this.publicPort = publicPort;
    this.internalPort = internalPort;
    this.baseUrl = `http://127.0.0.1:${publicPort}`;
    this.cliEntry = cliEntry;
    this.dependencyLoader = staged ? "none" : "workspace-tsx";
    // Preserve only OS/runtime inputs. In particular, an Actions account's model
    // credentials, proxy configuration and unrelated JOKO_* settings stay out.
    const inherited: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR",
      "COMSPEC", "ComSpec", "PATHEXT", "LANG", "LC_ALL", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH"]) {
      if (process.env[name] !== undefined) inherited[name] = process.env[name];
    }
    const profile = join(root, "profile");
    this.#environment = {
      ...inherited,
      HOME: profile, USERPROFILE: profile,
      APPDATA: join(profile, "AppData", "Roaming"), LOCALAPPDATA: join(profile, "AppData", "Local"),
      XDG_CONFIG_HOME: join(profile, ".config"), XDG_DATA_HOME: join(profile, ".local", "share"),
      JOKO_HOST: "127.0.0.1", JOKO_PORT: String(publicPort), JOKO_INTERNAL_PORT: String(internalPort),
      JOKO_PUBLIC_ORIGIN: this.baseUrl, JOKO_ALLOW_INSECURE_LOOPBACK: "1",
      JOKO_LAN_DISCOVERY: "0", JOKO_VOICE_DICTIONARY_LAN_DISCOVERY: "0",
      JOKO_DATA_DIR: join(root, "data"), JOKO_PI_AGENT_HOME: join(root, "data", "pi-agent-home"),
      JOKO_WORKSPACE_ROOT: join(root, "workspace"), JOKO_WORKSPACE_ID: STANDALONE_WORKSPACE_ID,
      JOKO_WORKSPACE_NAME: "Standalone Web workspace", JOKO_WEB_DIR: webDirectory,
      JOKO_BROWSER_ENABLED: "0", JOKO_CORS_ORIGINS: this.baseUrl
    };
  }

  static async create(webDirectory: string): Promise<StandaloneWebCliFixture> {
    const configuredEntry = process.env.JOKO_STANDALONE_ORCHESTRATOR_ENTRY?.trim();
    if (configuredEntry !== undefined && !isAbsolute(configuredEntry)) {
      throw new Error("The standalone staged CLI entry must be absolute.");
    }
    const entry = configuredEntry ?? standaloneCliEntry;
    if (!(await lstat(entry)).isFile()) throw new Error("The standalone CLI entry must be a regular built file.");
    const cliEntry = await realpath(entry);
    const root = await realpath(await mkdtemp(join(tmpdir(), "joko-standalone-web-cli-")));
    try {
      for (const directory of ["data", "workspace", "profile", "browser-profile"]) {
        await mkdir(join(root, directory), { recursive: true, mode: 0o700 });
      }
      await writeFile(join(root, "workspace", "README.md"), "# Standalone Web CLI fixture\n", { mode: 0o600 });
      const publicPort = await freeLoopbackPort();
      let internalPort = await freeLoopbackPort();
      while (internalPort === publicPort) internalPort = await freeLoopbackPort();
      return new StandaloneWebCliFixture(root, publicPort, internalPort, webDirectory,
        cliEntry, configuredEntry !== undefined);
    } catch (error) {
      await removeOwnedRoot(root);
      throw error;
    }
  }

  async start(): Promise<void> {
    if (this.#closed || this.#child !== undefined) throw new Error("The owned CLI is already running or retired.");
    this.#pairingCode = undefined;
    const nodeArguments = this.dependencyLoader === "none" ? [] : ["--import", import.meta.resolve("tsx")];
    const child = spawn(process.execPath, [...nodeArguments, this.cliEntry], {
      cwd: join(this.root, "workspace"), env: this.#environment, windowsHide: true, shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.#child = child;
    const observation: ChildObservation = {
      pid: child.pid ?? 0, generation: this.observations.length + 1, dependencyLoader: this.dependencyLoader,
      exited: false, exitCode: null, signal: null, stderrBytes: 0
    };
    this.observations.push(observation);
    let pendingLine = "";
    child.stdout.on("data", (bytes: Buffer) => {
      // CLI console pairing output is an out-of-band secret. Keep only the
      // bounded current code in memory; never retain or export console logs.
      for (const character of bytes.toString("utf8")) {
        if (character === "\n") {
          const match = /^Orchestrator pairing code: ([A-Z0-9-]{6,32}) \(expires /u.exec(pendingLine);
          if (match !== null) { this.#pairingCode = match[1]; this.#pairingRevision += 1; }
          pendingLine = "";
        } else if (character !== "\r") {
          pendingLine = pendingLine.length < 512 ? pendingLine + character : "";
        }
      }
    });
    child.stderr.on("data", (bytes: Buffer) => { observation.stderrBytes += bytes.byteLength; });
    child.once("error", () => { observation.exited = true; });
    child.once("exit", (code, signal) => {
      observation.exited = true; observation.exitCode = code; observation.signal = signal;
    });
    await pollOwned(async () => {
      if (observation.exited) throw new Error("The independent production CLI exited during startup.");
      try {
        const response = await fetch(`${this.baseUrl}/healthz`, { signal: AbortSignal.timeout(1000) });
        return response.ok && (await response.json() as { status?: string }).status === "ok";
      } catch { return false; }
    }, value => value, "independent CLI health", 60_000);
  }

  async pairingCode(): Promise<string> {
    const revision = this.#pairingRevision;
    await createE2eClients(this.baseUrl).connection.beginPairing({ deviceDisplayName: "Standalone Web browser" });
    await pollOwned(async () => this.#pairingRevision > revision && this.#pairingCode !== undefined,
      value => value, "owner console pairing announcement", 10_000);
    return this.#pairingCode!;
  }

  async pairInspector(): Promise<PairedClient> {
    const anonymous = createE2eClients(this.baseUrl);
    const code = await this.pairingCode();
    const completed = (await anonymous.connection.completePairing({
      humanCode: code, deviceDisplayName: "Standalone CLI RPC inspector"
    })).result;
    if (!completed?.authKey || !completed.connection?.connectionId || !completed.device?.deviceId) {
      throw new Error("The independent CLI did not complete normal public pairing.");
    }
    return {
      authKey: completed.authKey, connectionId: completed.connection.connectionId,
      deviceId: completed.device.deviceId, clients: createE2eClients(this.baseUrl, completed.authKey, 30_000)
    };
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (child === undefined) return;
    const observation = this.observations.at(-1)!;
    if (child.pid === undefined) {
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      this.#child = undefined;
      return;
    }
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === "win32") {
        // Windows cannot deliver a POSIX SIGTERM to the CLI's shutdown handler.
        // Retire only this owned live process tree, including its real Pi CLI.
        const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
        if (!systemRoot || !isAbsolute(systemRoot)) throw new Error("The Windows retirement helper is unavailable.");
        observation.retirement = "windows-owned-tree";
        const result = spawnSync(join(systemRoot, "System32", "taskkill.exe"),
          ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5000 });
        observation.treeRetirementSucceeded = result.status === 0 && result.error === undefined;
      } else {
        observation.retirement = "production-sigterm";
        child.kill("SIGTERM");
      }
    }
    try {
      await pollOwned(async () => child.exitCode !== null || child.signalCode !== null,
        value => value, "owned CLI process exit", 10_000);
    } catch {
      observation.retirement = "forced-root";
      child.kill("SIGKILL");
      await pollOwned(async () => child.exitCode !== null || child.signalCode !== null,
        value => value, "owned CLI forced process exit", 5000);
    } finally {
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    }
    if (process.platform === "win32" && observation.treeRetirementSucceeded !== true) {
      throw new Error("The owned Windows CLI tree retirement was not confirmed.");
    }
    this.#child = undefined;
    await pollOwned(async () => {
      try { await fetch(`${this.baseUrl}/healthz`, { signal: AbortSignal.timeout(500) }); return false; }
      catch { return true; }
    }, value => value, "stopped independent CLI listener", 5000);
  }

  async close(): Promise<void> {
    await this.stop();
    this.#pairingCode = undefined;
    this.#closed = true;
    await removeOwnedRoot(this.root);
  }
}

export async function pollOwned<T>(observe: () => Promise<T>, accepted: (value: T) => boolean,
  label: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await observe();
    if (accepted(value)) return value;
    await new Promise<void>(accept => setTimeout(accept, 150));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No owned loopback port was allocated.");
  await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
  return address.port;
}

async function removeOwnedRoot(root: string): Promise<void> {
  const parent = await realpath(tmpdir());
  const path = relative(parent, root);
  if (path.length === 0 || path.startsWith("..") || path.includes("/") || path.includes("\\")
    || !path.startsWith("joko-standalone-web-cli-")) throw new Error("The temporary CLI profile is outside its owned parent.");
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
