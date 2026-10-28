import { extname, posix } from "node:path";
import { parseMailReader, type MailReaderDeclaration } from "@joko/contracts";
import { parseExtensionNetwork, type ExtensionNetworkDeclaration } from "./extension-cards/network-manifest.js";

export const EXTENSION_MAIN_VIEW_ICONS = [
  "activity",
  "box",
  "code",
  "file-text",
  "globe",
  "layout",
  "search",
  "sparkles",
  "terminal",
  "tool"
] as const;

export type ExtensionMainViewIcon = typeof EXTENSION_MAIN_VIEW_ICONS[number];

export interface ExtensionMainViewDescriptor {
  /** Package-relative HTML entry. */
  readonly html: string;
  readonly title?: string;
  readonly icon?: ExtensionMainViewIcon;
  readonly open?: "page" | "sidebar" | "window";
  readonly side?: "left" | "right" | "top" | "bottom";
  readonly multiple?: true;
}

export interface ExtensionLibraryDescriptor {
  readonly schemaVersion: 1;
}

export interface ExtensionRoutineEventsDescriptor {
  readonly html: string;
  readonly events: readonly { readonly type: string; readonly name: string; readonly fields: readonly string[] }[];
}

export type ExtensionRecommendationLocale = "en" | "zh-CN";

export interface ExtensionRecommendationTranslation {
  readonly label: string;
  readonly prompt: string;
}

/** Optional author content. It is never executable authority or a model
 * system instruction; command only names an exact runtime command to verify. */
export interface ExtensionRecommendationDescriptor {
  readonly id: string;
  readonly label: string;
  readonly prompt: string;
  readonly command?: string;
  readonly locales?: Readonly<Partial<Record<ExtensionRecommendationLocale, ExtensionRecommendationTranslation>>>;
}

export interface ExtensionSurfaceBinding {
  /** Exact package-relative runtime Extension entry. */
  readonly entry: string;
  readonly mainView?: ExtensionMainViewDescriptor;
  readonly library?: ExtensionLibraryDescriptor;
  readonly routineEvents?: ExtensionRoutineEventsDescriptor;
  readonly runtime?: ExtensionRuntimeDescriptor;
  readonly recommendations?: readonly ExtensionRecommendationDescriptor[];
}

const EXTENSION_SUFFIXES = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const ICONS = new Set<string>(EXTENSION_MAIN_VIEW_ICONS);
const MAXIMUM_SURFACES = 256;
const MAXIMUM_PATH_CHARACTERS = 2_048;
const MAXIMUM_TITLE_CHARACTERS = 80;
const MAXIMUM_RECOMMENDATIONS = 24;
const MAXIMUM_RECOMMENDATIONS_BYTES = 64 * 1_024;
const MAXIMUM_RECOMMENDATION_LABEL_CHARACTERS = 120;
const MAXIMUM_RECOMMENDATION_PROMPT_CHARACTERS = 8_000;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_TEXT = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_RECOMMENDATION_LABEL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
// Prompts may contain horizontal tabs and newlines, but no other control or
// bidirectional formatting characters.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_RECOMMENDATION_PROMPT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const PORTABLE_COMPONENT = /^(?![. ]+$)[A-Za-z0-9@][A-Za-z0-9@._+ -]*$/u;
const RECOMMENDATION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const COMMAND_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const RECOMMENDATION_LOCALES = new Set<ExtensionRecommendationLocale>(["en", "zh-CN"]);

/**
 * Parses the only current-v1 Joko Extension surface declaration. The caller
 * supplies an independently enumerated package tree so declarations cannot
 * invent runtime entries or HTML outside the inspected package generation.
 */
export function parseExtensionSurfaceManifest(
  packageManifest: Readonly<Record<string, unknown>>,
  extensionEntries: readonly string[],
  regularFiles: readonly string[]
): readonly ExtensionSurfaceBinding[] {
  if (packageManifest.joko === undefined) return [];
  const joko = requirePlainObject(packageManifest.joko, "package.json joko field");
  requireExactKeys(joko, ["extensionSurfaces"], ["extensionSurfaces"], "package.json joko field");
  const surfaces = requirePlainObject(joko.extensionSurfaces, "Extension surface manifest");
  requireExactKeys(surfaces, ["schemaVersion", "extensions"], ["schemaVersion", "extensions"], "Extension surface manifest");
  if (surfaces.schemaVersion !== 1) throw new Error("Extension surface manifest schemaVersion must be 1.");
  if (!Array.isArray(surfaces.extensions) || surfaces.extensions.length === 0 || surfaces.extensions.length > MAXIMUM_SURFACES) {
    throw new Error(`Extension surface manifest must declare between 1 and ${MAXIMUM_SURFACES} extensions.`);
  }

  const discoveredEntries = new Set(extensionEntries.map((entry) => normalizeKnownPath(entry, "Discovered Extension entry")));
  const discoveredFiles = new Set(regularFiles.map((entry) => normalizeKnownPath(entry, "Discovered package file")));
  const seenEntries = new Set<string>();
  const result: ExtensionSurfaceBinding[] = [];
  for (const rawBinding of surfaces.extensions) {
    const binding = requirePlainObject(rawBinding, "Extension surface declaration");
    requireExactKeys(binding, ["entry", "mainView", "library", "routineEvents", "runtime", "recommendations"], ["entry"], "Extension surface declaration");
    const entry = requirePortablePath(binding.entry, "Extension surface entry");
    if (!EXTENSION_SUFFIXES.has(extname(entry).toLowerCase())) throw new Error("Extension surface entry has an unsupported file type.");
    if (!discoveredEntries.has(entry)) throw new Error("Extension surface entry does not exactly match a discovered Extension.");
    if (seenEntries.has(entry)) throw new Error("Extension surface entry is declared more than once.");
    seenEntries.add(entry);

    if (binding.mainView === undefined && binding.library === undefined && binding.routineEvents === undefined && binding.runtime === undefined && binding.recommendations === undefined) {
      throw new Error("Extension surface declaration must advertise at least one current capability.");
    }
    let mainView: ExtensionMainViewDescriptor | undefined;
    if (binding.mainView !== undefined) {
      const rawMainView = requirePlainObject(binding.mainView, "Extension main view");
      requireExactKeys(rawMainView, ["html", "title", "icon", "open", "side", "multiple"], ["html"], "Extension main view");
      const placement = parseMainViewPlacement(rawMainView);
      const html = requirePortablePath(rawMainView.html, "Extension main-view HTML");
      if (extname(html) !== ".html" || posix.dirname(html) === ".") {
        throw new Error("Extension main-view HTML must be a lowercase .html file in a self-contained directory.");
      }
      if (!discoveredFiles.has(html)) throw new Error("Extension main-view HTML is not an inspected regular package file.");
      const title = rawMainView.title === undefined ? undefined : requireTitle(rawMainView.title);
      const icon = rawMainView.icon === undefined ? undefined : requireIcon(rawMainView.icon);
      mainView = {
        html,
        ...placement,
        ...(title === undefined ? {} : { title }),
        ...(icon === undefined ? {} : { icon })
      };
    }
    let library: ExtensionLibraryDescriptor | undefined;
    if (binding.library !== undefined) {
      const rawLibrary = requirePlainObject(binding.library, "Extension Library declaration");
      requireExactKeys(rawLibrary, ["schemaVersion"], ["schemaVersion"], "Extension Library declaration");
      if (rawLibrary.schemaVersion !== 1) throw new Error("Extension Library schemaVersion must be 1.");
      library = { schemaVersion: 1 };
    }
    const recommendations = binding.recommendations === undefined
      ? undefined
      : validateExtensionRecommendations(binding.recommendations).items;
    const routineEvents = binding.routineEvents === undefined ? undefined : parseExtensionRoutineEvents(binding.routineEvents);
    const runtime = binding.runtime === undefined ? undefined : parseExtensionRuntime(binding.runtime);
    if (runtime && !discoveredFiles.has(runtime.html)) throw new Error("Extension runtime HTML is not an inspected regular package file.");
    if (routineEvents && !discoveredFiles.has(routineEvents.html)) throw new Error("Routine publisher HTML is not an inspected regular package file.");
    result.push({
      entry,
      ...(mainView === undefined ? {} : { mainView }),
      ...(library === undefined ? {} : { library }),
      ...(routineEvents === undefined ? {} : { routineEvents }),
      ...(runtime === undefined ? {} : { runtime }),
      ...(recommendations === undefined ? {} : { recommendations })
    });
  }
  return result;
}

export function parseExtensionRuntime(value: unknown): ExtensionRuntimeDescriptor {
  const raw = requirePlainObject(value, "Extension runtime");
  requireExactKeys(raw, ["html", "tools", "card", "mail", "mailReader", "agent", "network", "tasks", "targets", "text", "showTaskPreferences", "deviceSync"], ["html", "tools"], "Extension runtime");
  const html = requirePortablePath(raw.html, "Extension runtime HTML");
  if (extname(html) !== ".html" || posix.dirname(html) === ".") throw new Error("Extension runtime HTML must be in a self-contained directory.");
  if (!Array.isArray(raw.tools) || raw.tools.length > 64 || raw.tools.length === 0 && raw.tasks === undefined && raw.text === undefined && raw.deviceSync === undefined) throw new Error("Extension runtime must declare tools or an autonomous task/text capability.");
  const tools = raw.tools.map(item => {
    const tool = requirePlainObject(item, "Extension tool");
    requireExactKeys(tool, ["name", "description", "inputSchema", "readOnly"], ["name", "description", "inputSchema"], "Extension tool");
    if (typeof tool.name !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/u.test(tool.name)
      || typeof tool.description !== "string" || !tool.description.trim() || tool.description.length > 8000
      || tool.readOnly !== undefined && typeof tool.readOnly !== "boolean") throw new Error("Extension tool declaration is invalid.");
    const inputSchema = requirePlainObject(tool.inputSchema, "Extension tool schema");
    if (inputSchema.type !== "object" || Buffer.byteLength(JSON.stringify(inputSchema)) > 64 * 1024) throw new Error("Extension tool schema is invalid.");
    return { name: tool.name, description: tool.description, inputSchema: structuredClone(inputSchema), readOnly: tool.readOnly === true };
  });
  if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error("Extension tool names must be unique.");
  let card: ExtensionRuntimeDescriptor["card"];
  if (raw.card !== undefined) {
    const declaration = requirePlainObject(raw.card, "Extension card");
    requireExactKeys(declaration, ["externalLinks"], [], "Extension card");
    if (declaration.externalLinks !== undefined && declaration.externalLinks !== true) throw new Error("External links capability must be true when present.");
    card = declaration.externalLinks === true ? { externalLinks: true } : {};
  }
  if (raw.mail !== undefined && raw.mail !== true) throw new Error("Extension mail capability must be true when present.");
  if (raw.agent !== undefined && raw.agent !== true) throw new Error("Extension task continuation capability must be true when present.");
  if (raw.deviceSync !== undefined && raw.deviceSync !== true) throw new Error("Extension device sync capability must be true when present.");
  if (raw.targets !== undefined && (raw.targets !== true || raw.tasks === undefined)) throw new Error("Extension targets require managed tasks and an explicit targets declaration.");
  const mailReader = raw.mailReader === undefined ? undefined : parseMailReader(raw.mailReader);
  if (mailReader === null || mailReader && (raw.mail !== true || !tools.some(tool => tool.name === mailReader.tool))) throw new Error("Mail reader must name a declared tool and mail capability.");
  const network = raw.network === undefined ? undefined : parseExtensionNetwork(raw.network);
  let tasks: ExtensionRuntimeDescriptor["tasks"];
  if (raw.tasks !== undefined) {
    const value = requirePlainObject(raw.tasks, "Extension managed tasks");
    requireExactKeys(value, ["hidden"], [], "Extension managed tasks");
    if (value.hidden !== undefined && value.hidden !== true) throw new Error("Hidden tasks capability must be true when declared.");
    tasks = value.hidden === true ? { hidden: true } : {};
  }
  let text: ExtensionRuntimeDescriptor["text"];
  if (raw.text !== undefined) {
    const value = requirePlainObject(raw.text, "Extension text inference");
    requireExactKeys(value, ["oneshot", "model"], ["oneshot"], "Extension text inference");
    if (value.oneshot !== true || value.model !== undefined && (typeof value.model !== "string" || !value.model.trim() || value.model.length > 128)) throw new Error("Extension text inference declaration is invalid.");
    text = { oneshot: true, ...(typeof value.model === "string" ? { model: value.model } : {}) };
  }
  if (raw.showTaskPreferences !== undefined && typeof raw.showTaskPreferences !== "boolean") throw new Error("showTaskPreferences must be boolean.");
  return { html, tools, ...(card === undefined ? {} : { card }), ...(raw.mail === true ? { mail: true } : {}), ...(mailReader ? { mailReader } : {}), ...(raw.agent === true ? { agent: true } : {}), ...(network ? { network } : {}),
    ...(raw.deviceSync === true ? { deviceSync: true } : {}),
    ...(raw.targets === true ? { targets: true } : {}),
    ...(tasks ? { tasks } : {}), ...(text ? { text } : {}), ...(typeof raw.showTaskPreferences === "boolean" ? { showTaskPreferences: raw.showTaskPreferences } : {}) };
}

/** Flat plugin event declarations. */
export function parseExtensionRoutineEvents(value: unknown): ExtensionRoutineEventsDescriptor {
  const raw = requirePlainObject(value, "Routine events");
  requireExactKeys(raw, ["html", "events"], ["html", "events"], "Routine events");
  const html = requirePortablePath(raw.html, "Routine publisher HTML");
  if (extname(html) !== ".html" || posix.dirname(html) === ".") throw new Error("Routine publisher HTML must be in a self-contained directory.");
  if (!Array.isArray(raw.events) || raw.events.length < 1 || raw.events.length > 32) throw new Error("Routine events must declare 1–32 event types.");
  const token = (candidate: unknown): string => {
    if (typeof candidate !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(candidate)) throw new Error("Routine event identifier is invalid.");
    return candidate;
  };
  const events = raw.events.map(item => {
    const event = requirePlainObject(item, "Routine event declaration");
    requireExactKeys(event, ["type", "name", "fields"], ["type", "name", "fields"], "Routine event declaration");
    if (typeof event.name !== "string" || !event.name.trim() || event.name.length > 200 || FORBIDDEN_TEXT.test(event.name)) throw new Error("Routine event name is invalid.");
    if (!Array.isArray(event.fields) || event.fields.length > 32) throw new Error("Routine event fields are invalid.");
    const fields = event.fields.map(token); if (new Set(fields).size !== fields.length) throw new Error("Routine event fields must be unique.");
    return { type: token(event.type), name: event.name, fields };
  });
  if (new Set(events.map(event => event.type)).size !== events.length) throw new Error("Routine event types must be unique.");
  return { html, events };
}

export function validateExtensionRecommendations(value: unknown):
  | { readonly ok: true; readonly items: readonly ExtensionRecommendationDescriptor[] }
  | { readonly ok: false; readonly items: readonly []; readonly reason: string } {
  const failure = {
    ok: false as const,
    items: [] as const,
    reason: "Extension recommendations must contain at most 24 unique bounded tasks in the current-v1 shape."
  };
  if (!Array.isArray(value) || value.length > MAXIMUM_RECOMMENDATIONS) return failure;
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).length > MAXIMUM_RECOMMENDATIONS_BYTES) return failure;
  } catch {
    return failure;
  }

  const ids = new Set<string>();
  const items: ExtensionRecommendationDescriptor[] = [];
  try {
    for (const raw of value) {
      if (!isPlainObject(raw)) return failure;
      requireExactKeys(raw, ["id", "label", "prompt", "command", "locales"], ["id", "label", "prompt"], "Extension recommendation");
      if (typeof raw.id !== "string" || !RECOMMENDATION_ID.test(raw.id) || ids.has(raw.id)
        || !recommendationText(raw.label, MAXIMUM_RECOMMENDATION_LABEL_CHARACTERS, FORBIDDEN_RECOMMENDATION_LABEL)
        || !recommendationText(raw.prompt, MAXIMUM_RECOMMENDATION_PROMPT_CHARACTERS, FORBIDDEN_RECOMMENDATION_PROMPT)
        || raw.command !== undefined && (typeof raw.command !== "string" || !COMMAND_SLUG.test(raw.command))) return failure;
      ids.add(raw.id);

      let locales: Partial<Record<ExtensionRecommendationLocale, ExtensionRecommendationTranslation>> | undefined;
      if (raw.locales !== undefined) {
        if (!isPlainObject(raw.locales)) return failure;
        locales = {};
        for (const [locale, rawTranslation] of Object.entries(raw.locales)) {
          if (!RECOMMENDATION_LOCALES.has(locale as ExtensionRecommendationLocale) || !isPlainObject(rawTranslation)) return failure;
          requireExactKeys(rawTranslation, ["label", "prompt"], ["label", "prompt"], "Extension recommendation translation");
          if (!recommendationText(rawTranslation.label, MAXIMUM_RECOMMENDATION_LABEL_CHARACTERS, FORBIDDEN_RECOMMENDATION_LABEL)
            || !recommendationText(rawTranslation.prompt, MAXIMUM_RECOMMENDATION_PROMPT_CHARACTERS, FORBIDDEN_RECOMMENDATION_PROMPT)) return failure;
          locales[locale as ExtensionRecommendationLocale] = {
            label: rawTranslation.label,
            prompt: rawTranslation.prompt
          };
        }
      }
      items.push({
        id: raw.id,
        label: raw.label,
        prompt: raw.prompt,
        ...(raw.command === undefined ? {} : { command: raw.command }),
        ...(locales === undefined ? {} : { locales })
      });
    }
  } catch {
    return failure;
  }
  return { ok: true, items };
}

export function isExtensionMainViewDescriptor(value: unknown): value is ExtensionMainViewDescriptor {
  if (!isPlainObject(value)) return false;
  try {
    requireExactKeys(value, ["html", "title", "icon", "open", "side", "multiple"], ["html"], "Extension main view");
    parseMainViewPlacement(value);
    const html = requirePortablePath(value.html, "Extension main-view HTML");
    if (extname(html) !== ".html" || posix.dirname(html) === ".") return false;
    if (value.title !== undefined) requireTitle(value.title);
    if (value.icon !== undefined) requireIcon(value.icon);
    return true;
  } catch {
    return false;
  }
}

function parseMainViewPlacement(value: Record<string, unknown>): Pick<ExtensionMainViewDescriptor, "open" | "side" | "multiple"> {
  if (value.open !== undefined && !["page", "sidebar", "window"].includes(value.open as string)) throw new Error("Extension main-view open must be page, sidebar or window.");
  if (value.side !== undefined && (value.open !== "sidebar" || !["left", "right", "top", "bottom"].includes(value.side as string))) throw new Error("Extension main-view side requires sidebar mode and a supported edge.");
  if (value.multiple !== undefined && value.multiple !== true) throw new Error("Extension main-view multiple must be true when declared.");
  return { ...(value.open === undefined ? {} : { open: value.open as NonNullable<ExtensionMainViewDescriptor["open"]> }),
    ...(value.side === undefined ? {} : { side: value.side as NonNullable<ExtensionMainViewDescriptor["side"]> }),
    ...(value.multiple === true ? { multiple: true } : {}) };
}

export function isExtensionLibraryDescriptor(value: unknown): value is ExtensionLibraryDescriptor {
  if (!isPlainObject(value)) return false;
  try {
    requireExactKeys(value, ["schemaVersion"], ["schemaVersion"], "Extension Library declaration");
    return value.schemaVersion === 1;
  } catch {
    return false;
  }
}

function requirePortablePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "" || value.length > MAXIMUM_PATH_CHARACTERS || value !== value.trim()
    || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/u.test(value) || FORBIDDEN_TEXT.test(value)) {
    throw new Error(`${label} is not a portable package-relative path.`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || !PORTABLE_COMPONENT.test(part)
      || part.endsWith(".") || part.endsWith(" "))) {
    throw new Error(`${label} is not a portable package-relative path.`);
  }
  return value;
}

function normalizeKnownPath(value: string, label: string): string {
  return requirePortablePath(value.replaceAll("\\", "/"), label);
}

function requireTitle(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAXIMUM_TITLE_CHARACTERS
    || value !== value.trim() || FORBIDDEN_TEXT.test(value)) throw new Error("Extension main-view title is invalid.");
  return value;
}

function requireIcon(value: unknown): ExtensionMainViewIcon {
  if (typeof value !== "string" || !ICONS.has(value)) throw new Error("Extension main-view icon is invalid.");
  return value as ExtensionMainViewIcon;
}

function recommendationText(value: unknown, maximum: number, forbidden: RegExp): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !forbidden.test(value);
}

function requirePlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function requireExactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  required: readonly string[],
  label: string
): void {
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${label} has an invalid shape.`);
  }
}
/** Resident logic runs in a separate browser sandbox, without Node or UI authority. */
export interface ExtensionRuntimeDescriptor {
  readonly html: string;
  readonly tools: readonly { readonly name: string; readonly description: string; readonly inputSchema: Readonly<Record<string, unknown>>; readonly readOnly: boolean }[];
  readonly card?: { readonly externalLinks?: true };
  readonly mail?: true;
  readonly mailReader?: MailReaderDeclaration;
  readonly agent?: true;
  readonly deviceSync?: true;
  readonly targets?: true;
  readonly network?: ExtensionNetworkDeclaration;
  readonly tasks?: { readonly hidden?: true };
  readonly text?: { readonly oneshot: true; readonly model?: string };
  readonly showTaskPreferences?: boolean;
}
