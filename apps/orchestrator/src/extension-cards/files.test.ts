import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ExtensionFileDeposits, sanitizeExtensionSaveName, captureExtensionFileWorkspace, type ExtensionFileWorkspace } from "./files.js";
import { OperationalStore } from "@joko/store";
import { ExtraDirectoryManager } from "../extra-directory-manager.js";
import { ExtensionNetwork, type ExtensionNetworkScope } from "./network.js";
import { parseExtensionNetwork } from "./network-manifest.js";
import type { ExtensionCardScope } from "./service.js";
import type { RemoteFileAuthority } from "../remote-execution-router.js";

const scope: ExtensionCardScope = { extensionId: "plugin", authorityKey: "installation", sessionId: "task", sessionCreatedAt: 1, targetId: "workspace", toolUseId: null };
const receipt = (args: Readonly<Record<string, unknown>>, key: string) => args[key] as { token: string };
async function fixture(run: (root: string, files: ExtensionFileDeposits, workspace: ExtensionFileWorkspace) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "joko-extension-file-"));
  try { await run(root, new ExtensionFileDeposits(), { root, assertCurrent: () => {} }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
it("issues host-only single-use directory receipts, skips credentials/development residue and binds the task/source", async () => fixture(async (root, files, workspace) => {
  await mkdir(join(root, "input", "nested"), { recursive: true }); await mkdir(join(root, "input", "node_modules"));
  await writeFile(join(root, "input", "nested", "report.txt"), "report"); await writeFile(join(root, "input", ".env.local"), "secret");
  await writeFile(join(root, "input", ".npmrc"), "secret"); await writeFile(join(root, "input", "node_modules", "discard.txt"), "discard");
  const prepared = await files.prepare(scope, { dir: join(root, "input"), title: "Report" }, workspace, () => {});
  expect(prepared).not.toHaveProperty("dir"); expect(JSON.stringify(prepared)).not.toContain(root);
  expect(prepared.dir_deposit).toMatchObject({ file_count: 1, total_bytes: 6, rel_paths: ["nested/report.txt"] });
  const token = receipt(prepared, "dir_deposit").token;
  expect(files.take({ ...scope, sessionId: "another" }, token)).toBeUndefined();
  expect(files.take({ ...scope, authorityKey: "replacement" }, token)).toBeUndefined();
  const taken = files.take(scope, token)!; expect(Buffer.from(await taken.files[0]!.read()).toString()).toBe("report");
  expect(files.take(scope, token)).toBeUndefined();
}));
it("refuses forged receipts, outside paths, expired receipts and changed directory links", async () => fixture(async (root, _files, workspace) => {
  let now = 1; const files = new ExtensionFileDeposits(() => now);
  await writeFile(join(root, "file"), "snapshot");
  await expect(files.prepare(scope, { dir_deposit: { token: "forged" } }, workspace, () => {})).rejects.toThrow("host");
  await expect(files.prepare(scope, { dir: tmpdir() }, workspace, () => {})).rejects.toThrow("inside");
  const args = await files.prepare(scope, { dir: join(root, "file") }, workspace, () => {});
  now += 600_000; expect(files.take(scope, receipt(args, "dir_deposit").token)).toBeUndefined();
  await mkdir(join(root, "input")); await writeFile(join(root, "input", "read.txt"), "original");
  const prepared = await files.prepare(scope, { dir: join(root, "input") }, workspace, () => {}), taken = files.take(scope, receipt(prepared, "dir_deposit").token)!;
  await rm(join(root, "input"), { recursive: true });
  await symlink(tmpdir(), join(root, "input"), process.platform === "win32" ? "junction" : "dir");
  await expect(taken.files[0]!.read()).rejects.toThrow("changed");
}));
it("saves binary and text bytes without overwriting, sanitizes names and revokes writes when the original authorization changes", async () => fixture(async (root, files, workspace) => {
  const args = await files.prepare(scope, { save_dir: root }, workspace, () => {}), token = receipt(args, "save_deposit").token;
  expect(args.save_deposit).toEqual({ token, dir_name: root.split(/[\\/]/u).at(-1) });
  await writeFile(join(root, "report.pdf"), "existing");
  expect(await files.write(scope, token, "../../report.pdf", Buffer.from("download"), () => {})).toBe("report (1).pdf");
  expect(await readFile(join(root, "report.pdf"), "utf8")).toBe("existing"); expect(await readFile(join(root, "report (1).pdf"), "utf8")).toBe("download");
  expect(await files.write({ ...scope, sessionCreatedAt: 2 }, token, "report.pdf", Buffer.from("wrong"), () => {})).toBeUndefined();
  expect(sanitizeExtensionSaveName("../../NUL.pdf. ")).toBe("_NUL.pdf");
  let authorized = true;
  const scoped = await files.prepare(scope, { save_dir: root }, { root, assertCurrent: () => { if (!authorized) throw new Error("revoked"); } }, () => {});
  authorized = false;
  await expect(files.write(scope, receipt(scoped, "save_deposit").token, "private.bin", Buffer.from("bytes"), () => {})).rejects.toThrow("revoked");
  expect(await readdir(root)).not.toContain("private.bin");
}));
it("reserves the save budget before asynchronous writes and retires installation receipts", async () => fixture(async (root, files, workspace) => {
  const args = await files.prepare(scope, { save_dir: root }, workspace, () => {}), token = receipt(args, "save_deposit").token;
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) => files.write(scope, token, `file-${index}`, new Uint8Array([index]), () => {})));
  expect(results.filter(Boolean)).toHaveLength(16); expect(await readdir(root)).toHaveLength(16);
  const next = await files.prepare(scope, { save_dir: root, dir: join(root, "file-0") }, workspace, () => {});
  files.retire(scope.authorityKey);
  expect(files.take(scope, receipt(next, "dir_deposit").token)).toBeUndefined();
  expect(await files.write(scope, receipt(next, "save_deposit").token, "retired", new Uint8Array(), () => {})).toBeUndefined();
}));
it("uploads directory snapshots and downloads owned files through the network bridge without exposing bytes to the page", async () => fixture(async (root, files, workspace) => {
  await writeFile(join(root, "input.txt"), "upload bytes");
  const prepared = await files.prepare(scope, { dir: join(root, "input.txt"), save_dir: root }, workspace, () => {});
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("accepted", { headers: { "content-type": "text/plain" } }))
    .mockResolvedValueOnce(new Response(new Uint8Array([0, 1, 2]), { headers: { "content-type": "application/zip", "content-disposition": "attachment; filename*=UTF-8''report%20one.zip" } }))
    .mockResolvedValueOnce(new Response('{"error":"missing"}', { status: 404, headers: { "content-type": "application/json" } }));
  const network = new ExtensionNetwork({ files, fetch: fetchMock, redact: value => value, resolveCredential: () => "" });
  const networkScope: ExtensionNetworkScope = { ...scope, declaration: parseExtensionNetwork({ hosts: ["files.example.test"] }), task: scope, readOnly: false, signal: new AbortController().signal, assertCurrent: () => {} };
  const upload = { token: receipt(prepared, "dir_deposit").token, fileField: "attachment", fields: { size: "{bytes}" } };
  const saveTo = { token: receipt(prepared, "save_deposit").token };
  expect(await network.request(networkScope, { url: "https://files.example.test/upload", method: "POST", uploadDir: upload })).toMatchObject({ ok: true, body: "accepted" });
  const multipart = Buffer.from(fetchMock.mock.calls[0]![1]!.body as ArrayBuffer).toString();
  expect(multipart).toContain('name="attachment"; filename="input.txt"'); expect(multipart).toContain("upload bytes"); expect(multipart).toContain("\r\n12\r\n");
  expect(await network.request(networkScope, { url: "https://files.example.test/upload", method: "POST", uploadDir: upload })).toMatchObject({ ok: false }); expect(fetchMock).toHaveBeenCalledTimes(1);
  const result = await network.request(networkScope, { url: "https://files.example.test/file", as: "file", saveTo });
  expect(result).toMatchObject({ ok: true, file: { file_name: "report one.zip", bytes: 3, mime_type: "application/zip" } }); expect(result).not.toHaveProperty("body");
  expect(await readFile(join(root, "report one.zip"))).toEqual(Buffer.from([0, 1, 2]));
  expect(await network.request(networkScope, { url: "https://files.example.test/missing", as: "file", saveTo })).toMatchObject({ ok: true, status: 404, body: '{"error":"missing"}' });
  for (const payload of [{ as: "file" }, { as: "file", saveTo: { token: "forged" } }, { saveTo }, { method: "GET", uploadDir: upload }, { method: "POST", uploadDir: { ...upload, fileFieldPrefix: "file-" } }]) {
    expect(await network.request(networkScope, { url: "https://files.example.test/file", ...payload })).toMatchObject({ ok: false });
  }
  expect(await network.request({ ...networkScope, readOnly: true }, { url: "https://files.example.test/file", as: "file", saveTo })).toMatchObject({ ok: false }); expect(fetchMock).toHaveBeenCalledTimes(3);
}));
it("uses the exact remote transport and exclusive target write, keeps remote paths out of receipts and never retries a lost write acknowledgement", async () => {
  const entries = new Map<string, Uint8Array>([["/work/input.txt", Buffer.from("remote input")], ["/work/report.bin", Buffer.from("existing")]]);
  let current = true, failWrite = false;
  const write = vi.fn(async (request: { path: string; content: Uint8Array; createOnly?: boolean }) => {
    expect(request.createOnly).toBe(true); if (entries.has(request.path)) throw new Error("exists");
    entries.set(request.path, request.content); if (failWrite) throw new Error("lost acknowledgement");
  });
  const remote: RemoteFileAuthority = { kind: "ssh", pathStyle: "posix", executionIdentity: "machine", authorityIdentity: "lease", binding: { kind: "ssh", hostTargetId: "host", hostId: "one", workspaceRoot: "/work" }, assertCurrent: () => { if (!current) throw new Error("lease revoked"); },
    files: { realpath: async value => value, stat: async value => {
      if (value === "/work") return { kind: "directory", size: 0, modifiedAt: 1, mode: 0o700 };
      const bytes = entries.get(value); if (!bytes) throw new Error("missing"); return { kind: "file", size: bytes.byteLength, modifiedAt: 1, mode: 0o600 };
    }, read: async request => entries.get(request.path)!, write, list: async () => [], mkdir: async () => {}, rename: async () => {}, remove: async () => {} } };
  const files = new ExtensionFileDeposits(), workspace = { root: "/work", remote, assertCurrent: remote.assertCurrent };
  const args = await files.prepare(scope, { dir: "/work/input.txt", save_dir: "/work" }, workspace, () => {});
  expect(JSON.stringify(args)).not.toContain("/work");
  const transfer = files.take(scope, receipt(args, "dir_deposit").token)!; expect(Buffer.from(await transfer.files[0]!.read()).toString()).toBe("remote input");
  expect(await files.write(scope, receipt(args, "save_deposit").token, "report.bin", Buffer.from("download"), () => {})).toBe("report (1).bin");
  failWrite = true;
  await expect(files.write(scope, receipt(args, "save_deposit").token, "unknown.bin", Buffer.from("unknown"), () => {})).rejects.toThrow("lost acknowledgement");
  expect(write).toHaveBeenCalledTimes(2); expect(entries.has("unknown (1).bin")).toBe(false);
  current = false;
  await expect(files.write(scope, receipt(args, "save_deposit").token, "revoked.bin", new Uint8Array(), () => {})).rejects.toThrow("lease revoked");
});
it("consumes existing extra-directory approvals with their exact read/write scope and fences receipts immediately on revocation", async () => fixture(async (root, files) => {
  const project = join(root, "project"), readOnly = join(root, "references"), readWrite = join(root, "exports");
  for (const directory of [project, readOnly, readWrite]) await mkdir(directory);
  await writeFile(join(readOnly, "input.txt"), "approved input");
  const store = new OperationalStore(":memory:");
  try {
    store.upsertBackend({ id: "runtime", displayName: "Runtime", version: "test", health: "healthy", adapterKind: "fixture", instanceGeneration: 0,
      installationState: "installed", authenticationState: "authenticated", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
    store.upsertTarget({ id: "workspace", backendId: "runtime", displayName: "Workspace", workspaceRoot: project, managed: false, trusted: true });
    store.createSession({ id: "task", backendId: "runtime", targetId: "workspace", title: "Task", binding: { opaqueRef: "native", generation: 1 },
      pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
    const extras = new ExtraDirectoryManager(store), approvedRead = await extras.add({ workspaceId: "workspace", serverPath: readOnly, access: "read_only" });
    await extras.add({ workspaceId: "workspace", serverPath: readWrite, access: "read_write" });
    const registration = { id: "workspace", root: project, displayName: "Workspace", trusted: true }, workspaces = { listRegistrations: () => [registration] };
    const capture = () => captureExtensionFileWorkspace(store, workspaces, { sessionId: "task", targetId: "workspace", generation: 1 }, undefined, undefined, extras);
    const workspace = await capture();
    await expect(files.prepare(scope, { save_dir: readOnly }, workspace, () => {})).rejects.toThrow("permitted directories");
    await expect(files.prepare(scope, { dir: root }, workspace, () => {})).rejects.toThrow("permitted directories");
    const args = await files.prepare(scope, { dir: join(readOnly, "input.txt"), save_dir: readWrite }, workspace, () => {});
    const transfer = files.take(scope, receipt(args, "dir_deposit").token)!;
    expect(Buffer.from(await transfer.files[0]!.read()).toString()).toBe("approved input");
    expect(await files.write(scope, receipt(args, "save_deposit").token, "report.bin", new Uint8Array([1, 2]), () => {})).toBe("report.bin");
    extras.remove(approvedRead.id);
    await expect(transfer.files[0]!.read()).rejects.toThrow("directories changed");
    await expect(files.write(scope, receipt(args, "save_deposit").token, "revoked.bin", new Uint8Array(), () => {})).rejects.toThrow("directories changed");
    expect(await readdir(readWrite)).toEqual(["report.bin"]);
  } finally { store.close(); }
}));
it("keeps the admitted turn's explicit extra-directory selection instead of borrowing the target's other approvals", async () => fixture(async (root, files) => {
  const project = join(root, "project"), selected = join(root, "selected"), omitted = join(root, "omitted");
  for (const directory of [project, selected, omitted]) await mkdir(directory);
  await writeFile(join(selected, "input.txt"), "selected input");
  const store = new OperationalStore(":memory:");
  try {
    store.upsertBackend({ id: "runtime", displayName: "Runtime", version: "test", health: "healthy", adapterKind: "fixture", instanceGeneration: 0,
      installationState: "installed", authenticationState: "authenticated", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
    store.upsertTarget({ id: "workspace", backendId: "runtime", displayName: "Workspace", workspaceRoot: project, managed: false, trusted: true });
    store.createSession({ id: "task", backendId: "runtime", targetId: "workspace", title: "Task", binding: { opaqueRef: "native", generation: 1 },
      pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
    const extras = new ExtraDirectoryManager(store), approval = await extras.add({ workspaceId: "workspace", serverPath: selected, access: "read_only" });
    await extras.add({ workspaceId: "workspace", serverPath: omitted, access: "read_write" });
    store.runOperation({ id: "input-operation", kind: "input", body: {} }, target => {
      target.createRun({ id: "run", sessionId: "task", source: "user", state: "queued", createdAt: 1 });
      target.createAttempt({ id: "attempt", runId: "run", ordinal: 1, generation: 1, startedAt: 1 });
      target.enqueueQueueItem({ id: "queue", sessionId: "task", runId: "run", attemptId: "attempt", operationId: "input-operation", disposition: "prompt",
        body: { text: "Use selected directory", images: [], files: [], mentions: [], disposition: "prompt" }, executionOverrides: { extraDirectoryIds: [approval.id] } }); return {};
    });
    expect(store.claimNextQueueItem({ sessionId: "task", backendInstanceGeneration: 0 })).toBeDefined();
    const registration = { id: "workspace", root: project, displayName: "Workspace", trusted: true };
    const workspace = await captureExtensionFileWorkspace(store, { listRegistrations: () => [registration] }, { sessionId: "task", targetId: "workspace", generation: 1 }, undefined, undefined, extras);
    expect(workspace.extraRoots).toEqual([{ path: selected, access: "read_only" }]);
    await expect(files.prepare(scope, { save_dir: omitted }, workspace, () => {})).rejects.toThrow("permitted directories");
    const args = await files.prepare(scope, { dir: join(selected, "input.txt") }, workspace, () => {});
    expect(files.take(scope, receipt(args, "dir_deposit").token)).toBeDefined();
    store.updateQueueState({ queueItemId: "queue", state: "failed", traceId: "turn-ended", error: { code: "TURN_ENDED", message: "The selected turn ended.", phase: "dispatch", retryable: false, stateMayHaveChanged: false, recovery: "Start a new turn." } });
    expect(() => workspace.assertCurrent()).toThrow("directories changed");
  } finally { store.close(); }
}));
