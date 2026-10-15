import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSupervisedDevelopmentProcessAuthority } from "./supervised-process.js";
import { developmentEnvironment } from "./process.js";
import { createCommandJournal } from "./command-journal.js";
import { pathToFileURL } from "node:url";

const enabled = process.env.JOKO_TEST_PERSONAL_COMMAND_HOST === "1";
const windows = process.platform === "win32";
const helper = resolve("dist/native-command-host/joko-command-host.exe");
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const pause = (ms: number) => new Promise(resolvePause => setTimeout(resolvePause, ms));
async function root() { const value = await mkdtemp(join(tmpdir(), "joko-command-owner-test-")); roots.push(value); return value; }
async function waitForFile(file: string) {
  const deadline = Date.now() + 5000;
  while (!existsSync(file) && Date.now() < deadline) await pause(10);
  expect(existsSync(file)).toBe(true);
}
const environment = developmentEnvironment(process.env);
const runner = () => {
  const journalDirectory = join(tmpdir(), `joko-personal-command-journal-${randomUUID()}`); roots.push(journalDirectory);
  return createSupervisedDevelopmentProcessAuthority({ windowsHelperPath: helper, nodeExecutable: process.execPath, journalDirectory });
};

describe.skipIf(!enabled)("personal command writer retirement", { timeout: 20_000 }, () => {
  it("returns complete command bytes only after the exact command scope retires", async () => {
    const directory = await root(); const progress: number[] = [];
    const result = await runner().run({ executable: process.execPath, args: ["-e", "process.stdout.write('complete π 字'.repeat(2000));process.stderr.write('Receiving objects: 42%\\n')"],
      cwd: directory, environment, signal: new AbortController().signal, timeoutMs: 10_000,
      onProgress: value => { if (value.percent !== undefined) progress.push(value.percent); } });
    expect(result.exitCode).toBe(0); expect(result.stdout).toBe("complete π 字".repeat(2000)); expect(progress).toContain(42);
    const counters: unknown[] = [];
    await runner().run({ executable: process.execPath, args: ["-e", "process.stdout.write('Progress: resolved 42, reused 31, downloaded 11, added 17\\nprivate message\\n')"],
      cwd: directory, environment, signal: new AbortController().signal, timeoutMs: 10_000,
      onProgress: value => counters.push(value) });
    expect(counters).toEqual([{ stage: "dependency-progress", dependencyProgress: { resolved: 42, reused: 31, downloaded: 11, added: 17 } }]);
    await expect(runner().run({ executable: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000)"],
      cwd: directory, environment, signal: new AbortController().signal, timeoutMs: 10_000, maxOutputBytes: 16 })).rejects.toMatchObject({ code: "COMMAND_FAILED" });
  });
  it("does not release a completed root while its nested writer can still change the checkout", async () => {
    const directory = await root(); const marker = join(directory, "writer.txt");
    const writer = `const fs=require('fs');fs.appendFileSync(${JSON.stringify(marker)},'x');setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'x'),10)`;
    const parent = `const cp=require('child_process'),fs=require('fs');cp.spawn(process.execPath,['-e',${JSON.stringify(writer)}],{stdio:'ignore'});setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)}))process.exit(0)},10)`;
    const result = runner().run({ executable: process.execPath, args: ["-e", parent], cwd: directory, environment, signal: new AbortController().signal, timeoutMs: 10_000 });
    const outcome = await result.then(value => ({ value, error: undefined }), error => ({ value: undefined, error: error as { code?: string } }));
    if (outcome.error) expect(outcome.error.code).toBe("COMMAND_FAILED"); else expect(outcome.value?.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(true); const bytes = (await stat(marker)).size;
    await pause(150); expect((await stat(marker)).size).toBe(bytes);
  });
  it("cancels the owned scope and confirms its nested writer stopped before returning cancellation", async () => {
    const directory = await root(); const marker = join(directory, "cancel-writer.txt"); const abort = new AbortController();
    const writer = `const fs=require('fs');fs.appendFileSync(${JSON.stringify(marker)},'x');setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'x'),10)`;
    const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(writer)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
    const outcome = runner().run({ executable: process.execPath, args: ["-e", parent], cwd: directory, environment, signal: abort.signal, timeoutMs: 10_000 });
    const rejected = expect(outcome).rejects.toMatchObject({ code: "CANCELLED" }); await waitForFile(marker); abort.abort(); await rejected;
    const bytes = (await stat(marker)).size; await pause(150); expect((await stat(marker)).size).toBe(bytes);
  });
  it.skipIf(!windows)("retires its job without issuing a success proof after an invalid cancellation nonce", async () => {
    const directory = await root(); const marker = join(directory, "invalid-writer.txt");
    const manifest = JSON.parse(await readFile(join(dirname(helper), "manifest.json"), "utf8")) as { sourceDigest: string; helper: { sha256: string } };
    const journal = await createCommandJournal(join(directory, "journal"), { helperSha256: manifest.helper.sha256, helperSourceDigest: manifest.sourceDigest }); const nonce = journal.nonce;
    const script = `require('fs').writeFileSync(${JSON.stringify(marker)},'started');setInterval(()=>require('fs').appendFileSync(${JSON.stringify(marker)},'x'),10)`;
    const child = spawn(helper, [], { cwd: directory, env: environment, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; let cancelled = false;
    const closed = new Promise<number | null>((resolveClosed, rejectClosed) => { child.once("error", rejectClosed); child.once("close", resolveClosed); });
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString("utf8");
      if (!cancelled && output.includes('"event":"started"')) { cancelled = true; child.stdin.write(`${JSON.stringify({ protocol: 1, nonce: "wrong", action: "cancel" })}\n`); }
    });
    child.stderr.resume();
    child.stdin.write(`${JSON.stringify({ protocol: 1, nonce, commandId: journal.commandId, journalDirectory: journal.directory, operationId: journal.operationId, helperSha256: journal.helperSha256,
      helperSourceDigest: journal.helperSourceDigest, executable: process.execPath, args: ["-e", script], cwd: directory, environment, timeoutMs: 10_000 })}\n`);
    expect(await closed).toBe(2); expect(output).not.toContain('"event":"retired"');
    if (existsSync(marker)) { const bytes = (await readFile(marker)).length; await pause(100); expect((await readFile(marker)).length).toBe(bytes); }
  });
  it.skipIf(!windows)("permits the fixed read-only compiler prerequisite probe and rejects another argument shape", async () => {
    const programFiles = process.env["ProgramFiles(x86)"] ?? process.env.ProgramFiles;
    const executable = join(programFiles!, "Microsoft Visual Studio", "Installer", "vswhere.exe");
    expect(existsSync(executable)).toBe(true);
    const input = { executable, args: ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"],
      cwd: await root(), environment, signal: new AbortController().signal, timeoutMs: 10_000 };
    const result = await runner().run(input); expect(result.exitCode).toBe(0);
    await expect(runner().run({ ...input, args: ["-all"] })).rejects.toMatchObject({ code: "PROCESS_UNKNOWN" });
  });
  it.skipIf(!windows)("recovers only durable whole-job retirement after the owning service disappears", async () => {
    const directory = await root(), journalDirectory = join(directory, "journal"), marker = join(directory, "detached-writer.txt");
    const writer = `const fs=require('fs');fs.appendFileSync(${JSON.stringify(marker)},'x');setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'x'),10)`;
    const command = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(writer)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
    const service = `const {createSupervisedDevelopmentProcessAuthority}=await import(${JSON.stringify(pathToFileURL(resolve("dist/supervised-process.js")).href)});` +
      `const runner=createSupervisedDevelopmentProcessAuthority(${JSON.stringify({ windowsHelperPath: helper, journalDirectory })});` +
      `const input=${JSON.stringify({ executable: process.execPath, args: ["-e", command], cwd: directory, environment: { ...environment, MODEL_API_TOKEN: "private-test-credential" }, timeoutMs: 15000, operationId: "lost-service" })};` +
      `await runner.run({...input,signal:new AbortController().signal});`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", service], { cwd: directory, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.resume(); let error = ""; child.stderr.on("data", chunk => { error += String(chunk); });
    const closed = new Promise<void>(resolve => { child.once("close", () => resolve()); });
    await waitForFile(marker); child.kill("SIGKILL"); await closed;
    const recovered = createSupervisedDevelopmentProcessAuthority({ windowsHelperPath: helper, journalDirectory });
    const deadline = Date.now() + 5000; let result = await recovered.recover!({ operationId: "lost-service", journalDirectory });
    while (result.status === "unknown" && Date.now() < deadline) { await pause(20); result = await recovered.recover!({ operationId: "lost-service", journalDirectory }); }
    expect(result.status, error).toBe("retired"); expect(result.commandIds).toHaveLength(1);
    const bytes = (await stat(marker)).size; await pause(120); expect((await stat(marker)).size).toBe(bytes);
    const commandRoot = join(journalDirectory, "lost-service", result.commandIds[0]!); const retiredFile = join(commandRoot, "retired.json");
    const original = await readFile(retiredFile, "utf8"); const proof = JSON.parse(original) as { identity: string }; proof.identity = "mismatched-birth";
    await writeFile(retiredFile, JSON.stringify(proof)); expect((await recovered.recover!({ operationId: "lost-service", journalDirectory })).status).toBe("unknown");
    await writeFile(retiredFile, original);
    for (const file of await readdir(commandRoot)) expect(await readFile(join(commandRoot, file), "utf8")).not.toContain("private-test-credential");
  });
  it.skipIf(!windows)("keeps helper-crash recovery unknown when no durable retirement proof exists", async () => {
    const directory = await root(), journalDirectory = join(directory, "journal"), marker = join(directory, "helper-crash-writer.txt");
    const manifest = JSON.parse(await readFile(join(dirname(helper), "manifest.json"), "utf8")) as { sourceDigest: string; helper: { sha256: string } };
    const journal = await createCommandJournal(journalDirectory, { operationId: "helper-crash", helperSha256: manifest.helper.sha256, helperSourceDigest: manifest.sourceDigest });
    const child = spawn(helper, [], { cwd: directory, env: environment, windowsHide: true, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const closed = new Promise<void>(resolve => { child.once("close", () => resolve()); }); child.stdout.resume(); child.stderr.resume();
    child.stdin.write(`${JSON.stringify({ protocol: 1, nonce: journal.nonce, commandId: journal.commandId, journalDirectory: journal.directory, operationId: journal.operationId,
      helperSha256: journal.helperSha256, helperSourceDigest: journal.helperSourceDigest, executable: process.execPath,
      args: ["-e", `const fs=require('fs');fs.appendFileSync(${JSON.stringify(marker)},'x');setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'x'),10)`],
      cwd: directory, environment, timeoutMs: 15_000 })}\n`);
    await waitForFile(marker); child.kill("SIGKILL"); await closed;
    const bytes = (await stat(marker)).size; await pause(120); expect((await stat(marker)).size).toBe(bytes);
    expect((await runner().recover!({ operationId: "helper-crash", journalDirectory })).status).toBe("unknown");
    expect(existsSync(join(journal.directory, "retired.json"))).toBe(false);
  });
});
