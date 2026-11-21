import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rename, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexBackendAdapter } from "./adapter.js";
import { projectCodexNativeHistory } from "./native-history.js";
import { parseCodexPortableRollout, readCodexPortableRollout } from "./portable-rollout.js";
import { expect, it } from "vitest";
import { RpcRemoteFault } from "./errors.js";
import { useCodexHistoryHome } from "./external-auth.js";
import { AppServerHost } from "./host.js";
import { objectValue, parseFullTurnPage, parseThreadResult, stringValue } from "./protocol.js";

const executable = process.env["JOKO_CODEX_HOSTED_TEST_BINARY"];

it.skipIf(!executable).each(["paginated root", "legacy root", "derived lineage"] as const)(
  "continues a remapped Codex %s independently while retaining the exact native context", async strategy => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joko-codex-portable-rollout-")));
  const originalHome = join(root, "original-home"), receiverHome = join(root, "receiver-home");
  const originalProject = join(root, "original-project"), receiverProject = join(root, "receiver-project");
  const modelRequests: string[] = [];
  let phase = "starting owned fixture";
  const provider = createServer(async (request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
      request.resume();
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += Buffer.byteLength(chunk);
      if (size > 1_000_000) { response.writeHead(413).end(); return; }
      chunks.push(Buffer.from(chunk));
    }
    modelRequests.push(Buffer.concat(chunks).toString("utf8"));
    const number = modelRequests.length;
    const id = `portable-response-${number}`;
    const events = [
      { type: "response.created", response: { id } },
      { type: "response.output_item.done", item: { id: `portable-answer-${number}`, type: "message", role: "assistant",
        content: [{ type: "output_text", text: `Portable native reply ${number}.`, annotations: [] }] } },
      { type: "response.completed", response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
    ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  });
  const hosts: AppServerHost[] = [];
  let adapter: CodexBackendAdapter | undefined;
  const nativeTurn = async (host: AppServerHost, threadId: string, text: string) => {
    const completed = new EventEmitter();
    const subscription = await host.subscribe(threadId, host.generation, { onRequest: async () => undefined, onDisconnect: () => undefined,
      onNotification: (method, params) => { if (method === "turn/completed") completed.emit("turn", params); } });
    const terminal = once(completed, "turn", { signal: AbortSignal.timeout(20_000) });
    void terminal.catch(() => undefined);
    try {
      await host.request("turn/start", { threadId, input: [{ type: "text", text }] });
      expect((await terminal)[0]).toMatchObject({ turn: { status: "completed" } });
    } finally {
      await subscription.release({ unsubscribe: false });
    }
  };
  const readTurns = async (host: AppServerHost, threadId: string) => parseFullTurnPage((await host.request("thread/turns/list", {
    threadId, sortDirection: "asc", itemsView: "full", limit: 10
  })).value, { maximumTurns: 10, maximumItems: 60 }).turns;
  try {
    await Promise.all([originalHome, originalProject, receiverHome, receiverProject].map(directory => mkdir(directory)));
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    const address = provider.address();
    if (address === null || typeof address === "string") throw new Error("The owned model listener is unavailable.");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const startHost = async (home: string, cwd: string, providerId: "source-probe" | "receiver-probe") => {
      const host = new AppServerHost({ transport: { command: executable!, cwd, requestTimeoutMs: 20_000,
        env: useCodexHistoryHome({ PATH: process.env["PATH"] ?? "", HOME: home }, home),
        args: ["app-server", "--listen", "stdio://", "--disable", "plugins", "--disable", "remote_plugin",
          "-c", `model_provider=${JSON.stringify(providerId)}`, "-c", `model_providers.${providerId}.name="Probe"`,
          "-c", `model_providers.${providerId}.base_url=${JSON.stringify(baseUrl)}`, "-c", `model_providers.${providerId}.wire_api="responses"`,
          "-c", `model_providers.${providerId}.request_max_retries=0`, "-c", `model_providers.${providerId}.stream_max_retries=0`,
          "-c", `model_providers.${providerId}.requires_openai_auth=false`, "-c", `chatgpt_base_url=${JSON.stringify(baseUrl)}`]
      } });
      hosts.push(host);
      await host.ensureStarted();
      expect(host.initializeResult?.userAgent).toContain("0.166.0");
      return host;
    };
    const sessionConfig = { model: "gpt-6-astra", approvalPolicy: "never", sandbox: "read-only" } as const;
    phase = "starting the original thread";
    const originalHost = await startHost(originalHome, originalProject, "source-probe");
    const historyMode = strategy === "legacy root" ? "legacy" : "paginated";
    const sourceResult = (await originalHost.request("thread/start", {
      ...sessionConfig, cwd: originalProject, historyMode
    })).value;
    const source = parseThreadResult(sourceResult);
    expect(source.historyMode ?? "legacy").toBe(historyMode);
    await nativeTurn(originalHost, source.id, "Retain the source checklist.");
    const sourcePath = pathFrom(sourceResult);
    let chosen = source, chosenPath = sourcePath;
    if (strategy === "derived lineage") {
      phase = "creating the original derived thread and extending its source";
      const fork = (await originalHost.request("thread/fork", {
        ...sessionConfig, threadId: source.id, cwd: originalProject, excludeTurns: true
      }, { mutation: true })).value;
      chosen = parseThreadResult(fork);
      chosenPath = pathFrom(fork);
      await nativeTurn(originalHost, chosen.id, "Retain the derived observations.");
      await nativeTurn(originalHost, source.id, "This later source-only text was never visible to the derived thread.");
    }
    const originalTurns = await readTurns(originalHost, chosen.id);
    expect(originalTurns).toHaveLength(strategy === "derived lineage" ? 2 : 1);
    await originalHost.shutdown();
    phase = "reading the exact portable package and its bounded ancestor bytes";
    const packaged = await readCodexPortableRollout(originalHome, chosenPath, chosen.id, () => {});
    const rollouts = parseCodexPortableRollout(packaged.bytes);
    expect(packaged.sourceNativeSessionIds).toEqual(strategy === "derived lineage" ? [chosen.id, source.id] : [source.id]);
    expect(rollouts).toHaveLength(strategy === "derived lineage" ? 2 : 1);
    if (strategy === "derived lineage") {
      const original = await readFile(sourcePath);
      const prefix = rollouts[1]!.bytes;
      expect(original.toString("utf8")).toContain("This later source-only text");
      expect(prefix.byteLength).toBeLessThan(original.byteLength);
      expect(prefix).toEqual(original.subarray(0, prefix.byteLength));
      expect(prefix.toString("utf8")).not.toContain("This later source-only text");
    }
    await rename(originalHome, join(root, "retired-original-home"));
    await rename(originalProject, join(root, "retired-original-project"));
    const modelCount = modelRequests.length;

    phase = "adopting the exact restored rollout through the production Adapter";
    const receiver = await startHost(receiverHome, receiverProject, "receiver-probe");
    adapter = new CodexBackendAdapter({ host: receiver, profileDirectory: receiverHome, instanceGeneration: 1 });
    const target = { id: "receiving-target", backendId: adapter.id, displayName: "Receiving project",
      workspaceRoot: receiverProject, managed: false, trusted: true } as const;
    const projection = projectCodexNativeHistory({ ...chosen, turns: originalTurns }, { maximumEvents: 1_000 });
    const messageIdentities = projection.events.flatMap(event => event.payload.type === "message_complete"
      ? [{ role: event.payload.role, entryId: event.nativeEntryId }] : []);
    const binding = await adapter.importPortableNativeSession({
      target, bytes: packaged.bytes, generation: 1, nativeSessionId: "portable-codex-native-adoption", messageIdentities,
      activeEntryId: projection.activeEntryId ?? null
    }, AbortSignal.timeout(20_000));
    const chosenId = binding.nativeSessionId;
    if (chosenId === undefined) throw new Error("The Adapter returned no native thread identity.");
    expect(chosenId).not.toBe(chosen.id);
    expect(binding.confirmedMessageIdentities).toEqual(messageIdentities);
    expect(await readTurns(receiver, chosenId)).toEqual(originalTurns);
    expect(modelRequests).toHaveLength(modelCount);
    await adapter.dispose();
    await receiver.shutdown();

    phase = "reopening the remapped thread on a cold receiving host";
    const reopened = await startHost(receiverHome, receiverProject, "receiver-probe");
    const resumed = parseThreadResult((await reopened.request("thread/resume", {
      ...sessionConfig, threadId: chosenId, cwd: receiverProject, excludeTurns: true
    })).value);
    expect(resumed.id).toBe(chosenId);
    expect(resumed.cwd).toBe(receiverProject);
    expect(await readTurns(reopened, chosenId)).toEqual(originalTurns);
    await nativeTurn(reopened, chosenId, "Continue the restored checklist.");
    expect(modelRequests).toHaveLength(modelCount + 1);
    expect(modelRequests.at(-1)).toContain("Retain the source checklist.");
    expect(modelRequests.at(-1)).toContain("Portable native reply 1.");
    if (strategy === "derived lineage") expect(modelRequests.at(-1)).toContain("Retain the derived observations.");
    expect(modelRequests.at(-1)).not.toContain("This later source-only text was never visible");
    expect(modelRequests.at(-1)).toContain("Continue the restored checklist.");

  } catch (error) {
    const rpc = error instanceof RpcRemoteFault ? `, RPC ${error.requestMethod ?? "unknown"} ${error.rpcCode}` : "";
    throw new Error(`Codex ${strategy} transfer failed while ${phase} (${modelRequests.length} model requests${rpc}).`, { cause: error });
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await Promise.allSettled(hosts.map(host => host.shutdown()));
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);

function pathFrom(value: unknown): string {
  return stringValue(objectValue(objectValue(value)["thread"])["path"], "native rollout path");
}
