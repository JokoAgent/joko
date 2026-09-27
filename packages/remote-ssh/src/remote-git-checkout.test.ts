import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { posix, win32 } from "node:path";
import { Script, runInNewContext } from "node:vm";

import {
  RemoteGitCheckoutError,
  RemoteGitCheckoutService,
  type RemoteGitCheckoutAuthority,
  type RemoteGitCheckoutExecutionOptions,
  type RemoteGitCheckoutLease,
  type RemoteGitCheckoutPlan
} from "./remote-git-checkout.js";
import type { RemoteSshExecutionResult } from "./types.js";

const head = "a".repeat(40);
const snapshot = `sha256:${"c".repeat(64)}`;
const authority: RemoteGitCheckoutAuthority = {
  targetId: "target-a",
  binding: { kind: "ssh", hostTargetId: "host-target-a", hostId: "host-a", workspaceRoot: "/srv/project" },
  executionIdentity: `sha256:${"b".repeat(64)}`,
  targetRevision: "12"
};

function reply(value: unknown): RemoteSshExecutionResult {
  return { stdout: JSON.stringify({ format: 1, ...value as object }), stderr: "", exitCode: 0, outputCapped: false };
}

function operation(request: RemoteGitCheckoutExecutionOptions): { operation: string; data: unknown } {
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
  it("accepts the bounded structured execution identity persisted by the current remote authority", async () => {
    const structuredAuthority: RemoteGitCheckoutAuthority = {
      ...authority,
      executionIdentity: JSON.stringify({
        kind: "ssh",
        hostTargetId: "host-target-a",
        hostId: "host-a",
        ownerId: "owner-a",
        hostname: "fixture.invalid",
        port: 22,
        user: "fixture",
        algorithm: "ssh-ed25519",
        fingerprint: `SHA256:${"b".repeat(300)}`
      })
    };
    const execute = vi.fn(async (): Promise<RemoteSshExecutionResult> => reply({
      status: "source", repositoryRoot: "/srv/project", sourceCommit: head, sourceSnapshot: snapshot
    }));
    const service = new RemoteGitCheckoutService({
      storageRoot: "/srv/joko/worktrees", nodeExecutable: "/opt/joko/node/bin/node", pathStyle: "posix", execute,
      assertCurrent: () => undefined
    });

    await expect(service.plan({
      sessionId: "child", sourceSessionId: "parent", workspaceId: "workspace-child",
      sourceCwd: "/srv/project", authority: structuredAuthority
    })).resolves.toMatchObject({ authority: structuredAuthority });
    expect(structuredAuthority.executionIdentity.length).toBeGreaterThan(256);
    await expect(service.plan({
      sessionId: "child-2", sourceSessionId: "parent", workspaceId: "workspace-child-2",
      sourceCwd: "/srv/project", authority: { ...structuredAuthority, executionIdentity: "x".repeat(4_097) }
    })).rejects.toMatchObject({ code: "INVALID_ARGUMENT", stateMayHaveChanged: false });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("uses native Win32 paths and structured Node argv for a Device peer checkout", async () => {
    const peerAuthority: RemoteGitCheckoutAuthority = {
      targetId: "target-win",
      binding: {
        kind: "device_peer",
        controllerDeviceId: "controller-a",
        targetDeviceId: "desktop-win",
        workspaceRoot: "C:\\work\\project"
      },
      executionIdentity: "device-peer:desktop-win",
      targetRevision: "3"
    };
    let helperError: unknown;
    const execute = vi.fn(async (request: RemoteGitCheckoutExecutionOptions): Promise<RemoteSshExecutionResult> => {
      expect(request).toMatchObject({
        executable: "C:\\Joko\\runtime\\node.exe",
        args: ["-e", expect.any(String)]
      });
      expect(JSON.parse(request.input ?? "")).toMatchObject({ pathStyle: "win32" });
      try { return runWin32RemoteHelperProbe(request); }
      catch (error) {
        helperError = error;
        return reply({ status: "source", repositoryRoot: "C:\\work\\project", sourceCommit: head, sourceSnapshot: snapshot });
      }
    });
    const service = new RemoteGitCheckoutService({
      storageRoot: "C:\\Joko\\runtime\\worktrees",
      nodeExecutable: "C:\\Joko\\runtime\\node.exe",
      pathStyle: "win32",
      execute,
      assertCurrent: () => undefined
    });

    const plan = await service.plan({
      sessionId: "child-win",
      sourceSessionId: "parent-win",
      workspaceId: "workspace-win",
      sourceCwd: "C:\\work\\project",
      authority: peerAuthority
    });

    expect(plan.path).toBe(`C:\\Joko\\runtime\\worktrees\\checkouts\\${plan.leaseId}`);
    expect(plan.remote).toMatchObject({ binding: peerAuthority.binding });
    expect(helperError).toBeUndefined();
  });

  it("plans an exact checkout before mutation and recovers a lost derive acknowledgement by inspecting the same lease", async () => {
    let durable: RemoteGitCheckoutLease | undefined;
    let loseAcknowledgement = true;
    const execute = vi.fn(async (request: RemoteGitCheckoutExecutionOptions): Promise<RemoteSshExecutionResult> => {
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
      storageRoot: "/srv/joko/worktrees", nodeExecutable: "/opt/joko/node/bin/node", pathStyle: "posix", execute, assertCurrent
    });
    const plan = await service.plan({
      sessionId: "child", sourceSessionId: "parent", workspaceId: "workspace-child",
      sourceCwd: "/srv/project/subdir", authority
    });
    expect(plan).toMatchObject({
      workspaceId: "workspace-child", repositoryRoot: "/srv/project", sourceCommit: head,
      sourceRef: head, sourceSnapshot: snapshot, sourceStrategy: "explicit", sourceRefreshed: false,
      remote: { binding: authority.binding, executionIdentity: `sha256:${"b".repeat(64)}` }
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
    expect(() => new Script(extractRemoteHelper(execute.mock.calls[0]![0]))).not.toThrow();
    loseAcknowledgement = false;
  });

  it("rejects a changed owner or returned manifest without adopting an unverified lease", async () => {
    let changedField: "manifestId" | "executionIdentity" = "manifestId";
    const execute = vi.fn(async (request: RemoteGitCheckoutExecutionOptions): Promise<RemoteSshExecutionResult> => {
      const call = operation(request);
      if (call.operation === "probe") return reply({ status: "source", repositoryRoot: "/srv/project", sourceCommit: head, sourceSnapshot: snapshot });
      const lease = ownedLease(call.data as RemoteGitCheckoutPlan);
      return reply({ status: "active", lease: {
        ...lease, remote: { ...lease.remote, [changedField]: changedField === "manifestId"
          ? "11111111-1111-4111-8111-111111111111" : "changed-execution" }
      } });
    });
    const service = new RemoteGitCheckoutService({
      storageRoot: "/srv/joko/worktrees", nodeExecutable: "/opt/joko/node/bin/node", pathStyle: "posix", execute,
      assertCurrent: () => undefined
    });
    const plan = await service.plan({
      sessionId: "child", sourceSessionId: "parent", workspaceId: "workspace-child",
      sourceCwd: "/srv/project", authority
    });
    await expect(service.derive(plan)).rejects.toMatchObject({ code: "LEASE_CONFLICT" });
    changedField = "executionIdentity";
    await expect(service.derive(plan)).rejects.toMatchObject({ code: "LEASE_CONFLICT" });
    await expect(service.plan({
      sessionId: "child2", sourceSessionId: "child", workspaceId: "workspace-2",
      sourceCwd: plan.path, sourceLease: {
        ...ownedLease(plan), remote: { ...plan.remote, executionIdentity: "other" }
      },
      authority
    })).rejects.toBeInstanceOf(RemoteGitCheckoutError);
  });

  it("fences remote effects on authority loss and distinguishes SSH unavailability from lease mismatch", async () => {
    let current = true;
    const execute = vi.fn(async (request: RemoteGitCheckoutExecutionOptions): Promise<RemoteSshExecutionResult> => {
      if (operation(request).operation === "probe") return reply({ status: "source", repositoryRoot: "/srv/project", sourceCommit: head, sourceSnapshot: snapshot });
      throw new Error("SSH disconnected");
    });
    const service = new RemoteGitCheckoutService({
      storageRoot: "/srv/joko/worktrees", nodeExecutable: "/opt/joko/node/bin/node", pathStyle: "posix", execute,
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
      storageRoot: "/srv/joko/worktrees", nodeExecutable: "/opt/joko/node/bin/node", pathStyle: "posix",
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
    const execute = vi.fn(async (request: RemoteGitCheckoutExecutionOptions): Promise<RemoteSshExecutionResult> => {
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
      storageRoot: "/srv/joko/worktrees", nodeExecutable: "/opt/joko/node/bin/node", pathStyle: "posix", execute,
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
    const execute = async (request: RemoteGitCheckoutExecutionOptions): Promise<RemoteSshExecutionResult> =>
      runRemoteHelper(request, tracked, gitCalls);
    const service = new RemoteGitCheckoutService({
      storageRoot: "/srv/joko/worktrees", nodeExecutable: "/opt/joko/node/bin/node", pathStyle: "posix", execute,
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
    const execute = vi.fn(async (request: RemoteGitCheckoutExecutionOptions): Promise<RemoteSshExecutionResult> => {
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
      storageRoot: "/srv/joko/worktrees", nodeExecutable: "/opt/joko/node/bin/node", pathStyle: "posix", execute,
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

function extractRemoteHelper(request: RemoteGitCheckoutExecutionOptions): string {
  if (request.args.length !== 2 || request.args[0] !== "-e" || request.args[1] === undefined) {
    throw new Error("Remote Node command is malformed.");
  }
  return request.args[1];
}

function runRemoteHelper(
  request: RemoteGitCheckoutExecutionOptions,
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
  runInNewContext(extractRemoteHelper(request), {
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

function runWin32RemoteHelperProbe(request: RemoteGitCheckoutExecutionOptions): RemoteSshExecutionResult {
  const root = "C:\\work\\project";
  const gitDirectory = `${root}\\.git`;
  const directory = {
    dev: 1, ino: 1, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false
  };
  const fakeFs = {
    constants: fileConstants,
    readFileSync: (target: string | number) => {
      if (target === 0) return request.input ?? "";
      throw new Error(`Unexpected file read: ${String(target)}`);
    },
    lstatSync: (target: string) => {
      if (target === root) return directory;
      throw new Error(`Unexpected lstat: ${target}`);
    },
    statSync: (target: string) => {
      if (target === gitDirectory) return { dev: 1n, ino: 2n, isDirectory: () => true };
      throw new Error(`Unexpected stat: ${target}`);
    },
    realpathSync: (target: string) => win32.normalize(target),
    existsSync: () => false
  };
  const fakeChildProcess = {
    spawnSync: (_executable: string, args: string[], options: { encoding?: string }) => {
      const command = args.join(" ");
      let output = "";
      let status = 0;
      if (command === "rev-parse --show-toplevel") output = "C:/work/project\n";
      else if (command === "rev-parse --git-common-dir" || command === "rev-parse --git-dir") output = "C:/work/project/.git\n";
      else if (command === "rev-parse --verify HEAD^{commit}") output = `${head}\n`;
      else if (command === "symbolic-ref --quiet --short HEAD") output = "main\n";
      else if ([
        "ls-files --stage -z", "ls-files -v -z", "ls-files --cached -z",
        "status --porcelain=v2 -z --untracked-files=all --ignored=matching",
        "ls-files --others --exclude-standard -z"
      ].includes(command)) output = "";
      else { status = 1; }
      return { status, signal: null, stdout: options.encoding === "utf8" ? output : Buffer.from(output, "utf8") };
    }
  };
  let stdout = "";
  runInNewContext(extractRemoteHelper(request), {
    Buffer,
    TextDecoder,
    require: (name: string) => {
      if (name === "node:fs") return fakeFs;
      if (name === "node:path") return { posix, win32 };
      if (name === "node:crypto") return { createHash: createHashProxy };
      if (name === "node:child_process") return fakeChildProcess;
      throw new Error(`Unexpected module: ${name}`);
    },
    process: {
      platform: "win32",
      env: { PATH: "C:\\Windows\\System32", USERPROFILE: "C:\\Users\\test" },
      cwd: () => root,
      stdout: { write: (value: string) => { stdout += value; } }
    }
  });
  return { stdout, stderr: "", exitCode: 0, outputCapped: false };
}

function createHashProxy(algorithm: string) {
  return createHash(algorithm);
}
