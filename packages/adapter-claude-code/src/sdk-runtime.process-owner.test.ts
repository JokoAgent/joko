import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableProcessOwner, type ProcessIdentitySupervisor } from "@joko/runtime-governance";
import { spawnOwnedClaudeCodeProcess } from "./sdk-runtime.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Claude SDK owned custom spawn", () => {
  it("publishes exact ownership before returning and retires through the forwarded signal", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-claude-owner-"));
    roots.push(root);
    const terminate = vi.fn(async (
      pid: number,
      expectedIdentity: string
    ) => {
      if (expectedIdentity !== `identity-${pid}`) return "identity_mismatch" as const;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        return "not_running" as const;
      }
      return "terminated" as const;
    });
    const supervisor: ProcessIdentitySupervisor = {
      capture: async (pid) => `identity-${pid}`,
      captureSync: (pid) => `identity-${pid}`,
      terminate
    };
    const owner = new DurableProcessOwner({
      rootDirectory: root,
      instanceId: "claude-instance",
      generation: 6,
      recoverStale: false,
      supervisor
    });
    await owner.prepare(1_000);
    const forwarded = new AbortController();
    const child = spawnOwnedClaudeCodeProcess({
      command: process.execPath,
      args: ["-e", "setInterval(() => undefined, 1000)"],
      cwd: process.cwd(),
      env: { ...process.env },
      signal: forwarded.signal
    }, owner, 1_000);
    const exit = new Promise<void>((resolvePromise) => {
      child.once("exit", () => resolvePromise());
    });
    const files = await readdir(join(root, "6"));
    expect(files).toHaveLength(1);
    const manifest = JSON.parse(await readFile(join(root, "6", files[0]!), "utf8")) as {
      readonly pid: number;
      readonly processIdentity: string;
    };
    expect(manifest).toMatchObject({ processIdentity: `identity-${manifest.pid}` });

    forwarded.abort();
    await exit;
    await expectOwnerRootEmpty(root);
    expect(terminate).toHaveBeenCalledWith(manifest.pid, manifest.processIdentity, 1_000);
  });
});

async function expectOwnerRootEmpty(root: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await readdir(root)).length === 0) return;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  expect(await readdir(root)).toEqual([]);
}
