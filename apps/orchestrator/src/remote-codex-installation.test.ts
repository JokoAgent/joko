import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { RemoteProcessHandle, RemoteProcessStartRequest, RemoteProcessTransportPort } from "@joko/remote-ssh";
import { describe, expect, it } from "vitest";

import {
  installRemoteCodex,
  probeRemoteCodexInstallation,
  uninstallRemoteCodex
} from "./remote-codex-installation.js";

describe("remote Codex installation", () => {
  it("requires the Joko sentinel, managed standalone layout, and exact fixed version", async () => {
    const processes = new ScriptedProcesses([probeOutput("ready", "codex-cli 0.153.4")]);
    await expect(probeRemoteCodexInstallation(processes, "/srv/project", () => undefined)).resolves.toMatchObject({
      state: "ready",
      workspaceRoot: "/srv/project-real",
      profileRoot: "/home/test/.joko/runtime/v1/codex-home",
      installedVersion: "0.153.4"
    });
    expect(processes.requests[0]).toMatchObject({ executable: "/bin/sh", cwd: "/srv/project", args: ["-c", expect.stringContaining(".joko-runtime-ready-v1")] });

    const missing = new ScriptedProcesses([probeOutput("not_installed", "codex-cli 9.9.9")]);
    await expect(probeRemoteCodexInstallation(missing, "/", () => undefined)).resolves.toMatchObject({ state: "not_installed", installedVersion: "9.9.9" });
  });

  it("uses only the fixed release and a staged managed HOME while streaming bounded phases", async () => {
    const processes = new ScriptedProcesses([
      { stdout: "JOKO_PHASE probing\nJOKO_PHASE downloading\nJOKO_PHASE installing\nJOKO_PHASE validating\nJOKO_PHASE complete\n", exitCode: 0 },
      probeOutput("ready", "codex-cli 0.153.4")
    ]);
    const phases: string[] = [];
    await expect(installRemoteCodex(processes, {
      reinstall: true,
      assertCurrent: () => undefined,
      onPhase: (phase) => phases.push(phase)
    })).resolves.toMatchObject({ state: "ready" });
    expect(phases).toEqual(["probing", "downloading", "installing", "validating", "complete"]);
    const script = processes.inputs[0] ?? "";
    expect(script).toContain("rust-v0.153.4/install.sh");
    expect(script).toContain("HOME=\"$stage/home\"");
    expect(script).toContain("CODEX_NON_INTERACTIVE=1");
    expect(script).toContain(".joko-install-lock");
    expect(script).toContain('mv "$stage/codex-home/packages" "$next"');
    expect(script).toContain('mv "$profile/packages" "$previous"');
    expect(script).toContain('if [ "$new_moved" -eq 1 ]; then rm -rf "$profile/packages"; fi');
    expect(script).toContain('if [ "$old_moved" -eq 1 ] && [ -e "$previous" ]; then mv "$previous" "$profile/packages"');
    const finalValidation = script.indexOf('= "codex-cli 0.153.4" ] || exit 47');
    const sentinelCommit = script.indexOf(".joko-runtime-ready-v1.tmp");
    expect(finalValidation).toBeGreaterThan(-1);
    expect(sentinelCommit).toBeGreaterThan(finalValidation);
    expect(script).not.toContain("auth.json");
    expect(script).not.toMatch(/\.bashrc|\.zshrc|\.profile/u);
    expect(script).not.toContain("export PATH=");
  });

  it("uninstalls only the admission sentinel and confirms the result with the shared probe", async () => {
    const processes = new ScriptedProcesses([
      { stdout: "", exitCode: 0 },
      probeOutput("not_installed", "codex-cli 0.153.4")
    ]);
    await expect(uninstallRemoteCodex(processes, () => undefined)).resolves.toMatchObject({ state: "not_installed" });
    const script = processes.requests[0]?.args[1] ?? "";
    expect(script).toContain("rm -f \"$sentinel\"");
    expect(script).not.toContain("rm -rf \"$profile\"");
    expect(script).not.toMatch(/kill|pkill/u);
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
    const process = new FixtureProcess((input) => this.inputs.push(input), result);
    return process;
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

function probeOutput(state: "ready" | "not_installed", version: string): ProcessResult {
  return {
    stdout: Buffer.from([
      "/srv/project-real",
      "/home/test/.joko/runtime/v1/codex-home",
      "/home/test/.joko/runtime/v1/codex-home/packages/standalone/current/codex",
      version,
      state,
      ""
    ].join("\0"), "utf8"),
    exitCode: 0
  };
}
