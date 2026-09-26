import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { posix } from "node:path";
import { Script, runInNewContext } from "node:vm";

import {
  RemoteGitCheckoutError,
  RemoteGitCheckoutService,
  type RemoteGitCheckoutAuthority,
  type RemoteGitCheckoutLease,
  type RemoteGitCheckoutPlan
} from "./remote-git-checkout.js";
import type { RemoteSshExecutionOptions, RemoteSshExecutionResult } from "./types.js";

const head = "a".repeat(40);
const snapshot = `sha256:${"c".repeat(64)}`;
const authority: RemoteGitCheckoutAuthority = {
  hostOwnerId: "owner-a", hostTargetId: "host-target-a", hostId: "host-a",
  hostIdentity: `sha256:${"b".repeat(64)}`, targetId: "target-a",
  targetRevision: "12", hostRevision: "19"
};

function reply(value: unknown): RemoteSshExecutionResult {
  return { stdout: JSON.stringify({ format: 1, ...value as object }), stderr: "", exitCode: 0, outputCapped: false };
}

function operation(request: RemoteSshExecutionOptions): { operation: string; data: unknown } {
  return JSON.parse(request.input ?? "") as { operation: string; data: unknown };
}

function ownedLease(plan: RemoteGitCheckoutPlan): RemoteGitCheckoutLease {
  return {
    id: plan.leaseId, sessionId: plan.sessionId, path: plan.path,
    repositoryRoot: plan.repositoryRoot, branch: plan.branch,
    source: { ref: head, commit: head, refreshed: false, strategy: "explicit" },
    acquiredAt: 1_000, remote: plan.remote
  };
}

describe("remote Git checkout authority", () => {
  it("plans an exact checkout before mutation and recovers a lost derive acknowledgement by inspecting the same lease", async () => {
    let durable: RemoteGitCheckoutLease | undefined;
    let loseAcknowledgement = true;
    const execute = vi.fn(async (request: RemoteSshExecutionOptions): Promise<RemoteSshExecutionResult> => {
      const call = operation(request);
      if (call.operation === "probe") return reply({ status: "source", repositoryRoot: "/srv/project", sourceCommit: head, sourceSnapshot: snapshot });
      if (call.operation === "derive") {
        durable = ownedLease(call.data as RemoteGitCheckoutPlan);
        if (loseAcknowledgement) throw new Error("transport closed after remote manifest commit");
        return reply({ status: "active", lease: durable });
      }
      if (call.operation === "inspect") return reply(durable === undefined
        ? { status: "absent" } : { status: "active", lease: durable });
      if (call.operation === "assert") return reply({ status: "active", lease: durable });
      return reply({ status: "preserved" });
    });
    const assertCurrent = vi.fn();
    const service = new RemoteGitCheckoutService({
      storageRoot: "/srv/joko/worktrees", nodeExecutable: "/opt/joko/node/bin/node", execute, assertCurrent
    });
    const plan = await service.plan({
      sessionId: "child", sourceSessionId: "parent", workspaceId: "workspace-child",
      sourceCwd: "/srv/project/subdir", authority
    });
    expect(plan).toMatchObject({
      workspaceId: "workspace-child", repositoryRoot: "/srv/project", sourceCommit: head,
      sourceRef: head, sourceSnapshot: snapshot, sourceStrategy: "explicit", sourceRefreshed: false,
      remote: { hostOwnerId: "owner-a", hostIdentity: `sha256:${"b".repeat(64)}` }
    });
    expect(plan.path).toBe(`/srv/joko/worktrees/checkouts/${plan.leaseId}`);
    expect(execute.mock.calls.map(([request]) => operation(request).operation)).toEqual(["probe"]);

    await expect(service.derive(plan)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", stateMayHaveChanged: true });
    expect(await service.inspectExact(plan)).toEqual({ status: "active", lease: durable });
    await service.assertExact(durable!);
    expect(await service.releaseExact(durable!)).toBe("preserved");
    expect(execute.mock.calls.map(([request]) => operation(request).operation))
      .toEqual(["probe", "derive", "inspect", "assert", "release"]);
    expect(assertCurrent).toHaveBeenCalledTimes(9);
    expect(() => new Script(extractRemoteHelper(execute.mock.calls[0]![0].command))).not.toThrow();
    loseAcknowledgement = false;
  });

  it("rejects a changed owner or returned manifest without adopting an unverified lease", async () => {
    let changedField: "manifestId" | "hostRevision" = "manifestId";
    const execute = vi.fn(async (request: RemoteSshExecutionOptions): Promise<RemoteSshExecutionResult> => {
      const call = operation(request);
      if (call.operation === "probe") return reply({ status: "source", repositoryRoot: "/srv/project", sourceCommit: head, sourceSnapshot: snapshot });
      const lease = ownedLease(call.data as RemoteGitCheckoutPlan);
      return reply({ status: "active", lease: {
        ...lease, remote: { ...lease.remote, [changedField]: changedField === "manifestId"
          ? "11111111-1111-4111-8111-111111111111" : "20" }
      } });
    });
    const service = new RemoteGitCheckoutService({
      storageRoot: "/srv/joko/worktrees", nodeExecutable: "/opt/joko/node/bin/node", execute,
      assertCurrent: () => undefined
    });
    const plan = await service.plan({
      sessionId: "child", sourceSessionId: "parent", workspaceId: "workspace-child",
      sourceCwd: "/srv/project", authority
    });
    await expect(service.derive(plan)).rejects.toMatchObject({ code: "LEASE_CONFLICT" });
    changedField = "hostRevision";
    await expect(service.derive(plan)).rejects.toMatchObject({ code: "LEASE_CONFLICT" });
    await expect(service.plan({
      sessionId: "child2", sourceSessionId: "child", workspaceId: "workspace-2",
      sourceCwd: plan.path, sourceLease: { ...ownedLease(plan), remote: { ...plan.remote, hostOwnerId: "other" } },
      authority
    })).rejects.toBeInstanceOf(RemoteGitCheckoutError);
  });

  it("fences remote effects on authority loss and distinguishes SSH unavailability from lease mismatch", async () => {
    let current = true;
    const execute = vi.fn(async (request: RemoteSshExecutionOptions): Promise<RemoteSshExecutionResult> => {
      if (operation(request).operation === "probe") return reply({ status: "source", repositoryRoot: "/srv/project", sourceCommit: head, sourceSnapshot: snapshot });
      throw new Error("SSH disconnected");
    });
    const service = new RemoteGitCheckoutService({
      storageRoot: "/srv/joko/worktrees", nodeExecutable: "/opt/joko/node/bin/node", execute,
      assertCurrent: () => { if (!current) throw new Error("host changed"); }
    });
    const plan = await service.plan({
      sessionId: "child", sourceSessionId: "parent", workspaceId: "workspace-child",
      sourceCwd: "/srv/project", authority
    });
    await expect(service.inspectExact(plan)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    current = false;
    await expect(service.derive(plan)).rejects.toMatchObject({ code: "AUTHORITY_CHANGED", stateMayHaveChanged: false });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("reports a non-Git source separately from unsafe source state", async () => {
    let sourceCode = "NOT_GIT_REPOSITORY";
    const service = new RemoteGitCheckoutService({
      storageRoot: "/srv/joko/worktrees", nodeExecutable: "/opt/joko/node/bin/node",
      execute: async () => reply({ status: "error", code: sourceCode, stateMayHaveChanged: false }),
      assertCurrent: () => undefined
    });
    const input = {
      sessionId: "child", sourceSessionId: "parent", workspaceId: "workspace-child",
      sourceCwd: "/srv/plain", authority
    };
    await expect(service.plan(input)).rejects.toMatchObject({ code: "NOT_GIT_REPOSITORY" });
    sourceCode = "SOURCE_UNSAFE";
    await expect(service.plan(input)).rejects.toMatchObject({ code: "SOURCE_UNSAFE" });
  });

  it("keeps the read-only source snapshot in the durable plan and refuses a changed source before checkout", async () => {
    let currentSnapshot = snapshot;
    let checkoutEffects = 0;
    const execute = vi.fn(async (request: RemoteSshExecutionOptions): Promise<RemoteSshExecutionResult> => {
      const call = operation(request);
      if (call.operation === "probe") return reply({
        status: "source", repositoryRoot: "/srv/project", sourceCommit: head,
        sourceSnapshot: currentSnapshot
      });
      if (call.operation === "derive") {
        const planned = call.data as RemoteGitCheckoutPlan;
        if (planned.sourceSnapshot !== currentSnapshot) return reply({
          status: "error", code: "SOURCE_CHANGED", stateMayHaveChanged: false
        });
        checkoutEffects += 1;
        return reply({ status: "active", lease: ownedLease(planned) });
      }
      throw new Error("Unexpected checkout operation.");
    });
    const service = new RemoteGitCheckoutService({
      storageRoot: "/srv/joko/worktrees", nodeExecutable: "/opt/joko/node/bin/node", execute,
      assertCurrent: () => undefined
    });
    const plan = await service.plan({
      sessionId: "child", sourceSessionId: "parent", workspaceId: "workspace-child",
      sourceCwd: "/srv/project", authority
    });
    expect(plan.sourceSnapshot).toBe(snapshot);
    currentSnapshot = `sha256:${"d".repeat(64)}`;
    await expect(service.derive(plan)).rejects.toMatchObject({
      code: "SOURCE_CHANGED", stateMayHaveChanged: false
    });
    expect(checkoutEffects).toBe(0);
    await expect(service.derive({ ...plan, sourceSnapshot: "invalid" })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT", stateMayHaveChanged: false
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("detects a dirty tracked-file change in the remote helper before any checkout effect", async () => {
    let tracked = Buffer.from("planned working content", "utf8");
    const gitCalls: string[][] = [];
    const execute = async (request: RemoteSshExecutionOptions): Promise<RemoteSshExecutionResult> =>
      runRemoteHelper(request, tracked, gitCalls);
    const service = new RemoteGitCheckoutService({
      storageRoot: "/srv/joko/worktrees", nodeExecutable: "/opt/joko/node/bin/node", execute,
      assertCurrent: () => undefined
    });
    const plan = await service.plan({
      sessionId: "child", sourceSessionId: "parent", workspaceId: "workspace-child",
      sourceCwd: "/srv/project", authority
    });
    expect(plan.sourceSnapshot).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(plan)).not.toContain("planned working content");
    expect(gitCalls.some((args) => args[0] === "stash" || args[0] === "worktree")).toBe(false);
    tracked = Buffer.from("changed working content", "utf8");
    await expect(service.derive(plan)).rejects.toMatchObject({
      code: "SOURCE_CHANGED", stateMayHaveChanged: false
    });
    expect(gitCalls.some((args) => args[0] === "stash" || args[0] === "worktree" && args[1] === "add")).toBe(false);
  });

  it("retains an uncertain pending checkout when exact cleanup cannot prove it is clean", async () => {
    let planned: RemoteGitCheckoutPlan | undefined;
    const execute = vi.fn(async (request: RemoteSshExecutionOptions): Promise<RemoteSshExecutionResult> => {
      const call = operation(request);
      if (call.operation === "probe") return reply({ status: "source", repositoryRoot: "/srv/project", sourceCommit: head, sourceSnapshot: snapshot });
      if (call.operation === "derive") { planned = call.data as RemoteGitCheckoutPlan; throw new Error("lost effect receipt"); }
      if (call.operation === "inspect") return reply({ status: "pending" });
      if (call.operation === "cleanup") {
        expect(call.data).toEqual(planned);
        return reply({ status: "preserved" });
      }
      throw new Error("unexpected operation");
    });
    const service = new RemoteGitCheckoutService({
      storageRoot: "/srv/joko/worktrees", nodeExecutable: "/opt/joko/node/bin/node", execute,
      assertCurrent: () => undefined
    });
    const plan = await service.plan({
      sessionId: "child", sourceSessionId: "parent", workspaceId: "workspace-child",
      sourceCwd: "/srv/project", authority
    });
    await expect(service.derive(plan)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(await service.inspectExact(plan)).toEqual({ status: "pending" });
    expect(await service.cleanupPending(plan)).toBe("preserved");
  });
});

function extractRemoteHelper(command: string): string {
  const delimiter = "' -e '";
  const at = command.indexOf(delimiter);
  if (at < 0 || !command.endsWith("'")) throw new Error("Remote Node command is malformed.");
  return command.slice(at + delimiter.length, -1).replaceAll("'\\''", "'");
}

function runRemoteHelper(
  request: RemoteSshExecutionOptions,
  tracked: Buffer,
  gitCalls: string[][]
): RemoteSshExecutionResult {
  const file = "/srv/project/file.txt";
  const directory = {
    dev: 1, ino: 1, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false
  };
  const fileStat = () => ({
    dev: 1, ino: 2, size: tracked.length, mtimeMs: 1, mode: 0o100644,
    isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false
  });
  const fakeFs = {
    constants: fileConstants,
    readFileSync: (target: string | number) => {
      if (target === 0) return request.input ?? "";
      if (target === 51) return tracked;
      throw new Error("Unexpected file read.");
    },
    lstatSync: (target: string) => {
      if (target === file) return fileStat();
      if (target === "/srv/project") return directory;
      throw new Error("Unexpected lstat.");
    },
    statSync: (target: string) => {
      if (target === "/srv/project/.git") return {
        dev: 1n, ino: 3n, isDirectory: () => true
      };
      throw new Error("Unexpected stat.");
    },
    realpathSync: (target: string) => target,
    existsSync: () => false,
    openSync: (target: string) => {
      if (target === file) return 51;
      throw new Error("Unexpected open.");
    },
    fstatSync: (fd: number) => {
      if (fd === 51) return fileStat();
      throw new Error("Unexpected fstat.");
    },
    closeSync: () => undefined
  };
  const fakeChildProcess = {
    spawnSync: (_executable: string, args: string[], options: { encoding?: string }) => {
      gitCalls.push(args);
      let output: string;
      let status = 0;
      const command = args.join(" ");
      if (command === "rev-parse --show-toplevel") output = "/srv/project\n";
      else if (command === "rev-parse --git-common-dir" || command === "rev-parse --git-dir") output = "/srv/project/.git\n";
      else if (command === "rev-parse --verify HEAD^{commit}") output = `${head}\n`;
      else if (command === "symbolic-ref --quiet --short HEAD") output = "main\n";
      else if (command === "ls-files --stage -z") output = `100644 ${"e".repeat(40)} 0\tfile.txt\0`;
      else if (command === "ls-files -v -z") output = "H file.txt\0";
      else if (command === "ls-files --cached -z") output = "file.txt\0";
      else if (command === "status --porcelain=v2 -z --untracked-files=all --ignored=matching"
        || command === "ls-files --others --exclude-standard -z") output = "";
      else if (command.startsWith("show-ref --verify --quiet")) { output = ""; status = 1; }
      else throw new Error(`Unexpected Git command: ${command}`);
      return { status, signal: null, stdout: options.encoding === "utf8" ? output : Buffer.from(output, "utf8") };
    }
  };
  let stdout = "";
  runInNewContext(extractRemoteHelper(request.command), {
    Buffer,
    TextDecoder,
    require: (name: string) => {
      if (name === "node:fs") return fakeFs;
      if (name === "node:path") return { posix };
      if (name === "node:crypto") return { createHash: createHashProxy };
      if (name === "node:child_process") return fakeChildProcess;
      throw new Error(`Unexpected module: ${name}`);
    },
    process: { env: { PATH: "/usr/bin:/bin", HOME: "/home/test" }, stdout: { write: (value: string) => { stdout += value; } } }
  });
  return { stdout, stderr: "", exitCode: 0, outputCapped: false };
}

function createHashProxy(algorithm: string) {
  return createHash(algorithm);
}
