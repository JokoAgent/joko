import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import type { OperationalStore } from "@joko/store";

import type { ArtifactRecord, ArtifactStore } from "./artifact-store.js";
import type { CredentialManager } from "./credential-manager.js";

export type DiagnosticsBundleLevel = "minimal" | "standard" | "verbose";

const DIAGNOSTIC_SCAN_PAGE_SIZE = 10_000;
const SANITIZED_COLLECTION_ITEM_LIMIT = 10_000;

export interface DiagnosticsBundleOptions {
  readonly store: OperationalStore;
  readonly artifacts: ArtifactStore;
  readonly credentials: CredentialManager;
  readonly serviceVersion: string;
  readonly now?: () => number;
  /** Collector output is always passed through the same bounded redactor. */
  readonly collectors?: Readonly<Record<string, () => unknown | Promise<unknown>>>;
  readonly maximumBundleBytes?: number;
}

export interface CreateDiagnosticsBundleInput {
  readonly level: DiagnosticsBundleLevel;
  readonly diagnosticIds?: readonly string[];
}

/** Creates a JSON diagnostic artifact from an explicit, redacted allowlist. */
export class DiagnosticsBundleService {
  readonly #store: OperationalStore;
  readonly #artifacts: ArtifactStore;
  readonly #credentials: CredentialManager;
  readonly #serviceVersion: string;
  readonly #now: () => number;
  readonly #collectors: Readonly<Record<string, () => unknown | Promise<unknown>>>;
  readonly #maximumBundleBytes: number;

  constructor(options: DiagnosticsBundleOptions) {
    this.#store = options.store;
    this.#artifacts = options.artifacts;
    this.#credentials = options.credentials;
    this.#serviceVersion = nonBlank(options.serviceVersion, "Orchestrator version");
    this.#now = options.now ?? Date.now;
    this.#collectors = options.collectors ?? {};
    this.#maximumBundleBytes = options.maximumBundleBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(this.#maximumBundleBytes) || this.#maximumBundleBytes < 64 * 1024) {
      throw new RangeError("Diagnostics bundle size limit is invalid.");
    }
  }

  async create(input: CreateDiagnosticsBundleInput): Promise<ArtifactRecord> {
    validateLevel(input.level);
    const now = this.#now();
    const snapshot = this.#store.getSnapshot(now);
    const health = this.#store.health();
    const selected = this.#selectDiagnostics(input.diagnosticIds);
    const settings = this.#store.listSettings().map((setting) => ({
      scopeType: setting.scopeType,
      scopeIdFingerprint: fingerprint(setting.scopeId),
      key: setting.key,
      updatedAt: setting.updatedAt,
      revision: setting.revision.toString(10)
      // Setting values are intentionally excluded, including encrypted or
      // reference-bearing configuration.
    }));
    const bundle: Record<string, unknown> = {
      schema: "joko.orchestrator.diagnostics.v1",
      generatedAt: new Date(now).toISOString(),
      level: input.level,
      service: {
        version: this.#serviceVersion,
        nodeVersion: process.versions.node,
        platform: process.platform,
        architecture: process.arch,
        uptimeSeconds: Math.floor(process.uptime())
      },
      store: {
        healthy: health.foreignKeys && health.journalMode.toLowerCase() === "wal",
        schemaVersion: health.schemaVersion,
        journalMode: health.journalMode,
        foreignKeys: health.foreignKeys,
        revision: snapshot.revision.toString(10),
        globalEventCursor: snapshot.globalCursor.toString(10),
        counts: {
          connections: snapshot.connections.length,
          backends: snapshot.backends.length,
          targets: snapshot.targets.length,
          sessions: snapshot.sessions.length,
          activeRuns: snapshot.activeRuns.length,
          openInteractions: snapshot.openInteractions.length,
          dueSchedules: snapshot.dueSchedules.length,
          activeToolLeases: this.#store.listToolLeases({ activeOnly: true }).length
        }
      },
      backends: snapshot.backends.map((backend) => ({
        id: backend.descriptor.id,
        displayName: backend.descriptor.displayName,
        version: backend.descriptor.version,
        health: backend.descriptor.health,
        installationState: backend.descriptor.installationState,
        authenticationState: backend.descriptor.authenticationState,
        capabilities: [...backend.descriptor.capabilities.entries()].map(([id, capability]) => ({ id, supported: capability.supported, reason: capability.reason })),
        revision: backend.revision.toString(10)
      })),
      runStates: countBy(snapshot.activeRuns.map((run) => run.descriptor.state)),
      diagnostics: selected.map((diagnostic) => ({
        id: diagnostic.id,
        severity: diagnostic.severity,
        component: diagnostic.component,
        code: diagnostic.code,
        message: input.level === "minimal" ? "[omitted at minimal level]" : diagnostic.message,
        ...(input.level === "verbose" ? { details: diagnostic.details } : {}),
        createdAt: diagnostic.createdAt,
        revision: diagnostic.revision.toString(10)
      })),
      settings
    };
    if (input.level === "verbose") {
      const collectorOutput: Record<string, unknown> = {};
      for (const [name, collector] of Object.entries(this.#collectors).sort(([left], [right]) => left.localeCompare(right, "en"))) {
        try { collectorOutput[safeCollectorName(name)] = await collector(); }
        catch (error) { collectorOutput[safeCollectorName(name)] = { error: error instanceof Error ? error.name : "CollectorError" }; }
      }
      bundle["collectors"] = collectorOutput;
    }
    const sanitized = sanitizeDiagnostic(bundle, (text) => this.#credentials.redactText(text), 0, new Set());
    const body = Buffer.from(JSON.stringify(sanitized, null, 2) + "\n", "utf8");
    if (body.byteLength > this.#maximumBundleBytes) throw new Error("Redacted diagnostics bundle exceeds its size limit.");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const fileName = `joko-diagnostics-${new Date(now).toISOString().replace(/[:.]/gu, "-")}.json`;
    const ticket = await this.#artifacts.createUploadTicket({
      expectedSha256: sha256,
      expectedSize: body.byteLength,
      maximumSize: this.#maximumBundleBytes,
      mimeType: "application/json",
      fileName
    });
    const artifact = await this.#artifacts.acceptUpload(ticket.ticketId, ticket.secret, Readable.from([body]));
    this.#store.appendDiagnostic({
      severity: "info",
      component: "diagnostics",
      code: "DIAGNOSTICS_BUNDLE_CREATED",
      message: "A redacted diagnostics bundle was created.",
      details: { artifactId: artifact.id, byteLength: artifact.byteLength, level: input.level },
      createdAt: now
    });
    return artifact;
  }

  #selectDiagnostics(ids: readonly string[] | undefined) {
    if (ids !== undefined && ids.length > 0) {
      const requested = new Set(ids.map((id) => nonBlank(id, "Diagnostic ID")));
      try {
        return [...requested].map((id) => this.#store.getDiagnostic(id));
      } catch {
        throw new Error("One or more requested diagnostics do not exist.");
      }
    }
    const diagnostics: ReturnType<OperationalStore["listDiagnostics"]> = [];
    for (;;) {
      const page = this.#store.listDiagnostics({
        limit: DIAGNOSTIC_SCAN_PAGE_SIZE,
        offset: diagnostics.length
      });
      diagnostics.push(...page);
      if (page.length < DIAGNOSTIC_SCAN_PAGE_SIZE) return diagnostics;
    }
  }
}

const SENSITIVE_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|authorization|password|passwd|secret|client[_-]?secret|private[_-]?key|cookie|credentials?|ciphertext|nonce|auth[_-]?header)/iu;
const BEARER = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/giu;
const SECRET_ASSIGNMENT = /\b(?:api[_-]?key|token|secret|password|authorization|cookie)\s*[:=]\s*[^\s,;]+/giu;
const HOME_PATH = /(?:[A-Za-z]:\\Users\\[^\\\s]+|\/(?:home|Users)\/[^/\s]+)/gu;

function sanitizeDiagnostic(
  value: unknown,
  redactCredential: (text: string) => string,
  depth: number,
  seen: Set<object>,
  key?: string
): unknown {
  if (key !== undefined && SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (depth > 12) return "[truncated:depth]";
  if (value === null || value === undefined || typeof value === "boolean") return value ?? null;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "string") return boundedDiagnosticText(redactText(redactCredential(value)), 32_768);
  if (value instanceof Uint8Array) return `[binary:${value.byteLength}]`;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: redactText(redactCredential(value.message)) };
  if (typeof value !== "object") return redactText(redactCredential(String(value)));
  if (seen.has(value)) return "[truncated:cycle]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const selected = value.slice(0, SANITIZED_COLLECTION_ITEM_LIMIT)
        .map((item) => sanitizeDiagnostic(item, redactCredential, depth + 1, seen));
      if (value.length > SANITIZED_COLLECTION_ITEM_LIMIT) {
        selected.push(`[truncated:${value.length - SANITIZED_COLLECTION_ITEM_LIMIT} items]`);
      }
      return selected;
    }
    const result: Record<string, unknown> = {};
    const properties = Object.keys(value).sort();
    for (const property of properties.slice(0, SANITIZED_COLLECTION_ITEM_LIMIT)) {
      result[property] = sanitizeDiagnostic((value as Record<string, unknown>)[property], redactCredential, depth + 1, seen, property);
    }
    if (properties.length > SANITIZED_COLLECTION_ITEM_LIMIT) {
      result["[truncated:properties]"] = properties.length - SANITIZED_COLLECTION_ITEM_LIMIT;
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function redactText(value: string): string {
  return value
    .replace(BEARER, "[REDACTED]")
    .replace(SECRET_ASSIGNMENT, "[REDACTED]")
    .replace(HOME_PATH, "[HOME]");
}

function boundedDiagnosticText(value: string, maximumCharacters: number): string {
  return value.length <= maximumCharacters ? value : `${value.slice(0, maximumCharacters - 1)}…`;
}

function fingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function countBy(values: readonly string[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function validateLevel(level: DiagnosticsBundleLevel): void {
  if (!(["minimal", "standard", "verbose"] as const).includes(level)) throw new Error("Diagnostics bundle level is invalid.");
}

function safeCollectorName(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 128);
  return normalized === "" ? "collector" : normalized;
}

function nonBlank(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized === "" || normalized.includes("\0")) throw new Error(`${label} must not be blank.`);
  return normalized;
}
