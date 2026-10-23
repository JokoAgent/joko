import { randomUUID } from "node:crypto";
import { posix, win32 } from "node:path";
import { runInNewContext } from "node:vm";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import sharp from "sharp";
import { claudeHostedToolDefinitions } from "@joko/adapter-claude-code";
import { HostedAgentExecutorError } from "./hosted-agent-executor.js";

type Result = { readonly content: readonly Record<string, unknown>[]; readonly isError: boolean };
export interface HostedAgentClaudeAuthorization {
  readonly webFetch?: (input: Readonly<Record<string, unknown>>, signal: AbortSignal) => Promise<Result>;
  readonly readPdf?: (bytes: Buffer, pages: string | undefined, signal: AbortSignal) => Promise<Result>;
  execute(input: unknown, signal?: AbortSignal, effects?: {
    readonly onOutput?: (chunk: Buffer) => void;
    readonly captureCwd?: boolean;
    readonly background?: boolean;
    readonly readMaximumBytes?: number;
    readonly readLines?: { readonly offset: number; readonly limit: number; readonly maxLineChars: number };
  }): Promise<Record<string, unknown>>;
}
interface Scope {
  readonly callId: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly authorization: HostedAgentClaudeAuthorization;
  readonly path?: string;
  readonly command?: string;
  readonly cwd?: string;
  readonly timeout?: number;
  sequence: number;
  dispatched: boolean;
  background?: Job;
}
interface Job {
  readonly id: string;
  readonly scope: Scope;
  readonly abort: AbortController;
  readonly settled: Promise<void>;
  text: string;
  consumed: number;
  complete: boolean;
  exitCode?: number | null;
  truncated: boolean;
}
export interface HostedAgentClaudeExecutorOptions {
  readonly workspaceRoot: string;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
}

/** Per-task native-style state on the original computer. Every filesystem and
 * command effect uses the executor captured for its original Queue operation. */
export class HostedAgentClaudeExecutor {
  readonly #options: HostedAgentClaudeExecutorOptions;
  readonly #lifetime = new AbortController();
  readonly #scopes = new Map<string, Scope>();
  readonly #reads = new Map<string, string>();
  readonly #jobs = new Map<string, Job>();
  readonly #seen = new Set<string>();
  readonly #validators = new Map(claudeHostedToolDefinitions(true).map(definition => [definition.name,
    new AjvJsonSchemaValidator().getValidator<Record<string, unknown>>(definition.inputSchema)]));
  readonly #paths: typeof posix | typeof win32;
  #cwd: string;
  constructor(options: HostedAgentClaudeExecutorOptions) {
    this.#options = options; this.#cwd = options.workspaceRoot;
    this.#paths = /^[A-Za-z]:|^\\\\/u.test(options.workspaceRoot) ? win32 : posix;
    if (!this.#paths.isAbsolute(this.#cwd)) throw new HostedAgentExecutorError("INVALID_REQUEST");
    this.#assertCurrent(options.signal);
  }
  async execute(inputValue: unknown, signal: AbortSignal, authorization: HostedAgentClaudeAuthorization): Promise<Record<string, unknown> | undefined> {
    const value = record(inputValue); if (!value) return undefined;
    const payload = record(value.payload), operation = value.operation, callId = value.callId;
    const own = typeof callId === "string" ? this.#scopes.get(callId) : undefined;
    const beginning = operation === "tool.begin" && payload?.name === "claude";
    if (!beginning && !own && operation !== "claude.call") return undefined;
    const active = AbortSignal.any([signal, this.#lifetime.signal, this.#options.signal]); this.#assertCurrent(active);
    if (value.format !== 1 || typeof callId !== "string" || !callId || callId.length > 512
      || typeof value.requestId !== "string" || !value.requestId || value.requestId.length > 1024 || !payload
      || Object.keys(value).some(key => !["format", "callId", "requestId", "operation", "payload"].includes(key))) throw new HostedAgentExecutorError("INVALID_REQUEST");
    if (this.#seen.has(value.requestId)) throw new HostedAgentExecutorError("REQUEST_REPLAYED");
    if (this.#seen.size >= 65_536) throw new HostedAgentExecutorError("RESOURCE_EXHAUSTED");
    this.#seen.add(value.requestId);
    if (beginning) {
      if (own || this.#scopes.size >= 256 || Object.keys(payload).some(key => !["name", "input"].includes(key))) throw new HostedAgentExecutorError("INVALID_REQUEST");
      const request = record(payload.input), name = request?.name, input = record(request?.arguments);
      const validator = typeof name === "string" ? this.#validators.get(name) : undefined;
      if (!request || Object.keys(request).some(key => !["name", "arguments"].includes(key)) || !input || !validator?.(input).valid
        || Buffer.byteLength(JSON.stringify(input)) > 20 * 1024 * 1024) throw new HostedAgentExecutorError("INVALID_REQUEST");
      const scope = await this.#begin(callId, String(name), structuredClone(input), authorization, active);
      this.#assertCurrent(active); this.#scopes.set(callId, scope); return {};
    }
    if (!own || own.authorization !== authorization || Object.keys(payload).length !== 0) throw new HostedAgentExecutorError("ACCESS_DENIED");
    if (operation === "tool.end") {
      this.#scopes.delete(callId);
      if (!own.background) await this.#primitive(own, "tool.end", {}, active);
      return {};
    }
    if (operation !== "claude.call" || own.dispatched) throw new HostedAgentExecutorError("REQUEST_REPLAYED");
    own.dispatched = true;
    const result = await this.#call(own, active); this.#assertCurrent(active);
    return { ...result };
  }
  async dispose(): Promise<void> {
    this.#lifetime.abort(); for (const job of this.#jobs.values()) job.abort.abort();
    await Promise.allSettled([...this.#jobs.values()].map(job => job.settled));
    this.#scopes.clear(); this.#reads.clear(); this.#jobs.clear(); this.#seen.clear();
  }
  async #begin(callId: string, name: string, input: Record<string, unknown>, authorization: HostedAgentClaudeAuthorization, signal: AbortSignal): Promise<Scope> {
    const scope: Scope = { callId, name, input, authorization, sequence: 0, dispatched: false };
    if (["Read", "Write", "Edit", "NotebookEdit"].includes(name)) {
      const path = text(input[name === "NotebookEdit" ? "notebook_path" : "file_path"], 16_384);
      const canonical = this.#paths.resolve(this.#options.workspaceRoot, path);
      Object.assign(scope, { path: canonical });
      await this.#primitive(scope, "tool.begin", { name: name === "Read" ? "read" : "edit", input: { path: canonical } }, signal);
    } else if (name === "WebFetch") {
      if (!authorization.webFetch) throw new HostedAgentExecutorError("ACCESS_DENIED");
      // The injected Source service owns URL policy, private-address review,
      // DNS and proxy dispatch. It receives this exact operation's signal.
    } else {
      const job = name === "Bash" ? undefined : this.#jobs.get(text(input[name === "BashOutput" ? "bash_id" : "shell_id"], 512));
      if (name !== "Bash" && !job) throw new HostedAgentExecutorError("NOT_FOUND");
      const command = name === "Bash" ? text(input.command, 1024 * 1024) : job!.scope.command!;
      const cwd = name === "Bash" ? this.#cwd : job!.scope.cwd!;
      const timeout = name === "Bash" ? Number(input.timeout ?? 120000) / 1000 : job!.scope.timeout!;
      Object.assign(scope, { command, cwd, timeout });
      await this.#primitive(scope, "tool.begin", { name: "bash", input: { command, cwd, timeout } }, signal);
    }
    return scope;
  }
  #primitive(scope: Scope, operation: string, payload: Record<string, unknown>, signal: AbortSignal, effects?: Parameters<HostedAgentClaudeAuthorization["execute"]>[2]): Promise<Record<string, unknown>> {
    this.#assertCurrent(signal);
    const callId = `${scope.callId}:native`;
    return scope.authorization.execute({ format: 1, callId,
      requestId: `${callId}:${++scope.sequence}`, operation, payload }, signal, effects);
  }
  async #call(scope: Scope, signal: AbortSignal): Promise<Result> {
    switch (scope.name) {
      case "Read": {
        const path = scope.path!, info = await this.#primitive(scope, "fs.stat", { path }, signal);
        if (info.type !== "file") return result("The path is not a regular file. Use Bash to list a directory.", true);
        const mime = (await this.#primitive(scope, "fs.mime", { path }, signal)).mime;
        const extension = this.#paths.extname(path).toLowerCase();
        if (typeof mime === "string" || [".png", ".jpg", ".jpeg", ".jfif", ".gif", ".webp", ".bmp", ".avif", ".ico", ".tiff", ".tif", ".heic", ".heif"].includes(extension)) {
          const loaded = await this.#read(scope, signal, 32 * 1024 * 1024); let bytes = loaded.bytes, imageMime = typeof mime === "string" ? mime : undefined;
          if (bytes.byteLength > 500_000) {
            try { bytes = await sharp(bytes, { limitInputPixels: 100_000_000, sequentialRead: true }).timeout({ seconds: 5 }).rotate()
              .resize({ width: 1568, height: 1568, fit: "inside", withoutEnlargement: true }).webp({ quality: 85 }).toBuffer(); imageMime = "image/webp"; }
            catch { /* Preserve the fixed native Read's original-image fallback. */ }
          }
          signal.throwIfAborted();
          if (!imageMime) return result("The image format cannot be sent to the model on the task computer.", true);
          if (bytes.byteLength > 5 * 1024 * 1024) return result("The image exceeds the 5 MiB model input limit.", true);
          this.#remember(path, loaded.sha256); return { content: [{ type: "image", data: bytes.toString("base64"), mimeType: imageMime }], isError: false };
        }
        if (extension === ".pdf") {
          if (typeof info.size !== "number" || info.size > 32 * 1024 * 1024) return result("The PDF exceeds the 32 MiB input limit.", true);
          const loaded = await this.#read(scope, signal, 32 * 1024 * 1024);
          const extracted = scope.authorization.readPdf ? await scope.authorization.readPdf(loaded.bytes, typeof scope.input.pages === "string" ? scope.input.pages : undefined, signal)
            : result("PDF text extraction is unavailable on the task computer.", true);
          if (!extracted.isError) this.#remember(path, loaded.sha256); return extracted;
        }
        if (extension === ".ipynb") {
          const loaded = await this.#read(scope, signal), rendered = notebookText(decodeText(loaded.bytes)); this.#remember(path, loaded.sha256); return result(rendered);
        }
        if (scope.input.offset === undefined && scope.input.limit === undefined && typeof info.size === "number" && info.size > 256 * 1024) {
          return result("The file exceeds the 256 KiB full-read limit. Use offset and limit to read specific lines.", true);
        }
        const offset = Math.max(1, Number(scope.input.offset ?? 1)), limit = Number(scope.input.limit ?? 2000);
        const response = await this.#primitive(scope, "fs.read", { path }, signal, { readLines: { offset, limit, maxLineChars: 2000 } });
        if (!Array.isArray(response.lines) || response.lines.some(line => typeof line !== "string") || !Number.isSafeInteger(response.totalLines)
          || typeof response.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(response.sha256)) throw new HostedAgentExecutorError("INVALID_REQUEST");
        this.#remember(path, response.sha256);
        if (info.size === 0) return result("<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>");
        if (!response.lines.length) return result(`<system-reminder>Warning: the file has ${String(response.totalLines)} lines, shorter than offset ${offset}.</system-reminder>`);
        return result(response.lines.map((line, index) => `${offset + index}\t${String(line)}`).join("\n"));
      }
      case "Write": case "Edit": case "NotebookEdit": return this.#write(scope, signal);
      case "Bash": {
        if (scope.input.run_in_background === true) return this.#background(scope);
        const response = await this.#primitive(scope, "exec.run", { command: scope.command!, cwd: scope.cwd!, timeout: scope.timeout! }, signal, { captureCwd: true });
        this.#adoptCwd(response.cwd);
        return result(shellText(response), response.exitCode !== 0 || response.aborted === true || response.timedOut === true);
      }
      case "BashOutput": {
        const job = this.#jobs.get(String(scope.input.bash_id))!;
        const fresh = job.text.slice(job.consumed); job.consumed = job.text.length;
        let text = fresh;
        if (typeof scope.input.filter === "string") {
          if (scope.input.filter.length > 4096) return result("The output filter exceeds its limit.", true);
          try {
            text = runInNewContext("const expression = new RegExp(pattern); content.split('\\n').filter(line => expression.test(line)).join('\\n')",
              { pattern: scope.input.filter, content: fresh }, { timeout: 200 }) as string;
          } catch { return result("The output filter is invalid or exceeded its execution limit.", true); }
        }
        return result(`Status: ${job.complete ? "completed" : "running"}${job.complete ? ` (exit ${String(job.exitCode ?? "unknown")})` : ""}\n${text}${job.truncated ? "\nOutput exceeded its retained limit." : ""}`);
      }
      case "KillShell": {
        const job = this.#jobs.get(String(scope.input.shell_id))!; job.abort.abort(); await job.settled;
        return result(`Stopped background command ${job.id}.`);
      }
      case "WebFetch": return scope.authorization.webFetch!(scope.input, signal);
      default: throw new HostedAgentExecutorError("INVALID_REQUEST");
    }
  }
  async #read(scope: Scope, signal: AbortSignal, maximum?: number): Promise<{ readonly bytes: Buffer; readonly sha256: string }> {
    const response = await this.#primitive(scope, "fs.read", { path: scope.path! }, signal, maximum === undefined ? undefined : { readMaximumBytes: maximum });
    const data = response.data;
    if (typeof data !== "string" || data.length > 44 * 1024 * 1024 || typeof response.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(response.sha256)) throw new HostedAgentExecutorError("RESOURCE_EXHAUSTED");
    const bytes = Buffer.from(data, "base64"); if (bytes.toString("base64") !== data) throw new HostedAgentExecutorError("INVALID_REQUEST");
    return { bytes, sha256: response.sha256 };
  }
  async #write(scope: Scope, signal: AbortSignal): Promise<Result> {
    let previous: { readonly bytes: Buffer; readonly sha256: string } | undefined;
    try { previous = await this.#read(scope, signal); }
    catch (error) { if (!(error instanceof HostedAgentExecutorError) || error.code !== "NOT_FOUND") throw error; }
    const path = scope.path!, input = scope.input;
    if (previous && this.#reads.get(this.#key(path)) !== previous.sha256) return result("The file was not read in this task, or it changed since it was read. Read it again before editing.", true);
    let updated: string;
    if (scope.name === "Write") updated = String(input.content);
    else if (scope.name === "NotebookEdit") {
      if (!previous || !path.toLowerCase().endsWith(".ipynb")) return result("Read an existing notebook before editing its cells.", true);
      updated = editNotebook(decodeText(previous.bytes), input);
    } else {
      const old = String(input.old_string), next = String(input.new_string);
      if (old === next) return result("No changes to make: the old and new strings are identical.", true);
      if (!previous) { if (old !== "") return result("The file does not exist.", true); updated = next; }
      else {
        const raw = decodeText(previous.bytes), crlf = raw.includes("\r\n"), original = crlf ? raw.replace(/\r\n/gu, "\n") : raw;
        const needle = crlf ? old.replace(/\r\n/gu, "\n") : old, replacement = crlf ? next.replace(/\r\n/gu, "\n") : next;
        if (needle === "") { if (original.trim()) return result("Cannot create a file that already contains content.", true); updated = replacement; }
        else {
          const count = original.split(needle).length - 1;
          if (!count) return result("The string to replace was not found in the file.", true);
          if (count > 1 && input.replace_all !== true) return result(`Found ${count} matches. Set replace_all or provide more context.`, true);
          updated = input.replace_all === true ? original.split(needle).join(replacement) : original.replace(needle, () => replacement);
        }
        if (crlf) updated = updated.replace(/\n/gu, "\r\n");
      }
    }
    await this.#primitive(scope, "fs.mkdir", { path: this.#paths.dirname(path) }, signal);
    await this.#primitive(scope, "fs.write", { path, data: Buffer.from(updated).toString("base64") }, signal);
    this.#remember(path, (await this.#read(scope, signal)).sha256);
    return result(`The file ${path} has been ${previous ? "updated" : "created"} successfully.`);
  }
  #background(scope: Scope): Result {
    if ([...this.#jobs.values()].filter(job => !job.complete).length >= 16 || this.#jobs.size >= 256) return result("Too many background commands. Stop a running command first.", true);
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, this.#lifetime.signal, this.#options.signal]);
    const id = "shell-" + randomUUID(); let job!: Job;
    const settled = Promise.resolve().then(async () => {
      const response = await this.#primitive(scope, "exec.run", { command: scope.command!, cwd: scope.cwd!, timeout: scope.timeout! }, signal, {
        captureCwd: true, background: true, onOutput: bytes => {
          this.#assertCurrent(signal);
          const available = 4 * 1024 * 1024 - job.text.length;
          if (available > 0) job.text += bytes.toString("utf8").slice(0, available);
          if (bytes.byteLength > available) job.truncated = true;
        }
      });
      if (!job.text && typeof response.output === "string") job.text = Buffer.from(response.output, "base64").toString("utf8").slice(0, 4 * 1024 * 1024);
      job.exitCode = typeof response.exitCode === "number" || response.exitCode === null ? response.exitCode : undefined;
    }).catch(() => { job.text += "\nThe task command stopped or its execution authority changed."; })
      .finally(async () => { job.complete = true;
        const callId = `${scope.callId}:native`;
        await scope.authorization.execute({ format: 1, callId, requestId: `${callId}:${++scope.sequence}`, operation: "tool.end", payload: {} }, this.#options.signal).catch(() => undefined); });
    job = { id, scope, abort, settled, text: "", consumed: 0, complete: false, truncated: false };
    scope.background = job; this.#jobs.set(id, job);
    return result(`Command running in background with ID: ${id}. Use BashOutput to read new output and KillShell to stop it.`);
  }
  #adoptCwd(value: unknown): void { if (typeof value === "string" && this.#paths.isAbsolute(value) && value.length <= 16_384 && !value.includes("\0")) this.#cwd = value; }
  #remember(path: string, sha256: string): void { if (this.#reads.size >= 4096) this.#reads.delete(this.#reads.keys().next().value!); this.#reads.set(this.#key(path), sha256); }
  #key(path: string): string { return this.#paths === win32 ? this.#paths.normalize(path).toLowerCase() : this.#paths.normalize(path); }
  #assertCurrent(signal: AbortSignal): void { if (signal.aborted || this.#lifetime.signal.aborted) throw new HostedAgentExecutorError("STALE_AUTHORITY"); this.#options.assertCurrent(); }
}

function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function text(value: unknown, maximum: number): string { if (typeof value !== "string" || !value || value.length > maximum || value.includes("\0")) throw new HostedAgentExecutorError("INVALID_REQUEST"); return value; }
function result(text: string, isError = false): Result { return { content: [{ type: "text", text }], isError }; }
function decodeText(bytes: Buffer): string { const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); if (text.includes("\0")) throw new HostedAgentExecutorError("INVALID_REQUEST"); return text; }
function shellText(response: Record<string, unknown>): string {
  const output = typeof response.output === "string" ? Buffer.from(response.output, "base64").toString("utf8") : "";
  const shortened = output.length > 30000 ? output.slice(0, 15000) + "\n... output truncated ...\n" + output.slice(-15000) : output;
  return shortened + (response.timedOut ? "\nCommand timed out." : response.aborted ? "\nCommand was stopped." : response.exitCode !== 0 ? `\nExit code: ${String(response.exitCode ?? "unknown")}` : "");
}
function notebookText(raw: string): string {
  let notebook: Record<string, unknown> | undefined;
  try { notebook = record(JSON.parse(raw)); } catch { return raw; }
  const cells = Array.isArray(notebook?.cells) ? notebook.cells : [];
  if (cells.length > 10_000) throw new HostedAgentExecutorError("RESOURCE_EXHAUSTED");
  if (!cells.length) return "<system-reminder>Warning: the notebook has no cells.</system-reminder>";
  return cells.map((cell, index) => { const item = record(cell) ?? {}, source = Array.isArray(item.source) ? item.source.join("") : String(item.source ?? "");
    const outputs = Array.isArray(item.outputs) ? item.outputs.map(output => { const entry = record(output) ?? {};
      if (typeof entry.text === "string") return entry.text;
      if (Array.isArray(entry.text)) return entry.text.join("");
      const data = record(entry.data), plain = data?.["text/plain"];
      if (typeof plain === "string") return plain;
      if (Array.isArray(plain)) return plain.join("");
      if (data && Object.keys(data).some(key => key.startsWith("image/"))) return "[image output]";
      return typeof entry.ename === "string" ? `${entry.ename}: ${String(entry.evalue ?? "")}` : ""; }).filter(Boolean).join("\n") : "";
    return `<cell id="${typeof item.id === "string" ? item.id : `cell-${index}`}"><cell_type>${String(item.cell_type ?? "code")}</cell_type>\n${source}${outputs ? `\n<outputs>\n${outputs}\n</outputs>` : ""}\n</cell>`; }).join("\n");
}
function editNotebook(raw: string, input: Readonly<Record<string, unknown>>): string {
  const notebook = record(JSON.parse(raw)); if (!notebook || !Array.isArray(notebook.cells) || notebook.cells.length > 10_000) throw new HostedAgentExecutorError("INVALID_REQUEST");
  const cells = notebook.cells as Record<string, unknown>[], id = input.cell_id;
  let index = typeof id === "string" ? cells.findIndex(cell => cell.id === id) : -1;
  if (index < 0 && typeof id === "string" && /^cell-\d+$/u.test(id)) index = Number(id.slice(5));
  const mode = input.edit_mode ?? "replace", type = input.cell_type;
  if (mode !== "insert" && (index < 0 || index >= cells.length)) throw new HostedAgentExecutorError("NOT_FOUND");
  if (mode === "delete") cells.splice(index, 1);
  else if (mode === "insert") {
    if (type !== "code" && type !== "markdown" || id !== undefined && (index < 0 || index >= cells.length)) throw new HostedAgentExecutorError("INVALID_REQUEST");
    const supportsIds = Number(notebook.nbformat ?? 4) > 4 || Number(notebook.nbformat ?? 4) === 4 && Number(notebook.nbformat_minor ?? 0) >= 5;
    cells.splice(index + 1, 0, { ...(supportsIds ? { id: randomUUID().slice(0, 8) } : {}), cell_type: type, metadata: {}, source: String(input.new_source), ...(type === "code" ? { execution_count: null, outputs: [] } : {}) });
  } else {
    const cell = cells[index]!; cell.source = String(input.new_source);
    if (type !== undefined) cell.cell_type = type;
    if (cell.cell_type === "code") { cell.execution_count = null; cell.outputs = []; } else { delete cell.execution_count; delete cell.outputs; }
  }
  const indent = /^\{\s*\n( +)"/u.exec(raw)?.[1]?.length ?? 1;
  return JSON.stringify(notebook, null, Math.min(indent, 10)) + "\n";
}
