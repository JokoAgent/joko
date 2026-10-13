import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { ClipboardSync, CLIPBOARD_SYNC_CHUNK_CHARS, type ClipboardSyncBaseline, type ClipboardSyncRemote,
  type LocalClipboardReadCache } from "./clipboard-sync.js";
import { ClipboardSyncError, getClipboardSyncFailure, type ClipboardSyncFailureReason } from "./clipboard-sync-failure.js";

function item(text: string): string { return JSON.stringify({ text }); }
function digest(json: string): string {
  const value = JSON.parse(json) as Record<string, unknown>;
  return JSON.stringify([value["text"], value["html"], value["rtf"], value["url"], value["png"]]);
}

function fixture(inline = true, fingerprints = false) {
  let local = item("local before opt-in"), remote = item("remote before opt-in"), localVersion = 1, remoteVersion = 1;
  let current = true, nextId = 0;
  const transfers = new Map<string, { data: string; version?: string }>();
  const baseline: ClipboardSyncBaseline = { local: "", remote: "" };
  const cache: LocalClipboardReadCache = {};
  const readLocal = vi.fn(async () => local);
  const localId = () => fingerprints ? createHash("sha256").update(local).digest("hex") : String(localVersion);
  const remoteId = () => fingerprints ? createHash("sha256").update(remote).digest("hex") : String(remoteVersion);
  const writeLocal = vi.fn(async (json: string, version: string) => {
    if (version !== localId()) throw new ClipboardSyncError("changed");
    local = json; localVersion++; return localId();
  });
  const paste = vi.fn(async (json: string, version: string) => {
    if (version !== remoteId()) throw new ClipboardSyncError("changed");
    remote = json; remoteVersion++; return remoteId();
  });
  const remotePort = {
    version: vi.fn(async () => remoteId()),
    copy: vi.fn(async (version: string, useInline: boolean) => {
      if (version !== remoteId()) throw new ClipboardSyncError("changed");
      if (useInline && remote.length <= CLIPBOARD_SYNC_CHUNK_CHARS) return { length: remote.length, data: remote };
      const id = `copy-${++nextId}`; transfers.set(id, { data: remote }); return { length: remote.length, id };
    }),
    begin: vi.fn(async (_length: number, version: string) => {
      if (version !== remoteId()) throw new ClipboardSyncError("changed");
      const id = `paste-${++nextId}`; transfers.set(id, { data: "", version }); return id;
    }),
    read: vi.fn(async (id: string, offset: number) => transfers.get(id)!.data.slice(offset, offset + CLIPBOARD_SYNC_CHUNK_CHARS)),
    write: vi.fn(async (id: string, offset: number, data: string) => {
      const transfer = transfers.get(id)!;
      if (offset !== transfer.data.length) throw new ClipboardSyncError("changed");
      transfer.data += data;
    }),
    commit: vi.fn(async (id: string) => {
      const transfer = transfers.get(id)!; transfers.delete(id);
      return paste(transfer.data, transfer.version!);
    }),
    paste,
    cancel: vi.fn(async (id: string) => { transfers.delete(id); })
  } satisfies ClipboardSyncRemote;
  const sync = new ClipboardSync({ remote: remotePort, localVersion: async () => localId(), readLocal,
    writeLocal, current: () => current, digest, inline, localReadCache: cache }, baseline);
  return { sync, baseline, cache, readLocal, writeLocal, remote: remotePort, transfers,
    local: () => local, remoteValue: () => remote,
    setLocal: (json: string) => { local = json; localVersion++; },
    setRemote: (json: string) => { remote = json; remoteVersion++; }, retire: () => { current = false; } };
}

describe("clipboard sync", () => {
  it("compares content fingerprints by equality through bidirectional writes without echo or numerical ordering", async () => {
    const f = fixture(true, true);
    await f.sync.tick();
    expect(f.baseline.remote).toMatch(/^[0-9a-f]{64}$/u);
    expect(f.writeLocal).not.toHaveBeenCalled(); expect(f.remote.paste).not.toHaveBeenCalled();
    f.setLocal(item("local fingerprint change")); await f.sync.tick();
    expect(f.remoteValue()).toBe(f.local());
    expect(f.remote.paste).toHaveBeenCalledTimes(1);
    await f.sync.tick(); expect(f.writeLocal).not.toHaveBeenCalled();
    f.setRemote(item("remote fingerprint change")); await f.sync.tick();
    expect(f.local()).toBe(f.remoteValue()); expect(f.writeLocal).toHaveBeenCalledTimes(1);
    f.setLocal(f.local()); f.setRemote(f.remoteValue()); await f.sync.tick();
    expect(f.remote.paste).toHaveBeenCalledTimes(1); expect(f.writeLocal).toHaveBeenCalledTimes(1);
    f.setLocal(item("local conflicting copy")); f.setRemote(item("remote conflicting copy"));
    await expect(f.sync.tick()).rejects.toMatchObject({ reason: "conflict" });
    expect(f.local()).toBe(item("local conflicting copy")); expect(f.remoteValue()).toBe(item("remote conflicting copy"));
  });

  it("establishes both content baselines without importing pre-opt-in contents or counter-only rewrites", async () => {
    const f = fixture();
    await f.sync.tick();
    expect(f.writeLocal).not.toHaveBeenCalled(); expect(f.remote.paste).not.toHaveBeenCalled();
    f.setLocal(f.local()); f.setRemote(f.remoteValue());
    await f.sync.tick();
    expect(f.writeLocal).not.toHaveBeenCalled(); expect(f.remote.paste).not.toHaveBeenCalled();
    f.setLocal(item("copied after opt-in")); await f.sync.tick();
    expect(f.remoteValue()).toBe(item("copied after opt-in"));
    expect(f.remote.paste).toHaveBeenCalledTimes(1);
    f.setRemote(f.remoteValue()); await f.sync.tick();
    expect(f.writeLocal).not.toHaveBeenCalled();
  });

  it("records the destination's actual normalized content and suppresses its rewrite echo", async () => {
    const f = fixture(); await f.sync.tick();
    f.writeLocal.mockImplementationOnce(async () => {
      f.setLocal(item("normalized native representation")); return "2";
    });
    f.setRemote(item("rich remote representation")); await f.sync.tick();
    expect(f.baseline.localDigest).toBe(digest(item("normalized native representation")));
    f.setLocal(f.local()); await f.sync.tick();
    expect(f.remote.paste).not.toHaveBeenCalled();
  });

  it("preserves both simultaneous content changes and resumes only after another actual copy", async () => {
    const f = fixture(); await f.sync.tick();
    f.setLocal(item("new local")); f.setRemote(item("new remote"));
    await expect(f.sync.tick()).rejects.toMatchObject({ reason: "conflict" });
    expect(f.local()).toBe(item("new local")); expect(f.remoteValue()).toBe(item("new remote"));
    expect(f.writeLocal).not.toHaveBeenCalled(); expect(f.remote.paste).not.toHaveBeenCalled();
    await f.sync.tick(); expect(f.remote.paste).not.toHaveBeenCalled();
    f.setLocal(item("next deliberate copy")); await f.sync.tick();
    expect(f.remoteValue()).toBe(item("next deliberate copy"));
  });

  it.each(["empty", "unsupported", "too-large"] as const)("skips one %s version while preserving the proven other baseline", async reason => {
    const f = fixture(); await f.sync.tick();
    const priorRemoteDigest = f.baseline.remoteDigest;
    f.setLocal(item("unreadable snapshot")); f.readLocal.mockRejectedValueOnce(new ClipboardSyncError(reason));
    await f.sync.tick(); await f.sync.tick();
    expect(f.readLocal).toHaveBeenCalledTimes(2); expect(f.baseline.remoteDigest).toBe(priorRemoteDigest);
    expect(f.remote.paste).not.toHaveBeenCalled();
    f.setLocal(item("next readable copy")); await f.sync.tick();
    expect(f.remoteValue()).toBe(item("next readable copy"));
  });

  it("does not cache a denied permission read as a successful baseline", async () => {
    const f = fixture(); f.readLocal.mockRejectedValueOnce(new ClipboardSyncError("permission"));
    await expect(f.sync.tick()).rejects.toMatchObject({ reason: "permission" });
    expect(f.cache.version).toBeUndefined(); expect(f.baseline.local).toBe("");
    await f.sync.tick(); expect(f.readLocal).toHaveBeenCalledTimes(2);
    expect(f.remote.paste).not.toHaveBeenCalled();
  });

  it("keeps one pending tick occupied through a native effect and rejects its late receipt after retirement", async () => {
    const f = fixture(); await f.sync.tick(); f.setLocal(item("pending native write"));
    let complete!: (version: string) => void;
    f.remote.paste.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const pending = f.sync.tick();
    await vi.waitFor(() => expect(f.remote.paste).toHaveBeenCalledTimes(1));
    const rejected = expect(pending).rejects.toMatchObject({ reason: "expired" });
    f.retire(); await f.sync.tick();
    expect(f.remote.paste).toHaveBeenCalledTimes(1);
    complete("2"); await rejected;
    expect(f.baseline.local).toBe("1");
  });

  it("transfers bounded Unicode chunks and never replays a consumed commit after an unknown reply", async () => {
    const f = fixture(false); await f.sync.tick();
    f.setLocal(item("🙂".repeat(CLIPBOARD_SYNC_CHUNK_CHARS)));
    f.remote.commit.mockImplementationOnce(async id => {
      const transfer = f.transfers.get(id)!; f.transfers.delete(id);
      await f.remote.paste(transfer.data, transfer.version!);
      throw new ClipboardSyncError("unknown");
    });
    await expect(f.sync.tick()).rejects.toMatchObject({ reason: "unknown" });
    expect(f.remote.write.mock.calls.every(([, , data]) => data.length <= CLIPBOARD_SYNC_CHUNK_CHARS)).toBe(true);
    await f.sync.tick();
    expect(f.remote.commit).toHaveBeenCalledTimes(1);
    expect(f.remote.paste).toHaveBeenCalledTimes(1); expect(f.transfers.size).toBe(0);
  });

  it("rejects malformed remote versions before any content or write is admitted", async () => {
    const f = fixture(); f.remote.version.mockResolvedValueOnce("invalid");
    await expect(f.sync.tick()).rejects.toMatchObject({ reason: "unsupported" });
    expect(f.remote.copy).not.toHaveBeenCalled(); expect(f.remote.paste).not.toHaveBeenCalled();
  });
});

describe("clipboard sync failure recovery", () => {
  it.each([
    ["permission", 5, "permission", null], ["changed", 5, "conflict", 1500], ["conflict", 0, "conflict", 1500],
    ["outcome-unknown", 0, "failed", null],
    ["temporary-focus", 0, "failed", 1500], ["temporary-focus", 5, "failed", 30000], ["write-failed", 2, "failed", 6000]
  ] as const)("maps %s failure at count %s to bounded recovery", (reason: ClipboardSyncFailureReason, count, notice, delay) => {
    expect(getClipboardSyncFailure(new ClipboardSyncError(reason), count)).toEqual({ reason, notice, delay });
  });
  it("sanitizes unknown errors and invalid retry counts", () => {
    expect(getClipboardSyncFailure(new Error("arbitrary native response"), Number.NaN)).toEqual({ reason: "unknown", notice: "failed", delay: 1500 });
  });
});
