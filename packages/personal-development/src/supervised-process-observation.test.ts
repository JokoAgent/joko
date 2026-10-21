import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: native.spawn }));
import { createSupervisedDevelopmentProcessAuthority } from "./supervised-process.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const roots: string[] = [];
afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  vi.clearAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("private command retirement observations", () => {
  it.each([
    { stage: "birth", systemCode: "ESRCH", accepted: true },
    { stage: "receipt", systemCode: "ENOSPC", accepted: true },
    { stage: "private command argument", systemCode: "ESRCH", accepted: false },
    { stage: "receipt", systemCode: "private native diagnostic", accepted: false },
    { stage: ["birth"], systemCode: "ESRCH", accepted: false }
  ])("keeps failure unknown and projects only fixed fields: $stage / $systemCode", async ({ stage, systemCode, accepted }) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "joko-command-observation-")));
    roots.push(root);
    const helper = join(root, "posix-command-host.js");
    await writeFile(helper, "// controlled helper identity\n");
    await writeFile(join(root, "posix-command-sentinel.js"), "// controlled sentinel identity\n");
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    native.spawn.mockImplementation(() => {
      const channel = new PassThrough();
      const child = Object.assign(new EventEmitter(), { pid: 431, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), stdio: [null, null, null, channel] });
      child.stdin.once("data", (bytes: Buffer) => {
        const request = JSON.parse(bytes.toString("utf8")) as { nonce: string };
        queueMicrotask(() => {
          channel.write(`${JSON.stringify({ protocol: 1, nonce: request.nonce, event: "started", pid: 432, identity: "darwin:owned" })}\n`);
          channel.write(`${JSON.stringify({ protocol: 1, nonce: request.nonce, event: "failed", stage, systemCode })}\n`);
          child.emit("close", 2);
        });
      });
      return child;
    });
    const runner = createSupervisedDevelopmentProcessAuthority({ posixHelperPath: helper, journalDirectory: join(root, "journal") });
    const error: unknown = await runner.run({ executable: process.execPath, args: [], cwd: root, environment: {},
      signal: new AbortController().signal, timeoutMs: 1000 }).catch(error => error);
    expect(error).toMatchObject({ code: "PROCESS_UNKNOWN" });
    expect((error as Error).cause).toEqual(accepted ? { stage, systemCode } : undefined);
    expect(Object.keys(error as object)).not.toContain("cause");
  });
});
