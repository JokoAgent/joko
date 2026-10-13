import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { llamaCppProcessCommand, probeLlamaCppOwner, startLlamaCppOwnerProof, withLlamaCppMutationLock } from "./llama-cpp-process.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const value = await mkdtemp(join(tmpdir(), "joko-gguf-process-")); roots.push(value); return value; }
describe("GGUF process ownership", () => {
  it("keeps arguments positional in the POSIX EOF guard and verifies live proof tokens without trusting PID records", async () => {
    const command = llamaCppProcessCommand("/path/server $(touch injected)", ["--models-dir", "/models with spaces"], "linux");
    expect(command.binary).toBe("/bin/sh"); expect(command.args.slice(-3)).toEqual(["/path/server $(touch injected)", "--models-dir", "/models with spaces"]); expect(command.args[1]).toContain("/bin/cat <&3"); expect(command.args[1]).toContain("kill -KILL -$$");
    expect(llamaCppProcessCommand("C:\\models\\llama-server.exe", ["--port", "11435"], "win32")).toEqual({ binary: "C:\\models\\llama-server.exe", args: ["--port", "11435"] });
    const proof = await startLlamaCppOwnerProof(); expect(await probeLlamaCppOwner(proof.identity)).toBe("alive"); expect(await probeLlamaCppOwner({ ...proof.identity, token: "a".repeat(36) })).toBe("ended"); await proof.close(); expect(await probeLlamaCppOwner(proof.identity)).toBe("ended");
  });
  it("serializes an independent live process and reclaims only its dead immutable claim after actual exit", async () => {
    const directory = await root(), module = new URL("../dist/llama-cpp-process.js", import.meta.url).href;
    const code = `const {withLlamaCppMutationLock}=await import(${JSON.stringify(module)}); await withLlamaCppMutationLock(${JSON.stringify(directory)},new AbortController().signal,0,async()=>{process.stdout.write('held\\n');await new Promise(resolve=>process.stdin.once('data',resolve));});`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    try {
      await new Promise<void>((resolvePromise, reject) => { child.once("error", reject); child.once("exit", code => reject(new Error(`The lock process exited: ${code}`))); child.stdout!.once("data", () => resolvePromise()); });
      await expect(withLlamaCppMutationLock(directory, new AbortController().signal, 0, async () => true)).rejects.toMatchObject({ reason: "BUSY" });
      const ended = new Promise<void>(resolvePromise => child.once("exit", () => resolvePromise())); child.kill("SIGKILL"); await ended;
      expect(await withLlamaCppMutationLock(directory, new AbortController().signal, 0, async () => "acquired")).toBe("acquired");
    } finally { if (child.exitCode === null && child.signalCode === null) { const ended = new Promise<void>(resolvePromise => child.once("exit", () => resolvePromise())); child.kill("SIGKILL"); await ended; } }
  });
  it("preserves a connected but unconfirmed live claim instead of deleting it as stale", async () => {
    const directory = await root(), claims = join(directory, "mutation-locks"); await mkdir(claims);
    const sockets: import("node:net").Socket[] = [], server = createServer(socket => sockets.push(socket)); await new Promise<void>(resolvePromise => server.listen(0, "127.0.0.1", resolvePromise));
    const address = server.address(); if (address === null || typeof address === "string") throw new Error("No proof port");
    const file = join(claims, `claim-${address.port}-${"a".repeat(36)}.json`); await writeFile(file, JSON.stringify({ ticket: 1, choosing: false }));
    try { await expect(withLlamaCppMutationLock(directory, new AbortController().signal, 0, async () => true)).rejects.toMatchObject({ reason: "BUSY" }); }
    finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolvePromise => server.close(() => resolvePromise())); }
  });
});
