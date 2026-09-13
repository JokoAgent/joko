import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  GetSessionStatisticsResponseSchema,
  GetSnapshotResponseSchema,
  SnapshotSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";

describe("task statistics gateway", () => {
  it("keeps lifetime usage independent from the current context window", async () => {
    const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
    const transport = statisticsTransport((method, input) => {
      calls.push({ method: method.localName, input });
      return create(GetSessionStatisticsResponseSchema, {
        statistics: {
          sessionId: "task-1",
          messageCount: 12n,
          turnCount: 5n,
          branchCount: 2n,
          compactionCount: 3n,
          usage: {
            inputTokens: 1_000n,
            outputTokens: 200n,
            cacheReadTokens: 100n,
            cacheWriteTokens: 50n,
            totalTokens: 1_350n,
            costMicros: 125_000n,
            currencyCode: "USD"
          },
          context: {
            usedTokens: 80n,
            contextWindowTokens: 200n,
            reservedTokens: 120n,
            utilizationRatio: 0.4,
            measuredAt: { seconds: 100n, nanos: 0 }
          },
          activeDuration: { seconds: 12n, nanos: 500_000_000 }
        }
      });
    });
    const gateway = createOrchestratorGateway(
      { id: "connection-statistics", deviceId: "device-test", name: "Desktop", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();

    await expect(gateway.getSessionStatistics("task-1")).resolves.toEqual({
      sessionId: "task-1",
      messageCount: 12,
      turnCount: 5,
      branchCount: 2,
      compactionCount: 3,
      usage: {
        inputTokens: 1_000,
        outputTokens: 200,
        cacheReadTokens: 100,
        cacheWriteTokens: 50,
        totalTokens: 1_350,
        costMicros: 125_000,
        currencyCode: "USD"
      },
      context: {
        usedTokens: 80,
        contextWindow: 200,
        reservedTokens: 120,
        utilizationRatio: 0.4,
        measuredAt: 100_000
      },
      activeDurationMs: 12_500
    });
    expect(calls).toContainEqual({ method: "getSessionStatistics", input: { sessionId: "task-1" } });
    gateway.disconnect();
  });
});

function statisticsTransport(resolve: (method: any, input: any) => unknown): Transport {
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
