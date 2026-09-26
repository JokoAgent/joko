import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import ts from "typescript";
import { describe, expect, it } from "vitest";
import { loadClaudeRemoteManagerSource } from "./remote-manager-source.js";

const execute = promisify(execFile);

describe("remote Claude manager bundle", () => {
  it("loads deterministic source and built inputs into equivalent bounded executable modules", async () => {
    const packageSource = dirname(fileURLToPath(import.meta.url));
    const root = await mkdtemp(join(packageSource, ".manager-bundle-test-"));
    try {
      const remoteManagerRoot = join(root, "remote-manager");
      await mkdir(remoteManagerRoot);
      const managerTypescript = await readFile(join(packageSource, "remote-manager", "manager.mts"), "utf8");
      const storeTypescript = await readFile(join(packageSource, "claude-session-store.ts"), "utf8");
      await Promise.all([
        writeFile(join(remoteManagerRoot, "manager.mts"), managerTypescript),
        writeFile(join(root, "claude-session-store.ts"), storeTypescript),
        writeFile(join(remoteManagerRoot, "manager.mjs"), transpile(managerTypescript, "manager.mts")),
        writeFile(join(root, "claude-session-store.js"), transpile(storeTypescript, "claude-session-store.ts"))
      ]);
      const moduleUrl = pathToFileURL(join(root, "remote-manager-source.js"));
      const [source, repeatedSource, built, repeatedBuilt] = await Promise.all([
        loadClaudeRemoteManagerSource("source", moduleUrl),
        loadClaudeRemoteManagerSource("source", moduleUrl),
        loadClaudeRemoteManagerSource("compiled", moduleUrl),
        loadClaudeRemoteManagerSource("compiled", moduleUrl)
      ]);
      expect(source).toEqual(repeatedSource);
      expect(built).toEqual(repeatedBuilt);
      for (const bundle of [source, built]) {
        expect(bundle.byteLength).toBeGreaterThan(1_024);
        expect(bundle.byteLength).toBeLessThanOrEqual(512 * 1_024);
        expect(bundle.toString("utf8")).not.toContain(root);
      }
      const [sourceIdentity, builtIdentity] = await Promise.all([
        executeBundle(root, "source-manager.mjs", source),
        executeBundle(root, "built-manager.mjs", built)
      ]);
      expect(sourceIdentity).toMatchObject({ managerVersion: "2.0.0", protocolVersion: 2 });
      expect(builtIdentity).toMatchObject({ managerVersion: "2.0.0", protocolVersion: 2 });
      expect(sourceIdentity.managerSha256).toBe(createHash("sha256").update(source).digest("hex"));
      expect(builtIdentity.managerSha256).toBe(createHash("sha256").update(built).digest("hex"));
      await unlink(join(root, "claude-session-store.js"));
      await expect(loadClaudeRemoteManagerSource("compiled", moduleUrl)).rejects.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function transpile(source: string, fileName: string): string {
  return ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
      sourceMap: false
    }
  }).outputText;
}

async function executeBundle(
  root: string,
  name: string,
  source: Buffer
): Promise<{ readonly managerVersion: string; readonly protocolVersion: number; readonly managerSha256: string }> {
  const modulePath = join(root, name);
  await writeFile(modulePath, source, { mode: 0o600 });
  const result = await execute(process.execPath, [modulePath, "--version"], {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 64 * 1_024
  });
  expect(result.stderr).toBe("");
  await exerciseEmbeddedStore(modulePath, join(root, `${name}-store`));
  return JSON.parse(result.stdout.trim()) as {
    readonly managerVersion: string;
    readonly protocolVersion: number;
    readonly managerSha256: string;
  };
}

async function exerciseEmbeddedStore(modulePath: string, storeRoot: string): Promise<void> {
  const manager = await import(`${pathToFileURL(modulePath).href}?store=${randomSuffix()}`) as {
    createManagerState(sdk: unknown, options: Record<string, unknown>): unknown;
    ManagerConnection: new (socket: unknown, state: unknown) => {
      handle(message: Record<string, unknown>): Promise<void>;
    };
  };
  const frames: Array<Record<string, unknown>> = [];
  const socket = {
    on: () => socket,
    once: () => socket,
    write: (bytes: Buffer, callback: (error?: Error) => void) => {
      frames.push(JSON.parse(bytes.toString("utf8")) as Record<string, unknown>);
      callback();
      return true;
    },
    destroy: () => undefined
  };
  const state = manager.createManagerState({}, { sessionStoreRootDirectory: storeRoot });
  const connection = new manager.ManagerConnection(socket, state);
  await connection.handle({
    v: 2,
    kind: "request",
    id: "embedded-store",
    method: "store.prepareImport",
    params: {
      authority: { schemaVersion: 1, namespace: `backend-${"c".repeat(64)}`, generation: 1 },
      input: {
        operationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        sourceWorkspaceAuthority: "workspace-source",
        sourceSessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        targetWorkspaceAuthority: "workspace-target"
      }
    }
  });
  expect(frames).toEqual([expect.objectContaining({
    v: 2,
    kind: "response",
    id: "embedded-store",
    ok: true,
    value: expect.objectContaining({ kind: "operation", operationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" })
  })]);
}

function randomSuffix(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
