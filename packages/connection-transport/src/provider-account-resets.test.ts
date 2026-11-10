import assert from "node:assert/strict";
import { test } from "vitest";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError, createRouterTransport } from "@connectrpc/connect";
import { BackendService, OperationService, OperationState, OperationMutationSchema, ProviderAccountResetStateSchema, ProviderAccountResetAvailability,
  ProviderAccountResetOutcome, DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS, parseProviderAccountResetSettings, providerAccountResetOperationId } from "@joko/contracts";
import { createProviderAccountResetApi } from "./provider-account-resets.js";

test("keeps the original typed reset request across a lost response, UI replacement and explicit retry", async () => {
  const offerId = "0d724809-86af-4f8d-93dc-fbfa21e81afe", calls: { id: string; body: Buffer }[] = [];
  const state = create(ProviderAccountResetStateSchema, { backendId: "codex", providerId: "openai", accountKey: "a".repeat(64),
    availability: ProviderAccountResetAvailability.AVAILABLE, availableCount: 1, defaultOffer: { offerId }, automaticSettings: DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS, settingsRevision: { value: 0n } });
  const transport = createRouterTransport(router => {
    router.service(BackendService, { getProviderAccountResetState: () => ({ state }) });
    router.service(OperationService, { submitOperation: request => {
      calls.push({ id: request.operationId, body: Buffer.from(toBinary(OperationMutationSchema, request.mutation!)) });
      if (calls.length === 1) throw new ConnectError("Response lost", Code.Unavailable);
      return { operation: { operationId: request.operationId, connectionId: "owner", state: OperationState.SUCCEEDED, result: { payload: { case: "providerAccountReset",
        value: { backendId: "codex", providerId: "openai", accountKey: state.accountKey, offerId, outcome: ProviderAccountResetOutcome.ALREADY_REDEEMED } } } } };
    } });
  });
  const bind = (ownerKey: string) => createProviderAccountResetApi({ ownerKey, connectionId: "owner", transport, newId: () => "settings-operation", assertCurrent() {} });
  const first = bind("first-view"), read = await first.read("codex", "openai", new AbortController().signal);
  await assert.rejects(first.consume(read, read.defaultOffer!, new AbortController().signal));
  const reopened = bind("reopened-view"), receipt = await reopened.consume(state, { ...state.defaultOffer!, retryOnly: true }, new AbortController().signal);
  assert.equal(receipt.outcome, ProviderAccountResetOutcome.ALREADY_REDEEMED); assert.equal(calls.length, 2);
  assert.equal(calls[0]!.id, calls[1]!.id); assert.deepEqual(calls[0]!.body, calls[1]!.body);
  const mutation = fromBinary(OperationMutationSchema, calls[0]!.body);
  assert.equal(mutation.payload.case, "consumeProviderAccountReset"); assert.equal(mutation.preconditions.length, 0);
  if (mutation.payload.case !== "consumeProviderAccountReset") throw new Error("Wrong reset mutation");
  assert.equal(mutation.payload.value.offerId, offerId);
  assert.notEqual(providerAccountResetOperationId(offerId, "first-connection"), providerAccountResetOperationId(offerId, "second-connection"));
});

test("distinguishes an unknown reset count from zero and refuses a retired account owner", async () => {
  let active = true;
  const state = create(ProviderAccountResetStateSchema, { backendId: "codex", providerId: "openai" });
  const transport = createRouterTransport(router => router.service(BackendService, { getProviderAccountResetState: () => ({ state }) }));
  const api = createProviderAccountResetApi({ ownerKey: "owner", connectionId: "owner", transport, newId: () => "unused",
    assertCurrent() { if (!active) throw new Error("Owner retired"); } });
  assert.equal((await api.read("codex", "openai", new AbortController().signal)).availableCount, undefined);
  state.availableCount = 0;
  assert.equal((await api.read("codex", "openai", new AbortController().signal)).availableCount, 0);
  active = false; await assert.rejects(api.read("codex", "openai", new AbortController().signal), /retired/);
  assert.deepEqual(parseProviderAccountResetSettings(DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS), DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS);
  assert.throws(() => parseProviderAccountResetSettings({ ...DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS, enabled: true, lowQuota: false, expiring: false }));
  assert.throws(() => parseProviderAccountResetSettings({ ...DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS, minimumDays: 366 }));
  assert.throws(() => parseProviderAccountResetSettings({ ...DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS, expiryMinutes: 90 }));
});

test("reads the original completed receipt after a lost reply without resubmitting a reset", async () => {
  const offerId = "0d724809-86af-4f8d-93dc-fbfa21e81afe", calls: string[] = [], reads: string[] = [];
  const state = create(ProviderAccountResetStateSchema, { backendId: "codex", providerId: "openai", accountKey: "a".repeat(64), defaultOffer: { offerId } });
  const transport = createRouterTransport(router => router.service(OperationService, {
    submitOperation: request => { calls.push(request.operationId); throw new ConnectError("Reply lost", Code.Unavailable); },
    getOperation: request => { reads.push(request.operationId); return { operation: { operationId: request.operationId, connectionId: "owner", state: OperationState.SUCCEEDED,
      result: { payload: { case: "providerAccountReset", value: { backendId: "codex", providerId: "openai", accountKey: state.accountKey, offerId, outcome: ProviderAccountResetOutcome.RESET } } } } }; }
  }));
  const api = createProviderAccountResetApi({ ownerKey: "owner", connectionId: "owner", transport, newId: () => "unused", assertCurrent() {} });
  const receipt = await api.consume(state, state.defaultOffer!, new AbortController().signal);
  assert.equal(receipt.outcome, ProviderAccountResetOutcome.RESET); assert.equal(calls.length, 1); assert.deepEqual(reads, calls);
});
