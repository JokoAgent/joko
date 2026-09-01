import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  ArtifactKind,
  BlobDisposition,
  GetBlobDownloadTicketResponseSchema,
  GetSnapshotResponseSchema,
  OperationState,
  SnapshotSchema,
  SubmitOperationResponseSchema,
  TransferDirection,
  WatchOperationResponseSchema
} from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";

describe("Session export gateway", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("waits for the terminal Artifact and invokes the authenticated download chain", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const clicked = vi.fn(() => calls.push("click"));
    const link: { href: string; download: string; rel: string; click: () => void } = {
      href: "",
      download: "",
      rel: "",
      click: clicked
    };
    vi.stubGlobal("document", {
      createElement: vi.fn((tag: string) => {
        expect(tag).toBe("a");
        return link;
      })
    });
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      calls.push("object-url");
      expect(blob).toBeInstanceOf(Blob);
      return "blob:joko-session-export";
    });
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const fetchDownload = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push("fetch");
      expect(String(input)).toBe("https://orchestrator.example/v1/blob-downloads/ticket-export");
      expect(init).toMatchObject({
        headers: { authorization: "Bearer secret" },
        cache: "no-store"
      });
      return new Response("<!doctype html><title>Export</title>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    });
    vi.stubGlobal("fetch", fetchDownload);
    const transport = exportTransport(calls, "artifact");
    const gateway = createOrchestratorGateway(
      { id: "connection-export", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();

    await gateway.exportSession("session-1");

    expect(calls).toEqual(["submit", "watch", "ticket", "fetch", "object-url", "click"]);
    expect(link).toMatchObject({
      href: "blob:joko-session-export",
      download: "session-1.html",
      rel: "noopener"
    });
    expect(createObjectUrl).toHaveBeenCalledOnce();
    expect(clicked).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1_000);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:joko-session-export");
    gateway.disconnect();
  });

  it.each(["acknowledgement", "missing"] as const)(
    "fails closed and never downloads when the terminal result is %s",
    async (resultKind) => {
      const calls: string[] = [];
      const fetchDownload = vi.fn();
      vi.stubGlobal("fetch", fetchDownload);
      const gateway = createOrchestratorGateway(
        { id: "connection-export", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
        "secret",
        {},
        () => exportTransport(calls, resultKind)
      );
      await gateway.connect();

      await expect(gateway.exportSession("session-1")).rejects.toThrow(
        "completed Session export without an Artifact"
      );
      expect(fetchDownload).not.toHaveBeenCalled();
      expect(calls).toEqual(["submit", "watch"]);
      gateway.disconnect();
    }
  );
});

type ExportResultKind = "artifact" | "acknowledgement" | "missing";

function exportTransport(calls: string[], resultKind: ExportResultKind): Transport {
  return {
    unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
      if (method.localName === "getSnapshot") {
        return response(method, create(GetSnapshotResponseSchema, {
          snapshot: create(SnapshotSchema, {
            generation: 1n,
            resumeCursor: { generation: 1n, sequence: 0n }
          })
        }));
      }
      if (method.localName === "submitOperation") {
        calls.push("submit");
        expect(input.mutation?.payload).toMatchObject({
          case: "exportSession",
          value: { sessionId: "session-1" }
        });
        return response(method, create(SubmitOperationResponseSchema, {
          operation: {
            operationId: input.operationId,
            connectionId: input.connectionId,
            state: OperationState.RUNNING
          }
        }));
      }
      if (method.localName === "getBlobDownloadTicket") {
        calls.push("ticket");
        expect(input).toMatchObject({ blobId: "artifact-export" });
        return response(method, create(GetBlobDownloadTicketResponseSchema, {
          ticket: {
            ticketId: "ticket-export",
            blobId: "artifact-export",
            direction: TransferDirection.DOWNLOAD,
            relativeEndpoint: "/v1/blob-downloads/ticket-export",
            maximumBytes: 46n,
            requiredMediaType: "text/html"
          }
        }));
      }
      throw new Error(`Unexpected method: ${method.localName}`);
    }),
    stream: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
      if (method.localName === "watchOperation") {
        calls.push("watch");
        return response(method, terminalExport(input.operationId, resultKind), true);
      }
      return response(method, idleStream(), true);
    })
  } as unknown as Transport;
}

function terminalResult(kind: ExportResultKind) {
  if (kind === "missing") return undefined;
  if (kind === "acknowledgement") {
    return { payload: { case: "acknowledgement" as const, value: { accepted: true } } };
  }
  return {
    payload: {
      case: "artifact" as const,
      value: {
        artifactId: "artifact-export",
        sessionId: "session-1",
        kind: ArtifactKind.EXPORT,
        title: "session-1.html",
        blob: {
          blobId: "artifact-export",
          fileName: "session-1.html",
          mediaType: "text/html",
          byteSize: 46n,
          sha256Hex: "a".repeat(64),
          disposition: BlobDisposition.EXPORT
        }
      }
    }
  };
}

async function* terminalExport(operationId: string, kind: ExportResultKind) {
  yield create(WatchOperationResponseSchema, {
    operation: {
      operationId,
      state: OperationState.SUCCEEDED,
      result: terminalResult(kind)
    }
  });
}

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
