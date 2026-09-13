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

import type { RemoteHostRegistry } from "./remote-host-registry.js";
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
                lines: { text: "hello remote workspace\n" },
                submatches: [{ start: 6, end: 12 }]
              }
            })}\n`
          });
        }
        if (request.executable === "git" && request.args[0] === "status" && request.args.includes("--porcelain=v1")) {
          return new CompletedRemoteProcess({ stdout: "## main\0 M README.md\0" });
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
    const registry = {
      transports: async (targetId: string, hostId: string) => {
        scopes.push([targetId, hostId]);
        return { host: {}, lease };
      }
    } as unknown as RemoteHostRegistry;
    const remote = new RemoteWorkspaceService(registry);
    const workspaces = new WorkspaceService({ remoteDelegate: remote });

    await workspaces.register({
      id: "workspace-a",
      root: "/workspace",
      displayName: "Remote project",
      trusted: true,
      remote: { targetId: "target-a", hostId: "host-a", workspaceRoot: "/workspace" }
    });

    const listing = await workspaces.list("workspace-a", "", { recursive: true });
    expect(listing.map((entry) => entry.path)).toEqual(["src", "src/main.ts", "README.md", "scene.gltf"]);
    expect(listing.some((entry) => entry.path.startsWith(".git"))).toBe(false);

    const prefix = await workspaces.preview("workspace-a", "README.md", 5);
    expect(prefix).toMatchObject({ text: "hello", truncated: true, mediaType: "text/markdown" });
    const model = await workspaces.preview("workspace-a", "scene.gltf", 5);
    expect(model).toMatchObject({ mediaType: "model/gltf+json", truncated: false });
    expect(model.text).toBeUndefined();
    expect(model.bytes).toBeUndefined();
    await files.write({ path: "/workspace/page.html", content: Buffer.from("<p>Remote HTML</p>"), mode: 0o644 });
    expect(await workspaces.preview("workspace-a", "page.html")).toMatchObject({ mediaType: "text/html", text: "<p>Remote HTML</p>", truncated: false });
    await expect(workspaces.preview("workspace-a", "page.html", 2 * 1024 * 1024, 4)).rejects.toMatchObject({ kind: "unsupported" });
    await files.write({ path: "/workspace/page.html", content: Buffer.from([0xff, 0xfe]), mode: 0o644 });
    await expect(workspaces.preview("workspace-a", "page.html")).rejects.toMatchObject({ kind: "unsupported" });
    const realpath = vi.spyOn(files, "realpath");
    realpath.mockResolvedValueOnce("/outside/page.html");
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
    const registry = { transports: async () => ({ lease }), captureTransportAuthority: capture } as unknown as RemoteHostRegistry;
    const workspaces = new WorkspaceService({ remoteDelegate: new RemoteWorkspaceService(registry) });
    const registration = { id: "workspace", root: "/workspace", displayName: "Remote", trusted: true,
      remote: { targetId: "target", hostId: "host", workspaceRoot: "/workspace" } };
    await workspaces.register(registration);
    const store = { getSession: () => ({ descriptor: { id: "session", targetId: "target", binding: { generation: 1, opaqueRef: "native" } } }),
      getTarget: () => ({ descriptor: { id: "target" }, metadata: { workspaceId: "workspace" }, revision: 1n }), findPendingSessionLifecycleCleanup: () => undefined } as unknown as OperationalStore;
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

  it("fails registration closed for non-canonical or missing transport capabilities", async () => {
    const files = new MemoryRemoteFiles();
    await files.mkdir("/canonical", { recursive: true });
    const registry = {
      transports: async () => ({
        host: {},
        lease: {
          capabilities: {
            commandExecution: false,
            processStreaming: false,
            fileTransfer: true,
            tcpForwarding: false,
            interactiveTerminal: false
          },
          files
        }
      })
    } as unknown as RemoteHostRegistry;
    const workspaces = new WorkspaceService({ remoteDelegate: new RemoteWorkspaceService(registry) });
    await expect(workspaces.register({
      id: "workspace-a",
      root: "/canonical",
      displayName: "Remote",
      trusted: true,
      remote: { targetId: "target-a", hostId: "host-a", workspaceRoot: "/canonical" }
    })).rejects.toThrow("transports are unavailable");
    expect(workspaces.listRegistrations()).toEqual([]);
    await workspaces.close();
  });
});

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
