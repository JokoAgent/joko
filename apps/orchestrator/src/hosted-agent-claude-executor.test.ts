import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { AdapterContext } from "@joko/core";
import { createClaudeHostedTools } from "@joko/adapter-claude-code";
import { HostedAgentClaudeExecutor } from "./hosted-agent-claude-executor.js";
import { HostedAgentExecutor } from "./hosted-agent-executor.js";
import { createHostedAgentToolChannel } from "./hosted-agent-tool-channel.js";
import { readHostedAgentClaudePdf } from "./hosted-agent-claude-pdf.js";

describe("Claude Source MCP executor", () => {
  it("shrinks large Source images to the fixed native vision size without replacing the original", async () => {
    const f = await fixture();
    try {
      const original = await sharp(randomBytes(2000 * 1200 * 3), { raw: { width: 2000, height: 1200, channels: 3 } }).png().toBuffer();
      await writeFile(join(f.source, "large.png"), original);
      const response = await f.call("Read", { file_path: join(f.virtual, "large.png") });
      expect(response).toMatchObject({ isError: false, content: [{ type: "image", mimeType: "image/webp" }] });
      const image = response.content[0] as { data: string };
      const rendered = Buffer.from(image.data, "base64"), metadata = await sharp(rendered).metadata();
      expect(metadata.width).toBe(1568); expect(metadata.height).toBeLessThanOrEqual(1568); expect(rendered.byteLength).toBeLessThanOrEqual(5 * 1024 * 1024);
      expect((await readFile(join(f.source, "large.png"))).equals(original)).toBe(true);
    } finally { await f.close(); }
  });
  it("streams explicit text ranges beyond the full-read boundary and keeps original file revisions for edits", async ({ onTestFailed }) => {
    let phase = "fixture"; const started = performance.now();
    onTestFailed(() => { console.info("Source ranged read failure:", { phase, elapsedMs: Math.round(performance.now() - started) }); });
    const f = await fixture();
    try {
      const ranged = join(f.virtual, "ranged.txt"), contents = Array.from({ length: 3000 }, (_, index) => `line-${index + 1}`).join("\n");
      await writeFile(join(f.source, "ranged.txt"), contents);
      phase = "explicit 2500 lines";
      const response = await f.call("Read", { file_path: ranged, limit: 2500 });
      expect(response).toMatchObject({ isError: false, content: [{ text: expect.stringContaining("2500\tline-2500") }] });
      expect(JSON.stringify(response)).not.toContain("line-2501");
      phase = "large file creation";
      await writeFile(join(f.source, "large.txt"), ("x".repeat(1000) + "\n").repeat(18_000));
      phase = "full-read bound";
      expect(await f.call("Read", { file_path: join(f.virtual, "large.txt") })).toMatchObject({ isError: true });
      phase = "large file streaming range";
      expect(await f.call("Read", { file_path: join(f.virtual, "large.txt"), offset: 17000, limit: 1 }))
        .toMatchObject({ isError: false, content: [{ text: "17000\t" + "x".repeat(1000) }] });
      phase = "original file revision";
      await writeFile(join(f.source, "paths.txt"), "Original path: " + f.source);
      await f.call("Read", { file_path: join(f.virtual, "paths.txt") });
      expect(await f.call("Edit", { file_path: join(f.virtual, "paths.txt"), old_string: "Original path", new_string: "Updated path" })).toMatchObject({ isError: false });
      expect(await readFile(join(f.source, "paths.txt"), "utf8")).toContain("Updated path");
    } finally { await f.close(); }
  });
  it("keeps reads, guarded edits, new parents, notebooks and images on Source through the private channel", async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.source, "note.txt"), "one\r\ntwo\r\n");
      const file = join(f.virtual, "note.txt");
      expect(await f.call("Write", { file_path: file, content: "unsafe overwrite" })).toMatchObject({ isError: true });
      expect(await f.call("Read", { file_path: file })).toMatchObject({ isError: false, content: [{ type: "text", text: "1\tone\n2\ttwo\n3\t" }] });
      expect(await f.call("Edit", { file_path: file, old_string: "two", new_string: "second" })).toMatchObject({ isError: false });
      expect(await readFile(join(f.source, "note.txt"), "utf8")).toBe("one\r\nsecond\r\n");
      await writeFile(join(f.source, "note.txt"), "external update");
      expect(await f.call("Edit", { file_path: file, old_string: "second", new_string: "unsafe" })).toMatchObject({ isError: true });
      expect(await f.call("Write", { file_path: join(f.virtual, "new", "file.txt"), content: "created on Source" })).toMatchObject({ isError: false });
      expect(await readFile(join(f.source, "new", "file.txt"), "utf8")).toBe("created on Source");
      const notebook = { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ id: "cell-a", cell_type: "code", metadata: {}, source: ["print(1)"],
        outputs: [{ output_type: "display_data", data: { "image/png": "controlled-image" } }, { output_type: "error", ename: "ValueError", evalue: "Source notebook error" }], execution_count: null }] };
      await writeFile(join(f.source, "demo.ipynb"), JSON.stringify(notebook, null, 2));
      const rendered = await f.call("Read", { file_path: join(f.virtual, "demo.ipynb") });
      expect(rendered).toMatchObject({ content: [{ text: expect.stringContaining('id="cell-a"') }] });
      expect(JSON.stringify(rendered)).toContain("[image output]"); expect(JSON.stringify(rendered)).toContain("ValueError: Source notebook error");
      expect(await f.call("NotebookEdit", { notebook_path: join(f.virtual, "demo.ipynb"), cell_id: "cell-a", new_source: "print(2)" })).toMatchObject({ isError: false });
      const updatedNotebook = await readFile(join(f.source, "demo.ipynb"), "utf8");
      expect(JSON.parse(updatedNotebook).cells[0].source).toBe("print(2)"); expect(updatedNotebook.endsWith("\n")).toBe(true);
      await writeFile(join(f.source, "legacy.ipynb"), JSON.stringify({ nbformat: 4, nbformat_minor: 4, metadata: {}, cells: [] }));
      expect(await f.call("Read", { file_path: join(f.virtual, "legacy.ipynb") })).toMatchObject({ content: [{ text: expect.stringContaining("notebook has no cells") }] });
      expect(await f.call("NotebookEdit", { notebook_path: join(f.virtual, "legacy.ipynb"), edit_mode: "insert", cell_type: "markdown", new_source: "Source note" })).toMatchObject({ isError: false });
      const legacy = JSON.parse(await readFile(join(f.source, "legacy.ipynb"), "utf8")); expect(legacy.cells[0].id).toBeUndefined(); expect(legacy.cells[0].source).toBe("Source note");
      await writeFile(join(f.source, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2lVQAAAAASUVORK5CYII=", "base64"));
      expect(await f.call("Read", { file_path: join(f.virtual, "pixel.png") })).toMatchObject({ content: [{ type: "image", mimeType: "image/png" }] });
      await expect(readFile(join(f.virtual, "note.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await f.close(); }
  });
  it("uses Source shell cwd and retains actual background output until stopped", async () => {
    const f = await fixture();
    try {
      await mkdir(join(f.source, "child"));
      const first = await f.call("Bash", { command: "cd child; pwd" });
      expect(first).toMatchObject({ isError: false, content: [{ text: expect.stringContaining("child") }] });
      expect(await f.call("Bash", { command: "pwd" })).toMatchObject({ isError: false, content: [{ text: expect.stringContaining("child") }] });
      const launch = await f.call("Bash", { command: "printf 'source-first\\n'; sleep 30", run_in_background: true });
      const id = /shell-[a-f0-9-]+/u.exec(JSON.stringify(launch))?.[0]; expect(id).toBeDefined();
      let observed = "";
      for (let attempt = 0; attempt < 80 && !observed.includes("source-first"); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 25));
        observed += JSON.stringify(await f.call("BashOutput", { bash_id: id }));
      }
      expect(observed).toContain("source-first");
      expect(await f.call("KillShell", { shell_id: id })).toMatchObject({ isError: false });
      expect(await f.call("BashOutput", { bash_id: id })).toMatchObject({ content: [{ text: expect.stringContaining("completed") }] });
    } finally { await f.close(); }
  }, 30_000);
  it("never grants a pending native call another operation's authority", async () => {
    const f = await fixture();
    try {
      const first = { format: 1, callId: "tool-original", requestId: "tool-original:1", operation: "tool.begin",
        payload: { name: "claude", input: { name: "Write", arguments: { file_path: join(f.virtual, "private.txt"), content: "never" } } } };
      await f.helper.execute(first, f.context.signal, f.executor);
      const other = new HostedAgentExecutor({ context: { ...f.context, operationId: "other-operation" }, virtualRoot: f.virtual,
        assertCurrent: () => {}, readPolicy: () => ({ revision: "1", permissionMode: "bypassPermissions", planMode: false, approvedRoots: [], confirmCredentials: false }) });
      try {
        await expect(f.helper.execute({ format: 1, callId: first.callId, requestId: "tool-original:2", operation: "claude.call", payload: {} }, f.context.signal, other))
          .rejects.toMatchObject({ code: "ACCESS_DENIED" });
        await expect(readFile(join(f.source, "private.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      } finally { other.dispose(); }
    } finally { await f.close(); }
  });
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joko-hosted-claude-source-"))), source = join(root, "source"), virtual = join(root, "model");
  await Promise.all([mkdir(source), mkdir(virtual)]); const lifetime = new AbortController();
  const context: AdapterContext = { sessionId: "source-task", generation: 1, backendInstanceGeneration: 1, operationId: "source-input", signal: lifetime.signal,
    target: { id: "source-target", backendId: "source-backend", displayName: "Source", workspaceRoot: source, managed: false, trusted: true },
    emit: async () => {}, requestInteraction: async () => ({ kind: "cancelled" }), artifactCapacityBytes: 1024,
    storeArtifact: async () => { throw new Error("No Artifact expected."); } };
  const executor = new HostedAgentExecutor({ context, virtualRoot: virtual, assertCurrent: () => lifetime.signal.throwIfAborted(),
    readPolicy: () => ({ revision: "1", permissionMode: "bypassPermissions", planMode: false, approvedRoots: [], confirmCredentials: false }) });
  const helper = new HostedAgentClaudeExecutor({ workspaceRoot: virtual, signal: lifetime.signal, assertCurrent: () => lifetime.signal.throwIfAborted() });
  const authorization = { execute: executor.execute.bind(executor), readPdf: readHostedAgentClaudePdf };
  const channel = await createHostedAgentToolChannel({ assertCurrent: () => lifetime.signal.throwIfAborted(), execute: async (input, signal) => {
    const { origin, ...primitive } = input as Record<string, unknown>; if (origin !== "agent") throw new Error("Wrong native owner.");
    return await helper.execute(primitive, signal, authorization) ?? executor.execute(primitive, signal);
  } });
  const tools = createClaudeHostedTools({ workspace: { root: virtual, additionalRoots: [], platform: process.platform as "win32" | "darwin" | "linux", shell: "bash", isGitRepository: false },
    source: { sessionId: context.sessionId, targetId: context.target.id, generation: context.generation }, channel,
    trust: "owner", assertCurrent: () => lifetime.signal.throwIfAborted() });
  return { root, source, virtual, context, executor, helper,
    call: (name: string, arguments_: Record<string, unknown>) => tools.find(tool => tool.name === name)!.call(arguments_, { toolUseId: name, signal: lifetime.signal }),
    async close() { lifetime.abort(); await channel.close(); await helper.dispose(); executor.dispose();
      const suffix = relative(resolve(tmpdir()), root); if (!suffix || suffix === ".." || suffix.startsWith(".." + sep)) throw new Error("Unsafe test cleanup.");
      await rm(root, { recursive: true, force: true }); }
  };
}
