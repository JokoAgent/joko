import type { AdapterContext, PromptInput, RuntimeResource } from "@joko/core";
import { claudeCodeError } from "./errors.js";

const MAXIMUM_RESOURCE_IDENTITY_BYTES = 4_096;
const MAXIMUM_RESOURCE_NAME_BYTES = 4_096;
const MAXIMUM_RESOURCE_VERSION_BYTES = 4_096;
const MAXIMUM_RESOURCE_CONTENT_BYTES = 256 * 1024;
const MAXIMUM_RUNTIME_RESOURCE_BYTES = 256 * 1024 * 1024;
const MAXIMUM_RUNTIME_RESOURCES = 4_096;
const MAXIMUM_UINT64 = 18_446_744_073_709_551_615n;

export interface ClaudeTextResourceSeed {
  readonly id: string;
  readonly kind: "skill" | "prompt";
  readonly name: string;
  readonly revision: string;
  readonly resourceVersion: bigint;
  readonly version?: string;
  /** Service-owned, approved content copied before this runtime starts. */
  readonly content: string;
  /** Revalidates the exact managed-resource record without exposing its path. */
  readonly assertCurrent: () => void;
}

export type ClaudeTextResourceResolver = (
  context: AdapterContext,
  signal: AbortSignal
) => readonly ClaudeTextResourceSeed[] | Promise<readonly ClaudeTextResourceSeed[]>;

export interface ClaudeRuntimeTextResource extends ClaudeTextResourceSeed {
  readonly runtimeGeneration: number;
}

type ResourceMention = Extract<PromptInput["mentions"][number], { readonly kind: "resource" }>;

export interface ResolvedClaudeResourceMention {
  readonly text: string;
  readonly assertCurrent: () => void;
}

/**
 * Copies a service-approved text catalog into one native runtime generation.
 * Strings are immutable values, so the runtime retains no service filesystem
 * path and never re-reads mutable source content while dispatching a mention.
 */
export function snapshotClaudeTextResources(
  value: readonly ClaudeTextResourceSeed[],
  runtimeGeneration: number,
  lifetimeSignal: AbortSignal
): readonly ClaudeRuntimeTextResource[] {
  if (!Array.isArray(value) || value.length > MAXIMUM_RUNTIME_RESOURCES) {
    throw catalogError("The approved text resource catalog exceeds its runtime limit.");
  }
  if (!Number.isSafeInteger(runtimeGeneration) || runtimeGeneration < 1) {
    throw catalogError("The text resource runtime generation is invalid.");
  }
  const ids = new Set<string>();
  const resources: ClaudeRuntimeTextResource[] = [];
  let totalBytes = 0;
  for (const seed of value) {
    lifetimeSignal.throwIfAborted();
    validateSeed(seed);
    if (ids.has(seed.id)) throw catalogError("The approved text resource catalog contains duplicate identities.");
    ids.add(seed.id);
    const authority = seed.assertCurrent;
    assertAuthorityCurrent(
      authority,
      lifetimeSignal,
      "RESOURCE_CATALOG_STALE",
      "An approved text resource changed during runtime assembly.",
      "session_start"
    );
    const content = `${seed.content}`;
    const contentBytes = Buffer.byteLength(content, "utf8");
    totalBytes += contentBytes;
    if (contentBytes > MAXIMUM_RESOURCE_CONTENT_BYTES || totalBytes > MAXIMUM_RUNTIME_RESOURCE_BYTES) {
      throw catalogError("Approved text resource content exceeds its runtime limit.");
    }
    const resource = Object.freeze({
      id: seed.id,
      kind: seed.kind,
      name: seed.name,
      revision: seed.revision,
      resourceVersion: seed.resourceVersion,
      ...(seed.version === undefined ? {} : { version: seed.version }),
      content,
      runtimeGeneration,
      assertCurrent: (): void => {
        assertAuthorityCurrent(
          authority,
          lifetimeSignal,
          "RESOURCE_MENTION_STALE",
          "The referenced resource is no longer current.",
          "input"
        );
      }
    });
    resource.assertCurrent();
    resources.push(resource);
  }
  return Object.freeze(resources);
}

export function loadedClaudeTextResources(
  resources: readonly ClaudeRuntimeTextResource[]
): readonly RuntimeResource[] {
  return resources.flatMap((resource) => {
    try {
      resource.assertCurrent();
    } catch {
      return [];
    }
    return [{
      id: resource.id,
      kind: resource.kind,
      name: resource.name,
      source: "managed",
      state: "loaded" as const,
      revision: resource.revision,
      resourceVersion: resource.resourceVersion,
      runtimeGeneration: resource.runtimeGeneration,
      ...(resource.version === undefined ? {} : { version: resource.version })
    }];
  });
}

export function resolveClaudeResourceMention(
  mention: ResourceMention,
  resources: readonly ClaudeRuntimeTextResource[] | undefined
): ResolvedClaudeResourceMention {
  if (resources === undefined) {
    throw inputError("MENTION_KIND_UNSUPPORTED", "Resource mentions require a service-owned text resource resolver.");
  }
  if (!validIdentity(mention.reference)
    || !validIdentity(mention.discoveredRevision)
    || !/^[1-9][0-9]*$/u.test(mention.resourceVersion)
    || mention.resourceVersion.length > 20
    || BigInt(mention.resourceVersion) > MAXIMUM_UINT64
    || !Number.isSafeInteger(mention.runtimeGeneration)
    || mention.runtimeGeneration < 1) {
    throw inputError("RESOURCE_REFERENCE_INVALID", "A resource mention requires a complete bounded runtime identity.");
  }
  const matching = resources.filter((resource) => resource.id === mention.reference);
  const resource = matching.length === 1 ? matching[0] : undefined;
  if (resource === undefined
    || resource.revision !== mention.discoveredRevision
    || resource.resourceVersion.toString(10) !== mention.resourceVersion
    || resource.runtimeGeneration !== mention.runtimeGeneration) {
    throw inputError("RESOURCE_MENTION_STALE", "The referenced resource is not the exact version loaded by this task runtime.");
  }
  resource.assertCurrent();
  const text = [
    `[Joko approved ${resource.kind} resource]`,
    `Name: ${JSON.stringify(resource.name)}`,
    "Content:",
    resource.content,
    `[End Joko approved ${resource.kind} resource]`
  ].join("\n");
  if (Buffer.byteLength(text, "utf8") > MAXIMUM_RESOURCE_CONTENT_BYTES + MAXIMUM_RESOURCE_NAME_BYTES + 256) {
    throw inputError("RESOURCE_CONTENT_TOO_LARGE", "The referenced resource exceeds the native input limit.");
  }
  return { text, assertCurrent: resource.assertCurrent };
}

function validateSeed(seed: ClaudeTextResourceSeed): void {
  if (typeof seed !== "object" || seed === null
    || !validIdentity(seed.id)
    || (seed.kind !== "skill" && seed.kind !== "prompt")
    || !validText(seed.name, MAXIMUM_RESOURCE_NAME_BYTES, false)
    || !validIdentity(seed.revision)
    || typeof seed.resourceVersion !== "bigint"
    || seed.resourceVersion < 1n
    || seed.resourceVersion > MAXIMUM_UINT64
    || (seed.version !== undefined && !validText(seed.version, MAXIMUM_RESOURCE_VERSION_BYTES, false))
    || typeof seed.content !== "string"
    || seed.content.includes("\u0000")
    || typeof seed.assertCurrent !== "function") {
    throw catalogError("The approved text resource catalog contains an invalid entry.");
  }
}

function validIdentity(value: unknown): value is string {
  return validText(value, MAXIMUM_RESOURCE_IDENTITY_BYTES, false);
}

function validText(value: unknown, maximumBytes: number, allowEmpty: boolean): value is string {
  return typeof value === "string"
    && (allowEmpty || value.length > 0)
    && value === value.trim()
    && Buffer.byteLength(value, "utf8") <= maximumBytes
    && !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value);
}

function assertAuthorityCurrent(
  authority: () => void,
  signal: AbortSignal,
  code: string,
  message: string,
  phase: "input" | "session_start"
): void {
  try {
    signal.throwIfAborted();
    authority();
    signal.throwIfAborted();
  } catch {
    throw claudeCodeError(code, message, phase, {
      recovery: "Refresh this task's resource catalog and select the approved resource again."
    });
  }
}

function catalogError(message: string) {
  return claudeCodeError("RESOURCE_CATALOG_INVALID", message, "session_start", {
    recovery: "Repair the approved resource catalog and restart this native Session."
  });
}

function inputError(code: string, message: string) {
  return claudeCodeError(code, message, "input", {
    recovery: "Refresh this task's resource catalog and select the approved resource again."
  });
}
