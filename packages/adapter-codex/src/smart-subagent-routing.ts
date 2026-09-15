import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type {
  ManagedProviderSmartRoutingCandidate,
  ManagedProviderSmartRoutingRoute,
  ProviderModel
} from "@joko/core";

const SOURCE_FILE = "models_cache.json";
const MAXIMUM_SOURCE_BYTES = 16 * 1024 * 1024;
const MAXIMUM_GENERATED_BYTES = MAXIMUM_SOURCE_BYTES * 2;
const MAXIMUM_MODELS = 4_096;
const MAXIMUM_ADDITIONAL_MODELS = 8;
const NATIVE_V2_DEFAULTS = new Set(["gpt-5.6-sol", "gpt-5.6-terra"]);

interface CatalogRecord extends Record<string, unknown> {
  readonly slug: string;
  readonly multi_agent_version?: string | null;
  readonly priority?: number;
}

interface SmartCandidate {
  readonly providerId: string;
  readonly model: ProviderModel;
  readonly revision: string;
  readonly native: boolean;
}

export interface CodexSmartRoutingPreparation {
  readonly desired: boolean;
  readonly applied: boolean;
  readonly revision: string;
  readonly routes: readonly ManagedProviderSmartRoutingRoute[];
  /** Native Sol/Terra passthrough authority; excluded from the bounded additional-model menu. */
  readonly nativeRoutes: readonly ManagedProviderSmartRoutingRoute[];
  readonly launchArgs: readonly string[];
  readonly catalogPath?: string;
  /** Alternate exact generation used when native account authority is absent. */
  readonly managedOnly?: CodexSmartRoutingGeneration;
  /** Expected state for the same source when native account routes are excluded. */
  readonly managedOnlyInspection?: CodexSmartRoutingInspection;
  readonly unavailableReason: string;
  cleanup(): Promise<void>;
}

export interface CodexSmartRoutingGeneration {
  readonly revision: string;
  readonly routes: readonly ManagedProviderSmartRoutingRoute[];
  readonly nativeRoutes: readonly ManagedProviderSmartRoutingRoute[];
  readonly launchArgs: readonly string[];
  readonly catalogPath: string;
}

export interface CodexSmartRoutingInspection {
  readonly revision: string;
  readonly candidateCount: number;
  readonly unavailableReason: string;
}

export async function inspectCodexSmartRouting(input: {
  readonly desired: boolean;
  readonly codexHome: string;
  readonly nativeProviderId: string;
  readonly managedCandidates: readonly ManagedProviderSmartRoutingCandidate[];
  readonly includeNativeCandidates?: boolean;
}): Promise<CodexSmartRoutingInspection> {
  if (!input.desired) return { revision: "default", candidateCount: 0, unavailableReason: "" };
  let source: Awaited<ReturnType<typeof readNativeCatalog>>;
  try {
    source = await readNativeCatalog(input.codexHome);
  } catch {
    return { revision: unavailableRevision("unreadable", input.managedCandidates, input.includeNativeCandidates !== false), candidateCount: 0,
      unavailableReason: "The exact Codex native model catalog is unavailable or unsafe." };
  }
  let built: ReturnType<typeof buildCodexSmartModelCatalog>;
  try {
    built = buildCodexSmartModelCatalog(
      source.value,
      source.digest,
      input.nativeProviderId,
      input.managedCandidates,
      input.includeNativeCandidates !== false
    );
  } catch {
    built = undefined;
  }
  if (built === undefined) {
    return { revision: unavailableRevision(source.digest, input.managedCandidates, input.includeNativeCandidates !== false), candidateCount: 0,
      unavailableReason: "The Codex native model catalog has no compatible multi-agent template or authorized candidates." };
  }
  return { revision: built.revision, candidateCount: built.routes.length, unavailableReason: "" };
}

export async function prepareCodexSmartRouting(input: {
  readonly desired: boolean;
  readonly codexHome: string;
  readonly outputDirectory: string;
  readonly instanceGeneration: number;
  readonly nativeProviderId: string;
  readonly managedCandidates: readonly ManagedProviderSmartRoutingCandidate[];
}): Promise<CodexSmartRoutingPreparation> {
  if (!input.desired) return inactivePreparation(false, "default", "");
  let source: Awaited<ReturnType<typeof readNativeCatalog>>;
  try {
    source = await readNativeCatalog(input.codexHome);
  } catch {
    return inactivePreparation(true, unavailableRevision("unreadable", input.managedCandidates, true),
      "The exact Codex native model catalog is unavailable or unsafe.");
  }
  let built: ReturnType<typeof buildCodexSmartModelCatalog>;
  try {
    built = buildCodexSmartModelCatalog(source.value, source.digest, input.nativeProviderId, input.managedCandidates);
  } catch {
    return inactivePreparation(true, unavailableRevision(source.digest, input.managedCandidates, true),
      "The Codex native model catalog has no compatible multi-agent template or authorized candidates.");
  }
  if (built === undefined) {
    return inactivePreparation(true, unavailableRevision(source.digest, input.managedCandidates, true),
      "The Codex native model catalog has no compatible multi-agent template or authorized candidates.");
  }
  const managedOnlyBuilt = buildCodexSmartModelCatalog(
    source.value,
    source.digest,
    input.nativeProviderId,
    input.managedCandidates,
    false
  );
  const managedOnlyInspection: CodexSmartRoutingInspection = managedOnlyBuilt === undefined
    ? {
        revision: unavailableRevision(source.digest, input.managedCandidates, false),
        candidateCount: 0,
        unavailableReason: "The Codex native model catalog has no compatible authorized managed candidates."
      }
    : { revision: managedOnlyBuilt.revision, candidateCount: managedOnlyBuilt.routes.length, unavailableReason: "" };
  const catalogPaths: string[] = [];
  let generation: CodexSmartRoutingGeneration;
  let managedOnly: CodexSmartRoutingGeneration | undefined;
  try {
    const catalogPath = await writeGenerationCatalog(
      input.outputDirectory,
      input.instanceGeneration,
      JSON.stringify({ models: built.models }, null, 2) + "\n"
    );
    catalogPaths.push(catalogPath);
    generation = {
      revision: built.revision,
      routes: built.routes,
      nativeRoutes: built.nativeRoutes,
      catalogPath,
      launchArgs: buildCodexSmartRoutingLaunchArgs(catalogPath, built.routes)
    };
    if (managedOnlyBuilt !== undefined) {
      const managedCatalogPath = await writeGenerationCatalog(
        input.outputDirectory,
        input.instanceGeneration,
        JSON.stringify({ models: managedOnlyBuilt.models }, null, 2) + "\n"
      );
      catalogPaths.push(managedCatalogPath);
      managedOnly = {
        revision: managedOnlyBuilt.revision,
        routes: managedOnlyBuilt.routes,
        nativeRoutes: managedOnlyBuilt.nativeRoutes,
        catalogPath: managedCatalogPath,
        launchArgs: buildCodexSmartRoutingLaunchArgs(managedCatalogPath, managedOnlyBuilt.routes)
      };
    }
  } catch {
    await Promise.allSettled(catalogPaths.map(async (path) => await rm(path, { force: true })));
    return inactivePreparation(true, built.revision, "The generation-scoped Codex smart-routing catalog could not be installed safely.");
  }
  let cleaned = false;
  return {
    desired: true,
    applied: true,
    ...generation,
    ...(managedOnly === undefined ? {} : { managedOnly }),
    managedOnlyInspection,
    unavailableReason: "",
    cleanup: async () => {
      if (cleaned) return;
      await Promise.all(catalogPaths.map(async (path) => await rm(path, { force: true })));
      cleaned = true;
    }
  };
}

export function buildCodexSmartModelCatalog(
  value: unknown,
  sourceRevision: string,
  nativeProviderId: string,
  managedCandidates: readonly ManagedProviderSmartRoutingCandidate[],
  includeNativeCandidates = true
): {
  readonly models: readonly CatalogRecord[];
  readonly routes: readonly ManagedProviderSmartRoutingRoute[];
  readonly nativeRoutes: readonly ManagedProviderSmartRoutingRoute[];
  readonly revision: string;
} | undefined {
  if (!validId(nativeProviderId, 128) || !validId(sourceRevision, 512)
    || !isRecord(value) || !Array.isArray(value["models"]) || value["models"].length > MAXIMUM_MODELS) return undefined;
  const models = value["models"].filter(readCatalogRecord);
  if (models.length !== value["models"].length || new Set(models.map((model) => model.slug)).size !== models.length) {
    return undefined;
  }
  const template = models.find((model) => model.slug === "gpt-5.6-terra" && model.multi_agent_version === "v2")
    ?? models.find((model) => model.slug === "gpt-5.6-sol" && model.multi_agent_version === "v2")
    ?? models.find((model) => model.multi_agent_version === "v2");
  if (template === undefined) return undefined;
  const nativeCandidates = models.flatMap((record): SmartCandidate[] => {
    if (NATIVE_V2_DEFAULTS.has(record.slug) || !selectableNativeRecord(record)) return [];
    const model = nativeProviderModel(nativeProviderId, record);
    return model === undefined ? [] : [{
      providerId: nativeProviderId,
      model,
      revision: `native:${sourceRevision}`,
      native: true
    }];
  });
  const managed = managedCandidates.flatMap((candidate): SmartCandidate[] =>
    NATIVE_V2_DEFAULTS.has(candidate.model.modelId)
      || candidate.protocol !== "openai-responses" || candidate.model.api !== "openai-responses"
      || candidate.model.providerId !== candidate.providerId
      || candidate.model.supportsTools === false || candidate.model.defaultVisible === false
      || !validId(candidate.providerId, 128) || !validId(candidate.model.modelId, 256)
      || !validId(candidate.revision, 512) || !positiveInteger(candidate.model.contextWindow)
      ? []
      : [{ providerId: candidate.providerId, model: candidate.model, revision: candidate.revision, native: false }]);
  const selected = uniqueCandidates([...(includeNativeCandidates ? nativeCandidates : []), ...managed])
    .sort(compareCandidates)
    .slice(0, MAXIMUM_ADDITIONAL_MODELS);
  if (selected.length === 0) return undefined;

  const nativeRoutes = includeNativeCandidates
    ? models.flatMap((record): ManagedProviderSmartRoutingRoute[] => {
        if (!NATIVE_V2_DEFAULTS.has(record.slug) || record.multi_agent_version !== "v2"
          || !selectableNativeRecord(record) || nativeProviderModel(nativeProviderId, record) === undefined) return [];
        return [{
          providerId: nativeProviderId,
          modelId: record.slug,
          revision: `native:${sourceRevision}`,
          native: true
        }];
      })
    : [];

  const bySlug = new Map(models.map((model) => [model.slug, model]));
  const selectedBySlug = new Map(selected.map((candidate) => [candidate.model.modelId, candidate]));
  const output: CatalogRecord[] = models.map((record) => {
    const candidate = selectedBySlug.get(record.slug);
    const next = candidate === undefined || (candidate.native && record.multi_agent_version === "v2")
      ? { ...record }
      : upgradedRecord(record, candidate.model);
    const routed = candidate !== undefined || nativeRoutes.some((route) => route.modelId === record.slug);
    // Keep every native v2 record byte-for-byte when it has frozen authority.
    // Unauthenticated or overflow native entries retain their v2 contract but
    // leave the picker so Codex cannot advertise a route the proxy must reject.
    return record.multi_agent_version === "v2" && !routed
      ? { ...next, visibility: "hide" }
      : next;
  });
  let priority = Math.max(8, ...models.map((model) => finiteNumber(model.priority) ?? 0)) + 1;
  for (const candidate of selected) {
    if (bySlug.has(candidate.model.modelId)) continue;
    output.push({
      ...template,
      ...upgradedRecord(template, candidate.model),
      slug: candidate.model.modelId,
      priority: priority++,
      upgrade: null
    });
  }
  const routes = selected.map((candidate): ManagedProviderSmartRoutingRoute => ({
    providerId: candidate.providerId,
    modelId: candidate.model.modelId,
    revision: candidate.revision,
    native: candidate.native
  }));
  // Inspection and installation must make the same availability decision.
  // A large v2 template is cloned for each new slug, so a bounded input can
  // still expand beyond the generation-file limit.
  try {
    if (Buffer.byteLength(JSON.stringify({ models: output })) > MAXIMUM_GENERATED_BYTES) return undefined;
  } catch {
    return undefined;
  }
  const revision = createHash("sha256").update(JSON.stringify([
    sourceRevision,
    routes.map((route) => [route.providerId, route.modelId, route.revision, route.native]),
    nativeRoutes.map((route) => [route.providerId, route.modelId, route.revision, route.native])
  ])).digest("hex");
  return { models: output, routes, nativeRoutes, revision };
}

export function buildCodexSmartRoutingLaunchArgs(
  catalogPath: string,
  routes: readonly ManagedProviderSmartRoutingRoute[]
): readonly string[] {
  if (!isAbsolute(catalogPath) || routes.length === 0
    || routes.some((route) => !validId(route.modelId, 256))) {
    throw new TypeError("Codex smart-routing launch inputs are invalid.");
  }
  const models = routes.map((route) => route.modelId).join(", ");
  const hint = "Delegate independent exploration when it saves time. Choose the least expensive capable "
    + "subagent model and report conclusions back to the parent; keep implementation and final verification "
    + `in the parent. Additional available models: ${models}.`;
  return [
    "-c", `model_catalog_json=${tomlString(catalogPath)}`,
    "-c", "features.multi_agent_v2.expose_spawn_agent_model_overrides=true",
    "-c", `features.multi_agent_v2.multi_agent_mode_hint_text=${tomlString(hint)}`
  ];
}

async function readNativeCatalog(codexHome: string): Promise<{ readonly value: unknown; readonly digest: string }> {
  const requestedHome = resolve(codexHome);
  const home = await realpath(requestedHome);
  if (!samePath(home, requestedHome)) throw new Error("aliased profile");
  const sourcePath = join(home, SOURCE_FILE);
  const info = await lstat(sourcePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > MAXIMUM_SOURCE_BYTES) throw new Error("unsafe catalog");
  const canonical = await realpath(sourcePath);
  if (!samePath(canonical, sourcePath) || !samePath(dirname(canonical), home)) throw new Error("aliased catalog");
  const handle = await open(canonical, "r");
  try {
    const before = await handle.stat();
    if (!sameFile(info, before) || !before.isFile() || before.size < 2 || before.size > MAXIMUM_SOURCE_BYTES) {
      throw new Error("catalog changed");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFile(before, after) || bytes.byteLength !== after.size || bytes.byteLength > MAXIMUM_SOURCE_BYTES) {
      throw new Error("catalog changed");
    }
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    return { value, digest: createHash("sha256").update(bytes).digest("hex") };
  } finally {
    await handle.close();
  }
}

async function writeGenerationCatalog(directory: string, generation: number, contents: string): Promise<string> {
  if (!Number.isSafeInteger(generation) || generation < 1 || Buffer.byteLength(contents) > MAXIMUM_GENERATED_BYTES) {
    throw new Error("Smart-routing catalog output is invalid.");
  }
  const requestedDirectory = resolve(directory);
  await mkdir(requestedDirectory, { recursive: true, mode: 0o700 });
  const info = await lstat(requestedDirectory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Smart-routing output directory is unsafe.");
  const root = await realpath(requestedDirectory);
  if (!samePath(root, requestedDirectory)) throw new Error("Smart-routing output directory is aliased.");
  const stem = `catalog-${generation}-${randomUUID()}`;
  const temporary = join(root, `${stem}.tmp`);
  const destination = join(root, `${stem}.json`);
  const handle = await open(temporary, "wx", 0o600);
  let writeFailed = false;
  let writeFailure: unknown;
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (error) {
    writeFailed = true;
    writeFailure = error;
  } finally {
    try {
      await handle.close();
    } catch (error) {
      if (!writeFailed) {
        writeFailed = true;
        writeFailure = error;
      }
    }
  }
  if (writeFailed) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw writeFailure;
  }
  try {
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return destination;
}

function inactivePreparation(desired: boolean, revision: string, unavailableReason: string): CodexSmartRoutingPreparation {
  return {
    desired,
    applied: false,
    revision,
    routes: [],
    nativeRoutes: [],
    launchArgs: [],
    unavailableReason,
    cleanup: async () => undefined
  };
}

function unavailableRevision(
  source: string,
  candidates: readonly ManagedProviderSmartRoutingCandidate[],
  includeNativeCandidates: boolean
): string {
  const identities = candidates.map((candidate) => [
    candidate.providerId, candidate.model.modelId, candidate.revision
  ] as const).sort((left, right) => {
    for (let index = 0; index < left.length; index += 1) {
      const order = left[index]!.localeCompare(right[index]!, "en");
      if (order !== 0) return order;
    }
    return 0;
  });
  return `unavailable:${createHash("sha256").update(JSON.stringify([
    source,
    includeNativeCandidates,
    identities
  ])).digest("hex")}`;
}

function readCatalogRecord(value: unknown): value is CatalogRecord {
  return isRecord(value) && validId(value["slug"], 256);
}

function selectableNativeRecord(record: CatalogRecord): boolean {
  const version = record.multi_agent_version;
  return record["supported_in_api"] !== false
    && record["visibility"] !== "hide"
    && record["visibility"] !== "hidden"
    // Never upgrade an explicit native opt-out or an unknown future contract
    // into v2 authority. Missing/null and the two reviewed versions are safe.
    && (version === undefined || version === null || version === "v1" || version === "v2");
}

function nativeProviderModel(providerId: string, record: CatalogRecord): ProviderModel | undefined {
  const contextWindow = positiveInteger(record["context_window"]) ?? positiveInteger(record["max_context_window"]);
  if (contextWindow === undefined) return undefined;
  const maxOutputTokens = positiveInteger(record["max_output_tokens"]) ?? 0;
  const thinkingLevels = Array.isArray(record["supported_reasoning_levels"])
    ? record["supported_reasoning_levels"].flatMap((level): string[] => {
        if (typeof level === "string" && validId(level, 64)) return [level];
        return isRecord(level) && validId(level["effort"], 64) ? [level["effort"]] : [];
      })
    : [];
  return {
    providerId,
    modelId: record.slug,
    displayName: typeof record["display_name"] === "string" && record["display_name"].trim() !== ""
      ? record["display_name"]
      : record.slug,
    api: "openai-responses",
    contextWindow,
    maxOutputTokens,
    supportsImages: Array.isArray(record["input_modalities"]) && record["input_modalities"].includes("image"),
    thinkingLevels: [...new Set(thinkingLevels)],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  };
}

function upgradedRecord(record: CatalogRecord, model: ProviderModel): CatalogRecord {
  return {
    ...record,
    slug: model.modelId,
    display_name: model.displayName,
    context_window: model.contextWindow,
    max_context_window: model.contextWindow,
    ...(model.maxOutputTokens > 0 ? { max_output_tokens: model.maxOutputTokens } : {}),
    ...(model.thinkingLevels.length === 0 ? {} : {
      supported_reasoning_levels: model.thinkingLevels.map((effort) => ({
        effort,
        description: `${model.displayName} ${effort} reasoning`
      }))
    }),
    ...fullPromptCompatibility(model.modelId),
    multi_agent_version: "v2",
    visibility: "list",
    supported_in_api: true
  };
}

function fullPromptCompatibility(modelId: string): Record<string, unknown> {
  return /(?:^|\/)gpt-\d[^/]*$/iu.test(modelId) ? {} : {
    use_responses_lite: false,
    tool_mode: null,
    include_skills_usage_instructions: true
  };
}

function uniqueCandidates(candidates: readonly SmartCandidate[]): SmartCandidate[] {
  const byModel = new Map<string, SmartCandidate[]>();
  for (const candidate of candidates) {
    const matching = byModel.get(candidate.model.modelId) ?? [];
    matching.push(candidate);
    byModel.set(candidate.model.modelId, matching);
  }
  return [...byModel.values()].flatMap((matching) => {
    const identities = new Set(matching.map((candidate) => JSON.stringify([
      candidate.providerId, candidate.revision, candidate.native
    ])));
    return identities.size === 1 ? [[...matching].sort(compareCandidates)[0]!] : [];
  });
}

function compareCandidates(left: SmartCandidate, right: SmartCandidate): number {
  const leftRank = candidateRank(left);
  const rightRank = candidateRank(right);
  for (let index = 0; index < leftRank.length; index += 1) {
    const a = leftRank[index]!;
    const b = rightRank[index]!;
    if (a === b) continue;
    return a < b ? -1 : 1;
  }
  return left.providerId.localeCompare(right.providerId, "en");
}

function candidateRank(candidate: SmartCandidate): readonly (number | string)[] {
  const id = candidate.model.modelId.toLowerCase();
  const family = id.includes("luna") ? 0 : /(?:mini|flash|haiku|small|budget)/u.test(id) ? 1 : /(?:qwen|glm|deepseek|kimi)/u.test(id) ? 2 : 3;
  const cost = candidate.model.cost.input > 0 || candidate.model.cost.output > 0
    ? candidate.model.cost.input + candidate.model.cost.output
    : Number.POSITIVE_INFINITY;
  return [family, cost, candidate.native ? 0 : 1, id, candidate.revision];
}

function tomlString(value: string): string {
  // JSON strings are valid TOML basic strings and escape every control
  // character that could otherwise terminate a `-c key=value` override.
  return JSON.stringify(value);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function validId(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\s\u0000-\u001f\u007f]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
