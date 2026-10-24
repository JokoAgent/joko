import { EventEmitter } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationalStore } from "@joko/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), execFile: mocked.execFile }));

import { isolatedProcessEnvironment } from "./resource-acquisition.js";
import { executeSourceGit } from "./source-git-executor.js";
import { ExtensionSourceManager } from "./extension-source-manager.js";
import { SkillMarketManager } from "./skill-market-manager.js";

type GitOptions = { readonly env: NodeJS.ProcessEnv; readonly cwd: string; readonly signal?: AbortSignal; readonly timeout: number; readonly windowsHide: boolean };
type GitCallback = (error: Error | null, stdout: string, stderr: string) => void;
beforeEach(() => { mocked.execFile.mockReset(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("source Git credential isolation", () => {
  it("replaces account config, agent and injected Git configuration with a private public-acquisition environment", () => {
    const home = join(tmpdir(), "joko-isolated-account");
    const env = isolatedProcessEnvironment(home, { PATH: "/runtime", HOME: "/private-user", USERPROFILE: "C:/private-user", XDG_CONFIG_HOME: "/private-config",
      SSH_AUTH_SOCK: "/agent", SSH_AGENT_PID: "123", GIT_SSH: "private-ssh", GIT_SSH_COMMAND: "private-command", GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: "Authorization: private-token", GIT_CONFIG: "/private-git",
      GIT_CONFIG_GLOBAL: "/private-config", GIT_CONFIG_SYSTEM: "/private-system", NODE_OPTIONS: "--require private-code", PROVIDER_PROXY_KEY: "private-provider-token" });
    expect(env).toMatchObject({ HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), PATH: "/runtime", GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "", GIT_CONFIG_KEY_1: "core.hooksPath", GIT_TERMINAL_PROMPT: "0" });
    for (const key of ["SSH_AUTH_SOCK", "SSH_AGENT_PID", "GIT_SSH", "GIT_CONFIG", "NODE_OPTIONS", "PROVIDER_PROXY_KEY"]) expect(env[key]).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain("Authorization: private-token");
    expect(JSON.stringify(env)).not.toContain("private-provider-token");
    expect(env.GIT_CONFIG_GLOBAL).toBe(process.platform === "win32" ? "NUL" : "/dev/null");
    expect(env.GIT_CONFIG_SYSTEM).toBe(env.GIT_CONFIG_GLOBAL);
    for (const option of ["IdentityAgent=none", "IdentityFile=none", "IdentitiesOnly=yes", "BatchMode=yes", "PasswordAuthentication=no", "KbdInteractiveAuthentication=no", "PreferredAuthentications=none"]) {
      expect(env.GIT_SSH_COMMAND).toContain(option);
    }
  });

  it.each(["success", "failure"] as const)("cleans the private Git HOME after child %s", async outcome => {
    let options!: GitOptions;
    mocked.execFile.mockImplementation((_command: string, _args: readonly string[], received: GitOptions, callback: GitCallback) => {
      options = received; const child = new EventEmitter();
      setImmediate(() => { callback(outcome === "success" ? null : new Error("Git failed"), "git version 2.50.0", ""); child.emit("close", outcome === "success" ? 0 : 1); });
      return child;
    });
    const pending = executeSourceGit(["--version"], { timeoutMs: 10_000 });
    if (outcome === "success") await expect(pending).resolves.toMatchObject({ stdout: "git version 2.50.0" });
    else await expect(pending).rejects.toThrow("Git failed");
    expect(options.cwd).toBe(options.env.HOME); expect(options.windowsHide).toBe(true); expect(options.timeout).toBe(10_000);
    await expect(stat(options.env.HOME!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(mocked.execFile.mock.calls[0]?.[1]).toContain("credential.helper=");
  });

  it("waits for the original child to close before cleaning an aborted acquisition", async () => {
    let entered!: () => void, options!: GitOptions, callback!: GitCallback;
    const started = new Promise<void>(resolve => { entered = resolve; }), child = new EventEmitter();
    mocked.execFile.mockImplementation((_command: string, _args: readonly string[], received: GitOptions, accept: GitCallback) => {
      options = received; callback = accept; entered(); return child;
    });
    const controller = new AbortController(), pending = executeSourceGit(["clone", "https://example.test/public.git", "/destination"], { timeoutMs: 10_000, signal: controller.signal });
    await started; controller.abort(); callback(new DOMException("Cancelled", "AbortError"), "", "");
    expect((await stat(options.env.HOME!)).isDirectory()).toBe(true);
    child.emit("close", null, "SIGTERM");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(stat(options.env.HOME!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses the same isolated executor in both production catalog owners", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-source-git-owners-")), store = new OperationalStore(":memory:");
    const environments: NodeJS.ProcessEnv[] = [];
    vi.stubEnv("GIT_CONFIG_COUNT", "1"); vi.stubEnv("GIT_CONFIG_KEY_0", "http.extraHeader"); vi.stubEnv("GIT_CONFIG_VALUE_0", "Authorization: private-token");
    vi.stubEnv("SSH_AUTH_SOCK", "/private-agent");
    mocked.execFile.mockImplementation((_command: string, _args: readonly string[], options: GitOptions, callback: GitCallback) => {
      environments.push(options.env); const child = new EventEmitter();
      setImmediate(() => { callback(null, "git version 2.50.0", ""); child.emit("close", 0); }); return child;
    });
    try {
      const extensions = new ExtensionSourceManager({ store, cacheRoot: join(root, "extensions") });
      const skills = new SkillMarketManager({ store, cacheRoot: join(root, "skills") });
      await extensions.initialize(); await skills.initialize();
      expect((await extensions.gitPreflight()).available).toBe(true); expect((await skills.gitPreflight()).available).toBe(true);
      expect(environments).toHaveLength(2);
      for (const env of environments) {
        expect(env.GIT_CONFIG_KEY_0).toBe("credential.helper"); expect(env.SSH_AUTH_SOCK).toBeUndefined();
        await expect(stat(env.HOME!)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });
});
