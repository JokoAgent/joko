import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiSessionStore } from "./session-store.js";
import { mkdtemp } from "./test-paths.js";

describe("PiSessionStore", () => {
  it("uses a stable storage root and rejects ambiguous relative roots", async () => {
    expect(() => new PiSessionStore("relative-session-root")).toThrowError(
      expect.objectContaining({ publicError: expect.objectContaining({ code: "PI_INVALID_SESSION_ROOT" }) })
    );
    const root = await mkdtemp(join(tmpdir(), "joko-pi-stable-session-root-"));
    const store = new PiSessionStore(root);
    expect(store.sessionsRoot).toBe(join(root, "sessions"));
    expect(store.trashRoot).toBe(join(root, "trash", "sessions"));
    await store.initialize();
  });

  it("accepts an unmaterialized new-session reference but never as a resume", async () => {
    const home = await mkdtemp(join(tmpdir(), "joko-pi-empty-session-"));
    const store = new PiSessionStore(home);
    await store.initialize();
    const prospective = join(store.sessionsRoot, "future.jsonl");
    await expect(store.assertManagedSessionReference(prospective, { requireExists: false })).resolves.toBe(prospective);
    await expect(store.assertManagedSession(prospective)).rejects.toMatchObject({ publicError: { code: "PI_SESSION_NOT_FOUND" } });
  });

  it("lists native JSONL and uses recoverable managed trash", async () => {
    const home = await mkdtemp(join(tmpdir(), "joko-pi-sessions-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-workspace-"));
    const store = new PiSessionStore(home);
    await store.initialize();
    const path = join(store.sessionsRoot, "session.jsonl");
    await mkdir(store.sessionsRoot, { recursive: true });
    await writeFile(
      path,
      [
        JSON.stringify({ type: "session", version: 3, id: "native-1", timestamp: new Date().toISOString(), cwd: workspace }),
        JSON.stringify({ type: "message", id: "a", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "hello" } }),
        JSON.stringify({ type: "session_info", id: "b", parentId: "a", timestamp: new Date().toISOString(), name: "Daily" })
      ].join("\n") + "\n"
    );

    await expect(store.list(workspace)).resolves.toMatchObject([{ id: "native-1", name: "Daily", messageCount: 1, state: "ready" }]);
    const trashed = await store.moveToTrash(path);
    expect(await readFile(trashed, "utf8")).toContain('"native-1"');
    await expect(store.list(workspace)).resolves.toEqual([]);
  });

  it("reuses the exact trash entry when a remote deletion is retried after rename", async () => {
    const home = await mkdtemp(join(tmpdir(), "joko-pi-trash-recovery-"));
    const store = new PiSessionStore(home);
    await store.initialize();
    const path = join(store.sessionsRoot, "recoverable.jsonl");
    await writeFile(path, `${JSON.stringify({ type: "session", version: 3, id: "recoverable", cwd: home })}\n`);
    const recoveryKey = createHash("sha256").update("remote deletion operation").digest("hex");

    const first = await store.moveToTrash(path, recoveryKey);
    const retried = await store.moveToTrash(path, recoveryKey);

    expect(retried).toBe(first);
    expect(await readFile(retried, "utf8")).toContain('"recoverable"');
  });

  it("exports an identity-fenced native Session and imports a workspace-rebound copy", async () => {
    const home = await mkdtemp(join(tmpdir(), "joko-pi-portable-session-"));
    const sourceWorkspace = await mkdtemp(join(tmpdir(), "joko-pi-portable-source-"));
    const targetWorkspace = await mkdtemp(join(tmpdir(), "joko-pi-portable-target-"));
    const store = new PiSessionStore(home);
    await store.initialize();
    const path = join(store.sessionsRoot, "source.jsonl");
    await writeFile(path, [
      JSON.stringify({ type: "session", version: 3, id: "source-native", cwd: sourceWorkspace, parentSession: "C:/private/parent.jsonl" }),
      JSON.stringify({ type: "message", id: "one", parentId: null, message: { role: "user", content: "hello" } })
    ].join("\n") + "\n");

    const exported = await store.exportPortableSession(path);
    expect(exported.nativeSessionId).toBe("source-native");
    expect(exported.sha256).toMatch(/^[a-f0-9]{64}$/);
    const imported = await store.importPortableSession(exported.bytes, {
      workspaceRoot: targetWorkspace,
      generation: 7,
      nativeSessionId: "imported-native"
    });
    expect(imported).toMatchObject({ nativeSessionId: "imported-native", generation: 7 });
    expect(imported.opaqueRef).not.toBe(path);
    const records = (await readFile(imported.opaqueRef, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records[0]).toMatchObject({ type: "session", id: "imported-native", cwd: targetWorkspace });
    expect(records[0]).not.toHaveProperty("parentSession");
    expect(records[1]).toMatchObject({ type: "message", id: "one" });
  });

  it("lists and portable-round-trips a native message line containing an image larger than 25 MiB", async () => {
    const home = await mkdtemp(join(tmpdir(), "joko-pi-large-portable-session-"));
    const sourceWorkspace = await mkdtemp(join(tmpdir(), "joko-pi-large-portable-source-"));
    const targetWorkspace = await mkdtemp(join(tmpdir(), "joko-pi-large-portable-target-"));
    const store = new PiSessionStore(home);
    await store.initialize();
    const path = join(store.sessionsRoot, "large-image.jsonl");
    const imageData = Buffer.alloc(25 * 1024 * 1024 + 1).toString("base64");
    const messageLine = JSON.stringify({
      type: "message",
      id: "large-image-message",
      parentId: null,
      message: {
        role: "user",
        content: [
          { type: "text", text: "inspect large portable image" },
          { type: "image", data: imageData, mimeType: "image/png" }
        ]
      }
    });
    await writeFile(path, `${JSON.stringify({
      type: "session",
      version: 3,
      id: "large-source-native",
      cwd: sourceWorkspace
    })}\n${messageLine}\n`);

    await expect(store.list(sourceWorkspace)).resolves.toMatchObject([{
      id: "large-source-native",
      messageCount: 1,
      firstMessage: "inspect large portable image",
      state: "ready"
    }]);
    const maximumBytes = 64 * 1024 * 1024;
    const exported = await store.exportPortableSession(path, maximumBytes);
    const imported = await store.importPortableSession(exported.bytes, {
      workspaceRoot: targetWorkspace,
      generation: 8,
      nativeSessionId: "large-imported-native",
      maximumBytes
    });
    await expect(store.list(targetWorkspace)).resolves.toMatchObject([{
      id: "large-imported-native",
      messageCount: 1,
      firstMessage: "inspect large portable image",
      state: "ready"
    }]);
    const importedBytes = await readFile(imported.opaqueRef);
    const firstLf = importedBytes.indexOf(0x0a);
    const secondLf = importedBytes.indexOf(0x0a, firstLf + 1);
    expect(firstLf).toBeGreaterThan(0);
    expect(secondLf).toBeGreaterThan(firstLf);
    expect(createHash("sha256").update(importedBytes.subarray(firstLf + 1, secondLf)).digest("hex"))
      .toBe(createHash("sha256").update(messageLine).digest("hex"));
  }, 15_000);

  it("materializes an unflushed detached fork without changing its source identity", async () => {
    const home = await mkdtemp(join(tmpdir(), "joko-pi-detached-fork-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-detached-fork-workspace-"));
    const store = new PiSessionStore(home);
    await store.initialize();
    const source = join(store.sessionsRoot, "source.jsonl");
    const derived = join(store.sessionsRoot, "derived.jsonl");
    await writeFile(source, `${JSON.stringify({
      type: "session",
      version: 3,
      id: "source-native",
      timestamp: new Date(0).toISOString(),
      cwd: workspace
    })}\n`);
    const entry = {
      type: "model_change",
      id: "model-entry",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      provider: "local",
      modelId: "test-model"
    };

    await expect(store.materializeDetachedFork({
      binding: { opaqueRef: derived, nativeSessionId: "derived-native", generation: 9 },
      parentSession: source,
      entries: [entry]
    })).resolves.toEqual({ opaqueRef: derived, nativeSessionId: "derived-native", generation: 9 });
    const records = (await readFile(derived, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toEqual([
      expect.objectContaining({
        type: "session",
        version: expect.any(Number),
        id: "derived-native",
        cwd: workspace,
        parentSession: source
      }),
      entry
    ]);
    await expect(store.binding(source, 9)).resolves.toMatchObject({ nativeSessionId: "source-native" });

    await store.materializeDetachedFork({
      binding: { opaqueRef: derived, nativeSessionId: "derived-native", generation: 10 },
      parentSession: source,
      entries: []
    });
    expect((await readFile(derived, "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("rejects invalid or conflicting detached fork materialization", async () => {
    const home = await mkdtemp(join(tmpdir(), "joko-pi-detached-fork-reject-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-detached-fork-reject-workspace-"));
    const store = new PiSessionStore(home);
    await store.initialize();
    const source = join(store.sessionsRoot, "source.jsonl");
    const derived = join(store.sessionsRoot, "derived.jsonl");
    await writeFile(source, `${JSON.stringify({ type: "session", version: 3, id: "source-native", cwd: workspace })}\n`);
    await expect(store.materializeDetachedFork({
      binding: { opaqueRef: derived, nativeSessionId: "derived-native", generation: 1 },
      parentSession: source,
      entries: [{ type: "session", id: "injected", parentId: null }]
    })).rejects.toMatchObject({ publicError: { code: "PI_FORK_MATERIALIZATION_RECORD_INVALID" } });

    await writeFile(derived, `${JSON.stringify({ type: "session", version: 3, id: "other-native", cwd: workspace })}\n`);
    await expect(store.materializeDetachedFork({
      binding: { opaqueRef: derived, nativeSessionId: "derived-native", generation: 1 },
      parentSession: source,
      entries: []
    })).rejects.toMatchObject({ publicError: { code: "PI_FORK_MATERIALIZATION_ID_MISMATCH" } });
  });

  it("rejects malformed, oversized, duplicate-header, and unsafe-destination portable Sessions", async () => {
    const home = await mkdtemp(join(tmpdir(), "joko-pi-portable-reject-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-portable-workspace-"));
    const store = new PiSessionStore(home);
    await store.initialize();
    await expect(store.importPortableSession(Buffer.from("{}\n"), { workspaceRoot: workspace, generation: 1 }))
      .rejects.toMatchObject({ publicError: { code: "PI_SESSION_PORTABLE_JSONL_INVALID" } });
    const duplicate = Buffer.from([
      JSON.stringify({ type: "session", id: "one", cwd: workspace }),
      JSON.stringify({ type: "session", id: "two", cwd: workspace })
    ].join("\n") + "\n");
    await expect(store.importPortableSession(duplicate, { workspaceRoot: workspace, generation: 1 }))
      .rejects.toMatchObject({ publicError: { code: "PI_SESSION_PORTABLE_REWRITE_FAILED" } });
    const valid = Buffer.from(`${JSON.stringify({ type: "session", id: "one", cwd: workspace })}\n`);
    await expect(store.importPortableSession(valid, {
      workspaceRoot: workspace,
      generation: 1,
      maximumBytes: valid.byteLength - 1
    }))
      .rejects.toMatchObject({ publicError: { code: "PI_SESSION_PORTABLE_SIZE_INVALID" } });
    await expect(store.importPortableSession(valid, { workspaceRoot: "relative", generation: 1 }))
      .rejects.toMatchObject({ publicError: { code: "PI_SESSION_IMPORT_WORKSPACE_INVALID" } });
  });
});
