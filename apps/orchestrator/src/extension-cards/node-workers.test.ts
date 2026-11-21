import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultManagedProcessSupervisor } from "@joko/runtime-governance";
import { OperationalStore } from "@joko/store";
import { expect, it, vi } from "vitest";
import type { ExtensionMainViewAuthority } from "../extension-main-view-manager.js";
import { PiResourceManager } from "../resource-manager.js";
import { mkdtemp } from "../test-paths.js";
import { ExtensionNodeWorkers } from "./node-workers.js";
import type { DownloadResponse } from "./verified-downloads.js";

it("leases verified bytes to the declared worker of one installed package and cancels its original process", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-node-downloads-"));
  const workerRoot = join(root, "worker-runtime");
  const store = new OperationalStore(join(root, "orchestrator.db"));
  store.upsertBackend({ id: "pi", displayName: "Pi", version: "1.5.2", health: "healthy", adapterKind: "pi",
    instanceGeneration: 1, installationState: "installed", authenticationState: "not_required", models: [], tools: [], diagnostics: [],
    capabilities: new Map([["runtime.resources", { key: "runtime.resources", supported: true, options: ["package"] }]]) });
  const resources = new PiResourceManager({ store, managedRoot: join(root, "resources") });
  const body = Buffer.from("verified rules\n", "utf8");
  const download: DownloadResponse = { status: 200, contentLength: String(body.length),
    body: { async *[Symbol.asyncIterator]() { yield body.subarray(0, 3); yield body.subarray(3); } }, close: () => undefined };
  const openDownload = vi.fn(async (url: URL): Promise<DownloadResponse> => url.pathname === "/foreign"
    ? { ...download, status: 302, location: "https://other.example.test/rules" } : download);
  const workers = new ExtensionNodeWorkers({ rootDirectory: workerRoot, generation: 1,
    supervisor: createDefaultManagedProcessSupervisor(), resources, redact: value => value, openDownload });
  const lifetime = new AbortController();
  try {
    await resources.initialize();
    const source = join(root, "source");
    await mkdir(join(source, "ui"), { recursive: true });
    await mkdir(join(source, "workers"));
    const html = "ui/index.html";
    const entry = "extension.mjs";
    const worker = { entry: "workers/rules.mjs", methods: ["readRules", "waitForCancellation"] };
    const runtime = { html, tools: [{ name: "rules", description: "Inspect a verified file.", inputSchema: { type: "object" } }],
      node: worker, network: { hosts: ["files.example.test"] } };
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "@joko-test/verified-worker", version: "1.0.0",
      pi: { extensions: [entry] }, joko: { extensionSurfaces: { schemaVersion: 1, extensions: [{ entry, runtime }] } } }));
    await writeFile(join(source, entry), "export default function setup() {}\n");
    await writeFile(join(source, html), "<!doctype html><title>Verified worker</title>");
    await writeFile(join(source, worker.entry), WORKER);
    const discovered = await resources.discoverPackage({ backendId: "pi", scope: "managed", source: { kind: "local", path: source } });
    await resources.approve(discovered.id, discovered.discoveredRevision, "connection-owner");
    await resources.install(discovered.id);
    const resource = await resources.setEnabled(discovered.id, true);
    const installation: ExtensionMainViewAuthority = { extensionId: "plugin-worker", resourceId: resource.id, backendId: "pi",
      backendRevision: store.getBackend("pi").revision, backendGeneration: 1, resourceRevision: resource.versionNumber,
      discoveredRevision: resource.discoveredRevision, packageName: resource.packageIdentity!, packageVersion: resource.version,
      extensionEntry: entry, mainView: { html } };
    let current = true;
    const owner = { key: "original-approval", installation, worker, downloadHosts: runtime.network.hosts, signal: lifetime.signal,
      assertCurrent: () => { if (!current) throw new Error("Approval changed."); } };
    const spec = { id: "rules", url: "https://files.example.test/rules", bytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex") };
    await expect(workers.download(owner, { ...spec, url: "https://files.example.test/foreign" })).rejects.toThrow(/destination/u);
    await expect(workers.download(owner, { ...spec, sha256: "a".repeat(64) })).rejects.toThrow("SHA-256");
    const receipt = await workers.download(owner, spec) as { token: string };
    await expect(workers.download(owner, spec)).resolves.toEqual(receipt);
    expect(openDownload).toHaveBeenCalledTimes(3);
    const input = { method: "readRules", downloadTokens: { rules: receipt.token } };
    await expect(workers.request({ ...owner, key: "different-approval" }, input)).rejects.toThrow("receipt");
    await expect(workers.request(owner, { ...input, params: { downloads: { rules: "client pathname" } } })).rejects.toThrow("invalid");
    await expect(workers.request(owner, { ...input, method: "undeclared" })).rejects.toThrow("undeclared");
    await expect(workers.request(owner, input)).resolves.toEqual({ ok: true, result: { content: body.toString(), path: "[host file]" } });
    const waiting = workers.request(owner, { ...input, method: "waitForCancellation" }).catch((error: unknown) => error);
    const processes = join(workerRoot, "processes", "1");
    await expect.poll(async () => (await readdir(processes).catch(() => [])).length).toBeGreaterThan(0);
    const cache = join(workerRoot, "downloads");
    const [file] = await readdir(cache);
    expect(await readFile(join(cache, file!), "utf8")).toBe(body.toString());
    await workers.cancelDownload(owner, spec.id);
    expect(await waiting).toBeInstanceOf(Error);
    await expect.poll(() => readdir(cache)).toEqual([]);
    await expect(readdir(join(workerRoot, "workers"))).resolves.toEqual([]);
    await expect(workers.request(owner, input)).rejects.toThrow("receipt");
    current = false;
    workers.retire(owner.key);
    await expect(workers.download(owner, spec)).rejects.toThrow("Approval changed");
  } finally {
    lifetime.abort();
    await workers.drain();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

const WORKER = `
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", async line => {
  const request = JSON.parse(line);
  const path = request.params.downloads.rules;
  const content = await readFile(path, "utf8");
  if (request.method === "waitForCancellation") return;
  process.stdout.write(JSON.stringify({jsonrpc: "2.0", id: request.id, result: { content, path }}) + "\\n");
});
`;
