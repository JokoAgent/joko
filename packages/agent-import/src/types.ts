/** Native source identifiers are interoperability values, independent of a Backend. */
export type AgentImportSourceKind = "hermes" | "openclaw" | "package";
export type AgentImportCategory = "personality" | "memory" | "skills" | "connections" | "automations";

/** Safe domain projections are mapped into generated contracts at the service boundary. */
export interface AgentImportSource {
  readonly id: string;
  readonly kind: AgentImportSourceKind;
  readonly name: string;
}

export interface AgentImportEntry {
  readonly id: string;
  readonly category: AgentImportCategory;
  readonly name: string;
  readonly description?: string;
  readonly selected: boolean;
  readonly enabled?: boolean;
  readonly dependsOn?: readonly string[];
  readonly exclusiveWith?: readonly string[];
  readonly issues?: readonly string[];
}

export interface AgentImportPreview {
  readonly id: string;
  readonly source: AgentImportSource;
  readonly name: string;
  readonly avatarImageBase64?: string;
  readonly entries: readonly AgentImportEntry[];
}

export interface AgentImportSelection {
  readonly previewId: string;
  readonly requestId: string;
  readonly name: string;
  readonly avatarImageBase64?: string;
  readonly entryIds: readonly string[];
  readonly entryRanges?: ReadonlyArray<readonly [number, number]>;
  readonly takeover: boolean;
  readonly deferSetup: boolean;
}

export interface AgentImportCheck {
  readonly entryId: string;
  readonly status: "copied" | "verified" | "needs-attention" | "taken-over" | "paused";
  readonly message?: string;
  readonly progress?: { readonly saved: number; readonly total: number };
}

export interface AgentImportResult {
  readonly requestId: string;
  readonly partnerId: string;
  readonly canonicalSessionId?: string;
  readonly status: "running" | "complete" | "needs-attention";
  readonly checks: readonly AgentImportCheck[];
  readonly saved: boolean;
  readonly savedEntryIds: readonly string[];
}

/** Host-only paths and material. None of these shapes cross a public RPC boundary. */
export interface ImportSource {
  kind: AgentImportSourceKind;
  agentId: string;
  name: string;
  root: string;
  workspace: string;
  configFile: string;
}

export interface ImportFile {
  /** Relative path within the selected item, never a client-supplied destination. */
  name: string;
  bytes: Buffer;
  executable: boolean;
  /** Host-validated native Python interpreter; retain its runtime/library location. */
  interpreterLink?: string;
}

export interface ImportedMcpServer {
  name: string;
  enabled?: boolean;
  command?: string;
  args?: string[];
  /** Host-only source working directory; references resolve after selection. */
  cwd?: string;
  url?: string;
  transport?: 'stdio' | 'sse' | 'http';
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface ImportedDelivery { connectionId: string; chatId: string; threadId?: number }

export type ImportedRoutineTrigger =
  | { id: string; kind: "cron"; expression: string; timezone: string }
  | { id: string; kind: "interval"; intervalMs: number; anchorMs?: number }
  | { id: string; kind: "once"; at: number }
  | { id: string; kind: "event"; sourceId: string; eventType: string;
      filters: Array<{ field: string; operator: "equals" | "contains" | "not-equals"; value: string }> };

export interface ImportedRoutineInput {
  name: string;
  prompt: string;
  enabled: boolean;
  triggers: ImportedRoutineTrigger[];
  silentWhenIdle: boolean;
  preRunHook?: { command: string; timeoutMs?: number };
}

/** Private, host-only content. Do not serialize this into IPC, logs or model messages. */
export interface ImportItem {
  view: { -readonly [Key in keyof AgentImportEntry]: AgentImportEntry[Key] };
  /** Stable index in the originating preview, retained in selected-only checkpoints. */
  sourceIndex?: number;
  files?: ImportFile[];
  sourceDirectory?: string;
  sourceAlias?: string;
  /** Failed document or subtree read; retained for an explicit retry. */
  sourceFile?: { root: string; file: string; kind: 'file' | 'directory' | 'unknown'; logicalPrefix?: string; sharedDocumentRoots?: string[] };
  /** Recovered subtree documents stay under the original selected entry/receipt. */
  documents?: Array<{ id: string; name: string; text: string; role?: 'user' }>;
  /** Selected skill resources have been captured for copying, verification and restart. */
  filesComplete?: boolean;
  /** Item-level capture failure retained for a later retry, without discarding healthy siblings. */
  captureIssue?: string;
  text?: string;
  role?: 'identity' | 'user' | 'instructions';
  env?: Record<string, string>;
  /** Variable requirements are separate from mandatory entries: profiles are alternatives. */
  envDependencies?: { names: string[]; entries: string[] };
  mcp?: ImportedMcpServer;
  credential?: { format: string; value: unknown };
  asset?: { name: string; bytes: Buffer; executable?: boolean };
  automation?: {
    sourceId: string;
    input: ImportedRoutineInput;
    original: Record<string, unknown>;
    /** Native schedule state fingerprint used before source handover. */
    fingerprint: string;
    deliveries: ImportedDelivery[];
  };
}

export interface ImportSnapshot {
  source: ImportSource;
  items: ImportItem[];
  avatarImageBase64?: string;
  fingerprint: string;
  /** Private restart masks for values already embedded in selected source content. */
  publicationRedactions?: Record<string, string>;
  nativePackage?: { packageId: string; packageVersion: string; packageHash: string; description: string; avatarPreset: "orbit" | "spark" | "leaf" | "wave"; locale?: string;
    opening: { welcome: string; capabilities: string[]; onboardingSkill?: string; starterOptions?: string[] } };
}

export class AgentImportError extends Error {
  constructor(readonly code: string) { super(code); this.name = "AgentImportError"; }
}

export function validateNativePartnerPackage(value: unknown): asserts value is NonNullable<ImportSnapshot["nativePackage"]> {
  const valid = (input: unknown): input is Record<string, unknown> => !!input && typeof input === "object" && !Array.isArray(input);
  const text = (input: unknown, max: number): input is string => typeof input === "string" && input.length > 0 && input.length <= max && !input.includes("\0");
  if (!valid(value) || Object.keys(value).some(key => !["packageId", "packageVersion", "packageHash", "description", "opening", "locale", "avatarPreset"].includes(key))
    || !text(value.packageId, 100) || !/^[a-z0-9-]+$/.test(value.packageId) || !text(value.packageVersion, 40)
    || !text(value.packageHash, 64) || !/^[a-f0-9]{64}$/.test(value.packageHash) || !text(value.description, 12_000)
    || !["orbit", "spark", "leaf", "wave"].includes(String(value.avatarPreset))
    || value.locale !== undefined && !text(value.locale, 30) || !valid(value.opening)) throw new AgentImportError("INVALID_PACKAGE");
  const opening = value.opening;
  if (Object.keys(opening).some(key => !["welcome", "capabilities", "onboardingSkill", "starterOptions"].includes(key))
    || !text(opening.welcome, 12_000) || !Array.isArray(opening.capabilities) || opening.capabilities.length !== 3 || opening.capabilities.some(item => !text(item, 200))
    || opening.onboardingSkill !== undefined && !text(opening.onboardingSkill, 100)
    || opening.starterOptions !== undefined && (!Array.isArray(opening.starterOptions) || opening.starterOptions.length > 4 || opening.starterOptions.some(item => !text(item, 200)))) throw new AgentImportError("INVALID_PACKAGE");
}

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function string(value: unknown): string { return typeof value === "string" ? value : ""; }

/** Safe reasons only; native filesystem errors, diagnostics and source paths remain private. */
export function importFailureCode(error: unknown): string {
  if (error instanceof AgentImportError) return error.code;
  const code = (error as { code?: string } | null)?.code;
  const known: Readonly<Record<string, string>> = { ENOSPC: "IMPORT_DISK_FULL", EACCES: "IMPORT_PERMISSION_DENIED", EPERM: "IMPORT_PERMISSION_DENIED" };
  return code && known[code] || "IMPORT_ITEM_FAILED";
}
