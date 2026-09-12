import { create } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import {
  ArtifactKind,
  ArtifactSchema,
  GetSnapshotResponseSchema,
  ListArtifactsResponseSchema,
  SnapshotSchema,
  type Artifact,
  type ListArtifactsResponse
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import { createOrchestratorGateway } from "./gateway.js";

describe("task Artifact catalog gateway", () => {
  it("collects every page from one durable revision and omits expired entries", async () => {
    const requests: Array<{ readonly sessionId?: string; readonly page?: { readonly pageToken?: string } }> = [];
    const responses = [
      responsePage([artifact("artifact-one")], "page-two", 3n, 7n),
      responsePage([
        artifact("artifact-two"),
        artifact("expired", "session-one", create(TimestampSchema, { seconds: 1n }))
      ], "", 3n, 7n)
    ];
    const gateway = gatewayFor((input) => {
      requests.push(input as typeof requests[number]);
      const value = responses.shift();
      if (value === undefined) throw new Error("Unexpected Artifact page.");
      return value;
    });
    await gateway.connect();
    try {
      await expect(gateway.listSessionArtifacts("session-one")).resolves.toEqual([
        expect.objectContaining({ id: "artifact-one", blobId: "blob-artifact-one" }),
        expect.objectContaining({ id: "artifact-two", blobId: "blob-artifact-two" })
      ]);
      expect(requests).toEqual([
        expect.objectContaining({ sessionId: "session-one", page: expect.objectContaining({ pageToken: "" }) }),
        expect.objectContaining({ sessionId: "session-one", page: expect.objectContaining({ pageToken: "page-two" }) })
      ]);
    } finally {
      gateway.disconnect();
    }
  });

  it("restarts the whole catalog after a revision fence abort", async () => {
    let call = 0;
    const gateway = gatewayFor((_input) => {
      call += 1;
      if (call === 1) return responsePage([artifact("stale")], "stale-next", 2n, 7n);
      if (call === 2) throw new ConnectError("catalog changed", Code.Aborted);
      return responsePage([artifact("current")], "", 1n, 8n);
    });
    await gateway.connect();
    try {
      await expect(gateway.listSessionArtifacts("session-one")).resolves.toEqual([
        expect.objectContaining({ id: "current" })
      ]);
      expect(call).toBe(3);
    } finally {
      gateway.disconnect();
    }
  });

  it("rejects an Artifact that is not owned by the requested task", async () => {
    const gateway = gatewayFor(() => responsePage([artifact("foreign", "session-two")], "", 1n, 7n));
    await gateway.connect();
    try {
      await expect(gateway.listSessionArtifacts("session-one")).rejects.toThrow("invalid Artifact catalog identity");
    } finally {
      gateway.disconnect();
    }
  });
});

function artifact(
  id: string,
  sessionId = "session-one",
  expiresAt?: Artifact["expiresAt"]
): Artifact {
  return create(ArtifactSchema, {
    artifactId: id,
    sessionId,
    kind: ArtifactKind.FILE,
    title: id,
    blob: {
      blobId: `blob-${id}`,
      fileName: `${id}.txt`,
      mediaType: "text/plain",
      byteSize: 4n,
      sha256Hex: "a".repeat(64)
    },
    createdAt: create(TimestampSchema, { seconds: 10n }),
    ...(expiresAt === undefined ? {} : { expiresAt })
  });
}

function responsePage(
  artifacts: readonly Artifact[],
  nextPageToken: string,
  totalSize: bigint,
  revision: bigint
): ListArtifactsResponse {
  return create(ListArtifactsResponseSchema, {
    artifacts: [...artifacts],
    page: { nextPageToken, totalSize },
    revision: { value: revision }
  });
}

function gatewayFor(listArtifacts: (input: unknown) => ListArtifactsResponse): ReturnType<typeof createOrchestratorGateway> {
  const transport = {
    unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: unknown) => {
      const message = method.localName === "getSnapshot"
        ? create(GetSnapshotResponseSchema, {
            snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } })
          })
        : method.localName === "listArtifacts"
          ? listArtifacts(input)
          : (() => { throw new Error(`Unexpected method: ${method.localName}`); })();
      return { stream: false, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
    }),
    stream: vi.fn(async (method: any) => ({
      stream: true,
      service: method.parent,
      method,
      header: new Headers(),
      trailer: new Headers(),
      message: idleStream()
    }))
  } as unknown as Transport;
  return createOrchestratorGateway(
    { id: "connection-artifacts", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example", serverId: "server-test" },
    "secret",
    {},
    () => transport
  );
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
