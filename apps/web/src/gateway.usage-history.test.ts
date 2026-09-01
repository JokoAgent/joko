import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  GetModelPriceOverrideResponseSchema,
  GetSnapshotResponseSchema,
  GetUsageHistoryResponseSchema,
  ModelPriceCurrency,
  ResetModelPriceOverrideResponseSchema,
  SetModelPriceOverrideResponseSchema,
  SnapshotSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import { createOrchestratorGateway } from "./gateway.js";

describe("usage history gateway", () => {
  it("maps durable history and exact price targets without combining currencies", async () => {
    const calls: Array<{ readonly method: string; readonly input: any }> = [];
    const transport = usageTransport((method, input) => {
      calls.push({ method: method.localName, input });
      if (method.localName === "getUsageHistory") return create(GetUsageHistoryResponseSchema, { history: protoHistory(input.days) });
      if (method.localName === "getModelPriceOverride") return create(GetModelPriceOverrideResponseSchema, { price: protoPrice(input.backendId, input.providerId, input.modelId) });
      if (method.localName === "setModelPriceOverride") return create(SetModelPriceOverrideResponseSchema, { price: { ...protoPrice(input.backendId, input.providerId, input.modelId), override: input.desired, effective: input.desired } });
      if (method.localName === "resetModelPriceOverride") return create(ResetModelPriceOverrideResponseSchema, { price: { ...protoPrice(input.backendId, input.providerId, input.modelId), override: undefined } });
      throw new Error(`Unexpected method ${method.localName}`);
    });
    const gateway = createOrchestratorGateway(
      { id: "connection-usage", deviceId: "device-test", name: "Desktop", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();

    const history = await gateway.getUsageHistory(140, "backend-one", "provider-one");
    expect(history.days).toHaveLength(140);
    expect(history.today.currencyTotals.map((total) => [total.currencyCode, total.usage.costMicros])).toEqual([["USD", 1_000_000], ["CNY", 2_000_000]]);
    expect(history.today.usage.costMicros).toBe(0);
    expect(history.currentStreakDays).toBe(3);
    expect(history.models.map(({ backendId, providerId, modelId }) => ({ backendId, providerId, modelId })))
      .toEqual([
        { backendId: "backend-one", providerId: "provider-one", modelId: "model-one" },
        { backendId: "backend-two", providerId: "provider-one", modelId: "model-one" }
      ]);
    expect(calls.find((call) => call.method === "getUsageHistory")?.input).toEqual({ days: 140, backendId: "backend-one", providerId: "provider-one" });

    const reference = await gateway.getModelPriceOverride(" backend-one ", " provider-one ", " model-one ");
    expect(reference).toMatchObject({ backendId: "backend-one", providerId: "provider-one", modelId: "model-one", effective: { currency: "USD", inputPerMillion: 2, outputPerMillion: 6 }, revision: 9n });
    const saved = await gateway.setModelPriceOverride("backend-one", "provider-one", "model-one", {
      currency: "CNY",
      inputPerMillion: 2.5,
      outputPerMillion: 8,
      cacheReadPerMillion: 0.25
    });
    expect(saved.effective).toEqual({ currency: "CNY", inputPerMillion: 2.5, outputPerMillion: 8, cacheReadPerMillion: 0.25 });
    expect(calls.find((call) => call.method === "setModelPriceOverride")?.input.desired).toMatchObject({
      currency: ModelPriceCurrency.CNY,
      inputCostMicrosPerMillion: 2_500_000n,
      outputCostMicrosPerMillion: 8_000_000n,
      cacheReadCostMicrosPerMillion: 250_000n
    });
    expect(calls.find((call) => call.method === "setModelPriceOverride")?.input).toMatchObject({
      backendId: "backend-one",
      providerId: "provider-one",
      modelId: "model-one"
    });
    expect((await gateway.resetModelPriceOverride("backend-one", "provider-one", "model-one")).override)
      .toBeUndefined();
    await expect(gateway.getUsageHistory(367)).rejects.toThrow("between 1 and 366");
    gateway.disconnect();
  });
});

function protoHistory(days: number): any {
  const values = Array.from({ length: days }, (_, index) => ({
    day: utcDay(index - days + 1),
    usage: usage(index + 1, 0, ""),
    currencyTotals: [],
    costComplete: true,
    estimated: false
  }));
  const currencyTotals = [
    { currencyCode: "USD", usage: usage(10, 1_000_000, "USD"), costComplete: true, estimated: false },
    { currencyCode: "CNY", usage: usage(20, 2_000_000, "CNY"), costComplete: true, estimated: true }
  ];
  const summary = { usage: usage(30, 0, ""), currencyTotals, costComplete: true, estimated: true };
  return {
    days: values,
    modelDaily: [
      { day: values.at(-1)?.day, backendId: "backend-one", model: { providerId: "provider-one", modelId: "model-one" }, ...summary },
      { day: values.at(-1)?.day, backendId: "backend-two", model: { providerId: "provider-one", modelId: "model-one" }, ...summary }
    ],
    models: [
      { backendId: "backend-one", model: { providerId: "provider-one", modelId: "model-one" }, ...summary },
      { backendId: "backend-two", model: { providerId: "provider-one", modelId: "model-one" }, ...summary }
    ],
    today: summary,
    last30Days: summary,
    currentStreakDays: 3,
    longestStreakDays: 7,
    todayAnomalous: true,
    generatedAt: { seconds: 100n, nanos: 0 },
    measuredAt: { seconds: 99n, nanos: 0 },
    estimated: true
  };
}

function protoPrice(backendId: string, providerId: string, modelId: string): any {
  const quote = {
    currency: ModelPriceCurrency.USD,
    inputCostMicrosPerMillion: 2_000_000n,
    outputCostMicrosPerMillion: 6_000_000n,
    cacheReadCostMicrosPerMillion: 200_000n
  };
  return {
    backendId,
    model: { providerId, modelId },
    reference: quote,
    effective: quote,
    override: quote,
    allowedCurrencies: [ModelPriceCurrency.USD, ModelPriceCurrency.CNY],
    updatedAt: { seconds: 90n, nanos: 0 },
    version: { revision: { value: 9n, etag: "nine" }, generation: 1n }
  };
}

function usage(totalTokens: number, costMicros: number, currencyCode: string): any {
  return { inputTokens: BigInt(totalTokens), outputTokens: 0n, cacheReadTokens: 0n, cacheWriteTokens: 0n, totalTokens: BigInt(totalTokens), costMicros: BigInt(costMicros), currencyCode };
}

function utcDay(offset: number): string {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function usageTransport(resolve: (method: any, input: any) => unknown): Transport {
  return {
    unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
      const message = method.localName === "getSnapshot"
        ? create(GetSnapshotResponseSchema, { snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } }) })
        : resolve(method, input);
      return response(method, message);
    }),
    stream: vi.fn(async (method: any) => response(method, idleStream(), true))
  } as unknown as Transport;
}

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncGenerator<never> {
  await new Promise<void>(() => undefined);
}
