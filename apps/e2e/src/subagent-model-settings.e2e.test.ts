import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { OperationMutationSchema, OperationState } from "@joko/contracts";
import { SubagentModelSettings } from "@joko/orchestrator";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { afterEach, expect, it } from "vitest";

import { InstrumentedFakeAdapter, OrchestratorE2eFixture, type E2eClients, type FixtureOptions } from "./fixture.js";
import { submit } from "./operations.js";

let fixture: OrchestratorE2eFixture | undefined;
let rootDirectory: string | undefined;
afterEach(async () => {
  try { await fixture?.close(); }
  finally {
    fixture = undefined;
    if (rootDirectory !== undefined) await rm(rootDirectory, { recursive: true, force: true, maxRetries: 3 });
    rootDirectory = undefined;
  }
});

class SubagentSettingsAdapter extends InstrumentedFakeAdapter {
  override async describe() {
    const descriptor = await super.describe();
    return {
      ...descriptor,
      providers: [{
        providerId: "test", displayName: "Test Provider", api: "anthropic-messages", authenticationState: "not_required" as const,
        loginMethods: [], supportsLogin: false, supportsLogout: false, supportsRefresh: false, supportsModelRefresh: false
      }]
    };
  }
}

it("persists subagent defaults through authenticated clients, CAS, replay, reset and service restart", async () => {
  const profile = {
    ...PI_LIKE_PROFILE,
    capabilities: [...PI_LIKE_PROFILE.capabilities, { key: "subagents.default_model", supported: true }]
  };
  const options: FixtureOptions = {
    profiles: [profile], createAdapter: (value) => new SubagentSettingsAdapter(value),
    createAuxiliaryServices: async (store) => ({ subagentModels: new SubagentModelSettings({ store }) })
  };
  fixture = await OrchestratorE2eFixture.start(options);
  rootDirectory = fixture.rootDirectory;
  const first = await fixture.pair("First subagent settings window");
  const second = await fixture.pair("Second subagent settings window");
  const read = async (clients: E2eClients) => (await clients.settings.getSettings({})).settings!.subagentModels
    .find((setting) => setting.backendId === profile.id)!;
  const mutation = (model: { providerId: string; modelId: string } | undefined, revision: bigint) => create(OperationMutationSchema, {
    payload: {
      case: "updateSubagentModelSettings",
      value: { backendId: profile.id, ...(model === undefined ? {} : { model }), expectedRevision: { value: revision } }
    }
  });
  expect(await read(first.clients)).toMatchObject({ available: true, revision: { value: 0n } });
  const model = { providerId: "test", modelId: "text" };
  const operationId = randomUUID();
  const saved = await submit(first.clients.operation, first.connectionId, mutation(model, 0n), operationId);
  expect(saved.state).toBe(OperationState.SUCCEEDED);
  const current = await read(second.clients);
  expect(current.model).toMatchObject(model);
  const revision = current.revision!.value;
  await expect(submit(second.clients.operation, second.connectionId, mutation(undefined, 0n)))
    .rejects.toMatchObject({ code: Code.Aborted });
  await submit(first.clients.operation, first.connectionId, mutation(model, 0n), operationId);
  expect((await read(first.clients)).revision!.value).toBe(revision);

  await fixture.close({ removeRoot: false });
  fixture = await OrchestratorE2eFixture.start({ ...options, rootDirectory });
  const firstReconnected = fixture.clients(first.authKey);
  const secondReconnected = fixture.clients(second.authKey);
  expect(await read(secondReconnected)).toMatchObject({ available: true, model, revision: { value: revision } });
  await submit(firstReconnected.operation, first.connectionId, mutation(model, 0n), operationId);
  expect((await read(secondReconnected)).revision!.value).toBe(revision);

  await submit(secondReconnected.operation, second.connectionId, mutation(undefined, revision));
  const reset = await read(firstReconnected);
  expect(reset.model).toBeUndefined();
  expect(reset.revision!.value).toBeGreaterThan(revision);
  await expect(submit(firstReconnected.operation, first.connectionId, mutation(model, revision)))
    .rejects.toMatchObject({ code: Code.Aborted });
  await expect(submit(firstReconnected.operation, first.connectionId, mutation(model, 0n)))
    .rejects.toMatchObject({ code: Code.Aborted });
});
