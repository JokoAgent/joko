import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCommandConcurrencyGate } from "@joko/runtime-governance";
import { ExecutorWorkspace } from "./hosted-agent-workspace.js";
import { HostedAgentCodexExecServerRelay, type HostedAgentCodexAction } from "./hosted-agent-codex-relay.js";

const binary = process.env["JOKO_CODEX_HOSTED_TEST_BINARY"];
describe.skipIf(!binary)("Hosted native Codex Source executor", () => {
  it("runs the actual exec-server with Source files, reversible binary data, original operation approval and process capacity", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "joko-hosted-codex-"))), project = join(root, "source");
    await mkdir(project); const virtual = "/hosted/workspace";
    const workspace = new ExecutorWorkspace({ workingDir: project, aliases: [{ from: virtual, to: project }] }); workspace.setVirtualRoot(virtual);
    const gate = createCommandConcurrencyGate({ readMaximum: () => 1, maximumWaitMs: 5_000 });
    const actions: HostedAgentCodexAction[] = [], allowed = () => undefined;
    const relay = new HostedAgentCodexExecServerRelay({ codexExecutable: binary!, cwd: project, workspace, sessionId: "source-session",
      commandConcurrencyGate: gate, assertCurrent: allowed, authorize: async selected => { actions.push(...selected); return allowed; },
      env: { PATH: process.env["PATH"], SystemRoot: process.env["SystemRoot"], TEMP: root, TMP: root } });
    const signal = new AbortController().signal, messages: Record<string, unknown>[] = [];
    const request = (kind: "open" | "message" | "poll" | "close", data?: unknown, owner?: { assertCurrent: () => void; authorize: (actions: readonly HostedAgentCodexAction[], signal: AbortSignal) => Promise<() => void> }) =>
      relay.execute({ format: 1, callId: "native-source", requestId: randomUUID(), operation: "codex.exec_server",
        payload: { kind, connectionId: "native-source", ...(data === undefined ? {} : { data: JSON.stringify(data) }) } }, signal, owner);
    const until = async (predicate: () => boolean) => {
      const expires = Date.now() + 15_000;
      while (!predicate()) {
        if (Date.now() > expires) throw new Error("Native execution response timed out.");
        const result = await request("poll");
        for (const text of result.messages as string[]) messages.push(JSON.parse(text) as Record<string, unknown>);
        if (result.closed && !predicate()) throw new Error("Native executor closed before returning its response.");
      }
    };
    try {
      await request("open");
      await request("message", { id: 1, method: "initialize", params: { clientName: "joko-native-source-test", clientVersion: "1" } });
      await until(() => messages.some(message => message.id === 1));
      const init = messages.find(message => message.id === 1)!;
      expect((init.result as { environmentInfo: { cwd: string } }).environmentInfo.cwd).toBe("file:///hosted/workspace");
      await request("message", { method: "initialized", params: {} });
      const binaryBytes = Buffer.from([0, 255, 195, 0, 23, 128]);
      await request("message", { id: 2, method: "fs/writeFile", params: { path: "file:///hosted/workspace/data.bin", dataBase64: binaryBytes.toString("base64") } });
      await until(() => messages.some(message => message.id === 2)); expect(messages.find(message => message.id === 2)?.error).toBeUndefined();
      expect(await readFile(join(project, "data.bin"))).toEqual(binaryBytes);
      await request("message", { id: 3, method: "fs/readFile", params: { path: "file:///hosted/workspace/data.bin" } });
      await until(() => messages.some(message => message.id === 3));
      expect(messages.find(message => message.id === 3)?.result).toMatchObject({ dataBase64: binaryBytes.toString("base64") });
      const original = JSON.stringify({ path: join(project, "build", "file.txt"), flag: "before" });
      await writeFile(join(project, "paths.json"), original);
      await request("message", { id: 4, method: "fs/writeFile", params: { path: "file:///hosted/workspace/paths.json",
        dataBase64: Buffer.from(JSON.stringify({ path: virtual + "/build/file.txt", flag: "after" })).toString("base64") } });
      await until(() => messages.some(message => message.id === 4));
      expect(await readFile(join(project, "paths.json"), "utf8")).toBe(original.replace("before", "after"));
      let release!: () => void, reviewed = false;
      const blocked = request("message", { id: 5, method: "fs/writeFile", params: { path: "file:///hosted/workspace/blocked.txt", dataBase64: Buffer.from("blocked").toString("base64") } },
        { assertCurrent: allowed, authorize: async selected => { expect(selected).toEqual([{ kind: "write", path: join(project, "blocked.txt") }]); reviewed = true; await new Promise<void>(resolve => { release = resolve; }); throw new Error("Rejected by original author"); } });
      await expect.poll(() => reviewed).toBe(true); release(); await blocked;
      await until(() => messages.some(message => message.id === 5)); expect(messages.find(message => message.id === 5)?.error).toMatchObject({ code: -32001 });
      await expect(readFile(join(project, "blocked.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      await request("message", { id: 6, method: "process/start", params: { processId: "native-command", argv: [process.execPath, "-e", "setTimeout(() => { console.log(process.cwd()); }, 500);"],
        cwd: "file:///hosted/workspace", env: { SystemRoot: process.env["SystemRoot"], TEMP: root }, tty: false } });
      expect(gate.snapshot().running).toBe(1);
      await until(() => messages.some(message => message.method === "process/closed"));
      expect(gate.snapshot().running).toBe(0); expect(messages.find(message => message.id === 6)?.error).toBeUndefined();
      const output = messages.filter(message => message.method === "process/output").map(message => Buffer.from((message.params as { chunk: string }).chunk, "base64").toString()).join("");
      expect(output.trim()).toBe(virtual); expect(actions).toContainEqual({ kind: "exec", command: expect.any(String), cwd: project });
      expect(JSON.stringify(messages)).not.toContain(JSON.stringify(project).slice(1, -1));
      await request("message", { id: 7, method: "process/start", params: { processId: "owned-background", argv: [process.execPath, "-e",
        "console.log('BACKGROUND_READY'); setTimeout(() => require('node:fs').writeFileSync('orphaned.txt','orphan'), 1200);"],
        cwd: "file:///hosted/workspace", env: { SystemRoot: process.env["SystemRoot"], TEMP: root }, tty: false } });
      await until(() => messages.some(message => message.method === "process/output" && Buffer.from((message.params as { chunk: string }).chunk, "base64").toString().includes("BACKGROUND_READY")));
      await relay.close(); expect(gate.snapshot().running).toBe(0);
      await new Promise(resolve => setTimeout(resolve, 1500));
      await expect(readFile(join(project, "orphaned.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await relay.close(); gate.close();
      const canonical = resolve(root), parent = resolve(tmpdir());
      if (!relative(parent, canonical).startsWith("joko-hosted-codex-")) throw new Error("Native test cleanup escaped its temporary root.");
      await rm(canonical, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }, 45_000);
});
