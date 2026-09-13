import { describe, expect, it, vi } from "vitest";

import {
  ComputerProcessError,
  type ComputerCommandRequest,
  type ComputerCommandResult,
  type ComputerCommandRunner
} from "./process-runner.js";
import {
  computerDriverReleaseAssetName,
  compareSemver,
  ComputerRuntime,
  ComputerRuntimeActionError
} from "./runtime.js";

describe("ComputerRuntime status", () => {
  it("reports a missing executable without attempting any mutating command", async () => {
    const runner = queuedRunner([
      new ComputerProcessError("spawn", result("", "not found", null))
    ]);
    const runtime = new ComputerRuntime({ platform: "linux", runner });

    await expect(runtime.status()).resolves.toMatchObject({
      installed: false,
      issue: "not_found",
      daemon: { state: "unknown" },
      permissions: { required: false, status: "not_required" }
    });
    expect(argumentsFor(runner)).toEqual([["--version"]]);
  });

  it("discovers version and daemon state on Linux without probing permissions", async () => {
    const runner = queuedRunner([
      result("cua-driver 0.14.3\n"),
      result("status: running\npid: 987\n")
    ]);
    const runtime = new ComputerRuntime({
      platform: "linux",
      architecture: "arm64",
      executablePath: "/runtime/bin/driver",
      runner
    });

    await expect(runtime.status()).resolves.toEqual({
      installed: true,
      executablePath: "/runtime/bin/driver",
      version: "0.14.3",
      platform: {
        platform: "linux",
        architecture: "arm64",
        supported: true,
        permissionsRequired: false,
        installation: "posix"
      },
      daemon: { state: "running", processId: 987 },
      permissions: {
        required: false,
        status: "not_required",
        accessibility: "not_required",
        screenRecording: "not_required",
        liveScreenCapture: "not_required",
        canGrant: false,
        passiveProbe: "not_required"
      }
    });
    expect(argumentsFor(runner)).toEqual([["--version"], ["status"]]);
  });

  it("does not use the macOS permission probe on versions where it may prompt", async () => {
    const runner = queuedRunner([
      result("0.12.1"),
      result("pid: 44")
    ]);
    const runtime = new ComputerRuntime({ platform: "darwin", runner });

    await expect(runtime.status()).resolves.toMatchObject({
      installed: true,
      permissions: {
        status: "unknown",
        passiveProbe: "unsupported_version"
      }
    });
    expect(argumentsFor(runner)).toEqual([["--version"], ["status"]]);
  });

  it("uses the passive macOS permission probe only for a compatible running daemon", async () => {
    const runner = queuedRunner([
      result("driver version 0.12.2"),
      result("pid: 55"),
      result(JSON.stringify({
        ok: true,
        accessibility: true,
        screen_recording: false,
        screen_recording_capturable: true
      }))
    ]);
    const runtime = new ComputerRuntime({ platform: "darwin", runner });

    await expect(runtime.status()).resolves.toMatchObject({
      daemon: { state: "running", processId: 55 },
      permissions: {
        status: "granted",
        accessibility: "granted",
        screenRecording: "missing",
        liveScreenCapture: "granted",
        canGrant: true,
        passiveProbe: "supported"
      }
    });
    expect(argumentsFor(runner)).toEqual([
      ["--version"],
      ["status"],
      ["permissions", "status", "--json"]
    ]);
  });

  it("skips the macOS permission probe while the daemon is stopped", async () => {
    const runner = queuedRunner([result("0.13.0"), result("", "stopped", 1)]);
    const runtime = new ComputerRuntime({ platform: "darwin", runner });

    await expect(runtime.status()).resolves.toMatchObject({
      daemon: { state: "stopped" },
      permissions: { passiveProbe: "daemon_unavailable" }
    });
    expect(argumentsFor(runner)).toEqual([["--version"], ["status"]]);
  });

  it("only attempts the macOS daemon recovery on an explicit fresh probe", async () => {
    const runner = queuedRunner([
      result("0.13.0"),
      result("", "stopped", 1),
      result(),
      result("pid: 82"),
      result('{"ok":true,"accessibility":true,"screen_recording":true}')
    ]);
    const runtime = new ComputerRuntime({ platform: "darwin", runner });

    await expect(runtime.status({ fresh: true })).resolves.toMatchObject({
      daemon: { state: "running", processId: 82 },
      permissions: { status: "granted" }
    });
    expect(runner.run).toHaveBeenNthCalledWith(3, expect.objectContaining({
      command: "open",
      arguments: ["-n", "-g", "-a", "CuaDriver", "--args", "serve", "--no-permissions-gate"]
    }));
  });

  it("restarts an idle bundled macOS daemon before a fresh permission observation", async () => {
    const runner = queuedRunner([
      result("0.13.0"),
      result("pid: 41"),
      result(),
      result("", "stopped", 1),
      result(),
      result("pid: 42"),
      result('{"ok":true,"accessibility":false,"screen_recording":true}')
    ]);
    const runtime = new ComputerRuntime({
      platform: "darwin",
      runner,
      pathExists: (path) => path === "/Applications/CuaDriver.app"
    });

    await expect(runtime.status({ fresh: true })).resolves.toMatchObject({
      daemon: { state: "running", processId: 42 },
      permissions: { accessibility: "missing" }
    });
    expect(argumentsFor(runner)).toEqual([
      ["--version"],
      ["status"],
      ["stop"],
      ["status"],
      ["-n", "-g", "-a", "CuaDriver", "--args", "serve", "--no-permissions-gate"],
      ["status"],
      ["permissions", "status", "--json"]
    ]);
  });

  it("never restarts the macOS daemon while a computer session is active", async () => {
    const runner = queuedRunner([
      result("0.13.0"),
      result("pid: 41"),
      result('{"ok":true,"accessibility":true,"screen_recording":true}')
    ]);
    const runtime = new ComputerRuntime({
      platform: "darwin",
      runner,
      pathExists: (path) => path === "/Applications/CuaDriver.app"
    });
    runtime.retainDriverSession();
    try {
      await runtime.status({ fresh: true });
    } finally {
      runtime.releaseDriverSession();
    }

    expect(argumentsFor(runner)).toEqual([
      ["--version"],
      ["status"],
      ["permissions", "status", "--json"]
    ]);
  });

  it("reuses a denied live-capture result only while the same daemon remains alive", async () => {
    const runner = queuedRunner([
      result("0.13.0"),
      result("pid: 55"),
      result('{"ok":true,"accessibility":true,"screen_recording":true,"screen_recording_capturable":false}'),
      result("0.13.0"),
      result("pid: 55")
    ]);
    const runtime = new ComputerRuntime({ platform: "darwin", runner });

    await runtime.status();
    await runtime.status();

    expect(argumentsFor(runner)).toEqual([
      ["--version"],
      ["status"],
      ["permissions", "status", "--json"],
      ["--version"],
      ["status"]
    ]);
  });
});

describe("ComputerRuntime explicit actions", () => {
  it("uses a bounded one-shot driver call for lightweight state fallback", async () => {
    const runner = queuedRunner([result('{"ok":true,"width":1920,"height":1080}\n')]);
    const runtime = new ComputerRuntime({
      platform: "linux",
      executablePath: "/runtime/bin/driver",
      runner
    });

    await expect(runtime.callCliFallback("get_screen_size")).resolves.toEqual({
      ok: true,
      width: 1920,
      height: 1080
    });
    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({
      command: "/runtime/bin/driver",
      arguments: ["call", "get_screen_size"],
      stdin: "{}\n",
      timeoutMs: 8_000,
      maximumStdoutBytes: 256 * 1024
    }));
  });

  it("rejects malformed or failed one-shot state fallback output", async () => {
    const runtime = new ComputerRuntime({
      platform: "linux",
      runner: queuedRunner([result("not-json"), result('{"ok":false}', "failed", 1)])
    });

    await expect(runtime.callCliFallback("get_cursor_position")).resolves.toBeUndefined();
    await expect(runtime.callCliFallback("get_cursor_position")).resolves.toBeUndefined();
  });

  it("runs an injected install plan only when install is explicitly invoked", async () => {
    const onSpawn = vi.fn();
    const runner = queuedRunner([
      result("installed", "warning"),
      result("0.15.0"),
      result("pid: 12")
    ]);
    const installPlan = vi.fn(() => ({
      command: "/trusted/installer",
      arguments: ["--quiet"]
    }));
    const runtime = new ComputerRuntime({
      platform: "linux",
      executablePath: "/runtime/bin/driver",
      runner,
      installPlan
    });

    const installed = await runtime.install({ timeoutMs: 7_000, onSpawn });

    expect(installPlan).toHaveBeenCalledWith({
      platform: "linux",
      executablePath: "/runtime/bin/driver"
    });
    expect(runner.run).toHaveBeenNthCalledWith(1, expect.objectContaining({
      command: "/trusted/installer",
      arguments: ["--quiet"],
      timeoutMs: 7_000,
      maximumStdoutBytes: 1024 * 1024,
      maximumStderrBytes: 256 * 1024,
      onSpawn
    }));
    expect(installed).toMatchObject({
      stdout: "installed",
      stderr: "warning",
      status: { installed: true, version: "0.15.0" }
    });
  });

  it("injects the host outbound proxy decision into the installer without publishing it", async () => {
    const runner = queuedRunner([
      result("installed"),
      result("0.15.0"),
      result("pid: 12")
    ]);
    const resolveOutboundProxy = vi.fn(async () => "http://127.0.0.1:8899/");
    const runtime = new ComputerRuntime({
      platform: "linux",
      environment: {},
      runner,
      resolveOutboundProxy,
      installPlan: () => ({ command: "/trusted/installer", arguments: [] })
    });

    const installed = await runtime.install();

    expect(resolveOutboundProxy).toHaveBeenCalledWith(
      expect.stringContaining("raw.githubusercontent.com"),
      { signal: undefined }
    );
    expect(runner.run).toHaveBeenNthCalledWith(1, expect.objectContaining({
      extraEnvironment: expect.objectContaining({
        HTTP_PROXY: "http://127.0.0.1:8899/",
        HTTPS_PROXY: "http://127.0.0.1:8899/"
      })
    }));
    expect(JSON.stringify(installed)).not.toContain("127.0.0.1:8899");
  });

  it("maps a host SOCKS verdict to remote-DNS installer proxy variables only", async () => {
    const runner = queuedRunner([
      result("installed"),
      result("0.15.0"),
      result("pid: 12")
    ]);
    const runtime = new ComputerRuntime({
      platform: "linux",
      environment: {},
      runner,
      resolveOutboundProxy: async () => "socks5://127.0.0.1:1080/",
      installPlan: () => ({ command: "/trusted/installer", arguments: [] })
    });

    const installed = await runtime.install();

    expect(runner.run).toHaveBeenNthCalledWith(1, expect.objectContaining({
      extraEnvironment: expect.objectContaining({
        ALL_PROXY: "socks5h://127.0.0.1:1080/",
        all_proxy: "socks5h://127.0.0.1:1080/"
      })
    }));
    const environment = runner.run.mock.calls[0]?.[0]?.extraEnvironment;
    expect(environment).not.toHaveProperty("HTTP_PROXY");
    expect(environment).not.toHaveProperty("HTTPS_PROXY");
    expect(JSON.stringify(installed)).not.toContain("127.0.0.1:1080");
  });

  it("keeps explicit proxy environment authoritative over the host resolver", async () => {
    const runner = queuedRunner([
      result("installed"),
      result("0.15.0"),
      result("pid: 12")
    ]);
    const resolveOutboundProxy = vi.fn(async () => "http://127.0.0.1:9988/");
    const runtime = new ComputerRuntime({
      platform: "linux",
      environment: { HTTPS_PROXY: "http://127.0.0.1:8877" },
      runner,
      resolveOutboundProxy,
      installPlan: () => ({ command: "/trusted/installer", arguments: [] })
    });

    await runtime.install();

    expect(resolveOutboundProxy).not.toHaveBeenCalled();
    expect(runner.run).toHaveBeenNthCalledWith(1, expect.objectContaining({
      extraEnvironment: expect.objectContaining({ HTTPS_PROXY: "http://127.0.0.1:8877/" })
    }));
  });

  it("returns a typed failure with bounded command output metadata", async () => {
    const failure = result("partial", "failed", 9, true, true);
    const runner = queuedRunner([failure]);
    const runtime = new ComputerRuntime({
      platform: "win32",
      runner,
      installPlan: () => ({ command: "installer.exe", arguments: [] })
    });

    try {
      await runtime.install();
      throw new Error("Expected installation to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(ComputerRuntimeActionError);
      expect(error).toMatchObject({ code: "install_failed", result: failure });
    }
    expect(runner.run).toHaveBeenNthCalledWith(1, expect.objectContaining({
      timeoutMs: 30 * 60_000,
      idleTimeoutMs: 30 * 60_000,
      activityPollMs: 2_000,
      killProcessTree: true
    }));
  });

  it("does not run a grant command on platforms that do not require permissions", async () => {
    const grantPlan = vi.fn(() => ({ command: "grant", arguments: [] }));
    const runner = queuedRunner([result("0.15.0"), result("pid: 7")]);
    const runtime = new ComputerRuntime({ platform: "win32", runner, permissionGrantPlan: grantPlan });

    await expect(runtime.grantPermissions()).resolves.toMatchObject({
      stdout: "",
      stderr: "",
      status: { installed: true, permissions: { required: false } }
    });
    expect(grantPlan).not.toHaveBeenCalled();
    expect(argumentsFor(runner)).toEqual([["--version"], ["status"]]);
  });

  it("runs an injected macOS grant plan and re-reads passive status", async () => {
    const runner = queuedRunner([
      result("0.15.0"),
      result("pid: 7"),
      result('{"ok":true,"accessibility":false,"screen_recording":false}'),
      result("grant complete"),
      result("0.15.0"),
      result("pid: 7"),
      result('{"ok":true,"accessibility":true,"screen_recording":true}')
    ]);
    const runtime = new ComputerRuntime({
      platform: "darwin",
      runner,
      permissionGrantPlan: ({ executablePath }) => ({
        command: executablePath,
        arguments: ["consent", "request"]
      })
    });

    await expect(runtime.grantPermissions({ timeoutMs: 9_000 })).resolves.toMatchObject({
      stdout: "grant complete",
      status: { permissions: { status: "granted" } }
    });
    expect(argumentsFor(runner)).toEqual([
      ["--version"],
      ["status"],
      ["permissions", "status", "--json"],
      ["consent", "request"],
      ["--version"],
      ["status"],
      ["permissions", "status", "--json"]
    ]);
    expect(runner.run).toHaveBeenNthCalledWith(4, expect.objectContaining({ timeoutMs: 9_000 }));
  });

  it("reuses an active permission flow and cancellation reaps the owned process", async () => {
    let grantSignal: AbortSignal | undefined;
    const run = vi.fn(async (request: ComputerCommandRequest): Promise<ComputerCommandResult> => {
      const arguments_ = request.arguments ?? [];
      if (arguments_.join(" ") === "consent request") {
        grantSignal = request.signal;
        return await new Promise<ComputerCommandResult>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => {
            reject(new DOMException("Cancelled", "AbortError"));
          }, { once: true });
        });
      }
      if (arguments_[0] === "--version") return result("0.15.0");
      if (arguments_[0] === "status") return result("pid: 7");
      if (arguments_.join(" ") === "permissions status --json") {
        return result('{"ok":true,"accessibility":false,"screen_recording":false,"screen_recording_capturable":false}');
      }
      throw new Error("Unexpected command invocation.");
    });
    const runtime = new ComputerRuntime({
      platform: "darwin",
      runner: { run },
      permissionGrantSettleMs: 0,
      permissionGrantReuseMs: 15_000,
      now: () => 1_000,
      permissionGrantPlan: ({ executablePath }) => ({
        command: executablePath,
        arguments: ["consent", "request"]
      })
    });

    await runtime.grantPermissions();
    await runtime.grantPermissions();

    expect(run.mock.calls.filter(([request]) =>
      (request.arguments ?? []).join(" ") === "consent request")).toHaveLength(1);
    expect(grantSignal?.aborted).toBe(false);
    runtime.cancelPermissionGrant();
    expect(grantSignal?.aborted).toBe(true);
  });

  it("opens only the fixed macOS pane selected by a permission capability", async () => {
    const runner = queuedRunner([result()]);
    const runtime = new ComputerRuntime({ platform: "darwin", runner });

    await runtime.openPermissionSettings("screenRecording");

    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({
      command: "/usr/bin/open",
      arguments: ["x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"],
      timeoutMs: 5_000
    }));
  });

  it("never exposes the macOS settings opener on another service-node platform", async () => {
    const runner = queuedRunner([]);
    const runtime = new ComputerRuntime({ platform: "linux", runner });

    await expect(runtime.openPermissionSettings("accessibility")).rejects.toMatchObject({
      code: "unsupported_platform"
    });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("rejects explicit actions on unsupported platforms", async () => {
    const runner = queuedRunner([]);
    const runtime = new ComputerRuntime({ platform: "aix", runner });

    await expect(runtime.install()).rejects.toMatchObject({
      name: "ComputerRuntimeActionError",
      code: "unsupported_platform"
    });
    expect(runner.run).not.toHaveBeenCalled();
  });
});

describe("compareSemver", () => {
  it("compares stable semantic version cores", () => {
    expect(compareSemver("0.12.1", "0.12.2")).toBe(-1);
    expect(compareSemver("v0.12.2", "0.12.2")).toBe(0);
    expect(compareSemver("1.0.0", "0.99.99")).toBe(1);
  });
});

describe("ComputerRuntime update lifecycle", () => {
  it("quietly verifies a stable tag and current-platform asset, then serves the cached result", async () => {
    const runner = queuedRunner([result("driver 0.12.0")]);
    const fetchImpl = updateFetch("0.13.0", "linux", "x64");
    const runtime = new ComputerRuntime({ platform: "linux", architecture: "x64", runner });

    await expect(runtime.checkForUpdate({ fetchImpl })).resolves.toEqual({
      currentVersion: "0.12.0",
      latestVersion: "0.13.0",
      updateAvailable: true,
      updating: false
    });
    await expect(runtime.checkForUpdate({ fetchImpl })).resolves.toMatchObject({ updateAvailable: true });
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("pins the reverified target through installation and publishes bounded progress phases", async () => {
    const runner = queuedRunner([
      result("driver 0.12.0"),
      result("installed"),
      result("driver 0.13.0"),
      result("pid: 15")
    ]);
    const fetchImpl = updateFetch("0.13.0", "linux", "x64");
    const installPlan = vi.fn(({ targetVersion }: { targetVersion?: string }) => ({
      command: "/trusted/installer",
      arguments: [],
      extraEnvironment: targetVersion === undefined ? undefined : { CUA_DRIVER_RS_VERSION: targetVersion }
    }));
    const progress: string[] = [];
    const runtime = new ComputerRuntime({
      platform: "linux",
      architecture: "x64",
      runner,
      installPlan
    });

    await runtime.checkForUpdate({ fetchImpl });
    await expect(runtime.update({
      fetchImpl,
      onProgress: (event) => progress.push(event.phase)
    })).resolves.toMatchObject({ status: { version: "0.13.0" } });

    expect(installPlan).toHaveBeenCalledWith(expect.objectContaining({ targetVersion: "0.13.0" }));
    expect(runner.run).toHaveBeenNthCalledWith(2, expect.objectContaining({
      command: "/trusted/installer",
      extraEnvironment: expect.objectContaining({ CUA_DRIVER_RS_VERSION: "0.13.0" })
    }));
    expect(progress).toEqual(["downloading", "installing", "done"]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("authenticates catalog requests from bounded GitHub environment without returning the token", async () => {
    const runner = queuedRunner([result("driver 0.12.0")]);
    const fetchImpl = updateFetch("0.13.0", "linux", "x64");
    const runtime = new ComputerRuntime({
      platform: "linux",
      architecture: "x64",
      environment: { GITHUB_TOKEN: "release-catalog-token" },
      runner
    });

    const update = await runtime.checkForUpdate({ fetchImpl });

    for (const [, init] of fetchImpl.mock.calls) {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer release-catalog-token" });
    }
    expect(JSON.stringify(update)).not.toContain("release-catalog-token");
  });

  it("requires a cached verified target before update and never discovers one as a side effect", async () => {
    const runner = queuedRunner([]);
    const fetchImpl = updateFetch("0.13.0", "linux", "x64");
    const runtime = new ComputerRuntime({ platform: "linux", architecture: "x64", runner });

    await expect(runtime.update({ fetchImpl })).rejects.toMatchObject({ code: "no_verified_update" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("maps official release assets for every supported host family", () => {
    expect(computerDriverReleaseAssetName("1.2.3", "darwin", "arm64"))
      .toBe("cua-driver-rs-1.2.3-darwin-universal.tar.gz");
    expect(computerDriverReleaseAssetName("1.2.3", "linux", "aarch64"))
      .toBe("cua-driver-rs-1.2.3-linux-arm64-binary.tar.gz");
    expect(computerDriverReleaseAssetName("1.2.3", "win32", "amd64"))
      .toBe("cua-driver-rs-1.2.3-windows-x86_64.zip");
  });
});

function queuedRunner(
  responses: readonly (ComputerCommandResult | Error)[]
): ComputerCommandRunner & { readonly run: ReturnType<typeof vi.fn> } {
  const queue = [...responses];
  const run = vi.fn(async (_request: ComputerCommandRequest) => {
    _request.onSpawn?.(123);
    const next = queue.shift();
    if (next === undefined) throw new Error("Unexpected command invocation.");
    if (next instanceof Error) throw next;
    return next;
  });
  return { run };
}

function updateFetch(
  version: string,
  platform: NodeJS.Platform,
  architecture: string
): ReturnType<typeof vi.fn<typeof fetch>> {
  const assetName = computerDriverReleaseAssetName(version, platform, architecture);
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.includes("matching-refs")) {
      return new Response(JSON.stringify([{ ref: `refs/tags/cua-driver-rs-v${version}` }]), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({
      tag_name: `cua-driver-rs-v${version}`,
      draft: false,
      assets: [{ name: assetName, state: "uploaded", size: 12_345 }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  });
}

function argumentsFor(runner: ComputerCommandRunner & { readonly run: ReturnType<typeof vi.fn> }): unknown[] {
  return runner.run.mock.calls.map(([request]) => (request as ComputerCommandRequest).arguments ?? []);
}

function result(
  stdout = "",
  stderr = "",
  exitCode: number | null = 0,
  stdoutTruncated = false,
  stderrTruncated = false
): ComputerCommandResult {
  return {
    stdout,
    stderr,
    stdoutTruncated,
    stderrTruncated,
    exitCode,
    signal: null
  };
}
