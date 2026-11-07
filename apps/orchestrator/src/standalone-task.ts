import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { create, fromJsonString, toJson, type JsonValue, type MessageInitShape } from "@bufbuild/protobuf";
import { createClient, createRouterTransport, type CallOptions } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { redactSecrets } from "@joko/core";
import { createOrchestratorApplication, type OrchestratorApplication } from "./application.js";
import { isLoopbackHost, loadConfig } from "./config.js";
import { registerConnectServices } from "./connect-services.js";
import { createInternalServer } from "./server.js";

const usage = "joko-orchestrator run-task --profile <provider.json> --model <id> --working-dir <directory> --turns-file <texts.json> --output-dir <new-directory> [--timeout-ms N] [--trust-workspace]";
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const stoppedRunStates = new Set([contract.RunState.SUCCEEDED, contract.RunState.FAILED, contract.RunState.ABORTED, contract.RunState.CANCELLED]);

export async function runStandaloneTask(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { profile: { type: "string" }, model: { type: "string" }, "working-dir": { type: "string" },
    "turns-file": { type: "string" }, "output-dir": { type: "string" }, "timeout-ms": { type: "string" }, "trust-workspace": { type: "boolean" }, help: { type: "boolean" } } });
  if (values.help) {
    process.stdout.write(`${usage}\nLinux x64. The profile is a v1 ProviderConfiguration with one Pi OpenAI-compatible runtime and an API key environment name. Turns are a JSON array of text strings. Each turn has a 30-minute default deadline.\n`);
    return 0;
  }
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Standalone tasks are available on Linux x64.");
  const { profile: profileFile, model, "working-dir": workdir, "turns-file": turnsFile, "output-dir": output } = values;
  if (!profileFile || !model || !workdir || !turnsFile || !output) throw new Error(usage);
  const timeout = Number(values["timeout-ms"] ?? "1800000");
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 86_400_000) throw new Error("The per-turn timeout must be between 1000 and 86400000 ms.");
  const workspace = await realpath(workdir);
  if (!(await stat(workspace)).isDirectory()) throw new Error("Choose an existing working directory.");
  let turns: unknown;
  try { turns = JSON.parse(await readTaskInput(turnsFile)); }
  catch { throw new Error("The turns file must be a JSON array of text strings."); }
  if (!Array.isArray(turns) || turns.length < 1 || turns.length > 64
    || turns.some(text => typeof text !== "string" || text.trim() === "" || text.length > 60_000)) {
    throw new Error("The turns file must contain one to 64 nonempty text strings, each at most 60000 characters.");
  }
  let profile: contract.ProviderConfiguration;
  try { profile = fromJsonString(contract.ProviderConfigurationSchema, await readTaskInput(profileFile)); }
  catch { throw new Error("The provider profile must be a v1 ProviderConfiguration JSON object."); }
  const runtime = profile.runtimes[0];
  if (profile.runtimes.length !== 1 || runtime?.backendId !== "pi" || runtime.apiCompatibility !== contract.ProviderApiCompatibility.OPENAI_COMPLETIONS
    || runtime.headers.length > 0 || runtime.credentialReferenceId !== "" || runtime.keyless
    || !runtime.models.some(candidate => candidate.modelId === model) || !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(runtime.apiKeyEnvironment)) {
    throw new Error("Choose an OpenAI-compatible Pi provider profile with the selected model and a private API key environment name.");
  }
  const endpoint = new URL(runtime.endpoint);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || (endpoint.protocol !== "https:" && (endpoint.protocol !== "http:" || !isLoopbackHost(endpoint.hostname)))) {
    throw new Error("The profile endpoint must use HTTPS or loopback HTTP, with credentials supplied by the environment.");
  }
  const key = process.env[runtime.apiKeyEnvironment];
  if (!key?.trim() || Buffer.byteLength(key) > 4096) throw new Error("The profile's API key environment value is unavailable or too large.");
  const redact = (value: string) => redactSecrets(value.replaceAll(key, "[REDACTED]"));
  const encode = (value: unknown, indentation?: number) => redactSecrets(JSON.stringify(value,
    (_name, item: unknown) => typeof item === "string" ? item.replaceAll(key, "[REDACTED]") : item, indentation));

  const outputDirectory = await createOutputDirectory(output);
  const stop = new AbortController();
  const interrupt = () => stop.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let dataDirectory: string | undefined;
  let dataIdentity: Awaited<ReturnType<typeof lstat>> | undefined;
  let application: OrchestratorApplication | undefined;
  let internal: Awaited<ReturnType<typeof createInternalServer>> | undefined;
  try {
    dataDirectory = await mkdtemp(join(await realpath(tmpdir()), "joko-task-run-"));
    dataIdentity = await lstat(dataDirectory);
    const internalPort = await privatePort();
    const config = loadConfig({ JOKO_HOST: "127.0.0.1", JOKO_PORT: "1", JOKO_INTERNAL_PORT: String(internalPort),
      JOKO_ALLOW_INSECURE_LOOPBACK: "1", JOKO_DATA_DIR: dataDirectory, JOKO_WORKSPACE_ROOT: workspace, JOKO_WORKSPACE_ID: "standalone-task-workspace",
      JOKO_WORKSPACE_TRUSTED: values["trust-workspace"] ? "1" : "0", JOKO_LAN_DISCOVERY: "0", JOKO_VOICE_DICTIONARY_LAN_DISCOVERY: "0", JOKO_BROWSER_ENABLED: "0" });
    application = await createOrchestratorApplication(config, { agentImportSources: { home: dataDirectory, environment: {} } });
    stop.signal.throwIfAborted();
    internal = await createInternalServer(application);
    internal.log.level = "silent";
    await internal.listen({ host: "127.0.0.1", port: config.internalPort });
    const outcome = await executeTask(application, config.workspace.id, profile, model, key, turns, timeout, stop.signal, encode);
    const directory = `/proc/self/fd/${outputDirectory.fd}`;
    await writeFile(join(directory, "trace.jsonl"), outcome.trace, { flag: "wx", mode: 0o600 });
    const result = encode(outcome.result, 2) + "\n";
    await writeFile(join(directory, "result.json"), result, { flag: "wx", mode: 0o600 });
    process.stdout.write(result);
    return outcome.result.status === "completed" ? 0 : 1;
  } catch (error) {
    throw new Error(stop.signal.aborted ? "The standalone task was interrupted." : redact(error instanceof Error ? error.message : String(error)));
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    try { await application?.close(); }
    finally {
      try { await internal?.close(); }
      finally {
        await outputDirectory.close();
        if (dataDirectory !== undefined && dataIdentity !== undefined) {
          const current = await lstat(dataDirectory);
          if (current.isDirectory() && current.dev === dataIdentity.dev && current.ino === dataIdentity.ino) await rm(dataDirectory, { recursive: true });
        }
      }
    }
  }
}

async function executeTask(application: OrchestratorApplication, targetId: string, profile: contract.ProviderConfiguration, modelId: string,
  key: string, turns: readonly string[], timeout: number, signal: AbortSignal, encode: (value: unknown) => string) {
  const challenge = application.connections.issuePairing("Standalone task");
  const paired = application.connections.completePairing({ challengeId: challenge.id, code: challenge.code, connectionName: "Standalone task" });
  const transport = createRouterTransport(router => registerConnectServices(router, application));
  const operations = createClient(contract.OperationService, transport), sessions = createClient(contract.SessionService, transport);
  const runs = createClient(contract.RunService, transport), credentials = createClient(contract.CredentialService, transport);
  const options: CallOptions = { headers: { authorization: `Bearer ${paired.authKey}` }, timeoutMs: 120_000 };
  const submit = async (mutation: MessageInitShape<typeof contract.OperationMutationSchema>, callSignal: AbortSignal | undefined = signal) => {
    const { operation } = await operations.submitOperation({ operationId: randomUUID(), connectionId: paired.connection.id, mutation },
      { ...options, signal: callSignal });
    if (operation?.state !== contract.OperationState.SUCCEEDED) throw new Error(operation?.error?.message || "The task operation could not be confirmed.");
    return operation.result?.payload;
  };
  const ticket = (await credentials.beginCredentialUpload({ kind: contract.CredentialKind.API_KEY, providerId: profile.providerId }, { ...options, signal })).ticket;
  if (!ticket || !application.credentials) throw new Error("The standalone credential channel is unavailable.");
  application.credentials.upload(ticket.ticketId, key, paired.connection.id);
  const reference = `cred_${randomUUID()}`;
  await submit({ payload: { case: "commitCredential", value: { credentialUploadTicketId: ticket.ticketId,
    credentialReferenceId: reference, providerId: profile.providerId, displayName: "Standalone task API key", kind: contract.CredentialKind.API_KEY } } });
  const runtime = profile.runtimes[0]!;
  await submit({ payload: { case: "upsertProvider", value: { provider: { ...profile, kind: contract.ProviderKind.API_KEY, enabled: true,
    version: create(contract.EntityVersionSchema, { revision: { value: 0n } }),
    runtimes: [{ ...runtime, credentialReferenceId: reference, credentialOrigin: new URL(runtime.endpoint).origin }] } } } });
  const created = await submit({ payload: { case: "createSession", value: { backendId: "pi", targetId, displayName: "Standalone task",
    permissionMode: contract.PermissionMode.ASK, model: { model: { providerId: profile.providerId, modelId }, effortId: "off" } } } });
  if (created?.case !== "session" || created.value.nativeBinding === undefined) throw new Error("The standalone task session could not be confirmed.");
  const { sessionId } = created.value, generation = created.value.nativeBinding.runtimeGeneration;
  const outcomes: { runId: string; state: string; usage?: JsonValue; errorCode?: string }[] = [];
  let status = "completed";
  for (const text of turns) {
    const receipt = await submit({ preconditions: [{ entity: { kind: contract.EntityKind.SESSION, id: sessionId }, expectedGeneration: generation }],
      payload: { case: "sendInput", value: { sessionId, deliveryMode: contract.QueueDeliveryMode.PROMPT,
        input: { parts: [{ content: { case: "text", value: text } }] } } } });
    if (receipt?.case !== "queueItem") throw new Error("The standalone input receipt could not be confirmed.");
    const { runId } = receipt.value;
    const deadline = AbortSignal.timeout(timeout), wait = AbortSignal.any([signal, deadline]);
    let terminal: contract.Run | undefined;
    try {
      for (;;) {
        terminal = (await runs.getRun({ runId }, { ...options, signal: wait })).run;
        if (!terminal || terminal.sessionId !== sessionId) throw new Error("The standalone run changed ownership.");
        if (stoppedRunStates.has(terminal.state) || terminal.state === contract.RunState.DISPATCH_UNKNOWN || terminal.state === contract.RunState.WAITING) break;
        await delay(100, undefined, { signal: wait });
      }
      status = terminal.state === contract.RunState.SUCCEEDED ? "completed" : terminal.state === contract.RunState.WAITING ? "action-required"
        : terminal.state === contract.RunState.DISPATCH_UNKNOWN ? "unconfirmed" : terminal.state === contract.RunState.ABORTED ? "aborted" : "failed";
    } catch (error) {
      if (!wait.aborted) throw error;
      status = signal.aborted ? "interrupted" : "timed-out";
    } finally {
      if (terminal === undefined || !stoppedRunStates.has(terminal.state)) {
        await submit({ payload: { case: "abortRun", value: { runId } } }, AbortSignal.timeout(5_000)).catch(() => undefined);
      }
    }
    outcomes.push({ runId, state: status, ...(terminal?.usage ? { usage: toJson(contract.RunUsageSummarySchema, terminal.usage) } : {}),
      ...(terminal?.error?.code ? { errorCode: terminal.error.code } : {}) });
    if (status !== "completed") break;
  }
  const events: contract.Event[] = [];
  let beforeCursor: contract.EventCursor | undefined;
  do {
    const page = await sessions.listSessionTimeline({ sessionId, limit: 64, beforeCursor }, options);
    events.unshift(...page.events);
    beforeCursor = page.nextBeforeCursor;
  } while (beforeCursor !== undefined && events.length < 2048);
  const textByRun = new Map<string, string>();
  const trace: string[] = [];
  let truncated = beforeCursor !== undefined;
  let traceBytes = 0;
  for (const event of events) {
    const payload = event.payload?.kind, runId = event.identity?.runId;
    if (runId && payload?.case === "messageCompleted" && payload.value.role === contract.MessageRole.ASSISTANT) {
      textByRun.set(runId, payload.value.blocks.flatMap(block => block.content.case === "text" ? [block.content.value] : []).join("\n").slice(0, 60_000));
    }
    if (payload?.case === "textDelta" || payload?.case === "thinkingDelta") continue;
    const line = encode(toJson(contract.EventSchema, event));
    const bytes = Buffer.byteLength(line) + 1;
    if (bytes > 32_768 || traceBytes + bytes > 8 * 1024 * 1024) { truncated = true; continue; }
    traceBytes += bytes;
    trace.push(line);
  }
  return { result: { version: 1, status, sessionId, providerId: profile.providerId, modelId, traceTruncated: truncated,
    turns: outcomes.map(turn => ({ ...turn, text: textByRun.get(turn.runId) })) },
    trace: trace.length === 0 ? "" : trace.join("\n") + "\n" };
}

async function readTaskInput(path: string): Promise<string> {
  const handle = await open(await realpath(path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error("The standalone input must be a regular file of at most 4 MiB.");
    const bytes = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== info.size) throw new Error("The standalone input changed while it was read.");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
  } finally { await handle.close(); }
}

async function createOutputDirectory(path: string): Promise<FileHandle> {
  const absolute = resolve(path), parent = await open(await realpath(dirname(absolute)), directoryFlags);
  try {
    const target = join(`/proc/self/fd/${parent.fd}`, basename(absolute));
    await mkdir(target, { mode: 0o700 });
    const output = await open(target, directoryFlags);
    const info = await output.stat();
    if (info.uid === process.getuid?.() && (info.mode & 0o077) === 0) return output;
    await output.close();
    throw new Error("The standalone output directory is no longer private.");
  } finally { await parent.close(); }
}

async function privatePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (address === null || typeof address === "string") throw new Error("No private loopback port was available.");
  return address.port;
}
