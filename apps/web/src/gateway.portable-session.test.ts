import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import {
  BeginBlobUploadResponseSchema,
  BlobDisposition,
  CommitPortableSessionImportResponseSchema,
  CompleteBlobUploadResponseSchema,
  ExportPortableSessionResponseSchema,
  GetBlobDownloadTicketResponseSchema,
  GetSnapshotResponseSchema,
  InspectPortableSessionImportResponseSchema,
  PortableSessionFidelity,
  PortableSessionImportStatus,
  RetryPortableSessionActivationResponseSchema,
  SnapshotSchema,
  TransferDirection,
  UnlockPortableSessionImportResponseSchema,
  WorkspaceKind
} from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOrchestratorGateway, GatewayError } from "./gateway.js";

describe("portable task package gateway", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("exports through the native save boundary and returns typed oversize details", async () => {
    const saveFile = vi.fn(async () => true);
    vi.stubGlobal("window", { jokoDesktop: { saveFile } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "application/vnd.joko.session" }
    })));
    let oversize = false;
    const transport = portableTransport(async (method, input) => {
      if (method.localName === "exportPortableSession") {
        if (oversize) {
          expect(input).toEqual({ sessionId: "session-1", excludeMedia: false });
          throw new ConnectError("Package too large.", Code.ResourceExhausted, {
            "x-joko-portable-media-bytes": "7340032",
            "x-joko-portable-limit-bytes": "10485760"
          });
        }
        expect(input).toMatchObject({ sessionId: "session-1", password: "transient", excludeMedia: false });
        return response(method, create(ExportPortableSessionResponseSchema, {
          artifact: portableBlob("export-1", "portable-task.jshare", BlobDisposition.EXPORT),
          fidelity: PortableSessionFidelity.FULL,
          messageCount: 4n,
          mediaCount: 1n,
          workerCount: 2n,
          mediaBytes: 3n
        }));
      }
      if (method.localName === "getBlobDownloadTicket") {
        expect(input).toEqual({ blobId: "export-1" });
        return response(method, create(GetBlobDownloadTicketResponseSchema, {
          ticket: {
            ticketId: "download-1",
            blobId: "export-1",
            direction: TransferDirection.DOWNLOAD,
            relativeEndpoint: "/v1/blob-downloads/download-1",
            maximumBytes: 3n,
            requiredMediaType: "application/vnd.joko.session"
          }
        }));
      }
      throw new Error(`Unexpected RPC ${method.localName}`);
    });
    const gateway = createGateway(transport);
    await gateway.connect();

    await expect(gateway.exportPortableSession("session-1", {
      password: "transient",
      excludeMedia: false
    })).resolves.toEqual({ status: "exported", fidelity: "full" });
    expect(saveFile).toHaveBeenCalledWith({
      name: "portable-task.jshare",
      mediaType: "application/vnd.joko.session",
      bytes: new Uint8Array([1, 2, 3])
    });

    oversize = true;
    await expect(gateway.exportPortableSession("session-1", {
      excludeMedia: false
    })).resolves.toEqual({
      status: "oversize",
      mediaBytes: 7_340_032,
      limitBytes: 10_485_760
    });
    gateway.disconnect();
  });

  it("uploads, inspects, unlocks, cancels and commits with transient secrets and typed conflicts", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls.push("put");
      return new Response(undefined, { status: 204 });
    }));
    let wrongPassword = true;
    let conflict = false;
    const transport = portableTransport(async (method, input) => {
      if (method.localName === "beginBlobUpload") {
        calls.push("begin");
        expect(input).toMatchObject({
          fileName: "portable-task.jshare",
          mediaType: "application/vnd.joko.session",
          byteSize: 7n,
          disposition: BlobDisposition.ATTACHMENT
        });
        return response(method, create(BeginBlobUploadResponseSchema, {
          upload: {
            uploadId: "upload-1",
            ticket: {
              ticketId: "upload-ticket",
              direction: TransferDirection.UPLOAD,
              relativeEndpoint: "/v1/blob-uploads/upload-ticket",
              maximumBytes: 7n,
              requiredMediaType: "application/octet-stream"
            },
            expectedByteSize: 7n
          }
        }));
      }
      if (method.localName === "completeBlobUpload") {
        calls.push("complete");
        return response(method, create(CompleteBlobUploadResponseSchema, {
          blob: portableBlob("package-1", "portable-task.jshare", BlobDisposition.ATTACHMENT, 7n)
        }));
      }
      if (method.localName === "inspectPortableSessionImport") {
        calls.push("inspect");
        expect(input.package).toMatchObject({ blobId: "package-1" });
        return response(method, create(InspectPortableSessionImportResponseSchema, {
          draft: {
            draftId: "draft-1",
            expiresAt: { seconds: 2_000_000_000n, nanos: 0 },
            encrypted: true,
            passwordRequired: true
          }
        }));
      }
      if (method.localName === "unlockPortableSessionImport") {
        calls.push("unlock");
        expect(input).toEqual({ draftId: "draft-1", password: wrongPassword ? "wrong" : "right" });
        if (wrongPassword) throw new ConnectError("Integrity check failed.", Code.InvalidArgument);
        return response(method, create(UnlockPortableSessionImportResponseSchema, {
          draft: previewDraft()
        }));
      }
      if (method.localName === "cancelPortableSessionImport") {
        calls.push("cancel");
        expect(input).toEqual({ draftId: "draft-1" });
        return response(method, { cancelled: true });
      }
      if (method.localName === "commitPortableSessionImport") {
        calls.push("commit");
        expect(input).toMatchObject({
          draftId: "draft-1",
          targetId: "target-1",
          model: {
            model: { providerId: "provider-1", modelId: "model-1" },
            effortId: "high",
            fastMode: true
          },
          planMode: true,
          overwrite: false,
          useWorktree: true,
          worktreeSourceRef: "refs/heads/main",
          refreshWorktreeRemote: true
        });
        expect(input.operationId).toMatch(/^[0-9a-f-]{36}$/);
        if (conflict) throw new ConnectError("An imported task already exists.", Code.AlreadyExists);
        return response(method, create(CommitPortableSessionImportResponseSchema, {
          result: {
            sessionId: "session-imported",
            fidelity: PortableSessionFidelity.PARTIAL,
            messageCount: 8n,
            mediaCount: 2n,
            workerCount: 1n,
            replacedSessionIds: ["session-old"],
            status: PortableSessionImportStatus.READY
          }
        }));
      }
      if (method.localName === "retryPortableSessionActivation") {
        expect(input).toEqual({ sessionId: "session-imported" });
        return response(method, create(RetryPortableSessionActivationResponseSchema, {
          sessionId: "session-imported",
          status: PortableSessionImportStatus.READY
        }));
      }
      throw new Error(`Unexpected RPC ${method.localName}`);
    });
    const gateway = createGateway(transport);
    await gateway.connect();

    const file = new File(["package"], "portable-task.jshare", { type: "application/vnd.joko.session" });
    await expect(gateway.inspectPortableSessionImport(file)).resolves.toMatchObject({
      draftId: "draft-1",
      encrypted: true,
      passwordRequired: true
    });
    expect(calls.slice(0, 4)).toEqual(["begin", "put", "complete", "inspect"]);

    await expect(gateway.unlockPortableSessionImport("draft-1", "wrong")).rejects.toMatchObject({
      code: "DECRYPTION_FAILED"
    } satisfies Partial<GatewayError>);
    wrongPassword = false;
    await expect(gateway.unlockPortableSessionImport("draft-1", "right")).resolves.toMatchObject({
      passwordRequired: false,
      preview: {
        title: "Imported task",
        workspaceKind: "project",
        fidelity: "partial",
        messageCount: 8,
        mediaCount: 2,
        workerCount: 1
      }
    });

    await expect(gateway.cancelPortableSessionImport("draft-1")).resolves.toBeUndefined();
    const commit = {
      draftId: "draft-1",
      targetId: "target-1",
      execution: {
        providerId: "provider-1",
        modelId: "model-1",
        effort: "high",
        fastMode: true,
        permissionMode: "ask" as const,
        planMode: true
      },
      overwrite: false,
      useWorktree: true,
      worktreeSourceRef: "refs/heads/main",
      refreshWorktreeRemote: true
    };
    await expect(gateway.commitPortableSessionImport(commit)).resolves.toEqual({
      sessionId: "session-imported",
      fidelity: "partial",
      messageCount: 8,
      mediaCount: 2,
      workerCount: 1,
      replacedSessionIds: ["session-old"],
      status: "ready"
    });
    await expect(gateway.retryPortableSessionActivation("session-imported")).resolves.toEqual({
      sessionId: "session-imported",
      status: "ready"
    });
    conflict = true;
    await expect(gateway.commitPortableSessionImport(commit)).rejects.toMatchObject({
      code: "PORTABLE_SESSION_IMPORT_CONFLICT"
    } satisfies Partial<GatewayError>);
    gateway.disconnect();
  });
});

function previewDraft() {
  return {
    draftId: "draft-1",
    expiresAt: { seconds: 2_000_000_000n, nanos: 0 },
    encrypted: true,
    passwordRequired: false,
    preview: {
      title: "Imported task",
      workspaceKind: WorkspaceKind.USER_PROJECT,
      exportedAt: { seconds: 1_800_000_000n, nanos: 0 },
      applicationVersion: "0.1.0",
      formatVersion: 1,
      backendCapability: "native-portable-session-v1",
      fidelity: PortableSessionFidelity.PARTIAL,
      messageCount: 8n,
      mediaCount: 2n,
      workerCount: 1n,
      nativeHistory: true
    }
  };
}

function portableBlob(
  blobId: string,
  fileName: string,
  disposition: BlobDisposition,
  byteSize = 3n
) {
  return {
    blobId,
    fileName,
    mediaType: "application/vnd.joko.session",
    byteSize,
    sha256Hex: "a".repeat(64),
    disposition
  };
}

function createGateway(transport: Transport) {
  return createOrchestratorGateway(
    { id: "connection-1", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
    "secret",
    {},
    () => transport
  );
}

function portableTransport(handler: (method: any, input: any) => Promise<any>): Transport {
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
      if (method.localName === "listManagedModelRuntimes") {
        throw new ConnectError("Managed local models are unavailable.", Code.Unimplemented);
      }
      return handler(method, input);
    }),
    stream: vi.fn(async (method: any) => response(method, idleStream(), true))
  } as unknown as Transport;
}

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
