import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  GetBlobDownloadTicketResponseSchema,
  GetSnapshotResponseSchema,
  SnapshotSchema,
  TransferDirection
} from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOrchestratorGateway } from "./gateway.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("artifact URL gateway leases", () => {
  it("shares one pending URL and revokes it only after the final release", async () => {
    const fetchArtifact = vi.fn(async () => new Response(new Blob(["media"], { type: "audio/ogg" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchArtifact);
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValueOnce("blob:shared").mockReturnValueOnce("blob:next");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const gateway = createOrchestratorGateway(
      { id: "connection-artifact", deviceId: "device-test", name: "Desktop", origin: "https://orchestrator.example", serverId: "server-test" },
      "secret",
      {},
      () => artifactTransport()
    );
    await gateway.connect();

    const first = gateway.getArtifactUrl("artifact");
    const second = gateway.getArtifactUrl("artifact");
    await expect(Promise.all([first, second])).resolves.toEqual(["blob:shared", "blob:shared"]);
    expect(fetchArtifact).toHaveBeenCalledOnce();
    expect(createObjectUrl).toHaveBeenCalledOnce();

    gateway.releaseArtifactUrl("artifact");
    expect(revokeObjectUrl).not.toHaveBeenCalled();
    gateway.releaseArtifactUrl("artifact");
    expect(revokeObjectUrl).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).toHaveBeenLastCalledWith("blob:shared");

    await expect(gateway.getArtifactUrl("artifact")).resolves.toBe("blob:next");
    expect(fetchArtifact).toHaveBeenCalledTimes(2);
    gateway.releaseArtifactUrl("artifact");
    expect(revokeObjectUrl).toHaveBeenCalledTimes(2);
    gateway.disconnect();
  });

  it("revokes an acquisition that completes after its final owner releases it", async () => {
    const response = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => response.promise));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:late");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const gateway = createOrchestratorGateway(
      { id: "connection-artifact", deviceId: "device-test", name: "Desktop", origin: "https://orchestrator.example", serverId: "server-test" },
      "secret",
      {},
      () => artifactTransport()
    );
    await gateway.connect();

    const pending = gateway.getArtifactUrl("artifact");
    gateway.releaseArtifactUrl("artifact");
    response.resolve(new Response(new Blob(["media"], { type: "video/mp4" }), { status: 200 }));
    await expect(pending).resolves.toBe("blob:late");
    expect(revokeObjectUrl).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:late");
    gateway.disconnect();
  });
});

function artifactTransport(): Transport {
  return {
    unary: vi.fn(async (method: any) => {
      const message = method.localName === "getSnapshot"
        ? create(GetSnapshotResponseSchema, { snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } }) })
        : method.localName === "getBlobDownloadTicket"
          ? create(GetBlobDownloadTicketResponseSchema, {
            ticket: {
              ticketId: "ticket",
              blobId: "artifact",
              direction: TransferDirection.DOWNLOAD,
              relativeEndpoint: "/blob/artifact"
            }
          })
          : (() => { throw new Error(`Unexpected method ${method.localName}`); })();
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
}

async function* idleStream(): AsyncGenerator<never> {
  await new Promise<void>(() => undefined);
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}
