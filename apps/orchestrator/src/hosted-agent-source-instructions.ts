import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { redactSecrets, type AdapterContext } from "@joko/core";
import { isShareCredentialPath, textSpellsOutSecret } from "./hosted-agent-credentials.js";
import { mapSourceInstructionImports, sanitizeHostedPermissionSettings, type HostedProjectFile } from "./hosted-agent-project-files.js";

const ANCESTOR_FILES = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "AGENTS.override.md"];
const MAX_FILES = 512, MAX_FILE_BYTES = 512 * 1024, MAX_TOTAL_BYTES = 4 * 1024 * 1024;
interface Instruction { readonly local: string; readonly wire: string; readonly hops: number; readonly content: string }

/** Read the task computer's guidance only. Native credentials, executable
 * settings and the model computer's HOME never participate in this snapshot. */
export async function snapshotSourceInstructions(context: AdapterContext, input: {
  readonly files: readonly HostedProjectFile[]; readonly nativeKind: string; readonly assertCurrent: () => void;
  readonly home?: string; readonly environment?: Readonly<Record<string, string | undefined>>;
}): Promise<readonly HostedProjectFile[]> {
  const root = context.target.workspaceRoot, home = input.home ?? homedir(), env = input.environment ?? process.env;
  const guard = () => { context.signal.throwIfAborted(); input.assertCurrent(); };
  guard(); if (!context.target.trusted || context.target.remoteWorkspace || context.hostedExecution) throw new Error("Source guidance requires its trusted task computer.");
  const out = input.files.map(file => ({ ...file })), queue: Instruction[] = [], seen = new Map<string, string>();
  let count = out.length, total = out.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
  const config = input.nativeKind === "codex" ? absoluteConfig(env["CODEX_HOME"], path.join(home, ".codex"))
    : absoluteConfig(env["CLAUDE_CONFIG_DIR"], path.join(home, ".claude"));
  const roots = [root, config]; let ancestor = root;
  for (let up = 1; up <= 24; up++) {
    const parent = path.dirname(ancestor); if (parent === ancestor || path.dirname(parent) === parent) break;
    roots.push(parent); ancestor = parent;
  }
  const credentialPath = (file: string) => {
    // An instruction may import a plain text note beside personal CLAUDE.md.
    // Keep all executable/credential configuration excluded, including links.
    const relative = path.relative(config, file);
    return input.nativeKind === "claude-agent-sdk-stdio" && within(file, config) && /\.(?:md|markdown|txt)$/iu.test(file)
      ? isShareCredentialPath(path.join(path.parse(file).root, relative)) : isShareCredentialPath(file);
  };
  const read = async (local: string, permissionsOnly = false): Promise<string | undefined> => {
    guard(); if (count >= MAX_FILES || !permissionsOnly && credentialPath(local)) return;
    try {
      const actual = await realpath(local); guard();
      if (permissionsOnly ? pathKey(local) !== pathKey(path.join(config, "settings.json")) || !within(actual, config)
        : credentialPath(actual) || !roots.some(parent => within(actual, parent))) return;
      const file = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await file.stat({ bigint: true }); guard();
        if (!before.isFile() || before.size > BigInt(MAX_FILE_BYTES) || total + Number(before.size) > MAX_TOTAL_BYTES) return;
        const bytes = Buffer.alloc(Number(before.size) + 1); let length = 0;
        while (length < bytes.length) { const part = await file.read(bytes, length, bytes.length - length, length); guard(); if (!part.bytesRead) break; length += part.bytesRead; }
        const after = await file.stat({ bigint: true }), current = await lstat(actual, { bigint: true }); guard();
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
          || current.dev !== after.dev || current.ino !== after.ino || current.mtimeNs !== after.mtimeNs || current.size !== after.size
          || BigInt(length) !== after.size || await realpath(local) !== actual) return;
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
        const content = permissionsOnly ? sanitizeHostedPermissionSettings(decoded) : decoded;
        if (content === undefined) return;
        if (content.includes("\0") || textSpellsOutSecret(content) || redactSecrets(content) !== content) return;
        guard(); count++; total += length; return content;
      } finally { await file.close(); }
    } catch { guard(); return; }
  };
  const add = async (local: string, hops: number, nonBlank = false): Promise<string | undefined> => {
    const key = pathKey(local), prior = seen.get(key); if (prior) return prior;
    const content = await read(local); if (content === undefined || nonBlank && !content.trim()) return;
    const wire = `.claude/rules/source-context/${createHash("sha256").update(key).digest("hex")}.md`;
    seen.set(key, wire); out.push({ path: wire, content }); queue.push({ local, wire, hops, content }); return wire;
  };
  for (const file of out) if (isInstruction(file.path)) {
    const local = path.join(root, ...file.path.split("/")); seen.set(pathKey(local), file.path); queue.push({ local, wire: file.path, hops: 0, content: file.content });
  }
  // Ancestors precede the current project in their explicit source labels;
  // no file is written outside the Host's private ownership manifest.
  if (["pi", "claude-agent-sdk-stdio"].includes(input.nativeKind)) for (const parent of roots.slice(2).reverse()) {
    for (const name of ANCESTOR_FILES) await add(path.join(parent, name), 0);
  }
  if (input.nativeKind === "codex") {
    for (const name of ["AGENTS.override.md", "AGENTS.md"]) {
      if (await add(path.join(config, name), 0, true)) break;
    }
  } else if (input.nativeKind === "claude-agent-sdk-stdio") {
    await add(path.join(config, "CLAUDE.md"), 0);
    let visited = 0;
    const projectRules = new Set(out.filter(file => file.path.startsWith(".claude/rules/")).map(file => pathKey(file.path)));
    const scanRules = async (relative: string, depth: number, ancestors: ReadonlySet<string>): Promise<void> => {
      guard(); if (depth > 6 || visited >= 4096 || count >= MAX_FILES) return;
      const directory = path.join(config, "rules", relative); let entries: Awaited<ReturnType<typeof opendir>> | undefined;
      try {
        const actual = await realpath(directory); guard();
        if (!within(actual, config) || ancestors.has(pathKey(actual))) return;
        const next = new Set(ancestors).add(pathKey(actual)); entries = await opendir(directory);
        for await (const entry of entries) {
          guard(); if (++visited > 4096 || count >= MAX_FILES) break;
          if (entry.name === "node_modules" || entry.name === ".git") continue;
          const child = path.join(relative, entry.name), local = path.join(directory, entry.name);
          const linked = entry.isSymbolicLink() ? await realpath(local).then(async actual => within(actual, config) ? lstat(actual) : undefined).catch(() => undefined) : undefined;
          if (entry.isDirectory() || linked?.isDirectory()) await scanRules(child, depth + 1, next);
          else if ((entry.isFile() || linked?.isFile()) && /\.(?:md|markdown)$/iu.test(entry.name) && !projectRules.has(pathKey(`.claude/rules/${child.split(path.sep).join("/")}`))) {
            await add(local, 0);
          }
        }
        entries = undefined;
      } catch { guard(); } finally { await entries?.close().catch(() => undefined); }
    };
    await scanRules("", 0, new Set());
    const personalSettings = await read(path.join(config, "settings.json"), true);
    if (personalSettings !== undefined) {
      const local = out.find(file => file.path === ".claude/settings.local.json");
      const personal = JSON.parse(personalSettings) as { permissions: Record<string, string[]> };
      const project = local ? JSON.parse(local.content) as typeof personal : undefined;
      const permissions: Record<string, string[]> = {};
      for (const name of ["allow", "deny", "ask"]) {
        const rules = [...new Set([...(project?.permissions[name] ?? []), ...(personal.permissions[name] ?? [])])];
        if (rules.length) permissions[name] = rules;
      }
      const merged = JSON.stringify({ permissions }, null, 2);
      total += Buffer.byteLength(merged) - (local ? Buffer.byteLength(local.content) : 0);
      if (Buffer.byteLength(merged) > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) throw new Error("Source personal permissions exceed their limit.");
      if (local) local.content = merged; else out.push({ path: ".claude/settings.local.json", content: merged });
    }
  }
  for (let index = 0; index < queue.length; index++) {
    const instruction = queue[index]!, replacements = new Map<string, string>();
    if (input.nativeKind === "claude-agent-sdk-stdio" && instruction.hops < 5) {
      const tokens = new Set<string>(); mapSourceInstructionImports(instruction.content, token => { tokens.add(token); return `@${token}`; });
      for (const token of tokens) {
        const local = path.resolve(path.dirname(instruction.local), token.startsWith("~/") || token.startsWith("~\\") ? path.join(home, token.slice(2)) : token);
        if (!roots.some(parent => within(local, parent))) continue;
        const wire = await add(local, instruction.hops + 1);
        if (wire) replacements.set(token, path.posix.relative(path.posix.dirname(instruction.wire), wire));
      }
    }
    const content = mapSourceInstructionImports(instruction.content, token => replacements.has(token) ? `@${replacements.get(token)!}` : `\`@${token}\``);
    const target = out.find(file => file.path === instruction.wire)!;
    target.content = instruction.wire.startsWith(".claude/rules/source-context/")
      ? `Source instruction file: ${JSON.stringify(instruction.local)}\n\n${content}` : content;
  }
  const added = out.filter(file => !input.files.some(original => original.path === file.path));
  const personal = new Set(queue.filter(file => within(file.local, config)).map(file => file.wire));
  guard(); return [...added.filter(file => personal.has(file.path)), ...added.filter(file => !personal.has(file.path)),
    ...out.filter(file => input.files.some(original => original.path === file.path))];
}
function isInstruction(file: string): boolean {
  return ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md", "AGENTS.md", "AGENTS.override.md"].includes(file) || file.startsWith(".claude/rules/") && /\.md$/iu.test(file);
}
function absoluteConfig(value: string | undefined, fallback: string): string { return value && path.isAbsolute(value) ? path.resolve(value) : fallback; }
function pathKey(value: string): string { const resolved = path.resolve(value); return process.platform === "win32" ? resolved.toLowerCase() : resolved; }
function within(child: string, parent: string): boolean { const value = path.relative(parent, child); return !value || value !== ".." && !value.startsWith(`..${path.sep}`) && !path.isAbsolute(value); }
