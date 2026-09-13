import { create } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import { ArtifactKind, ArtifactSchema, GetArtifactResponseSchema, GetSnapshotResponseSchema, SnapshotSchema, type Artifact } from "@joko/contracts";
import { expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";

it("reads only the original task's live canonical Artifact and fences late replies on cancellation or disconnect", async () => {
  const live = create(ArtifactSchema, { artifactId: "artifact", sessionId: "session", title: "Export", kind: ArtifactKind.FILE, blob: { blobId: "blob", fileName: "export.txt", mediaType: "text/plain", byteSize: 3n } });
  let artifact: Artifact | undefined = live;
  let artifactError: Error | undefined;
  let wait: Promise<void> | undefined;
  const transport = { unary: vi.fn(async (method, _signal, _timeout, _headers, input) => {
    let message;
    if (method.localName === "getSnapshot") message = create(GetSnapshotResponseSchema, { snapshot: create(SnapshotSchema) });
    else if (method.localName === "getArtifact") {
      expect(input).toMatchObject({ artifactId: "artifact" });
      await wait;
      if (artifactError !== undefined) throw artifactError;
      message = create(GetArtifactResponseSchema, { artifact });
    } else throw new Error(`Unexpected RPC ${method.localName}`);
    return { stream: false, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
  }), stream: vi.fn(async (method: any) => ({ stream: true, service: method.parent, method, header: new Headers(), trailer: new Headers(), message: idleStream() })) } as Transport;
  const gateway = createOrchestratorGateway({ id: "connection", deviceId: "device", name: "Browser", origin: "https://orchestrator.example", serverId: "server" }, "secret", {}, () => transport);
  await gateway.connect();
  try {
    await expect(gateway.readSessionArtifact("session", "artifact", new AbortController().signal)).resolves.toMatchObject({ id: "artifact", blobId: "blob", title: "Export" });
    const unavailable: readonly (Artifact | undefined)[] = [
      create(ArtifactSchema, { ...live, sessionId: "other" }),
      create(ArtifactSchema, { ...live, artifactId: "other" }),
      create(ArtifactSchema, { ...live, expiresAt: create(TimestampSchema, { seconds: 1n, nanos: 0 }) }),
      create(ArtifactSchema, { ...live, blob: undefined }),
      undefined
    ];
    for (const changed of unavailable) {
      artifact = changed;
      await expect(gateway.readSessionArtifact("session", "artifact", new AbortController().signal)).rejects.toThrow("unavailable in its original task");
    }
    artifactError = new ConnectError("Artifact not found", Code.NotFound);
    await expect(gateway.readSessionArtifact("session", "artifact", new AbortController().signal)).rejects.toThrow("unavailable in its original task");
    artifactError = undefined;
    artifact = live;
    for (const retire of ["cancel", "disconnect"] as const) {
      let release!: () => void;
      wait = new Promise<void>((resolve) => { release = resolve; });
      const controller = new AbortController();
      const read = gateway.readSessionArtifact("session", "artifact", controller.signal);
      const rejected = expect(read).rejects.toThrow();
      if (retire === "cancel") controller.abort(); else gateway.disconnect();
      release();
      await rejected;
    }
  } finally { gateway.disconnect(); }
});

async function* idleStream(): AsyncIterable<never> { await new Promise<never>(() => undefined); }
