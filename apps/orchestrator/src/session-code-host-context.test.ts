import { rmSync } from "node:fs";
import { mkdtempSync } from "./test-paths.js";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CodeHostProvider } from "@joko/code-host";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OperationalCodeHostSessionAuthorization,
  readSessionCodeHostProjection,
  SessionCodeHostContextRuntime
} from "./session-code-host-context.js";
import { toProtoSession } from "./proto-mapper.js";
import { sessionProjectionContext } from "./snapshot-projector.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("Session code-host context", () => {
  it("extracts task/message references, binds them to the Session owner, and persists provider projections", async () => {
    const fixture = createFixture("Track https://code.example/acme/widgets/pull/42");
    const provider: CodeHostProvider = {
      capability: "code-host.pull-request",
      supports: (reference) => reference.host === "code.example",
      getPullRequest: vi.fn(async () => ({
        state: "merged" as const,
        draft: false,
        title: "Persist projection metadata",
        headBranch: "feature/persist-projection",
        unresolvedReviewThreadCount: 0
      }))
    };
    fixture.store.appendEvent({
      backendId: "backend-1",
      targetId: "target-1",
      sessionId: "session-1",
      generation: 0,
      traceId: "message-1",
      payload: {
        type: "message_complete",
        role: "user",
        blocks: [{ kind: "text", text: "Also inspect https://forge.example/team/service/-/merge_requests/7" }]
      }
    });

    const runtime = new SessionCodeHostContextRuntime({ store: fixture.store, providers: [provider], now: () => 5_000 });
    const projection = await runtime.refreshSession("session-1");
    expect(projection).toMatchObject({
      sessionOwnerId: "session-1",
      references: [
        {
          reference: {
            key: "forge.example/team/service#7",
            number: 7,
            webUrl: "https://forge.example/team/service/-/merge_requests/7"
          }
        },
        {
          reference: {
            key: "code.example/acme/widgets#42",
            number: 42,
            webUrl: "https://code.example/acme/widgets/pull/42"
          },
          projection: {
            state: "merged",
            draft: false,
            title: "Persist projection metadata",
            headBranch: "feature/persist-projection",
            unresolvedReviewThreadCount: 0,
            observedAt: 5_000
          }
        }
      ]
    });
    expect(provider.getPullRequest).toHaveBeenCalledOnce();
    const proto = toProtoSession(
      fixture.store.getSession("session-1"),
      sessionProjectionContext(fixture.store, fixture.store.getSession("session-1"))
    );
    expect(proto.codeHostPullRequests).toHaveLength(2);
    expect(proto.codeHostPullRequests[0]).toMatchObject({
      observed: false,
      reference: { webUrl: "https://forge.example/team/service/-/merge_requests/7" }
    });
    expect(proto.codeHostPullRequests[1]).toMatchObject({
      observed: true,
      draft: false,
      title: "Persist projection metadata",
      headBranch: "feature/persist-projection",
      unresolvedReviewThreadCount: 0
    });

    const filePath = fixture.store.filePath;
    fixture.store.close();
    const reopened = new OperationalStore(filePath);
    fixture.replaceStore(reopened);
    expect(readSessionCodeHostProjection(reopened, "session-1")).toEqual(projection);
  });

  it("rejects credential-bearing references without persisting source text", async () => {
    const fixture = createFixture("https://secret@code.example/acme/widgets/pull/42");
    const runtime = new SessionCodeHostContextRuntime({ store: fixture.store });
    expect(await runtime.refreshSession("session-1")).toMatchObject({ sessionOwnerId: "session-1", references: [] });
    const durable = fixture.store.findSetting("session", "session-1", "codeHost.pullRequests.v1");
    expect(JSON.stringify(durable?.value)).not.toContain("secret");
  });

  it.each(["success", "revoked", "failure"] as const)("reconciles a deleted reference after an in-flight %s response", async (outcome) => {
    const { store } = createFixture("Ordinary task");
    const sessionId = "session-1";
    const message = store.appendEvent({ backendId: "backend-1", targetId: "target-1", sessionId, generation: 0, traceId: "reference-message",
      payload: { type: "message_complete", role: "user", blocks: [{ kind: "text", text: "Review https://github.com/acme/work/pull/42" }] } });
    let now = 5_000;
    const authorization = new OperationalCodeHostSessionAuthorization(store);
    const initial = { state: "open" as const, draft: false, title: "Original status", headBranch: "topic" };
    const late = { ...initial, state: "merged" as const };
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const getPullRequest = vi.fn<CodeHostProvider["getPullRequest"]>().mockResolvedValueOnce(initial)
      .mockImplementationOnce(async (reference, { sessionOwnerId }) => {
        const lease = authorization.authorize(sessionOwnerId, reference);
        if (lease === undefined) throw new Error("The fixture reference was not authorized.");
        await paused;
        if (outcome === "failure") throw new Error("Temporary Provider failure.");
        if (outcome === "revoked" && !authorization.isCurrent(lease, reference)) throw new Error("Original reference revoked.");
        return late;
      });
    const runtime = new SessionCodeHostContextRuntime({ store, now: () => now, providers: [
      { capability: "code-host.pull-request", supports: () => true, getPullRequest }
    ] });
    expect((await runtime.refreshSession(sessionId))?.references[0]?.projection).toMatchObject(initial);
    runtime.install();
    const publish = vi.spyOn(store, "appendEvent");
    const save = vi.spyOn(store, "setSetting");
    now += 60_001;
    const inflight = runtime.refreshSession(sessionId);
    try {
      await vi.waitFor(() => expect(getPullRequest).toHaveBeenCalledTimes(2));
      store.runOperation({ id: "delete-reference", kind: "delete_message", body: { eventId: message.id } }, owner => {
        owner.commitMessageDeletion({ sessionId, requestedEventId: message.id, deletedEventIds: [message.id],
          operationId: "delete-reference", traceId: "reference:delete" });
        return {};
      });
      const afterDeletion = runtime.refreshSession(sessionId);
      release();
      const projections = await Promise.all([inflight, afterDeletion]);
      expect(projections.map(value => value?.references)).toEqual([[], []]);
      expect(save).toHaveBeenCalledWith("session", sessionId, "codeHost.pullRequests.v1", expect.objectContaining({ references: [] }));
      expect(JSON.stringify(save.mock.calls)).not.toContain("merged");
      expect(readSessionCodeHostProjection(store, sessionId)?.references).toEqual([]);
      const session = store.getSession(sessionId);
      expect(toProtoSession(session, sessionProjectionContext(store, session)).codeHostPullRequests).toEqual([]);
      await vi.waitFor(() => expect(publish).toHaveBeenCalledWith(expect.objectContaining({ traceId: "session-code-host-projection",
        payload: { type: "session_changed" } })));
      expect(getPullRequest).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await inflight.catch(() => undefined);
      save.mockRestore();
      publish.mockRestore();
    }
  });

  it("authorizes only references currently attached to the durable Session owner", () => {
    const fixture = createFixture("Track https://github.com/acme/private-repo/pull/42");
    const authorization = new OperationalCodeHostSessionAuthorization(fixture.store);
    const reference = {
      key: "github.com/acme/private-repo#42",
      host: "github.com",
      repositoryOwner: "acme",
      repositoryName: "private-repo",
      number: 42,
      webUrl: "https://github.com/acme/private-repo/pull/42"
    };

    const lease = authorization.authorize("session-1", reference);
    expect(lease).toMatchObject({ sessionOwnerId: "session-1", referenceKey: reference.key });
    expect(lease === undefined ? false : authorization.isCurrent(lease, reference)).toBe(true);
    expect(authorization.authorize("missing-session", reference)).toBeUndefined();
    expect(authorization.authorize("session-1", {
      ...reference,
      key: "github.com/acme/private-repo#43",
      number: 43,
      webUrl: "https://github.com/acme/private-repo/pull/43"
    })).toBeUndefined();
    expect(authorization.authorize("session-1", {
      ...reference,
      webUrl: "https://github.com/acme/other/pull/42"
    })).toBeUndefined();
  });
});

function createFixture(title: string): {
  store: OperationalStore;
  replaceStore: (replacement: OperationalStore) => void;
} {
  const directory = mkdtempSync(path.join(tmpdir(), "joko-code-host-"));
  const filePath = path.join(directory, "operational.sqlite");
  let store = new OperationalStore(filePath);
  cleanups.push(() => {
    try { store.close(); } catch { /* already closed */ }
    rmSync(directory, { recursive: true, force: true });
  });
  store.upsertBackend({
    id: "backend-1",
    displayName: "Coding agent",
    version: "1",
    health: "healthy",
    adapterKind: "fixture",
    instanceGeneration: 0,
    installationState: "installed",
    authenticationState: "authenticated",
    capabilities: new Map(),
    models: [],
    tools: [],
    diagnostics: []
  });
  store.upsertTarget({
    id: "target-1",
    backendId: "backend-1",
    displayName: "Workspace",
    workspaceRoot: "D:/workspace",
    managed: false,
    trusted: true
  });
  store.createSession({
    id: "session-1",
    backendId: "backend-1",
    targetId: "target-1",
    title,
    binding: { opaqueRef: "native/session", generation: 0 },
    pinned: false,
    archived: false,
    permissionMode: "ask",
    planMode: false,
    fastMode: false,
    createdAt: 1,
    updatedAt: 1
  });
  return {
    get store() { return store; },
    replaceStore(replacement) { store = replacement; }
  };
}
