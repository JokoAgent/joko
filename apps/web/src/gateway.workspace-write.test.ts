import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import {
  GetSnapshotResponseSchema,
  GetOperationResponseSchema,
  OperationState,
  ReadWorkspaceFileResponseSchema,
  SnapshotSchema,
  WriteWorkspaceTextFileResponseSchema,
  type WriteWorkspaceTextFileResponse
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";

describe("workspace text editor gateway", () => {
  it.each([false, true])("reads the editor and recovers the exact write receipt (response lost: %s)", async lost => {
    let committed: WriteWorkspaceTextFileResponse | undefined;
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        if (method.localName === "getSnapshot") {
          return response(method, create(GetSnapshotResponseSchema, { snapshot: create(SnapshotSchema) }));
        }
        if (method.localName === "readWorkspaceFile") {
          expect(input).toMatchObject({
            workspaceId: "workspace-1",
            relativePath: "src/main.ts",
            startByte: 0n,
            maximumBytes: 2_097_152n
          });
          return response(method, create(ReadWorkspaceFileResponseSchema, {
            preview: {
              entry: {
                workspaceId: "workspace-1",
                relativePath: "src/main.ts",
                displayName: "main.ts",
                revision: {
                  sha256Hex: "a".repeat(64),
                  byteSize: 13n,
                  modifiedAt: { seconds: 1_725_000_000n, nanos: 456_000_000 },
                  opaqueRevision: "revision-before"
                }
              },
              content: { case: "text", value: { utf8Text: "export {};\r\n", languageId: "typescript" } },
              truncated: false
            }
          }));
        }
        if (method.localName === "writeWorkspaceTextFile") {
          expect(committed).toBeUndefined();
          expect(input).toMatchObject({
            workspaceId: "workspace-1",
            relativePath: "src/main.ts",
            utf8Text: "export const value = 1;\r\n",
            expectedRevision: { opaqueRevision: "revision-before" }
          });
          committed = create(WriteWorkspaceTextFileResponseSchema, {
            operationId: input.operationId, previousRevision: input.expectedRevision,
            entry: {
              workspaceId: "workspace-1",
              relativePath: "src/main.ts",
              displayName: "main.ts",
              revision: { sha256Hex: "b".repeat(64), byteSize: 25n, opaqueRevision: "revision-after" }
            },
            newRevision: { sha256Hex: "b".repeat(64), byteSize: 25n, opaqueRevision: "revision-after" }
          });
          if (lost) throw new ConnectError("Response lost", Code.Unavailable);
          return response(method, committed);
        }
        if (method.localName === "getOperation" && lost && committed) {
          expect(input.operationId).toBe(committed.operationId);
          return response(method, create(GetOperationResponseSchema, { operation: {
            operationId: input.operationId, connectionId: "connection-workspace", state: OperationState.SUCCEEDED,
            result: { payload: { case: "workspaceTextFileWrite", value: committed } }
          } }));
        }
        throw new Error(`Unexpected RPC ${method.localName}`);
      }),
      stream: vi.fn(async (method: any) => response(method, idleStream(), true))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway(
      { id: "connection-workspace", deviceId: "device-test", name: "Workspace", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();

    const preview = await gateway.readWorkspaceFile("workspace-1", "src/main.ts");
    expect(preview).toMatchObject({
      path: "src/main.ts",
      text: "export {};\r\n",
      language: "typescript",
      revision: "revision-before",
      byteSize: 13,
      modifiedAt: 1_725_000_000_456,
      truncated: false
    });
    expect(preview.byteSize).toBe(13);
    expect(preview.modifiedAt).toBe(1_725_000_000_456);
    await expect(gateway.writeWorkspaceTextFile("workspace-1", {
      path: "src/main.ts",
      text: "export const value = 1;\r\n",
      expectedRevision: "revision-before"
    })).resolves.toEqual({ path: "src/main.ts", name: "main.ts", revision: "revision-after" });
    gateway.disconnect();
  });

  it("maps a streamed workspace binary BlobRef without exposing a service path", async () => {
    const transport = {
      unary: vi.fn(async (method: any) => {
        if (method.localName === "getSnapshot") {
          return response(method, create(GetSnapshotResponseSchema, { snapshot: create(SnapshotSchema) }));
        }
        if (method.localName === "readWorkspaceFile") {
          return response(method, create(ReadWorkspaceFileResponseSchema, {
            preview: {
              entry: {
                workspaceId: "workspace-1",
                relativePath: "media/demo.mp4",
                displayName: "demo.mp4",
                revision: { byteSize: 33_554_433n, opaqueRevision: "meta:video-fence" }
              },
              content: {
                case: "blob",
                value: {
                  blobId: "workspace-video-blob",
                  fileName: "demo.mp4",
                  mediaType: "video/mp4",
                  byteSize: 33_554_433n,
                  sha256Hex: "c".repeat(64)
                }
              },
              truncated: false
            }
          }));
        }
        throw new Error(`Unexpected RPC ${method.localName}`);
      }),
      stream: vi.fn(async (method: any) => response(method, idleStream(), true))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway(
      { id: "connection-workspace", deviceId: "device-test", name: "Workspace", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();

    await expect(gateway.readWorkspaceFile("workspace-1", "media/demo.mp4")).resolves.toEqual({
      path: "media/demo.mp4",
      name: "demo.mp4",
      kind: "blob",
      revision: "meta:video-fence",
      blobId: "workspace-video-blob",
      mediaType: "video/mp4",
      byteSize: 33_554_433,
      truncated: false
    });
    expect(JSON.stringify(await gateway.readWorkspaceFile("workspace-1", "media/demo.mp4"))).not.toMatch(/[a-z]:\\|serverPath|workspaceRoot/iu);
    gateway.disconnect();
  });
});

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
