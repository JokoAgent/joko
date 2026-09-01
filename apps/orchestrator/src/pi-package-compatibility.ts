import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { parse } from "@babel/parser";
import { minimatch } from "minimatch";

export type PiPackageCompatibility = "supported" | "partial" | "unsupported" | "unknown";

export type PiPackageCompatibilityIssue =
  | "working-indicator"
  | "widget-component"
  | "editor-integration"
  | "tui-layout"
  | "custom-ui"
  | "theme-control"
  | "terminal-input"
  | "tui-rendering"
  | "cli-flags"
  | "analysis-incomplete";

export type PiExtensionUiApi =
  | "select"
  | "confirm"
  | "input"
  | "editor"
  | "notify"
  | "setStatus"
  | "setWorkingMessage"
  | "setWorkingVisible"
  | "setWorkingIndicator"
  | "setHiddenThinkingLabel"
  | "setWidget"
  | "setTitle"
  | "setEditorText"
  | "getEditorText"
  | "pasteToEditor"
  | "getEditorComponent"
  | "addAutocompleteProvider"
  | "setEditorComponent"
  | "setFooter"
  | "setHeader"
  | "setToolsExpanded"
  | "getToolsExpanded"
  | "custom"
  | "getAllThemes"
  | "getTheme"
  | "setTheme"
  | "theme"
  | "onTerminalInput"
  | "registerShortcut"
  | "registerFlag"
  | "registerMessageRenderer"
  | "registerMarkdownTransformer"
  | "registerEntryRenderer";

export type PiPackageResourceDetailKind = "extension" | "skill" | "prompt" | "theme";

export interface PiExtensionCompatibilityAnalysis {
  readonly compatibility: Extract<PiPackageCompatibility, "supported" | "partial" | "unknown">;
  readonly compatibilityIssues: readonly PiPackageCompatibilityIssue[];
  readonly detectedApis: readonly PiExtensionUiApi[];
  readonly adaptedApis: readonly PiExtensionUiApi[];
  readonly unsupportedApis: readonly PiExtensionUiApi[];
  readonly scannedFiles: number;
}

export interface PiPackageResourceDetail {
  readonly kind: PiPackageResourceDetailKind;
  readonly name: string;
  readonly compatibility: PiPackageCompatibility;
  readonly compatibilityIssues: readonly PiPackageCompatibilityIssue[];
  readonly detectedApis: readonly PiExtensionUiApi[];
  readonly adaptedApis: readonly PiExtensionUiApi[];
  readonly unsupportedApis: readonly PiExtensionUiApi[];
}

export interface PiPackageRuntimeRequirement {
  readonly packageName: string;
  readonly range: string;
  readonly currentVersion?: string;
  readonly compatible: boolean | null;
}

export type PiPackageWarning =
  | "no-resources"
  | "inspection-failed"
  | "inspection-limit"
  | "lifecycle-scripts-disabled";

export interface PiPackageInspection {
  readonly name: string;
  readonly version?: string;
  readonly resources: readonly PiPackageResourceDetail[];
  readonly runtimeRequirements: readonly PiPackageRuntimeRequirement[];
  readonly warnings: readonly PiPackageWarning[];
  readonly disabledLifecycleScripts: readonly string[];
  readonly canToggle: boolean;
  readonly extensionContentFingerprint?: string;
  readonly compatibilityNotice: boolean;
}

const ADAPTED_APIS = new Set<PiExtensionUiApi>([
  "select",
  "confirm",
  "input",
  "editor",
  "notify",
  "setStatus",
  "setWidget",
  "setTitle",
  "setEditorText",
  "pasteToEditor"
]);

const ISSUE_BY_API: Readonly<Partial<Record<PiExtensionUiApi, PiPackageCompatibilityIssue>>> = {
  setWorkingMessage: "working-indicator",
  setWorkingVisible: "working-indicator",
  setWorkingIndicator: "working-indicator",
  setHiddenThinkingLabel: "working-indicator",
  getEditorText: "editor-integration",
  getEditorComponent: "editor-integration",
  addAutocompleteProvider: "editor-integration",
  setEditorComponent: "editor-integration",
  setFooter: "tui-layout",
  setHeader: "tui-layout",
  setToolsExpanded: "tui-layout",
  getToolsExpanded: "tui-layout",
  custom: "custom-ui",
  getAllThemes: "theme-control",
  getTheme: "theme-control",
  setTheme: "theme-control",
  theme: "theme-control",
  onTerminalInput: "terminal-input",
  registerShortcut: "tui-rendering",
  registerFlag: "cli-flags",
  registerMessageRenderer: "tui-rendering",
  registerMarkdownTransformer: "tui-rendering",
  registerEntryRenderer: "tui-rendering"
};

const KNOWN_APIS = new Set<PiExtensionUiApi>([
  ...ADAPTED_APIS,
  ...(Object.keys(ISSUE_BY_API) as PiExtensionUiApi[])
]);

const RUNTIME_PACKAGES = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui"
] as const;
const EXTENSION_SUFFIXES = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] as const;
const INSTALL_SCRIPT_NAMES = ["preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishOnly"] as const;
const MAX_ANALYSIS_FILES = 256;
const MAX_ANALYSIS_FILE_BYTES = 512 * 1024;
const MAX_ANALYSIS_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_ANALYSIS_DURATION_MS = 2_000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PACKAGE_ENTRIES = 4_096;
const MAX_PACKAGE_DEPTH = 32;
const MAX_MANIFEST_PATTERNS = 256;
const MAX_PACKAGE_INSPECTION_MS = 2_000;

interface SemverApi {
  valid(version: string): string | null;
  validRange(range: string): string | null;
  satisfies(version: string, range: string, options?: { readonly includePrerelease?: boolean }): boolean;
}

const semver = createRequire(import.meta.url)("semver") as SemverApi;

interface AstNode {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface MemberAccess {
  readonly object: unknown;
  readonly property?: string;
  readonly dynamic: boolean;
}

interface ParsedSource {
  readonly root: AstNode;
  readonly localImports: readonly string[];
  readonly recovered: boolean;
}

interface PackageEntry {
  readonly path: string;
  readonly relativePath: string;
  readonly directory: boolean;
}

interface PackageTree {
  readonly root: string;
  readonly entries: readonly PackageEntry[];
}

class PackageInspectionLimitError extends Error {
  constructor() {
    super("Package inspection exceeded its bounded analysis limits.");
    this.name = "PackageInspectionLimitError";
  }
}

export function evaluatePiRuntimeRequirements(
  peerDependencies: Readonly<Record<string, string>> | undefined,
  currentVersion: string | undefined
): readonly PiPackageRuntimeRequirement[] {
  if (peerDependencies === undefined) return [];
  const normalizedCurrent = currentVersion?.trim();
  return RUNTIME_PACKAGES.flatMap((packageName) => {
    const rawRange = peerDependencies[packageName];
    if (typeof rawRange !== "string" || rawRange.trim() === "") return [];
    const range = rawRange.trim().slice(0, 256);
    const comparable = normalizedCurrent !== undefined
      && semver.valid(normalizedCurrent) !== null
      && semver.validRange(range) !== null;
    return [{
      packageName,
      range,
      ...(normalizedCurrent === undefined || normalizedCurrent === "" ? {} : { currentVersion: normalizedCurrent.slice(0, 128) }),
      compatible: comparable
        ? semver.satisfies(normalizedCurrent, range, { includePrerelease: true })
        : null
    }];
  });
}

export async function analyzePiExtensionCompatibility(
  entryFile: string,
  packageRoot: string
): Promise<PiExtensionCompatibilityAnalysis> {
  const root = await canonicalRegularPath(packageRoot, true, "Extension package root");
  const entry = await canonicalRegularPath(entryFile, false, "Extension entry");
  assertWithin(root, entry, "Extension entry");
  const pending = [entry];
  const visited = new Set<string>();
  const detected = new Set<PiExtensionUiApi>();
  const explicitIssues = new Set<PiPackageCompatibilityIssue>();
  let incomplete = false;
  let totalBytes = 0;
  const deadline = Date.now() + MAX_ANALYSIS_DURATION_MS;

  while (pending.length > 0) {
    if (Date.now() > deadline || visited.size >= MAX_ANALYSIS_FILES) {
      incomplete = true;
      break;
    }
    const next = pending.shift()!;
    if (visited.has(next)) continue;
    visited.add(next);
    try {
      const source = await readStableFile(next, root, MAX_ANALYSIS_FILE_BYTES);
      totalBytes += source.byteLength;
      if (totalBytes > MAX_ANALYSIS_TOTAL_BYTES) {
        incomplete = true;
        break;
      }
      const parsed = parseSource(source.text);
      if (parsed.recovered) incomplete = true;
      const findings = detectUiApis(parsed.root);
      for (const api of findings.apis) detected.add(api);
      for (const issue of findings.issues) explicitIssues.add(issue);
      if (findings.dynamicUiAccess) incomplete = true;
      for (const specifier of parsed.localImports) {
        const resolved = await resolveLocalImport(next, specifier, root);
        if (resolved === undefined) incomplete = true;
        else if (!visited.has(resolved)) pending.push(resolved);
      }
    } catch {
      incomplete = true;
    }
  }

  const detectedApis = sorted(detected);
  const adaptedApis = detectedApis.filter((api) => ADAPTED_APIS.has(api));
  const unsupportedApis = detectedApis.filter((api) => !ADAPTED_APIS.has(api));
  const issues = new Set<PiPackageCompatibilityIssue>(explicitIssues);
  for (const api of unsupportedApis) {
    const issue = ISSUE_BY_API[api];
    if (issue !== undefined) issues.add(issue);
  }
  if (incomplete) issues.add("analysis-incomplete");
  const compatibility = unsupportedApis.length > 0 || explicitIssues.size > 0
    ? "partial"
    : incomplete
      ? "unknown"
      : "supported";
  return {
    compatibility,
    compatibilityIssues: sorted(issues),
    detectedApis,
    adaptedApis,
    unsupportedApis,
    scannedFiles: visited.size
  };
}

export async function inspectPiPackageCompatibility(
  packagePath: string,
  options: {
    readonly currentRuntimeVersion?: string;
    readonly contentFingerprint?: string;
  } = {}
): Promise<PiPackageInspection> {
  try {
    const source = await canonicalRegularPath(packagePath, undefined, "Package path");
    const sourceInfo = await lstat(source);
    if (sourceInfo.isFile()) {
      const extension = isExtensionFile(source)
        ? await extensionDetail(dirname(source), source)
        : undefined;
      const resources = extension === undefined ? [] : [extension];
      return completePackageInspection({
        name: boundedDisplay(basename(source)),
        resources,
        runtimeRequirements: [],
        warnings: resources.length === 0 ? ["no-resources"] : [],
        disabledLifecycleScripts: [],
        ...(extension === undefined || options.contentFingerprint === undefined
          ? {}
          : { extensionContentFingerprint: options.contentFingerprint })
      });
    }

    const tree = await enumeratePackageTree(source);
    const manifestEntry = tree.entries.find((entry) => !entry.directory && entry.relativePath === "package.json");
    const manifest = manifestEntry === undefined ? {} : await readPackageManifest(manifestEntry.path, source);
    const piManifest = plainObject(manifest.pi) ? manifest.pi : undefined;
    const resourceGroups = await Promise.all([
      packageResourcePaths(tree, piManifest, "extensions"),
      packageResourcePaths(tree, piManifest, "skills"),
      packageResourcePaths(tree, piManifest, "prompts"),
      packageResourcePaths(tree, piManifest, "themes")
    ]);
    const extensionPaths = collectExtensionFiles(tree, resourceGroups[0]);
    const skillPaths = collectSkillFiles(tree, resourceGroups[1]);
    const promptPaths = collectFilesWithSuffix(tree, resourceGroups[2], [".md"]);
    const themePaths = collectFilesWithSuffix(tree, resourceGroups[3], [".json"]);
    const extensionResources: PiPackageResourceDetail[] = [];
    for (const entry of extensionPaths) extensionResources.push(await extensionDetail(source, entry));
    const resources: PiPackageResourceDetail[] = [
      ...extensionResources,
      ...skillPaths.map((path) => basicResourceDetail("skill", basename(dirname(path)), "supported")),
      ...promptPaths.map((path) => basicResourceDetail("prompt", basename(path), "supported")),
      ...themePaths.map((path) => basicResourceDetail("theme", basename(path), "unsupported", ["theme-control"]))
    ];
    const peerDependencies = stringRecord(manifest.peerDependencies);
    const runtimeRequirements = evaluatePiRuntimeRequirements(peerDependencies, options.currentRuntimeVersion);
    const scripts = plainObject(manifest.scripts) ? manifest.scripts : undefined;
    const disabledLifecycleScripts = INSTALL_SCRIPT_NAMES.filter((name) => typeof scripts?.[name] === "string" && scripts[name].trim() !== "");
    const warnings: PiPackageWarning[] = [];
    if (disabledLifecycleScripts.length > 0) warnings.push("lifecycle-scripts-disabled");
    if (resources.length === 0) warnings.push("no-resources");
    return completePackageInspection({
      name: boundedDisplay(typeof manifest.name === "string" && manifest.name.trim() !== "" ? manifest.name : basename(source)),
      ...(typeof manifest.version === "string" && manifest.version.trim() !== ""
        ? { version: boundedDisplay(manifest.version, 128) }
        : {}),
      resources,
      runtimeRequirements,
      warnings,
      disabledLifecycleScripts,
      ...(extensionPaths.length === 0 || options.contentFingerprint === undefined
        ? {}
        : { extensionContentFingerprint: options.contentFingerprint })
    });
  } catch (error) {
    const warning: PiPackageWarning = error instanceof PackageInspectionLimitError ? "inspection-limit" : "inspection-failed";
    return completePackageInspection({
      name: boundedDisplay(basename(packagePath)),
      resources: [],
      runtimeRequirements: [],
      warnings: [warning],
      disabledLifecycleScripts: []
    });
  }
}

export async function inspectPiResourceCompatibility(
  kind: PiPackageResourceDetailKind | "package",
  path: string,
  options: {
    readonly currentRuntimeVersion?: string;
    readonly contentFingerprint?: string;
  } = {}
): Promise<PiPackageInspection> {
  if (kind === "package") return inspectPiPackageCompatibility(path, options);
  if (kind !== "extension") {
    const compatibility = kind === "theme" ? "unsupported" : "supported";
    const issues: readonly PiPackageCompatibilityIssue[] = kind === "theme" ? ["theme-control"] : [];
    return completePackageInspection({
      name: boundedDisplay(basename(path)),
      resources: [basicResourceDetail(kind, basename(path), compatibility, issues)],
      runtimeRequirements: [],
      warnings: [],
      disabledLifecycleScripts: []
    });
  }
  try {
    const canonical = await canonicalRegularPath(path, undefined, "Extension resource");
    const info = await lstat(canonical);
    let entry: string | undefined;
    if (info.isFile() && isExtensionFile(canonical)) entry = canonical;
    else if (info.isDirectory()) {
      for (const suffix of EXTENSION_SUFFIXES) {
        const candidate = join(canonical, `index${suffix}`);
        try {
          entry = await canonicalRegularPath(candidate, false, "Extension entry");
          break;
        } catch {
          // Try the next conventional entry.
        }
      }
    }
    if (entry === undefined) {
      const inspected = await inspectPiPackageCompatibility(canonical, options);
      const resources = inspected.resources.filter((resource) => resource.kind === "extension");
      return completePackageInspection({
        ...inspected,
        resources,
        warnings: resources.length === 0 ? [...new Set([...inspected.warnings, "no-resources" as const])] : inspected.warnings
      });
    }
    const detail = await extensionDetail(info.isDirectory() ? canonical : dirname(canonical), entry);
    return completePackageInspection({
      name: boundedDisplay(basename(canonical)),
      resources: [detail],
      runtimeRequirements: [],
      warnings: [],
      disabledLifecycleScripts: [],
      ...(options.contentFingerprint === undefined ? {} : { extensionContentFingerprint: options.contentFingerprint })
    });
  } catch {
    return completePackageInspection({
      name: boundedDisplay(basename(path)),
      resources: [],
      runtimeRequirements: [],
      warnings: ["inspection-failed"],
      disabledLifecycleScripts: []
    });
  }
}

export function shouldShowPiPackageNotice(inspection: PiPackageInspection, requiresExtensionApproval: boolean): boolean {
  return requiresExtensionApproval || inspection.compatibilityNotice;
}

function completePackageInspection(input: Omit<PiPackageInspection, "canToggle" | "compatibilityNotice">): PiPackageInspection {
  const canToggle = input.resources.some((resource) => resource.kind !== "theme");
  const compatibilityNotice = input.warnings.length > 0
    || input.resources.some((resource) => resource.compatibility !== "supported" || resource.compatibilityIssues.length > 0)
    || input.runtimeRequirements.some((requirement) => requirement.compatible !== true);
  return { ...input, canToggle, compatibilityNotice };
}

function basicResourceDetail(
  kind: PiPackageResourceDetailKind,
  name: string,
  compatibility: PiPackageCompatibility,
  compatibilityIssues: readonly PiPackageCompatibilityIssue[] = []
): PiPackageResourceDetail {
  return {
    kind,
    name: boundedDisplay(name),
    compatibility,
    compatibilityIssues,
    detectedApis: [],
    adaptedApis: [],
    unsupportedApis: []
  };
}

async function extensionDetail(root: string, entry: string): Promise<PiPackageResourceDetail> {
  try {
    const analysis = await analyzePiExtensionCompatibility(entry, root);
    return {
      kind: "extension",
      name: boundedDisplay(basename(entry)),
      compatibility: analysis.compatibility,
      compatibilityIssues: analysis.compatibilityIssues,
      detectedApis: analysis.detectedApis,
      adaptedApis: analysis.adaptedApis,
      unsupportedApis: analysis.unsupportedApis
    };
  } catch {
    return {
      ...basicResourceDetail("extension", basename(entry), "unknown", ["analysis-incomplete"])
    };
  }
}

function parseSource(source: string): ParsedSource {
  const root = parse(source, {
    sourceType: "unambiguous",
    errorRecovery: true,
    plugins: ["typescript", "jsx", "decorators-legacy", "importAttributes"]
  }) as unknown as AstNode;
  const imports = new Set<string>();
  walk(root, (node) => {
    if (
      (node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration")
      && isNode(node.source)
      && typeof node.source.value === "string"
      && node.source.value.startsWith(".")
    ) imports.add(node.source.value);
    if (node.type !== "CallExpression" && node.type !== "OptionalCallExpression") return;
    const callee = isNode(node.callee) ? node.callee : undefined;
    const dynamicImport = callee?.type === "Import";
    const requireCall = identifier(callee) === "require";
    if (!dynamicImport && !requireCall) return;
    const first = Array.isArray(node.arguments) ? node.arguments.find(isNode) : undefined;
    if (first !== undefined && typeof first.value === "string" && first.value.startsWith(".")) imports.add(first.value);
  });
  return {
    root,
    localImports: [...imports],
    recovered: Array.isArray(root.errors) && root.errors.length > 0
  };
}

function detectUiApis(root: AstNode): {
  readonly apis: ReadonlySet<PiExtensionUiApi>;
  readonly issues: ReadonlySet<PiPackageCompatibilityIssue>;
  readonly dynamicUiAccess: boolean;
} {
  const contexts = new Set(["ctx", "context", "extensionContext"]);
  const extensionApis = new Set(["pi", "extensionApi"]);
  const uiAliases = new Set<string>();
  const methodAliases = new Map<string, PiExtensionUiApi>();

  walk(root, (node) => {
    for (const parameter of functionParameters(node)) {
      const name = identifier(parameter);
      if (name !== undefined && (/^_?(?:ctx|context|extensionContext)$/iu.test(name) || containsTypeName(parameter, /Extension(?:Command|Tool)?Context$/u))) {
        contexts.add(name);
      }
      if (name !== undefined && (/^_?(?:pi|api|extensionApi)$/iu.test(name) || containsTypeName(parameter, /ExtensionAPI$/u))) {
        extensionApis.add(name);
      }
    }
    if ((node.type === "CallExpression" || node.type === "OptionalCallExpression") && member(node.callee)?.property === "on") {
      const callback = Array.isArray(node.arguments)
        ? node.arguments.filter(isNode).find((argument) => functionParameters(argument).length > 0)
        : undefined;
      const contextParameter = callback === undefined ? undefined : functionParameters(callback)[1];
      const name = identifier(contextParameter);
      if (name !== undefined) contexts.add(name);
    }
    if (node.type === "ObjectProperty" && isNode(node.value)) {
      registerStructuredContext(propertyName(node.key), functionParameters(node.value), contexts);
    }
    if (node.type === "ObjectMethod") {
      registerStructuredContext(propertyName(node.key), functionParameters(node), contexts);
    }
    if (node.type !== "VariableDeclarator" || !isNode(node.id)) return;
    const initialized = node.init;
    const local = identifier(node.id);
    if (local !== undefined) {
      if (isUiValue(initialized, contexts, uiAliases)) uiAliases.add(local);
      const access = member(initialized);
      if (access?.property !== undefined && KNOWN_APIS.has(access.property as PiExtensionUiApi)) {
        if (isUiValue(access.object, contexts, uiAliases) || isBoundIdentifier(access.object, extensionApis)) {
          methodAliases.set(local, access.property as PiExtensionUiApi);
        }
      }
      return;
    }
    if (node.id.type !== "ObjectPattern") return;
    for (const property of Array.isArray(node.id.properties) ? node.id.properties.filter(isNode) : []) {
      if (property.type !== "ObjectProperty") continue;
      const sourceName = propertyName(property.key);
      const destinationName = identifier(property.value);
      if (sourceName === undefined || destinationName === undefined) continue;
      if (sourceName === "ui" && isBoundIdentifier(initialized, contexts)) uiAliases.add(destinationName);
      if (KNOWN_APIS.has(sourceName as PiExtensionUiApi)
        && (isUiValue(initialized, contexts, uiAliases) || isBoundIdentifier(initialized, extensionApis))) {
        methodAliases.set(destinationName, sourceName as PiExtensionUiApi);
      }
    }
  });

  const apis = new Set<PiExtensionUiApi>();
  const issues = new Set<PiPackageCompatibilityIssue>();
  let dynamicUiAccess = false;
  const visit = (node: AstNode, activeInRpc: boolean): void => {
    if (!activeInRpc) return;
    if (node.type === "IfStatement" && isNode(node.test) && isNode(node.consequent)) {
      visit(node.test, true);
      const value = rpcConditionValue(node.test, contexts);
      if (value !== false) visit(node.consequent, true);
      if (isNode(node.alternate) && value !== true) visit(node.alternate, true);
      return;
    }
    if (node.type === "ConditionalExpression" && isNode(node.test) && isNode(node.consequent) && isNode(node.alternate)) {
      visit(node.test, true);
      const value = rpcConditionValue(node.test, contexts);
      if (value !== false) visit(node.consequent, true);
      if (value !== true) visit(node.alternate, true);
      return;
    }
    if (node.type === "LogicalExpression" && isNode(node.left) && isNode(node.right)) {
      visit(node.left, true);
      const value = rpcConditionValue(node.left, contexts);
      if (node.operator === "&&" && value !== false) visit(node.right, true);
      else if (node.operator === "||" && value !== true) visit(node.right, true);
      else if (node.operator === "??") visit(node.right, true);
      return;
    }
    if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
      const direct = identifier(node.callee);
      const aliased = direct === undefined ? undefined : methodAliases.get(direct);
      if (aliased !== undefined) apis.add(aliased);
      const access = member(node.callee);
      if (access !== undefined && (isUiValue(access.object, contexts, uiAliases) || isBoundIdentifier(access.object, extensionApis))) {
        if (access.property !== undefined && KNOWN_APIS.has(access.property as PiExtensionUiApi)) {
          const api = access.property as PiExtensionUiApi;
          apis.add(api);
          if (api === "setWidget") {
            const content = Array.isArray(node.arguments) ? node.arguments.filter(isNode)[1] : undefined;
            if (content !== undefined && (content.type === "ArrowFunctionExpression" || content.type === "FunctionExpression")) {
              issues.add("widget-component");
            }
          }
        } else if (access.dynamic) dynamicUiAccess = true;
      }
    }
    const access = member(node);
    if (access !== undefined && isUiValue(access.object, contexts, uiAliases)) {
      if (access.property === "theme") apis.add("theme");
      else if (access.dynamic) dynamicUiAccess = true;
    }
    for (const child of childNodes(node)) visit(child, true);
  };
  visit(root, true);
  return { apis, issues, dynamicUiAccess };
}

function registerStructuredContext(
  memberName: string | undefined,
  parameters: readonly AstNode[],
  contexts: Set<string>
): void {
  const contextParameter = memberName === "handler"
    ? parameters[1]
    : memberName === "execute"
      ? parameters.at(-1)
      : undefined;
  const name = identifier(contextParameter);
  if (name !== undefined) contexts.add(name);
}

function rpcConditionValue(node: AstNode, contexts: ReadonlySet<string>): boolean | undefined {
  if (node.type === "UnaryExpression" && node.operator === "!" && isNode(node.argument)) {
    const nested = rpcConditionValue(node.argument, contexts);
    return nested === undefined ? undefined : !nested;
  }
  if (node.type !== "BinaryExpression") return undefined;
  const operator = typeof node.operator === "string" ? node.operator : "";
  if (!(operator === "===" || operator === "==" || operator === "!==" || operator === "!=")) return undefined;
  const left = member(node.left);
  const right = member(node.right);
  const leftValue = stringLiteral(node.left);
  const rightValue = stringLiteral(node.right);
  const leftMode = left?.property === "mode" && isBoundIdentifier(left.object, contexts);
  const rightMode = right?.property === "mode" && isBoundIdentifier(right.object, contexts);
  const compared = leftMode ? rightValue : rightMode ? leftValue : undefined;
  if (compared === undefined) return undefined;
  const equal = compared === "rpc";
  return operator === "===" || operator === "==" ? equal : !equal;
}

function isUiValue(value: unknown, contexts: ReadonlySet<string>, aliases: ReadonlySet<string>): boolean {
  const name = identifier(value);
  if (name !== undefined && aliases.has(name)) return true;
  const access = member(value);
  return access?.property === "ui" && isBoundIdentifier(access.object, contexts);
}

function isBoundIdentifier(value: unknown, names: ReadonlySet<string>): boolean {
  const name = identifier(value);
  return name !== undefined && names.has(name);
}

function containsTypeName(node: AstNode, pattern: RegExp): boolean {
  let found = false;
  walk(node, (candidate) => {
    const name = identifier(candidate);
    if (name !== undefined && pattern.test(name)) found = true;
  });
  return found;
}

function functionParameters(node: AstNode): readonly AstNode[] {
  if (!(node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression" || node.type === "ObjectMethod")) return [];
  return Array.isArray(node.params) ? node.params.filter(isNode) : [];
}

function walk(node: AstNode, visit: (node: AstNode) => void): void {
  visit(node);
  for (const child of childNodes(node)) walk(child, visit);
}

function childNodes(node: AstNode): AstNode[] {
  const result: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "extra" || key === "errors") continue;
    if (isNode(value)) result.push(value);
    else if (Array.isArray(value)) for (const item of value) if (isNode(item)) result.push(item);
  }
  return result;
}

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as { readonly type?: unknown }).type === "string";
}

function identifier(value: unknown): string | undefined {
  return isNode(value) && value.type === "Identifier" && typeof value.name === "string" ? value.name : undefined;
}

function propertyName(value: unknown): string | undefined {
  if (!isNode(value)) return undefined;
  if (value.type === "Identifier" && typeof value.name === "string") return value.name;
  return (value.type === "StringLiteral" || value.type === "Literal") && typeof value.value === "string" ? value.value : undefined;
}

function stringLiteral(value: unknown): string | undefined {
  return isNode(value) && (value.type === "StringLiteral" || value.type === "Literal") && typeof value.value === "string"
    ? value.value
    : undefined;
}

function member(value: unknown): MemberAccess | undefined {
  if (!isNode(value) || (value.type !== "MemberExpression" && value.type !== "OptionalMemberExpression")) return undefined;
  const property = value.computed === true ? stringLiteral(value.property) : propertyName(value.property);
  return { object: value.object, ...(property === undefined ? {} : { property }), dynamic: property === undefined };
}

async function resolveLocalImport(fromFile: string, specifier: string, root: string): Promise<string | undefined> {
  const base = resolve(dirname(fromFile), specifier);
  if (!within(root, base)) return undefined;
  const suffix = extname(base).toLowerCase();
  const candidates = new Set<string>([base]);
  if (suffix !== "") {
    for (const extension of EXTENSION_SUFFIXES) candidates.add(`${base.slice(0, -suffix.length)}${extension}`);
  } else {
    for (const extension of EXTENSION_SUFFIXES) {
      candidates.add(`${base}${extension}`);
      candidates.add(join(base, `index${extension}`));
    }
  }
  for (const candidate of candidates) {
    try {
      const canonical = await canonicalRegularPath(candidate, false, "Imported extension module");
      if (within(root, canonical)) return canonical;
    } catch {
      // Continue through the bounded candidate set.
    }
  }
  return undefined;
}

async function enumeratePackageTree(root: string): Promise<PackageTree> {
  const entries: PackageEntry[] = [];
  const deadline = Date.now() + MAX_PACKAGE_INSPECTION_MS;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_PACKAGE_DEPTH || entries.length > MAX_PACKAGE_ENTRIES || Date.now() > deadline) throw new PackageInspectionLimitError();
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      if (entries.length >= MAX_PACKAGE_ENTRIES || Date.now() > deadline) throw new PackageInspectionLimitError();
      validatePathComponent(child.name);
      const path = join(directory, child.name);
      const info = await lstat(path);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error("Package tree contains an unsafe filesystem entry.");
      const canonical = await realpath(path);
      assertWithin(root, canonical, "Package entry");
      const relativePath = toPosix(relative(root, canonical));
      entries.push({ path: canonical, relativePath, directory: info.isDirectory() });
      if (info.isDirectory() && child.name !== "node_modules" && !child.name.startsWith(".")) {
        await visit(canonical, depth + 1);
      }
    }
  };
  await visit(root, 0);
  return { root, entries };
}

async function readPackageManifest(path: string, root: string): Promise<Record<string, unknown>> {
  const source = await readStableFile(path, root, MAX_MANIFEST_BYTES);
  let decoded: unknown;
  try {
    decoded = JSON.parse(source.text);
  } catch {
    throw new Error("Package manifest is invalid.");
  }
  if (!plainObject(decoded)) throw new Error("Package manifest must be an object.");
  return decoded;
}

async function packageResourcePaths(
  tree: PackageTree,
  manifest: Record<string, unknown> | undefined,
  kind: "extensions" | "skills" | "prompts" | "themes"
): Promise<readonly PackageEntry[]> {
  const raw = manifest === undefined ? [kind] : manifest[kind] ?? [];
  if (!Array.isArray(raw) || raw.length > MAX_MANIFEST_PATTERNS || !raw.every((item) => typeof item === "string")) {
    throw new Error(`Package manifest field pi.${kind} is invalid.`);
  }
  const patterns = raw.map((item) => normalizeManifestPattern(item));
  const sourcePatterns = patterns.filter((pattern) => !/^[!+-]/u.test(pattern));
  const selected = new Map<string, PackageEntry>();
  for (const pattern of sourcePatterns) {
    for (const entry of matchingEntries(tree, pattern)) selected.set(entry.relativePath, entry);
  }
  for (const pattern of patterns.filter((item) => /^[!+-]/u.test(item))) {
    const marker = pattern[0]!;
    const body = pattern.slice(1);
    const matches = matchingEntries(tree, body);
    if (marker === "+") for (const entry of matches) selected.set(entry.relativePath, entry);
    else for (const entry of matches) selected.delete(entry.relativePath);
  }
  return [...selected.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
}

function matchingEntries(tree: PackageTree, pattern: string, allowGlob = true): readonly PackageEntry[] {
  const glob = allowGlob && /[*?\[]/u.test(pattern);
  return tree.entries.filter((entry) => glob
    ? minimatch(entry.relativePath, pattern, { dot: false, nocase: false })
    : entry.relativePath === pattern || entry.relativePath.startsWith(`${pattern}/`));
}

function normalizeManifestPattern(value: string): string {
  const trimmed = value.trim().replaceAll("\\", "/");
  if (trimmed === "" || trimmed.length > 2_048 || /[\r\n\0]/u.test(trimmed)) throw new Error("Package manifest path is invalid.");
  const marker = /^[!+-]/u.test(trimmed) ? trimmed[0]! : "";
  let body = marker === "" ? trimmed : trimmed.slice(1);
  while (body.startsWith("./")) body = body.slice(2);
  if (body === "" || body.startsWith("/") || isAbsolute(body) || body.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Package manifest path escapes its package root.");
  }
  return `${marker}${body}`;
}

function collectExtensionFiles(tree: PackageTree, roots: readonly PackageEntry[]): readonly string[] {
  const values = new Set<string>();
  for (const root of roots) {
    if (!root.directory) {
      if (isExtensionFile(root.path)) values.add(root.path);
      continue;
    }
    const direct = tree.entries.filter((entry) => !entry.directory && dirname(entry.relativePath) === root.relativePath && isExtensionFile(entry.path));
    const ownIndex = direct.find((entry) => basename(entry.path).toLowerCase().startsWith("index."));
    if (ownIndex !== undefined) values.add(ownIndex.path);
    else for (const entry of direct) values.add(entry.path);
    const children = tree.entries.filter((entry) => entry.directory && dirname(entry.relativePath) === root.relativePath && basename(entry.path) !== "node_modules");
    for (const child of children) {
      const entry = tree.entries.find((candidate) => !candidate.directory && dirname(candidate.relativePath) === child.relativePath && basename(candidate.path).toLowerCase().startsWith("index.") && isExtensionFile(candidate.path));
      if (entry !== undefined) values.add(entry.path);
    }
  }
  return [...values].sort((left, right) => left.localeCompare(right, "en"));
}

function collectSkillFiles(tree: PackageTree, roots: readonly PackageEntry[]): readonly string[] {
  const values = new Set<string>();
  for (const root of roots) {
    if (!root.directory) {
      if (extname(root.path).toLowerCase() === ".md") values.add(root.path);
      continue;
    }
    for (const entry of tree.entries) {
      if (entry.directory || !(entry.relativePath === `${root.relativePath}/SKILL.md` || entry.relativePath.startsWith(`${root.relativePath}/`) && basename(entry.path) === "SKILL.md")) continue;
      values.add(entry.path);
    }
    for (const entry of tree.entries) {
      if (!entry.directory && dirname(entry.relativePath) === root.relativePath && extname(entry.path).toLowerCase() === ".md") values.add(entry.path);
    }
  }
  return [...values].sort((left, right) => left.localeCompare(right, "en"));
}

function collectFilesWithSuffix(tree: PackageTree, roots: readonly PackageEntry[], suffixes: readonly string[]): readonly string[] {
  const values = new Set<string>();
  for (const root of roots) {
    if (!root.directory) {
      if (suffixes.includes(extname(root.path).toLowerCase())) values.add(root.path);
      continue;
    }
    for (const entry of tree.entries) {
      if (!entry.directory && entry.relativePath.startsWith(`${root.relativePath}/`) && suffixes.includes(extname(entry.path).toLowerCase())) values.add(entry.path);
    }
  }
  return [...values].sort((left, right) => left.localeCompare(right, "en"));
}

async function canonicalRegularPath(path: string, directory: boolean | undefined, label: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0")) throw new Error(`${label} must be a normalized absolute path.`);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) throw new Error(`${label} must be a regular file or directory.`);
  if (directory === true && !info.isDirectory()) throw new Error(`${label} must be a regular directory.`);
  if (directory === false && !info.isFile()) throw new Error(`${label} must be a regular file.`);
  const canonical = await realpath(path);
  if (!samePath(path, canonical)) throw new Error(`${label} contains a path alias or junction.`);
  return canonical;
}

async function readStableFile(path: string, root: string, maximumBytes: number): Promise<{ readonly text: string; readonly byteLength: number }> {
  assertWithin(root, path, "Package file");
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximumBytes) throw new Error("Package file is missing, unsafe, or too large.");
  const handle = await open(path, constants.O_RDONLY);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== before.size || !sameIdentity(before, opened)) throw new Error("Package file changed before inspection.");
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== buffer.length || after.size !== opened.size || !sameIdentity(opened, after)) throw new Error("Package file changed during inspection.");
    return { text: buffer.toString("utf8"), byteLength: buffer.length };
  } finally {
    await handle.close();
  }
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!plainObject(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) if (typeof item === "string") result[key] = item;
  return result;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedDisplay(value: string, maximum = 256): string {
  const trimmed = value.trim().replace(/[\r\n\0]+/gu, " ");
  return (trimmed === "" ? "unnamed" : trimmed).slice(0, maximum);
}

function isExtensionFile(path: string): boolean {
  return EXTENSION_SUFFIXES.includes(extname(path).toLowerCase() as typeof EXTENSION_SUFFIXES[number]);
}

function sorted<T extends string>(values: Iterable<T>): T[] {
  return [...values].sort((left, right) => left.localeCompare(right, "en"));
}

function validatePathComponent(name: string): void {
  if (name === "." || name === ".." || name.includes("\0") || name.includes("/") || name.includes("\\")) throw new Error("Package contains an invalid path component.");
}

function toPosix(value: string): string {
  return value.split(sep).join("/");
}

function assertWithin(root: string, candidate: string, label: string): void {
  if (!within(root, candidate)) throw new Error(`${label} escapes its package boundary.`);
}

function within(root: string, candidate: string): boolean {
  const suffix = relative(resolve(root), resolve(candidate));
  return suffix === "" || suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sameIdentity(left: { readonly dev: number; readonly ino: number }, right: { readonly dev: number; readonly ino: number }): boolean {
  return left.dev === right.dev && (left.ino === 0 || right.ino === 0 || left.ino === right.ino);
}

export function piPackageInspectionDigest(value: PiPackageInspection): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
