import { randomUUID } from "node:crypto";
import { execFile, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { assertArchiveEntrySafe, assertPathWithin } from "./security.js";
import { LocalRuntimeError } from "./errors.js";
import { LlamaCppRuntimeError } from "./llama-cpp-types.js";

export const LLAMA_CPP_OWNER_GUARD = `
exec 3<&0
"$@" 3<&- </dev/null &
server=$!
(/bin/cat <&3 >/dev/null; kill -KILL -$$) &
trap 'kill -TERM "$server" 2>/dev/null; wait "$server"; kill -KILL -$$' TERM INT
wait "$server"
kill -KILL -$$
`;
export function llamaCppProcessCommand(binary: string, args: readonly string[], platform: NodeJS.Platform = process.platform) {
  return platform === "win32" ? { binary, args: [...args] }
    : { binary: "/bin/sh", args: ["-c", LLAMA_CPP_OWNER_GUARD, "joko-local-model", binary, ...args] };
}
export interface LlamaCppOwnerIdentity { readonly version: 1; readonly port: number; readonly token: string }
export interface LlamaCppOwnerProof { readonly identity: LlamaCppOwnerIdentity; close(): Promise<void> }
const PROOF_PREFIX = "joko-runtime-owner-v1:";
export async function startLlamaCppOwnerProof(): Promise<LlamaCppOwnerProof> {
  const token = randomUUID(), server = createServer(socket => socket.end(`${PROOF_PREFIX}${token}\n`));
  server.on("error", () => undefined);
  await new Promise<void>((resolvePromise, reject) => {
    const failed = (error: Error) => { server.off("listening", listening); reject(error); };
    const listening = () => { server.off("error", failed); resolvePromise(); };
    server.once("error", failed); server.once("listening", listening); server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
  });
  server.unref(); const address = server.address();
  if (address === null || typeof address === "string") { server.close(); throw new Error("The runtime owner proof is unavailable."); }
  return { identity: { version: 1, port: address.port, token }, close: () => new Promise<void>((resolvePromise, reject) => {
    if (!server.listening) { resolvePromise(); return; }
    server.close(error => error ? reject(error) : resolvePromise());
  }) };
}
export function validLlamaCppOwnerIdentity(value: unknown): value is LlamaCppOwnerIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 3 && row["version"] === 1 && Number.isSafeInteger(row["port"])
    && Number(row["port"]) > 0 && Number(row["port"]) < 65536
    && typeof row["token"] === "string" && /^[0-9a-f-]{36}$/u.test(row["token"]);
}
export async function probeLlamaCppOwner(identity: LlamaCppOwnerIdentity, timeoutMs = 1000): Promise<"alive" | "ended" | "unknown"> {
  if (!validLlamaCppOwnerIdentity(identity)) return "unknown";
  return new Promise(resolvePromise => {
    const expected = `${PROOF_PREFIX}${identity.token}\n`, socket = createConnection({ host: "127.0.0.1", port: identity.port });
    let received = "", settled = false, connected = false;
    const finish = (result: "alive" | "ended" | "unknown") => { if (settled) return; settled = true; socket.destroy(); resolvePromise(result); };
    socket.setEncoding("utf8"); socket.setTimeout(timeoutMs); socket.on("connect", () => { connected = true; });
    socket.on("data", chunk => { received += chunk; if (received === expected) finish("alive"); else if (!expected.startsWith(received)) finish("ended"); });
    socket.on("end", () => finish(received === expected ? "alive" : "ended")); socket.on("timeout", () => finish(connected ? "unknown" : "ended"));
    socket.on("error", (error: NodeJS.ErrnoException) => finish(["ECONNREFUSED", "ENOENT", "ECONNRESET", "ECONNABORTED", "EPIPE"].includes(error.code ?? "") ? "ended" : "unknown"));
  });
}

interface LockTicket { readonly ticket: number; readonly choosing: boolean }
const LOCK_NAME = /^claim-(\d+)-([0-9a-f-]{36})\.json$/u;
/** Immutable claimant paths and live proofs protect both acquisition and stale cleanup.
 * A claimant publishes choosing before reading tickets, then waits for every
 * earlier ticket. New arrivals observe its published ticket and cannot bypass it. */
export async function withLlamaCppMutationLock<T>(root: string, signal: AbortSignal, waitMs: number, effect: () => Promise<T>): Promise<T> {
  const directory = join(root, "mutation-locks"); await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw new LlamaCppRuntimeError("RUNTIME_ERROR", "OWNER_UNKNOWN", "The runtime lock is unavailable.");
  const proof = await startLlamaCppOwnerProof(), name = `claim-${proof.identity.port}-${proof.identity.token}.json`, file = join(directory, name);
  const deadline = Date.now() + waitMs;
  try {
    signal.throwIfAborted(); await writeFile(file, JSON.stringify({ ticket: 0, choosing: true } satisfies LockTicket), { flag: "wx", mode: 0o600 });
    const rows = await tickets(directory);
    const ticket = Math.max(0, ...rows.map(row => row.ticket)) + 1;
    if (!Number.isSafeInteger(ticket)) throw new LlamaCppRuntimeError("RUNTIME_ERROR", "BUSY", "The runtime lock is busy.");
    const temporary = `${file}.tmp`;
    try { await writeFile(temporary, JSON.stringify({ ticket, choosing: false } satisfies LockTicket), { flag: "wx", mode: 0o600 }); await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
    for (;;) {
      signal.throwIfAborted();
      const others = (await tickets(directory)).filter(row => row.name !== name);
      if (others.every(row => !row.choosing && (row.ticket > ticket || row.ticket === ticket && row.name > name))) break;
      if (Date.now() >= deadline) throw new LlamaCppRuntimeError("INSTALL_BUSY", "BUSY", "Another instance owns the runtime operation.");
      await delay(40, undefined, { signal });
    }
    signal.throwIfAborted(); return await effect();
  } finally { try { await rm(file, { force: true }); } finally { await proof.close(); } }
}
async function tickets(directory: string): Promise<readonly (LockTicket & { readonly name: string })[]> {
  const names = (await readdir(directory)).filter(name => LOCK_NAME.test(name));
  if (names.length > 1024) throw new LlamaCppRuntimeError("RUNTIME_ERROR", "OWNER_UNKNOWN", "The runtime lock is unavailable.");
  const rows = [];
  for (const name of names) {
    const match = LOCK_NAME.exec(name)!, file = join(directory, name);
    const owner = await probeLlamaCppOwner({ version: 1, port: Number(match[1]), token: match[2]! });
    if (owner === "ended") { await rm(file, { force: true }); continue; }
    if (owner === "unknown") { rows.push({ name, ticket: 0, choosing: true }); continue; }
    try {
      const value = await readLlamaCppRecord(file) as Partial<LockTicket>;
      rows.push(Number.isSafeInteger(value.ticket) && Number(value.ticket) >= 0 && typeof value.choosing === "boolean"
        ? { name, ticket: Number(value.ticket), choosing: value.choosing } : { name, ticket: 0, choosing: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") rows.push({ name, ticket: 0, choosing: true });
    }
  }
  return rows;
}
export async function readLlamaCppRecord(file: string): Promise<unknown> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error("The runtime record is unavailable.");
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}
const exec = promisify(execFile);
export async function terminateLlamaCppTree(child: ChildProcess, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (!Number.isSafeInteger(child.pid) || child.pid === undefined) return false;
  if (platform === "win32") {
    try { await exec("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 4000 }); return true; } catch { return false; }
  }
  try { process.kill(-child.pid, "SIGKILL"); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
export async function extractLlamaCppArchive(input: { readonly archivePath: string; readonly destination: string; readonly platform: NodeJS.Platform; readonly signal: AbortSignal }): Promise<string> {
  const tar = input.platform === "win32" ? join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe") : "/usr/bin/tar";
  const run = async (args: string[]) => (await exec(tar, args, { windowsHide: true, signal: input.signal, timeout: 120000, maxBuffer: 4 * 1024 * 1024 })).stdout;
  const entries = (await run(["-tf", input.archivePath])).split(/\r?\n/u).filter(Boolean);
  if (entries.length === 0 || entries.length > 8192) throw new LocalRuntimeError("ARCHIVE_REJECTED", "The runtime archive is unavailable.");
  for (const entry of entries) assertArchiveEntrySafe(entry);
  if ((await run(["-tvf", input.archivePath])).split(/\r?\n/u).some(line => /^[lh]/u.test(line))) throw new LocalRuntimeError("ARCHIVE_REJECTED", "The runtime archive contains links.");
  await mkdir(input.destination, { recursive: true, mode: 0o700 });
  await run(["-xf", input.archivePath, "-C", input.destination, "--no-same-owner", "--no-same-permissions"]);
  const root = await realpath(input.destination), found: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 8) throw new LocalRuntimeError("ARCHIVE_REJECTED", "The runtime archive is nested too deeply.");
    for (const name of await readdir(directory)) {
      const file = join(directory, name), stat = await lstat(file); assertPathWithin(root, file);
      if (stat.isSymbolicLink()) throw new LocalRuntimeError("ARCHIVE_REJECTED", "The runtime archive contains links.");
      if (stat.isDirectory()) await visit(file, depth + 1);
      else if (stat.isFile() && name === (input.platform === "win32" ? "llama-server.exe" : "llama-server")) found.push(file);
      else if (!stat.isFile()) throw new LocalRuntimeError("ARCHIVE_REJECTED", "The runtime archive contains an unsupported entry.");
    }
  };
  await visit(root, 0);
  if (found.length !== 1) throw new LocalRuntimeError("ARCHIVE_REJECTED", "The runtime executable is unavailable.");
  const binary = await realpath(found[0]!); assertPathWithin(root, binary);
  if (input.platform !== "win32") await chmod(binary, 0o755); return resolve(binary);
}
