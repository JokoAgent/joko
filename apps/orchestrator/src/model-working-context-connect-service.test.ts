import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelWorkingContextCoordinator } from "./model-working-context.js";
import { createModelWorkingContextConnectMethods } from "./model-working-context-connect-service.js";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()));
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "joko-working-context-connect-")), store = new OperationalStore(join(directory, "state.sqlite"));
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const connection = store.createConnection({ id: "connection", name: "Device", authKeyDigest: "digest" });
  let authorized = true; const callbacks = new Set<() => void>();
  const authenticate = vi.fn(() => { if (!authorized) throw new ConnectError("Connection revoked.", Code.Unauthenticated); return connection; });
  const refresh = vi.fn(async (_targets: unknown, current: () => void) => { current(); });
  const coordinator = new ModelWorkingContextCoordinator({ store, currentOwner: () => ({ ownerId: "node", generation: 1 }), refresh,
    resolveRoute: () => ({ model: { providerId: "provider", modelId: "model", displayName: "Model", api: "openai-responses", contextWindow: 128000,
      maxOutputTokens: 10000, supportsImages: false, thinkingLevels: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      catalogRevision: 1n, instanceGeneration: 1, supported: true, available: true }) });
  const service = createModelWorkingContextConnectMethods(coordinator, authenticate, () => { if (!authorized) throw new ConnectError("Revoked.", Code.Unauthenticated); },
    (_id, listener) => { callbacks.add(listener); return () => { callbacks.delete(listener); }; });
  const context = { signal: new AbortController().signal } as HandlerContext;
  const target = { backendId: "backend", providerId: "provider", modelId: "model" };
  return { coordinator, service, refresh, context, target, authenticate, callbacks,
    revoke: () => { authorized = false; callbacks.forEach(callback => callback()); } };
}
describe("Model working context Connect owner", () => {
  it("maps typed optional contexts and resets through the authenticated exact CAS owner", async () => {
    const fixture = setup();
    const result = await fixture.service.getModelWorkingContext(create(contract.GetModelWorkingContextRequestSchema, { target: fixture.target }), fixture.context);
    expect(result.context).toMatchObject({ defaultContextWindowTokens: 128000n, customized: false, canConfigure: true });
    const changed = await fixture.service.setModelWorkingContext(create(contract.SetModelWorkingContextRequestSchema, { target: fixture.target,
      operationId: "set", expectedRevision: result.context!.revision, expectedSourceRevision: result.context!.sourceRevision, contextWindowTokens: 256000n }), fixture.context);
    expect(changed.context).toMatchObject({ limitTokens: 256000n, effectiveContextWindowTokens: 256000n });
    const reset = await fixture.service.resetModelWorkingContext(create(contract.ResetModelWorkingContextRequestSchema, { target: fixture.target,
      operationId: "reset", expectedRevision: changed.context!.revision, expectedSourceRevision: changed.context!.sourceRevision }), fixture.context);
    expect(reset.context).toMatchObject({ customized: false, effectiveContextWindowTokens: 128000n }); expect(reset.context?.limitTokens).toBeUndefined();
    expect(fixture.authenticate).toHaveBeenCalledTimes(9); expect(fixture.callbacks.size).toBe(0);
  });
  it("retires credential authority while awaiting native refresh and restores the setting before returning cancellation", async () => {
    const fixture = setup(), view = await fixture.coordinator.read({ target: fixture.target });
    fixture.refresh.mockImplementationOnce(async () => { fixture.revoke(); });
    await expect(fixture.service.setModelWorkingContext(create(contract.SetModelWorkingContextRequestSchema, { target: fixture.target,
      operationId: "cancel", expectedRevision: { value: view.revision }, expectedSourceRevision: view.sourceRevision, contextWindowTokens: 256000n }), fixture.context))
      .rejects.toMatchObject({ code: Code.Canceled });
    expect(await fixture.coordinator.read({ target: fixture.target })).toMatchObject({ customized: false, effectiveContextWindowTokens: 128000 });
    expect(fixture.callbacks.size).toBe(0);
  });
  it("rejects missing CAS and returns a finite failed-apply message without private runtime diagnostics", async () => {
    const fixture = setup(), view = await fixture.coordinator.read({ target: fixture.target });
    await expect(fixture.service.setModelWorkingContext(create(contract.SetModelWorkingContextRequestSchema, { target: fixture.target }), fixture.context)).rejects.toMatchObject({ code: Code.InvalidArgument });
    fixture.refresh.mockImplementationOnce(async () => { throw new Error("C:\\private\\token-proxy"); });
    await expect(fixture.service.setModelWorkingContext(create(contract.SetModelWorkingContextRequestSchema, { target: fixture.target,
      operationId: "failed", expectedRevision: { value: view.revision }, expectedSourceRevision: view.sourceRevision, contextWindowTokens: 64000n }), fixture.context))
      .rejects.toMatchObject({ code: Code.FailedPrecondition, rawMessage: "The model working context could not be applied. Read the current setting before retrying." });
  });
});
