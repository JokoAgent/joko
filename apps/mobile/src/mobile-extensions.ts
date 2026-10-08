import {
  ExtensionCatalogSource,
  ExtensionInstallState,
  ExtensionMainViewIcon,
  ExtensionSetupFieldKind,
  ExtensionSetupState,
  type ExtensionCatalogEntry
} from "@joko/contracts";

const EXTENSION_ID = /^extension_[a-f0-9]{32}$/u;
const SOURCE_ID = /^extension_source_[a-f0-9]{32}$/u;
const SOURCE_ENTRY_ID = /^extension_source_entry_[a-f0-9]{32}$/u;
const CONTENT_REVISION = /^sha256:[a-f0-9]{64}$/u;
const RECOMMENDATION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const RECOMMENDATION_COMMAND = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const FORBIDDEN_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const FORBIDDEN_LONG_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const FORBIDDEN_RECOMMENDATION_LABEL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const FORBIDDEN_RECOMMENDATION_PROMPT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const MAXIMUM_CATALOG_ENTRIES = 10_000;
const MAXIMUM_CATALOG_PAGES = 10_000;

export type MobileExtensionOwner =
  | {
      readonly kind: "resource";
      readonly resourceId: string;
      readonly discoveredRevision: string;
      readonly resourceRevision: bigint;
    }
  | { readonly kind: "mcp"; readonly serverId: string; readonly serverRevision: bigint }
  | {
      readonly kind: "source";
      readonly sourceId: string;
      readonly sourceRevision: bigint;
      readonly entryId: string;
      readonly contentRevision: string;
    };

export interface MobileExtension {
  readonly extensionId: string;
  readonly revision: bigint;
  readonly owner: MobileExtensionOwner;
  readonly source: "local" | "market";
  readonly installed: boolean;
  readonly installState: "available" | "installing" | "installed" | "updateAvailable" | "error";
  readonly name: string;
  readonly version?: string;
  readonly author?: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly sidebarSupported: boolean;
  readonly sidebarVisible: boolean;
  readonly mainView?: {
    readonly title?: string;
    readonly icon?: "activity" | "box" | "code" | "fileText" | "globe" | "layout" | "search" | "sparkles" | "terminal" | "tool";
  };
  readonly library?: { readonly schemaVersion: 1 };
  readonly tools: readonly {
    readonly name: string;
    readonly description: string;
    readonly requiresPermission: boolean;
  }[];
  readonly permissions: readonly {
    readonly permissionId: string;
    readonly label: string;
    readonly description: string;
    readonly required: boolean;
    readonly granted: boolean;
  }[];
  readonly commands: readonly MobileExtensionCommand[];
  readonly setup: {
    readonly state: "notRequired" | "required" | "inProgress" | "ready" | "cancelled" | "failed";
    readonly attemptId?: string;
    readonly revision: bigint;
    readonly fields: readonly {
      readonly fieldId: string;
      readonly label: string;
      readonly description: string;
      readonly kind: "text" | "secret" | "oauth" | "confirmation";
      readonly required: boolean;
      readonly configured: boolean;
      readonly options: readonly string[];
    }[];
    readonly error?: string;
  };
  readonly useSupported: boolean;
  readonly error?: string;
  readonly updateAvailable: boolean;
}

export interface MobileExtensionCatalog {
  readonly revision: bigint;
  readonly recoveredFromCorruption: boolean;
  readonly extensions: readonly MobileExtension[];
}

export interface MobileExtensionCatalogPage {
  readonly revision: bigint;
  readonly recoveredFromCorruption: boolean;
  readonly extensions: readonly ExtensionCatalogEntry[];
  readonly nextPageToken: string;
  readonly totalSize: number;
}

export type MobileExtensionCredentialKind = "apiKey" | "oauth" | "headerSecret";

export type MobileExtensionPendingMutationKind =
  | "enabled"
  | "sidebar"
  | "setupBegin"
  | "setupInteraction"
  | "setupCredential"
  | "setupComplete"
  | "setupCancel"
  | "setupRevoke";

export interface MobileExtensionPendingMutation {
  readonly operationId: string;
  readonly extensionId: string;
  readonly kind: MobileExtensionPendingMutationKind;
  readonly state: "unknown" | "accepted";
}

export interface MobileExtensionMutationResult {
  readonly catalog: MobileExtensionCatalog;
  readonly extension: MobileExtension;
}

export interface MobileExtensionCommand {
  readonly name: string;
  readonly description: string;
  readonly sessionId: string;
}

export interface MobileExtensionTaskChoice {
  readonly sessionId: string;
  readonly displayName: string;
  readonly targetName: string;
}

export type MobileExtensionUseDestination =
  | { readonly kind: "newTask" }
  | { readonly kind: "task"; readonly sessionId: string };

export type MobileExtensionUseResult =
  | { readonly kind: "newTask" }
  | { readonly kind: "task"; readonly sessionId: string };

export interface MobileExtensionTransport {
  readonly ownerKey: string;
  readonly pending: readonly MobileExtensionPendingMutation[];
  list(signal: AbortSignal): Promise<MobileExtensionCatalog>;
  detail(expected: MobileExtension, signal: AbortSignal): Promise<MobileExtension>;
  setEnabled(expected: MobileExtension, enabled: boolean, signal: AbortSignal): Promise<MobileExtensionMutationResult>;
  setSidebarVisible(expected: MobileExtension, visible: boolean, signal: AbortSignal): Promise<MobileExtensionMutationResult>;
  beginSetup(expected: MobileExtension, signal: AbortSignal): Promise<MobileExtensionMutationResult>;
  submitSetupInteraction(
    expected: MobileExtension,
    fieldId: string,
    value: string | boolean,
    signal: AbortSignal
  ): Promise<MobileExtensionMutationResult>;
  saveSetupCredential(
    expected: MobileExtension,
    fieldId: string,
    kind: MobileExtensionCredentialKind,
    secret: string,
    signal: AbortSignal
  ): Promise<MobileExtensionMutationResult>;
  completeSetup(expected: MobileExtension, signal: AbortSignal): Promise<MobileExtensionMutationResult>;
  cancelSetup(expected: MobileExtension, signal: AbortSignal): Promise<MobileExtensionMutationResult>;
  revokeSetup(expected: MobileExtension, signal: AbortSignal): Promise<MobileExtensionMutationResult>;
  tasks(expected: MobileExtension): readonly MobileExtensionTaskChoice[];
  useCommand(
    expected: MobileExtension,
    command: MobileExtensionCommand,
    destination: MobileExtensionUseDestination,
    signal: AbortSignal
  ): Promise<MobileExtensionUseResult>;
  reconcile(operationId: string, signal: AbortSignal): Promise<void>;
  dismiss(operationId: string, signal: AbortSignal): Promise<void>;
}

export function mobileExtensionKey(extension: MobileExtension): string {
  return [
    extension.extensionId,
    extension.revision.toString(10),
    mobileExtensionOwnerKey(extension.owner),
    extension.installState,
    extension.enabled ? "enabled" : "disabled",
    extension.sidebarSupported ? "sidebar" : "no-sidebar",
    extension.sidebarVisible ? "visible" : "hidden",
    JSON.stringify({
      state: extension.setup.state,
      attemptId: extension.setup.attemptId ?? "",
      revision: extension.setup.revision.toString(10),
      fields: extension.setup.fields.map((field) => ({
        fieldId: field.fieldId,
        label: field.label,
        description: field.description,
        kind: field.kind,
        required: field.required,
        configured: field.configured,
        options: field.options
      })),
      error: extension.setup.error ?? ""
    })
  ].join("\u001f");
}

export function mobileExtensionOwnerKey(owner: MobileExtensionOwner): string {
  switch (owner.kind) {
    case "resource":
      return [owner.kind, owner.resourceId, owner.discoveredRevision, owner.resourceRevision.toString(10)].join("\u001f");
    case "mcp":
      return [owner.kind, owner.serverId, owner.serverRevision.toString(10)].join("\u001f");
    case "source":
      return [
        owner.kind,
        owner.sourceId,
        owner.sourceRevision.toString(10),
        owner.entryId,
        owner.contentRevision
      ].join("\u001f");
  }
}

export async function collectMobileExtensionCatalog(
  readPage: (pageToken: string, signal: AbortSignal) => Promise<MobileExtensionCatalogPage>,
  signal: AbortSignal
): Promise<MobileExtensionCatalog> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await collectStableCatalog(readPage, signal);
    } catch (error) {
      if (!(error instanceof CatalogRevisionDrift) || attempt > 0) throw error;
    }
  }
  throw new Error("The Joko node changed the Extension catalog while it was being read.");
}

export function projectMobileExtension(value: ExtensionCatalogEntry): MobileExtension {
  const revision = positiveRevision(value.revision?.value, "Extension revision");
  if (!EXTENSION_ID.test(value.extensionId)) invalid("Extension identity");
  const owner = projectOwner(value);
  const source = value.source === ExtensionCatalogSource.LOCAL
    ? "local" as const
    : value.source === ExtensionCatalogSource.MARKET
      ? "market" as const
      : invalid("Extension source");
  const installState = projectInstallState(value.installState);
  const name = requiredText(value.name, 160, "Extension name");
  const version = optionalText(value.version, 160, "Extension version");
  const author = optionalText(value.author, 160, "Extension author");
  const description = longText(value.description, 8_192, "Extension description");
  const mainView = value.mainView === undefined ? undefined : {
    ...(value.mainView.title === undefined
      ? {}
      : { title: requiredText(value.mainView.title, 80, "Extension main-view title") }),
    ...(projectMainViewIcon(value.mainView.icon) === undefined
      ? {}
      : { icon: projectMainViewIcon(value.mainView.icon)! })
  };
  if (value.sidebarSupported !== (mainView !== undefined) || value.sidebarVisible && mainView === undefined) {
    invalid("Extension main-view capability");
  }
  const library = value.library === undefined
    ? undefined
    : value.library.schemaVersion === 1
      ? { schemaVersion: 1 as const }
      : invalid("Extension Library capability");

  if (value.tools.length > 256 || value.permissions.length > 256 || value.commands.length > 256) {
    invalid("Extension descriptor size");
  }
  const tools = uniqueMap(value.tools, (tool) => tool.name, "Extension tool", (tool) => ({
    name: requiredText(tool.name, 160, "Extension tool name"),
    description: longText(tool.description, 2_048, "Extension tool description"),
    requiresPermission: tool.requiresPermission
  }));
  const permissions = uniqueMap(value.permissions, (permission) => permission.permissionId, "Extension permission", (permission) => ({
    permissionId: identity(permission.permissionId, 256, "Extension permission identity"),
    label: requiredText(permission.label, 160, "Extension permission label"),
    description: longText(permission.description, 2_048, "Extension permission description"),
    required: permission.required,
    granted: permission.granted
  }));
  const commands = uniqueMap(value.commands, (command) => command.name, "Extension command", (command) => ({
    name: requiredText(command.name, 160, "Extension command name"),
    description: longText(command.description, 2_048, "Extension command description"),
    sessionId: command.sessionId === "" ? "" : identity(command.sessionId, 512, "Extension command task identity")
  }));

  const setup = value.setup;
  if (setup?.revision?.value === undefined || setup.fields.length > 64) invalid("Extension setup descriptor");
  const setupFields = uniqueMap(setup.fields, (field) => field.fieldId, "Extension setup field", (field) => {
    if (field.options.length > 128) invalid("Extension setup options");
    const options = uniqueStrings(field.options, 512, "Extension setup option");
    return {
      fieldId: identity(field.fieldId, 256, "Extension setup field identity"),
      label: requiredText(field.label, 160, "Extension setup field label"),
      description: longText(field.description, 2_048, "Extension setup field description"),
      kind: projectSetupFieldKind(field.kind),
      required: field.required,
      configured: field.configured,
      options
    };
  });
  const setupState = projectSetupState(setup.state);
  const setupError = optionalLongText(setup.error, 4_096, "Extension setup error");
  const attemptId = setup.attemptId === undefined
    ? undefined
    : identity(setup.attemptId, 256, "Extension setup attempt identity");
  const setupRevision = nonNegativeRevision(setup.revision?.value, "Extension setup revision");
  if ((setupState === "inProgress" || setupState === "cancelled" || setupState === "failed")
    && attemptId === undefined) invalid("Extension setup attempt");
  if ((setupState === "notRequired" && (attemptId !== undefined || setupFields.length !== 0 || setupRevision !== 0n))
    || (setupState !== "notRequired" && setupFields.length === 0)
    || (setupState === "required" && (attemptId !== undefined || setupFields.length === 0 || setupRevision !== 0n))
    || (attemptId === undefined && setupRevision !== 0n)
    || (attemptId !== undefined && setupRevision === 0n)) {
    invalid("Extension setup state");
  }
  if (setupFields.some((field) => field.kind !== "text" && field.options.length > 0)) {
    invalid("Extension setup options");
  }

  validateRecommendations(value);
  if (value.update !== undefined) {
    projectSourceOwner(value.update.source);
    optionalText(value.update.availableVersion, 160, "Extension update version");
    if (owner.kind !== "resource") invalid("Extension package update owner");
  }
  const error = optionalLongText(value.error, 4_096, "Extension error");

  return {
    extensionId: value.extensionId,
    revision,
    owner,
    source,
    installed: value.installed,
    installState,
    name,
    ...(version === undefined ? {} : { version }),
    ...(author === undefined ? {} : { author }),
    description,
    enabled: value.enabled,
    sidebarSupported: value.sidebarSupported,
    sidebarVisible: value.sidebarVisible,
    ...(mainView === undefined ? {} : { mainView }),
    ...(library === undefined ? {} : { library }),
    tools,
    permissions,
    commands,
    setup: {
      state: setupState,
      ...(attemptId === undefined ? {} : { attemptId }),
      revision: setupRevision,
      fields: setupFields,
      ...(setupError === undefined ? {} : { error: setupError })
    },
    useSupported: value.useSupported,
    ...(error === undefined ? {} : { error }),
    updateAvailable: value.update !== undefined || installState === "updateAvailable"
  };
}

export function filterMobileExtensions(
  extensions: readonly MobileExtension[],
  query: string
): readonly MobileExtension[] {
  const needle = query.trim().normalize("NFKC").toLocaleLowerCase();
  if (!needle) return extensions;
  return extensions.filter((extension) => [extension.name, extension.description, extension.author ?? ""]
    .some((candidate) => candidate.normalize("NFKC").toLocaleLowerCase().includes(needle)));
}

async function collectStableCatalog(
  readPage: (pageToken: string, signal: AbortSignal) => Promise<MobileExtensionCatalogPage>,
  signal: AbortSignal
): Promise<MobileExtensionCatalog> {
  const extensions: MobileExtension[] = [];
  const identities = new Set<string>();
  const pageTokens = new Set<string>();
  let pageToken = "";
  let revision: bigint | undefined;
  let recoveredFromCorruption: boolean | undefined;
  let totalSize: number | undefined;

  for (let pageNumber = 0; pageNumber < MAXIMUM_CATALOG_PAGES; pageNumber += 1) {
    if (signal.aborted) throw signal.reason;
    if (pageTokens.has(pageToken)) invalid("Extension catalog page cycle");
    pageTokens.add(pageToken);
    const page = await readPage(pageToken, signal);
    const pageRevision = nonNegativeRevision(page.revision, "Extension catalog revision");
    if (!Number.isSafeInteger(page.totalSize) || page.totalSize < 0 || page.totalSize > MAXIMUM_CATALOG_ENTRIES) {
      invalid("Extension catalog total size");
    }
    if (revision !== undefined && (pageRevision !== revision || page.recoveredFromCorruption !== recoveredFromCorruption)) {
      throw new CatalogRevisionDrift();
    }
    revision ??= pageRevision;
    recoveredFromCorruption ??= page.recoveredFromCorruption;
    totalSize ??= page.totalSize;
    if (page.extensions.length > 500 || page.totalSize !== totalSize
      || extensions.length + page.extensions.length > MAXIMUM_CATALOG_ENTRIES
      || page.nextPageToken !== "" && page.extensions.length === 0) {
      invalid("Extension catalog pagination");
    }
    for (const raw of page.extensions) {
      const extension = projectMobileExtension(raw);
      if (!extension.installed || identities.has(extension.extensionId)) invalid("installed Extension catalog entry");
      identities.add(extension.extensionId);
      extensions.push(extension);
    }
    if (page.nextPageToken === "") break;
    pageToken = identity(page.nextPageToken, 4_096, "Extension catalog page token");
    if (pageNumber === MAXIMUM_CATALOG_PAGES - 1) invalid("Extension catalog page count");
  }
  if (revision === undefined || recoveredFromCorruption === undefined || totalSize === undefined
    || extensions.length !== totalSize) invalid("Extension catalog completeness");
  extensions.sort((left, right) => left.name.localeCompare(right.name, "en", { sensitivity: "base" })
    || left.extensionId.localeCompare(right.extensionId, "en"));
  return { revision, recoveredFromCorruption, extensions };
}

function projectOwner(value: ExtensionCatalogEntry): MobileExtensionOwner {
  const owner = value.owner?.kind;
  if (owner?.case === "resource") {
    return {
      kind: "resource",
      resourceId: identity(owner.value.resourceId, 256, "Extension Resource identity"),
      discoveredRevision: identity(owner.value.discoveredRevision, 256, "Extension discovered revision"),
      resourceRevision: positiveRevision(owner.value.resourceVersion?.value, "Extension Resource revision")
    };
  }
  if (owner?.case === "mcp") {
    return {
      kind: "mcp",
      serverId: identity(owner.value.mcpServerId, 256, "Extension MCP server identity"),
      serverRevision: positiveRevision(owner.value.serverRevision?.value, "Extension MCP server revision")
    };
  }
  if (owner?.case === "source") return projectSourceOwner(owner.value);
  return invalid("Extension owner");
}

function projectSourceOwner(value: {
  readonly sourceId: string;
  readonly sourceRevision?: { readonly value: bigint };
  readonly entryId: string;
  readonly contentRevision: string;
} | undefined): Extract<MobileExtensionOwner, { readonly kind: "source" }> {
  if (!value || !SOURCE_ID.test(value.sourceId) || !SOURCE_ENTRY_ID.test(value.entryId)
    || !CONTENT_REVISION.test(value.contentRevision)) invalid("Extension Source owner");
  return {
    kind: "source",
    sourceId: value.sourceId,
    sourceRevision: positiveRevision(value.sourceRevision?.value, "Extension Source revision"),
    entryId: value.entryId,
    contentRevision: value.contentRevision
  };
}

function projectInstallState(value: ExtensionInstallState): MobileExtension["installState"] {
  switch (value) {
    case ExtensionInstallState.AVAILABLE: return "available";
    case ExtensionInstallState.INSTALLING: return "installing";
    case ExtensionInstallState.INSTALLED: return "installed";
    case ExtensionInstallState.UPDATE_AVAILABLE: return "updateAvailable";
    case ExtensionInstallState.ERROR: return "error";
    default: return invalid("Extension install state");
  }
}

function projectSetupState(value: ExtensionSetupState): MobileExtension["setup"]["state"] {
  switch (value) {
    case ExtensionSetupState.NOT_REQUIRED: return "notRequired";
    case ExtensionSetupState.REQUIRED: return "required";
    case ExtensionSetupState.IN_PROGRESS: return "inProgress";
    case ExtensionSetupState.READY: return "ready";
    case ExtensionSetupState.CANCELLED: return "cancelled";
    case ExtensionSetupState.FAILED: return "failed";
    default: return invalid("Extension setup state");
  }
}

function projectSetupFieldKind(value: ExtensionSetupFieldKind): MobileExtension["setup"]["fields"][number]["kind"] {
  switch (value) {
    case ExtensionSetupFieldKind.TEXT: return "text";
    case ExtensionSetupFieldKind.SECRET: return "secret";
    case ExtensionSetupFieldKind.OAUTH: return "oauth";
    case ExtensionSetupFieldKind.CONFIRMATION: return "confirmation";
    default: return invalid("Extension setup field kind");
  }
}

function projectMainViewIcon(value: ExtensionMainViewIcon): NonNullable<MobileExtension["mainView"]>["icon"] | undefined {
  switch (value) {
    case ExtensionMainViewIcon.UNSPECIFIED: return undefined;
    case ExtensionMainViewIcon.ACTIVITY: return "activity";
    case ExtensionMainViewIcon.BOX: return "box";
    case ExtensionMainViewIcon.CODE: return "code";
    case ExtensionMainViewIcon.FILE_TEXT: return "fileText";
    case ExtensionMainViewIcon.GLOBE: return "globe";
    case ExtensionMainViewIcon.LAYOUT: return "layout";
    case ExtensionMainViewIcon.SEARCH: return "search";
    case ExtensionMainViewIcon.SPARKLES: return "sparkles";
    case ExtensionMainViewIcon.TERMINAL: return "terminal";
    case ExtensionMainViewIcon.TOOL: return "tool";
    default: return invalid("Extension main-view icon");
  }
}

function validateRecommendations(value: ExtensionCatalogEntry): void {
  if (value.recommendations.length > 24) invalid("Extension recommendations");
  const identities = new Set<string>();
  const wireProjection: unknown[] = [];
  for (const recommendation of value.recommendations) {
    if (!RECOMMENDATION_ID.test(recommendation.id) || identities.has(recommendation.id)) {
      invalid("Extension recommendation identity");
    }
    identities.add(recommendation.id);
    recommendationText(recommendation.label, 120, FORBIDDEN_RECOMMENDATION_LABEL,
      "Extension recommendation label");
    recommendationText(recommendation.prompt, 8_000, FORBIDDEN_RECOMMENDATION_PROMPT,
      "Extension recommendation prompt");
    if (recommendation.command !== undefined && !RECOMMENDATION_COMMAND.test(recommendation.command)) {
      invalid("Extension recommendation command");
    }
    if (recommendation.locales.length > 2) invalid("Extension recommendation locales");
    const locales = new Set<string>();
    for (const localized of recommendation.locales) {
      if ((localized.locale !== "en" && localized.locale !== "zh-CN") || locales.has(localized.locale)) {
        invalid("Extension recommendation locale");
      }
      locales.add(localized.locale);
      recommendationText(localized.label, 120, FORBIDDEN_RECOMMENDATION_LABEL,
        "Extension recommendation label");
      recommendationText(localized.prompt, 8_000, FORBIDDEN_RECOMMENDATION_PROMPT,
        "Extension recommendation prompt");
    }
    wireProjection.push({
      id: recommendation.id,
      label: recommendation.label,
      prompt: recommendation.prompt,
      ...(recommendation.command === undefined ? {} : { command: recommendation.command }),
      locales: recommendation.locales.map((localized) => ({
        locale: localized.locale,
        label: localized.label,
        prompt: localized.prompt
      }))
    });
  }
  try {
    if (new TextEncoder().encode(JSON.stringify(wireProjection)).byteLength > 65_536) {
      invalid("Extension recommendations size");
    }
  } catch {
    invalid("Extension recommendations encoding");
  }
}

function uniqueMap<T, R>(
  values: readonly T[],
  key: (value: T) => string,
  label: string,
  map: (value: T) => R
): readonly R[] {
  const identities = new Set<string>();
  return values.map((value) => {
    const identity = key(value);
    if (identities.has(identity)) invalid(`${label} identity`);
    identities.add(identity);
    return map(value);
  });
}

function uniqueStrings(values: readonly string[], maximum: number, label: string): readonly string[] {
  const seen = new Set<string>();
  return values.map((value) => {
    const projected = requiredText(value, maximum, label);
    if (seen.has(projected)) invalid(`${label} identity`);
    seen.add(projected);
    return projected;
  });
}

function identity(value: string, maximum: number, label: string): string {
  return requiredText(value, maximum, label);
}

function optionalText(value: string | undefined, maximum: number, label: string): string | undefined {
  return value === undefined ? undefined : requiredText(value, maximum, label);
}

function optionalLongText(value: string | undefined, maximum: number, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0) invalid(label);
  return longText(value, maximum, label);
}

function requiredText(value: string, maximum: number, label: string): string {
  if (value.length === 0) invalid(label);
  return text(value, maximum, label);
}

function text(value: string, maximum: number, label: string): string {
  if (value !== value.trim() || value.length > maximum || FORBIDDEN_TEXT.test(value)) invalid(label);
  return value;
}

function longText(value: string, maximum: number, label: string): string {
  if (value !== value.trim() || value.length > maximum || FORBIDDEN_LONG_TEXT.test(value)) invalid(label);
  return value;
}

function positiveRevision(value: bigint | undefined, label: string): bigint {
  if (value === undefined || value < 1n) invalid(label);
  return value;
}

function nonNegativeRevision(value: bigint | undefined, label: string): bigint {
  if (value === undefined || value < 0n) invalid(label);
  return value;
}

function recommendationText(value: string, maximum: number, forbidden: RegExp, label: string): void {
  if (value.trim().length === 0 || value.length > maximum || forbidden.test(value)) invalid(label);
}

function invalid(label: string): never {
  throw new Error(`The Joko node returned an invalid ${label}.`);
}

class CatalogRevisionDrift extends Error {}
