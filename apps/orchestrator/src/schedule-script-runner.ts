import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { TextDecoder } from "node:util";

import { redactSecrets } from "@joko/core";

const SCRIPT_PROTOCOL = "joko-schedule-script/1" as const;
const STDERR_CAP_BYTES = 64 * 1024;
const FRAME_CAP_BYTES = 256 * 1024;
const RESULT_CAP_BYTES = 8 * 1024;
const MAX_INFLIGHT_CALLS = 16;
const DEFAULT_POST_EXIT_CALL_TIMEOUT_MS = 30_000;
const FORCE_EXIT_TIMEOUT_MS = 1_000;
const KILLER_TIMEOUT_MS = 500;

const ENVIRONMENT_ALLOWLIST = new Set([
  "APPDATA",
  "COMSPEC",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
  "USERNAME",
  "USERPROFILE",
  "WINDIR"
]);
const SENSITIVE_ENVIRONMENT_NAME = /(?:AUTH|BEARER|COOKIE|CREDENTIAL|JWT|KEY|PASS(?:WORD|WD)?|PRIVATE|SECRET|SESSION|TOKEN)/iu;
const SAFE_CODE = /^[A-Z][A-Z0-9_.-]{0,63}$/u;

export type ScheduleScriptCapability = "sessions.dispatch";

export interface ScheduleScriptCapabilityCall {
  readonly id: string;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface ScheduleScriptCapabilityBroker {
  call(
    request: ScheduleScriptCapabilityCall,
    granted: ReadonlySet<ScheduleScriptCapability>,
    context: { readonly scheduleId: string; readonly runId: string }
  ): Promise<unknown>;
  finalizeActiveCalls?(runId: string): void;
}

export interface ExecuteScheduleScriptInput {
  readonly command: string;
  readonly cwd: string;
  readonly scheduleId: string;
  readonly scheduleName: string;
  readonly runId: string;
  readonly firedAt: number;
  readonly capabilities: readonly ScheduleScriptCapability[];
  /** Missing, non-finite, or non-positive means no whole-run timeout. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly broker: ScheduleScriptCapabilityBroker;
  /** Primarily useful for keeping process-exit tests bounded. */
  readonly postExitCallTimeoutMs?: number;
  /** Test-only source override. Values still pass through the strict allowlist. */
  readonly environment?: NodeJS.ProcessEnv;
}

export type ScheduleScriptInput = ExecuteScheduleScriptInput;

export interface ScheduleScriptExecutionResult {
  readonly resultText?: string;
  readonly primarySessionId?: string;
  readonly durationMs: number;
  readonly stderr: string;
  readonly stderrTruncated: boolean;
}

export type ScheduleScriptExecutionErrorCode =
  | "ABORTED"
  | "HOST_CALL_FAILED_AFTER_COMPLETE"
  | "HOST_CALL_TIMEOUT"
  | "INVALID_INPUT"
  | "NONZERO_EXIT"
  | "PROCESS_EXIT_FAILED"
  | "PROTOCOL_ERROR"
  | "SPAWN_FAILED"
  | "TIMED_OUT";

export class ScheduleScriptExecutionError extends Error {
  readonly code: ScheduleScriptExecutionErrorCode;
  readonly aborted: boolean;
  readonly timedOut: boolean;
  readonly exitCode?: number | null;

  constructor(
    code: ScheduleScriptExecutionErrorCode,
    message: string,
    options: { readonly exitCode?: number | null } = {}
  ) {
    super(safeDiagnostic(message, 2_048));
    this.name = "ScheduleScriptExecutionError";
    this.code = code;
    this.aborted = code === "ABORTED";
    this.timedOut = code === "TIMED_OUT";
    this.exitCode = options.exitCode;
  }
}

interface CallFrame {
  readonly type: "call";
  readonly id: string;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

interface CompleteFrame {
  readonly type: "complete";
  readonly resultText?: string;
  readonly primarySessionId?: string;
}

interface ProcessExit {
  readonly code: number | null;
  readonly spawnError?: string;
}

interface StableCallError {
  readonly code: string;
  readonly message: string;
}

export function buildScheduleScriptEnvironment(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== "string" || value === "") continue;
    const normalized = name.toUpperCase();
    if (!ENVIRONMENT_ALLOWLIST.has(normalized) || SENSITIVE_ENVIRONMENT_NAME.test(name)) continue;
    if (value.startsWith("()")) continue;
    environment[name] = value;
  }
  environment.JOKO_SCHEDULE_SCRIPT_PROTOCOL = "1";
  environment.PYTHONUTF8 = "1";
  return environment;
}

export async function executeScheduleScript(
  input: ExecuteScheduleScriptInput
): Promise<ScheduleScriptExecutionResult> {
  const startedAt = Date.now();
  validateInput(input);
  if (input.signal?.aborted === true) {
    throw new ScheduleScriptExecutionError("ABORTED", "Schedule script execution was aborted.");
  }

  const timeoutMs = positiveInteger(input.timeoutMs);
  const postExitCallTimeoutMs = positiveInteger(input.postExitCallTimeoutMs)
    ?? DEFAULT_POST_EXIT_CALL_TIMEOUT_MS;
  const granted = new Set(input.capabilities);
  let child: ChildProcess;
  try {
    child = spawn(input.command, {
      shell: true,
      cwd: input.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: buildScheduleScriptEnvironment(input.environment)
    });
  } catch (error) {
    throw new ScheduleScriptExecutionError(
      "SPAWN_FAILED",
      `Schedule script could not start: ${unknownErrorMessage(error)}`
    );
  }

  child.stdin?.on("error", () => undefined);

  let stdoutBuffer = "";
  const stdoutDecoder = new StringDecoder("utf8");
  const stdoutValidator = new TextDecoder("utf-8", { fatal: true });
  const stderrDecoder = new StringDecoder("utf8");
  const stderrOutput = new BoundedText(STDERR_CAP_BYTES);
  const seenCallIds = new Set<string>();
  const activeCalls = new Set<Promise<void>>();
  let inflightCalls = 0;
  let completeReceived = false;
  let completed: CompleteFrame | undefined;
  let pendingComplete: CompleteFrame | undefined;
  let protocolError: ScheduleScriptExecutionError | undefined;
  let deferredCallFailure: StableCallError | undefined;
  let timedOut: boolean = false;
  let aborted: boolean = false;
  let childExited = false;
  let killStarted = false;
  let timer: NodeJS.Timeout | undefined;
  let forceExitTimer: NodeJS.Timeout | undefined;
  let postExitReject: ((error: ScheduleScriptExecutionError) => void) | undefined;

  let settleExit: (exit: ProcessExit) => void = () => undefined;
  const exitPromise = new Promise<ProcessExit>((resolve) => {
    let settled = false;
    settleExit = (exit): void => {
      if (settled) return;
      settled = true;
      childExited = true;
      resolve(exit);
    };
    child.once("error", (error) => settleExit({ code: null, spawnError: error.message }));
    child.once("close", (code) => settleExit({ code }));
  });

  const forceExitSettlement = (): void => {
    if (childExited || forceExitTimer !== undefined) return;
    forceExitTimer = setTimeout(
      () => settleExit({ code: null, spawnError: "Process did not exit after termination." }),
      FORCE_EXIT_TIMEOUT_MS
    );
  };

  const terminate = (): void => {
    if (childExited || killStarted) return;
    killStarted = true;
    stopProcessTree(child, forceExitSettlement);
  };

  const failProtocol = (message: string): void => {
    if (protocolError !== undefined) return;
    protocolError = new ScheduleScriptExecutionError("PROTOCOL_ERROR", message);
    terminate();
    postExitReject?.(protocolError);
  };

  const writeFrame = (
    frame: Readonly<Record<string, unknown>>
  ): "written" | "closed" | "invalid" => {
    let serialized: string;
    try {
      serialized = `${JSON.stringify({ protocol: SCRIPT_PROTOCOL, ...frame })}\n`;
    } catch {
      return "invalid";
    }
    if (Buffer.byteLength(serialized, "utf8") > FRAME_CAP_BYTES) return "invalid";
    if (child.stdin?.writable !== true) return "closed";
    try {
      child.stdin.write(serialized);
      return "written";
    } catch {
      return "closed";
    }
  };

  const writeCallError = (id: string, error: StableCallError): void => {
    writeFrame({ type: "call_result", id, ok: false, error });
  };

  const finalizeCompletion = (frame: CompleteFrame): void => {
    completed = frame;
    try {
      child.stdin?.end();
    } catch {
      // The exit status remains the authoritative process outcome.
    }
  };

  const handleCall = (frame: CallFrame): void => {
    if (completeReceived) {
      failProtocol("Schedule script sent a capability call after its complete frame.");
      return;
    }
    if (seenCallIds.has(frame.id)) {
      failProtocol("Schedule script reused a capability call id.");
      return;
    }
    seenCallIds.add(frame.id);
    if (inflightCalls >= MAX_INFLIGHT_CALLS) {
      writeCallError(frame.id, {
        code: "TOO_MANY_REQUESTS",
        message: "At most 16 capability calls may be in flight."
      });
      return;
    }

    inflightCalls += 1;
    let task!: Promise<void>;
    task = (async () => {
      try {
        const result = await input.broker.call(
          { id: frame.id, method: frame.method, params: frame.params },
          granted,
          { scheduleId: input.scheduleId, runId: input.runId }
        );
        if (writeFrame({ type: "call_result", id: frame.id, ok: true, result }) === "invalid") {
          const error = {
            code: "INVALID_RESULT",
            message: "The capability result could not be represented as a bounded JSON frame."
          } as const;
          writeCallError(frame.id, error);
          if (completeReceived && deferredCallFailure === undefined) deferredCallFailure = error;
        }
      } catch (error) {
        const stable = stableBrokerError(error);
        writeCallError(frame.id, stable);
        if (completeReceived && deferredCallFailure === undefined) deferredCallFailure = stable;
      } finally {
        inflightCalls -= 1;
        if (inflightCalls === 0 && pendingComplete !== undefined) {
          const frameToFinish = pendingComplete;
          pendingComplete = undefined;
          finalizeCompletion(frameToFinish);
        }
      }
    })();
    activeCalls.add(task);
    void task.finally(() => activeCalls.delete(task));
  };

  const handleComplete = (frame: CompleteFrame): void => {
    if (completeReceived) {
      failProtocol("Schedule script sent more than one complete frame.");
      return;
    }
    completeReceived = true;
    if (inflightCalls > 0) {
      pendingComplete = frame;
      return;
    }
    finalizeCompletion(frame);
  };

  const handleLine = (line: string): void => {
    if (protocolError !== undefined || line.trim() === "") return;
    if (Buffer.byteLength(line, "utf8") > FRAME_CAP_BYTES) {
      failProtocol("Schedule script emitted a protocol frame larger than 256 KiB.");
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      failProtocol("Schedule script stdout must contain valid UTF-8 JSONL protocol frames only.");
      return;
    }
    if (!isRecord(value) || value.protocol !== SCRIPT_PROTOCOL) {
      failProtocol(`Schedule script frames must use protocol ${SCRIPT_PROTOCOL}.`);
      return;
    }
    if (value.type === "call") {
      const call = parseCallFrame(value);
      if (call === undefined) {
        failProtocol("Schedule script emitted an invalid capability call frame.");
        return;
      }
      handleCall(call);
      return;
    }
    if (value.type === "complete") {
      const complete = parseCompleteFrame(value);
      if (complete === undefined) {
        failProtocol("Schedule script emitted an invalid complete frame.");
        return;
      }
      handleComplete(complete);
      return;
    }
    failProtocol("Schedule script emitted a frame with an unsupported type.");
  };

  const consumeStdout = (text: string): void => {
    stdoutBuffer += text;
    while (protocolError === undefined) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      handleLine(line);
    }
    if (protocolError === undefined && Buffer.byteLength(stdoutBuffer, "utf8") > FRAME_CAP_BYTES) {
      failProtocol("Schedule script emitted a protocol frame larger than 256 KiB.");
    }
  };

  const onStdout = (chunk: Buffer | string): void => {
    if (protocolError !== undefined) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    try {
      stdoutValidator.decode(bytes, { stream: true });
    } catch {
      failProtocol("Schedule script stdout contained invalid UTF-8.");
      return;
    }
    consumeStdout(stdoutDecoder.write(bytes));
  };
  const onStderr = (chunk: Buffer | string): void => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    stderrOutput.append(stderrDecoder.write(bytes));
  };
  child.stdout?.on("data", onStdout);
  child.stderr?.on("data", onStderr);

  const onAbort = (): void => {
    aborted = true;
    terminate();
    postExitReject?.(
      new ScheduleScriptExecutionError("ABORTED", "Schedule script execution was aborted.")
    );
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) onAbort();

  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      terminate();
      postExitReject?.(
        new ScheduleScriptExecutionError(
          "TIMED_OUT",
          `Schedule script execution timed out after ${timeoutMs}ms.`
        )
      );
    }, timeoutMs);
  }

  writeFrame({
    type: "start",
    context: {
      scheduleId: input.scheduleId,
      scheduleName: input.scheduleName,
      runId: input.runId,
      firedAt: input.firedAt,
      workingDir: input.cwd
    },
    capabilities: [...granted]
  });

  const exit = await exitPromise;
  try {
    if (protocolError === undefined) {
      try {
        stdoutValidator.decode();
      } catch {
        failProtocol("Schedule script stdout ended with invalid UTF-8.");
      }
    }
    if (protocolError === undefined) consumeStdout(stdoutDecoder.end());
    stderrOutput.append(stderrDecoder.end());
    if (protocolError === undefined && stdoutBuffer.trim() !== "") {
      const tail = stdoutBuffer;
      stdoutBuffer = "";
      handleLine(tail);
    }

    const callWaitError = await waitForActiveCalls(
      activeCalls,
      postExitCallTimeoutMs,
      (reject) => {
        postExitReject = reject;
      }
    );

    const stderr = sanitizedBoundedText(stderrOutput.text(), STDERR_CAP_BYTES);
    if (aborted || input.signal?.aborted) {
      throw new ScheduleScriptExecutionError("ABORTED", "Schedule script execution was aborted.");
    }
    if (protocolError !== undefined) throw protocolError;
    if (timedOut) {
      throw new ScheduleScriptExecutionError(
        "TIMED_OUT",
        `Schedule script execution timed out after ${timeoutMs ?? 0}ms.`
      );
    }
    if (exit.spawnError !== undefined) {
      throw new ScheduleScriptExecutionError(
        "SPAWN_FAILED",
        `Schedule script could not start: ${exit.spawnError}`,
        { exitCode: exit.code }
      );
    }
    if (exit.code !== 0) {
      const detail = stderr.text === "" ? "" : `: ${truncateUtf8(stderr.text, 1_000)}`;
      throw new ScheduleScriptExecutionError(
        "NONZERO_EXIT",
        `Schedule script exited with code ${exit.code ?? "unknown"}${detail}`,
        { exitCode: exit.code }
      );
    }
    if (callWaitError !== undefined) throw callWaitError;
    if (deferredCallFailure !== undefined) {
      throw new ScheduleScriptExecutionError(
        "HOST_CALL_FAILED_AFTER_COMPLETE",
        `A capability call failed after the script declared completion (${deferredCallFailure.code}): ${deferredCallFailure.message}`
      );
    }
    if (completed === undefined) {
      throw new ScheduleScriptExecutionError(
        "PROTOCOL_ERROR",
        `Schedule script exited without a ${SCRIPT_PROTOCOL} complete frame.`
      );
    }

    const resultText = completed.resultText === undefined
      ? undefined
      : truncateUtf8Marked(safeDiagnostic(completed.resultText, FRAME_CAP_BYTES), RESULT_CAP_BYTES);
    return {
      ...(resultText === undefined ? {} : { resultText }),
      ...(completed.primarySessionId === undefined
        ? {}
        : { primarySessionId: completed.primarySessionId }),
      durationMs: Math.max(0, Date.now() - startedAt),
      stderr: stderr.text,
      stderrTruncated: stderrOutput.truncated || stderr.truncated
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (forceExitTimer !== undefined) clearTimeout(forceExitTimer);
    input.signal?.removeEventListener("abort", onAbort);
    postExitReject = undefined;
    child.stdout?.removeListener("data", onStdout);
    child.stderr?.removeListener("data", onStderr);
    try {
      input.broker.finalizeActiveCalls?.(input.runId);
    } catch {
      // Finalization is cleanup only and must not replace the execution outcome.
    }
  }
}

async function waitForActiveCalls(
  activeCalls: ReadonlySet<Promise<void>>,
  timeoutMs: number,
  setExternalReject: (
    reject: (error: ScheduleScriptExecutionError) => void
  ) => void
): Promise<ScheduleScriptExecutionError | undefined> {
  if (activeCalls.size === 0) return undefined;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (error?: ScheduleScriptExecutionError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolve(error);
    };
    const guard = setTimeout(
      () => finish(new ScheduleScriptExecutionError(
        "HOST_CALL_TIMEOUT",
        `A capability call did not settle within ${timeoutMs}ms after the script exited.`
      )),
      timeoutMs
    );
    setExternalReject((error) => finish(error));
    Promise.all([...activeCalls]).then(
      () => finish(),
      () => finish()
    );
  });
}

function parseCallFrame(value: Readonly<Record<string, unknown>>): CallFrame | undefined {
  if (!boundedWireString(value.id, 256) || !boundedWireString(value.method, 256)) return undefined;
  if (value.params !== undefined && !isRecord(value.params)) return undefined;
  return {
    type: "call",
    id: value.id,
    method: value.method,
    params: value.params ?? {}
  };
}

function parseCompleteFrame(value: Readonly<Record<string, unknown>>): CompleteFrame | undefined {
  if (value.resultText !== undefined && typeof value.resultText !== "string") return undefined;
  if (
    value.primarySessionId !== undefined
    && value.primarySessionId !== null
    && !boundedOptionalWireString(value.primarySessionId, 512)
  ) {
    return undefined;
  }
  const primarySessionId = typeof value.primarySessionId === "string" && value.primarySessionId !== ""
    ? value.primarySessionId
    : undefined;
  return {
    type: "complete",
    ...(value.resultText === undefined ? {} : { resultText: value.resultText }),
    ...(primarySessionId === undefined ? {} : { primarySessionId })
  };
}

function validateInput(input: ExecuteScheduleScriptInput): void {
  if (!boundedInputString(input.command, 32_768)) invalidInput("command");
  if (!boundedInputString(input.cwd, 32_768)) invalidInput("working directory");
  if (!boundedInputString(input.scheduleId, 512)) invalidInput("schedule id");
  if (!boundedInputString(input.scheduleName, 4_096)) invalidInput("schedule name");
  if (!boundedInputString(input.runId, 512)) invalidInput("run id");
  if (!Number.isFinite(input.firedAt)) invalidInput("fire timestamp");
  if (!Array.isArray(input.capabilities)) invalidInput("capability list");
  for (const capability of input.capabilities) {
    if (capability !== "sessions.dispatch") invalidInput("capability list");
  }
  if (input.broker === null || typeof input.broker !== "object" || typeof input.broker.call !== "function") {
    invalidInput("capability broker");
  }
}

function invalidInput(field: string): never {
  throw new ScheduleScriptExecutionError(
    "INVALID_INPUT",
    `Schedule script ${field} is invalid.`
  );
}

function boundedInputString(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string"
    && value.trim() !== ""
    && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= maximumBytes;
}

function boundedWireString(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && Buffer.byteLength(value, "utf8") <= maximumBytes;
}

function boundedOptionalWireString(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string"
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && Buffer.byteLength(value, "utf8") <= maximumBytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.max(1, Math.floor(value));
}

function stableBrokerError(error: unknown): StableCallError {
  const value = isRecord(error) ? error : undefined;
  const candidateCode = typeof value?.errorCode === "string"
    ? value.errorCode
    : typeof value?.code === "string"
      ? value.code
      : "INTERNAL";
  const code = SAFE_CODE.test(candidateCode) ? candidateCode : "INTERNAL";
  const message = error instanceof Error
    ? error.message
    : typeof value?.message === "string"
      ? value.message
      : "Capability call failed.";
  return { code, message: safeDiagnostic(message, 512) || "Capability call failed." };
}

function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown process error.";
}

function safeDiagnostic(value: string, maximumBytes: number): string {
  const redacted = redactSecrets(value)
    .replace(
      /\b(api[_-]?key|(?:access|api|refresh|session)?[_-]?token|authorization|cookie|credentials?|password|passwd|private[_-]?key|(?:client[_-]?)?secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "$1=[REDACTED]"
    )
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[REDACTED]@");
  return truncateUtf8(redacted, maximumBytes);
}

function sanitizedBoundedText(
  value: string,
  maximumBytes: number
): { readonly text: string; readonly truncated: boolean } {
  const sanitized = safeDiagnostic(value, Number.MAX_SAFE_INTEGER);
  const truncated = Buffer.byteLength(sanitized, "utf8") > maximumBytes;
  return { text: truncateUtf8(sanitized, maximumBytes), truncated };
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) return value;
  let end = Math.max(0, Math.min(maximumBytes, bytes.byteLength));
  while (end > 0 && end < bytes.byteLength && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function truncateUtf8Marked(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const marker = "\n...[truncated]";
  return `${truncateUtf8(value, maximumBytes - Buffer.byteLength(marker, "utf8"))}${marker}`;
}

function stopProcessTree(child: ChildProcess, complete: () => void): void {
  const pid = child.pid;
  const stopDirect = (): void => {
    try {
      child.kill("SIGKILL");
    } catch {
      // A concurrently exiting process needs no further action.
    }
  };
  if (pid === undefined) {
    stopDirect();
    complete();
    return;
  }
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      stopDirect();
    }
    complete();
    return;
  }

  let killer: ChildProcess;
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    clearTimeout(guard);
    complete();
  };
  const guard = setTimeout(() => {
    stopDirect();
    finish();
  }, KILLER_TIMEOUT_MS);
  try {
    killer = spawn("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
      env: buildScheduleScriptEnvironment(process.env)
    });
  } catch {
    stopDirect();
    finish();
    return;
  }
  killer.once("error", () => {
    stopDirect();
    finish();
  });
  killer.once("close", (code) => {
    if (code !== 0) stopDirect();
    finish();
  });
  killer.unref();
}

class BoundedText {
  readonly #maximumBytes: number;
  readonly #chunks: string[] = [];
  #byteLength = 0;
  truncated = false;

  constructor(maximumBytes: number) {
    this.#maximumBytes = maximumBytes;
  }

  append(value: string): void {
    if (value === "") return;
    const remaining = this.#maximumBytes - this.#byteLength;
    if (remaining <= 0) {
      this.truncated = true;
      return;
    }
    const byteLength = Buffer.byteLength(value, "utf8");
    if (byteLength <= remaining) {
      this.#chunks.push(value);
      this.#byteLength += byteLength;
      return;
    }
    const prefix = truncateUtf8(value, remaining);
    this.#chunks.push(prefix);
    this.#byteLength += Buffer.byteLength(prefix, "utf8");
    this.truncated = true;
  }

  text(): string {
    return this.#chunks.join("");
  }
}
