import {
  CapabilitySupport,
  RuntimeCommandSource,
  TargetState,
  capabilityNames,
  type BackendDescriptor,
  type RuntimeCommand,
  type Snapshot
} from "@joko/contracts";
import {
  normalizeMobileComposerDraft,
  replaceMobileComposerRange,
  type MobileComposerDraft,
  type MobileComposerEditResult,
  type MobileComposerSelection
} from "./mobile-composer-document";

export interface MobileRuntimeCommandControls {
  readonly authorityKey: string;
  readonly surfaceOwnerKey: string;
  readonly sessionId: string;
  readonly backendId: string;
  readonly targetId: string;
  readonly runtimeGeneration: string;
}

export interface MobileRuntimeCommandCandidate {
  readonly commandId: string;
  readonly name: string;
  readonly description: string;
  readonly source: RuntimeCommandSource;
  readonly resourceId?: string;
}

export interface MobileRuntimeCommandCatalog {
  readonly surfaceOwnerKey: string;
  readonly sessionId: string;
  readonly runtimeGeneration: string;
  readonly items: readonly MobileRuntimeCommandCandidate[];
}

export interface MobileRuntimeCommandActivation {
  /** UTF-16 offset of the slash owning this command run. */
  readonly from: number;
  /** UTF-16 offset after the complete non-whitespace run. */
  readonly to: number;
  /** UTF-16 caret offset used to derive query. */
  readonly caret: number;
  /** Text between the owning slash and caret. */
  readonly query: string;
}

export interface MobileRuntimeCommandResults {
  readonly items: readonly MobileRuntimeCommandCandidate[];
  readonly truncated: boolean;
}

export type MobileRuntimeCommandPaletteKey = "ArrowUp" | "ArrowDown" | "Enter" | "Tab" | "Escape";

export type MobileRuntimeCommandPaletteDecision<
  Candidate extends { readonly commandId: string; readonly name: string } = MobileRuntimeCommandCandidate
> =
  | { readonly kind: "dismiss" }
  | { readonly kind: "move"; readonly selectedIndex: number }
  | { readonly kind: "commit"; readonly candidate: Candidate }
  | { readonly kind: "consume" };

const maximumCatalogCommands = 4_096;
const maximumCatalogCharacters = 1_048_576;
const maximumCommandIdCharacters = 1_024;
const maximumCommandNameCharacters = 256;
const maximumCommandDescriptionCharacters = 4_096;
const maximumResourceIdCharacters = 4_096;
const maximumVisibleResults = 20;
const maximumCachedCatalogs = 16;

export function createMobileRuntimeCommandControls(
  authorityKey: string | undefined,
  owner: Snapshot | undefined,
  detail: Snapshot | undefined,
  selectedId: string | undefined
): MobileRuntimeCommandControls | undefined {
  if (!authorityKey || !owner || !detail || !validIdentity(selectedId, 1_024)
    || owner.generation !== detail.generation) return undefined;
  const ownerSession = unique(owner.sessions, (item) => item.sessionId === selectedId);
  const detailSession = unique(detail.sessions, (item) => item.sessionId === selectedId);
  if (!ownerSession || !detailSession || ownerSession.backendId !== detailSession.backendId
    || ownerSession.targetId !== detailSession.targetId
    || entityKey(ownerSession.version) !== entityKey(detailSession.version)) return undefined;
  const generation = detailSession.nativeBinding?.runtimeGeneration;
  if (!generation || generation < 1n || ownerSession.nativeBinding?.runtimeGeneration !== generation
    || detailSession.version?.generation !== generation) return undefined;

  const ownerBackend = unique(owner.backends, (item) => item.backendId === detailSession.backendId);
  const detailBackend = unique(detail.backends, (item) => item.backendId === detailSession.backendId);
  const ownerTarget = unique(owner.targets, (item) => item.targetId === detailSession.targetId);
  const detailTarget = unique(detail.targets, (item) => item.targetId === detailSession.targetId);
  if (!ownerBackend || !detailBackend || !ownerTarget || !detailTarget
    || ownerTarget.backendId !== detailSession.backendId || detailTarget.backendId !== detailSession.backendId
    || ownerTarget.state !== TargetState.ACTIVE || detailTarget.state !== TargetState.ACTIVE
    || entityKey(ownerTarget.version) !== entityKey(detailTarget.version)
    || !runtimeCommandsSupported(ownerBackend) || !runtimeCommandsSupported(detailBackend)) return undefined;

  return {
    authorityKey,
    surfaceOwnerKey: [
      authorityKey,
      "runtime-commands",
      detailSession.sessionId,
      detailSession.backendId,
      detailSession.targetId,
      generation.toString(10)
    ].join("\u001f"),
    sessionId: detailSession.sessionId,
    backendId: detailSession.backendId,
    targetId: detailSession.targetId,
    runtimeGeneration: generation.toString(10)
  };
}

export function projectMobileRuntimeCommandCatalog(
  controls: MobileRuntimeCommandControls,
  commands: readonly RuntimeCommand[]
): MobileRuntimeCommandCatalog {
  if (commands.length > maximumCatalogCommands) {
    throw new Error("The Joko node returned too many runtime commands.");
  }
  const commandIds = new Set<string>();
  let characters = 0;
  const candidates = commands.map((command): MobileRuntimeCommandCandidate | undefined => {
    characters += command.commandId.length + command.name.length + command.description.length
      + command.resourceId.length + command.sessionId.length;
    if (!Number.isSafeInteger(characters) || characters > maximumCatalogCharacters
      || command.sessionId !== controls.sessionId
      || !validIdentity(command.commandId, maximumCommandIdCharacters) || commandIds.has(command.commandId)
      || !validCommandName(command.name) || !validDescription(command.description)
      || command.resourceId !== "" && !validIdentity(command.resourceId, maximumResourceIdCharacters)
      || !validCommandSource(command.source)) {
      throw new Error("The Joko node returned an invalid runtime command catalog.");
    }
    commandIds.add(command.commandId);
    if (!command.loaded) return undefined;
    return {
      commandId: command.commandId,
      name: command.name,
      description: command.description,
      source: command.source,
      ...(command.resourceId === "" ? {} : { resourceId: command.resourceId })
    };
  }).filter((candidate): candidate is MobileRuntimeCommandCandidate => candidate !== undefined)
    .sort(compareRuntimeCommands);

  const names = new Set<string>();
  const items = candidates.filter((candidate) => {
    const key = candidate.name.toLowerCase();
    if (names.has(key)) return false;
    names.add(key);
    return true;
  });
  return {
    surfaceOwnerKey: controls.surfaceOwnerKey,
    sessionId: controls.sessionId,
    runtimeGeneration: controls.runtimeGeneration,
    items
  };
}

export function detectMobileRuntimeCommandActivation(
  draft: MobileComposerDraft,
  selection: MobileComposerSelection,
  isComposing: boolean
): MobileRuntimeCommandActivation | undefined {
  if (isComposing || !Number.isSafeInteger(selection.start) || selection.start !== selection.end) return undefined;
  let exact: MobileComposerDraft;
  try {
    exact = normalizeMobileComposerDraft(draft);
  } catch {
    return undefined;
  }
  const caret = selection.start;
  if (caret < 0 || caret > exact.text.length || splitsSurrogate(exact.text, caret)) return undefined;
  let from = caret;
  while (from > 0 && !/\s/u.test(exact.text[from - 1] ?? "")) from -= 1;
  let to = caret;
  while (to < exact.text.length && !/\s/u.test(exact.text[to] ?? "")) to += 1;
  const run = exact.text.slice(from, to);
  const prefix = exact.text.slice(from, caret);
  if (!prefix.startsWith("/") || prefix.slice(1).includes("/") || run.slice(1).includes("/")
    || prefix.length - 1 > maximumCommandNameCharacters || run.length - 1 > maximumCommandNameCharacters
    || splitsSurrogate(exact.text, from)
    || splitsSurrogate(exact.text, to) || intersectsOccurrence(exact, from, to)) return undefined;
  return { from, to, caret, query: prefix.slice(1) };
}

export function filterMobileRuntimeCommands(
  catalog: MobileRuntimeCommandCatalog,
  query: string,
  limit = maximumVisibleResults
): MobileRuntimeCommandResults {
  const maximum = Math.max(0, Math.min(maximumVisibleResults, Number.isSafeInteger(limit) ? limit : 0));
  const needle = query.toLowerCase();
  const matches = catalog.items.filter((candidate) => candidate.name.toLowerCase().startsWith(needle)
    || candidate.description.toLowerCase().includes(needle));
  const ranked = matches.sort((left, right) => {
    const leftPrefix = left.name.toLowerCase().startsWith(needle);
    const rightPrefix = right.name.toLowerCase().startsWith(needle);
    return Number(rightPrefix) - Number(leftPrefix) || compareRuntimeCommands(left, right);
  });
  return { items: ranked.slice(0, maximum), truncated: ranked.length > maximum };
}

export function assertMobileRuntimeCommandCandidate(
  controls: MobileRuntimeCommandControls | undefined,
  catalog: MobileRuntimeCommandCatalog | undefined,
  value: MobileRuntimeCommandCandidate
): MobileRuntimeCommandCandidate {
  if (!controls || !catalog || catalog.surfaceOwnerKey !== controls.surfaceOwnerKey
    || catalog.sessionId !== controls.sessionId || catalog.runtimeGeneration !== controls.runtimeGeneration) {
    throw new Error("The runtime command catalog owner changed. Type the slash command again.");
  }
  const matches = catalog.items.filter((candidate) => candidate.commandId === value.commandId
    && candidate.name === value.name && candidate.source === value.source
    && candidate.resourceId === value.resourceId && candidate.description === value.description);
  if (matches.length !== 1) throw new Error("The selected runtime command is no longer loaded.");
  return matches[0]!;
}

export function resolveMobileRuntimeCommandPaletteKey<
  Candidate extends { readonly commandId: string; readonly name: string }
>(
  key: MobileRuntimeCommandPaletteKey,
  items: readonly Candidate[],
  selectedIndex: number,
  selectable: boolean
): MobileRuntimeCommandPaletteDecision<Candidate> {
  if (key === "Escape") return { kind: "dismiss" };
  if (key === "ArrowUp" || key === "ArrowDown") {
    if (items.length === 0) return { kind: "consume" };
    const current = Number.isSafeInteger(selectedIndex)
      ? Math.max(0, Math.min(selectedIndex, items.length - 1)) : 0;
    return {
      kind: "move",
      selectedIndex: key === "ArrowDown"
        ? (current + 1) % items.length
        : (current - 1 + items.length) % items.length
    };
  }
  const current = Number.isSafeInteger(selectedIndex)
    ? Math.max(0, Math.min(selectedIndex, items.length - 1)) : 0;
  const candidate = items[current];
  return selectable && candidate ? { kind: "commit", candidate } : { kind: "consume" };
}

export function replaceMobileRuntimeCommandRun<Command extends { readonly name: string }>(
  draft: MobileComposerDraft,
  activation: MobileRuntimeCommandActivation,
  command: Command
): MobileComposerEditResult {
  const exact = normalizeMobileComposerDraft(draft);
  const { from, to, caret, query } = activation;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || !Number.isSafeInteger(caret)
    || from < 0 || caret < from + 1 || caret > to || to > exact.text.length
    || splitsSurrogate(exact.text, from) || splitsSurrogate(exact.text, caret) || splitsSurrogate(exact.text, to)
    || exact.text.slice(from + 1, caret) !== query || !validCommandName(command.name)
    || from > 0 && !/\s/u.test(exact.text[from - 1] ?? "")
    || to < exact.text.length && !/\s/u.test(exact.text[to] ?? "")
    || !/^\/[^\s/]*$/u.test(exact.text.slice(from, to))
    || intersectsOccurrence(exact, from, to)) {
    throw new Error("The typed runtime command changed before it could be inserted.");
  }
  const separator = to < exact.text.length && /\s/u.test(exact.text[to] ?? "") ? "" : " ";
  return replaceMobileComposerRange(exact, { start: from, end: to }, `/${command.name}${separator}`);
}

export class MobileRuntimeCommandCatalogCache {
  readonly #catalogs = new Map<string, MobileRuntimeCommandCatalog>();

  read(surfaceOwnerKey: string): MobileRuntimeCommandCatalog | undefined {
    const catalog = this.#catalogs.get(surfaceOwnerKey);
    if (!catalog) return undefined;
    this.#catalogs.delete(surfaceOwnerKey);
    this.#catalogs.set(surfaceOwnerKey, catalog);
    return catalog;
  }

  write(catalog: MobileRuntimeCommandCatalog): void {
    this.#catalogs.delete(catalog.surfaceOwnerKey);
    this.#catalogs.set(catalog.surfaceOwnerKey, catalog);
    while (this.#catalogs.size > maximumCachedCatalogs) {
      const oldest = this.#catalogs.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.#catalogs.delete(oldest);
    }
  }

  clear(): void {
    this.#catalogs.clear();
  }
}

function runtimeCommandsSupported(backend: BackendDescriptor): boolean {
  const capabilities = backend.capabilities?.capabilities.filter((item) => item.name === capabilityNames.runtimeCommands) ?? [];
  return capabilities.length === 1 && capabilities[0]!.support === CapabilitySupport.SUPPORTED;
}

function compareRuntimeCommands(left: MobileRuntimeCommandCandidate, right: MobileRuntimeCommandCandidate): number {
  return compareText(left.name.toLowerCase(), right.name.toLowerCase())
    || sourceOrder(left.source) - sourceOrder(right.source)
    || compareText(left.name, right.name)
    || compareText(left.commandId, right.commandId);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sourceOrder(source: RuntimeCommandSource): number {
  if (source === RuntimeCommandSource.SKILL) return 0;
  if (source === RuntimeCommandSource.PROMPT) return 1;
  if (source === RuntimeCommandSource.EXTENSION) return 2;
  return 3;
}

function validCommandSource(source: RuntimeCommandSource): boolean {
  return source === RuntimeCommandSource.EXTENSION || source === RuntimeCommandSource.PROMPT
    || source === RuntimeCommandSource.SKILL || source === RuntimeCommandSource.BACKEND;
}

function validCommandName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumCommandNameCharacters
    && value === value.trim() && !/[\s/\u0000-\u001f\u007f\u2028\u2029]/u.test(value);
}

function validDescription(value: unknown): value is string {
  return typeof value === "string" && value.length <= maximumCommandDescriptionCharacters
    && (value === "" || value === value.trim()) && !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value);
}

function validIdentity(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value === value.trim()
    && !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value);
}

function intersectsOccurrence(draft: MobileComposerDraft, from: number, to: number): boolean {
  return [...draft.mentions, ...draft.atoms].some((occurrence) => occurrence.start < to && occurrence.end > from);
}

function splitsSurrogate(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function unique<T>(values: readonly T[], matches: (value: T) => boolean): T | undefined {
  const selected = values.filter(matches);
  return selected.length === 1 ? selected[0] : undefined;
}

function entityKey(version: {
  readonly generation: bigint;
  readonly revision?: { readonly value: bigint; readonly etag: string };
} | undefined): string {
  return [
    version?.generation.toString(10) ?? "",
    version?.revision?.value.toString(10) ?? "",
    version?.revision?.etag ?? ""
  ].join("\u001e");
}

export const mobileRuntimeCommandTesting = {
  maximumCachedCatalogs,
  maximumCatalogCharacters,
  maximumCatalogCommands,
  maximumVisibleResults
};
