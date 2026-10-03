import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, chmod, link, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { REMOTE_PI_SESSION_SOURCE, REMOTE_PI_SESSION_SOURCE_SHA256 } from "./remote-pi-session-source.js";
import { mkdtemp } from "./test-paths.js";

const directories: string[] = [];
const genericError = "Remote Pi Session file request failed.\n";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface Result {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function fixture() {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "joko-pi-session-helper-")));
  directories.push(temporary);
  const root = join(temporary, "sessions");
  const cwd = join(temporary, "workspace");
  await mkdir(root, { mode: 0o700 });
  await mkdir(cwd, { mode: 0o700 });
  const script = join(temporary, "session-helper.mjs");
  await writeFile(script, REMOTE_PI_SESSION_SOURCE, { mode: 0o600 });
  const path = join(root, "reserved.jsonl");
  const nativeSessionId = "6f8abaee-ec0a-4af7-80e9-6f6a48b02d0c";
  const source = `${JSON.stringify({
    type: "session", version: 3, id: nativeSessionId, timestamp: "2026-10-03T00:00:00.000Z", cwd
  })}\n`;
  const base = { root, path, cwd, nativeSessionId };
  const materialize = { ...base, action: "materialize", content: Buffer.from(source).toString("base64") };
  const run = (request: unknown): Promise<Result> => new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.stdin.on("error", () => undefined);
    child.on("close", (code) => resolveResult({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(request));
  });
  return { temporary, root, cwd, path, base, source, materialize, run };
}

function accepted(result: Result, value: Record<string, unknown>): void {
  expect(result).toEqual({ code: 0, stdout: `${JSON.stringify(value)}\n`, stderr: "" });
}

function rejected(result: Result): void {
  expect(result).toEqual({ code: 1, stdout: "", stderr: genericError });
}

describe("remote Pi Session file helper", () => {
  it("exclusively creates a v3 Session and confirms an advanced file without replacing appended history", async () => {
    const state = await fixture();
    expect(createHash("sha256").update(REMOTE_PI_SESSION_SOURCE).digest("hex")).toBe(REMOTE_PI_SESSION_SOURCE_SHA256);
    accepted(await state.run(state.materialize), { ok: true, created: true });
    expect(await readFile(state.path, "utf8")).toBe(state.source);
    const message = '{"type":"message","id":"message-a","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"retained"}]}}\n';
    await appendFile(state.path, message);
    accepted(await state.run(state.materialize), { ok: true, created: false });
    accepted(await state.run({ ...state.materialize, action: "confirm" }), { ok: true, created: false });
    expect(await readFile(state.path, "utf8")).toBe(state.source + message);
  });

  it("never recreates a missing Session during adoption confirmation", async () => {
    const state = await fixture();
    rejected(await state.run({ ...state.materialize, action: "confirm" }));
    expect(await readdir(state.root)).toEqual([]);
  });

  it.each(["id", "cwd", "parentSession"] as const)("rejects an existing Session with a different %s without changing it", async (field) => {
    const state = await fixture();
    const value = JSON.parse(state.source) as Record<string, unknown>;
    value[field] = field === "id" ? "another-session" : join(state.temporary, "another-owner");
    const conflicting = `${JSON.stringify(value)}\n`;
    await writeFile(state.path, conflicting, { mode: 0o600 });
    rejected(await state.run(state.materialize));
    expect(await readFile(state.path, "utf8")).toBe(conflicting);
  });

  it("accepts only the matching parent header for a normal mirrored fork", async () => {
    const state = await fixture();
    const value = JSON.parse(state.source) as Record<string, unknown>;
    value.parentSession = join(state.root, "source.jsonl");
    const mirrored = `${JSON.stringify(value)}\n{"type":"custom","id":"event-a"}\n`;
    const request = { ...state.materialize, content: Buffer.from(mirrored).toString("base64") };
    accepted(await state.run(request), { ok: true, created: true });
    await appendFile(state.path, '{"type":"custom","id":"event-b"}\n');
    accepted(await state.run(request), { ok: true, created: false });
    expect(await readFile(state.path, "utf8")).toBe(`${mirrored}{"type":"custom","id":"event-b"}\n`);
  });

  it("rejects hardlinked Session files for confirmation and removal", async () => {
    const state = await fixture();
    await writeFile(state.path, state.source, { mode: 0o600 });
    const other = join(state.root, "other.jsonl");
    await link(state.path, other);
    rejected(await state.run(state.materialize));
    rejected(await state.run({ ...state.base, action: "remove" }));
    expect(await readFile(other, "utf8")).toBe(state.source);
    expect(await readdir(state.root)).toEqual(["other.jsonl", "reserved.jsonl"]);
  });

  it("rejects Session paths passing through a symlinked directory", async () => {
    const state = await fixture();
    const target = join(state.root, "actual");
    const alias = join(state.root, "alias");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
    const path = join(alias, "reserved.jsonl");
    rejected(await state.run({ ...state.materialize, path }));
    rejected(await state.run({ ...state.base, action: "remove", path }));
    expect(await readdir(target)).toEqual([]);
  });

  it.runIf(process.platform !== "win32")("rejects symlinked files and nonprivate file or directory modes", async () => {
    const state = await fixture();
    const target = join(state.root, "original.jsonl");
    await writeFile(target, state.source, { mode: 0o600 });
    await symlink(target, state.path);
    rejected(await state.run(state.materialize));
    rejected(await state.run({ ...state.base, action: "remove" }));
    expect(await readFile(target, "utf8")).toBe(state.source);
    await rm(state.path);
    await writeFile(state.path, state.source, { mode: 0o644 });
    rejected(await state.run(state.materialize));
    await chmod(state.path, 0o600);
    await chmod(state.root, 0o755);
    rejected(await state.run(state.materialize));
    rejected(await state.run({ ...state.base, action: "remove" }));
  });

  it.each(["noncanonical", "outside", "shape", "base64", "header"] as const)("rejects %s requests before creating a Session", async (kind) => {
    const state = await fixture();
    const request = kind === "noncanonical" ? { ...state.materialize, path: `${state.root}/../sessions/reserved.jsonl` }
      : kind === "outside" ? { ...state.materialize, path: join(state.temporary, "outside.jsonl") }
        : kind === "shape" ? { ...state.materialize, unexpected: true }
          : kind === "base64" ? { ...state.materialize, content: `${state.materialize.content}\n` }
            : { ...state.materialize, content: Buffer.from(state.source.replace('"version":3', '"version":2')).toString("base64") };
    rejected(await state.run(request));
    expect(await readdir(state.root)).toEqual([]);
  });

  it("removes only the exact reserved Session and confirms absence without creating missing parents", async () => {
    const state = await fixture();
    accepted(await state.run(state.materialize), { ok: true, created: true });
    const sourcePath = join(state.root, "source.jsonl");
    await writeFile(sourcePath, state.source.replace(state.base.nativeSessionId, "source-session"), { mode: 0o600 });
    rejected(await state.run({ ...state.base, nativeSessionId: "wrong-session", action: "remove" }));
    accepted(await state.run({ ...state.base, action: "remove" }), { ok: true, removed: true });
    accepted(await state.run({ ...state.base, action: "remove" }), { ok: true, removed: false });
    accepted(await state.run({ ...state.base, path: join(state.root, "missing", "reserved.jsonl"), action: "remove" }), { ok: true, removed: false });
    expect(await readdir(state.root)).toEqual(["source.jsonl"]);
    expect(await readFile(sourcePath, "utf8")).toContain('"id":"source-session"');
  });
});
