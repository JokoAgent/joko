import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type ProjectConfigurationDestination = "codex" | "claude-code";
type Category = "instructions" | "agents" | "hooks" | "mcp";
type ConversionWrite = { readonly path: string; readonly text: string };
type ConversionCandidate = {
  readonly category: Category;
  readonly writes: readonly ConversionWrite[];
  readonly copies?: readonly { readonly source: string; readonly path: string }[];
};
type Document = Record<string, unknown>;
const configurationPaths = new Set(["AGENTS.md", "CLAUDE.md", ".claude/settings.json", ".codex/hooks.json", ".codex/config.toml", ".mcp.json"]);
const agentFile = /^\.(?:claude\/agents\/[a-z0-9_-]{1,64}\.md|codex\/agents\/[a-z0-9_-]{1,64}\.toml)$/iu;
const scriptFile = /^\.(claude|codex)\/hooks\/([a-z0-9_][a-z0-9_.-]{0,127})$/iu;
const commonHookEvents = new Set(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]);
const agentPermissionFields = ["tools", "disallowedTools", "permissionMode", "mcpServers", "sandbox_mode", "permissions",
  "approval_policy", "config_file", "hooks", "skills", "memory", "isolation", "allowed_tools"];
const hasEntries = (value: Document): boolean => Object.keys(value).length > 0;

/** Produces a preview from workspace-authorized inputs. Applying it is a separate workspace operation. */
export function planProjectConfigurationConversion(destination: unknown, files: unknown, scripts: unknown): ConversionCandidate[] {
  if ((destination !== "codex" && destination !== "claude-code") || !Array.isArray(files) || files.length > 128
    || !Array.isArray(scripts) || scripts.length > 128) throw new TypeError("Invalid project configuration preview.");
  const documents = new Map<string, string | null>();
  let length = 0;
  for (const input of files) {
    const file = object(input);
    const path = file?.path;
    const content = file?.text;
    if (typeof path !== "string" || (!configurationPaths.has(path) && !agentFile.test(path))
      || (content !== null && typeof content !== "string") || documents.has(path)) throw new TypeError("Invalid project configuration document.");
    length += content?.length ?? 0;
    if (length > 4 * 1024 * 1024) throw new Error("Project configuration preview is too large.");
    documents.set(path, content);
  }
  const plannedCopies: NonNullable<ConversionCandidate["copies"]>[number][] = [];
  for (const input of scripts) {
    const path = object(input)?.path;
    const source = object(input)?.source;
    const match = typeof source === "string" ? scriptFile.exec(source) : null;
    if (!match || typeof source !== "string" || typeof path !== "string"
      || match[1] !== (destination === "codex" ? "claude" : "codex")
      || path !== (destination === "codex" ? ".codex" : ".claude") + "/hooks/" + match[2]) throw new TypeError("Invalid project hook script.");
    plannedCopies.push({ source, path });
  }

  const candidates: ConversionCandidate[] = [];
  const instructions = documents.get("CLAUDE.md");
  const targetInstructions = documents.get("AGENTS.md");
  if (destination === "codex" && instructions?.trim() && targetInstructions !== undefined && !targetInstructions?.trim()) {
    candidates.push({ category: "instructions", writes: [{ path: "AGENTS.md", text: instructions }] });
  }
  const agents = agentWrites(destination, documents);
  if (agents.length) candidates.push({ category: "agents", writes: agents });
  const hooks = hookWrite(destination, documents, plannedCopies);
  if (hooks !== undefined && (hooks !== null || plannedCopies.length)) {
    candidates.push({ category: "hooks", writes: hooks === null ? [] : [hooks], copies: plannedCopies });
  }
  const mcp = mcpWrite(destination, documents);
  if (mcp !== undefined) candidates.push({ category: "mcp", writes: [mcp] });
  return candidates;
}

function agentWrites(destination: ProjectConfigurationDestination, files: ReadonlyMap<string, string | null>): ConversionWrite[] {
  const toCodex = destination === "codex";
  const pattern = toCodex ? /^\.claude\/agents\/([a-z0-9_-]{1,64})\.md$/iu : /^\.codex\/agents\/([a-z0-9_-]{1,64})\.toml$/iu;
  const writes: ConversionWrite[] = [];
  for (const [source, raw] of files) {
    const basename = pattern.exec(source)?.[1];
    if (!basename || !raw?.trim()) continue;
    const path = toCodex ? ".codex/agents/" + basename + ".toml" : ".claude/agents/" + basename + ".md";
    const existing = files.get(path);
    if (existing === undefined || existing?.trim()) continue;
    try {
      const front = toCodex ? /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/u.exec(raw) : null;
      const fields = toCodex ? front && object(parseYaml(front[1] ?? "")) : object(parseToml(raw));
      const prompt = toCodex ? front?.[2] : fields?.developer_instructions;
      if (!fields || typeof fields.description !== "string" || !fields.description.trim() || typeof prompt !== "string" || !prompt.trim()) continue;
      if (agentPermissionFields.some(key => Object.hasOwn(fields, key))) continue;
      const name = typeof fields.name === "string" && /^[a-z0-9_-]{1,64}$/iu.test(fields.name) ? fields.name : basename;
      const metadata = { name, description: fields.description };
      const text = toCodex ? stringifyToml({ ...metadata, developer_instructions: prompt.trim() }) + "\n"
        : "---\n" + stringifyYaml(metadata) + "---\n\n" + prompt.trim() + "\n";
      writes.push({ path, text });
    } catch {
      // Malformed source agents stay in the source configuration.
    }
  }
  return writes;
}

function hookWrite(destination: ProjectConfigurationDestination, files: ReadonlyMap<string, string | null>,
  copies: NonNullable<ConversionCandidate["copies"]>): ConversionWrite | null | undefined {
  const claude = parseDocument(files.get(".claude/settings.json"), JSON.parse);
  const codex = parseDocument(files.get(".codex/hooks.json"), JSON.parse);
  const toml = parseDocument(files.get(".codex/config.toml"), parseToml);
  if (!claude || !codex || !toml) return undefined;
  const claudeHooks = subsection(claude, "hooks");
  const tomlHooks = subsection(toml, "hooks");
  const codexHooks = Object.hasOwn(codex, "hooks") ? subsection(codex, "hooks")
    : Object.fromEntries(Object.entries(codex).filter(([name, value]) => /^[A-Z][A-Za-z]+$/u.test(name) && Array.isArray(value)));
  if (!claudeHooks || !codexHooks || !tomlHooks) return undefined;
  const flattenedClaude = { ...object(claudeHooks.hooks), ...Object.fromEntries(Object.entries(claudeHooks).filter(([name]) => name !== "hooks")) };
  const toCodex = destination === "codex";
  const source = toCodex ? flattenedClaude : { ...tomlHooks, ...codexHooks };
  const existing = toCodex ? codexHooks : flattenedClaude;
  const copiedScripts = new Map(copies.map(copy => [copy.source, copy.path]));
  const added = Object.entries(source).flatMap(([event, groups]) => {
    if (!commonHookEvents.has(event) || Object.hasOwn(existing, event) || (toCodex && Object.hasOwn(tomlHooks, event))) return [];
    const commands = convertHookGroups(groups, copiedScripts, toCodex);
    return commands.length ? [[event, commands] as const] : [];
  });
  if (!added.length) return null;
  const root = toCodex ? Object.fromEntries(Object.entries(codex).filter(([name]) => !Object.hasOwn(codexHooks, name) || name === "hooks"))
    : claude;
  const path = toCodex ? ".codex/hooks.json" : ".claude/settings.json";
  return { path, text: formatJson({ ...root, hooks: { ...existing, ...Object.fromEntries(added) } }) };
}

function convertHookGroups(value: unknown, copiedScripts: ReadonlyMap<string, string>, toCodex: boolean) {
  if (!Array.isArray(value)) return [];
  return value.flatMap(group => {
    const entry = object(group);
    if (!entry || !Array.isArray(entry.hooks) || (entry.matcher !== undefined && typeof entry.matcher !== "string")) return [];
    const hooks = entry.hooks.flatMap(value => {
      const handler = object(value);
      if (handler?.type !== "command" || typeof handler.command !== "string" || !handler.command.trim()
        || handler.async === true || handler.asyncRewake === true || handler.once === true || handler.if !== undefined) return [];
      const command = handler.command.replace(/\.(?:claude|codex)\/hooks\/[a-z0-9_.-]+/giu, script => copiedScripts.get(script) ?? script);
      return [{
        type: "command",
        command: toCodex ? command.replace(/\$\{CLAUDE_PROJECT_DIR\}|\$CLAUDE_PROJECT_DIR\b/gu, ".") : command,
        ...(typeof handler.timeout === "number" && Number.isFinite(handler.timeout) && handler.timeout > 0 ? { timeout: Math.ceil(handler.timeout) } : {}),
        ...(typeof handler.statusMessage === "string" ? { statusMessage: handler.statusMessage } : {})
      }];
    });
    return hooks.length ? [{ ...(typeof entry.matcher === "string" ? { matcher: entry.matcher } : {}), hooks }] : [];
  });
}

function mcpWrite(destination: ProjectConfigurationDestination, files: ReadonlyMap<string, string | null>): ConversionWrite | undefined {
  const jsonPath = ".mcp.json";
  const tomlPath = ".codex/config.toml";
  const json = parseDocument(files.get(jsonPath), JSON.parse);
  const toml = parseDocument(files.get(tomlPath), parseToml);
  if (!json || !toml) return undefined;
  const claude = subsection(json, "mcpServers");
  const codex = subsection(toml, "mcp_servers");
  if (!claude || !codex) return undefined;
  const toCodex = destination === "codex";
  const existing = toCodex ? codex : claude;
  const missing = Object.fromEntries(Object.entries(toCodex ? claude : codex).flatMap(([name, raw]) => {
    if (!/^[a-z0-9_-]{1,128}$/iu.test(name) || Object.hasOwn(existing, name)) return [];
    const server = portableMcpServer(raw, toCodex);
    return server === undefined ? [] : [[name, server]];
  }));
  if (!hasEntries(missing)) return undefined;
  if (!toCodex) return { path: jsonPath, text: formatJson({ ...json, mcpServers: { ...existing, ...missing } }) };
  const original = (files.get(tomlPath) ?? "").trimEnd();
  const appended = Object.entries(missing).map(([name, config]) => "[mcp_servers." + name + "]\n" + stringifyToml(config).trimEnd()).join("\n\n");
  const text = (original ? original + "\n\n" : "") + appended + "\n";
  // An inline TOML table is closed by definition. Leave it intact if there is no valid append.
  return parseDocument(text, parseToml) ? { path: tomlPath, text } : undefined;
}

function portableMcpServer(value: unknown, toCodex: boolean): Record<string, string | boolean | string[]> | undefined {
  const server = object(value);
  if (!server || server.enabled === false || ["headers", "http_headers", "env_http_headers", "bearer_token_env_var", "env", "env_vars", "cwd", "oauth"]
    .some(key => Object.hasOwn(server, key))) return undefined;
  const args = server.args;
  if (typeof server.command === "string" && server.command.trim() && (server.type === undefined || server.type === "stdio")
    && (args === undefined || Array.isArray(args) && args.every((arg): arg is string => typeof arg === "string"))) {
    return { ...(toCodex ? { enabled: false } : { type: "stdio" }), command: server.command, ...(args === undefined ? {} : { args }) };
  }
  if (typeof server.url !== "string" || (server.type !== undefined && server.type !== "http")) return undefined;
  try {
    const url = new URL(server.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    return { ...(toCodex ? { enabled: false } : { type: "http" }), url: server.url };
  } catch { return undefined; }
}

function object(value: unknown): Document | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Document : undefined;
}

function parseDocument(value: string | null | undefined, parse: (text: string) => unknown): Document | undefined {
  if (value === undefined) return undefined;
  if (!value?.trim()) return {};
  try { return object(parse(value)); } catch { return undefined; }
}

function subsection(parent: Document, key: string): Document | undefined {
  return Object.hasOwn(parent, key) ? object(parent[key]) : {};
}

function formatJson(value: Document): string { return JSON.stringify(value, null, 2) + "\n"; }
