import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  BeginBlobUploadResponseSchema,
  BlobDisposition,
  CompleteBlobUploadResponseSchema,
  GetSnapshotResponseSchema,
  OperationState,
  ReviewAttachmentKind,
  ReviewRunState,
  ReviewTargetKind,
  SnapshotSchema,
  SubmitOperationResponseSchema,
  TransferDirection
} from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOrchestratorGateway } from "./gateway.js";

describe("isolated Review gateway", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("commits this invocation's attachments before accepting one typed Review run", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls.push("put");
      return new Response(undefined, { status: 204 });
    }));
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        if (method.localName === "getSnapshot") {
          return response(method, create(GetSnapshotResponseSchema, { snapshot: create(SnapshotSchema) }));
        }
        if (method.localName === "beginBlobUpload") {
          const upload = input.fileName === "screen.png" ? 1 : input.fileName === "notes.txt" ? 2 : 3;
          calls.push(`begin:${upload}`);
          return response(method, create(BeginBlobUploadResponseSchema, {
            upload: {
              uploadId: `upload-${upload}`,
              ticket: {
                ticketId: `ticket-${upload}`,
                direction: TransferDirection.UPLOAD,
                relativeEndpoint: `/uploads/${upload}`,
                maximumBytes: input.byteSize,
                requiredMediaType: "application/octet-stream"
              },
              expectedByteSize: input.byteSize
            }
          }));
        }
        if (method.localName === "completeBlobUpload") {
          const index = Number(String(input.uploadId).split("-")[1]);
          calls.push(`complete:${index}`);
          return response(method, create(CompleteBlobUploadResponseSchema, {
            blob: {
              blobId: `blob-${index}`,
              fileName: index === 1 ? "screen.png" : "notes.txt",
              mediaType: index === 1 ? "image/png" : "text/plain",
              byteSize: 1n,
              sha256Hex: "0".repeat(64),
              disposition: BlobDisposition.ATTACHMENT
            }
          }));
        }
        if (method.localName === "submitOperation") {
          calls.push("submit");
          const mutation = input.mutation?.payload;
          expect(mutation).toMatchObject({
            case: "startReview",
            value: {
              sourceSessionId: "source-session",
              focus: "security and data loss",
              attachments: [
                { kind: ReviewAttachmentKind.IMAGE, displayName: "screen.png", blob: { blobId: "blob-1" } },
                { kind: ReviewAttachmentKind.FILE, displayName: "notes.txt", blob: { blobId: "blob-2" } }
              ]
            }
          });
          return response(method, create(SubmitOperationResponseSchema, { operation: {
            operationId: input.operationId,
            state: OperationState.SUCCEEDED,
            result: { payload: { case: "reviewRun", value: {
              reviewRunId: "review-run-1",
              sourceSessionId: "source-session",
              reviewerSessionId: "reviewer-session",
              state: ReviewRunState.RUNNING,
              targetKind: ReviewTargetKind.MIXED
            } } }
          } }));
        }
        throw new Error(`Unexpected RPC ${method.localName}`);
      }),
      stream: vi.fn(async (method: any) => response(method, idleStream(), true))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway(
      { id: "connection-review", deviceId: "device-test", name: "Review", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();

    const invocationAttachments = [
      { id: "image", kind: "image", file: new File(["i"], "screen.png", { type: "image/png" }) },
      { id: "file", kind: "file", file: new File(["n"], "notes.txt", { type: "text/plain" }) }
    ] as const;
    const started = gateway.startReview("source-session", "  security and data loss  ", invocationAttachments);
    // The caller's next composer mutation must not alter the in-flight Review
    // invocation after startReview reaches its first upload await.
    (invocationAttachments as unknown as unknown[]).splice(0, invocationAttachments.length, {
      id: "later",
      kind: "file",
      file: new File(["x"], "later.txt", { type: "text/plain" })
    });
    await expect(started).resolves.toBe("review-run-1");

    expect(calls.at(-1)).toBe("submit");
    expect(calls.filter((call) => call === "submit")).toHaveLength(1);
    gateway.disconnect();
  });

  it("submits one typed evidence reobservation and waits for the authoritative Review projection", async () => {
    let snapshots = 0;
    const submissions: unknown[] = [];
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        if (method.localName === "getSnapshot") {
          snapshots += 1;
          return response(method, create(GetSnapshotResponseSchema, { snapshot: create(SnapshotSchema) }));
        }
        if (method.localName === "submitOperation") {
          submissions.push(input.mutation?.payload);
          return response(method, create(SubmitOperationResponseSchema, { operation: {
            operationId: input.operationId,
            state: OperationState.SUCCEEDED,
            result: { payload: { case: "reviewRun", value: {
              reviewRunId: "review-run-1",
              sourceSessionId: "source-session",
              reviewerSessionId: "reviewer-session",
              state: ReviewRunState.COMPLETED,
              targetKind: ReviewTargetKind.MIXED
            } } }
          } }));
        }
        throw new Error(`Unexpected RPC ${method.localName}`);
      }),
      stream: vi.fn(async (method: any) => response(method, idleStream(), true))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway(
      { id: "connection-review", deviceId: "device-test", name: "Review", origin: "https://orchestrator.example", serverId: "server-test" },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();

    await expect(gateway.reobserveReview(" review-run-1 ")).resolves.toBeUndefined();

    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({ case: "reobserveReview", value: { reviewRunId: "review-run-1" } });
    expect(snapshots).toBe(2);
    gateway.disconnect();
  });
});

function response(method: any, message: any, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
