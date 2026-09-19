import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  CapabilitySupport,
  BrowserAutomationTarget,
  BrowserSettingsSchema,
  GitDiffSource,
  OperationMutationSchema,
  OpenBrowserPageMutationSchema,
  OperationState,
  QueueDeliveryMode,
  RestartBrowserMutationSchema,
  RevokeDeviceMutationSchema,
  WorkspaceEntryListingPolicy,
  WorkspaceFileChangeKind
} from "@joko/contracts";
import {
  CODEX_LIKE_PROFILE,
  MINIMAL_PROFILE,
  PI_LIKE_PROFILE,
  type FakeAdapterProfile
} from "@joko/testkit";
import { OperationalBrowserState, type OrchestratorApplication } from "@joko/orchestrator";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OrchestratorE2eFixture, sha256, waitFor } from "./fixture.js";
import {
  createSessionMutation,
  archiveMutation,
  exportMutation,
  sendInputMutation,
  sessionIdFrom,
  submit
} from "./operations.js";

const execFile = promisify(execFileCallback);
const WORKSPACE_WATCH_PROFILE = {
  ...PI_LIKE_PROFILE,
  id: "fake-workspace-files",
  displayName: "Workspace Files Fake",
  capabilities: [
    ...PI_LIKE_PROFILE.capabilities,
    { key: "workspace.files.watch", supported: true }
  ]
} satisfies FakeAdapterProfile;

describe("workspace, artifact, and capability boundaries", () => {
  let fixture: OrchestratorE2eFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  it("lists, reads, searches, and diffs a workspace while rejecting path and Git-boundary escapes", async () => {
    fixture = await OrchestratorE2eFixture.start();
    const paired = await fixture.pair();
    const workspaceId = "workspace-main";

    const listed = await paired.clients.workspace.listWorkspaceEntries({ workspaceId });
    expect(listed.entries.map((entry) => entry.relativePath)).toContain("README.md");
    const preview = await paired.clients.workspace.readWorkspaceFile({
      workspaceId,
      relativePath: "README.md",
      maximumBytes: 1024n
    });
    expect(preview.preview?.content).toEqual(expect.objectContaining({
      case: "text",
      value: expect.objectContaining({ utf8Text: expect.stringContaining("needle from the service workspace") })
    }));
    const searched = await paired.clients.workspace.searchWorkspace({ workspaceId, query: "needle" });
    expect(searched.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: "README.md", linePreview: expect.stringContaining("needle") })
    ]));

    await expect(paired.clients.workspace.readWorkspaceFile({
      workspaceId,
      relativePath: "../data/orchestrator.db",
      maximumBytes: 32n
    })).rejects.toBeInstanceOf(ConnectError);

    await execFile("git", ["init", fixture.rootDirectory], { windowsHide: true });
    await expect(paired.clients.workspace.getGitStatus({ workspaceId })).rejects.toBeInstanceOf(ConnectError);

    await execFile("git", ["init", fixture.workspaceDirectory], { windowsHide: true });
    await execFile("git", ["-C", fixture.workspaceDirectory, "config", "user.email", "e2e@joko.invalid"], { windowsHide: true });
    await execFile("git", ["-C", fixture.workspaceDirectory, "config", "user.name", "Joko E2E"], { windowsHide: true });
    await execFile("git", ["-C", fixture.workspaceDirectory, "add", "README.md"], { windowsHide: true });
    await execFile("git", ["-C", fixture.workspaceDirectory, "commit", "-m", "fixture baseline"], { windowsHide: true });
    await writeFile(join(fixture.workspaceDirectory, "README.md"), "# changed\nneedle after baseline\n", "utf8");

    const git = await paired.clients.workspace.getGitStatus({ workspaceId });
    expect(git.git).toMatchObject({ repository: true, dirty: true });
    expect(git.git?.changes.some((change) => change.relativePath === "README.md")).toBe(true);
    const diff = await paired.clients.workspace.getWorkspaceDiff({
      workspaceId,
      relativePaths: ["README.md"],
      source: GitDiffSource.UNSTAGED
    });
    expect(diff.diff?.files.some((file) => file.relativePath === "README.md" && file.hunks.length > 0)).toBe(true);
  });

  it("serves the mobile Session Workspace and same-task Generated catalog through the formal HTTP, Host, Blob, and SQLite chain", async () => {
    fixture = await OrchestratorE2eFixture.start();
    const paired = await fixture.pair("Mobile Files owner");
    const workspaceId = "workspace-main";
    const marker = "mobile-files-literal+a+b";
    const imageBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
      "base64"
    );
    await Promise.all([
      writeFile(join(fixture.workspaceDirectory, ".mobile-hidden.txt"), "hidden mobile file\n", "utf8"),
      writeFile(join(fixture.workspaceDirectory, "mobile-search.txt"), `${marker}\n`, "utf8"),
      writeFile(join(fixture.workspaceDirectory, "mobile-preview.png"), imageBytes)
    ]);

    const sessionId = sessionIdFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({
        backendId: PI_LIKE_PROFILE.id,
        targetId: fixture.targetId(),
        displayName: "Mobile Files task"
      })
    ));
    const owner = (await paired.clients.event.getSnapshot({ scope: { kind: { case: "owner", value: {} } } })).snapshot!;
    const session = owner.sessions.find((item) => item.sessionId === sessionId)!;
    const target = owner.targets.find((item) => item.targetId === session.targetId)!;
    expect(target.workspaceId).toBe(workspaceId);
    expect(owner.workspaces.find((item) => item.workspaceId === target.workspaceId)?.targetId).toBe(target.targetId);

    const entries = [];
    let pageToken = "";
    let directoryRevision = "";
    do {
      const page = await paired.clients.workspace.listWorkspaceEntries({
        workspaceId,
        parentRelativePath: "",
        includeHidden: true,
        listingPolicy: WorkspaceEntryListingPolicy.DOCUMENT_TREE,
        page: { pageSize: 1, pageToken }
      });
      const revision = page.revision?.etag || page.revision?.value.toString(10) || "";
      expect(revision).not.toBe("");
      if (directoryRevision) expect(revision).toBe(directoryRevision);
      else directoryRevision = revision;
      entries.push(...page.entries);
      pageToken = page.page?.nextPageToken ?? "";
    } while (pageToken);
    expect(entries.map((entry) => entry.relativePath)).toEqual(expect.arrayContaining([
      ".mobile-hidden.txt", "mobile-preview.png", "mobile-search.txt", "README.md"
    ]));
    expect(entries.find((entry) => entry.relativePath === ".mobile-hidden.txt")?.hidden).toBe(true);

    const index = await paired.clients.workspace.listWorkspaceFiles({ workspaceId });
    expect(index.relativePaths).toEqual(expect.arrayContaining([".mobile-hidden.txt", "mobile-preview.png", "mobile-search.txt"]));
    expect(index.revision).toBeDefined();
    const searched = await paired.clients.workspace.searchWorkspace({
      workspaceId,
      query: "literal+a+b",
      caseSensitive: true,
      regularExpression: false,
      page: { pageSize: 1, pageToken: "" }
    });
    const textMatch = searched.matches.find((match) => match.relativePath === "mobile-search.txt");
    expect(textMatch?.linePreview).toContain(marker);
    expect(textMatch?.revision?.opaqueRevision).not.toBe("");

    const imageEntry = entries.find((entry) => entry.relativePath === "mobile-preview.png")!;
    expect(imageEntry.revision?.opaqueRevision).not.toBe("");
    const preview = await paired.clients.workspace.readWorkspaceFile({
      workspaceId,
      relativePath: imageEntry.relativePath,
      expectedRevision: imageEntry.revision,
      maximumBytes: 2_097_152n
    });
    expect(preview.preview?.entry?.revision).toMatchObject({
      byteSize: imageEntry.revision?.byteSize,
      modifiedAt: imageEntry.revision?.modifiedAt,
      sha256Hex: sha256(imageBytes)
    });
    expect(preview.preview?.entry?.revision?.opaqueRevision).toMatch(/^sha256:/u);
    expect(preview.preview?.content.case).toBe("image");
    if (preview.preview?.content.case !== "image" || !preview.preview.content.value.blob) {
      throw new Error("Formal Workspace image preview returned no canonical BlobRef.");
    }
    const imageBlob = preview.preview.content.value.blob;
    expect(imageBlob).toMatchObject({
      mediaType: "image/png",
      byteSize: BigInt(imageBytes.byteLength),
      sha256Hex: sha256(imageBytes)
    });
    const imageTicket = await paired.clients.artifact.getBlobDownloadTicket({ blobId: imageBlob.blobId });
    expect(imageTicket.ticket).toMatchObject({
      blobId: imageBlob.blobId,
      maximumBytes: imageBlob.byteSize,
      requiredMediaType: imageBlob.mediaType
    });
    const imageDownload = await fetch(`${fixture.baseUrl}${imageTicket.ticket!.relativeEndpoint}`, {
      headers: { authorization: `Bearer ${paired.authKey}` }
    });
    expect(imageDownload.status).toBe(200);
    expect(imageDownload.headers.get("content-type")).toBe("image/png");
    expect(imageDownload.headers.get("content-length")).toBe(String(imageBytes.byteLength));
    expect(Buffer.from(await imageDownload.arrayBuffer())).toEqual(imageBytes);

    const exported = await submit(paired.clients.operation, paired.connectionId, exportMutation(sessionId));
    expect(exported.state).toBe(OperationState.SUCCEEDED);
    if (exported.result?.payload.case !== "artifact") throw new Error("Session export returned no canonical Artifact.");
    const exportedArtifact = exported.result.payload.value;
    const catalog = await paired.clients.artifact.listArtifacts({
      sessionId,
      page: { pageSize: 1, pageToken: "" }
    });
    expect(catalog.artifacts).toEqual([expect.objectContaining({
      artifactId: exportedArtifact.artifactId,
      sessionId,
      blob: expect.objectContaining({ blobId: exportedArtifact.blob?.blobId })
    })]);
    expect(catalog.revision).toBeDefined();
    expect(fixture.application.store.listArtifacts({ sessionId }).map((record) => record.blob.id))
      .toContain(exportedArtifact.blob!.blobId);
    const artifactTicket = await paired.clients.artifact.getBlobDownloadTicket({ blobId: exportedArtifact.blob!.blobId });
    const artifactDownload = await fetch(`${fixture.baseUrl}${artifactTicket.ticket!.relativeEndpoint}`, {
      headers: { authorization: `Bearer ${paired.authKey}` }
    });
    expect(artifactDownload.status).toBe(200);
    expect(await artifactDownload.text()).toContain(`<main>${sessionId}</main>`);
    const archived = await submit(paired.clients.operation, paired.connectionId, archiveMutation(sessionId, true));
    expect(archived.state).toBe(OperationState.SUCCEEDED);
  });

  it("transfers authenticated workspace HTML through durable Browser admission without retaining bytes or completing a retired owner's read", async () => {
    const controlled = controlledHtmlBrowser();
    fixture = await OrchestratorE2eFixture.start({ createAuxiliaryServices: async (store) => ({
      browser: controlled.provider, browserSettings: controlled.settings, browserState: new OperationalBrowserState(store)
    }) });
    const owner = await fixture.pair("HTML owner");
    const manager = await fixture.pair("HTML manager");
    const createTask = async (name: string) => sessionIdFrom(await submit(manager.clients.operation, manager.connectionId,
      createSessionMutation({ backendId: PI_LIKE_PROFILE.id, targetId: fixture!.targetId(), displayName: name })));
    const sessionId = await createTask("HTML task");
    const otherSessionId = await createTask("Other task");
    const file = { workspaceId: "workspace-main", relativePath: "index.html", expectedRevision: "" };
    const read = { sessionId, file };
    const initialHtml = "<!doctype html><title>Preview</title><button onclick=\"this.textContent='clicked'\">Private initial content</button>";
    const currentHtml = initialHtml.replace("initial", "current");
    await writeFile(join(fixture.workspaceDirectory, file.relativePath), initialHtml);
    await expect(fixture.anonymous.workspace.readWorkspaceHtmlSnapshot(read)).rejects.toMatchObject({ code: Code.Unauthenticated });
    const initial = await owner.clients.workspace.readWorkspaceHtmlSnapshot(read);
    expect(initial.utf8Html).toBe(initialHtml);
    const mutationFor = (reference: NonNullable<typeof initial.file>, requestedSession = sessionId) => {
      const takeover = controlled.provider.currentHumanTakeover();
      return create(OperationMutationSchema, { payload: { case: "openBrowserPage", value: create(OpenBrowserPageMutationSchema, {
        browserProviderId: "browser", sessionId: requestedSession, expectedGeneration: BigInt(controlled.provider.generation),
        presentationTarget: BrowserAutomationTarget.SIDEBAR,
        currentPageId: takeover?.pageId ?? "", takeoverId: takeover?.takeoverId ?? "", workspaceHtml: reference
      }) } });
    };
    await writeFile(join(fixture.workspaceDirectory, file.relativePath), currentHtml);
    const staleId = randomUUID();
    const stale = await submit(owner.clients.operation, owner.connectionId, mutationFor(initial.file!), staleId);
    expect(stale.state).toBe(OperationState.FAILED);
    expect(controlled.accepted).toEqual([]);
    expect(fixture.application.store.getOperation(staleId).status).toBe("failed");

    const current = await owner.clients.workspace.readWorkspaceHtmlSnapshot(read);
    expect(current.file?.expectedRevision).not.toBe(initial.file?.expectedRevision);
    const mutation = mutationFor(current.file!);
    const operationId = randomUUID();
    const opened = await submit(owner.clients.operation, owner.connectionId, mutation, operationId);
    expect(opened.state).toBe(OperationState.SUCCEEDED);
    expect(opened.result?.payload).toMatchObject({ case: "browserTakeover", value: { pageId: "page-1-1", connectionId: owner.connectionId } });
    expect(controlled.accepted).toEqual([{ owner: owner.connectionId, html: currentHtml }]);
    const durable = fixture.application.store.getOperation(operationId);
    expect(durable.status).toBe("completed");
    expect(durable.body).toMatchObject({ payload: { case: "openBrowserPage", value: { workspaceHtml: current.file, url: "" } } });
    expect(JSON.stringify(durable.body)).not.toContain("Private");
    const pages = (await manager.clients.browser.listBrowserProviders({})).providers[0]?.pages;
    expect(pages).toEqual([expect.objectContaining({ pageId: "page-1-1", sessionId, url: expect.stringMatching(/^http:\/\/[a-z0-9-]+\.preview\.joko\.localhost\/index\.html$/u) })]);
    await submit(owner.clients.operation, owner.connectionId, mutation, operationId);
    expect(controlled.accepted).toHaveLength(1);
    await expect(submit(owner.clients.operation, owner.connectionId, mutationFor(current.file!, otherSessionId))).rejects.toMatchObject({ code: Code.FailedPrecondition });
    await submit(manager.clients.operation, manager.connectionId, archiveMutation(otherSessionId, true));
    await expect(manager.clients.workspace.readWorkspaceHtmlSnapshot({ ...read, sessionId: otherSessionId })).rejects.toMatchObject({ code: Code.Aborted });

    let readStarted = false;
    let releaseRead!: () => void;
    const released = new Promise<void>((resolve) => { releaseRead = resolve; });
    const originalPreview = fixture.application.workspaces.preview.bind(fixture.application.workspaces);
    const heldRead = vi.spyOn(fixture.application.workspaces, "preview").mockImplementationOnce(async (...args) => {
      const snapshot = await originalPreview(...args);
      readStarted = true;
      await released;
      return snapshot;
    });
    const lateId = randomUUID();
    const late = submit(owner.clients.operation, owner.connectionId, mutationFor(current.file!), lateId).then(
      (operation) => operation.state, (error: unknown) => error
    );
    try {
      await waitFor(async () => readStarted, (value) => value, "HTML snapshot read");
      expect(fixture.application.store.getOperation(lateId).status).toBe("started");
      await submit(manager.clients.operation, manager.connectionId, create(OperationMutationSchema, {
        payload: { case: "revokeDevice", value: create(RevokeDeviceMutationSchema, { deviceId: owner.deviceId, reason: "Retire HTML owner" }) }
      }));
    } finally { releaseRead(); }
    const lateResult = await late;
    heldRead.mockRestore();
    expect(lateResult).toBe(OperationState.FAILED);
    expect(fixture.application.store.getOperation(lateId).status).toBe("failed");
    expect(controlled.accepted).toHaveLength(1);
    expect(controlled.accepted.some((value) => value.owner === manager.connectionId)).toBe(false);
    expect(JSON.stringify(fixture.application.store.getOperation(lateId).body)).not.toContain("Private");
    await expect(owner.clients.workspace.readWorkspaceHtmlSnapshot(read)).rejects.toMatchObject({ code: Code.Unauthenticated });
  });

  it("enforces blob hash/size and one-time authenticated upload/download tickets", async () => {
    fixture = await OrchestratorE2eFixture.start();
    const paired = await fixture.pair();
    const bytes = Buffer.from("artifact payload\n", "utf8");

    const wrongHash = await paired.clients.artifact.beginBlobUpload({
      fileName: "wrong.txt",
      mediaType: "text/plain",
      byteSize: BigInt(bytes.byteLength),
      sha256Hex: "0".repeat(64)
    });
    const wrongResponse = await fetch(`${fixture.baseUrl}${wrongHash.upload!.ticket!.relativeEndpoint}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${paired.authKey}`, "content-type": "application/octet-stream" },
      body: bytes.toString("utf8")
    });
    expect(wrongResponse.ok).toBe(false);
    await expect(paired.clients.artifact.completeBlobUpload({ uploadId: wrongHash.upload!.uploadId }))
      .rejects.toBeInstanceOf(ConnectError);

    const tooSmall = await paired.clients.artifact.beginBlobUpload({
      fileName: "small.txt",
      mediaType: "text/plain",
      byteSize: 3n,
      sha256Hex: createHash("sha256").update("abcd").digest("hex")
    });
    const oversizedResponse = await fetch(`${fixture.baseUrl}${tooSmall.upload!.ticket!.relativeEndpoint}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${paired.authKey}`, "content-type": "application/octet-stream" },
      body: "abcd"
    });
    expect(oversizedResponse.ok).toBe(false);

    const begun = await paired.clients.artifact.beginBlobUpload({
      fileName: "artifact.txt",
      mediaType: "text/plain",
      byteSize: BigInt(bytes.byteLength),
      sha256Hex: sha256(bytes)
    });
    const uploadEndpoint = begun.upload!.ticket!.relativeEndpoint;
    const upload = await fetch(`${fixture.baseUrl}${uploadEndpoint}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${paired.authKey}`, "content-type": "application/octet-stream" },
      body: bytes.toString("utf8")
    });
    expect(upload.status).toBe(201);
    const completed = await paired.clients.artifact.completeBlobUpload({ uploadId: begun.upload!.uploadId });
    expect(completed.blob).toMatchObject({
      sha256Hex: sha256(bytes),
      byteSize: BigInt(bytes.byteLength),
      mediaType: "text/plain",
      fileName: "artifact.txt"
    });

    const replayUpload = await fetch(`${fixture.baseUrl}${uploadEndpoint}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${paired.authKey}`, "content-type": "application/octet-stream" },
      body: bytes.toString("utf8")
    });
    expect(replayUpload.ok).toBe(false);

    const download = await paired.clients.artifact.getBlobDownloadTicket({ blobId: completed.blob!.blobId });
    const downloaded = await fetch(`${fixture.baseUrl}${download.ticket!.relativeEndpoint}`, {
      headers: { authorization: `Bearer ${paired.authKey}` }
    });
    expect(downloaded.status).toBe(200);
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);
    const replayDownload = await fetch(`${fixture.baseUrl}${download.ticket!.relativeEndpoint}`, {
      headers: { authorization: `Bearer ${paired.authKey}` }
    });
    expect(replayDownload.ok).toBe(false);

    const unauthenticated = await fetch(`${fixture.baseUrl}${download.ticket!.relativeEndpoint}`);
    expect(unauthenticated.ok).toBe(false);
  });

  it("streams one real filesystem change over authenticated Connect", async () => {
    fixture = await OrchestratorE2eFixture.start({ profiles: [WORKSPACE_WATCH_PROFILE] });
    const paired = await fixture.pair("Workspace watch client");
    const workspaceId = "workspace-main";

    const watchAbort = new AbortController();
    const watchIterator = paired.clients.workspace.watchWorkspaceFileChanges({
      scope: { kind: { case: "workspace", value: { workspaceId } } }
    }, { signal: watchAbort.signal })[Symbol.asyncIterator]();
    const resync = await nextWithin(watchIterator, "initial workspace resync");
    expect(resync.done).toBe(false);
    expect(resync.value.change).toMatchObject({
      workspaceId,
      kind: WorkspaceFileChangeKind.RESYNC,
      relativePath: ""
    });
    await writeFile(join(fixture.workspaceDirectory, "watched.txt"), "watch-full-chain\n", "utf8");
    const watched = await nextWorkspacePath(watchIterator, "watched.txt");
    expect(watched.change).toMatchObject({ workspaceId, relativePath: "watched.txt" });
    expect(watched.change?.sequence).toBeGreaterThan(0n);
    expect(watched.change?.streamRevision).not.toBe("");

    watchAbort.abort();
    await watchIterator.return?.().catch(() => undefined);
  });

  it("projects three opposite fake capability profiles and fails closed when Browser is absent", async () => {
    fixture = await OrchestratorE2eFixture.start({ profiles: [PI_LIKE_PROFILE, CODEX_LIKE_PROFILE, MINIMAL_PROFILE] });
    const paired = await fixture.pair();
    const response = await paired.clients.backend.listBackends({});
    expect(response.backends).toHaveLength(3);
    const byId = new Map(response.backends.map((backend) => [backend.backendId, backend]));
    const support = (backendId: string, capability: string) => byId.get(backendId)?.capabilities?.capabilities
      .find((item) => item.name === capability)?.support;
    expect(support(PI_LIKE_PROFILE.id, "turn.steer")).toBe(CapabilitySupport.SUPPORTED);
    expect(support(CODEX_LIKE_PROFILE.id, "turn.steer")).toBe(CapabilitySupport.UPSTREAM_MISSING);
    expect(support(CODEX_LIKE_PROFILE.id, "context.compact")).toBe(CapabilitySupport.SUPPORTED);
    expect(support(MINIMAL_PROFILE.id, "context.compact")).toBe(CapabilitySupport.UPSTREAM_MISSING);
    expect(support(MINIMAL_PROFILE.id, "input.image")).toBe(CapabilitySupport.UPSTREAM_MISSING);

    const threadSession = sessionIdFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({
        backendId: CODEX_LIKE_PROFILE.id,
        targetId: fixture.targetId(CODEX_LIKE_PROFILE.id),
        displayName: "No-steer profile"
      })
    ));
    const steer = await submit(
      paired.clients.operation,
      paired.connectionId,
      sendInputMutation(threadSession, BigInt(fixture!.application.store.getSession(threadSession).descriptor.binding.generation), "must not be simulated", QueueDeliveryMode.STEER)
    );
    expect(steer.state).toBe(OperationState.FAILED);
    expect(steer.error?.code).toBe("INPUT_CAPABILITY_UNAVAILABLE");

    expect((await paired.clients.browser.listBrowserProviders({})).providers).toEqual([]);
    const toolProviders = (await paired.clients.tool.listToolProviders({})).providers;
    expect(new Set(toolProviders.map((provider) => provider.toolProviderId))).toEqual(new Set([
      `backend:${PI_LIKE_PROFILE.id}`,
      `backend:${CODEX_LIKE_PROFILE.id}`,
      `backend:${MINIMAL_PROFILE.id}`
    ]));
    const restart = create(OperationMutationSchema, {
      payload: {
        case: "restartBrowser",
        value: create(RestartBrowserMutationSchema, { browserProviderId: "browser" })
      }
    });
    const unsupported = await submit(paired.clients.operation, paired.connectionId, restart, randomUUID());
    expect(unsupported.state).toBe(OperationState.FAILED);
    expect(unsupported.result?.payload).toEqual({
      case: "acknowledgement",
      value: expect.objectContaining({ accepted: false })
    });
    expect(unsupported.error?.message).toMatch(/not configured/i);
  });
});

async function nextWithin<T>(iterator: AsyncIterator<T>, label: string, timeoutMs = 5_000): Promise<IteratorResult<T>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** HTTP composition uses a controlled Provider boundary; Chromium isolation belongs to tool-browser's tests. */
function controlledHtmlBrowser() {
  type Provider = NonNullable<OrchestratorApplication["browser"]>;
  type Takeover = Awaited<ReturnType<Provider["openHumanPage"]>>;
  const accepted: Array<{ readonly owner: string; readonly html: string }> = [];
  const pages: Array<Awaited<ReturnType<Provider["listPages"]>>[number]> = [];
  let generation = 0;
  let running = false;
  let takeover: Takeover | undefined;
  const assertHumanTakeover = (expected: Takeover): Takeover => {
    if (takeover === undefined || expected.takeoverId !== takeover.takeoverId || expected.owner !== takeover.owner || expected.generation !== generation) throw new Error("Browser owner fence changed.");
    return takeover;
  };
  const provider = {
    id: "browser", targetMode: "sidebar",
    get generation() { return generation; }, get running() { return running; },
    start: async () => { if (!running) { generation += 1; running = true; } },
    stop: async () => { running = false; pages.length = 0; takeover = undefined; },
    currentHumanTakeover: () => takeover,
    currentAgentLease: () => undefined,
    assertHumanTakeover,
    endHumanTakeover: async (expected: Takeover) => { assertHumanTakeover(expected); takeover = undefined; },
    listPages: async () => [...pages],
    openHumanPage: async (...[request, ttlMs = 60_000, snapshot]: Parameters<Provider["openHumanPage"]>): Promise<Takeover> => {
      if (!running || request.generation !== generation || request.providerId !== "browser" || snapshot === undefined) throw new Error("HTML Browser admission is invalid.");
      snapshot.assertCurrent();
      accepted.push({ owner: request.owner, html: snapshot.html });
      const pageId = `page-${generation}-${accepted.length}`;
      pages.push({ id: pageId, url: request.url, title: "HTML preview", state: "ready" });
      takeover = { providerId: "browser", pageId, owner: request.owner, generation, takeoverId: `takeover-${accepted.length}`, startedAt: Date.now(), expiresAt: Date.now() + ttlMs };
      return takeover;
    }
  } as unknown as Provider;
  const settings = {
    enabled: () => true,
    automationTarget: () => "sidebar" as const,
    takeoverTimeout: () => 60_000,
    profileDisplayName: () => "Joko",
    setBackendHealth: () => undefined,
    snapshot: () => create(BrowserSettingsSchema, {
      browserProviderId: "browser",
      profileDisplayName: "Joko",
      automationTarget: BrowserAutomationTarget.SIDEBAR,
      support: CapabilitySupport.SUPPORTED
    })
  } as unknown as NonNullable<OrchestratorApplication["browserSettings"]>;
  return { provider, settings, accepted };
}

async function nextWorkspacePath<T extends {
  readonly change?: { readonly relativePath?: string };
}>(iterator: AsyncIterator<T>, relativePath: string): Promise<T> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const next = await nextWithin(iterator, `workspace change for ${relativePath}`);
    if (next.done) throw new Error(`Workspace change stream ended before ${relativePath}.`);
    if (next.value.change?.relativePath === relativePath) return next.value;
  }
  throw new Error(`Workspace change stream did not publish ${relativePath}.`);
}
