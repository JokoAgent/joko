import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { ClaudeCodeAdapter } from "@joko/adapter-claude-code";
import { DefaultClaudeSdkRuntime } from "@joko/adapter-claude-code/testing";
import { createDefaultManagedProcessSupervisor } from "@joko/adapter-pi";
import { NativeNavigationTargetSchema, OperationMutationSchema, OperationState } from "@joko/contracts";
import { expect, it } from "vitest";
import { OrchestratorE2eFixture } from "./fixture.js";
import { createSessionMutation, deleteMutation, navigateMutation, sessionIdFrom, submit } from "./operations.js";

const enabled = process.env.JOKO_CLAUDE_CODE_REAL_PROBE === "1"
  && process.env.JOKO_CLAUDE_CODE_REAL_PROBE_ACK === "local-process-without-turn-approved";
const backendId = "claude-code";

it.skipIf(!enabled)("keeps an unconsumed real SDK start replacement across service restart and exact deletion", { timeout: 180_000 }, async (test) => {
  const root = await mkdtemp(join(tmpdir(), "joko-claude-empty-real-"));
  let fixture: OrchestratorE2eFixture | undefined;
  try {
    let started = await start(root);
    fixture = started.fixture;
    const paired = await fixture.pair();
    const descriptor = fixture.application.store.getBackend(backendId).descriptor;
    expect(descriptor).toMatchObject({ installationState: "installed", health: "healthy" });
    expect(descriptor.capabilities.get("session.rewind_to_start")).toMatchObject({ supported: true });
    if (descriptor.authenticationState !== "authenticated" && descriptor.authenticationState !== "not_required") {
      test.skip("A Provider admitted by the real service is required; SDK readiness alone does not authorize Session creation.");
    }
    const model = descriptor.models.find((candidate) => candidate.defaultVisible !== false) ?? descriptor.models[0];
    if (model === undefined) throw new Error("The installed SDK did not expose a model for the no-input probe.");
    const created = await submit(paired.clients.operation, paired.connectionId, createSessionMutation({
      backendId, targetId: fixture.targetId(backendId), displayName: "Unconsumed native start",
      providerId: model.providerId, modelId: model.modelId
    }));
    expect({ code: created.error?.code, message: created.error?.message }).toEqual({ code: undefined, message: undefined });
    expect({ state: created.state, error: created.error }).toMatchObject({ state: OperationState.SUCCEEDED });
    const sessionId = sessionIdFrom(created);
    const source = fixture.application.store.getSession(sessionId).descriptor;
    const sourceBinding = source.binding;
    if (sourceBinding?.nativeSessionId === undefined) throw new Error("The fresh Session lacks native identity.");
    const operationId = randomUUID();
    const navigation = navigateMutation(sessionId,
      create(NativeNavigationTargetSchema, { kind: { case: "sessionStart", value: {} } }),
      BigInt(sourceBinding.generation));
    const navigated = await submit(paired.clients.operation, paired.connectionId, navigation, operationId);
    expect({ state: navigated.state, error: navigated.error }).toMatchObject({ state: OperationState.SUCCEEDED });
    const replacement = fixture.application.store.getSession(sessionId).descriptor;
    const binding = replacement.binding;
    if (binding?.nativeSessionId === undefined) throw new Error("The start replacement lacks native identity.");
    expect(binding.nativeSessionId).not.toBe(sourceBinding.nativeSessionId);
    expect(binding.generation).toBe(sourceBinding.generation + 1);
    expect(fixture.application.store.findNativeSessionDerivation(operationId))
      .toMatchObject({ state: "adopted", sessionId, binding });
    expect(await started.runtime.freshContexts!.getForOperation(operationId))
      .toMatchObject({ lifecycle: "adopted", dispatch: "never_dispatched", sourceRetired: true, binding });
    expect(await started.runtime.getSessionInfo(binding.nativeSessionId, { dir: fixture.workspaceDirectory })).toBeUndefined();
    expect(await started.runtime.getSessionMessages(binding.nativeSessionId, { dir: fixture.workspaceDirectory, limit: 10, offset: 0, includeSystemMessages: true })).toEqual([]);
    expect(await messageCount(paired.clients, sessionId)).toBe(0);

    await fixture.close({ removeRoot: false });
    started = await start(root);
    fixture = started.fixture;
    const clients = fixture.clients(paired.authKey);
    const resumed = await submit(clients.operation, paired.connectionId,
      create(OperationMutationSchema, { payload: { case: "resumeSession", value: { sessionId } } }));
    expect({ state: resumed.state, error: resumed.error }).toMatchObject({ state: OperationState.SUCCEEDED });
    const reopened = fixture.application.store.getSession(sessionId).descriptor.binding;
    expect(reopened).toMatchObject({ nativeSessionId: binding.nativeSessionId, opaqueRef: binding.opaqueRef });
    expect(await started.runtime.freshContexts!.getForOperation(operationId))
      .toMatchObject({ lifecycle: "adopted", dispatch: "never_dispatched", sourceRetired: true, binding: reopened });
    expect(await started.runtime.getSessionInfo(binding.nativeSessionId, { dir: fixture.workspaceDirectory })).toBeUndefined();
    expect(await messageCount(clients, sessionId)).toBe(0);
    const deleted = await submit(clients.operation, paired.connectionId, deleteMutation(sessionId, true));
    expect({ state: deleted.state, error: deleted.error }).toMatchObject({ state: OperationState.SUCCEEDED });
    expect(await started.runtime.freshContexts!.getForOperation(operationId))
      .toMatchObject({ lifecycle: "cleaned", dispatch: "never_dispatched" });
    expect(await started.runtime.getSessionInfo(binding.nativeSessionId, { dir: fixture.workspaceDirectory })).toBeUndefined();
    expect(await started.runtime.getSessionMessages(sourceBinding.nativeSessionId, { dir: fixture.workspaceDirectory, limit: 10, offset: 0, includeSystemMessages: true })).toEqual([]);
  } finally {
    await fixture?.close({ removeRoot: false });
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

async function start(root: string) {
  let runtime: DefaultClaudeSdkRuntime | undefined;
  const fixture = await OrchestratorE2eFixture.start({
    rootDirectory: root, profiles: [],
    backendFactories: [{
      instanceId: backendId, adapterKind: "claude-agent-sdk-stdio", displayName: "Installed SDK no-input probe",
      create: ({ generation }) => {
        runtime = new DefaultClaudeSdkRuntime({
          processOwner: {
            rootDirectory: join(root, "native-process-owner"), instanceId: backendId, generation,
            recoverStale: true, supervisor: createDefaultManagedProcessSupervisor()
          },
          sessionStoreRootDirectory: join(root, "native-session-store")
        });
        return new ClaudeCodeAdapter({ instanceGeneration: generation, runtime, probeCwd: join(root, "workspace") });
      }
    }]
  });
  if (runtime === undefined) throw new Error("The installed SDK Runtime was not provisioned.");
  return { fixture, runtime };
}

async function messageCount(clients: ReturnType<OrchestratorE2eFixture["clients"]>, sessionId: string) {
  const response = await clients.event.getSnapshot({ scope: { kind: { case: "session", value: { sessionId, recentTimelineItems: 200 } } } });
  return response.snapshot!.timeline.filter((event) => event.payload?.kind.case === "messageStarted"
    || event.payload?.kind.case === "messageCompleted").length;
}
