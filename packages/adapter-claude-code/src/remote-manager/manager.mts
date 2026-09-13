// @ts-nocheck
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, unlink } from "node:fs/promises";
import net from "node:net";
import { dirname, join, posix as remotePath, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as nativeSdk from "@anthropic-ai/claude-agent-sdk";

const PROTOCOL_VERSION = 1;
const MANAGER_VERSION = "1.0.0";
const MANAGER_SHA256 = createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex");
const MAX_LINE_BYTES = 32 * 1024 * 1024;
const MAX_EVENTS = 4096;
const MAX_EVENT_BYTES = 32 * 1024 * 1024;
const MAX_INPUT_RECEIPTS = 4096;
const MAX_QUEUED_INPUTS = 256;
const MAX_QUEUED_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_TERMINAL_QUERIES = 128;
const MAX_CALLBACKS_PER_CONNECTION = 256;
const CALLBACK_TIMEOUT_MS = 30 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const ENVIRONMENT_PREFIXES = ["ANTHROPIC_", "CLAUDE_", "AWS_", "GOOGLE_", "AZURE_", "CLOUD_ML_"];
const PATH_BACKED_CREDENTIALS = new Set([
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "AZURE_CLIENT_CERTIFICATE_PATH",
  "AZURE_FEDERATED_TOKEN_FILE"
]);

export function createManagerState(runtimeSdk = nativeSdk) {
  return {
    generation: randomUUID(),
    sdk: runtimeSdk,
    queries: new Map(),
    starts: new Map(),
    terminalOrder: []
  };
}

const state = createManagerState();

class InputQueue {
  values = [];
  bytes = 0;
  waiters = [];
  closed = false;
  error = undefined;

  push(value) {
    if (this.closed) throw fault("query_closed", true);
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else {
      if (this.values.length >= MAX_QUEUED_INPUTS || this.bytes + bytes > MAX_QUEUED_INPUT_BYTES) {
        throw fault("input_queue_full", false);
      }
      this.values.push({ value, bytes });
      this.bytes += bytes;
    }
  }

  close(error) {
    if (this.closed) return;
    this.closed = true;
    this.error = error;
    for (const waiter of this.waiters.splice(0)) {
      if (error) waiter.reject(error);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator]() { return this; }

  next() {
    const queued = this.values.shift();
    if (queued !== undefined) {
      this.bytes -= queued.bytes;
      return Promise.resolve({ value: queued.value, done: false });
    }
    if (this.closed) return this.error ? Promise.reject(this.error) : Promise.resolve({ value: undefined, done: true });
    return new Promise((resolvePromise, reject) => this.waiters.push({ resolve: resolvePromise, reject }));
  }
}

export class ManagerConnection {
  constructor(socket, managerState = state) {
    this.socket = socket;
    this.state = managerState;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.requestTail = Promise.resolve();
    this.writeTail = Promise.resolve();
    this.callbacks = new Map();
    this.controllers = new Set();
    socket.on("data", (chunk) => this.accept(chunk));
    socket.once("error", () => this.close());
    socket.once("close", () => this.close());
  }

  accept(chunk) {
    if (this.closed) return;
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.buffer.length + value.length > MAX_LINE_BYTES) return this.destroy(fault("frame_too_large", false));
    this.buffer = Buffer.concat([this.buffer, value]);
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) return;
      if (newline === 0 || newline > MAX_LINE_BYTES) return this.destroy(fault("protocol_error", false));
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      let message;
      try { message = JSON.parse(UTF8.decode(line)); }
      catch { return this.destroy(fault("protocol_error", false)); }
      if (record(message) && message.v === PROTOCOL_VERSION && message.kind === "callback_result") {
        void this.handle(message).catch(() => this.destroy(fault("protocol_error", true)));
        continue;
      }
      const operation = this.requestTail.then(() => this.handle(message));
      this.requestTail = operation.catch(() => this.destroy(fault("protocol_error", true)));
    }
  }

  async handle(message) {
    if (!record(message) || message.v !== PROTOCOL_VERSION) throw fault("protocol_error", false);
    if (message.kind === "callback_result") {
      const pending = this.callbacks.get(string(message.callbackId, "callbackId"));
      if (!pending) return;
      this.callbacks.delete(message.callbackId);
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener("abort", pending.abort);
      if (message.ok === true) pending.resolve(message.value);
      else pending.reject(fault("callback_failed", false));
      return;
    }
    if (message.kind !== "request") throw fault("protocol_error", false);
    const id = boundedString(message.id, "request id", 512);
    try {
      const value = await dispatch(this, message.method, message.params);
      await this.send({ v: PROTOCOL_VERSION, kind: "response", id, ok: true, value });
    } catch (error) {
      const safe = normalizeFault(error);
      await this.send({
        v: PROTOCOL_VERSION,
        kind: "response",
        id,
        ok: false,
        error: { code: safe.code, stateMayHaveChanged: safe.stateMayHaveChanged }
      }).catch(() => undefined);
    }
  }

  send(value) {
    if (this.closed) return Promise.reject(fault("connection_closed", true));
    let bytes;
    try { bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8"); }
    catch { return Promise.reject(fault("invalid_response", true)); }
    if (bytes.length > MAX_LINE_BYTES) return Promise.reject(fault("frame_too_large", true));
    const operation = this.writeTail.then(() => new Promise((resolvePromise, reject) => {
      if (this.closed) return reject(fault("connection_closed", true));
      this.socket.write(bytes, (error) => error ? reject(fault("connection_closed", true)) : resolvePromise());
    }));
    this.writeTail = operation.catch(() => undefined);
    return operation;
  }

  callback(query, callback, value, signal) {
    if (this.closed || query.connection !== this) return Promise.reject(fault("callback_unavailable", false));
    if (this.callbacks.size >= MAX_CALLBACKS_PER_CONNECTION) return Promise.reject(fault("callback_capacity", false));
    const callbackId = randomUUID();
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        const pending = this.callbacks.get(callbackId);
        this.callbacks.delete(callbackId);
        pending?.signal?.removeEventListener("abort", abort);
        reject(fault("callback_timeout", false));
      }, CALLBACK_TIMEOUT_MS);
      timer.unref?.();
      const abort = () => {
        const pending = this.callbacks.get(callbackId);
        if (!pending) return;
        this.callbacks.delete(callbackId);
        clearTimeout(timer);
        void this.send({ v: PROTOCOL_VERSION, kind: "callback_cancel", callbackId }).catch(() => undefined);
        reject(fault("callback_cancelled", false));
      };
      this.callbacks.set(callbackId, { query, resolve: resolvePromise, reject, timer, abort, signal });
      signal?.addEventListener("abort", abort, { once: true });
      this.send({ v: PROTOCOL_VERSION, kind: "callback", callbackId, queryId: query.id, callback, value })
        .catch(() => abort());
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const query of this.state.queries.values()) {
      if (query.connection === this) query.connection = undefined;
    }
    for (const pending of this.callbacks.values()) {
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener("abort", pending.abort);
      pending.reject(fault("callback_unavailable", false));
    }
    this.callbacks.clear();
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }

  detachQuery(query) {
    if (query.connection === this) query.connection = undefined;
    for (const [callbackId, pending] of this.callbacks) {
      if (pending.query !== query) continue;
      this.callbacks.delete(callbackId);
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener("abort", pending.abort);
      pending.reject(fault("callback_unavailable", false));
      void this.send({ v: PROTOCOL_VERSION, kind: "callback_cancel", callbackId }).catch(() => undefined);
    }
  }

  destroy() {
    this.close();
    this.socket.destroy();
  }
}

async function dispatch(connection, method, params) {
  if (method === "hello") return {
    protocolVersion: PROTOCOL_VERSION,
    managerVersion: MANAGER_VERSION,
    managerSha256: MANAGER_SHA256,
    managerGeneration: connection.state.generation
  };
  if (method === "owner.reconcile") return reconcileOwner(connection, params);
  if (method === "query.start") return startQuery(connection, params);
  if (method === "query.attach") return attachQuery(connection, params);
  if (method === "query.input") return queryInput(connection, params);
  if (method === "query.interrupt") return queryControl(connection, params, (query) => query.interrupt());
  if (method === "query.stopTask") return queryControl(connection, params, (query) => query.stopTask(boundedString(params.taskId, "task id", 512)));
  if (method === "query.setPermissionMode") return queryControl(connection, params, (query) => query.setPermissionMode(permissionMode(params.mode)));
  if (method === "query.setModel") return queryControl(connection, params, (query) => query.setModel(optionalString(params.model, "model", 512)));
  if (method === "query.applyFlagSettings") return queryControl(connection, params, (query) => query.applyFlagSettings(flagSettings(params.settings)));
  if (method === "query.initializationResult") return queryControl(connection, params, (query) => query.initializationResult());
  if (method === "query.supportedModels") return queryControl(connection, params, (query) => query.supportedModels());
  if (method === "query.accountInfo") return queryControl(connection, params, (query) => query.accountInfo());
  if (method === "query.retire") return retireQuery(connection, params);
  if (method === "query.retireOwned") return retireOwnedQuery(connection, params);
  if (method === "session.info") return sessionOperation(connection, params, (signal) => connection.state.sdk.getSessionInfo(
    uuid(params.sessionId), { dir: absolutePath(params.dir), signal }
  ));
  if (method === "session.messages") return sessionOperation(connection, params, (signal) => connection.state.sdk.getSessionMessages(
    uuid(params.sessionId), {
      dir: absolutePath(params.dir), signal,
      limit: boundedInteger(params.limit, "limit", 1, 10001),
      offset: boundedInteger(params.offset, "offset", 0, 1_000_000),
      includeSystemMessages: params.includeSystemMessages === true
    }
  ));
  if (method === "session.list") return sessionOperation(connection, params, () => connection.state.sdk.listSessions({
    dir: absolutePath(params.dir),
    limit: boundedInteger(params.limit, "limit", 1, 1000),
    offset: boundedInteger(params.offset, "offset", 0, 1_000_000),
    includeWorktrees: false,
    includeProgrammatic: true
  }));
  if (method === "session.delete") return sessionOperation(connection, params, (signal) => connection.state.sdk.deleteSession(
    uuid(params.sessionId), { dir: absolutePath(params.dir), signal }
  ));
  if (method === "session.fork") return sessionOperation(connection, params, (signal) => connection.state.sdk.forkSession(
    uuid(params.sessionId), {
      dir: absolutePath(params.dir), signal,
      ...(params.upToMessageId === undefined ? {} : { upToMessageId: uuid(params.upToMessageId) })
    }
  ));
  throw fault("method_unsupported", false);
}

async function startQuery(connection, params) {
  if (!record(params)) throw fault("invalid_request", false);
  const requestId = boundedString(params.requestId, "start request id", 512);
  const queryId = uuid(params.queryId);
  const fingerprint = digest(params);
  const managerState = connection.state;
  const prior = managerState.starts.get(requestId);
  if (prior) {
    if (prior.fingerprint !== fingerprint || prior.queryId !== queryId) throw fault("request_reused", true);
    const existing = requiredQuery(managerState, queryId);
    return attach(existing, connection, boundedInteger(params.afterSeq ?? 0, "event cursor", 0, Number.MAX_SAFE_INTEGER));
  }
  if (managerState.queries.has(queryId)) throw fault("query_exists", true);
  const sessionId = uuid(params.sessionId);
  const ownerKey = ownerIdentity(params.ownerKey);
  const ownerGeneration = boundedString(params.ownerGeneration, "owner generation", 256);
  const queue = new InputQueue();
  const abortController = new AbortController();
  const queryRecord = {
    state: managerState,
    id: queryId,
    sessionId,
    ownerKey,
    ownerGeneration,
    query: undefined,
    queue,
    abortController,
    connection,
    attachmentId: randomUUID(),
    events: [],
    eventBytes: 0,
    nextSeq: 1,
    inputs: new Map(),
    inputOrder: [],
    processes: [],
    consumeLoop: undefined,
    ended: false,
    retired: false,
    retiring: undefined
  };
  const options = queryOptions(params.options, queryRecord);
  if ((options.resume ?? options.sessionId) !== sessionId) throw fault("session_mismatch", false);
  managerState.queries.set(queryId, queryRecord);
  managerState.starts.set(requestId, { fingerprint, queryId });
  try {
    queryRecord.query = await Promise.resolve(managerState.sdk.query({ prompt: queue, options }));
  } catch (error) {
    queryRecord.queue.close();
    queryRecord.abortController.abort();
    if (queryRecord.processes.length > 0) {
      try { await retireExactQuery(queryRecord, 5_000); }
      catch { throw fault("query_start_unknown", true); }
    }
    managerState.queries.delete(queryId);
    managerState.starts.delete(requestId);
    throw fault("query_start_failed", false);
  }
  const response = attach(queryRecord, connection, boundedInteger(params.afterSeq ?? 0, "event cursor", 0, Number.MAX_SAFE_INTEGER));
  queueMicrotask(() => {
    queryRecord.consumeLoop = pumpQuery(queryRecord);
  });
  return response;
}

function attachQuery(connection, params) {
  if (!record(params)) throw fault("invalid_request", false);
  const query = requiredQuery(connection.state, uuid(params.queryId));
  if (query.ownerKey !== ownerIdentity(params.ownerKey)
    || query.ownerGeneration !== boundedString(params.ownerGeneration, "owner generation", 256)) {
    throw fault("query_owner_mismatch", true);
  }
  return attach(query, connection, boundedInteger(params.afterSeq ?? 0, "event cursor", 0, Number.MAX_SAFE_INTEGER));
}

function attach(query, connection, afterSeq) {
  const earliest = query.events[0]?.seq ?? query.nextSeq;
  if (afterSeq < earliest - 1) throw fault("replay_gap", true);
  if (query.connection && query.connection !== connection) query.connection.detachQuery(query);
  query.connection = connection;
  query.attachmentId = randomUUID();
  for (const event of query.events) {
    if (event.seq > afterSeq) void connection.send(event).catch(() => undefined);
  }
  return {
    queryId: query.id,
    sessionId: query.sessionId,
    attachmentId: query.attachmentId,
    lastSeq: query.nextSeq - 1,
    ended: query.ended,
    retired: query.retired
  };
}

function queryInput(connection, params) {
  const query = attachedQuery(connection, params);
  if (query.ended || query.retired) throw fault("query_closed", true);
  const requestId = boundedString(params.requestId, "input request id", 512);
  const message = userMessage(params.message, query.sessionId);
  if (message.uuid !== requestId) throw fault("input_receipt_mismatch", false);
  const fingerprint = digest(message);
  const previous = query.inputs.get(requestId);
  if (previous !== undefined) {
    if (previous !== fingerprint) throw fault("request_reused", true);
    return { accepted: true };
  }
  if (query.inputs.size >= MAX_INPUT_RECEIPTS) throw fault("input_receipt_limit", false);
  query.inputs.set(requestId, fingerprint);
  query.inputOrder.push(requestId);
  try { query.queue.push(message); }
  catch (error) {
    query.inputs.delete(requestId);
    query.inputOrder.pop();
    throw error;
  }
  return { accepted: true };
}

async function queryControl(connection, params, operation) {
  const query = attachedQuery(connection, params);
  if (!query.query || query.retired) throw fault("query_closed", true);
  return await operation(query.query);
}

async function retireQuery(connection, params) {
  const query = requiredQuery(connection.state, uuid(params.queryId));
  if (query.ownerKey !== ownerIdentity(params.ownerKey)
    || query.ownerGeneration !== boundedString(params.ownerGeneration, "owner generation", 256)) {
    throw fault("query_owner_mismatch", true);
  }
  if (params.attachmentId !== query.attachmentId || query.connection !== connection) throw fault("attachment_stale", true);
  const timeoutMs = boundedInteger(params.timeoutMs, "retirement timeout", 100, 120_000);
  await ensureQueryRetired(query, timeoutMs);
  return { retired: true };
}

async function retireOwnedQuery(connection, params) {
  if (!record(params)) throw fault("invalid_request", false);
  const queryId = uuid(params.queryId);
  const ownerKey = ownerIdentity(params.ownerKey);
  const ownerGeneration = boundedString(params.ownerGeneration, "owner generation", 256);
  const timeoutMs = boundedInteger(params.timeoutMs, "retirement timeout", 100, 120_000);
  const query = connection.state.queries.get(queryId);
  if (query) {
    if (query.ownerKey !== ownerKey || query.ownerGeneration !== ownerGeneration) throw fault("query_owner_mismatch", true);
    if (query.connection && query.connection !== connection) query.connection.detachQuery(query);
    query.connection = connection;
    query.attachmentId = randomUUID();
    await ensureQueryRetired(query, timeoutMs);
    return { retired: true };
  }
  const manifests = (await readProcessManifests(ownerKey)).filter((manifest) =>
    manifest.queryId === queryId && manifest.ownerGeneration === ownerGeneration);
  if (manifests.length === 0) throw fault("retirement_unconfirmed", true);
  for (const manifest of manifests) await retireManifest(manifest, timeoutMs);
  return { retired: true };
}

async function ensureQueryRetired(query, timeoutMs) {
  if (!query.retiring) {
    const attempt = retireExactQuery(query, timeoutMs);
    query.retiring = attempt;
    void attempt.catch(() => { if (query.retiring === attempt) query.retiring = undefined; });
  }
  await query.retiring;
}

async function retireExactQuery(query, timeoutMs) {
  if (query.retired) return;
  query.queue.close();
  try { query.query?.close(); } catch {}
  query.abortController.abort();
  const deadline = Date.now() + timeoutMs;
  for (const owned of query.processes) {
    if (owned.exited && !processGroupAlive(owned.child.pid)) continue;
    if (await waitForExit(owned, Math.max(0, deadline - Date.now()))) continue;
    if (!(await exactProcessAlive(owned))) throw fault("retirement_unconfirmed", true);
    signalProcessGroup(owned.child.pid, "SIGTERM");
    if (await waitForExit(owned, Math.min(1000, Math.max(0, deadline - Date.now())))) continue;
    if (!(await exactProcessAlive(owned))) throw fault("retirement_unconfirmed", true);
    signalProcessGroup(owned.child.pid, "SIGKILL");
    if (!(await waitForExit(owned, Math.min(1000, Math.max(0, deadline - Date.now()))))) {
      throw fault("retirement_unconfirmed", true);
    }
  }
  if (query.processes.length === 0) {
    const settled = query.consumeLoop !== undefined
      && await promiseSettledBefore(query.consumeLoop, Math.max(0, deadline - Date.now()));
    if (!settled || !query.ended) throw fault("retirement_unconfirmed", true);
  }
  await removeProcessManifests(query);
  query.retired = true;
  query.ended = true;
  emitEvent(query, "retired");
  rememberTerminal(query);
}

async function pumpQuery(query) {
  try {
    for await (const value of query.query) emitEvent(query, "message", value);
    query.ended = true;
    emitEvent(query, "end");
  } catch {
    query.ended = true;
    emitEvent(query, "fault", undefined, true);
  } finally {
    rememberTerminal(query);
  }
}

async function promiseSettledBefore(operation, timeoutMs) {
  if (timeoutMs <= 0) return false;
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(operation).then(() => true, () => true),
      new Promise((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(false), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function emitEvent(query, event, value, stateMayHaveChanged = false) {
  const frame = {
    v: PROTOCOL_VERSION,
    kind: "event",
    queryId: query.id,
    seq: query.nextSeq,
    event,
    ...(value === undefined ? {} : { value }),
    ...(stateMayHaveChanged ? { stateMayHaveChanged: true } : {})
  };
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(frame), "utf8") + 1; }
  catch {
    query.ended = true;
    if (event !== "fault") return emitEvent(query, "fault", undefined, true);
    return;
  }
  if (bytes > MAX_LINE_BYTES) {
    query.ended = true;
    if (event !== "fault") return emitEvent(query, "fault", undefined, true);
    return;
  }
  query.nextSeq += 1;
  query.events.push(frame);
  query.eventBytes += bytes;
  while (query.events.length > MAX_EVENTS || query.eventBytes > MAX_EVENT_BYTES) {
    const removed = query.events.shift();
    if (removed) query.eventBytes -= Buffer.byteLength(JSON.stringify(removed), "utf8") + 1;
  }
  void query.connection?.send(frame).catch(() => undefined);
}

function rememberTerminal(query) {
  if (!query.ended && !query.retired) return;
  const managerState = query.state;
  if (!managerState.terminalOrder.includes(query.id)) managerState.terminalOrder.push(query.id);
  while (managerState.terminalOrder.length > MAX_TERMINAL_QUERIES) {
    const id = managerState.terminalOrder.shift();
    const candidate = managerState.queries.get(id);
    if (candidate?.ended || candidate?.retired) {
      managerState.queries.delete(id);
      for (const [requestId, start] of managerState.starts) {
        if (start.queryId === id) managerState.starts.delete(requestId);
      }
    }
  }
}

function queryOptions(value, query) {
  if (!record(value)) throw fault("invalid_request", false);
  const remoteRoot = absolutePath(process.env.JOKO_CLAUDE_RUNTIME_ROOT);
  const configRoot = join(remoteRoot, "profile");
  const tmpRoot = join(remoteRoot, "tmp");
  const executable = absolutePath(process.env.JOKO_CLAUDE_EXECUTABLE);
  const env = remoteEnvironment(value.env, configRoot, tmpRoot);
  const options = {
    abortController: query.abortController,
    additionalDirectories: stringArray(value.additionalDirectories, "additional directories", 64, 16_384).map(absolutePath),
    allowDangerouslySkipPermissions: value.allowDangerouslySkipPermissions === true,
    ...(value.agents === undefined ? {} : { agents: emptyRecord(value.agents, "agents") }),
    canUseTool: async (toolName, input, options) => {
      try {
        const result = await query.connection?.callback(query, "canUseTool", {
          toolName,
          input,
          options: callbackOptions(options)
        }, options.signal);
        return permissionResult(result, input);
      } catch {
        return { behavior: "deny", message: "The remote approval authority is unavailable.", interrupt: true };
      }
    },
    cwd: absolutePath(value.cwd),
    env,
    ...(value.extraArgs === undefined ? {} : { extraArgs: nullableStringRecord(value.extraArgs, "extra arguments") }),
    ...(value.getOAuthToken === true ? { getOAuthToken: async (options) => {
      try {
        const result = await query.connection?.callback(query, "oauth", {}, options.signal);
        if (!record(result) || (result.value !== null && typeof result.value !== "string")) return null;
        if (result.declined === true) options.onDecline?.();
        return result.value;
      } catch { return null; }
    } } : {}),
    ...(value.effort === undefined ? {} : { effort: effort(value.effort) }),
    ...(value.forwardSubagentText === true ? { forwardSubagentText: true } : {}),
    includePartialMessages: true,
    ...(value.disallowedTools === undefined ? {} : { disallowedTools: stringArray(value.disallowedTools, "disallowed tools", 256, 512) }),
    ...(value.mcpServers === undefined ? {} : { mcpServers: emptyRecord(value.mcpServers, "MCP servers") }),
    ...(value.model === undefined ? {} : { model: boundedString(value.model, "model", 512) }),
    pathToClaudeCodeExecutable: executable,
    permissionMode: permissionMode(value.permissionMode),
    persistSession: value.persistSession === true,
    spawnClaudeCodeProcess: (options) => spawnOwned(query, options),
    ...(value.resume === undefined ? {} : { resume: uuid(value.resume) }),
    ...(value.sessionId === undefined ? {} : { sessionId: uuid(value.sessionId) }),
    ...(value.settings === undefined ? {} : { settings: jsonObject(value.settings, "settings") }),
    settingSources: stringArray(value.settingSources, "setting sources", 3, 16)
      .map((source) => source === "user" || source === "project" || source === "local" ? source : invalid()),
    ...(value.skills === undefined ? {} : { skills: stringArray(value.skills, "skills", 256, 512) }),
    ...(value.strictMcpConfig === true ? { strictMcpConfig: true } : {}),
    systemPrompt: systemPrompt(value.systemPrompt),
    ...(value.title === undefined ? {} : { title: boundedString(value.title, "title", 4096) }),
    tools: tools(value.tools)
  };
  if (options.additionalDirectories.length > 0) throw fault("remote_extra_directories_unsupported", false);
  return options;
}

function spawnOwned(query, options) {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true
  });
  const owned = { child, exited: child.exitCode !== null || child.signalCode !== null, exit: undefined, birth: undefined };
  owned.exit = new Promise((resolvePromise) => child.once("exit", () => {
    owned.exited = true;
    resolvePromise();
  }));
  try { persistProcessManifest(query, owned, options.command); }
  catch {
    signalProcessGroup(child.pid, "SIGKILL");
    throw fault("process_manifest_failed", true);
  }
  query.processes.push(owned);
  return child;
}

async function exactProcessAlive(owned) {
  return fingerprintsMatch(await processFingerprint(owned.child.pid), owned.fingerprint);
}

async function waitForExit(owned, timeoutMs) {
  if ((owned.exited || owned.child.exitCode !== null || owned.child.signalCode !== null)
    && !processGroupAlive(owned.child.pid)) return true;
  if (timeoutMs <= 0) return false;
  const deadline = Date.now() + timeoutMs;
  let timer;
  try {
    return await Promise.race([
      owned.exit.then(async () => {
        while (processGroupAlive(owned.child.pid) && Date.now() < deadline) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
        }
        return !processGroupAlive(owned.child.pid);
      }),
      new Promise((resolvePromise) => { timer = setTimeout(() => resolvePromise(false), timeoutMs); timer.unref?.(); })
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

async function reconcileOwner(connection, params) {
  if (!record(params)) throw fault("invalid_request", false);
  const ownerKey = ownerIdentity(params.ownerKey);
  const ownerGeneration = boundedString(params.ownerGeneration, "owner generation", 256);
  const timeoutMs = boundedInteger(params.timeoutMs, "retirement timeout", 100, 120_000);
  for (const query of connection.state.queries.values()) {
    if (query.ownerKey !== ownerKey || query.ownerGeneration === ownerGeneration || query.retired) continue;
    await ensureQueryRetired(query, timeoutMs);
  }
  const manifests = await readProcessManifests(ownerKey);
  for (const manifest of manifests) {
    if (manifest.ownerGeneration === ownerGeneration) continue;
    await retireManifest(manifest, timeoutMs);
  }
  return { reconciled: true };
}

function manifestsRoot() {
  return join(absolutePath(process.env.JOKO_CLAUDE_RUNTIME_ROOT), "run", "queries");
}

function persistProcessManifest(query, owned, executable) {
  if (!Number.isSafeInteger(owned.child.pid) || owned.child.pid < 1) throw fault("process_identity_unavailable", true);
  const expectedExecutable = absolutePath(process.env.JOKO_CLAUDE_EXECUTABLE);
  if (executable !== expectedExecutable) throw fault("process_identity_unavailable", true);
  const fingerprint = processFingerprintSync(owned.child.pid);
  if (!fingerprint || (typeof process.getuid === "function" && fingerprint.uid !== process.getuid())) {
    throw fault("process_identity_unavailable", true);
  }
  owned.fingerprint = fingerprint;
  const root = manifestsRoot();
  requirePrivateDirectorySync(root);
  const path = join(root, `${query.id}-${owned.child.pid}.json`);
  const value = {
    schema: 1,
    queryId: query.id,
    ownerKey: query.ownerKey,
    ownerGeneration: query.ownerGeneration,
    pid: owned.child.pid,
    birth: fingerprint.birth,
    commandHash: fingerprint.commandHash,
    executableHash: fingerprint.executableHash,
    uid: fingerprint.uid,
    createdAt: Date.now()
  };
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try { lstatSync(path); throw fault("process_manifest_failed", true); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    renameSync(temporaryPath, path);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch {}
    throw error;
  }
  owned.manifestPath = path;
  owned.fingerprint = fingerprint;
}

async function removeProcessManifests(query) {
  await Promise.all(query.processes.map(async (owned) => {
    if (owned.manifestPath) await removeManifest(owned.manifestPath);
  }));
}

async function readProcessManifests(ownerKey) {
  const root = manifestsRoot();
  await requirePrivateDirectory(root);
  let names;
  try { names = await readdir(root); }
  catch { throw fault("process_manifest_invalid", true); }
  const values = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(root, name);
    try {
      const file = await lstat(path);
      if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size < 2 || file.size > 4096
        || (file.mode & 0o077) !== 0
        || (typeof process.getuid === "function" && file.uid !== process.getuid())) {
        throw fault("process_manifest_invalid", true);
      }
      const value = JSON.parse(await readFile(path, "utf8"));
      const nameSession = name.split("-").slice(0, 5).join("-");
      if (!UUID.test(nameSession) || !record(value) || value.schema !== 1 || value.queryId !== nameSession
        || name !== `${value.queryId}-${value.pid}.json`
        || !sha256(value.ownerKey)
        || !UUID.test(value.queryId)
        || typeof value.ownerGeneration !== "string" || value.ownerGeneration.length === 0
        || value.ownerGeneration.length > 256 || /[\u0000-\u001f\u007f]/u.test(value.ownerGeneration)
        || !Number.isSafeInteger(value.pid) || value.pid < 1
        || typeof value.birth !== "string" || value.birth.length === 0 || value.birth.length > 512
        || !sha256(value.commandHash) || !sha256(value.executableHash)
        || !Number.isSafeInteger(value.uid) || value.uid < 0 || value.uid !== file.uid
        || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) throw fault("process_manifest_invalid", true);
      if (value.ownerKey === ownerKey) values.push({ ...value, path });
    } catch (error) {
      if (error?.code === "process_manifest_invalid") throw error;
      throw fault("process_manifest_invalid", true);
    }
  }
  return values;
}

async function retireManifest(manifest, timeoutMs) {
  const expected = manifestFingerprint(manifest);
  let current = await processFingerprint(manifest.pid);
  if (!fingerprintsMatch(current, expected)) {
    if (processGroupAlive(manifest.pid)) throw fault("retirement_unconfirmed", true);
    await removeManifest(manifest.path);
    return;
  }
  signalProcessGroup(manifest.pid, "SIGTERM");
  if (!(await waitGroupGone(manifest.pid, Math.min(timeoutMs, 2_000)))) {
    current = await processFingerprint(manifest.pid);
    if (!fingerprintsMatch(current, expected)) throw fault("retirement_unconfirmed", true);
    signalProcessGroup(manifest.pid, "SIGKILL");
    if (!(await waitGroupGone(manifest.pid, Math.min(timeoutMs, 2_000)))) throw fault("retirement_unconfirmed", true);
  }
  await removeManifest(manifest.path);
}

async function removeManifest(path) {
  try { await unlink(path); }
  catch (error) {
    if (error?.code !== "ENOENT") throw fault("process_manifest_cleanup_failed", true);
  }
}

async function processFingerprint(pid) {
  return processFingerprintSync(pid);
}

function processFingerprintSync(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  if (process.platform === "linux") {
    try {
      const info = lstatSync(`/proc/${pid}`);
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const command = readFileSync(`/proc/${pid}/cmdline`);
      if (stat.length > 16 * 1024 || command.byteLength === 0 || command.byteLength > 64 * 1024) return undefined;
      const end = stat.lastIndexOf(")");
      const fields = stat.slice(end + 2).trim().split(/\s+/u);
      if (!fields[19] || !/^[0-9]+$/u.test(fields[19])) return undefined;
      const executable = statSync(`/proc/${pid}/exe`, { bigint: true });
      return {
        pid,
        birth: `linux:${fields[19]}`,
        commandHash: createHash("sha256").update(command).digest("hex"),
        executableHash: createHash("sha256").update(`${executable.dev}:${executable.ino}`).digest("hex"),
        uid: info.uid
      };
    } catch { return undefined; }
  }
  if (process.platform === "win32") return undefined;
  const started = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" });
  const command = spawnSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], { encoding: "utf8" });
  const executable = spawnSync("/bin/ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
  const owner = spawnSync("/bin/ps", ["-p", String(pid), "-o", "uid="], { encoding: "utf8" });
  const birth = started.status === 0 ? started.stdout.trim() : "";
  const commandLine = command.status === 0 ? command.stdout.trim() : "";
  const executablePath = executable.status === 0 ? executable.stdout.trim() : "";
  const uid = owner.status === 0 && /^[0-9]+$/u.test(owner.stdout.trim()) ? Number(owner.stdout.trim()) : -1;
  if (birth.length === 0 || commandLine.length === 0 || executablePath.length === 0
    || !Number.isSafeInteger(uid) || uid < 0 || Buffer.byteLength(commandLine, "utf8") > 64 * 1024) return undefined;
  return {
    pid,
    birth: `${process.platform}:${birth}`,
    commandHash: createHash("sha256").update(commandLine).digest("hex"),
    executableHash: createHash("sha256").update(executablePath).digest("hex"),
    uid
  };
}

function fingerprintsMatch(left, right) {
  return left !== undefined && right !== undefined
    && left.pid === right.pid
    && left.birth === right.birth
    && left.commandHash === right.commandHash
    && left.executableHash === right.executableHash
    && left.uid === right.uid;
}

function manifestFingerprint(value) {
  return {
    pid: value.pid,
    birth: value.birth,
    commandHash: value.commandHash,
    executableHash: value.executableHash,
    uid: value.uid
  };
}

function sha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function ownerIdentity(value) {
  if (!sha256(value)) throw fault("invalid_request", false);
  return value;
}

function requirePrivateDirectorySync(path) {
  try {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && info.uid !== process.getuid())
      || realpathSync(path) !== resolve(path)) throw fault("process_manifest_invalid", true);
  } catch (error) {
    if (error?.code === "process_manifest_invalid") throw error;
    throw fault("process_manifest_invalid", true);
  }
}

async function requirePrivateDirectory(path) {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && info.uid !== process.getuid())
      || await realpath(path) !== resolve(path)) throw fault("process_manifest_invalid", true);
  } catch (error) {
    if (error?.code === "process_manifest_invalid") throw error;
    throw fault("process_manifest_invalid", true);
  }
}

function processGroupAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(process.platform === "win32" ? pid : -pid, 0); return true; }
  catch { return false; }
}

function signalProcessGroup(pid, signal) {
  try { process.kill(process.platform === "win32" ? pid : -pid, signal); } catch {}
}

async function waitGroupGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupAlive(pid) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return !processGroupAlive(pid);
}

async function sessionOperation(connection, params, operation) {
  if (!record(params)) throw fault("invalid_request", false);
  const controller = new AbortController();
  connection.controllers.add(controller);
  try { return await operation(controller.signal); }
  finally { connection.controllers.delete(controller); }
}

function attachedQuery(connection, params) {
  if (!record(params)) throw fault("invalid_request", false);
  const query = requiredQuery(connection.state, uuid(params.queryId));
  if (query.connection !== connection || params.attachmentId !== query.attachmentId) throw fault("attachment_stale", true);
  return query;
}

function requiredQuery(managerState, id) {
  const query = managerState.queries.get(id);
  if (!query) throw fault("query_missing", true);
  return query;
}

function remoteEnvironment(value, configRoot, tmpRoot) {
  if (!record(value)) throw fault("invalid_environment", false);
  const output = {};
  for (const name of ["LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ"]) {
    const item = process.env[name];
    if (typeof item === "string" && Buffer.byteLength(item, "utf8") <= 4096) output[name] = item;
  }
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(key)) throw fault("invalid_environment", false);
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 1024 * 1024) throw fault("invalid_environment", false);
    if (PATH_BACKED_CREDENTIALS.has(key) && raw.length > 0) throw fault("path_credential_unsupported", false);
    if (ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix))) output[key] = raw;
  }
  delete output.CLAUDE_CODE_GIT_BASH_PATH;
  output.HOME = configRoot;
  output.PATH = fixedRuntimePath();
  output.TMPDIR = tmpRoot;
  output.TMP = tmpRoot;
  output.TEMP = tmpRoot;
  output.CLAUDE_CONFIG_DIR = configRoot;
  output.CLAUDE_CODE_TMPDIR = tmpRoot;
  output.CLAUDE_AGENT_SDK_CLIENT_APP = "joko/0.1.0";
  return output;
}

function userMessage(value, sessionId) {
  if (!record(value) || value.type !== "user" || !record(value.message) || value.message.role !== "user"
    || value.parent_tool_use_id !== null || !record(value.origin) || value.origin.kind !== "human"
    || !UUID.test(value.uuid)) throw fault("invalid_input", false);
  const content = value.message.content;
  if (typeof content !== "string" && !Array.isArray(content)) throw fault("invalid_input", false);
  if (Buffer.byteLength(JSON.stringify(content), "utf8") > 24 * 1024 * 1024) throw fault("invalid_input", false);
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, origin: { kind: "human" }, uuid: value.uuid };
}

function callbackOptions(value) {
  return {
    ...(Array.isArray(value.suggestions) ? { suggestions: value.suggestions } : {}),
    ...(typeof value.blockedPath === "string" ? { blockedPath: value.blockedPath } : {}),
    ...(typeof value.decisionReason === "string" ? { decisionReason: value.decisionReason } : {}),
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.displayName === "string" ? { displayName: value.displayName } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    toolUseID: boundedString(value.toolUseID, "tool use id", 512),
    ...(typeof value.agentID === "string" ? { agentID: boundedString(value.agentID, "agent id", 512) } : {}),
    requestId: boundedString(value.requestId, "callback request id", 512)
  };
}

function permissionResult(value, input) {
  if (!record(value)) return { behavior: "deny", message: "The remote approval response was invalid.", interrupt: true };
  if (value.behavior === "allow" && record(value.updatedInput)) {
    return {
      behavior: "allow",
      updatedInput: value.updatedInput,
      ...(Array.isArray(value.updatedPermissions) ? { updatedPermissions: value.updatedPermissions } : {})
    };
  }
  if (value.behavior === "deny" && typeof value.message === "string") {
    return { behavior: "deny", message: value.message, ...(value.interrupt === true ? { interrupt: true } : {}) };
  }
  return { behavior: "deny", message: "The remote approval response was invalid.", interrupt: true };
}

function permissionMode(value) {
  if (["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"].includes(value)) return value;
  throw fault("invalid_request", false);
}

function effort(value) {
  if (["low", "medium", "high", "xhigh", "max"].includes(value)) return value;
  throw fault("invalid_request", false);
}

function flagSettings(value) {
  if (!record(value)) throw fault("invalid_request", false);
  const output = {};
  if (value.effortLevel !== undefined) output.effortLevel = value.effortLevel === null ? null : effort(value.effortLevel);
  if (value.fastMode !== undefined) {
    if (value.fastMode !== null && typeof value.fastMode !== "boolean") throw fault("invalid_request", false);
    output.fastMode = value.fastMode;
  }
  if (value.permissions !== undefined) {
    if (value.permissions !== null) {
      if (!record(value.permissions)) throw fault("invalid_request", false);
      const directories = stringArray(value.permissions.additionalDirectories ?? [], "additional directories", 64, 16_384);
      if (directories.length > 0) throw fault("remote_extra_directories_unsupported", false);
      output.permissions = { additionalDirectories: [] };
    } else output.permissions = null;
  }
  return output;
}

function systemPrompt(value) {
  if (!record(value) || value.type !== "preset" || value.preset !== "claude_code") throw fault("invalid_request", false);
  return { type: "preset", preset: "claude_code", ...(value.append === undefined ? {} : { append: boundedString(value.append, "system prompt", 1024 * 1024) }) };
}

function tools(value) {
  if (Array.isArray(value)) return stringArray(value, "tools", 256, 512);
  if (record(value) && value.type === "preset" && value.preset === "claude_code") return { type: "preset", preset: "claude_code" };
  throw fault("invalid_request", false);
}

function nullableStringRecord(value, label) {
  if (!record(value) || Object.keys(value).length > 256) throw fault("invalid_request", false);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [boundedString(key, label, 512), item === null ? null : boundedString(item, label, 4096)]));
}

function jsonObject(value) {
  if (!record(value) || Buffer.byteLength(JSON.stringify(value), "utf8") > 1024 * 1024) throw fault("invalid_request", false);
  return value;
}

function emptyRecord(value) {
  if (!record(value) || Object.keys(value).length !== 0) throw fault("invalid_request", false);
  return {};
}

function stringArray(value, label, maximum, itemBytes) {
  if (!Array.isArray(value) || value.length > maximum) throw fault("invalid_request", false);
  return value.map((item) => boundedString(item, label, itemBytes));
}

function uuid(value) {
  if (typeof value !== "string" || !UUID.test(value)) throw fault("invalid_request", false);
  return value.toLowerCase();
}

function absolutePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 16_384 || value.includes("\0") || !value.startsWith("/") || remotePath.resolve(value) !== value) {
    throw fault("invalid_path", false);
  }
  return value;
}

function boundedString(value, label, maximumBytes) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maximumBytes || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw fault("invalid_request", false);
  }
  return value;
}

function optionalString(value, label, maximumBytes) {
  return value === undefined ? undefined : boundedString(value, label, maximumBytes);
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw fault("invalid_request", false);
  return value;
}

function string(value) {
  return boundedString(value, "identity", 512);
}

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function invalid() { throw fault("invalid_request", false); }

function fault(code, stateMayHaveChanged) {
  const error = new Error(code);
  error.code = code;
  error.stateMayHaveChanged = stateMayHaveChanged;
  return error;
}

function normalizeFault(error) {
  return error && typeof error.code === "string"
    ? { code: error.code, stateMayHaveChanged: error.stateMayHaveChanged === true }
    : { code: "operation_failed", stateMayHaveChanged: true };
}

async function readManagerLock(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && info.uid !== process.getuid()) || info.size < 2 || info.size > 4096) {
      throw fault("manager_lock_invalid", true);
    }
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!record(value) || value.schema !== 1 || value.managerSha256 !== MANAGER_SHA256
      || !Number.isSafeInteger(value.pid) || value.pid < 1
      || typeof value.birth !== "string" || value.birth.length === 0 || value.birth.length > 512
      || !sha256(value.commandHash) || !sha256(value.executableHash)
      || !Number.isSafeInteger(value.uid) || value.uid < 0 || value.uid !== info.uid) {
      throw fault("manager_lock_invalid", true);
    }
    return manifestFingerprint(value);
  } catch (error) {
    if (error?.code === "manager_lock_invalid") throw error;
    throw fault("manager_lock_invalid", true);
  }
}

async function removeManagerLock(path, expected) {
  const observed = await readManagerLock(path);
  if (!fingerprintsMatch(observed, expected)) throw fault("manager_lock_changed", true);
  await unlink(path);
}

async function runDaemon(socketPath, runtimeRoot, executable) {
  runtimeRoot = absolutePath(runtimeRoot);
  socketPath = absolutePath(socketPath);
  executable = absolutePath(executable);
  const expectedNode = join(runtimeRoot, "current", "node", "bin", "node");
  const expectedManager = join(runtimeRoot, "current", "manager.mjs");
  const executableRoot = `${join(runtimeRoot, "current", "node_modules", "@anthropic-ai")}/`;
  if (socketPath !== join(runtimeRoot, "run", "manager.sock")
    || resolve(process.execPath) !== resolve(expectedNode)
    || resolve(fileURLToPath(import.meta.url)) !== resolve(expectedManager)
    || !executable.startsWith(executableRoot) || !executable.endsWith("/claude")) {
    throw fault("runtime_layout_invalid", false);
  }
  process.env.JOKO_CLAUDE_RUNTIME_ROOT = runtimeRoot;
  process.env.JOKO_CLAUDE_EXECUTABLE = executable;
  const profileRoot = join(runtimeRoot, "profile");
  const temporaryRoot = join(runtimeRoot, "tmp");
  if (process.env.HOME !== profileRoot || process.env.CLAUDE_CONFIG_DIR !== profileRoot
    || process.env.CLAUDE_CODE_TMPDIR !== temporaryRoot || process.env.TMPDIR !== temporaryRoot) {
    throw fault("runtime_environment_invalid", false);
  }
  const runRoot = dirname(socketPath);
  await requirePrivateDirectory(runtimeRoot);
  await requirePrivateDirectory(profileRoot);
  await requirePrivateDirectory(temporaryRoot);
  await requirePrivateDirectory(runRoot);
  const queriesRoot = join(runRoot, "queries");
  try { await mkdir(queriesRoot, { mode: 0o700 }); }
  catch (error) { if (error?.code !== "EEXIST") throw fault("runtime_layout_invalid", false); }
  await requirePrivateDirectory(queriesRoot);
  const lockPath = join(runRoot, "manager.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    let observed;
    try { observed = await readManagerLock(lockPath); }
    catch { process.exitCode = 74; return; }
    if (fingerprintsMatch(await processFingerprint(observed.pid), observed)) { process.exitCode = 73; return; }
    try { await unlink(lockPath); }
    catch { process.exitCode = 74; return; }
    try { lock = await open(lockPath, "wx", 0o600); }
    catch { process.exitCode = 73; return; }
  }
  const managerFingerprint = await processFingerprint(process.pid);
  if (!managerFingerprint || (typeof process.getuid === "function" && managerFingerprint.uid !== process.getuid())) {
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
    process.exitCode = 74;
    return;
  }
  await lock.writeFile(`${JSON.stringify({ schema: 1, managerSha256: MANAGER_SHA256, ...managerFingerprint })}\n`, "utf8");
  await lock.close();
  await unlink(socketPath).catch(() => undefined);
  const managerState = createManagerState();
  const server = net.createServer((socket) => new ManagerConnection(socket, managerState));
  const finish = async () => {
    server.close();
    await unlink(socketPath).catch(() => undefined);
    await removeManagerLock(lockPath, managerFingerprint).catch(() => undefined);
  };
  process.once("SIGTERM", () => void finish().finally(() => process.exit(0)));
  process.once("SIGINT", () => void finish().finally(() => process.exit(0)));
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolvePromise());
  });
  await chmod(socketPath, 0o600);
}

async function connectSocket(socketPath) {
  return await new Promise((resolvePromise, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => resolvePromise(socket));
    socket.once("error", reject);
  });
}

async function ensureDaemon(socketPath, runtimeRoot, executable) {
  try { return await connectSocket(socketPath); } catch {}
  const managerPath = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [managerPath, "daemon", socketPath, runtimeRoot, executable], {
    detached: true,
    stdio: "ignore",
    env: daemonEnvironment(runtimeRoot, executable)
  });
  child.unref();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    try { return await connectSocket(socketPath); } catch {}
  }
  throw fault("daemon_unavailable", false);
}

function daemonEnvironment(runtimeRoot, executable) {
  const profile = join(runtimeRoot, "profile");
  const temporary = join(runtimeRoot, "tmp");
  const output = {
    HOME: profile,
    PATH: fixedRuntimePath(),
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    CLAUDE_CONFIG_DIR: profile,
    CLAUDE_CODE_TMPDIR: temporary,
    JOKO_CLAUDE_RUNTIME_ROOT: runtimeRoot,
    JOKO_CLAUDE_EXECUTABLE: executable
  };
  for (const name of ["LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ"]) {
    const item = process.env[name];
    if (typeof item === "string" && Buffer.byteLength(item, "utf8") <= 4096) output[name] = item;
  }
  return output;
}

function fixedRuntimePath() {
  const nodeDirectory = dirname(process.execPath);
  const inherited = typeof process.env.PATH === "string" ? process.env.PATH : "/usr/local/bin:/usr/bin:/bin";
  return `${nodeDirectory}:${inherited}`;
}

async function runBridge(socketPath, runtimeRoot, executable) {
  const socket = await ensureDaemon(absolutePath(socketPath), absolutePath(runtimeRoot), absolutePath(executable));
  await Promise.race([
    pipeline(process.stdin, socket),
    pipeline(socket, process.stdout)
  ]).catch(() => undefined);
  socket.destroy();
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--version") {
    process.stdout.write(`${JSON.stringify({
      managerVersion: MANAGER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      managerSha256: MANAGER_SHA256
    })}\n`);
  } else if (command === "daemon" && args.length === 3) {
    await runDaemon(args[0], args[1], args[2]);
  } else if (command === "bridge" && args.length === 3) {
    await runBridge(args[0], args[1], args[2]);
  } else {
    process.exitCode = 64;
  }
}
