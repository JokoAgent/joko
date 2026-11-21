import { once, EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CODEX_APP_SERVER_VERSION } from "./adapter.js";
import { AppServerHost } from "./host.js";
import { useCodexHistoryHome } from "./external-auth.js";
import { codexLegacyRewindAnchor } from "./native-history.js";
import { objectValue, parseFullTurnPage, parseThreadResult, stringValue } from "./protocol.js";

const binary = process.env["JOKO_CODEX_HOSTED_TEST_BINARY"];

it.skipIf(!binary)("discovers a Skill and reattaches to the exact Legacy fork on the published App Server", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "joko-native-legacy-rewind-")));
  let modelRequests = 0;
  const provider = createServer((request, response) => {
    request.resume();
    if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
      response.writeHead(404).end();
      return;
    }
    const number = ++modelRequests;
    const id = `legacy-response-${number}`;
    const events = [
      { type: "response.created", response: { id } },
      { type: "response.output_item.done", item: { id: `legacy-answer-${number}`, type: "message", role: "assistant",
        content: [{ type: "output_text", text: `Completed native reply ${number}.`, annotations: [] }] } },
      { type: "response.completed", response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
    ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  });
  let host: AppServerHost | undefined;
  try {
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    const address = provider.address();
    if (address === null || typeof address === "string") throw new Error("Missing loopback model listener.");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const skillDir = join(home, ".agents", "skills", "verify-runtime");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: verify-runtime\ndescription: Verify the installed runtime.\n---\n\nReport the observed version.\n");
    const options = { transport: { command: binary!, cwd: home, requestTimeoutMs: 20_000,
      env: useCodexHistoryHome({ PATH: process.env["PATH"] ?? "", SystemRoot: process.env["SystemRoot"] ?? "",
        HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TMP: home, TEMP: home }, home),
      args: ["app-server", "--listen", "stdio://", "--disable", "plugins", "--disable", "remote_plugin",
        "-c", 'model_provider="probe"', "-c", 'model_providers.probe.name="Probe"',
        "-c", `model_providers.probe.base_url=${JSON.stringify(baseUrl)}`, "-c", 'model_providers.probe.wire_api="responses"',
        "-c", "model_providers.probe.request_max_retries=0", "-c", "model_providers.probe.stream_max_retries=0",
        "-c", "model_providers.probe.requires_openai_auth=false", "-c", `chatgpt_base_url=${JSON.stringify(baseUrl)}`]
    } };
    const app = host = new AppServerHost(options);
    await app.ensureStarted();
    expect(app.initializeResult?.userAgent).toContain(CODEX_APP_SERVER_VERSION);
    const resources = (await app.request("skills/list", { cwds: [home], forceReload: true })).value;
    expect(resources).toMatchObject({ data: expect.arrayContaining([
      expect.objectContaining({ skills: expect.arrayContaining([expect.objectContaining({ name: "verify-runtime" })]) })
    ]) });
    const started = (await app.request("thread/start", { cwd: home, model: "gpt-6-astra", historyMode: "legacy",
      approvalPolicy: "never", sandbox: "read-only" })).value;
    const source = parseThreadResult(started);
    const rolloutPath = stringValue(objectValue(objectValue(started)["thread"])["path"], "original rollout path");
    const complete = new EventEmitter();
    await app.subscribe(source.id, app.generation, { onRequest: async () => undefined, onDisconnect: () => undefined,
      onNotification: (method, params) => { if (method === "turn/completed") complete.emit("turn", params); } });
    for (const text of ["Keep the original checklist.", "Draft a second checklist."]) {
      const startedTurn = once(complete, "turn", { signal: AbortSignal.timeout(20_000) });
      void startedTurn.catch(() => undefined);
      await app.request("turn/start", { threadId: source.id, input: [{ type: "text", text }] });
      expect((await startedTurn)[0]).toMatchObject({ turn: { status: "completed" } });
    }
    const readTurns = async (threadId: string) => parseFullTurnPage((await app.request("thread/turns/list", {
      threadId, sortDirection: "asc", itemsView: "full", limit: 100
    })).value, { maximumTurns: 100, maximumItems: 300 }).turns;
    const original = await readTurns(source.id);
    const metadata = parseThreadResult((await app.request("thread/read", { threadId: source.id, includeTurns: false })).value);
    expect(original).toHaveLength(2);
    expect(metadata).toMatchObject({ historyMode: "legacy", status: { type: "idle" } });
    const anchor = codexLegacyRewindAnchor({ ...metadata, turns: original }, 1);
    expect(anchor).toBe(original[0]?.items.at(-1)?.id);
    expect(anchor).toBeDefined();
    const sourceBytes = await readFile(rolloutPath);
    const fork = parseThreadResult((await app.request("thread/fork", { threadId: source.id,
      lastTurnId: original[0]!.id, cwd: home, excludeTurns: true }, { mutation: true })).value);
    expect(fork.id).not.toBe(source.id);
    expect(fork.turns).toEqual([]);
    expect(await readTurns(fork.id)).toEqual(original.slice(0, 1));
    expect(await readTurns(source.id)).toEqual(original);
    expect(await readFile(rolloutPath)).toEqual(sourceBytes);
    await app.shutdown();
    host = new AppServerHost(options);
    await host.ensureStarted();
    const resumed = parseThreadResult((await host.request("thread/resume", {
      threadId: fork.id, cwd: home, approvalPolicy: "never", sandbox: "read-only", excludeTurns: true
    })).value);
    expect(resumed.id).toBe(fork.id);
    const reopened = parseFullTurnPage((await host.request("thread/turns/list", {
      threadId: resumed.id, sortDirection: "asc", itemsView: "full", limit: 100
    })).value, { maximumTurns: 100, maximumItems: 300 }).turns;
    expect(reopened).toEqual(original.slice(0, 1));
    expect(modelRequests).toBe(2);
  } finally {
    await host?.shutdown();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
}, 65_000);
