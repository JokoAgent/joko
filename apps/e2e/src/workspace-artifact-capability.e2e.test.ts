import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { create } from "@bufbuild/protobuf";
import { ConnectError } from "@connectrpc/connect";
import {
  CapabilitySupport,
  GitDiffSource,
  OperationMutationSchema,
  OperationState,
  QueueDeliveryMode,
  RestartBrowserMutationSchema,
  WorkspaceFileChangeKind
} from "@joko/contracts";
import {
  CODEX_LIKE_PROFILE,
  MINIMAL_PROFILE,
  PI_LIKE_PROFILE,
  type FakeAdapterProfile
} from "@joko/testkit";
import { afterEach, describe, expect, it } from "vitest";

import { OrchestratorE2eFixture, sha256, waitFor } from "./fixture.js";
import {
  createSessionMutation,
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
      sendInputMutation(threadSession, "must not be simulated", QueueDeliveryMode.STEER)
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
