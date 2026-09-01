import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  BrowserActivityKind,
  BrowserTransferState,
  GetSnapshotResponseSchema,
  ListBrowserActivityResponseSchema,
  ListBrowserTransfersResponseSchema,
  SnapshotSchema,
  TransferDirection
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import { createOrchestratorGateway } from "./gateway.js";

describe("Browser ledger gateway", () => {
  it("collects every activity and transfer page without silently dropping older records", async () => {
    const activityTokens: string[] = [];
    const transferTokens: string[] = [];
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        if (method.localName === "getSnapshot") {
          return response(method, create(GetSnapshotResponseSchema, {
            snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } })
          }));
        }
        if (method.localName === "listBrowserActivity") {
          const token = input.page?.pageToken ?? "";
          activityTokens.push(token);
          return response(method, create(ListBrowserActivityResponseSchema, token === ""
            ? {
                activities: [{ activityId: "activity-new", pageId: "page-one", kind: BrowserActivityKind.NAVIGATION }],
                page: { nextPageToken: "activity-2", totalSize: 2n }
              }
            : {
                activities: [{ activityId: "activity-old", pageId: "page-one", kind: BrowserActivityKind.INTERACTION }],
                page: { totalSize: 2n }
              }));
        }
        if (method.localName === "listBrowserTransfers") {
          const token = input.page?.pageToken ?? "";
          transferTokens.push(token);
          return response(method, create(ListBrowserTransfersResponseSchema, token === ""
            ? {
                transfers: [{
                  browserTransferId: "transfer-new",
                  browserProviderId: "browser-one",
                  pageId: "page-one",
                  direction: TransferDirection.DOWNLOAD,
                  state: BrowserTransferState.COMPLETED
                }],
                page: { nextPageToken: "transfer-2", totalSize: 2n }
              }
            : {
                transfers: [{
                  browserTransferId: "transfer-old",
                  browserProviderId: "browser-one",
                  pageId: "page-one",
                  direction: TransferDirection.UPLOAD,
                  state: BrowserTransferState.FAILED
                }],
                page: { totalSize: 2n }
              }));
        }
        throw new Error(`Unexpected method: ${method.localName}`);
      }),
      stream: vi.fn(async (method: any) => response(method, idleStream(), true))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway(
      { id: "connection-ledger", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();

    await expect(gateway.listBrowserActivity("browser-one", "page-one"))
      .resolves.toMatchObject([{ id: "activity-new" }, { id: "activity-old" }]);
    await expect(gateway.listBrowserTransfers("browser-one", "page-one"))
      .resolves.toMatchObject([{ id: "transfer-new" }, { id: "transfer-old" }]);
    expect(activityTokens).toEqual(["", "activity-2"]);
    expect(transferTokens).toEqual(["", "transfer-2"]);
    expect((transport.unary as any).mock.calls
      .filter((call: any[]) => call[0].localName === "listBrowserActivity" || call[0].localName === "listBrowserTransfers")
      .every((call: any[]) => call[4].page.pageSize === 500)).toBe(true);
    gateway.disconnect();
  });

  it("rejects cyclic activity and transfer cursors instead of returning an incomplete ledger", async () => {
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        if (method.localName === "getSnapshot") {
          return response(method, create(GetSnapshotResponseSchema, {
            snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } })
          }));
        }
        const token = input.page?.pageToken ?? "";
        const page = { nextPageToken: token === "" ? "loop" : "loop", totalSize: 2n };
        if (method.localName === "listBrowserActivity") {
          return response(method, create(ListBrowserActivityResponseSchema, { page }));
        }
        if (method.localName === "listBrowserTransfers") {
          return response(method, create(ListBrowserTransfersResponseSchema, { page }));
        }
        throw new Error(`Unexpected method: ${method.localName}`);
      }),
      stream: vi.fn(async (method: any) => response(method, idleStream(), true))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway(
      { id: "connection-ledger-cycle", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();

    await expect(gateway.listBrowserActivity("browser-one", "page-one"))
      .rejects.toThrow("cyclic Browser activity page token");
    await expect(gateway.listBrowserTransfers("browser-one", "page-one"))
      .rejects.toThrow("cyclic Browser transfer page token");
    gateway.disconnect();
  });
});

function response(method: any, message: any, stream = false): any {
  return { header: new Headers(), trailer: new Headers(), message, method, service: method.parent, stream };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise(() => undefined);
}
