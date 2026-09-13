import { describe, expect, it, vi } from "vitest";

import {
  OperationalWorkspaceChangeJournal,
  WorkspaceChangeStream,
  type WorkspaceChangeJournal,
  type WorkspaceFileChangeDraft,
  type WorkspaceFileChangeRecord,
  type WorkspaceWatcherObserver,
  type WorkspaceWatcherProvider,
  type WorkspaceWatcherSubscription
} from "./workspace-change-stream.js";
import type { WorkspaceRegistration } from "./workspace-service.js";

const WORKSPACE: WorkspaceRegistration = {
  id: "workspace-a",
  root: "C:\\workspace-a",
  displayName: "Workspace A",
  trusted: true
};

class FakeWatcherProvider implements WorkspaceWatcherProvider {
  readonly observers = new Map<string, WorkspaceWatcherObserver>();
  readonly closed: string[] = [];
  calls = 0;

  async watch(workspace: WorkspaceRegistration, observer: WorkspaceWatcherObserver): Promise<WorkspaceWatcherSubscription> {
    this.calls += 1;
    this.observers.set(workspace.id, observer);
    return { close: () => { this.closed.push(workspace.id); } };
  }
}

class DeferredJournal implements WorkspaceChangeJournal {
  readonly drafts: WorkspaceFileChangeDraft[] = [];
  #sequence = 0n;
  release: (() => void) | undefined;

  async append(change: WorkspaceFileChangeDraft): Promise<WorkspaceFileChangeRecord> {
    this.drafts.push(change);
    await new Promise<void>((resolve) => { this.release = resolve; });
    const sequence = ++this.#sequence;
    return { ...change, sequence, streamRevision: `revision-${sequence}` };
  }
}

class DeferredWatcherProvider implements WorkspaceWatcherProvider {
  readonly observers = new Map<string, WorkspaceWatcherObserver>();
  readonly closed: string[] = [];
  calls = 0;
  release: (() => void) | undefined;

  async watch(workspace: WorkspaceRegistration, observer: WorkspaceWatcherObserver): Promise<WorkspaceWatcherSubscription> {
    this.calls += 1;
    this.observers.set(workspace.id, observer);
    await new Promise<void>((resolve) => { this.release = resolve; });
    return { close: () => { this.closed.push(workspace.id); } };
  }
}

describe("WorkspaceChangeStream", () => {
  it("persists the initial resync before publishing it and closes the last native watcher", async () => {
    const provider = new FakeWatcherProvider();
    const journal = new DeferredJournal();
    const stream = new WorkspaceChangeStream({
      provider,
      journal,
      registrations: () => [WORKSPACE],
      now: () => 123
    });
    const iterator = stream.watch({ kind: "workspace", workspaceId: WORKSPACE.id });
    const pending = iterator.next();
    await vi.waitFor(() => expect(journal.drafts).toHaveLength(1));
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    journal.release?.();
    await expect(pending).resolves.toMatchObject({
      done: false,
      value: { workspaceId: WORKSPACE.id, kind: "resync", sequence: 1n, observedAt: 123 }
    });
    await iterator.return(undefined);
    expect(provider.closed).toEqual([WORKSPACE.id]);
    await stream.close();
  });

  it("orders rename, overflow and resync events with canonical relative paths", async () => {
    const provider = new FakeWatcherProvider();
    const stream = new WorkspaceChangeStream({
      provider,
      registrations: () => [WORKSPACE],
      now: () => 456
    });
    const iterator = stream.watch({ kind: "workspace", workspaceId: WORKSPACE.id });
    await expect(iterator.next()).resolves.toMatchObject({ value: { kind: "resync", sequence: 1n } });
    const observer = provider.observers.get(WORKSPACE.id)!;

    await observer.change({
      kind: "renamed",
      previousPath: "src/old.ts",
      path: "src/new.ts",
      revision: { opaqueRevision: "meta:2", byteSize: 4, modifiedAt: 456 }
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        kind: "renamed",
        previousPath: "src/old.ts",
        path: "src/new.ts",
        sequence: 2n,
        revision: { opaqueRevision: "meta:2" }
      }
    });

    await observer.overflow();
    await expect(iterator.next()).resolves.toMatchObject({ value: { kind: "overflow", sequence: 3n } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { kind: "resync", sequence: 4n } });
    await iterator.return(undefined);
    await stream.close();
  });

  it("rejects provider paths that could escape or expose workspace control data", async () => {
    const provider = new FakeWatcherProvider();
    const stream = new WorkspaceChangeStream({ provider, registrations: () => [WORKSPACE] });
    const iterator = stream.watch({ kind: "workspace", workspaceId: WORKSPACE.id });
    await iterator.next();
    const observer = provider.observers.get(WORKSPACE.id)!;
    await expect(observer.change({ kind: "modified", path: "../outside.txt" })).rejects.toThrow(/canonical safe relative path/u);
    await expect(observer.change({ kind: "created", path: ".git/config" })).rejects.toThrow(/canonical safe relative path/u);
    await expect(observer.change({ kind: "created", path: "notes.META" })).rejects.toThrow(/canonical safe relative path/u);
    await expect(observer.change({ kind: "created", path: ".JOKO-WRITE-secret.TMP" })).rejects.toThrow(/canonical safe relative path/u);
    await expect(observer.change({ kind: "unknown" as never, path: "safe.txt" })).rejects.toThrow(/kind is invalid/u);
    await iterator.return(undefined);
    await stream.close();
  });

  it("shares one in-flight native watcher across concurrent subscribers", async () => {
    const provider = new DeferredWatcherProvider();
    const stream = new WorkspaceChangeStream({ provider, registrations: () => [WORKSPACE] });
    const first = stream.watch({ kind: "workspace", workspaceId: WORKSPACE.id });
    const second = stream.watch({ kind: "workspace", workspaceId: WORKSPACE.id });
    const firstValue = first.next();
    const secondValue = second.next();

    await vi.waitFor(() => expect(provider.calls).toBe(1));
    provider.release?.();
    await expect(firstValue).resolves.toMatchObject({ value: { kind: "resync" } });
    await expect(secondValue).resolves.toMatchObject({ value: { kind: "resync" } });

    await first.return(undefined);
    expect(provider.closed).toEqual([]);
    await second.return(undefined);
    expect(provider.closed).toEqual([WORKSPACE.id]);
    await stream.close();
  });

  it("closes a native watcher that finishes starting during workspace removal", async () => {
    const provider = new DeferredWatcherProvider();
    const stream = new WorkspaceChangeStream({ provider, registrations: () => [WORKSPACE] });
    const iterator = stream.watch({ kind: "workspace", workspaceId: WORKSPACE.id });
    const firstValue = iterator.next();
    await vi.waitFor(() => expect(provider.calls).toBe(1));
    const unregistering = stream.workspaceUnregistered(WORKSPACE.id);

    provider.release?.();
    await unregistering;
    await firstValue;
    expect(provider.closed).toEqual([WORKSPACE.id]);

    await iterator.return(undefined);
    await stream.close();
  });

  it("terminates an aborted subscriber and releases its last native watcher", async () => {
    const provider = new FakeWatcherProvider();
    const stream = new WorkspaceChangeStream({ provider, registrations: () => [WORKSPACE] });
    const abort = new AbortController();
    const iterator = stream.watch({ kind: "workspace", workspaceId: WORKSPACE.id }, abort.signal);
    await iterator.next();
    const waiting = iterator.next();

    abort.abort();
    await expect(waiting).resolves.toEqual({ done: true, value: undefined });
    expect(provider.closed).toEqual([WORKSPACE.id]);
    await stream.close();

    const preAbortedProvider = new FakeWatcherProvider();
    const preAbortedStream = new WorkspaceChangeStream({ provider: preAbortedProvider, registrations: () => [WORKSPACE] });
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(preAbortedStream.watch(
      { kind: "workspace", workspaceId: WORKSPACE.id },
      preAborted.signal
    ).next()).resolves.toEqual({ done: true, value: undefined });
    expect(preAbortedProvider.calls).toBe(0);
    await preAbortedStream.close();
  });

  it("cancels an overflow retry when the final subscriber leaves", async () => {
    vi.useFakeTimers();
    const provider = new FakeWatcherProvider();
    const stream = new WorkspaceChangeStream({ provider, registrations: () => [WORKSPACE] });
    try {
      const iterator = stream.watch({ kind: "workspace", workspaceId: WORKSPACE.id });
      await iterator.next();
      await provider.observers.get(WORKSPACE.id)!.overflow();
      await iterator.return(undefined);

      await vi.advanceTimersByTimeAsync(500);
      expect(provider.calls).toBe(1);
    } finally {
      await stream.close();
      vi.useRealTimers();
    }
  });

  it("bounds a stalled subscriber and forces a clean reconnect when its queue overflows", async () => {
    const provider = new FakeWatcherProvider();
    const stream = new WorkspaceChangeStream({ provider, registrations: () => [WORKSPACE], now: () => 789 });
    const iterator = stream.watch({ kind: "workspace", workspaceId: WORKSPACE.id });
    await iterator.next();
    const observer = provider.observers.get(WORKSPACE.id)!;

    for (let index = 0; index <= 1_024; index += 1) {
      await observer.change({ kind: "modified", path: `src/file-${index}.ts` });
    }

    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(provider.closed).toEqual([WORKSPACE.id]);
    await stream.close();
  });

  it("fails subscribers closed when durable append fails before publication", async () => {
    const provider = new FakeWatcherProvider();
    let sequence = 0n;
    const journal: WorkspaceChangeJournal = {
      append: async (change) => {
        if (change.kind === "modified") throw new Error("journal unavailable");
        sequence += 1n;
        return { ...change, sequence, streamRevision: `revision-${sequence}` };
      }
    };
    const stream = new WorkspaceChangeStream({ provider, journal, registrations: () => [WORKSPACE] });
    const iterator = stream.watch({ kind: "workspace", workspaceId: WORKSPACE.id });
    await iterator.next();
    const waiting = iterator.next();

    await expect(provider.observers.get(WORKSPACE.id)!.change({ kind: "modified", path: "README.md" }))
      .rejects.toThrow("journal unavailable");
    await expect(waiting).resolves.toEqual({ done: true, value: undefined });
    expect(provider.closed).toEqual([WORKSPACE.id]);
    await stream.close();
  });

  it("supports authenticated-owner scope without crossing into unrelated workspace subscribers", async () => {
    const provider = new FakeWatcherProvider();
    const workspaceB = { ...WORKSPACE, id: "workspace-b", root: "C:\\workspace-b" };
    const stream = new WorkspaceChangeStream({ provider, registrations: () => [WORKSPACE, workspaceB] });
    const owner = stream.watch({ kind: "owner" });
    const workspaceOnly = stream.watch({ kind: "workspace", workspaceId: WORKSPACE.id });
    // Owner subscription emits one resync per workspace. The workspace-only
    // subscriber receives only workspace-a even though both use one manager.
    const ownerFirst = await owner.next();
    const ownerSecond = await owner.next();
    expect(new Set([ownerFirst.value?.workspaceId, ownerSecond.value?.workspaceId])).toEqual(new Set(["workspace-a", "workspace-b"]));
    await expect(workspaceOnly.next()).resolves.toMatchObject({ value: { workspaceId: "workspace-a" } });
    await owner.return(undefined);
    await workspaceOnly.return(undefined);
    await stream.close();
  });
});

describe("OperationalWorkspaceChangeJournal", () => {
  it("continues a durable hash-chained owner sequence after recreation", async () => {
    let stored: unknown;
    const store = {
      findSetting: <T,>() => stored === undefined ? undefined : { value: stored as T },
      setSetting: <T,>(_scopeType: "service", _scopeId: string, _key: string, value: T) => { stored = value; }
    };
    const first = await new OperationalWorkspaceChangeJournal(store).append({
      workspaceId: WORKSPACE.id,
      kind: "resync",
      observedAt: 100
    });
    const second = await new OperationalWorkspaceChangeJournal(store).append({
      workspaceId: WORKSPACE.id,
      kind: "modified",
      path: "README.md",
      observedAt: 101
    });
    expect(first.sequence).toBe(1n);
    expect(second.sequence).toBe(2n);
    expect(second.streamRevision).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(second.streamRevision).not.toBe(first.streamRevision);
    expect(JSON.stringify(stored)).not.toContain(WORKSPACE.root);
  });
});
