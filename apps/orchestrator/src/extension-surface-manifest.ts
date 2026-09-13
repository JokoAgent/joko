import { extname, posix } from "node:path";

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
}

export interface ExtensionSurfaceBinding {
  /** Exact package-relative runtime Extension entry. */
  readonly entry: string;
  readonly mainView: ExtensionMainViewDescriptor;
}

const EXTENSION_SUFFIXES = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const ICONS = new Set<string>(EXTENSION_MAIN_VIEW_ICONS);
const MAXIMUM_SURFACES = 256;
const MAXIMUM_PATH_CHARACTERS = 2_048;
const MAXIMUM_TITLE_CHARACTERS = 80;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_TEXT = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const PORTABLE_COMPONENT = /^(?![. ]+$)[A-Za-z0-9@][A-Za-z0-9@._+ -]*$/u;

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
    requireExactKeys(binding, ["entry", "mainView"], ["entry", "mainView"], "Extension surface declaration");
    const entry = requirePortablePath(binding.entry, "Extension surface entry");
    if (!EXTENSION_SUFFIXES.has(extname(entry).toLowerCase())) throw new Error("Extension surface entry has an unsupported file type.");
    if (!discoveredEntries.has(entry)) throw new Error("Extension surface entry does not exactly match a discovered Extension.");
    if (seenEntries.has(entry)) throw new Error("Extension surface entry is declared more than once.");
    seenEntries.add(entry);

    const rawMainView = requirePlainObject(binding.mainView, "Extension main view");
    requireExactKeys(rawMainView, ["html", "title", "icon"], ["html"], "Extension main view");
    const html = requirePortablePath(rawMainView.html, "Extension main-view HTML");
    if (extname(html) !== ".html" || posix.dirname(html) === ".") {
      throw new Error("Extension main-view HTML must be a lowercase .html file in a self-contained directory.");
    }
    if (!discoveredFiles.has(html)) throw new Error("Extension main-view HTML is not an inspected regular package file.");
    const title = rawMainView.title === undefined ? undefined : requireTitle(rawMainView.title);
    const icon = rawMainView.icon === undefined ? undefined : requireIcon(rawMainView.icon);
    result.push({
      entry,
      mainView: {
        html,
        ...(title === undefined ? {} : { title }),
        ...(icon === undefined ? {} : { icon })
      }
    });
  }
  return result;
}

export function isExtensionMainViewDescriptor(value: unknown): value is ExtensionMainViewDescriptor {
  if (!isPlainObject(value)) return false;
  try {
    requireExactKeys(value, ["html", "title", "icon"], ["html"], "Extension main view");
    const html = requirePortablePath(value.html, "Extension main-view HTML");
    if (extname(html) !== ".html" || posix.dirname(html) === ".") return false;
    if (value.title !== undefined) requireTitle(value.title);
    if (value.icon !== undefined) requireIcon(value.icon);
    return true;
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
