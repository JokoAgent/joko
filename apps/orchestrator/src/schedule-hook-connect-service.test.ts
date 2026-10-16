import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "./test-paths.js";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { SessionHost } from "./session-host.js";
import { createScheduleHookConnectMethods } from "./schedule-hook-connect-service.js";
import { ScheduleHookScriptInstaller, scheduleHookScriptCommand } from "./schedule-hook-script-installer.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const context = () => ({ signal: new AbortController().signal }) as HandlerContext;
describe("Schedule hook management owner", () => {
  it("persists preparation before self-test and replays the exact typed receipt without re-execution", async () => {
    const f = fixture(); const install = vi.spyOn(f.installer, "install");
    const request = create(contract.PrepareScheduleHookRequestSchema, { operationId: "prepare-check-one", context: f.scope,
      source: { case: "script", value: "console.log('checked'); process.exit(2)" } });
    const first = await f.api.prepareScheduleHook!(request, context());
    expect(first.test).toMatchObject({ status: "skipped", exitCode: 2 });
    expect(f.store.getOperation(request.operationId)).toMatchObject({ status: "completed", completionMode: "external_effect", connectionId: f.connection.id });
    const replay = await f.api.prepareScheduleHook!(request, context());
    expect(replay).toEqual(first); expect(install).toHaveBeenCalledOnce();
    const recovered = await f.api.getScheduleHookOperation!(create(contract.GetScheduleHookOperationRequestSchema, { operationId: request.operationId }), context());
    expect(recovered.result).toEqual({ case: "preparation", value: first });
    await expect(f.api.prepareScheduleHook!(create(contract.PrepareScheduleHookRequestSchema, { ...request, source: { case: "script", value: "process.exit(0)" } }), context())).rejects.toBeDefined();
    expect(install).toHaveBeenCalledOnce();
  });
  it("prepares an independent edit and preserves the saved script until the user saves", async () => {
    const f = fixture();
    const original = await f.installer.install({ backendId: "backend", workspaceRoot: f.root, script: "process.exit(0)", scheduleName: "Saved" });
    const changed = await f.api.prepareScheduleHook!(create(contract.PrepareScheduleHookRequestSchema, { operationId: "prepare-check-edit", context: f.scope,
      currentHook: { command: original.command, filePath: original.filePath }, source: { case: "description", value: "Skip when idle" } }), context());
    expect(changed.hook?.filePath).not.toBe(original.filePath); expect(changed.test?.status).toBe("skipped");
    expect(readFileSync(original.filePath, "utf8")).toBe("process.exit(0)\n");
  });
  it("executes a manual check once, returns timeout results, and fences unknown restart receipts", async () => {
    const f = fixture(); const marker = join(f.root, "count.txt"), path = join(f.root, "manual.mjs");
    writeFileSync(path, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(marker)}, 'x'); process.exit(0);`);
    const request = create(contract.TestScheduleHookRequestSchema, { operationId: "test-check-once", context: f.scope,
      hook: { command: scheduleHookScriptCommand(path), filePath: "" } });
    expect((await f.api.testScheduleHook!(request, context())).result?.status).toBe("passed");
    await f.api.testScheduleHook!(request, context()); expect(readFileSync(marker, "utf8")).toBe("x");
    const unresolved = "test-check-unknown";
    f.store.claimAuthorizedDeferredEffectOperation(f.connection.id, f.connection.authKeyDigest, { id: unresolved, kind: "testScheduleHook", body: { request: "original" } });
    await expect(f.api.testScheduleHook!(create(contract.TestScheduleHookRequestSchema, { ...request, operationId: unresolved }), context())).rejects.toBeDefined();
    expect(readFileSync(marker, "utf8")).toBe("x");
    const pending = await f.api.getScheduleHookOperation!(create(contract.GetScheduleHookOperationRequestSchema, { operationId: unresolved }), context());
    expect(pending.operation?.state).toBe(contract.OperationState.RUNNING);
    f.store.recoverStartup();
    const recovered = await f.api.getScheduleHookOperation!(create(contract.GetScheduleHookOperationRequestSchema, { operationId: unresolved }), context());
    expect(recovered.operation?.state).toBe(contract.OperationState.FAILED);
    await expect(f.api.testScheduleHook!(create(contract.TestScheduleHookRequestSchema, { ...request, operationId: unresolved }), context())).rejects.toBeDefined();
    expect(readFileSync(marker, "utf8")).toBe("x");
    writeFileSync(path, "setInterval(() => {}, 1000)");
    const timed = await f.api.testScheduleHook!(create(contract.TestScheduleHookRequestSchema, { ...request, operationId: "test-check-timeout", hook: { ...request.hook!, timeout: { $typeName: "google.protobuf.Duration", seconds: 0n, nanos: 30_000_000 } } }), context());
    expect(timed.result).toMatchObject({ status: "timed_out", decision: "block" });
  });
  it("rejects changed owners before generated bytes are installed and prevents path expansion", async () => {
    let finish!: (value: string) => void;
    const installer = new ScheduleHookScriptInstaller({ generate: () => new Promise(resolve => { finish = resolve; }) });
    const f = fixture(installer); const pending = f.api.prepareScheduleHook!(create(contract.PrepareScheduleHookRequestSchema, { operationId: "prepare-check-retired", context: f.scope,
      source: { case: "description", value: "Run if needed" } }), context());
    await vi.waitFor(() => expect(finish).toBeTypeOf("function")); f.retire(); finish("process.exit(0)");
    await expect(pending).rejects.toBeDefined(); expect(f.store.getOperation("prepare-check-retired").status).toBe("failed");
    const active = fixture(); writeFileSync(join(active.root, "check.mjs"), "process.exit(0)");
    const picked = await active.api.prepareScheduleHook!(create(contract.PrepareScheduleHookRequestSchema, { context: active.scope, source: { case: "workspaceFile", value: "check.mjs" } }), context());
    expect(picked.hook?.command).toBe(scheduleHookScriptCommand(join(active.root, "check.mjs")));
    await expect(active.api.prepareScheduleHook!(create(contract.PrepareScheduleHookRequestSchema, { context: active.scope, source: { case: "workspaceFile", value: "../outside.mjs" } }), context())).rejects.toBeDefined();
    if (process.platform === "win32") { writeFileSync(join(active.root, "%EXPANDED%.mjs"), "process.exit(0)");
      await expect(active.api.prepareScheduleHook!(create(contract.PrepareScheduleHookRequestSchema, { context: active.scope, source: { case: "workspaceFile", value: "%EXPANDED%.mjs" } }), context())).rejects.toMatchObject({ code: Code.InvalidArgument }); }
  });
});

function fixture(installer = new ScheduleHookScriptInstaller({ generate: async () => "process.exit(2)" })) {
  const root = mkdtempSync(join(tmpdir(), "joko-schedule-hooks-")); const store = new OperationalStore(":memory:");
  store.upsertBackend({ id: "backend", displayName: "Backend", version: "test", health: "healthy", adapterKind: "fixture", instanceGeneration: 0,
    installationState: "installed", authenticationState: "authenticated", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "target", backendId: "backend", displayName: "Workspace", workspaceRoot: root, trusted: true, managed: false });
  const connection = store.createConnection({ id: "connection", name: "Owner", authKeyDigest: "digest" });
  const artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root] });
  mkdirSync(join(root, "artifacts")); const host = new SessionHost(store, artifacts, []);
  let active = true;
  const api = createScheduleHookConnectMethods({ store, installer, sessionHost: host, authenticate: () => {
    if (!active) throw new ConnectError("Owner retired", Code.PermissionDenied); return connection;
  } });
  cleanup.push(async () => { await host.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, connection, installer, api, retire: () => { active = false; }, scope: create(contract.ScheduleHookContextSchema, { targetId: "target", backendId: "backend", scheduleName: "Check" }) };
}
