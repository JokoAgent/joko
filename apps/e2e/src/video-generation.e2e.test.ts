import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  BlobDisposition, CredentialKind, CredentialService, InputPartSchema, ModelInputModality, OperationMutationSchema, OperationState,
  PermissionMode, ProviderApiCompatibility, ProviderKind, type BlobRef
} from "@joko/contracts";
import { expect, it } from "vitest";
import { waitFor } from "./fixture.js";
import { createSessionMutation, queueRunIdFrom, sendInputMutation, sessionIdFrom, submit } from "./operations.js";
import { REAL_PI_MODEL_ID, REAL_PI_PROVIDER_ID, RealPiSystemFixture, type RealPiSystemFixtureOptions } from "./real-pi-fixture.js";

it("submits one configured video request and recovers the original clip after restart", { timeout: 100_000 }, async () => {
  const fixtureKey = "owned-video-fixture-key";
  const providerTaskId = "controlled-video-job";
  const lostReplyPrompt = "The provider accepts the request and loses its reply.";
  const clip = Buffer.from("000000186674797069736f6d0000020069736f6d6d703431", "hex");
  const submissions: { authenticated: boolean; body: unknown }[] = [];
  const polls: { authenticated: boolean; original: boolean }[] = [];
  const downloads: { hasCredential: boolean }[] = [];
  const upstream = createServer((request, response) => {
    void (async () => {
      if (request.method === "POST" && request.url === "/gateway/v1/videos/generations") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { readonly prompt?: string };
        submissions.push({ authenticated: request.headers.authorization === `Bearer ${fixtureKey}`, body });
        if (body.prompt === lostReplyPrompt) { response.destroy(); return; }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ request_id: providerTaskId }));
        return;
      }
      if (request.method === "GET" && request.url?.startsWith("/gateway/v1/videos/")) {
        polls.push({ authenticated: request.headers.authorization === `Bearer ${fixtureKey}`,
          original: request.url === `/gateway/v1/videos/${providerTaskId}` });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(polls.length === 1 ? { status: "pending" }
          : { status: "done", video: { url: `${origin}/clip.mp4?ticket=fixture`, duration: 5 } }));
        return;
      }
      if (request.method === "GET" && request.url === "/clip.mp4?ticket=fixture") {
        downloads.push({ hasCredential: request.headers.authorization !== undefined || request.headers["x-api-key"] !== undefined });
        response.writeHead(downloads.length === 1 ? 503 : 200, { "content-type": "video/mp4" });
        response.end(downloads.length === 1 ? undefined : clip);
        return;
      }
      response.writeHead(404).end();
    })().catch(() => response.destroy());
  });
  await new Promise<void>((done, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", done);
  });
  const address = upstream.address();
  if (address === null || typeof address === "string") throw new Error("The fixture video provider has no address.");
  const origin = `http://127.0.0.1:${address.port}`;
  let nextTool: { readonly name: string; readonly arguments: Readonly<Record<string, unknown>> } | undefined;
  const providerResponder: NonNullable<RealPiSystemFixtureOptions["providerResponder"]> = ({ request }) => {
    const tool = nextTool;
    if (tool === undefined) return { kind: "text", text: "The video request returned." };
    const definitions = request.body["tools"] as readonly { function?: { name?: string } }[];
    const name = definitions?.find(definition => definition.function?.name?.endsWith(tool.name))?.function?.name;
    expect(name).toBeDefined();
    nextTool = undefined;
    return { kind: "tool", name: name!, arguments: tool.arguments };
  };
  let fixture: RealPiSystemFixture | undefined;
  try {
    fixture = await RealPiSystemFixture.start({ keepRoot: true, providerResponder, providerSupportsImages: true, enableInternalServer: true });
    const owner = await fixture.pair("Video request owner");
    const originOfNode = fixture.baseUrl;
    let clients = owner.clients;
    const client = createClient(CredentialService, createConnectTransport({ baseUrl: originOfNode, httpVersion: "1.1",
      interceptors: [next => request => { request.header.set("authorization", `Bearer ${owner.authKey}`); return next(request); }] }));
    const mutate = (payload: MessageInitShape<typeof OperationMutationSchema>["payload"]) =>
      submit(clients.operation, owner.connectionId, create(OperationMutationSchema, { payload }));
    const saveCredential = async (key: string) => {
      const ticket = (await client.beginCredentialUpload({ kind: CredentialKind.API_KEY, providerId: "" })).ticket!;
      expect((await fetch(new URL(ticket.relativeEndpoint, originOfNode), { method: "PUT", headers: {
        authorization: `Bearer ${owner.authKey}`, "content-type": "application/octet-stream"
      }, body: key })).ok).toBe(true);
      const saved = await mutate({ case: "commitCredential", value: {
        credentialUploadTicketId: ticket.ticketId, credentialReferenceId: "video-owned-credential",
        displayName: "Video fixture key", kind: CredentialKind.API_KEY, providerId: ""
      } });
      expect(saved.state, saved.error?.message).toBe(OperationState.SUCCEEDED);
    };
    await saveCredential(fixtureKey);
    const added = await mutate({ case: "upsertProvider", value: { provider: {
      providerId: "fixture-video", displayName: "Fixture video", kind: ProviderKind.CUSTOM_ENDPOINT, enabled: true,
      version: { revision: { value: 0n } }, runtimes: [{
        backendId: "pi", endpoint: `${origin}/gateway`, credentialOrigin: origin,
        apiCompatibility: ProviderApiCompatibility.OPENAI_COMPLETIONS, credentialReferenceId: "video-owned-credential",
        apiKeyEnvironment: "JOKO_FIXTURE_VIDEO_KEY", authHeader: true,
        models: [{ modelId: "local-video", displayName: "Fixture video model", mode: "xai_video",
          inputModalities: [ModelInputModality.TEXT, ModelInputModality.IMAGE] }]
      }]
    } } });
    expect(added.state, added.error?.message).toBe(OperationState.SUCCEEDED);
    expect(fixture.application.providers!.resolveInferenceRoute("pi", "fixture-video", "local-video")).toBeUndefined();

    const targetId = "workspace-real-pi";
    const target = fixture.application.store.getTarget(targetId);
    fixture.application.store.upsertTarget({ ...target.descriptor, trusted: true }, target.metadata);
    const createTask = async () => sessionIdFrom(await submit(owner.clients.operation, owner.connectionId, createSessionMutation({
      targetId, backendId: "pi", providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID, permissionMode: PermissionMode.BYPASS_PERMISSIONS
    })));
    const sessionId = await createTask();
    const otherId = await createTask();
    const invoke = async (task: string, name: string, id: string = randomUUID(), image?: BlobRef) => {
      const store = fixture!.application.store;
      const generation = BigInt(store.getSession(task).descriptor.binding.generation);
      const input = sendInputMutation(task, generation, `Run fixture tool ${name}.`);
      if (image !== undefined && input.payload.case === "sendInput") {
        input.payload.value.input!.parts.push(create(InputPartSchema, { content: { case: "image", value: { blob: image } } }));
      }
      const operation = await submit(clients.operation, owner.connectionId, input, id);
      expect(operation.state, operation.error?.message).toBe(OperationState.SUCCEEDED);
      const runId = queueRunIdFrom(operation);
      const terminal = await waitFor(async () => store.getRun(runId).descriptor,
        run => run.state === "completed" || run.state === "failed", "the original video tool turn", 20_000);
      expect(terminal.state, terminal.error?.code).toBe("completed");
      const result = store.listEvents({ sessionId: task }).find(event => event.runId === runId
        && event.payload.type === "tool_result" && event.payload.name.endsWith(name));
      if (result?.payload.type !== "tool_result") throw new Error("The original video tool result is unavailable.");
      return result.payload;
    };
    const tool = (task: string, name: string, args: Readonly<Record<string, unknown>>, id?: string, image?: BlobRef) => {
      nextTool = { name, arguments: args };
      return invoke(task, name, id, image);
    };
    const arguments_ = { model: "pi/fixture-video/local-video", prompt: "A still view of the shoreline.", duration: 5, resolution: "720p" };
    const operationId = randomUUID();
    const first = await tool(sessionId, "video_generate", arguments_, operationId);
    expect(first.isError, first.output).toBe(false);
    const { receipt } = JSON.parse(first.output) as { receipt: string };
    const replayed = await invoke(sessionId, "video_generate", operationId);
    expect(replayed.output).toEqual(first.output);
    expect(submissions).toEqual([{ authenticated: true,
      body: { model: "local-video", prompt: arguments_.prompt, duration: 5, resolution: "720p" } }]);
    expect((await tool(otherId, "video_status", { receipt })).isError).toBe(true);
    expect(polls).toHaveLength(0);
    expect(JSON.parse((await tool(sessionId, "video_status", { receipt })).output)).toMatchObject({ receipt, status: "pending" });
    expect(JSON.parse((await tool(sessionId, "video_status", { receipt })).output)).toMatchObject({ receipt, status: "download_unavailable" });
    const originalGeneration = fixture.application.store.getSession(sessionId).descriptor.binding.generation;
    const { rootDirectory } = fixture;
    const port = Number(new URL(fixture.baseUrl).port), internalPort = Number(new URL(fixture.application.config.internalOrigin).port);
    await fixture.close({ removeRoot: false });
    fixture = await RealPiSystemFixture.start({ rootDirectory, keepRoot: true, providerResponder, providerSupportsImages: true,
      enableInternalServer: true, port, internalPort });
    clients = fixture.clients(owner.authKey);
    const completedTurn = await tool(sessionId, "video_status", { receipt });
    const currentGeneration = fixture.application.store.getSession(sessionId).descriptor.binding.generation;
    expect(completedTurn.isError, JSON.stringify({ outcome: completedTurn.output, originalGeneration, currentGeneration,
      polls: polls.length, downloads: downloads.length })).toBe(false);
    const completed = JSON.parse(completedTurn.output) as { status: string; blobId: string };
    expect(completed.status).toBe("done");
    expect(fixture.application.store.getArtifact(completed.blobId).blob).toMatchObject({
      sha256: createHash("sha256").update(clip).digest("hex"), byteLength: clip.length, mimeType: "video/mp4"
    });
    const clipTicket = (await clients.artifact.getBlobDownloadTicket({ blobId: completed.blobId })).ticket!;
    const clipResponse = await fetch(new URL(clipTicket.relativeEndpoint, fixture.baseUrl), {
      headers: { authorization: `Bearer ${owner.authKey}` }
    });
    expect(clipResponse.status).toBe(200);
    expect(Buffer.from(await clipResponse.arrayBuffer())).toEqual(clip);
    expect(JSON.parse((await tool(sessionId, "video_status", { receipt })).output)).toEqual(completed);
    expect(submissions).toHaveLength(1);
    expect(polls).toEqual(Array.from({ length: 3 }, () => ({ authenticated: true, original: true })));
    expect(downloads).toEqual([{ hasCredential: false }, { hasCredential: false }]);
    expect(first.output).not.toMatch(/controlled-video-job|fixture-key|ticket=/u);

    const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const upload = (await clients.artifact.beginBlobUpload({ fileName: "pixel.png", mediaType: "image/png",
      byteSize: BigInt(pixel.length), sha256Hex: createHash("sha256").update(pixel).digest("hex"),
      disposition: BlobDisposition.ATTACHMENT })).upload!;
    const put = await fetch(new URL(upload.ticket!.relativeEndpoint, fixture.baseUrl), { method: "PUT",
      headers: { authorization: `Bearer ${owner.authKey}`, "content-type": "application/octet-stream" }, body: pixel });
    expect(put.status).toBe(201);
    const attached = (await clients.artifact.completeBlobUpload({ uploadId: upload.uploadId })).blob!;
    const imageRequest = { ...arguments_, image_blob_id: attached.blobId };
    expect((await tool(sessionId, "video_generate", imageRequest)).isError).toBe(true);
    expect(submissions).toHaveLength(1);
    const animated = await tool(sessionId, "video_generate", imageRequest, undefined, attached);
    expect(animated.isError, animated.output).toBe(false);
    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toMatchObject({ authenticated: true,
      body: { image: { url: `data:image/png;base64,${pixel.toString("base64")}` } } });

    const lostOperation = randomUUID();
    const unknown = await tool(sessionId, "video_generate", { ...arguments_, prompt: lostReplyPrompt }, lostOperation);
    expect(unknown.isError, unknown.output).toBe(false);
    const pendingSubmission = JSON.parse(unknown.output) as { receipt: string; status: string };
    expect(pendingSubmission.status).toBe("submission_unknown");
    expect((await invoke(sessionId, "video_generate", lostOperation)).output).toBe(unknown.output);
    expect(JSON.parse((await tool(sessionId, "video_status", { receipt: pendingSubmission.receipt })).output)).toEqual(pendingSubmission);
    expect(submissions).toHaveLength(3);
    expect(polls).toHaveLength(3);

    const animatedReceipt = (JSON.parse(animated.output) as { receipt: string }).receipt;
    await saveCredential("replacement-owned-video-key");
    const stale = await tool(sessionId, "video_status", { receipt: animatedReceipt });
    expect(stale.isError).toBe(true);
    expect(submissions).toHaveLength(3);
    expect(polls).toHaveLength(3);
  } finally {
    try { await fixture?.close({ removeRoot: true }); }
    finally {
      upstream.closeAllConnections();
      await new Promise<void>(done => upstream.close(() => done()));
    }
  }
});
