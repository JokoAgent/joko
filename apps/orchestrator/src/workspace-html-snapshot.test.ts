import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationalStore } from "@joko/store";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceService, type WorkspaceFilePreview } from "./workspace-service.js";
import { readWorkspaceHtmlSnapshot } from "./workspace-html-snapshot.js";
import { rm } from "node:fs/promises";

function authority() {
  let generation = 1;
  const store = { getSession: () => ({ descriptor: { id: "session", targetId: "target", binding: { generation, opaqueRef: "native" }, archived: false } }),
    getTarget: () => ({ descriptor: { id: "target" }, metadata: { workspaceId: "workspace" }, revision: 1n }), findPendingSessionLifecycleCleanup: () => undefined } as unknown as OperationalStore;
  return { store, retire: () => { generation += 1; } };
}

describe("workspace HTML snapshot authority", () => {
  it("requires an owned complete UTF-8 HTML file and rechecks its exact content revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-html-workspace-"));
    try {
      const workspaces = new WorkspaceService();
      await workspaces.register({ id: "workspace", root, displayName: "Workspace", trusted: true });
      const owner = authority();
      const input = { store: owner.store, workspaces, sessionId: "session", source: { workspaceId: "workspace", relativePath: "index.html", expectedRevision: "" }, assertConnection: () => undefined };
      await writeFile(join(root, "index.html"), "<!doctype html><p>Snapshot</p>");
      const snapshot = await readWorkspaceHtmlSnapshot(input);
      expect(snapshot.html).toContain("Snapshot");
      expect(snapshot.file.expectedRevision).toMatch(/^workspace-html:[0-9a-f]{64}$/u);
      await expect(readWorkspaceHtmlSnapshot({ ...input, source: { ...input.source, expectedRevision: (await workspaces.preview("workspace", "index.html")).entry.revision } })).rejects.toMatchObject({ kind: "stale" });
      const navigation = new AbortController();
      const readSignal = navigation.signal;
      await mkdir(join(root, "pages"));
      await writeFile(join(root, "pages", "details.html"), "<!doctype html><p>Details</p>");
      await writeFile(join(root, "pages", "not-html.txt"), "not html");
      expect(await snapshot.readDocument("pages/details.html", readSignal)).toEqual({ html: "<!doctype html><p>Details</p>", mediaType: "text/html" });
      await expect(snapshot.readDocument("pages/not-html.txt", readSignal)).rejects.toMatchObject({ kind: "invalid" });
      await expect(snapshot.readDocument("../outside.html", readSignal)).rejects.toMatchObject({ kind: "invalid" });
      await writeFile(join(root, "style.css"), "p { color: red }");
      expect(await snapshot.readResource("style.css", readSignal)).toEqual({ body: Buffer.from("p { color: red }"), mediaType: "text/css" });
      await writeFile(join(root, "private.json"), '{"value":"private"}');
      expect(await snapshot.readResource("private.json", readSignal)).toEqual({ body: Buffer.from('{"value":"private"}'), mediaType: "application/json" });
      const binaryResources = [
        ["module.wasm", "application/wasm"],
        ["font.woff2", "font/woff2"],
        ["sound.mp3", "audio/mpeg"],
        ["movie.mp4", "video/mp4"]
      ] as const;
      for (const [name, mediaType] of binaryResources) {
        const body = Buffer.from([0, 1, 2, 3]);
        await writeFile(join(root, name), body);
        expect(await snapshot.readResource(name, readSignal)).toEqual({ body, mediaType });
      }
      await writeFile(join(root, "private.bin"), Buffer.from([0, 1, 2, 3]));
      await expect(snapshot.readResource("private.bin", readSignal)).rejects.toMatchObject({ kind: "unsupported" });
      await expect(snapshot.readResource("../outside.css", readSignal)).rejects.toMatchObject({ kind: "invalid" });
      await writeFile(join(root, "large.png"), Buffer.alloc(2 * 1024 * 1024 + 1));
      await expect(snapshot.readResource("large.png", readSignal)).rejects.toMatchObject({ kind: "unsupported" });
      await expect(readWorkspaceHtmlSnapshot({ ...input, source: { ...input.source, workspaceId: "other" } })).rejects.toMatchObject({ kind: "invalid" });
      await expect(readWorkspaceHtmlSnapshot({ ...input, source: { ...input.source, relativePath: "../outside.html" } })).rejects.toThrow();
      await writeFile(join(root, "index.html"), "changed");
      await expect(readWorkspaceHtmlSnapshot({ ...input, source: snapshot.file })).rejects.toMatchObject({ kind: "stale" });
      const fresh = await snapshot.reload(readSignal);
      expect(fresh.html).toBe("changed");
      navigation.abort();
      await writeFile(join(root, "index.html"), "changed twice");
      expect((await fresh.reload(new AbortController().signal)).html).toBe("changed twice");
      await writeFile(join(root, "index.html"), "x".repeat(2 * 1024 * 1024 + 1));
      await expect(readWorkspaceHtmlSnapshot(input)).rejects.toMatchObject({ kind: "unsupported" });
      await writeFile(join(root, "index.html"), Buffer.from([0xff, 0xfe, 0x80]));
      await expect(readWorkspaceHtmlSnapshot(input)).rejects.toThrow();
      owner.retire();
      expect(snapshot.assertCurrent).toThrow(/owner changed/u);
      await expect(snapshot.readDocument("pages/details.html", readSignal)).rejects.toMatchObject({ kind: "stale" });
      await expect(snapshot.readResource("style.css", readSignal)).rejects.toMatchObject({ kind: "stale" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(["cancel", "connection", "session"] as const)("does not release a late read after %s retirement", async (retirement) => {
    const owner = authority();
    const controller = new AbortController();
    let resolve!: (value: unknown) => void;
    let connected = true;
    const preview = vi.fn(() => new Promise<WorkspaceFilePreview>((done) => { resolve = (value) => done(value as WorkspaceFilePreview); }));
    const pending = readWorkspaceHtmlSnapshot({ store: owner.store, workspaces: {} as WorkspaceService, authority: { identity: "workspace", assertCurrent: () => undefined, preview },
      sessionId: "session", source: { workspaceId: "workspace", relativePath: "index.html", expectedRevision: "" }, signal: controller.signal,
      assertConnection: () => { if (!connected) throw new Error("Disconnected"); } });
    if (retirement === "cancel") controller.abort();
    if (retirement === "session") owner.retire();
    if (retirement === "connection") connected = false;
    resolve({ entry: { path: "index.html", revision: "revision" }, text: "<p>Late</p>", mediaType: "text/html", truncated: false });
    await expect(pending).rejects.toThrow();
    expect(preview).toHaveBeenCalledOnce();
  });

  it("rechecks original Session authority and navigation cancellation after an associated resource read", async () => {
    const owner = authority();
    let finish!: (value: unknown) => void;
    const preview = vi.fn().mockResolvedValueOnce({ entry: { path: "index.html", revision: "revision" }, text: "<p>Root</p>", mediaType: "text/html", truncated: false })
      .mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const snapshot = await readWorkspaceHtmlSnapshot({ store: owner.store, workspaces: {} as WorkspaceService, authority: { identity: "workspace", assertCurrent: () => undefined, preview },
      sessionId: "session", source: { workspaceId: "workspace", relativePath: "index.html", expectedRevision: "" }, assertConnection: () => undefined });
    const controller = new AbortController();
    const pending = snapshot.readResource("script.js", controller.signal);
    controller.abort();
    finish({ text: "globalThis.value = true", truncated: false });
    await expect(pending).rejects.toThrow();
    const retired = snapshot.readResource("script.js", new AbortController().signal);
    owner.retire(); finish({ text: "globalThis.value = true", truncated: false });
    await expect(retired).rejects.toMatchObject({ kind: "stale" });
  });

  it.each(["document", "resource", "reload"] as const)("propagates original connection cancellation to an in-flight %s read", async (kind) => {
    const owner = authority();
    const original = new AbortController();
    const navigation = new AbortController();
    let readSignal: AbortSignal | undefined;
    let finish!: (value: unknown) => void;
    const preview = vi.fn().mockResolvedValueOnce({ entry: { path: "index.html", revision: "revision" }, text: "<p>Root</p>", mediaType: "text/html", truncated: false })
      .mockImplementation((_path: string, _maximum?: number, _completeMaximum?: number, signal?: AbortSignal) => {
        readSignal = signal;
        return new Promise((resolve) => { finish = resolve; });
      });
    const snapshot = await readWorkspaceHtmlSnapshot({ store: owner.store, workspaces: {} as WorkspaceService,
      authority: { identity: "workspace", assertCurrent: () => undefined, preview }, signal: original.signal,
      sessionId: "session", source: { workspaceId: "workspace", relativePath: "index.html", expectedRevision: "" }, assertConnection: () => undefined });
    const pending = kind === "document" ? snapshot.readDocument("next.html", navigation.signal)
      : kind === "resource" ? snapshot.readResource("script.js", navigation.signal) : snapshot.reload(navigation.signal);
    expect(readSignal?.aborted).toBe(false);
    original.abort();
    expect(readSignal?.aborted).toBe(true);
    expect(navigation.signal.aborted).toBe(false);
    finish({ entry: { path: "index.html", revision: "changed" }, text: "<p>Late</p>", mediaType: "text/html", truncated: false });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
