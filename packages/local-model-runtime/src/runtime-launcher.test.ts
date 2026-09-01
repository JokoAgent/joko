import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ChildProcess, spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import { runtimeManifestPath, runtimeRoot } from "./installer.js";
import { LocalRuntimeError } from "./errors.js";
import { OllamaRuntimeLauncher } from "./runtime-launcher.js";

function childProcess() {
  const child = new EventEmitter() as EventEmitter & { killed: boolean; kill: ReturnType<typeof vi.fn> };
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  return child as unknown as ChildProcess;
}

describe("OllamaRuntimeLauncher", () => {
  it("opens an installed macOS application and waits for loopback readiness", async () => {
    let ready = false;
    const openApplication = vi.fn(async () => { ready = true; });
    const launcher = new OllamaRuntimeLauncher({
      client: { version: async () => ready ? "0.14.2" : Promise.reject(new LocalRuntimeError("RUNTIME_UNREACHABLE", "not ready")) },
      dataRoot: "unused",
      platform: "darwin",
      arch: "arm64",
      exists: (path) => path === "/Applications/Ollama.app",
      openApplication,
      sleep: async () => undefined
    });
    const owner = { ownerId: "owner-a", generation: 1 };
    await expect(launcher.start({ owner, currentOwner: () => owner })).resolves.toMatchObject({ state: "ready", source: "application" });
    expect(openApplication).toHaveBeenCalledOnce();
  });

  it("starts a fixed-location CLI with a loopback-only host", async () => {
    let ready = false;
    const child = childProcess();
    const spawnProcess = vi.fn(() => {
      ready = true;
      return child;
    }) as unknown as typeof spawn;
    const launcher = new OllamaRuntimeLauncher({
      client: { version: async () => ready ? "0.14.2" : Promise.reject(new LocalRuntimeError("RUNTIME_UNREACHABLE", "not ready")) },
      dataRoot: "unused",
      platform: "linux",
      arch: "x64",
      exists: (path) => path === "/usr/bin/ollama",
      spawnProcess,
      sleep: async () => undefined
    });
    const owner = { ownerId: "owner-a", generation: 1 };
    await launcher.start({ owner, currentOwner: () => owner });
    expect(spawnProcess).toHaveBeenCalledWith("/usr/bin/ollama", ["serve"], expect.objectContaining({
      windowsHide: true,
      env: expect.objectContaining({ OLLAMA_HOST: "127.0.0.1:11434" })
    }));
  });

  it("discovers and starts a verified managed sidecar", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "joko-runtime-launch-"));
    const root = runtimeRoot(dataRoot);
    const binary = join(root, "v1.2.3", "ollama");
    await mkdir(join(root, "v1.2.3"), { recursive: true });
    await writeFile(binary, "binary");
    await writeFile(runtimeManifestPath(dataRoot), JSON.stringify({
      format: 1,
      version: "1.2.3",
      binaryRelativePath: relative(root, binary),
      archiveSha256: "ab".repeat(32)
    }));
    let ready = false;
    const spawnProcess = vi.fn(() => {
      ready = true;
      return childProcess();
    }) as unknown as typeof spawn;
    const launcher = new OllamaRuntimeLauncher({
      client: { version: async () => ready ? "1.2.3" : Promise.reject(new LocalRuntimeError("RUNTIME_UNREACHABLE", "not ready")) },
      dataRoot,
      platform: "linux",
      arch: "x64",
      exists: () => false,
      spawnProcess,
      sleep: async () => undefined
    });
    const owner = { ownerId: "owner-a", generation: 1 };
    await launcher.start({ owner, currentOwner: () => owner });
    expect(spawnProcess).toHaveBeenCalledWith(binary, ["serve"], expect.objectContaining({
      env: expect.objectContaining({ OLLAMA_HOST: "127.0.0.1:11434", OLLAMA_MODELS: join(root, "models") })
    }));
  });

  it("kills only its managed child when the owner generation changes", async () => {
    let activeOwner = { ownerId: "owner-a", generation: 1 };
    const child = childProcess();
    const launcher = new OllamaRuntimeLauncher({
      client: { version: async () => Promise.reject(new LocalRuntimeError("RUNTIME_UNREACHABLE", "not ready")) },
      dataRoot: "unused",
      platform: "linux",
      arch: "x64",
      exists: (path) => path === "/usr/bin/ollama",
      spawnProcess: (() => child) as typeof spawn,
      sleep: async () => { activeOwner = { ownerId: "owner-a", generation: 2 }; }
    });
    await expect(launcher.start({ owner: { ownerId: "owner-a", generation: 1 }, currentOwner: () => activeOwner })).rejects.toMatchObject({ code: "OWNER_CHANGED" });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
