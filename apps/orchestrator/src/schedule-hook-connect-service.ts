import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { create, fromJsonString, toJsonString, type DescMessage, type MessageShape } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { redactSecrets } from "@joko/core";
import type { ConnectionRecord, OperationalStore } from "@joko/store";
import { toProtoDuration, toProtoOperation } from "./proto-mapper.js";
import type { SessionHost } from "./session-host.js";
import { ScheduleHookScriptInstaller, validateScheduleHookScriptBinding } from "./schedule-hook-script-installer.js";
import { executeSchedulePreRunHook, type SchedulePreRunHookResult } from "./schedule-pre-run-hook.js";

type Methods = Pick<ServiceImpl<typeof contract.SchedulerService>, "prepareScheduleHook" | "testScheduleHook" | "getScheduleHookOperation">;

/** GUI draft preparation shares installation and execution with scheduled gates. */
export function createScheduleHookConnectMethods(options: {
  readonly store: OperationalStore;
  readonly installer?: ScheduleHookScriptInstaller;
  readonly sessionHost: SessionHost;
  readonly authenticate: (context: HandlerContext) => ConnectionRecord;
}): Methods {
  const scope = (input: contract.ScheduleHookContext | undefined, context: HandlerContext) => {
    options.authenticate(context);
    if (!input) throw new ConnectError("Schedule hook context is required.", Code.InvalidArgument);
    const target = options.store.getTarget(input.targetId);
    if (!target.descriptor.trusted || target.descriptor.remoteWorkspace || target.descriptor.backendId !== input.backendId) {
      throw new ConnectError("Pre-run checks require this node's trusted Schedule workspace.", Code.FailedPrecondition);
    }
    const session = input.sessionId ? options.store.getSession(input.sessionId) : undefined;
    if (session && (session.descriptor.targetId !== input.targetId || session.descriptor.backendId !== input.backendId
      || session.descriptor.deletedAt !== undefined || session.descriptor.archived)) throw new ConnectError("Bound task changed.", Code.FailedPrecondition);
    const schedule = input.scheduleId ? options.store.getSchedule(input.scheduleId) : undefined;
    if (schedule && (schedule.targetId !== input.targetId || schedule.backendId !== input.backendId)) throw new ConnectError("Schedule workspace changed.", Code.FailedPrecondition);
    const assertCurrent = () => {
      context.signal.throwIfAborted(); options.authenticate(context);
      const current = options.store.getTarget(input.targetId);
      if (current.revision !== target.revision || !current.descriptor.trusted
        || current.descriptor.workspaceRoot !== target.descriptor.workspaceRoot) throw new ConnectError("Schedule workspace changed.", Code.Aborted);
      if (session && options.store.getSession(input.sessionId).revision !== session.revision) throw new ConnectError("Bound task changed.", Code.Aborted);
      if (schedule && options.store.getSchedule(input.scheduleId).revision !== schedule.revision) throw new ConnectError("Schedule changed.", Code.Aborted);
    };
    assertCurrent();
    return { input, target: target.descriptor, session: session?.descriptor, assertCurrent };
  };
  const invoke = async <T>(action: () => Promise<T>): Promise<T> => {
    try { return await action(); } catch (error) {
      if (error instanceof ConnectError) throw error;
      throw new ConnectError(redactSecrets(error instanceof Error ? error.message : "Pre-run check is unavailable."), Code.FailedPrecondition);
    }
  };
  const effect = async <D extends DescMessage>(id: string, kind: "prepareScheduleHook" | "testScheduleHook", body: string,
    schema: D, context: HandlerContext, assertCurrent: () => void, action: () => Promise<MessageShape<D>>): Promise<MessageShape<D>> => {
    if (!/^[A-Za-z0-9_-]{8,128}$/u.test(id)) throw new ConnectError("A valid operation ID is required.", Code.InvalidArgument);
    safeText(body, 512 * 1024);
    const connection = options.authenticate(context);
    let response: MessageShape<D> | undefined;
    const execution = await options.sessionHost.mutate({ operationId: id, connection, kind, body: { request: body },
      precondition: assertCurrent,
      effect: async () => { assertCurrent(); response = await action(); assertCurrent(); },
      commit: () => ({ responseJson: toJsonString(schema, response!) }) });
    return fromJsonString(schema, execution.value.responseJson);
  };
  return {
    prepareScheduleHook: (request, context) => invoke(async () => {
      const owner = scope(request.context, context), current = request.currentHook;
      if (request.source.case === "readCurrent") {
        if (!request.source.value || !current?.filePath) throw new ConnectError("Select a managed script to edit.", Code.InvalidArgument);
        const path = await validateScheduleHookScriptBinding({ workspaceRoot: owner.target.workspaceRoot, filePath: current.filePath, command: current.command });
        owner.assertCurrent();
        const info = await stat(path);
        if (info.size > 256 * 1024) throw new ConnectError("Script is too large.", Code.ResourceExhausted);
        const content = await readFile(path, "utf8"); owner.assertCurrent(); safeText(content, 256 * 1024);
        return create(contract.PrepareScheduleHookResponseSchema, { hook: current, content });
      }
      if (request.source.case === "workspaceFile") {
        const path = await workspaceFile(owner.target.workspaceRoot, request.source.value); owner.assertCurrent();
        return create(contract.PrepareScheduleHookResponseSchema, { hook: { command: scriptCommand(path), filePath: "" } });
      }
      if (request.source.case !== "script" && request.source.case !== "description") throw new ConnectError("Script content or a generation description is required.", Code.InvalidArgument);
      const source = request.source;
      if (!options.installer) throw new ConnectError("Script preparation is unavailable.", Code.Unimplemented);
      return effect(request.operationId, "prepareScheduleHook", toJsonString(contract.PrepareScheduleHookRequestSchema, request),
        contract.PrepareScheduleHookResponseSchema, context, owner.assertCurrent, async () => {
      const installed = await options.installer!.install({ backendId: owner.input.backendId, workspaceRoot: owner.target.workspaceRoot,
        scheduleName: owner.input.scheduleName, scheduleId: owner.input.scheduleId || undefined,
        ...(source.case === "script" ? { script: source.value } : { description: source.value }),
        ...(current?.filePath ? { currentFilePath: current.filePath } : {}),
        ...(owner.session
          ? owner.session.providerId && owner.session.modelId ? { providerId: owner.session.providerId, modelId: owner.session.modelId } : {}
          : owner.input.model ? { providerId: owner.input.model.providerId, modelId: owner.input.model.modelId } : {}),
        draft: true, signal: context.signal, assertCurrent: owner.assertCurrent });
      owner.assertCurrent();
      return create(contract.PrepareScheduleHookResponseSchema, { hook: { command: installed.command, filePath: installed.filePath, timeout: current?.timeout },
        content: installed.content, test: result(installed.test) });
      });
    }),
    testScheduleHook: (request, context) => invoke(async () => {
      const owner = scope(request.context, context), hook = request.hook;
      if (!hook) throw new ConnectError("Pre-run check is required.", Code.InvalidArgument);
      safeText(hook.command, 32_768);
      if (hook.filePath) await validateScheduleHookScriptBinding({ workspaceRoot: owner.target.workspaceRoot, filePath: hook.filePath, command: hook.command });
      owner.assertCurrent();
      const configured = hook.timeout ? Number(hook.timeout.seconds) * 1000 + hook.timeout.nanos / 1_000_000 : 30_000;
      if (!Number.isSafeInteger(configured) || configured <= 0) throw new ConnectError("Timeout must be positive whole milliseconds.", Code.InvalidArgument);
      return effect(request.operationId, "testScheduleHook", toJsonString(contract.TestScheduleHookRequestSchema, request),
        contract.TestScheduleHookResponseSchema, context, owner.assertCurrent, async () => {
      const value = await executeSchedulePreRunHook({ command: hook.command, timeoutMs: Math.min(configured, 300_000), cwd: owner.target.workspaceRoot,
        signal: context.signal, stdinPayload: { event: "schedule-pre-run", scheduleId: owner.input.scheduleId || "self-test",
          scheduleName: owner.input.scheduleName || "Self test", runId: "self-test", firedAt: Date.now(), workingDir: owner.target.workspaceRoot } });
      owner.assertCurrent(); return create(contract.TestScheduleHookResponseSchema, { result: result(value) });
      });
    }),
    getScheduleHookOperation: (request, context) => {
      const connection = options.authenticate(context), operation = options.store.findOperation<{ responseJson: string }>(request.operationId);
      if (!operation) throw new ConnectError("The check operation was not admitted. Retry explicitly.", Code.NotFound);
      if (operation.connectionId !== connection.id || operation.kind !== "prepareScheduleHook" && operation.kind !== "testScheduleHook") {
        throw new ConnectError("This check operation belongs to another owner.", Code.PermissionDenied);
      }
      const response = create(contract.GetScheduleHookOperationResponseSchema, { operation: toProtoOperation(operation) });
      if (operation.status === "completed" && operation.response) response.result = operation.kind === "prepareScheduleHook"
        ? { case: "preparation", value: fromJsonString(contract.PrepareScheduleHookResponseSchema, operation.response.responseJson) }
        : { case: "test", value: fromJsonString(contract.TestScheduleHookResponseSchema, operation.response.responseJson) };
      return response;
    }
  };
}

function result(value: SchedulePreRunHookResult): contract.SchedulePreRunResult {
  return create(contract.SchedulePreRunResultSchema, { ...value, exitCode: value.exitCode ?? undefined, duration: toProtoDuration(value.durationMs),
    stdout: redactSecrets(value.stdout), stderr: redactSecrets(value.stderr), spawnError: value.spawnError ?? "", error: value.error ?? "" });
}
function safeText(value: string, maximum: number): void {
  if (!value.trim() || Buffer.byteLength(value, "utf8") > maximum || value.includes("\0") || redactSecrets(value) !== value) {
    throw new ConnectError("Pre-run check text is empty, too large, or contains credential material.", Code.InvalidArgument);
  }
}
async function workspaceFile(root: string, path: string): Promise<string> {
  safeText(path, 4096);
  if (isAbsolute(path)) throw new ConnectError("Choose a workspace-relative script.", Code.InvalidArgument);
  const canonicalRoot = await realpath(root), file = await realpath(resolve(canonicalRoot, path)), rel = relative(canonicalRoot, file);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || !(await stat(file)).isFile()) throw new ConnectError("Script is outside this workspace.", Code.PermissionDenied);
  return file;
}
function scriptCommand(path: string): string {
  if (process.platform === "win32" && /["%!]/u.test(path)) throw new ConnectError("This script path cannot be represented safely by the Windows shell.", Code.InvalidArgument);
  const quoted = process.platform === "win32" ? `"${path}"` : `'${path.replaceAll("'", `'"'"'`)}'`;
  switch (extname(path).toLowerCase()) {
    case ".mjs": case ".cjs": case ".js": return `joko-node ${quoted}`;
    case ".py": return `python ${quoted}`;
    case ".sh": return `sh ${quoted}`;
    case ".ps1": return `powershell -NoProfile -File ${quoted}`;
    case ".bat": case ".cmd": case ".exe": return quoted;
    default: throw new ConnectError("Choose a JavaScript, Python, shell, PowerShell, or executable script.", Code.InvalidArgument);
  }
}
