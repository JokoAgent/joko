import { join } from "node:path";
import { createHash } from "node:crypto";
import type { AdapterContext, BlobRef, NativeSessionBinding, PromptInput } from "@joko/core";
import type { HostedAgentSourceController } from "@joko/adapter-hosted";
import type { CommandConcurrencyGate } from "@joko/runtime-governance";
import { HostedAgentController, type HostedAgentOperationOwner } from "./hosted-agent-controller.js";
import { HostedAgentExecutor, type HostedAgentExecutorPolicy } from "./hosted-agent-executor.js";
import type { HostedAgentPoller } from "./hosted-agent-poller.js";
import { HostedAgentCodexExecServerRelay } from "./hosted-agent-codex-relay.js";
import { HostedAgentClaudeExecutor } from "./hosted-agent-claude-executor.js";
import { createHostedAgentClaudeWebFetch, type HostedAgentClaudeWebFetchOptions } from "./hosted-agent-claude-web-network.js";
import { readHostedAgentClaudePdf } from "./hosted-agent-claude-pdf.js";
import { terminalEnvironment } from "@joko/tool-terminal";

/** Service-owned tool and Artifact ports behind the transport-only Adapter.
 * Each native occurrence retains the exact original SessionHost callbacks. */
export function createHostedAgentSourceController(options: {
  readonly poller: HostedAgentPoller; readonly runId: string; readonly shadow: string; readonly context: AdapterContext;
  readonly binding: () => NativeSessionBinding; readonly temporaryRoot: string;
  readonly readPolicy: (context: AdapterContext) => HostedAgentExecutorPolicy;
  readonly assertContext: (context: AdapterContext) => void; readonly assertCurrent: () => void;
  readonly onGroupSwitch?: (offer: string) => void;
  readonly commandConcurrencyGate?: CommandConcurrencyGate;
  readonly codexExecutable?: string;
  readonly readBlob?: (blob: BlobRef, context: AdapterContext) => Promise<Uint8Array>;
  readonly resolveProxy?: HostedAgentClaudeWebFetchOptions["resolveProxy"];
  readonly environmentProxyForTarget?: HostedAgentClaudeWebFetchOptions["environmentProxyForTarget"];
}): HostedAgentSourceController {
  const owners = new Map<string, HostedAgentOperationOwner>(), port = options.poller.attach(options.runId);
  const executor = (context: AdapterContext) => new HostedAgentExecutor({ context, virtualRoot: options.shadow,
    readPolicy: () => options.readPolicy(context), assertCurrent: () => { options.assertContext(context); options.assertCurrent(); },
    ...(options.commandConcurrencyGate === undefined ? {} : { commandConcurrencyGate: options.commandConcurrencyGate }) });
  const initialExecutor = executor(options.context);
  const lifetime = new AbortController();
  const claudeExecutor = new HostedAgentClaudeExecutor({ workspaceRoot: options.shadow, signal: lifetime.signal,
    assertCurrent: () => { options.assertContext(options.context); options.assertCurrent(); } });
  let nativeRelay: HostedAgentCodexExecServerRelay | undefined;
  const executeTool = (ownerExecutor: HostedAgentExecutor, context: AdapterContext, prompt?: PromptInput) => {
    const images = prompt?.images.map(image => ({ ...image.blob })) ?? [], pending = new Map<string, Uint8Array>();
    const webFetch = createHostedAgentClaudeWebFetch({ context, readPolicy: () => options.readPolicy(context),
      assertCurrent: () => { options.assertContext(context); options.assertCurrent(); },
      ...(options.resolveProxy === undefined ? {} : { resolveProxy: options.resolveProxy }),
      ...(options.environmentProxyForTarget === undefined ? {} : { environmentProxyForTarget: options.environmentProxyForTarget }) });
    const claudeAuthorization = { execute: (value: unknown, active?: AbortSignal, effects?: Parameters<HostedAgentExecutor["execute"]>[2]) => ownerExecutor.execute(value, active, effects), webFetch,
      readPdf: async (bytes: Buffer, pages: string | undefined, signal: AbortSignal) => {
        ownerExecutor.assertCurrent(signal); const result = await readHostedAgentClaudePdf(bytes, pages, signal); ownerExecutor.assertCurrent(signal); return result;
      } };
    return async (input: unknown, signal: AbortSignal): Promise<Record<string, unknown>> => {
    if ((input as { operation?: unknown } | null)?.operation === "input.blob") {
      const request = input as { blob?: BlobRef; offset?: number; maximum?: number }, blob = request.blob;
      const expected = blob && images.find(candidate => candidate.id === blob.id && candidate.sha256 === blob.sha256 && candidate.byteLength === blob.byteLength && candidate.mimeType === blob.mimeType);
      if (!options.readBlob || !expected || !Number.isSafeInteger(request.offset) || request.offset! < 0 || !Number.isSafeInteger(request.maximum)
        || request.maximum! < 1 || request.maximum! > 1024 * 1024 || request.offset! >= expected.byteLength) throw new Error("The input image belongs to another Source dispatch.");
      ownerExecutor.assertCurrent(signal);
      let bytes = pending.get(expected.id);
      if (!bytes) {
        bytes = await options.readBlob(expected, context); ownerExecutor.assertCurrent(signal);
        if (bytes.byteLength !== expected.byteLength || createHash("sha256").update(bytes).digest("hex") !== expected.sha256) throw new Error("The Source input image failed integrity validation.");
        if ([...pending.values()].reduce((size, value) => size + value.byteLength, 0) + bytes.byteLength > 64 * 1024 * 1024) throw new Error("The native input image capacity is exhausted.");
        pending.set(expected.id, bytes);
      }
      const end = Math.min(bytes.byteLength, request.offset! + request.maximum!);
      const data = Buffer.from(bytes.subarray(request.offset!, end)).toString("base64");
      if (end === bytes.byteLength) pending.delete(expected.id);
      return { data };
    }
    if ((input as { operation?: unknown } | null)?.operation === "codex.exec_server") {
      if (!options.codexExecutable) throw new Error("The Source native execution runtime is unavailable.");
      const authorization = { assertCurrent: () => ownerExecutor.assertCurrent(signal),
        authorize: (actions: Parameters<HostedAgentExecutor["authorizeNativeActions"]>[0], active: AbortSignal) => ownerExecutor.authorizeNativeActions(actions, active) };
      nativeRelay ??= new HostedAgentCodexExecServerRelay({ codexExecutable: options.codexExecutable,
        cwd: options.context.target.workspaceRoot, workspace: initialExecutor.workspace, sessionId: options.context.sessionId, env: terminalEnvironment(),
        assertCurrent: () => { options.assertContext(options.context); options.assertCurrent(); },
        authorize: (actions, active) => initialExecutor.authorizeNativeActions(actions, active),
        ...(options.commandConcurrencyGate === undefined ? {} : { commandConcurrencyGate: options.commandConcurrencyGate }) });
      return nativeRelay.execute(input, signal, authorization);
    }
    return await claudeExecutor.execute(input, signal, claudeAuthorization) ?? ownerExecutor.execute(input, signal);
    };
  };
  const controller = new HostedAgentController({ port, context: options.context, executor: initialExecutor, binding: options.binding,
    ...(options.onGroupSwitch === undefined ? {} : { onGroupSwitch: options.onGroupSwitch }),
    temporaryRoot: join(options.temporaryRoot, options.runId), assertCurrent: options.assertCurrent, resolveOperation: id => {
      const owner = owners.get(id); if (!owner) throw new Error("The original native dispatch is unavailable."); return owner;
    } });
  return {
    registerOperation: (id, context, fence, input) => {
      options.assertContext(context); options.assertCurrent();
      if (!id || id.length > 512 || /[\0\r\n]/u.test(id) || context.sessionId !== options.context.sessionId || context.generation !== options.context.generation
        || context.target.id !== options.context.target.id || context.target.workspaceRoot !== options.context.target.workspaceRoot) throw new Error("The native operation belongs to another Source task.");
      if (owners.has(id)) return;
      if (owners.size >= 65_536) throw new Error("The original native operation capacity is unavailable.");
      const sourceExecutor = id === options.runId ? initialExecutor : executor(context);
      owners.set(id, { context, executor: sourceExecutor, executeTool: executeTool(sourceExecutor, context, input), ...(fence === undefined ? {} : {
        persistFence: async (operationId, preparation) => {
          if (operationId !== id) throw new Error("The native dispatch confirmation belongs to another operation.");
          options.assertContext(context); options.assertCurrent(); await fence(preparation); options.assertContext(context); options.assertCurrent();
        }
      }) });
    },
    start: () => controller.start(), abortPending: () => controller.abortPending(),
    projectResult: value => controller.projectResult(value), projectState: state => controller.projectState(state), projectHistory: history => controller.projectHistory(history),
    stop: async () => { lifetime.abort(); await claudeExecutor.dispose(); await controller.stop(); await nativeRelay?.close(); port.detach(); initialExecutor.dispose(); for (const owner of owners.values()) owner.executor.dispose(); owners.clear(); }
  };
}
