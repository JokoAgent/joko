import { randomUUID } from "node:crypto";

import type {
  MakerMemoryEntry,
  MakerMemoryKind,
  MakerMemorySearchHit,
  OperationalStore
} from "@joko/store";

import type {
  BridgeToolCallContext,
  BridgeToolProvider,
  McpCallResult,
  McpToolDescriptor
} from "./mcp-router.js";

export const MAKER_MEMORY_PROVIDER_ID = "joko_memory";
export const MAKER_MEMORY_SETTING_KEY = "settings.memory";

const CURATED_KINDS = ["user", "feedback", "project", "reference"] as const;
const MEMORY_SCAN_PAGE_SIZE = 1_000;
const MEMORY_RULES = `# Maker Memory

You have workspace-scoped persistent memory shared by future agent sessions. Use only the managed \`joko_memory\` tools for this memory.

Save only durable information worth recalling later:
- user: the user's stable goals, role, knowledge, or preferences
- feedback: a reusable correction; include **Why:** and **How to apply:**
- project: durable decisions, constraints, or deadlines for this workspace
- reference: pointers to external systems or documentation

Do not save code structure, Git history, instructions already present in repository guidance, transient task progress, raw tool output, or credentials. Search before creating a related entry and update the existing entry instead of making a duplicate. A message beginning with "Save in memory:" or "记到 memory:" is an explicit request to evaluate and save the remainder.

Compression digests are private search-only history. They never appear in this automatic index and cannot be written through memory_write.`;

export interface StoredMemorySettings {
  readonly format: 1;
  readonly makerEnabled: boolean;
  readonly backendEnabled: Readonly<Record<string, boolean>>;
}

export interface MakerMemorySnapshot {
  readonly makerEnabled: boolean;
  readonly customized: boolean;
  readonly entryCount: number;
  readonly backendEnabled: Readonly<Record<string, boolean>>;
  readonly backendEntryCount: Readonly<Record<string, number>>;
}

/** Capability-derived role assignment supplied by the service projection. */
export interface MakerMemoryBackendRole {
  readonly backendId: string;
  readonly role: "compaction_digest";
}

export interface MakerMemorySettingsPatch {
  readonly makerEnabled?: boolean;
  readonly backendId?: string;
  readonly backendEnabled?: boolean;
}

export class MakerMemoryController {
  readonly #store: OperationalStore;
  readonly #scopeId: string;
  readonly #onSettingsChanged: () => Promise<void>;
  #generation = 1;

  constructor(input: {
    readonly store: OperationalStore;
    readonly scopeId?: string;
    readonly onSettingsChanged?: () => Promise<void>;
  }) {
    this.#store = input.store;
    this.#scopeId = input.scopeId ?? "orchestrator";
    this.#onSettingsChanged = input.onSettingsChanged ?? (() => Promise.resolve());
    const stored = this.#store.findSetting<unknown>("service", this.#scopeId, MAKER_MEMORY_SETTING_KEY);
    if (stored !== undefined) validateStoredSettings(stored.value);
  }

  get generation(): number {
    return this.#generation;
  }

  get available(): boolean {
    return this.settings().makerEnabled;
  }

  settings(): StoredMemorySettings {
    const stored = this.#store.findSetting<unknown>("service", this.#scopeId, MAKER_MEMORY_SETTING_KEY);
    return stored === undefined ? defaults() : validateStoredSettings(stored.value);
  }

  patchedSettings(patch: MakerMemorySettingsPatch): StoredMemorySettings {
    if (patch.makerEnabled === undefined && patch.backendEnabled === undefined) {
      throw new Error("Memory settings patch is empty.");
    }
    if (patch.backendEnabled !== undefined && !validId(patch.backendId)) {
      throw new Error("Backend memory settings require a valid Backend ID.");
    }
    const current = this.settings();
    return {
      format: 1,
      makerEnabled: patch.makerEnabled ?? current.makerEnabled,
      backendEnabled: patch.backendEnabled === undefined
        ? current.backendEnabled
        : { ...current.backendEnabled, [patch.backendId!]: patch.backendEnabled }
    };
  }

  /** Re-fences future runtimes after the caller has durably committed settings. */
  async reconcileSettingsChange(): Promise<boolean> {
    this.#generation += 1;
    try {
      await this.#onSettingsChanged();
      return true;
    } catch {
      return false;
    }
  }

  snapshot(backends: readonly MakerMemoryBackendRole[]): MakerMemorySnapshot {
    const settings = this.settings();
    const backendEnabled = Object.fromEntries(
      backends.map(({ backendId }) => [backendId, settings.backendEnabled[backendId] ?? true])
    );
    const backendEntryCount = Object.fromEntries(
      backends.map(({ backendId }) => [backendId, this.#store.countMakerMemoryEntries("digest", backendId)])
    );
    return {
      makerEnabled: settings.makerEnabled,
      customized: this.#store.findSetting("service", this.#scopeId, MAKER_MEMORY_SETTING_KEY) !== undefined,
      entryCount: this.#store.countMakerMemoryEntries(),
      backendEnabled,
      backendEntryCount
    };
  }

  enabledForBackend(backendId: string): boolean {
    const settings = this.settings();
    return settings.makerEnabled && (settings.backendEnabled[backendId] ?? true);
  }

  async update(patch: MakerMemorySettingsPatch): Promise<MakerMemorySnapshot> {
    const next = this.patchedSettings(patch);
    // Persist before refreshing any Adapter generation. A failed refresh never
    // loses the owner's durable choice; active runtimes retain their snapshot.
    this.#store.setSetting("service", this.#scopeId, MAKER_MEMORY_SETTING_KEY, next);
    await this.reconcileSettingsChange();
    return this.snapshot(Object.keys(next.backendEnabled).map((backendId) => ({ backendId, role: "compaction_digest" })));
  }

  async restoreDefaults(): Promise<MakerMemorySnapshot> {
    this.#store.deleteSetting("service", this.#scopeId, MAKER_MEMORY_SETTING_KEY);
    await this.reconcileSettingsChange();
    return this.snapshot([]);
  }

  reset(kind: "curated" | "backend", backendId?: string): { readonly removedEntries: number; readonly removedTargets: number } {
    if (kind === "curated") return this.#store.resetMakerMemory("curated");
    if (!validId(backendId)) throw new Error("Backend memory reset requires a valid Backend ID.");
    return this.#store.resetMakerMemory("digest", backendId);
  }

  /** Curated startup snapshot. Digest is deliberately omitted. */
  runtimePrompt(targetId: string): string | undefined {
    if (!this.settings().makerEnabled) return undefined;
    const entries = this.list(targetId)
      .filter((entry) => entry.kind !== "digest");
    const index = entries.length === 0
      ? "(No curated memory has been saved for this workspace.)"
      : entries.map((entry) => `- [${entry.kind}] ${entry.title} — ${entry.description} (id: ${entry.id})`).join("\n");
    return `${MEMORY_RULES}\n\n## Current index\n\n${truncateUtf8(index, 4_096)}`;
  }

  /** Best-effort compaction sink. Content is never copied to Events or logs. */
  writeCompactionDigest(input: {
    readonly backendId: string;
    readonly targetId: string;
    readonly sessionId: string;
    readonly summary: string;
    readonly reason: string;
  }): boolean {
    if (!this.enabledForBackend(input.backendId)) return false;
    const body = truncateUtf8(input.summary.trim(), 7_000);
    if (body === "") return false;
    try {
      this.#store.putMakerMemoryEntry({
        targetId: input.targetId,
        kind: "digest",
        backendId: input.backendId,
        slug: `digest-${safeSlug(input.sessionId, 24)}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`.slice(0, 64),
        title: `${singleLine(input.backendId, 32)} compaction digest (${singleLine(input.reason, 40)})`.slice(0, 100),
        description: singleLine(body, 180),
        body,
        mode: "create"
      });
      return true;
    } catch {
      // Compaction must complete even when memory storage is unavailable or a
      // credential-shaped summary is rejected. Do not log private content.
      return false;
    }
  }

  list(targetId: string): readonly MakerMemoryEntry[] {
    const entries: MakerMemoryEntry[] = [];
    for (;;) {
      const page = this.#store.listMakerMemoryEntries({
        targetId,
        limit: MEMORY_SCAN_PAGE_SIZE,
        offset: entries.length
      });
      entries.push(...page);
      if (page.length < MEMORY_SCAN_PAGE_SIZE) return entries;
    }
  }

  read(targetId: string, id: string): MakerMemoryEntry {
    const entry = this.#store.getMakerMemoryEntry(id);
    if (entry.targetId !== targetId) throw new Error("Memory entry is outside this workspace scope.");
    return entry;
  }

  search(targetId: string, query: string, kind?: MakerMemoryKind): readonly MakerMemorySearchHit[] {
    return this.#store.searchMakerMemory(targetId, query, { ...(kind === undefined ? {} : { kind }), limit: 10 });
  }

  write(targetId: string, input: {
    readonly kind: Exclude<MakerMemoryKind, "digest">;
    readonly name: string;
    readonly title: string;
    readonly description: string;
    readonly body: string;
    readonly mode?: "create" | "update" | "append";
  }): MakerMemoryEntry {
    if (!this.settings().makerEnabled) throw new Error("Maker Memory is disabled.");
    return this.#store.putMakerMemoryEntry({
      targetId,
      kind: input.kind,
      slug: input.name,
      title: input.title,
      description: input.description,
      body: input.body,
      ...(input.mode === undefined ? {} : { mode: input.mode })
    });
  }

  delete(targetId: string, id: string): boolean {
    this.read(targetId, id);
    return this.#store.deleteMakerMemoryEntry(id);
  }
}

export const MAKER_MEMORY_TOOLS: readonly McpToolDescriptor[] = [
  tool("memory_list", "List private workspace memory metadata. Digests are included but never auto-injected.", objectSchema({}), false),
  tool("memory_read", "Read one private workspace memory entry by opaque ID.", objectSchema({
    entry_id: stringProperty("Opaque entry ID returned by memory_list or memory_search.")
  }, ["entry_id"]), false),
  tool("memory_search", "Search curated memory and compression digests for this workspace.", objectSchema({
    query: stringProperty("Keyword query (1-256 characters)."),
    type: { type: "string", enum: ["user", "feedback", "project", "reference", "digest"] }
  }, ["query"]), false),
  tool("memory_write", "Create, update, or append a curated private workspace memory entry. Digest is system-only.", objectSchema({
    type: { type: "string", enum: [...CURATED_KINDS] },
    name: stringProperty("Stable lowercase filename slug without an extension."),
    title: stringProperty("Short display title."),
    description: stringProperty("One-line index hook."),
    body: stringProperty("Markdown body. Never include credentials."),
    mode: { type: "string", enum: ["create", "update", "append"] }
  }, ["type", "name", "title", "description", "body"]), true),
  tool("memory_delete", "Delete one private workspace memory entry by opaque ID.", objectSchema({
    entry_id: stringProperty("Opaque entry ID returned by memory_list or memory_search.")
  }, ["entry_id"]), true)
];

export class MakerMemoryBridgeProvider implements BridgeToolProvider {
  readonly id = MAKER_MEMORY_PROVIDER_ID;
  readonly tools = MAKER_MEMORY_TOOLS;
  readonly #memory: MakerMemoryController;

  constructor(memory: MakerMemoryController) {
    this.#memory = memory;
  }

  get generation(): number { return this.#memory.generation; }
  get available(): boolean { return this.#memory.available; }

  async callTool(
    name: string,
    input: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    context: BridgeToolCallContext
  ): Promise<McpCallResult> {
    signal?.throwIfAborted();
    const targetId = context.targetId;
    switch (name) {
      case "memory_list":
        return privateResult({ entries: this.#memory.list(targetId).map((entry) => publicEntry(entry)) });
      case "memory_read":
        return privateResult({ entry: publicEntry(this.#memory.read(targetId, requiredString(input, "entry_id", 512)), true) });
      case "memory_search": {
        const kind = input["type"] === undefined ? undefined : memoryKind(input["type"], true);
        return privateResult({ hits: this.#memory.search(targetId, requiredString(input, "query", 256), kind) });
      }
      case "memory_write": {
        const kind = memoryKind(input["type"], false);
        const entry = this.#memory.write(targetId, {
          kind,
          name: requiredString(input, "name", 64),
          title: requiredString(input, "title", 100),
          description: requiredString(input, "description", 200),
          body: requiredString(input, "body", 8_192),
          ...(input["mode"] === undefined ? {} : { mode: writeMode(input["mode"]) })
        });
        return privateResult({ entry: publicEntry(entry) });
      }
      case "memory_delete":
        return privateResult({ deleted: this.#memory.delete(targetId, requiredString(input, "entry_id", 512)) });
      default:
        throw new Error("Memory bridge tool is not available in this generation.");
    }
  }
}

function defaults(): StoredMemorySettings {
  return { format: 1, makerEnabled: true, backendEnabled: {} };
}

function validateStoredSettings(value: unknown): StoredMemorySettings {
  if (!isRecord(value) || value["format"] !== 1 || typeof value["makerEnabled"] !== "boolean" || !isRecord(value["backendEnabled"])) {
    throw new Error("Stored memory settings have an unsupported format.");
  }
  const backendEnabled: Record<string, boolean> = {};
  for (const [id, enabled] of Object.entries(value["backendEnabled"])) {
    if (!validId(id) || typeof enabled !== "boolean") throw new Error("Stored memory Backend settings are invalid.");
    backendEnabled[id] = enabled;
  }
  return { format: 1, makerEnabled: value["makerEnabled"], backendEnabled };
}

function publicEntry(entry: MakerMemoryEntry, includeBody = false): Readonly<Record<string, unknown>> {
  return {
    id: entry.id,
    type: entry.kind,
    title: entry.title,
    description: entry.description,
    ...(entry.backendId === undefined ? {} : { backend_id: entry.backendId }),
    updated_at: new Date(entry.updatedAt).toISOString(),
    ...(includeBody ? { body: entry.body } : {})
  };
}

function privateResult(value: Readonly<Record<string, unknown>>): McpCallResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false
  };
}

function objectSchema(
  properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  required: readonly string[] = []
): Readonly<Record<string, unknown>> {
  return { type: "object", properties, required, additionalProperties: false };
}

function stringProperty(description: string): Readonly<Record<string, unknown>> {
  return { type: "string", description };
}

function tool(
  name: string,
  description: string,
  inputSchema: Readonly<Record<string, unknown>>,
  requiresPermission: boolean
): McpToolDescriptor {
  return { serverId: MAKER_MEMORY_PROVIDER_ID, name, description, inputSchema, requiresPermission };
}

function requiredString(value: Readonly<Record<string, unknown>>, key: string, maximumLength: number): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.trim() === "" || candidate.length > maximumLength || candidate.includes("\0")) {
    throw new Error(`Memory tool argument '${key}' is invalid.`);
  }
  return candidate;
}

function memoryKind(value: unknown, allowDigest: true): MakerMemoryKind;
function memoryKind(value: unknown, allowDigest: false): Exclude<MakerMemoryKind, "digest">;
function memoryKind(value: unknown, allowDigest: boolean): MakerMemoryKind {
  if (value === "user" || value === "feedback" || value === "project" || value === "reference" || (allowDigest && value === "digest")) return value;
  throw new Error("Memory type is invalid.");
}

function writeMode(value: unknown): "create" | "update" | "append" {
  if (value === "create" || value === "update" || value === "append") return value;
  throw new Error("Memory write mode is invalid.");
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
}

function safeSlug(value: string, maximum: number): string {
  const slug = value.toLocaleLowerCase("en").replace(/[^a-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return (slug || "session").slice(0, maximum);
}

function singleLine(value: string, maximum: number): string {
  const line = value.replace(/[\r\n\t]+/gu, " ").replace(/\s+/gu, " ").trim();
  return (line || "compaction").slice(0, maximum);
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(`${value.slice(0, middle)}…`, "utf8") <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
