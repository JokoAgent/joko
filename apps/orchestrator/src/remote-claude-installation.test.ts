import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { RemoteProcessHandle, RemoteProcessStartRequest, RemoteProcessTransportPort } from "@joko/remote-ssh";
import { describe, expect, it } from "vitest";

import {
  REMOTE_CLAUDE_EXPECTED_VERSION,
  installRemoteClaude,
  probeRemoteClaudeInstallation,
  uninstallRemoteClaude
} from "./remote-claude-installation.js";

describe("remote Claude installation", () => {
  it("admits only the exact Joko-owned Node, SDK, CLI, manager, and canonical workspace", async () => {
    const processes = new ScriptedProcesses([probeOutput("ready")]);
    await expect(probeRemoteClaudeInstallation(processes, "/srv/project", () => undefined)).resolves.toMatchObject({
      state: "ready",
      workspaceRoot: "/srv/project-real",
      runtimeRoot: "/home/test/.joko/runtime/v1/claude-code",
      nodeExecutable: "/home/test/.joko/runtime/v1/claude-code/current/node/bin/node",
      managerModule: "/home/test/.joko/runtime/v1/claude-code/current/manager.mjs",
      claudeExecutable: "/home/test/.joko/runtime/v1/claude-code/current/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
      installedVersion: REMOTE_CLAUDE_EXPECTED_VERSION
    });
    expect(processes.requests[0]).toMatchObject({
      executable: "/bin/sh",
      cwd: "/srv/project",
      args: ["-c", expect.stringContaining(".joko-runtime-ready-v1")]
    });
    const script = processes.requests[0]?.args[1] ?? "";
    expectValidShellSyntax(script);
    expect(script).toContain('env -i HOME="$root/profile"');
    expect(script).toContain('CLAUDE_CONFIG_DIR="$root/profile"');
    expect(script).toContain('private_dir "$root"');
    expect(script).toContain('[ ! -L "$root/.joko-runtime-ready-v1" ]');
    expect(script).toContain('"managerSha256":"');

    const stale = new ScriptedProcesses([probeOutput("not_installed", {
      sdk: "0.0.1",
      cli: "0.0.2",
      claudeExecutable: ""
    })]);
    await expect(probeRemoteClaudeInstallation(stale, "/", () => undefined)).resolves.toMatchObject({
      state: "not_installed"
    });
  });

  it("builds a fixed checksum-verified runtime in staging and atomically replaces a corrupt current tree", async () => {
    const processes = new ScriptedProcesses([
      {
        stdout: "JOKO_PHASE probing\nJOKO_PHASE downloading\nJOKO_PHASE installing\nJOKO_PHASE validating\nJOKO_PHASE complete\n",
        exitCode: 0
      },
      probeOutput("ready", { workspace: "/" })
    ]);
    const phases: string[] = [];
    await expect(installRemoteClaude(processes, {
      reinstall: false,
      assertCurrent: () => undefined,
      onPhase: (phase) => phases.push(phase)
    })).resolves.toMatchObject({ state: "ready" });
    expect(phases).toEqual(["probing", "downloading", "installing", "validating", "complete"]);

    const script = processes.inputs[0] ?? "";
    expectValidShellSyntax(script);
    expect(script).toContain("node-v22.13.0-linux-x64.tar.gz");
    expect(script).toContain("nodejs.org/dist/v22.13.0");
    expect(script).toContain("bc1e374e7393e2f4b20e5bbc157d02e9b1fb2c634b2f992136b38fb8ca2023b7");
    expect(script).toContain('HOME="$stage/home"');
    expect(script).toContain('env -i HOME="$stage/home"');
    expect(script).toContain('env -i HOME="$root/profile"');
    expect(script).toContain('"@anthropic-ai/claude-agent-sdk":"0.3.259"');
    expect(script).toContain('"@anthropic-ai/sdk":"0.120.0"');
    expect(script).toContain('"@modelcontextprotocol/sdk":"1.29.0"');
    expect(script).toContain('"zod":"4.4.3"');
    expect(script).toContain("--ignore-scripts");
    expect(script).toContain(".joko-install-lock");
    expect(script).toContain('ensure_private_dir "$home/.joko/runtime/v1"');
    expect(script).toContain('[ ! -L "$managed_entry" ]');
    expect(script).toContain('mv "$root/current" "$previous"');
    expect(script).toContain('mv "$next" "$root/current"');
    expect(script.indexOf('manager.mjs" --version')).toBeLessThan(script.indexOf(".joko-runtime-ready-v1.tmp"));
    expect(script).toContain('"managerSha256":"');
    expect(script).not.toContain('if [ "$reinstall" != 1 ] && [ -f "$sentinel" ]');
    expect(script).not.toMatch(/\.bashrc|\.zshrc|\.profile/u);
    expect(script).not.toContain("auth.json");
    expect(script).not.toContain("export PATH=");
  });

  it("revokes admission without deleting profiles or processes and confirms the shared probe", async () => {
    const processes = new ScriptedProcesses([
      { stdout: "", exitCode: 0 },
      probeOutput("not_installed", { workspace: "/" })
    ]);
    await expect(uninstallRemoteClaude(processes, () => undefined)).resolves.toMatchObject({ state: "not_installed" });
    const script = processes.requests[0]?.args[1] ?? "";
    expectValidShellSyntax(script);
    expect(script).toContain('rm -f "$root/.joko-runtime-ready-v1"');
    expect(script).toContain('[ ! -L "$lock" ]');
    expect(script).not.toContain('rm -rf "$root"');
    expect(script).not.toMatch(/pkill/u);
  });
});

interface ProcessResult { readonly stdout: string | Buffer; readonly exitCode: number }

class ScriptedProcesses implements RemoteProcessTransportPort {
  readonly requests: RemoteProcessStartRequest[] = [];
  readonly inputs: string[] = [];
  readonly #results: ProcessResult[];

  constructor(results: ProcessResult[]) { this.#results = [...results]; }

  async open(request: RemoteProcessStartRequest): Promise<RemoteProcessHandle> {
    const result = this.#results.shift();
    if (result === undefined) throw new Error("Unexpected remote process request.");
    this.requests.push(request);
    return new FixtureProcess((input) => this.inputs.push(input), result);
  }
}

class FixtureProcess extends EventEmitter implements RemoteProcessHandle {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly pid = 42;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  #input = "";
  #finished = false;

  constructor(onInput: (input: string) => void, result: ProcessResult) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => { this.#input += Buffer.from(chunk).toString("utf8"); callback(); },
      final: (callback) => {
        onInput(this.#input);
        queueMicrotask(() => {
          this.stdout.write(result.stdout);
          this.finish(result.exitCode);
        });
        callback();
      }
    });
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.#finished) return false;
    this.signalCode = typeof signal === "string" ? signal : "SIGTERM";
    this.finish(null);
    return true;
  }

  private finish(code: number | null): void {
    if (this.#finished) return;
    this.#finished = true;
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code, this.signalCode);
  }
}

function probeOutput(
  state: "ready" | "not_installed",
  overrides: {
    readonly workspace?: string;
    readonly sdk?: string;
    readonly cli?: string;
    readonly claudeExecutable?: string;
  } = {}
): ProcessResult {
  const root = "/home/test/.joko/runtime/v1/claude-code";
  return {
    stdout: Buffer.from([
      overrides.workspace ?? "/srv/project-real",
      root,
      `${root}/current/node/bin/node`,
      `${root}/current/manager.mjs`,
      overrides.claudeExecutable
        ?? `${root}/current/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`,
      `${root}/run/manager.sock`,
      overrides.sdk ?? "0.3.259",
      overrides.cli ?? "2.1.259",
      state,
      ""
    ].join("\0"), "utf8"),
    exitCode: 0
  };
}

function expectValidShellSyntax(script: string): void {
  const candidates = process.platform === "win32"
    ? [join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Git", "bin", "sh.exe")]
    : ["/bin/sh"];
  const shell = candidates.find((candidate) => existsSync(candidate));
  if (shell === undefined) return;
  const result = spawnSync(shell, ["-n"], { input: script, encoding: "utf8", windowsHide: true });
  expect(result.status, result.stderr).toBe(0);
}
