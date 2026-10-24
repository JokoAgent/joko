type ToolSdk = Pick<typeof import("@earendil-works/pi-coding-agent"),
  "createReadToolDefinition" | "createWriteToolDefinition" | "createEditToolDefinition" | "createBashToolDefinition"
  | "createGrepToolDefinition" | "createFindToolDefinition" | "createLsToolDefinition">;
export const MAXIMUM_PI_HOSTED_CONFIGURATION_BYTES = 8 * 1024 * 1024;
type HostedTools = {
  read: ReturnType<ToolSdk["createReadToolDefinition"]>;
  write: ReturnType<ToolSdk["createWriteToolDefinition"]>;
  edit: ReturnType<ToolSdk["createEditToolDefinition"]>;
  bash: ReturnType<ToolSdk["createBashToolDefinition"]>;
  find: ReturnType<ToolSdk["createFindToolDefinition"]>;
  ls: ReturnType<ToolSdk["createLsToolDefinition"]>;
  grep: ReturnType<ToolSdk["createGrepToolDefinition"]>;
  bashOperations: import("@earendil-works/pi-coding-agent").BashOperations;
};
export interface PiHostedExecutor {
  createTools(callId: string, signal?: AbortSignal, origin?: "agent" | "user_shell"): HostedTools;
  assertModel(providerId: unknown, modelId: unknown): void;
  readonly trust: "owner" | "guest";
  readonly environmentNote: string;
}

export interface PiHostedExecutorConfiguration {
  readonly format: 1;
  readonly endpoint: string;
  readonly bearer: string;
  readonly root: string;
  readonly platform: "win32" | "darwin" | "linux";
  readonly shell: string;
  readonly trust: "owner" | "guest";
  readonly providerId?: string;
  readonly modelIds?: readonly string[];
  readonly environmentNote?: string;
  readonly backgroundScope?: PiHostedBackgroundScope;
}

/** Owner-private identity copied into one detached native runner's config. */
export interface PiHostedBackgroundScope {
  readonly taskId: string;
  readonly runId: string;
  readonly launchToken: string;
  readonly runnerInstanceId: string;
  readonly nativeSessionId: string;
}

/** Closure-free factory provisioned next to the native bridge. Every operation
 * goes through the task's authenticated executor; SDK formatting remains native. */
export function createPiHostedExecutor(sdk: ToolSdk, config: PiHostedExecutorConfiguration, fetcher: typeof fetch = fetch): PiHostedExecutor {
  const url = new URL(config.endpoint);
  if (config.format !== 1 || url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || !url.port || url.username || url.password || url.search || url.hash
    || !/^[A-Za-z0-9_-]{32,256}$/u.test(config.bearer) || !config.root || config.root.includes("\0")
    || !["win32", "darwin", "linux"].includes(config.platform) || typeof config.shell !== "string"
    || !["owner", "guest"].includes(config.trust)
    || config.environmentNote !== undefined && typeof config.environmentNote !== "string"
    || config.backgroundScope !== undefined && (!config.backgroundScope || typeof config.backgroundScope !== "object"
      || Object.keys(config.backgroundScope).length !== 5
      || typeof config.backgroundScope.taskId !== "string" || !config.backgroundScope.taskId || config.backgroundScope.taskId.length > 256
      || /[\0\r\n]/u.test(config.backgroundScope.taskId)
      || [config.backgroundScope.runId, config.backgroundScope.launchToken, config.backgroundScope.runnerInstanceId, config.backgroundScope.nativeSessionId]
        .some(value => typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)))
    || Buffer.byteLength(JSON.stringify(config)) > 8 * 1024 * 1024
    || config.trust === "guest" && (!config.providerId || !Array.isArray(config.modelIds) || !config.modelIds.length
      || config.modelIds.some(id => typeof id !== "string" || !id || id.length > 512))) throw new Error("Hosted execution channel is invalid.");
  const maximumBytes = 64 * 1024 * 1024;
  const endpoint = config.endpoint.replace(/\/$/u, "") + "/execute";
  const decode = (value: unknown): Buffer => {
    if (typeof value !== "string" || value.length > maximumBytes || value.length % 4 !== 0) throw new Error("The task executor returned invalid bytes.");
    const bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") !== value) throw new Error("The task executor returned invalid bytes.");
    return bytes;
  };
  const createTools = (callId: string, signal?: AbortSignal, origin: "agent" | "user_shell" = "agent") => {
    if (!callId || callId.length > 1024 || /[\0\r\n]/u.test(callId)) throw new Error("Hosted tool call identity is invalid.");
    let sequence = 0;
    // Provider tool IDs can repeat in later turns. Mint a runtime occurrence so
    // retry protection never mistakes a later native tool for an old write.
    const executionId = "tool-" + globalThis.crypto.randomUUID();
    let started = false;
    const call = async (operation: string, payload: Readonly<Record<string, unknown>>, operationSignal = signal): Promise<Record<string, unknown>> => {
      const activeSignal = signal && operationSignal && signal !== operationSignal ? AbortSignal.any([signal, operationSignal]) : operationSignal;
      activeSignal?.throwIfAborted();
      if (++sequence > 1024) throw new Error("Hosted tool operation limit exceeded.");
      const body = JSON.stringify({ format: 1, callId: executionId, requestId: `${executionId}:${sequence}`, operation, payload, origin,
        ...(config.backgroundScope === undefined ? {} : { backgroundScope: config.backgroundScope }) });
      if (Buffer.byteLength(body) > maximumBytes) throw new Error("Hosted tool request exceeds its limit.");
      const response = await fetcher(endpoint, { method: "POST", redirect: "error", signal: activeSignal,
        headers: { authorization: `Bearer ${config.bearer}`, "content-type": "application/json" }, body });
      activeSignal?.throwIfAborted();
      if (!response.body) throw new Error("The task executor returned no response.");
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
      try {
        for (;;) { const chunk = await reader.read(); activeSignal?.throwIfAborted(); if (chunk.done) break;
          bytes += chunk.value.byteLength; if (bytes > maximumBytes) throw new Error("The task executor response exceeds its limit."); chunks.push(chunk.value); }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("The task executor returned invalid JSON."); }
      const result = parsed as { format?: unknown; ok?: unknown; value?: unknown; error?: { code?: unknown } } | null;
      if (!result || result.format !== 1 || !response.ok || result.ok !== true) {
        const code = result?.error?.code;
        throw Object.assign(new Error("The task executor rejected the request."),
          typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? { code } : {});
      }
      if (!result.value || typeof result.value !== "object" || Array.isArray(result.value)) throw new Error("The task executor returned an invalid result.");
      return result.value as Record<string, unknown>;
    };
    const read = async (path: string) => decode((await call("fs.read", { path })).data);
    const write = async (path: string, content: string) => { await call("fs.write", { path, data: Buffer.from(content).toString("base64") }); };
    const access = async (path: string, mode: "read" | "write") => { await call("fs.access", { path, mode }); };
    const exists = async (path: string) => {
      try { await call("fs.stat", { path }); return true; }
      catch (error) { if ((error as { code?: unknown }).code === "NOT_FOUND") return false; throw error; }
    };
    const list = async (path: string): Promise<string[]> => {
      const result = await call("fs.readdir", { path });
      if (!Array.isArray(result.entries) || result.entries.some(entry => typeof entry !== "string")) throw new Error("The task executor returned invalid entries.");
      return result.entries as string[];
    };
    const bashOperations = { exec: async (command: string, cwd: string, options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number }) => {
      options.signal?.throwIfAborted();
      const direct = !started;
      if (direct) { await call("tool.begin", { name: "bash", input: { command, cwd, timeout: options.timeout ?? 300 } }, options.signal); started = true; }
      try {
        const result = await call("exec.run", { command, cwd, ...(options.timeout === undefined ? {} : { timeout: options.timeout }) }, options.signal);
        if (result.output !== undefined) options.onData(decode(result.output));
        if (result.aborted === true) throw new Error("aborted");
        if (result.timedOut === true) throw new Error(`timeout:${options.timeout}`);
        if (result.exitCode !== null && !Number.isSafeInteger(result.exitCode)) throw new Error("The task executor returned an invalid exit code.");
        return { exitCode: result.exitCode as number | null };
      } finally { if (direct) { started = false; await call("tool.end", {}).catch(() => undefined); } }
    } };
    const grep = sdk.createGrepToolDefinition(config.root);
    const tools = {
      read: sdk.createReadToolDefinition(config.root, { operations: { readFile: read, access: path => access(path, "read"),
        detectImageMimeType: async path => { const result = await call("fs.mime", { path }); if (result.mime !== null && typeof result.mime !== "string") throw new Error("Invalid task image type."); return result.mime as string | null; } } }),
      write: sdk.createWriteToolDefinition(config.root, { operations: { writeFile: write, mkdir: async path => { await call("fs.mkdir", { path }); } } }),
      edit: sdk.createEditToolDefinition(config.root, { operations: { readFile: read, writeFile: write, access: path => access(path, "write") } }),
      ls: sdk.createLsToolDefinition(config.root, { operations: { exists, readdir: list, stat: async path => {
        const result = await call("fs.stat", { path }); if (!["directory", "file", "symlink"].includes(String(result.type))) throw new Error("Invalid task file type.");
        return { isDirectory: () => result.type === "directory" }; } } }),
      find: sdk.createFindToolDefinition(config.root, { operations: { exists, glob: async (pattern, cwd, options) => {
        const result = await call("fs.glob", { pattern, cwd, limit: options.limit, ignore: options.ignore });
        if (!Array.isArray(result.paths) || result.paths.some(path => typeof path !== "string")) throw new Error("Invalid task file matches."); return result.paths as string[]; } } }),
      grep: { ...grep, execute: async (_id: string, params: unknown) => { const result = await call("pi.grep", { params });
        if (typeof result.text !== "string") throw new Error("Invalid task search result.");
        return { content: [{ type: "text" as const, text: result.text }], details: result.details as never }; } },
      bash: sdk.createBashToolDefinition(config.root, { exposeSessionEnvironment: false, operations: bashOperations }),
      bashOperations
    };
    const wrap = <T extends { execute: (...args: any[]) => any; name: string }>(tool: T): T => ({
      ...tool,
      execute: async (...args: Parameters<T["execute"]>) => {
        if (String(args[0]) !== callId || started) throw new Error("Hosted native tool occurrence is invalid.");
        await call("tool.begin", { name: tool.name, input: args[1] }); started = true;
        try { return await tool.execute(...args); }
        finally { started = false; await call("tool.end", {}).catch(() => undefined); }
      }
    });
    return { ...tools, read: wrap(tools.read), write: wrap(tools.write), edit: wrap(tools.edit), ls: wrap(tools.ls),
      find: wrap(tools.find), grep: wrap(tools.grep), bash: wrap(tools.bash) };
  };
  const assertModel = (providerId: unknown, modelId: unknown) => {
    if (config.trust === "guest" && (providerId !== config.providerId || typeof modelId !== "string" || !config.modelIds!.includes(modelId))) {
      throw new Error("The shared Provider does not allow this model.");
    }
  };
  return { createTools, assertModel, trust: config.trust,
    environmentNote: config.environmentNote ?? `# Workspace\nThe current workspace is ${JSON.stringify(config.root)} (${config.platform}, shell: ${config.shell}). File and shell tools operate in this workspace. Relative paths resolve against it.` };
}
