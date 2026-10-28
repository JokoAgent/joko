import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { workspaceEntryAbsentRevision } from "@joko/contracts";
import type {
  RemoteDirectoryEntry,
  RemoteFileReadRequest,
  RemoteFileStat,
  RemoteFileTransportPort,
  RemoteFileWriteRequest,
  RemoteProcessHandle,
  RemoteProcessStartRequest,
  RemoteProcessTransportPort,
  RemoteSshTransportLease
} from "@joko/remote-ssh";
import { describe, expect, it, vi } from "vitest";

import type { RemoteExecutionRouter } from "./remote-execution-router.js";
import { RemoteWorkspaceService } from "./remote-workspace-service.js";
import { WorkspaceService } from "./workspace-service.js";
import { readWorkspaceHtmlSnapshot } from "./workspace-html-snapshot.js";
import type { OperationalStore } from "@joko/store";

describe("RemoteWorkspaceService", () => {
  it("routes bounded files, CAS mutations, search, and Git state through owner-scoped transports", async () => {
    const files = new MemoryRemoteFiles();
    await files.mkdir("/workspace", { recursive: true });
    await files.write({ path: "/workspace/README.md", content: Buffer.from("hello remote workspace"), mode: 0o644 });
    await files.mkdir("/workspace/src");
    await files.write({ path: "/workspace/src/main.ts", content: Buffer.from("export const remote = true;"), mode: 0o644 });
    await files.write({ path: "/workspace/scene.gltf", content: Buffer.from('{"asset":{"version":"2.0"}}'), mode: 0o644 });
    await files.mkdir("/workspace/.git");
    await files.write({ path: "/workspace/.git/config", content: Buffer.from("private metadata"), mode: 0o600 });

    const processRequests: RemoteProcessStartRequest[] = [];
    const processes: RemoteProcessTransportPort = {
      open: async (request) => {
        processRequests.push(request);
        if (request.executable === "rg") {
          return new CompletedRemoteProcess({
            stdout: `${JSON.stringify({
              type: "match",
              data: {
                path: { text: "README.md" },
                line_number: 1,
                absolute_offset: 0,
                lines: { text: "hello remote workspace\n" },
                submatches: [{ start: 6, end: 12 }]
              }
            })}\n`
          });
        }
        if (request.executable === "git" && request.args.includes("status") && request.args.includes("--porcelain=v1")) {
          return new CompletedRemoteProcess({ stdout: "## main\0 M README.md\0" });
        }
        if (request.executable === "git" && request.args.includes("--show-toplevel")) {
          return new CompletedRemoteProcess({ stdout: "/workspace\n" });
        }
        if (request.executable === "git" && request.args[0] === "rev-parse") {
          return new CompletedRemoteProcess({ stdout: `${"a".repeat(40)}\n` });
        }
        if (request.executable === "sh") return new CompletedRemoteProcess({ exitCode: 1 });
        return new CompletedRemoteProcess({ stdout: "" });
      }
    };
    const scopes: Array<readonly [string, string]> = [];
    const lease: RemoteSshTransportLease = {
      capabilities: {
        commandExecution: true,
        processStreaming: true,
        fileTransfer: true,
        tcpForwarding: false,
        interactiveTerminal: false
      },
      files,
      processes
    };
    const authority = (binding: import("@joko/core").RemoteWorkspaceBinding) => {
      if (binding.kind !== "ssh") throw new Error("unexpected binding");
      scopes.push([binding.hostTargetId, binding.hostId]);
      return { kind: "ssh" as const, binding, executionIdentity: "ssh", authorityIdentity: "1", pathStyle: "posix" as const,
        files, processes, assertCurrent: () => undefined, assertForwardingCurrent: () => undefined };
    };
    const remoteExecution = { workspace: async (binding: import("@joko/core").RemoteWorkspaceBinding) => authority(binding),
      files: async (binding: import("@joko/core").RemoteWorkspaceBinding) => authority(binding) } as unknown as RemoteExecutionRouter;
    const remote = new RemoteWorkspaceService(remoteExecution);
    const workspaces = new WorkspaceService({ remoteDelegate: remote });

    await workspaces.register({
      id: "workspace-a",
      root: "/workspace",
      displayName: "Remote project",
      trusted: true,
      remote: { targetId: "target-a", binding: { kind: "ssh", hostTargetId: "target-a", hostId: "host-a", workspaceRoot: "/workspace" } }
    });

    const listing = await workspaces.list("workspace-a", "", { recursive: true });
    expect(listing.map((entry) => entry.path)).toEqual(["src", "src/main.ts", "README.md", "scene.gltf"]);
    expect(listing.some((entry) => entry.path.startsWith(".git"))).toBe(false);

    for (const [name, mediaType] of [["motion.apng", "image/apng"], ["photo.AVIF", "image/avif"],
      ["photo.heic", "image/heic"], ["photo.heif", "image/heif"], ["scan.tif", "image/tiff"], ["scan.tiff", "image/tiff"]] as const) {
      const bytes = Buffer.from([0, 1, 2, 3]);
      await files.write({ path: `/workspace/${name}`, content: bytes, mode: 0o644 });
      expect(await workspaces.preview("workspace-a", name, 32)).toMatchObject({ mediaType, bytes, truncated: false,
        entry: { path: name, size: bytes.length, revision: expect.stringMatching(/^sha256:/u) } });
    }

    const prefix = await workspaces.preview("workspace-a", "README.md", 5);
    expect(prefix).toMatchObject({ text: "hello", truncated: true, mediaType: "text/markdown" });
    await files.write({ path: "/workspace/unicode.zig", content: Buffer.from("a漢"), mode: 0o644 });
    expect(await workspaces.preview("workspace-a", "unicode.zig", 2)).toMatchObject({ text: "a", truncated: true });
    await files.write({ path: "/workspace/invalid.zig", content: Buffer.from([0xff, 0x78, 0x78]), mode: 0o644 });
    await expect(workspaces.preview("workspace-a", "invalid.zig", 2)).rejects.toMatchObject({ kind: "unsupported" });
    for (const [name, mediaType] of [["guide.mdown", "text/markdown"], ["Makefile", "text/plain"],
      ["data.xml", "application/xml"], ["settings.yml", "application/yaml"],
      ["styles.css", "text/css"], ["script.mjs", "text/javascript"], ["source.ts", "text/typescript"]] as const) {
      await files.write({ path: `/workspace/${name}`, content: Buffer.from("hello remote"), mode: 0o644 });
      expect(await workspaces.preview("workspace-a", name, 5)).toMatchObject({ mediaType, text: "hello", truncated: true });
    }
    const model = await workspaces.preview("workspace-a", "scene.gltf", 5);
    for (const name of ["main.zig", "events.jsonl", "movie.srt", "Gemfile", ".gitignore", ".env", "production.env.local", "layout.xhtml"]) {
      await files.write({ path: `/workspace/${name}`, content: Buffer.from("remote file text"), mode: 0o644 });
      expect(await workspaces.preview("workspace-a", name, 5)).toMatchObject({ mediaType: "text/plain", text: "remot", truncated: true });
    }
    expect(model).toMatchObject({ mediaType: "model/gltf+json", truncated: false });
    expect(model.text).toBeUndefined();
    expect(model.bytes).toBeUndefined();
    await files.write({ path: "/workspace/page.html", content: Buffer.from("<p>Remote HTML</p>"), mode: 0o644 });
    expect(await workspaces.preview("workspace-a", "page.html")).toMatchObject({ mediaType: "text/html", text: "<p>Remote HTML</p>", truncated: false });
    await expect(workspaces.preview("workspace-a", "page.html", 2 * 1024 * 1024, 4)).rejects.toMatchObject({ kind: "unsupported" });
    await files.write({ path: "/workspace/page.html", content: Buffer.from([0xff, 0xfe]), mode: 0o644 });
    await expect(workspaces.preview("workspace-a", "page.html")).rejects.toMatchObject({ kind: "unsupported" });
    const realpath = vi.spyOn(files, "realpath");
    realpath.mockImplementation(async (candidate) => candidate === "/workspace/page.html" ? "/outside/page.html" : candidate);
    await expect(workspaces.preview("workspace-a", "page.html")).rejects.toMatchObject({ kind: "invalid" });
    realpath.mockRestore();
    await expect(workspaces.writeTextFile("workspace-a", {
      path: "README.md",
      text: "changed",
      expectedRevision: "stale"
    })).rejects.toMatchObject({ code: "WORKSPACE_TEXT_FILE_STALE" });
    const saved = await workspaces.writeTextFile("workspace-a", {
      path: "README.md",
      text: "changed",
      expectedRevision: (await workspaces.preview("workspace-a", "README.md")).entry.revision
    });
    expect(saved.entry.path).toBe("README.md");
    expect(Buffer.from(await files.read({ path: "/workspace/README.md", maximumBytes: 64 })).toString()).toBe("changed");

    const created = await workspaces.createEntry("workspace-a", {
      path: "notes",
      kind: "directory",
      expectedRevision: workspaceEntryAbsentRevision
    });
    const copied = await workspaces.copyEntry("workspace-a", {
      sourcePath: "notes",
      destinationPath: "notes-copy",
      expectedRevision: created.entry.revision
    });
    const moved = await workspaces.moveEntry("workspace-a", {
      sourcePath: "notes-copy",
      destinationPath: "archive",
      expectedRevision: copied.entry.revision
    });
    await workspaces.deleteEntry("workspace-a", {
      path: "archive",
      expectedRevision: moved.entry.revision,
      confirmRecursive: true
    });
    await expect(files.stat("/workspace/archive")).rejects.toThrow();

    const search = await workspaces.search("workspace-a", "remote", { caseSensitive: false });
    expect(search).toMatchObject([{ path: "README.md", line: 1, column: 7 }]);
    expect(processRequests.at(-1)).toMatchObject({ executable: "rg", cwd: "/workspace" });
    const git = await workspaces.gitState("workspace-a");
    expect(git).toMatchObject({ repository: true, branch: "main", dirty: true });
    expect(git.changes).toMatchObject([{ path: "README.md", index: " ", worktree: "M" }]);

    expect(scopes.length).toBeGreaterThan(8);
    expect(scopes.every(([targetId, hostId]) => targetId === "target-a" && hostId === "host-a")).toBe(true);
    await workspaces.close();
  });

  it.each(["aliases", "nested roots"] as const)("serializes old-revision saves across remote workspace %s", async kind => {
    const f = await memoryWorkspaceFixture();
    let release!: () => void;
    try {
      const file = kind === "nested roots" ? "sub/note.txt" : "note.txt", aliasRoot = kind === "nested roots" ? "/workspace/sub" : "/workspace";
      if (kind === "nested roots") await f.files.mkdir("/workspace/sub");
      await f.files.write({ path: `/workspace/${file}`, content: Buffer.from("old") });
      const revision = (await f.workspaces.preview("workspace", file)).entry.revision;
      await f.workspaces.register({ ...f.registration, id: "workspace-alias", root: aliasRoot,
        remote: { ...f.registration.remote, binding: { ...f.registration.remote.binding, workspaceRoot: aliasRoot } } });
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const original = f.files.write.bind(f.files);
      const write = vi.spyOn(f.files, "write").mockImplementationOnce(async request => { entered(); await blocked; return original(request); });
      const first = f.workspaces.writeTextFile("workspace", { path: file, text: "first", expectedRevision: revision });
      await started;
      const second = f.workspaces.writeTextFile("workspace-alias", { path: "./note.txt", text: "second", expectedRevision: revision });
      await vi.waitFor(() => expect(f.capture).toHaveBeenCalledTimes(3));
      await new Promise<void>(done => setImmediate(done));
      release();
      await expect(first).resolves.toMatchObject({ revision: expect.stringContaining("sha256:") });
      await expect(second).rejects.toMatchObject({ code: "WORKSPACE_TEXT_FILE_STALE" });
      expect(write).toHaveBeenCalledOnce();
      expect(Buffer.from(await f.files.read({ path: `/workspace/${file}`, maximumBytes: 100 })).toString()).toBe("first");
    } finally { release?.(); vi.restoreAllMocks(); await f.workspaces.close(); }
  });

  it("retires a queued write's original registration instead of adopting a replacement route", async () => {
    const f = await memoryWorkspaceFixture();
    let release!: () => void;
    try {
      await f.files.write({ path: "/workspace/note.txt", content: Buffer.from("old") });
      await f.workspaces.register({ ...f.registration, id: "workspace-alias" });
      const revision = (await f.workspaces.preview("workspace", "note.txt")).entry.revision;
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const original = f.files.write.bind(f.files);
      const write = vi.spyOn(f.files, "write").mockImplementationOnce(async request => { entered(); await blocked; return original(request); });
      const first = f.workspaces.writeTextFile("workspace", { path: "note.txt", text: "first", expectedRevision: revision });
      await started;
      const pending = f.workspaces.writeTextFile("workspace-alias", { path: "note.txt", text: "second", expectedRevision: revision });
      await vi.waitFor(() => expect(f.capture).toHaveBeenCalledTimes(3));
      await new Promise<void>(done => setImmediate(done));
      await f.workspaces.register({ ...f.registration, id: "workspace-alias", remote: { ...f.registration.remote, binding: { ...f.registration.remote.binding, hostId: "replacement" } } });
      release(); await first;
      await expect(pending).rejects.toThrow("registered remote workspace changed");
      expect(write).toHaveBeenCalledOnce(); expect(f.capture).toHaveBeenCalledTimes(3);
    } finally { release?.(); vi.restoreAllMocks(); await f.workspaces.close(); }
  });

  it.each(["host", "root"] as const)("does not block an independent remote %s while a save waits", async kind => {
    const f = await memoryWorkspaceFixture(), other = kind === "host" ? new MemoryRemoteFiles() : f.files;
    let release!: () => void;
    try {
      const otherRoot = kind === "host" ? "/workspace" : "/workspace-other", otherHost = kind === "host" ? "other-host" : "host";
      await f.files.write({ path: "/workspace/note.txt", content: Buffer.from("old") });
      await other.mkdir(otherRoot, { recursive: true }); await other.write({ path: `${otherRoot}/note.txt`, content: Buffer.from("other") });
      f.capture.mockImplementation(async binding => ({ kind: "ssh", binding, executionIdentity: binding.hostId, authorityIdentity: "route", pathStyle: "posix",
        files: binding.hostId === "host" ? f.files : other, processes: f.processes, assertCurrent: () => undefined, assertFilesCurrent: () => undefined, assertForwardingCurrent: () => undefined }));
      await f.workspaces.register({ ...f.registration, id: "other", root: otherRoot,
        remote: { ...f.registration.remote, binding: { ...f.registration.remote.binding, hostId: otherHost, workspaceRoot: otherRoot } } });
      const firstRevision = (await f.workspaces.preview("workspace", "note.txt")).entry.revision;
      const otherRevision = (await f.workspaces.preview("other", "note.txt")).entry.revision;
      let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
      const blocked = new Promise<void>(resolve => { release = resolve; }), original = f.files.write.bind(f.files);
      vi.spyOn(f.files, "write").mockImplementationOnce(async request => { entered(); await blocked; return original(request); });
      const first = f.workspaces.writeTextFile("workspace", { path: "note.txt", text: "first", expectedRevision: firstRevision });
      await started;
      let otherSaved = false;
      const second = f.workspaces.writeTextFile("other", { path: "note.txt", text: "independent", expectedRevision: otherRevision }).then(() => { otherSaved = true; });
      await vi.waitFor(() => expect(otherSaved).toBe(true));
      release(); await Promise.all([first, second]);
    } finally { release?.(); vi.restoreAllMocks(); await f.workspaces.close(); }
  });

  it("pages the complete sorted search set and reports stream truncation accurately", async () => {
    const requests: RemoteProcessStartRequest[] = [];
    const lines = Array.from({ length: 1_001 }, (_, index) => JSON.stringify({ type: "match", data: { path: { text: index < 1_000 ? "note.txt" : "z.txt" },
      absolute_offset: index * 5, line_number: index + 1, lines: { text: "match\n" }, submatches: [{ start: 0, end: 5 }] } }));
    const f = await memoryWorkspaceFixture({ open: async request => { requests.push(request); return new CompletedRemoteProcess({ stdout: lines.slice().reverse().join("\n") }); } });
    try {
      const first = await f.workspaces.searchPage("workspace", "match", { maximumResults: 50 });
      expect(first).toMatchObject({ totalResults: 1_001, totalFiles: 2, truncated: true, nextOffset: 50 });
      expect(first.matches).toHaveLength(50); expect(first.matches[0]?.line).toBe(1);
      const later = await f.workspaces.searchPage("workspace", "match", { maximumResults: 50, offset: 200 });
      expect(later.matches[0]?.line).toBe(201); expect(later.revision).toBe(first.revision);
      const last = await f.workspaces.searchPage("workspace", "match", { maximumResults: 50, offset: 1_000 });
      expect(last).toMatchObject({ totalResults: 1_001, totalFiles: 2, truncated: false }); expect(last.nextOffset).toBeUndefined(); expect(last.matches).toHaveLength(1);
      const events = [];
      for await (const event of f.workspaces.searchStream("workspace", "match", false)) events.push(event);
      expect(events.filter(event => event.kind === "match")).toHaveLength(1_000);
      expect(events.at(-1)).toMatchObject({ kind: "end", truncated: true, totalResults: 1_001, totalFiles: 2, revision: first.revision });
      expect(requests.every(request => request.args.includes("--sort") && !request.args.includes("--max-count"))).toBe(true);
    } finally { await f.workspaces.close(); }
  });

  it("cancels the owned remote search process without accepting a late terminal result", async () => {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const events = new EventEmitter();
    const child = Object.assign(events, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      exitCode: null, signalCode: null, kill: vi.fn(() => { events.emit("exit", null, "SIGKILL"); return true; }) });
    const f = await memoryWorkspaceFixture({ open: async () => { entered(); return child; } });
    try {
      const controller = new AbortController(), stream = f.workspaces.searchStream("workspace", "match", false, controller.signal);
      const pending = stream.next(); await started; controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(child.kill).toHaveBeenCalled(); expect(f.capture).toHaveBeenCalledOnce();
    } finally { await f.workspaces.close(); }
  });

  it.each([
    { ending: "LF", lineEnding: "\n", preview: "😀" },
    { ending: "CRLF", lineEnding: "\r\n", preview: "😀" },
    { ending: "CRLF after a content CR", lineEnding: "\r\r\n", preview: "😀\r" }
  ])("preserves zero-width regular-expression anchors and Unicode byte boundaries with $ending", async ({ lineEnding, preview }) => {
    const f = await memoryWorkspaceFixture({ open: async () => new CompletedRemoteProcess({ stdout: JSON.stringify({ type: "match", data: {
      path: { text: "unicode.txt" }, line_number: 2, absolute_offset: 20, lines: { text: `😀${lineEnding}` }, submatches: [{ start: 0, end: 0 }, { start: 4, end: 4 }]
    } }) }) });
    try {
      const result = await f.workspaces.searchPage("workspace", "^|$", { regularExpression: true });
      expect(result).toMatchObject({ totalResults: 1, truncated: false, matches: [{ path: "unicode.txt", line: 2, preview, column: 1, endColumn: 1,
        startByte: 20, endByte: 20, submatches: [{ startByte: 0, endByte: 0 }, { startByte: 4, endByte: 4 }] }] });
    } finally { await f.workspaces.close(); }
  });

  it("keeps HTML resources and reloads on the original remote lease and registration across delayed reads", async () => {
    const files = new MemoryRemoteFiles();
    await files.mkdir("/workspace", { recursive: true });
    await files.write({ path: "/workspace/page.html", content: Buffer.from("<p>First</p>"), mode: 0o644 });
    await files.write({ path: "/workspace/details.html", content: Buffer.from("<p>Details</p>"), mode: 0o644 });
    await files.write({ path: "/workspace/script.js", content: Buffer.from("globalThis.value = 1"), mode: 0o644 });
    for (const name of ["module.wasm", "font.woff2", "sound.mp3", "movie.mp4", "pixel.bmp"] as const) {
      await files.write({ path: `/workspace/${name}`, content: Buffer.from([0, 1, 2, 3]), mode: 0o644 });
    }
    let generation = 1;
    const lease = { capabilities: { fileTransfer: true, processStreaming: true }, files, processes: {} };
    const capture = vi.fn(async (_targetId: string, _hostId: string, _signal?: AbortSignal) => {
      const captured = generation;
      return { hostRevision: BigInt(captured), leaseGeneration: captured, lease,
        assertCurrent: () => { if (generation !== captured) throw new Error("Remote lease changed"); } };
    });
    const remoteExecution = {
      workspace: async (binding: import("@joko/core").RemoteWorkspaceBinding) => ({
        kind: binding.kind, binding, executionIdentity: "ssh", authorityIdentity: "registration", pathStyle: "posix",
        files, processes: lease.processes, assertCurrent: () => undefined, assertForwardingCurrent: () => undefined
      }),
      files: async (binding: import("@joko/core").RemoteWorkspaceBinding, signal?: AbortSignal) => {
        if (binding.kind !== "ssh") throw new Error("unexpected binding");
        const current = await capture(binding.hostTargetId, binding.hostId, signal);
        return { kind: binding.kind, binding, executionIdentity: "ssh",
          authorityIdentity: `${current.hostRevision}:${current.leaseGeneration}`, pathStyle: "posix",
          files, assertCurrent: current.assertCurrent };
      }
    } as unknown as RemoteExecutionRouter;
    const workspaces = new WorkspaceService({ remoteDelegate: new RemoteWorkspaceService(remoteExecution) });
    const registration = { id: "workspace", root: "/workspace", displayName: "Remote", trusted: true,
      remote: { targetId: "target", binding: { kind: "ssh" as const, hostTargetId: "target", hostId: "host", workspaceRoot: "/workspace" } } };
    await workspaces.register(registration);
    const store = { getSession: () => ({ descriptor: { id: "session", targetId: "target", binding: { generation: 1, opaqueRef: "native" } } }),
      getTarget: () => ({ descriptor: { id: "target" }, metadata: { workspaceId: "workspace" }, revision: 1n }),
      findSetting: () => undefined, findPendingSessionLifecycleCleanup: () => undefined } as unknown as OperationalStore;
    const input = { store, workspaces, sessionId: "session", source: { workspaceId: "workspace", relativePath: "page.html", expectedRevision: "" }, assertConnection: () => undefined };
    const snapshot = await readWorkspaceHtmlSnapshot(input);
    expect(snapshot.html).toBe("<p>First</p>");
    const signal = new AbortController().signal;
    await writeRemoteHtml("Second");
    const reloaded = await snapshot.reload(signal);
    expect(reloaded.html).toBe("<p>Second</p>");
    expect(await reloaded.readDocument("details.html", signal)).toEqual({ html: "<p>Details</p>", mediaType: "text/html" });
    expect((await reloaded.readResource("script.js", signal)).mediaType).toBe("text/javascript");
    for (const [name, mediaType] of [["module.wasm", "application/wasm"], ["font.woff2", "font/woff2"],
      ["sound.mp3", "audio/mpeg"], ["movie.mp4", "video/mp4"], ["pixel.bmp", "image/bmp"]] as const) {
      expect(await reloaded.readResource(name, signal)).toEqual({ body: Buffer.from([0, 1, 2, 3]), mediaType });
    }
    expect(capture).toHaveBeenCalledOnce();
    let finish!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    const read = files.read.bind(files);
    const readSpy = vi.spyOn(files, "read").mockImplementationOnce(async (request) => { const value = await read(request); started(); await blocked; return value; });
    const late = reloaded.readResource("script.js", signal);
    await entered;
    generation = 2; finish();
    await expect(late).rejects.toThrow("Remote lease changed");
    await expect(reloaded.reload(signal)).rejects.toThrow("Remote lease changed");
    expect(capture).toHaveBeenCalledOnce();
    readSpy.mockRestore();
    await expect(readWorkspaceHtmlSnapshot({ ...input, source: reloaded.file })).rejects.toMatchObject({ kind: "stale" });
    const fresh = await readWorkspaceHtmlSnapshot(input);
    expect(fresh.html).toContain("Second");
    expect(capture).toHaveBeenCalledTimes(3);
    expect(fresh.file.expectedRevision).not.toBe(reloaded.file.expectedRevision);
    await workspaces.register(registration);
    await expect(fresh.readResource("script.js", signal)).rejects.toMatchObject({ kind: "stale" });
    const connectAbort = new AbortController();
    let connecting!: () => void;
    const connectEntered = new Promise<void>((resolve) => { connecting = resolve; });
    capture.mockImplementationOnce(async (_targetId, _hostId, requestSignal) => {
      connecting();
      await new Promise<void>((resolve) => requestSignal!.addEventListener("abort", () => resolve(), { once: true }));
      requestSignal!.throwIfAborted();
      throw new Error("Cancelled capture cannot return an authority.");
    });
    const cancelledCapture = readWorkspaceHtmlSnapshot({ ...input, signal: connectAbort.signal });
    await connectEntered;
    expect(capture).toHaveBeenLastCalledWith("target", "host", connectAbort.signal);
    connectAbort.abort();
    await expect(cancelledCapture).rejects.toMatchObject({ name: "AbortError" });
    await workspaces.close();

    async function writeRemoteHtml(value: string): Promise<void> {
      await files.write({ path: "/workspace/page.html", content: Buffer.from(`<p>${value}</p>`), mode: 0o644 });
    }
  });

  it("restores registration while offline and validates each later route and canonical root", async () => {
    const files = new MemoryRemoteFiles();
    await files.mkdir("/canonical", { recursive: true });
    const processes = { open: async () => new CompletedRemoteProcess({}) };
    let capture: () => Promise<unknown> = async () => { throw new Error("Remote workspace transports are unavailable."); };
    const remoteExecution = { workspace: async () => capture() } as unknown as RemoteExecutionRouter;
    const workspaces = new WorkspaceService({ remoteDelegate: new RemoteWorkspaceService(remoteExecution) });
    await workspaces.register({
      id: "workspace-a",
      root: "/canonical",
      displayName: "Remote",
      trusted: true,
      remote: { targetId: "target-a", binding: { kind: "ssh", hostTargetId: "target-a", hostId: "host-a", workspaceRoot: "/canonical" } }
    });
    expect(workspaces.listRegistrations()).toHaveLength(1);
    await expect(workspaces.list("workspace-a", "", {})).rejects.toThrow("transports are unavailable");

    let current = true;
    capture = async () => ({
      files,
      processes,
      pathStyle: "posix",
      assertCurrent: () => { if (!current) throw new Error("Remote route changed."); }
    });
    expect(await workspaces.list("workspace-a", "", {})).toEqual([]);

    const realpath = vi.spyOn(files, "realpath").mockResolvedValueOnce("/not-canonical");
    await expect(workspaces.list("workspace-a", "", {})).rejects.toThrow("canonical directory");
    realpath.mockRestore();
    current = false;
    await expect(workspaces.list("workspace-a", "", {})).rejects.toThrow("Remote route changed");
    await workspaces.close();
  });
});

async function memoryWorkspaceFixture(processes: RemoteProcessTransportPort = { open: async () => new CompletedRemoteProcess({}) }) {
  const files = new MemoryRemoteFiles(); await files.mkdir("/workspace", { recursive: true });
  const binding: Extract<import("@joko/core").RemoteWorkspaceBinding, { kind: "ssh" }> = {
    kind: "ssh", hostTargetId: "target", hostId: "host", workspaceRoot: "/workspace"
  };
  const capture = vi.fn(async (binding: Extract<import("@joko/core").RemoteWorkspaceBinding, { kind: "ssh" }>) => ({
    kind: "ssh" as const, binding, executionIdentity: binding.hostId, authorityIdentity: "route", pathStyle: "posix" as const,
    files, processes, assertCurrent: () => undefined, assertFilesCurrent: () => undefined, assertForwardingCurrent: () => undefined
  }));
  const router = { workspace: capture, files: capture } as unknown as RemoteExecutionRouter;
  const remote = new RemoteWorkspaceService(router), workspaces = new WorkspaceService({ remoteDelegate: remote });
  const registration = { id: "workspace", root: "/workspace", displayName: "Remote", trusted: true, remote: { targetId: "target", binding } };
  await workspaces.register(registration);
  return { files, processes, capture, remote, workspaces, registration };
}

type MemoryEntry =
  | { kind: "directory"; mode: number; modifiedAt: number }
  | { kind: "file"; mode: number; modifiedAt: number; content: Buffer };

class MemoryRemoteFiles implements RemoteFileTransportPort {
  readonly #entries = new Map<string, MemoryEntry>();
  #clock = 1;

  async realpath(path: string): Promise<string> {
    const accepted = normalize(path);
    this.require(accepted);
    return accepted;
  }

  async stat(path: string): Promise<RemoteFileStat> {
    const entry = this.require(normalize(path));
    return {
      kind: entry.kind,
      size: entry.kind === "file" ? entry.content.byteLength : 0,
      modifiedAt: entry.modifiedAt,
      mode: entry.mode
    };
  }

  async list(path: string): Promise<readonly RemoteDirectoryEntry[]> {
    const parent = normalize(path);
    if (this.require(parent).kind !== "directory") throw new Error("Not a directory.");
    const prefix = parent === "/" ? "/" : `${parent}/`;
    const names = new Map<string, MemoryEntry["kind"]>();
    for (const [candidate, entry] of this.#entries) {
      if (!candidate.startsWith(prefix)) continue;
      const tail = candidate.slice(prefix.length);
      if (tail === "" || tail.includes("/")) continue;
      names.set(tail, entry.kind);
    }
    return [...names].sort(([left], [right]) => left.localeCompare(right)).map(([name, kind]) => ({ name, kind }));
  }

  async read(request: RemoteFileReadRequest): Promise<Uint8Array> {
    const entry = this.require(normalize(request.path));
    if (entry.kind !== "file") throw new Error("Not a file.");
    if (entry.content.byteLength > request.maximumBytes && request.allowTruncated !== true) {
      throw new Error("File exceeds maximum.");
    }
    return Buffer.from(entry.content.subarray(0, request.maximumBytes));
  }

  async write(request: RemoteFileWriteRequest): Promise<void> {
    const accepted = normalize(request.path);
    if (request.createOnly && this.#entries.has(accepted)) throw new Error("Destination exists.");
    if (request.createParents === true) await this.mkdir(parentPath(accepted), { recursive: true });
    if (this.require(parentPath(accepted)).kind !== "directory") throw new Error("Parent is not a directory.");
    this.#entries.set(accepted, {
      kind: "file",
      mode: request.mode ?? 0o600,
      modifiedAt: this.#clock++,
      content: Buffer.from(request.content)
    });
  }

  async mkdir(path: string, options?: { readonly recursive?: boolean; readonly mode?: number }): Promise<void> {
    const accepted = normalize(path);
    if (this.#entries.has(accepted)) {
      if (this.require(accepted).kind !== "directory") throw new Error("Path is not a directory.");
      return;
    }
    const parent = parentPath(accepted);
    if (parent !== accepted && !this.#entries.has(parent)) {
      if (options?.recursive !== true) throw new Error("Parent is missing.");
      await this.mkdir(parent, options);
    }
    this.#entries.set(accepted, { kind: "directory", mode: options?.mode ?? 0o755, modifiedAt: this.#clock++ });
  }

  async rename(sourcePath: string, destinationPath: string): Promise<void> {
    const source = normalize(sourcePath);
    const destination = normalize(destinationPath);
    this.require(source);
    if (this.#entries.has(destination)) throw new Error("Destination exists.");
    const moved = [...this.#entries].filter(([path]) => path === source || path.startsWith(`${source}/`));
    for (const [path] of moved) this.#entries.delete(path);
    for (const [path, entry] of moved) this.#entries.set(`${destination}${path.slice(source.length)}`, { ...entry, modifiedAt: this.#clock++ });
  }

  async remove(path: string, options?: { readonly recursive?: boolean }): Promise<void> {
    const accepted = normalize(path);
    this.require(accepted);
    const children = [...this.#entries.keys()].filter((candidate) => candidate.startsWith(`${accepted}/`));
    if (children.length > 0 && options?.recursive !== true) throw new Error("Directory is not empty.");
    for (const child of children) this.#entries.delete(child);
    this.#entries.delete(accepted);
  }

  private require(path: string): MemoryEntry {
    const entry = this.#entries.get(path);
    if (entry === undefined) throw new Error("Remote path is missing.");
    return entry;
  }
}

class CompletedRemoteProcess extends EventEmitter implements RemoteProcessHandle {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(result: { readonly stdout?: string; readonly stderr?: string; readonly exitCode?: number }) {
    super();
    setImmediate(() => {
      if (result.stdout !== undefined) this.stdout.end(result.stdout);
      else this.stdout.end();
      if (result.stderr !== undefined) this.stderr.end(result.stderr);
      else this.stderr.end();
      this.exitCode = result.exitCode ?? 0;
      this.emit("exit", this.exitCode, null);
    });
  }

  kill(): boolean {
    if (this.exitCode !== null) return false;
    this.exitCode = -1;
    this.emit("exit", null, "SIGKILL");
    return true;
  }
}

function normalize(value: string): string {
  const parts = value.replace(/\\/gu, "/").split("/").filter(Boolean);
  if (!value.startsWith("/") || parts.some((part) => part === "." || part === "..")) throw new Error("Unsafe path.");
  return `/${parts.join("/")}`;
}

function parentPath(value: string): string {
  const index = value.lastIndexOf("/");
  return index <= 0 ? "/" : value.slice(0, index);
}
