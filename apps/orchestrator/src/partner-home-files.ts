import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, posix, win32, type PlatformPath } from "node:path";
import { DEVICE_PEER_RUNTIME_EXECUTABLES } from "@joko/device-peer";
import type { RemoteFileTransportPort, RemoteProcessTransportPort } from "@joko/remote-ssh";
import { createImportBudget, readImportTree } from "@joko/agent-import";
import type { DevicePeerOwner, DevicePeerSelectionIdentity } from "./device-peer-owner.js";
import { createDevicePeerCapabilityPorts } from "./device-peer-capability-ports.js";
import type { RemoteExecutionRouter } from "./remote-execution-router.js";
import { PartnerHomeError, type PartnerHomeLocation, type PartnerHomeMoveRecord } from "./partner-home-owner.js";

export interface PartnerHomeFile { readonly name: string; readonly bytes: Uint8Array; }
export interface InspectedPartnerHomeDevice {
  readonly location: PartnerHomeLocation & { readonly kind: "device" };
  readonly platform: string;
  readonly runtimeVersion: string;
  readonly assertCurrent: () => void;
}

/** A fixed read-only program: the target's installed runtime loader owns the executable. */
const HOME_PROGRAM = "process.stdout.write(JSON.stringify({home:require('node:os').homedir(),platform:process.platform}))";
const MARKER = ".joko-partner-home.json";
const MAXIMUM_FILE_BYTES = 64 * 1024 * 1024;

export class PartnerHomeFiles {
  constructor(private readonly options: { readonly serverId: string; readonly peers: DevicePeerOwner;
    readonly remoteExecution: Pick<RemoteExecutionRouter, "workspace"> }) {}

  async inspectDevice(controller: import("@joko/store").ConnectionRecord, selected: DevicePeerSelectionIdentity,
    partnerId: string): Promise<InspectedPartnerHomeDevice> {
    const authority = this.options.peers.capture(controller, selected, ["files", "process", "forwarding"]);
    const ports = createDevicePeerCapabilityPorts({ owner: this.options.peers, authority });
    if (!ports.files || !ports.processes || !ports.forwarding) throw new PartnerHomeError("runtime-unavailable", "This computer has no private managed execution channel.");
    const cwd = await ports.files.realpath("."); authority.assertCurrent(["files", "process"]);
    const raw = await runInspection(ports.processes, DEVICE_PEER_RUNTIME_EXECUTABLES.node, ["-e", HOME_PROGRAM], cwd);
    let info: { home: string; platform: string };
    try {
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (Object.keys(value).some(key => key !== "home" && key !== "platform") || typeof value.home !== "string"
        || typeof value.platform !== "string" || !["win32", "darwin", "linux"].includes(value.platform)) throw new Error();
      info = { home: value.home, platform: value.platform };
    } catch { throw new PartnerHomeError("runtime-unavailable", "The computer did not return a valid managed runtime identity."); }
    const paths = info.platform === "win32" ? win32 : posix;
    if (!paths.isAbsolute(info.home) || /[\u0000\r\n]/u.test(info.home)) throw new PartnerHomeError("runtime-unavailable", "The computer's account home is unavailable.");
    const canonicalHome = await ports.files.realpath(info.home); authority.assertCurrent(["files", "process"]);
    const runtimeVersion = await runInspection(ports.processes, DEVICE_PEER_RUNTIME_EXECUTABLES.pi, ["--version"], cwd);
    authority.assertCurrent(["files", "process"]);
    if (!runtimeVersion.trim() || runtimeVersion.length > 2_048) throw new PartnerHomeError("runtime-unavailable", "The computer has no usable managed agent runtime.");
    const device = this.options.peers.list(controller).find(peer => peer.targetDeviceId === selected.targetDeviceId);
    if (!device) throw new PartnerHomeError("target-unavailable", "The selected computer is no longer available.");
    return { location: { kind: "device", controllerDeviceId: controller.deviceId, deviceId: selected.targetDeviceId,
      name: device.displayName, root: paths.join(canonicalHome, ".joko", "partner-homes", hash(this.options.serverId).slice(0, 24), hash(partnerId).slice(0, 40)) },
      platform: info.platform, runtimeVersion: runtimeVersion.trim(), assertCurrent: () => authority.assertCurrent(["files", "process", "forwarding"]) };
  }

  async prepare(move: PartnerHomeMoveRecord, files: readonly PartnerHomeFile[], assertCurrent: () => void): Promise<void> {
    assertCurrent(); if (move.destination.kind === "service") return;
    const destination = move.destination;
    const binding = { kind: "device_peer" as const, controllerDeviceId: destination.controllerDeviceId,
      targetDeviceId: destination.deviceId, workspaceRoot: destination.root };
    const authority = await this.options.remoteExecution.workspace(binding);
    const paths = authority.pathStyle === "win32" ? win32 : posix;
    const assertOwner = () => { assertCurrent(); authority.assertCurrent(); authority.assertFilesCurrent(); };
    assertOwner();
    await privateDirectory(authority.files, destination.root, paths, assertOwner);
    const marker = paths.join(destination.root, MARKER);
    const fingerprint = hash(files.map(file => [file.name, hash(file.bytes)]));
    const expected = { version: 1, authorityServerId: this.options.serverId, partnerId: move.partnerId,
      requestId: move.requestId, generation: move.source.generation + 1, fingerprint, files: files.map(file => file.name) };
    const prior = await optionalFile(authority.files, marker, assertOwner);
    if (prior) {
      const parsed = parseMarker(prior);
      if (parsed.authorityServerId !== expected.authorityServerId || parsed.partnerId !== expected.partnerId) {
        throw new PartnerHomeError("preparation-failed", "This managed home belongs to another Partner.");
      }
      if (parsed.requestId === move.requestId && parsed.fingerprint !== fingerprint) {
        throw new PartnerHomeError("state-changed", "The prepared Partner files changed; the original action cannot be reused.");
      }
      if (parsed.requestId !== move.requestId) {
        // Only the previous host-owned file list is backed up. Arbitrary work
        // files on this computer keep their location and authorization.
        const backup = paths.join(destination.root, ".joko-home-backups", hash(move.requestId).slice(0, 32));
        await privateDirectory(authority.files, backup, paths, assertOwner);
        for (const name of [...parsed.files, MARKER]) {
          const bytes = await optionalFile(authority.files, contained(destination.root, name, paths), assertOwner);
          if (!bytes) continue;
          const leaf = contained(backup, name, paths); await privateDirectory(authority.files, paths.dirname(leaf), paths, assertOwner);
          await authority.files.write({ path: leaf, content: bytes, mode: 0o600, atomic: true }); assertOwner();
        }
      }
      for (const name of parsed.files.filter(name => !expected.files.includes(name))) {
        const leaf = contained(destination.root, name, paths);
        if (await optionalFile(authority.files, leaf, assertOwner)) { await authority.files.remove(leaf); assertOwner(); }
      }
    } else if ((await authority.files.list(destination.root)).length > 0) {
      throw new PartnerHomeError("preparation-failed", "The managed home directory contains unowned files.");
    }
    await authority.files.write({ path: marker, content: Buffer.from(JSON.stringify(expected)), mode: 0o600, atomic: true }); assertOwner();
    for (const file of files) {
      const leaf = contained(destination.root, file.name, paths); await privateDirectory(authority.files, paths.dirname(leaf), paths, assertOwner);
      await authority.files.write({ path: leaf, content: file.bytes, mode: 0o600, atomic: true }); assertOwner();
      const confirmed = await authority.files.read({ path: leaf, maximumBytes: MAXIMUM_FILE_BYTES }); assertOwner();
      if (hash(confirmed) !== hash(file.bytes)) throw new PartnerHomeError("preparation-failed", "A managed Partner file could not be confirmed.");
    }
  }
}

/** Explicit managed data only; no profile model/permission JSON, MCP files, auth or workspace tree. */
export async function readPartnerHomeFiles(root: string, identity: string, avatar: string,
  memories: readonly { readonly id: string; readonly title: string; readonly body: string }[], userContext: string | undefined,
  assertCurrent: () => void): Promise<readonly PartnerHomeFile[]> {
  assertCurrent();
  if (!["AVATAR.svg", "AVATAR.jpg", "AVATAR.png", "AVATAR.webp"].includes(avatar)) throw new PartnerHomeError("preparation-failed", "The Partner avatar is invalid.");
  const image = join(root, avatar); const imageInfo = await lstat(image); assertCurrent();
  if (!imageInfo.isFile() || imageInfo.isSymbolicLink() || imageInfo.size > 5 * 1024 * 1024) throw new PartnerHomeError("preparation-failed", "The Partner avatar is unavailable.");
  const files: PartnerHomeFile[] = [{ name: "IDENTITY.md", bytes: Buffer.from(identity) }, { name: avatar, bytes: await readFile(image) }];
  if (userContext !== undefined) files.push({ name: "USER.md", bytes: Buffer.from(userContext) });
  for (const memory of memories) files.push({ name: `memories/${hash(memory.id).slice(0, 40)}.md`, bytes: Buffer.from(`# ${memory.title}\n\n${memory.body}\n`) });
  const skillRoot = join(root, ".agents", "skills");
  try {
    const tree = await readImportTree(skillRoot, () => true, createImportBudget(undefined, assertCurrent));
    for (const file of tree) files.push({ name: `.agents/skills/${file.name}`, bytes: file.bytes });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  assertCurrent(); return files;
}

async function privateDirectory(files: RemoteFileTransportPort, value: string, paths: PlatformPath, assertOwner: () => void): Promise<void> {
  const root = paths.parse(value).root;
  if (!root || paths.normalize(value) !== value) throw new PartnerHomeError("preparation-failed", "The managed home path is invalid.");
  let current = root;
  for (const component of paths.relative(root, value).split(paths.sep).filter(Boolean)) {
    current = paths.join(current, component); assertOwner();
    let stat;
    try { stat = await files.stat(current); }
    catch (error) { if (!notFound(error)) throw error; await files.mkdir(current, { mode: 0o700, recursive: false }); stat = await files.stat(current); }
    assertOwner();
    if (stat.kind !== "directory" || await files.realpath(current) !== current) throw new PartnerHomeError("preparation-failed", "The managed home directory is not a canonical private directory.");
  }
}
async function optionalFile(files: RemoteFileTransportPort, value: string, assertOwner: () => void): Promise<Uint8Array | undefined> {
  assertOwner();
  try {
    const stat = await files.stat(value); assertOwner();
    if (stat.kind !== "file" || stat.size > MAXIMUM_FILE_BYTES) throw new PartnerHomeError("preparation-failed", "A managed Partner file is unsafe.");
    const bytes = await files.read({ path: value, maximumBytes: MAXIMUM_FILE_BYTES }); assertOwner(); return bytes;
  } catch (error) { if (notFound(error)) return undefined; throw error; }
}
function contained(root: string, name: string, paths: PlatformPath): string {
  if (!name || name.includes("\\") || name.split("/").some(part => !part || part === "." || part === "..") || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new PartnerHomeError("preparation-failed", "A managed Partner file path is invalid.");
  }
  const value = paths.join(root, ...name.split("/")), relative = paths.relative(root, value);
  if (!relative || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) throw new PartnerHomeError("preparation-failed", "A managed Partner file escaped its owner.");
  return value;
}
function parseMarker(bytes: Uint8Array): { readonly authorityServerId: string; readonly partnerId: string; readonly requestId: string; readonly fingerprint: string; readonly files: string[] } {
  try {
    const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>;
    if (value.version !== 1 || Object.keys(value).some(key => !["version", "authorityServerId", "partnerId", "requestId", "generation", "fingerprint", "files"].includes(key))
      || [value.authorityServerId, value.partnerId, value.requestId, value.fingerprint].some(item => typeof item !== "string")
      || !Number.isSafeInteger(value.generation) || Number(value.generation) < 1 || !Array.isArray(value.files)
      || value.files.length > 20_000 || value.files.some(name => typeof name !== "string")) throw new Error();
    for (const name of value.files as string[]) contained("/managed", name, posix);
    return value as unknown as ReturnType<typeof parseMarker>;
  } catch { throw new PartnerHomeError("preparation-failed", "The managed Partner home marker is invalid."); }
}
async function runInspection(processes: RemoteProcessTransportPort, executable: string, args: readonly string[], cwd: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let handle: Awaited<ReturnType<RemoteProcessTransportPort["open"]>> | undefined;
  try {
    handle = await processes.open({ executable, args, cwd, signal: controller.signal });
    const chunks: Buffer[] = []; let size = 0;
    handle.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= 64 * 1024) chunks.push(Buffer.from(chunk)); else controller.abort(); });
    handle.stderr.resume(); handle.stdin.end();
    const code = await new Promise<number | null>((resolve, reject) => {
      if (handle!.exitCode !== null || handle!.signalCode !== null) { resolve(handle!.exitCode); return; }
      handle!.once("exit", value => resolve(value)); handle!.once("error", reject);
      controller.signal.addEventListener("abort", () => reject(new Error("Runtime inspection timed out.")), { once: true });
    });
    if (code !== 0 || controller.signal.aborted || size > 64 * 1024) throw new Error();
    return Buffer.concat(chunks).toString("utf8");
  } catch { handle?.kill("SIGTERM"); throw new PartnerHomeError("runtime-unavailable", "This computer's managed agent runtime is unavailable."); }
  finally { clearTimeout(timer); }
}
function notFound(error: unknown): boolean { const value = error as { code?: unknown }; return value?.code === "ENOENT" || value?.code === "NOT_FOUND" || value?.code === "not_found"; }
function hash(value: unknown): string { return createHash("sha256").update(value instanceof Uint8Array ? value : JSON.stringify(value)).digest("hex"); }
