import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "./test-paths.js";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

const fixtureRoot = mkdtempSync(join(tmpdir(), "joko-orchestrator-config-"));
const workspaceRoot = join(fixtureRoot, "workspace");
const dataDirectory = join(fixtureRoot, "orchestrator-data");
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const explicitCodexExecutable = join(fixtureRoot, "codex.exe");
mkdirSync(workspaceRoot, { recursive: true });
writeFileSync(explicitCodexExecutable, "", { flag: "wx" });

afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

const base = {
  JOKO_BROWSER_ENABLED: "0",
  JOKO_ALLOW_INSECURE_LOOPBACK: "1",
  JOKO_DATA_DIR: dataDirectory,
  JOKO_WORKSPACE_ROOT: workspaceRoot
} satisfies NodeJS.ProcessEnv;

describe("Orchestrator network configuration", () => {
  it("keeps insecure loopback behind its existing explicit flag", () => {
    expect(() => loadConfig({ ...base, JOKO_ALLOW_INSECURE_LOOPBACK: "0" })).toThrow(/TLS is required/u);
    expect(loadConfig(base)).toMatchObject({
      host: "127.0.0.1",
      publicOrigin: "http://127.0.0.1:4318",
      internalOrigin: "http://127.0.0.1:4317",
      allowInsecureLoopback: true
    });
  });

  it("allows private-LAN HTTP only with JOKO_ALLOW_INSECURE_LAN=1", () => {
    const lan = {
      ...base,
      JOKO_HOST: "192.168.20.10",
      JOKO_ALLOW_INSECURE_LAN: "1"
    };
    expect(loadConfig(lan)).toMatchObject({
      publicOrigin: "http://192.168.20.10:4318",
      internalOrigin: "http://127.0.0.1:4317",
      allowInsecureLan: true
    });
    expect(() => loadConfig({ ...lan, JOKO_ALLOW_INSECURE_LAN: "0" })).toThrow(/TLS is required/u);
  });

  it("requires an explicit reachable public origin for wildcard binds", () => {
    const wildcard = {
      ...base,
      JOKO_HOST: "0.0.0.0",
      JOKO_ALLOW_INSECURE_LAN: "1"
    };
    expect(() => loadConfig(wildcard)).toThrow(/JOKO_PUBLIC_ORIGIN is required/u);
    expect(loadConfig({ ...wildcard, JOKO_PUBLIC_ORIGIN: "http://192.168.20.10:4318" })).toMatchObject({
      publicOrigin: "http://192.168.20.10:4318",
      internalOrigin: "http://127.0.0.1:4317"
    });
  });

  it("rejects public HTTP, credentials, paths, queries, and wildcard advertised origins", () => {
    const lan = {
      ...base,
      JOKO_HOST: "0.0.0.0",
      JOKO_ALLOW_INSECURE_LAN: "1"
    };
    for (const publicOrigin of [
      "http://example.com:4318",
      "http://user:pass@192.168.1.2:4318",
      "http://169.254.169.254:4318",
      "http://metadata:4318",
      "http://3232235778:4318",
      "http://192.168.1.2:4318/path",
      "http://192.168.1.2:4318?query=1",
      "http://0.0.0.0:4318"
    ]) expect(() => loadConfig({ ...lan, JOKO_PUBLIC_ORIGIN: publicOrigin })).toThrow();
  });

  it("accepts only loopback or explicitly-enabled private HTTP CORS origins", () => {
    expect(loadConfig({ ...base, JOKO_CORS_ORIGINS: "http://localhost:4319" }).corsOrigins)
      .toEqual(["http://localhost:4319"]);
    expect(() => loadConfig({ ...base, JOKO_CORS_ORIGINS: "http://192.168.1.30:4319" }))
      .toThrow(/JOKO_ALLOW_INSECURE_LAN/u);
    expect(loadConfig({
      ...base,
      JOKO_ALLOW_INSECURE_LAN: "1",
      JOKO_CORS_ORIGINS: "http://192.168.1.30:4319"
    }).corsOrigins).toEqual(["http://192.168.1.30:4319"]);
    expect(() => loadConfig({
      ...base,
      JOKO_ALLOW_INSECURE_LAN: "1",
      JOKO_CORS_ORIGINS: "http://example.com:4319"
    })).toThrow(/public HTTP origin/u);
  });

  it("enables LAN discovery by default and supports an explicit off switch", () => {
    expect(loadConfig(base).lanDiscoveryEnabled).toBe(true);
    expect(loadConfig({ ...base, JOKO_LAN_DISCOVERY: "0" }).lanDiscoveryEnabled).toBe(false);
  });

  it("reserves a distinct loopback-only internal bridge port", () => {
    expect(loadConfig(base)).toMatchObject({ internalPort: 4317, internalOrigin: "http://127.0.0.1:4317" });
    expect(() => loadConfig({ ...base, JOKO_INTERNAL_PORT: "4318" })).toThrow(/must differ/u);
    expect(() => loadConfig({ ...base, JOKO_INTERNAL_PORT: "0" })).toThrow(/valid TCP port/u);
  });

  it("keeps native coding runtime executable overrides private to service configuration", () => {
    expect(loadConfig({
      ...base,
      JOKO_CODEX_EXECUTABLE: explicitCodexExecutable,
      JOKO_CLAUDE_CODE_EXECUTABLE: "D:/tools/claude.exe"
    })).toMatchObject({
      codexExecutable: realpathSync.native(explicitCodexExecutable),
      claudeCodeExecutable: "D:/tools/claude.exe"
    });
  });

  it("canonicalizes a default-scheme port without rejecting its own origin", () => {
    expect(loadConfig({ ...base, JOKO_PORT: "80", JOKO_INTERNAL_PORT: "81" }).publicOrigin)
      .toBe("http://127.0.0.1");
  });

  it("defaults to an absolute OS user-data directory outside the workspace and source tree", () => {
    const config = loadConfig({ ...base, JOKO_DATA_DIR: undefined });
    expect(isAbsolute(config.dataDirectory)).toBe(true);
    expect(isContainedBy(workspaceRoot, config.dataDirectory)).toBe(false);
    expect(isContainedBy(sourceRoot, config.dataDirectory)).toBe(false);
  });

  it("rejects a normalized data directory inside the configured workspace", () => {
    expect(() => loadConfig({
      ...base,
      JOKO_DATA_DIR: join(workspaceRoot, "nested", "..", ".joko-data")
    })).toThrow(/outside the configured workspace/u);
  });

  it("rejects a linked data directory that resolves inside the configured workspace", () => {
    const linkedWorkspace = join(fixtureRoot, "linked-workspace");
    symlinkSync(workspaceRoot, linkedWorkspace, process.platform === "win32" ? "junction" : "dir");
    expect(() => loadConfig({
      ...base,
      JOKO_DATA_DIR: join(linkedWorkspace, ".joko-data")
    })).toThrow(/outside the configured workspace/u);
  });

  it("rejects a data directory inside the Joko source tree even when serving another workspace", () => {
    expect(() => loadConfig({
      ...base,
      JOKO_DATA_DIR: resolve(sourceRoot, ".runtime", "unsafe-orchestrator-data")
    })).toThrow(/outside the Joko source tree/u);
  });
});

function isContainedBy(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith("../") && !child.startsWith("..\\") && !isAbsolute(child));
}
