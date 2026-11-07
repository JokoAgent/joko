import type { CommandConcurrencyGate } from "@joko/runtime-governance";

export const COMMAND_GATE_REQUEST_PREFIX = "joko:command-gate/v1/";

export type CommandGateExtensionResponse =
  | { readonly type: "extension_ui_response"; readonly id: string; readonly value: string }
  | { readonly type: "extension_ui_response"; readonly id: string; readonly cancelled: true };

export interface CommandGateExtensionTransport {
  readonly closed: boolean;
  notify(message: CommandGateExtensionResponse): Promise<void>;
}

export function readCommandGateExtensionRequest(event: Readonly<Record<string, unknown>>): {
  readonly id: string;
  readonly command: ReturnType<typeof parseRequest>;
} | undefined {
  if (event["method"] !== "input" || typeof event["title"] !== "string"
      || !event["title"].startsWith(COMMAND_GATE_REQUEST_PREFIX)) return undefined;
  return { id: typeof event["id"] === "string" ? event["id"] : "", command: parseRequest(event["title"]) };
}

export async function handleCommandGateExtensionRequest(
  event: Readonly<Record<string, unknown>>,
  options: {
    readonly gate?: CommandConcurrencyGate;
    readonly sessionId: string;
    readonly generation: number;
    readonly runId?: string;
    readonly signal?: AbortSignal;
    readonly transport: CommandGateExtensionTransport;
    readonly isCurrent: () => boolean;
    readonly onAdmitted?: (releaseBeforeDispatch: () => void) => void;
  }
): Promise<boolean> {
  const request = readCommandGateExtensionRequest(event);
  if (request === undefined) return false;
  const { id: requestId, command } = request;
  if (requestId === "" || command === undefined || !options.isCurrent() || options.transport.closed) {
    await respond(options, requestId, { cancelled: true });
    return true;
  }
  // Native tool call IDs cannot contain NUL, so a parent tool cannot alias a
  // delegated run's lease even if its provider uses predictable IDs.
  const scope = options.runId === undefined ? "" : `\u0000${options.runId}:`;
  const commandId = `${options.sessionId}:${options.generation}:${scope}${command.toolCallId}`;
  if (command.action === "release") {
    options.gate?.release(commandId, "tool_terminal");
    await respond(options, requestId, { value: "released" });
    return true;
  }
  const admission = options.signal?.aborted ? "aborted" : await options.gate?.acquire({
    commandId,
    sessionId: options.sessionId,
    ...(options.signal === undefined ? {} : { signal: options.signal })
  }) ?? "immediate";
  const releaseBeforeDispatch = () => options.gate?.release(commandId, "approval_retired_before_dispatch");
  if (admission === "aborted" || options.signal?.aborted || !options.isCurrent() || options.transport.closed) {
    if (admission !== "aborted") releaseBeforeDispatch();
    await respond(options, requestId, { cancelled: true });
    return true;
  }
  options.onAdmitted?.(releaseBeforeDispatch);
  await options.transport.notify({ type: "extension_ui_response", id: requestId, value: "admitted" });
  return true;
}

function parseRequest(value: string): { readonly action: "acquire" | "release"; readonly toolCallId: string } | undefined {
  const match = /^joko:command-gate\/v1\/(acquire|release)\/([A-Za-z0-9_-]{1,684})$/u.exec(value);
  if (match === null) return undefined;
  let toolCallId: string;
  try {
    const bytes = Buffer.from(match[2]!, "base64url");
    toolCallId = bytes.toString("utf8");
    if (bytes.toString("base64url") !== match[2] || Buffer.from(toolCallId, "utf8").compare(bytes) !== 0) return undefined;
  }
  catch { return undefined; }
  if (toolCallId.length < 1 || toolCallId.length > 512 || /[\u0000-\u001f\u007f]/u.test(toolCallId)) return undefined;
  return { action: match[1] as "acquire" | "release", toolCallId };
}

async function respond(
  options: {
    readonly transport: CommandGateExtensionTransport;
    readonly isCurrent: () => boolean;
  },
  requestId: string,
  result: { readonly value: string } | { readonly cancelled: true }
): Promise<void> {
  if (requestId === "" || !options.isCurrent() || options.transport.closed) return;
  await options.transport.notify({ type: "extension_ui_response", id: requestId, ...result });
}
