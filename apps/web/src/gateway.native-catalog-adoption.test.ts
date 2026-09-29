import { create } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import type { Transport } from "@connectrpc/connect";
import { NativeCatalogAdoptionInspection, NativeCatalogAdoptionState } from "@joko/contracts";
import { expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";

it("pages public adoption receipts and reconciles only the requested Operation", async () => {
  const requests: Array<{ method: string; input: any }> = [];
  const transport = fakeTransport((method, input) => {
    requests.push({ method: method.localName, input });
    if (method.localName === "listNativeCatalogAdoptions") {
      const second = input.page?.pageToken === "next";
      return {
        adoptions: [adoption(second ? "operation-2" : "operation-1")],
        page: { totalSize: 2n, nextPageToken: second ? "" : "next" }
      };
    }
    if (method.localName === "reconcileNativeCatalogAdoption") {
      return {
        adoption: adoption(input.operationId, NativeCatalogAdoptionState.ADOPTED, "session-1"),
        inspection: NativeCatalogAdoptionInspection.PRESENT
      };
    }
    throw new Error(`Unexpected RPC ${method.localName}`);
  });
  const gateway = await mount(transport);
  try {
    await expect(gateway.listNativeCatalogAdoptions()).resolves.toMatchObject([
      { operationId: "operation-1", state: "pending" },
      { operationId: "operation-2", state: "pending" }
    ]);
    expect(requests.filter((request) => request.method === "listNativeCatalogAdoptions")
      .map((request) => request.input.page.pageToken)).toEqual(["", "next"]);
    await expect(gateway.reconcileNativeCatalogAdoption("operation-1")).resolves.toMatchObject({
      inspection: "present", adoption: { operationId: "operation-1", state: "adopted", sessionId: "session-1" }
    });
    expect(requests.find((request) => request.method === "reconcileNativeCatalogAdoption")?.input)
      .toEqual({ operationId: "operation-1" });
  } finally {
    gateway.disconnect();
  }
});

it("rejects a repeated or malformed adoption directory instead of rendering another owner", async () => {
  let malformed = false;
  const gateway = await mount(fakeTransport((method, input) => {
    if (method.localName !== "listNativeCatalogAdoptions") throw new Error(`Unexpected RPC ${method.localName}`);
    if (malformed) return {
      adoptions: [adoption("operation-1", NativeCatalogAdoptionState.ADOPTED)],
      page: { totalSize: 1n }
    };
    return {
      adoptions: [adoption("operation-1")],
      page: { totalSize: 2n, nextPageToken: input.page?.pageToken === "" ? "next" : "" }
    };
  }));
  try {
    await expect(gateway.listNativeCatalogAdoptions()).rejects.toThrow();
    malformed = true;
    await expect(gateway.listNativeCatalogAdoptions()).rejects.toThrow();
  } finally {
    gateway.disconnect();
  }
});

function adoption(operationId: string, state = NativeCatalogAdoptionState.PENDING, sessionId?: string) {
  return {
    operationId, backendId: "codex", targetId: "target-1", title: "Catalog task",
    state, revision: 1n, updatedAt: create(TimestampSchema, { seconds: 1_800_000_000n }),
    ...(sessionId === undefined ? {} : { sessionId })
  };
}

function fakeTransport(handler: (method: any, input: any) => object): Transport {
  return {
    unary: vi.fn(async (method: any, _signal: AbortSignal | undefined, _timeout: unknown,
      _headers: unknown, input: any) => {
      const value = method.localName === "getSnapshot" ? { snapshot: {} } : handler(method, input);
      return { stream: false, service: method.parent, method, header: new Headers(),
        trailer: new Headers(), message: create(method.output, value) };
    }),
    stream: vi.fn(async (method: any) => ({ stream: true, service: method.parent, method,
      header: new Headers(), trailer: new Headers(), message: idleStream() }))
  } as unknown as Transport;
}

async function mount(transport: Transport) {
  const gateway = createOrchestratorGateway({ id: "profile", deviceId: "device", name: "Node",
    origin: "https://service.example", serverId: "node" }, "fixture-auth", {}, () => transport);
  await gateway.connect();
  return gateway;
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
