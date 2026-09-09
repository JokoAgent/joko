import { createHash, randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AudioArtifactKind, PermissionMode } from "@joko/contracts";
import type { ImportPortableNativeSessionInput, NativeSessionBinding, PortableNativeSession } from "@joko/core";
import { CredentialManager, CredentialVault, McpRouter, createInternalServer } from "@joko/orchestrator";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { expect, it } from "vitest";
import { InstrumentedFakeAdapter, OrchestratorE2eFixture } from "./fixture.js";
import { createSessionMutation, sessionIdFrom, submit } from "./operations.js";

const cover = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFElEQVQImWP4P4Ph/wwGEP4/gwEAMI4GXTG6t9EAAAAASUVORK5CYII=";

it("publishes inline and resource-linked MCP tracks with one cover through HTTP and retains their identities across portable import", async () => {
  const protocol = new McpServer({ name: "audio-fixture", version: "1.0.0" }, { capabilities: { tools: {}, resources: {} } });
  const responses = new Set<ServerResponse>();
  let calls = 0;
  const reads: string[] = [];
  const audioUri = "https://media.example.test/track?signature=temporary-resource-access";
  protocol.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "tracks", inputSchema: { type: "object" } }] }));
  protocol.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    reads.push(request.params.uri);
    return { contents: [{ uri: request.params.uri, mimeType: "audio/wav", blob: wave().toString("base64") }] };
  });
  protocol.setRequestHandler(CallToolRequestSchema, async () => {
    calls += 1;
    return { content: [{ type: "audio", data: wave().toString("base64"), mimeType: "audio/wav" }, { type: "resource_link", uri: audioUri, name: "audio-result", mimeType: "audio/wav" }, { type: "image", data: cover, mimeType: "image/png" }],
      structuredContent: { jokoAudioArtifacts: [
        { audioContentIndex: 0, kind: "music", title: "Morning", description: "Piano and strings", durationSeconds: 7, artwork: { imageContentIndex: 2, alt: "First cover" } },
        { audioContentIndex: 1, kind: "music", title: "Evening", description: "Quiet melody", artwork: { imageContentIndex: 2, alt: "Second cover" } }
      ] } };
  });
  let transport: SSEServerTransport | undefined;
  const http = createServer((request, response) => {
    responses.add(response); response.on("close", () => responses.delete(response));
    if (request.method === "GET" && request.url === "/events") {
      transport = new SSEServerTransport("/messages", response);
      void protocol.connect(transport).catch(() => response.end());
    } else if (request.method === "POST" && request.url?.startsWith("/messages")) void transport!.handlePostMessage(request, response).catch(() => response.end());
    else { response.writeHead(404); response.end(); }
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("Missing fixture endpoint.");
  let fixture: OrchestratorE2eFixture | undefined;
  let internal: Awaited<ReturnType<typeof createInternalServer>> | undefined;
  try {
    fixture = await OrchestratorE2eFixture.start({
      profiles: [{ ...PI_LIKE_PROFILE, capabilities: [...PI_LIKE_PROFILE.capabilities, { key: "session.portable_transfer", supported: true }] }],
      createAdapter: (profile) => new PortableAudioFixtureAdapter(profile),
      createAuxiliaryServices: async (store, directory, artifacts) => {
      const vault = await CredentialVault.open(join(directory, "audio-vault.key"));
      const credentials = new CredentialManager({ vault, storagePath: join(directory, "audio-credentials.json") });
      await credentials.initialize();
      const mcpRouter = new McpRouter({ store, credentials, resultArtifacts: artifacts });
      await mcpRouter.initialize();
      await mcpRouter.upsert({ id: "audio-fixture", displayName: "Audio fixture", enabled: true, transport: "sse", endpoint: `http://127.0.0.1:${address.port}/events`, credentialBindings: [] });
      return { mcpRouter };
    } });
    internal = await createInternalServer(fixture.application);
    const internalUrl = await internal.listen({ host: "127.0.0.1", port: 0 });
    const paired = await fixture.pair();
    const [backendId, targetId] = [...fixture.targets][0]!;
    const sessionId = sessionIdFrom(await submit(paired.clients.operation, paired.connectionId, createSessionMutation({ backendId, targetId })));
    const generation = fixture.application.store.getSession(sessionId).descriptor.binding.generation;
    const bridge = fixture.application.mcpRouter!.createPiBridgeSnapshot({ endpoint: `${internalUrl}/internal/mcp`, sessionId, targetId, expectedPiGeneration: generation });
    const request = { requestId: randomUUID(), sessionId, targetId, generation, serverId: "audio-fixture", toolName: "tracks", arguments: {} };
    const call = async () => (await fetch(`${internalUrl}/internal/mcp`, { method: "POST", headers: { authorization: `Bearer ${bridge.mcpBridge.token}`, "content-type": "application/json", "x-joko-pi-generation": String(generation) }, body: JSON.stringify(request) })).json();
    expect(await call()).toMatchObject({ isError: false });
    expect(await call()).toMatchObject({ isError: false });
    expect(calls).toBe(1);
    expect(reads).toEqual([audioUri]);
    const original = (await paired.clients.artifact.listArtifacts({ sessionId })).artifacts;
    const tracks = original.filter((artifact) => artifact.audioMetadata !== undefined).sort((a, b) => a.title.localeCompare(b.title));
    expect(tracks.map((artifact) => artifact.title)).toEqual(["Evening", "Morning"]);
    expect(tracks[0]!.artifactId).not.toBe(tracks[1]!.artifactId);
    expect(tracks[0]!.blob!.sha256Hex).toBe(tracks[1]!.blob!.sha256Hex);
    expect(tracks.map((artifact) => artifact.audioMetadata!.artwork!.altText)).toEqual(["Second cover", "First cover"]);
    expect(tracks[0]!.audioMetadata!.artwork!.blob!.blobId).toBe(tracks[1]!.audioMetadata!.artwork!.blob!.blobId);
    expect(tracks[1]!.audioMetadata).toMatchObject({ kind: AudioArtifactKind.MUSIC, durationSeconds: 7, artwork: { widthPixels: 2, heightPixels: 2 } });
    const storedEvents = fixture.application.store.listEvents({ sessionId }).filter((event) => event.payload.type === "artifact");
    expect(storedEvents).toHaveLength(2);
    expect(new Set(storedEvents.map((event) => event.revision)).size).toBe(1);
    expect(JSON.stringify(fixture.application.store.listOperations().map((operation) => operation.response))).not.toContain(cover);
    expect(JSON.stringify(fixture.application.store.listOperations().map((operation) => operation.response))).not.toContain(audioUri);
    const exported = await paired.clients.portableSession.exportPortableSession({ sessionId });
    expect(exported.mediaCount).toBe(3n);
    const inspected = await paired.clients.portableSession.inspectPortableSessionImport({ package: exported.artifact });
    const imported = await paired.clients.portableSession.commitPortableSessionImport({ operationId: randomUUID(), draftId: inspected.draft!.draftId, targetId, title: "Imported tracks", permissionMode: PermissionMode.ASK });
    const importedId = imported.result!.sessionId;
    const restored = (await paired.clients.artifact.listArtifacts({ sessionId: importedId })).artifacts.filter((artifact) => artifact.audioMetadata !== undefined).sort((a, b) => a.title.localeCompare(b.title));
    expect(restored.map((artifact) => artifact.description)).toEqual(["Quiet melody", "Piano and strings"]);
    expect(restored[0]!.artifactId).not.toBe(tracks[0]!.artifactId);
    expect(restored[0]!.audioMetadata!.artwork!.blob!.blobId).not.toBe(tracks[0]!.audioMetadata!.artwork!.blob!.blobId);
    expect((await paired.clients.artifact.getArtifact({ artifactId: restored[1]!.artifactId })).artifact!.audioMetadata).toEqual(restored[1]!.audioMetadata);
    const snapshot = await paired.clients.event.getSnapshot({ scope: { kind: { case: "session", value: { sessionId: importedId, recentTimelineItems: 200 } } } });
    const visible = snapshot.snapshot!.timeline.flatMap((event) => event.payload?.kind.case === "artifactProduced" ? [event.payload.kind.value.artifact!] : []);
    expect(visible.map((artifact) => artifact.audioMetadata!.title).sort()).toEqual(["Evening", "Morning"]);
    expect(visible.every((artifact) => artifact.audioMetadata!.artwork!.blob!.blobId === restored[0]!.audioMetadata!.artwork!.blob!.blobId)).toBe(true);
    expect(fixture.application.store.listEvents({ sessionId: importedId }).filter((event) => event.payload.type === "artifact")).toHaveLength(2);
    await fixture.application.artifacts.garbageCollect();
    for (const artifact of restored) {
      const blob = fixture.application.store.getArtifact(artifact.artifactId).blob;
      expect((await fixture.application.artifacts.readBlob(blob)).data).toEqual(wave());
    }
  } finally {
    await internal?.close();
    await fixture?.close(); await protocol.close();
    for (const response of responses) response.end();
    http.closeAllConnections(); await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});

class PortableAudioFixtureAdapter extends InstrumentedFakeAdapter {
  async exportPortableNativeSession(): Promise<PortableNativeSession> {
    const bytes = Buffer.from('{"type":"session","id":"audio-history"}\n');
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), nativeSessionId: "audio-history" };
  }

  async importPortableNativeSession(input: ImportPortableNativeSessionInput, signal: AbortSignal): Promise<NativeSessionBinding> {
    signal.throwIfAborted();
    return { opaqueRef: `fake://${this.id}/portable/${randomUUID()}`, nativeSessionId: randomUUID(), generation: input.generation };
  }
}

function wave(): Buffer {
  const data = Buffer.alloc(44 + 160);
  data.write("RIFF"); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write("data", 36); data.writeUInt32LE(160, 40);
  return data;
}
