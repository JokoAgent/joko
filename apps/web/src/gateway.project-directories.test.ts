import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import { GetSnapshotResponseSchema, ListProjectDirectoriesResponseSchema, SnapshotSchema } from "@joko/contracts";
import { expect, it, vi } from "vitest";

import { createOrchestratorGateway } from "./gateway.js";

it("reads only the captured connection's service directory and retires a late response on cancellation", async () => {
  let resolveListing!: () => void;
  let requestSignal: AbortSignal | undefined;
  let requestPath: string | undefined;
  const transport = {
    unary: vi.fn(async (method: any, signal: AbortSignal | undefined, _timeout: unknown, _headers: unknown, input: any) => {
      if (method.localName === "getSnapshot") return response(method, create(GetSnapshotResponseSchema, {
        snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } })
      }));
      if (method.localName !== "listProjectDirectories") throw new Error(`Unexpected method: ${method.localName}`);
      requestSignal = signal;
      requestPath = input.path;
      await new Promise<void>((resolve) => { resolveListing = resolve; });
      return response(method, create(ListProjectDirectoriesResponseSchema, {
        path: "/srv/projects", parentPath: "/srv", directories: [{ name: "alpha", path: "/srv/projects/alpha" }]
      }));
    }),
    stream: vi.fn(async (method: any) => response(method, idleStream(), true))
  } as unknown as Transport;
  const gateway = createOrchestratorGateway(
    { id: "connection-1", deviceId: "device-1", serverId: "server-1", name: "Remote", origin: "https://remote.example.test" },
    "secret", {}, () => transport
  );
  await gateway.connect();
  try {
    const cancellation = new AbortController();
    const pending = gateway.listProjectDirectories("/srv/projects", cancellation.signal);
    await vi.waitFor(() => expect(requestPath).toBe("/srv/projects"));
    expect(requestSignal?.aborted).toBe(false);
    cancellation.abort();
    resolveListing();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(requestSignal?.aborted).toBe(true);
  } finally {
    gateway.disconnect();
  }
});

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
