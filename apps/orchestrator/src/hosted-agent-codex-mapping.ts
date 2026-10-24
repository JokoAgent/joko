import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveExecutorShell } from "./hosted-agent-shell.js";
import type { ExecutorWorkspace } from "./hosted-agent-workspace.js";

export type HostedAgentCodexAction =
  | { readonly kind: "read"; readonly path: string; readonly scope?: "tree" }
  | { readonly kind: "write"; readonly path: string; readonly scope?: "tree" }
  | { readonly kind: "network"; readonly url: string; readonly method: string }
  | { readonly kind: "exec"; readonly command: string; readonly cwd: string };

function readExistingTextSync(target: string): string | null {
  try {
    const info = fs.lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) return null;
    const bytes = fs.readFileSync(target);
    if (bytes.includes(0)) return null;
    const text = bytes.toString("utf8");
    return Buffer.from(text).equals(bytes) ? text : null;
  } catch { return null; }
}

export function execServerCommand(argv: unknown): string | null {
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((part) => typeof part === 'string')) return null;
  const parts = argv as string[];
  if (parts.length >= 3 && /^-l?c$/.test(parts[parts.length - 2]!) && /(^|\/)(ba|z|da|k)?sh$/.test(parts[0]!)) {
    return parts[parts.length - 1]!;
  }
  return parts.join(' ');
}

function fromFileUrl(value: unknown, base: string, pathStyle?: "posix" | "win32"): string | null {
  if (typeof value !== 'string' || !value) return null;
  if (/^file:/iu.test(value)) {
    try {
      return pathStyle === undefined ? fileURLToPath(value) : fileURLToPath(value, { windows: pathStyle === "win32" });
    } catch {
      return null;
    }
  }
  const paths = pathStyle === "win32" ? path.win32 : pathStyle === "posix" ? path.posix : path;
  return paths.isAbsolute(value) ? value : paths.resolve(base, value);
}

// exec-server 的只读操作按读取过闸门；不在下面几组里的 `fs/` 方法一律按写入处理(新版 Codex 新增的
// 方法先从严)。`fs/walk`、`fs/canonicalize`、`fs/open` 曾落进写入：计划模式下工作区里的项目 Skill
// 加载被拒，工作区外的单文件读取也被当成区外写入拒掉(#5764)。

/** 读单个文件或单层目录；固定协议的 fs/open 始终只读。 */
const READ_METHODS = new Set(['fs/readFile', 'fs/open', 'fs/readDirectory', 'fs/readDir', 'fs/listDirectory']);
/** 递归遍历：按目录级读取过闸门，根在工作区外与本机任务的搜索一样要本机确认。 */
const TREE_READ_METHODS = new Set(['fs/walk']);
/** 只看元数据、不读内容的操作不过闸门(`fs/canonicalize` 只解析真实路径)。 */
const METADATA_METHODS = new Set(['fs/getMetadata', 'fs/exists', 'fs/stat', 'fs/canonicalize']);

/** 把一个 exec-server 请求换成要过闸门的操作。 */
export function execServerActions(method: string, params: unknown, cwd: string, pathStyle?: "posix" | "win32"): HostedAgentCodexAction[] {
  const record = params && typeof params === 'object' ? params as Record<string, unknown> : {};
  if (method === 'process/start') {
    const command = execServerCommand(record.argv);
    const processCwd = fromFileUrl(record.cwd, cwd, pathStyle) ?? cwd;
    return command ? [{ kind: 'exec', command, cwd: processCwd }] : [{ kind: 'exec', command: '<unknown>', cwd: processCwd }];
  }
  if (method === 'http/request') return [{ kind: 'network',
    url: typeof record.url === 'string' ? record.url : '<unknown>',
    method: typeof record.method === 'string' ? record.method : '<unknown>' }];
  if (method === 'capabilityRoots/discoverV1') {
    const roots = Array.isArray(record.roots) ? record.roots : [];
    return roots.flatMap(root => {
      const target = fromFileUrl(asJsonRecord(root)?.path, cwd, pathStyle);
      return target ? [{ kind: 'read' as const, path: target, scope: 'tree' as const }] : [];
    });
  }
  if (!method.startsWith('fs/') || METADATA_METHODS.has(method)) return [];
  const paths = ['path', 'sourcePath', 'destinationPath', 'source', 'destination', 'from', 'to', 'target']
    .map((key) => fromFileUrl(record[key], cwd, pathStyle))
    .filter((value): value is string => !!value);
  if (TREE_READ_METHODS.has(method)) return paths.map((target) => ({ kind: 'read', path: target, scope: 'tree' }));
  if (method === 'fs/copy') {
    const source = fromFileUrl(record.sourcePath, cwd, pathStyle), destination = fromFileUrl(record.destinationPath, cwd, pathStyle);
    return [...(source ? [{ kind: 'read' as const, path: source, ...(record.recursive === true ? { scope: 'tree' as const } : {}) }] : []),
      ...(destination ? [{ kind: 'write' as const, path: destination, ...(record.recursive === true ? { scope: 'tree' as const } : {}) }] : [])];
  }
  // The pinned fs/open ignores unknown fields, including mode, and always opens for reading.
  // An explicit future write mode therefore needs both effects until its protocol is supported.
  if (method === 'fs/open') return paths.flatMap(target => [
    { kind: 'read' as const, path: target },
    ...(record.mode === undefined || record.mode === 'read' ? [] : [{ kind: 'write' as const, path: target }])
  ]);
  const kind = READ_METHODS.has(method) ? 'read' : 'write';
  return paths.map((target) => ({ kind, path: target,
    ...(method === 'fs/remove' && record.recursive === true ? { scope: 'tree' as const } : {}) }) as HostedAgentCodexAction);
}

/** 映射协议路径、命令和可逆的 UTF-8 文件数据；二进制内容保持原样。 */
export function mapExecServerParams(value: unknown, workspace: ExecutorWorkspace, method?: string, mapFileData = true): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = { ...value as Record<string, unknown> };
  const windowsAgent = agentUsesWindowsPaths(workspace);
  for (const key of ['cwd', 'path', 'sourcePath', 'destinationPath', 'source', 'destination', 'from', 'to', 'target']) {
    const item = result[key];
    if (typeof item !== 'string') continue;
    if (/^file:/iu.test(item)) {
      const foreign = fileURLToPath(item, { windows: windowsAgent });
      result[key] = sourcePathUri(workspace.resolve(foreign), workspace);
    } else result[key] = workspace.resolve(item);
  }
  if (method === 'capabilityRoots/discoverV1' && Array.isArray(result.roots)) {
    result.roots = result.roots.map(root => mapExecServerParams(root, workspace, undefined, false));
  }
  if (Array.isArray(result.argv)) result.argv = result.argv.map((part, index) => typeof part === 'string'
    // argv[0] is an executable filename, so shell quoting becomes part of the
    // filename when the native executor calls CreateProcess or exec directly.
    ? index === 0 ? workspace.mapAlias(part) : workspace.mapCommand(part, resolveExecutorShell().dialect)
    : part);
  if (typeof result.command === 'string') result.command = workspace.mapCommand(result.command, resolveExecutorShell().dialect);
  if (result.sandbox !== undefined) result.sandbox = mapExecServerSandbox(result.sandbox, workspace);
  return mapFileData ? mapExecServerFileData(result, workspace, method) : result;
}

type JsonRecord = Record<string, unknown>;

function asJsonRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function sourceUsesWindowsPaths(workspace: ExecutorWorkspace): boolean {
  return /^(?:[A-Za-z]:[\\/]|[\\/]{2})/u.test(workspace.workingDir);
}

function agentUsesWindowsPaths(workspace: ExecutorWorkspace): boolean {
  const prefix = workspace.agentPathPrefixes()[0];
  return prefix === undefined ? sourceUsesWindowsPaths(workspace) : /^(?:[A-Za-z]:|[\\/]{2})/u.test(prefix);
}

function sourcePathUri(value: string, workspace: ExecutorWorkspace): string {
  return pathToFileURL(value, { windows: sourceUsesWindowsPaths(workspace) }).href;
}

/** Unmapped deny entries keep their Source meaning; malformed entries still fail closed there. */
function sourceCanInterpretUri(value: unknown, workspace: ExecutorWorkspace): boolean {
  if (typeof value !== 'string') return true;
  const windows = sourceUsesWindowsPaths(workspace);
  try {
    fileURLToPath(value, { windows });
    return true;
  } catch {
    try {
      const uri = new URL(value);
      if (uri.protocol !== 'file:') return true;
      if (!windows) return uri.hostname === '' || uri.hostname === 'localhost';
      return uri.hostname !== '' && uri.hostname !== 'localhost' || /^\/[A-Za-z]:[\\/]/u.test(decodeURIComponent(uri.pathname));
    } catch { return true; }
  }
}

/** 转换沙箱用到的 Agent 一侧信息：它的路径约定按虚拟工作区(Agent 主机上的路径)判断，不按单个 URI 的长相猜。 */
interface SandboxMapping {
  workspace: ExecutorWorkspace;
  windowsAgent: boolean;
}

/** Agent 发来的 file URI 还原成它那边的路径写法(Windows Agent：`file:///C:/x` → `C:/x`；UNC 带回主机名)。 */
function agentPathFromUri(value: unknown, windowsAgent: boolean): string | null {
  if (typeof value !== 'string' || !/^file:/iu.test(value)) return null;
  try {
    return fileURLToPath(value, { windows: windowsAgent });
  } catch {
    return null;
  }
}

/** 虚拟工作区内的 file URI 换成本机 file URI；Agent 主机自己的路径返回 null。 */
function localUriFromAgent(value: unknown, { workspace, windowsAgent }: SandboxMapping): string | null {
  const agentPath = agentPathFromUri(value, windowsAgent);
  const local = agentPath === null ? null : workspace.localPathFromAgent(agentPath);
  return local === null ? null : sourcePathUri(local, workspace);
}

/**
 * 沙箱上下文里解释权限条目用的目录(policyContext 里同名字段同样处理)。用户目录对不上时用本机的：
 * Codex 缺了它会把 `~/…` 规则当作解析失败、一律拒绝读取。
 */
function mapSandboxDirs(record: JsonRecord, mapping: SandboxMapping): JsonRecord {
  const result = { ...record };
  if (result.cwd !== undefined) {
    const local = localUriFromAgent(result.cwd, mapping);
    if (local === null) delete result.cwd;
    else result.cwd = local;
  }
  if (result.userHomeDir !== undefined) {
    result.userHomeDir = localUriFromAgent(result.userHomeDir, mapping) ?? pathToFileURL(os.homedir()).href;
  }
  for (const key of ['workspaceRoots', 'temporaryDirectories']) {
    const items = result[key];
    if (Array.isArray(items)) result[key] = items.flatMap((item) => localUriFromAgent(item, mapping) ?? []);
  }
  return result;
}

/**
 * 一条文件权限：虚拟工作区内的路径换成本机路径。Agent 主机自己的路径(如它的 Codex 记忆目录)在本机
 * 没有对应位置，读写授权直接丢掉，只收不放。禁止规则不因转换失效：路径条目在本机也是合法绝对路径时
 * 原样保留(不合法的会让本机 exec-server 拒绝整个请求)；没映射上的禁止 glob 一律原样保留——相对的由本机
 * 按工作目录解释，Agent 主机的绝对路径在本机匹配不到东西，无需判断它是不是绝对路径。特殊路径(`:tmpdir`、
 * 项目根等)由本机 exec-server 按映射后的目录解释。
 */
function mapSandboxEntry(entry: unknown, mapping: SandboxMapping): unknown[] {
  const record = asJsonRecord(entry);
  const target = asJsonRecord(record?.path);
  if (!record || !target) return [entry];
  const deny = record.access === 'deny' || record.access === 'none';
  if (target.type === 'path') {
    const local = localUriFromAgent(target.path, mapping);
    if (local !== null) return [{ ...record, path: { ...target, path: local } }];
    return deny && sourceCanInterpretUri(target.path, mapping.workspace) ? [entry] : [];
  }
  if (target.type === 'glob_pattern' && typeof target.pattern === 'string') {
    const local = mapping.workspace.localGlobFromAgent(target.pattern);
    if (local !== null) return [{ ...record, path: { ...target, pattern: local } }];
    // 读写 glob 只有明确是绝对路径(盘符加分隔符、`/` 开头、`\\server`)才是 Agent 主机的路径，丢掉；判断不准只会少放。
    return deny || !/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(target.pattern) ? [entry] : [];
  }
  return [entry];
}

/**
 * Codex 请求(process/start、fs/*)里的 `sandbox`：权限条目和解释它们用的目录都是 Agent 主机上看到的
 * file URI。原样转给本机 exec-server，两端系统不同时会因路径不属于本机被拒(`invalid sandbox
 * permission path URI`)，相同时则放行的是本机不存在的虚拟目录。这里换成本机路径，规则见 mapSandboxEntry。
 */
function mapExecServerSandbox(value: unknown, workspace: ExecutorWorkspace): unknown {
  const record = asJsonRecord(value);
  const agentPrefixes = workspace.agentPathPrefixes();
  if (!record || agentPrefixes.length === 0) return value;
  const mapping: SandboxMapping = { workspace, windowsAgent: /^(?:[A-Za-z]:|[\\/]{2})/.test(agentPrefixes[0]!) };
  const sandbox = mapSandboxDirs(record, mapping);
  const policyContext = asJsonRecord(sandbox.policyContext);
  if (policyContext) sandbox.policyContext = mapSandboxDirs(policyContext, mapping);
  const permissions = asJsonRecord(sandbox.permissions);
  const fileSystem = asJsonRecord(permissions?.file_system);
  if (permissions && fileSystem && Array.isArray(fileSystem.entries)) {
    const entries = fileSystem.entries.flatMap((entry) => mapSandboxEntry(entry, mapping));
    sandbox.permissions = { ...permissions, file_system: { ...fileSystem, entries } };
  }
  return sandbox;
}

/**
 * 授权通过后、实际转发前才读写入目标的原内容，排队中的请求也在出队后读取最新内容。
 * 路径与命令的映射仍在权限检查前完成，确保 gate 检查的是实际执行的操作。
 */
export function mapExecServerFileData(value: unknown, workspace: ExecutorWorkspace, method?: string): unknown {
  if (!method?.startsWith('fs/write') || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = value as Record<string, unknown>;
  if (typeof result.dataBase64 !== 'string') return value;
  return { ...result, dataBase64: workspace.mapInputFromAgent(Buffer.from(result.dataBase64, 'base64'),
    existingTextFor(result.path, workspace)).toString('base64') };
}

/** 旧内容仅用于还原写入路径的原写法，不回给 Agent；凭证类文件不预读。 */
function existingTextFor(target: unknown, workspace: ExecutorWorkspace): string | null {
  if (typeof target !== 'string') return null;
  let local: string;
  try {
    local = target.startsWith('file://') ? fileURLToPath(target) : target;
  } catch {
    return null;
  }
  return workspace.isSensitive(local) ? null : readExistingTextSync(local);
}

/** JSON 层逐字符串投影；文件 base64 数据保持原始字节，进程输出单独解码。 */
export function mapExecServerResult(value: unknown, workspace: ExecutorWorkspace, method?: string): unknown {
  if (typeof value === 'string') {
    if (/^file:/iu.test(value)) {
      try {
        const real = fileURLToPath(value, { windows: sourceUsesWindowsPaths(workspace) });
        const virtual = workspace.toAgentPath(real);
        if (virtual === real) return value;
        return pathToFileURL(virtual, { windows: agentUsesWindowsPaths(workspace) }).href;
      } catch { return value; }
    }
    return workspace.mapTextForAgent(value);
  }
  if (Array.isArray(value)) return value.map((item) => mapExecServerResult(item, workspace, method));
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  // 初始化里的 HOME / temp 同样只暴露本机虚拟目录；这些别名不增加执行权限。
  if (record.environmentInfo && typeof record.environmentInfo === 'object') {
    const info = record.environmentInfo as Record<string, unknown>;
    const directories = [info.userHomeDir, info.tempDir, ...(Array.isArray(info.temporaryDirectories) ? info.temporaryDirectories : [])];
    workspace.virtualizeDirs(directories.flatMap((dir) => {
      if (typeof dir !== 'string') return [];
      try { return [/^file:/iu.test(dir) ? fileURLToPath(dir, { windows: sourceUsesWindowsPaths(workspace) }) : dir]; } catch { return []; }
    }));
  }
  const currentMethod = typeof record.method === 'string' ? record.method : method;
  return Object.fromEntries(Object.entries(record).map(([key, item]) => {
    if (currentMethod === 'process/output' && key === 'chunk' && typeof item === 'string') {
      return [key, workspace.mapOutputForAgent(Buffer.from(item, 'base64')).toString('base64')];
    }
    return [key, mapExecServerResult(item, workspace, currentMethod)];
  }));
}
