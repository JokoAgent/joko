import { redactSecrets, type SessionDescriptor } from "@joko/core";
import { isRemoteSshError, type RemoteSshExecutionResult } from "@joko/remote-ssh";
import { NotFoundError, type OperationalStore, type RemoteHostRecord } from "@joko/store";

import type {
  BridgeToolCallContext,
  BridgeToolPolicyDeclaration,
  BridgeToolProvider,
  McpCallResult,
  McpToolDescriptor
} from "./mcp-router.js";
import type { RemoteHostRegistry } from "./remote-host-registry.js";

export const REMOTE_HOST_TOOL_PROVIDER_ID = "joko-remote-host-tools";
export const REMOTE_HOST_TOOL_POLICY: BridgeToolPolicyDeclaration = Object.freeze({
  id: "joko-remote-host-policy",
  displayName: "Remote Host",
  description: "Inspect and run approved commands on configured remote hosts.",
  productDefaultEnabled: true,
  localizations: {
    "zh-CN": {
      displayName: "远程主机",
      description: "检查已配置的远程主机，并运行经过批准的命令。"
    }
  }
});

const OUTPUT_CHARACTER_LIMIT = 32_000;
const OUTPUT_TAIL_CHARACTERS = 8_000;
const COMMAND_BYTE_LIMIT = 256 * 1_024;
const INPUT_BYTE_LIMIT = 1_024 * 1_024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAXIMUM_TIMEOUT_MS = 600_000;

const HOST_PROPERTY = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 1_024,
  description: "Configured Remote Host alias or exact hostname."
});

const READ_TOOLS: readonly McpToolDescriptor[] = Object.freeze([
  tool(
    "remote_host_list_hosts",
    "List configured Remote Hosts in this authenticated task's exact target scope.",
    objectSchema({}),
    false
  ),
  tool(
    "remote_host_status",
    "Read one configured Remote Host connection and trust status by alias or exact hostname.",
    objectSchema({ host: HOST_PROPERTY }, ["host"]),
    false
  )
]);

const EXECUTION_TOOL: McpToolDescriptor = Object.freeze(tool(
  "remote_host_execute",
  "Execute one bounded command on a configured Remote Host. The authenticated connector, trust pin, timeout, output cap, and permission decision are service-owned.",
  objectSchema({
    host: HOST_PROPERTY,
    command: {
      type: "string",
      minLength: 1,
      maxLength: COMMAND_BYTE_LIMIT,
      description: "Remote command. It is never copied into events, diagnostics, logs, or errors."
    },
    cwd: {
      type: "string",
      minLength: 1,
      maxLength: 4_096,
      pattern: "^/",
      description: "Optional absolute remote working directory."
    },
    timeoutMs: {
      type: "integer",
      minimum: 1,
      maximum: MAXIMUM_TIMEOUT_MS,
      default: DEFAULT_TIMEOUT_MS
    },
    input: {
      type: "string",
      maxLength: INPUT_BYTE_LIMIT,
      description: "Optional bounded stdin. It is never persisted or logged."
    }
  }, ["host", "command"]),
  true
));

export interface RemoteHostToolProviderOptions {
  readonly store: OperationalStore;
  readonly registry: RemoteHostRegistry;
  readonly outputRedactor?: RemoteHostOutputRedactorPort;
}

export interface RemoteHostOutputRedactorPort {
  /** Redacts service-known credential values without exposing them to the tool result. */
  redactText(text: string): string;
}

/**
 * Direct Pi tools for the authenticated target's Remote Host catalog. The
 * execution descriptor is sampled only when the injected connector declares
 * that capability; read-only tools remain available independently.
 */
export class RemoteHostToolBridgeProvider implements BridgeToolProvider {
  readonly id = REMOTE_HOST_TOOL_PROVIDER_ID;
  readonly generation = 1;
  readonly available = true;
  readonly configurablePolicy = REMOTE_HOST_TOOL_POLICY;
  readonly #store: OperationalStore;
  readonly #registry: RemoteHostRegistry;
  readonly #outputRedactor: RemoteHostOutputRedactorPort | undefined;

  constructor(options: RemoteHostToolProviderOptions) {
    this.#store = options.store;
    this.#registry = options.registry;
    this.#outputRedactor = options.outputRedactor;
  }

  get tools(): readonly McpToolDescriptor[] {
    return this.#registry.capabilities().commandExecution
      ? Object.freeze([...READ_TOOLS, EXECUTION_TOOL])
      : READ_TOOLS;
  }

  includeForTarget(targetId: string): boolean {
    try {
      return this.#store.getTarget(targetId).descriptor.trusted;
    } catch {
      return false;
    }
  }

  async callTool(
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    context: BridgeToolCallContext
  ): Promise<McpCallResult> {
    signal?.throwIfAborted();
    try {
      this.#requireCaller(context);
      if (name === "remote_host_list_hosts") {
        requireOnlyKeys(arguments_, []);
        return success({ hosts: this.#registry.list(context.targetId).map(publicHost) });
      }
      if (name === "remote_host_status") {
        requireOnlyKeys(arguments_, ["host"]);
        return success({ host: publicHost(resolveHost(this.#registry, context.targetId, requiredHost(arguments_))) });
      }
      if (name === "remote_host_execute") {
        if (!this.#registry.capabilities().commandExecution) {
          throw new RemoteHostToolError(
            "EXECUTION_UNAVAILABLE",
            "Remote Host command execution is unavailable."
          );
        }
        requireOnlyKeys(arguments_, ["host", "command", "cwd", "timeoutMs", "input"]);
        const host = resolveHost(this.#registry, context.targetId, requiredHost(arguments_));
        const command = requiredText(arguments_["command"], "command", COMMAND_BYTE_LIMIT);
        const cwd = optionalText(arguments_["cwd"], "cwd", 4_096);
        if (cwd !== undefined && !cwd.startsWith("/")) {
          throw new RemoteHostToolError("INVALID_ARGUMENT", "cwd must be an absolute remote path.");
        }
        const input = optionalText(arguments_["input"], "input", INPUT_BYTE_LIMIT, true);
        const timeoutMs = optionalInteger(arguments_["timeoutMs"], "timeoutMs", 1, MAXIMUM_TIMEOUT_MS)
          ?? DEFAULT_TIMEOUT_MS;
        const outcome = await this.#registry.execute(context.targetId, host.id, {
          command,
          ...(cwd === undefined ? {} : { cwd }),
          ...(input === undefined ? {} : { input }),
          timeoutMs,
          ...(signal === undefined ? {} : { signal })
        });
        signal?.throwIfAborted();
        return success(publicExecution(outcome.host.id, outcome.result, this.#outputRedactor));
      }
      throw new RemoteHostToolError("UNKNOWN_TOOL", "Remote Host tool is not part of this runtime snapshot.");
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw error;
      return failure(error);
    }
  }

  #requireCaller(context: BridgeToolCallContext): SessionDescriptor {
    const session = this.#store.getSession(context.sessionId).descriptor;
    const target = this.#store.getTarget(context.targetId).descriptor;
    if (!target.trusted) {
      throw new RemoteHostToolError("PERMISSION_DENIED", "Remote Host tools require a trusted target.");
    }
    if (
      session.targetId !== context.targetId ||
      session.backendId !== target.backendId ||
      session.binding.generation !== context.generation ||
      session.deletedAt !== undefined ||
      session.archived
    ) {
      throw new RemoteHostToolError("STALE_SCOPE", "Remote Host tool scope is stale or unavailable.");
    }
    return session;
  }
}

function resolveHost(registry: RemoteHostRegistry, targetId: string, value: string): RemoteHostRecord {
  const hosts = registry.list(targetId);
  const alias = hosts.find((host) => host.id === value);
  if (alias !== undefined) return alias;
  const endpoints = hosts.filter((host) => host.hostname === value);
  if (endpoints.length === 1) return endpoints[0]!;
  if (endpoints.length > 1) {
    throw new RemoteHostToolError(
      "AMBIGUOUS_HOST",
      "The hostname matches multiple configured Remote Hosts; use one exact alias."
    );
  }
  throw new RemoteHostToolError("HOST_NOT_FOUND", "Remote Host is not configured for this target.");
}

function publicHost(host: RemoteHostRecord): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: host.id,
    hostname: host.hostname,
    port: host.port,
    user: host.user,
    source: host.source,
    credentialConfigured: host.credentialReferenceId !== undefined,
    status: host.status.state,
    changedAt: host.status.changedAt,
    ...(host.status.failure === undefined ? {} : { failure: host.status.failure }),
    ...(host.trust === undefined
      ? {}
      : {
          trust: {
            algorithm: host.trust.algorithm,
            sha256Fingerprint: host.trust.fingerprint,
            pinnedAt: host.trust.pinnedAt
          }
        })
  });
}

function publicExecution(
  hostId: string,
  result: RemoteSshExecutionResult,
  redactor: RemoteHostOutputRedactorPort | undefined
): Readonly<Record<string, unknown>> {
  const stdout = boundedRedactedOutput(result.stdout, redactor);
  const stderr = boundedRedactedOutput(result.stderr, redactor);
  return Object.freeze({
    host: hostId,
    exitCode: result.exitCode,
    ...(result.signal === undefined ? {} : { signal: result.signal }),
    stdout: stdout.text,
    stderr: stderr.text,
    outputCapped: result.outputCapped,
    ...(stdout.truncated ? { stdoutTruncated: true } : {}),
    ...(stderr.truncated ? { stderrTruncated: true } : {})
  });
}

function boundedRedactedOutput(
  value: string,
  redactor: RemoteHostOutputRedactorPort | undefined
): { readonly text: string; readonly truncated: boolean } {
  // Dynamic credential values are removed first, then the common structural
  // patterns are removed, and only that safe projection is size-bounded.
  const safe = redactSecrets(redactor?.redactText(value) ?? value);
  if (safe.length <= OUTPUT_CHARACTER_LIMIT) return { text: safe, truncated: false };
  const markerBudget = 64;
  const head = OUTPUT_CHARACTER_LIMIT - OUTPUT_TAIL_CHARACTERS - markerBudget;
  const dropped = safe.length - head - OUTPUT_TAIL_CHARACTERS;
  return {
    text: safe.slice(0, head) + `\n...[truncated ${dropped} chars]...\n` +
      safe.slice(safe.length - OUTPUT_TAIL_CHARACTERS),
    truncated: true
  };
}

function requiredHost(value: Readonly<Record<string, unknown>>): string {
  return requiredText(value["host"], "host", 1_024);
}

function requiredText(value: unknown, field: string, maximumBytes: number): string {
  if (
    typeof value !== "string" || value.length === 0 || value.includes("\u0000") ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) throw new RemoteHostToolError("INVALID_ARGUMENT", `${field} is invalid.`);
  return value;
}

function optionalText(
  value: unknown,
  field: string,
  maximumBytes: number,
  allowEmpty = false
): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" || (!allowEmpty && value.length === 0) || value.includes("\u0000") ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) throw new RemoteHostToolError("INVALID_ARGUMENT", `${field} is invalid.`);
  return value;
}

function optionalInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new RemoteHostToolError("INVALID_ARGUMENT", `${field} is invalid.`);
  }
  return value as number;
}

function requireOnlyKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) {
    throw new RemoteHostToolError("INVALID_ARGUMENT", "Remote Host tool arguments contain unknown fields.");
  }
}

function tool(
  name: string,
  description: string,
  inputSchema: Readonly<Record<string, unknown>>,
  requiresPermission: boolean
): McpToolDescriptor {
  return {
    serverId: REMOTE_HOST_TOOL_PROVIDER_ID,
    name,
    runtimeName: name,
    description,
    inputSchema,
    requiresPermission
  };
}

function objectSchema(
  properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  required: readonly string[] = []
): Readonly<Record<string, unknown>> {
  return { type: "object", properties, required, additionalProperties: false };
}

function success(data: unknown): McpCallResult {
  const envelope = { ok: true, data };
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope,
    isError: false
  };
}

function failure(error: unknown): McpCallResult {
  const classified = classifyError(error);
  const envelope = { ok: false, errorCode: classified.code, message: classified.message };
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope,
    isError: true
  };
}

function classifyError(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof RemoteHostToolError) return { code: error.code, message: error.message };
  if (error instanceof NotFoundError) return { code: "NOT_FOUND", message: "Remote Host scope is unavailable." };
  if (isRemoteSshError(error)) {
    switch (error.code) {
      case "ABORTED": return { code: "ABORTED", message: "Remote Host command was cancelled." };
      case "AUTHENTICATION_FAILED": return {
        code: "AUTHENTICATION_FAILED",
        message: "Remote Host authentication failed; retrying without configuration changes will not help."
      };
      case "EXECUTION_TIMEOUT": return { code: "EXECUTION_TIMEOUT", message: "Remote Host command timed out." };
      case "EXECUTION_UNAVAILABLE": return {
        code: "EXECUTION_UNAVAILABLE",
        message: "Remote Host command execution is unavailable."
      };
      case "HOST_KEY_CHANGED": return {
        code: "HOST_KEY_CHANGED",
        message: "Remote Host identity changed and the command was refused."
      };
      case "HOST_KEY_CONFLICT":
      case "HOST_KEY_INVALID":
      case "HOST_KEY_MISSING":
      case "HOST_KEY_STORE_CORRUPT":
      case "HOST_KEY_STORE_MISSING":
      case "HOST_KEY_STORE_UNREADABLE":
      case "HOST_KEY_STORE_WRITE_FAILED": return {
        code: "HOST_KEY_UNTRUSTED",
        message: "Remote Host identity could not be established safely."
      };
      case "INVALID_ARGUMENT": return { code: "INVALID_ARGUMENT", message: "Remote Host command input is invalid." };
      default: return { code: "REMOTE_FAILURE", message: "Remote Host command failed safely." };
    }
  }
  return { code: "INTERNAL", message: "Remote Host tool failed safely." };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

class RemoteHostToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RemoteHostToolError";
  }
}
