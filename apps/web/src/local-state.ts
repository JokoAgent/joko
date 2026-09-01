import type { AttachmentDraft, BrowserCommentDraftItem, ComposerDraft, ComposerMentionDraft, ConnectionProfile, Locale, MachineCacheView, NewSessionLocalDraft, PermissionMode, Theme } from "./model.js";
import { normalizeBrowserCommentStyleChanges, normalizeBrowserCommentTarget, sanitizeBrowserCommentPageUrl } from "./browser-comment-draft.js";
import { normalizeMachineCache, normalizeMachineSelection, type MachineSelection } from "./machine-federation.js";
import {
  isNavigationMode,
  NAVIGATION_DEFAULT_WIDTH,
  normalizeNavigationWidth,
  type NavigationMode
} from "./navigation-layout.js";
import { persistentWebSecretEncryptionAvailable } from "./web-crypto.js";
import { normalizeComposerDocument } from "./composer-quote-document.js";
import { normalizeAppShortcutOverrides, type AppShortcutOverrides } from "./app-shortcuts.js";
import {
  DEFAULT_APPEARANCE_PREFERENCES,
  normalizeAppearancePreferences,
  type AppearancePreferences
} from "./appearance-settings.js";
import {
  DEFAULT_SIDEBAR_DISPLAY_PREFERENCES,
  normalizeSidebarDisplayPreferences,
  normalizeSidebarOwnerLayouts,
  type SidebarDisplayPreferences,
  type SidebarOwnerLayouts
} from "./sidebar-layout.js";

const DATABASE_NAME = "joko-ui";
const DATABASE_VERSION = 1;
const PROFILE_STORE = "profiles";
const SECRET_STORE = "secrets";
const KEY_STORE = "keys";
const DRAFT_STORE = "drafts";
const NEW_SESSION_DRAFT_PREFIX = "new-session\u0000";
const PREFERENCE_STORE = "preferences";
const MACHINE_CACHE_STORE = "machine-caches";
const CURRENT_OBJECT_STORES = [
  PROFILE_STORE,
  SECRET_STORE,
  KEY_STORE,
  DRAFT_STORE,
  PREFERENCE_STORE,
  MACHINE_CACHE_STORE
] as const;
const MAXIMUM_BROWSER_COMMENT_MARKER_NUMBER = 0xffff_ffff;

let databaseOpenInFlight: Promise<IDBDatabase> | undefined;

interface PersistedAttachment {
  readonly id: string;
  readonly kind: AttachmentDraft["kind"];
  readonly name: string;
  readonly mediaType: string;
  readonly lastModified: number;
  readonly bytes: Blob;
}

interface PersistedBrowserCommentDraftItem extends Omit<BrowserCommentDraftItem, "screenshot"> {
  readonly screenshot: PersistedAttachment;
}

interface PersistedComposerDraft extends Omit<ComposerDraft, "attachments" | "browserComments"> {
  readonly attachments: readonly PersistedAttachment[];
  readonly browserComments: readonly PersistedBrowserCommentDraftItem[];
}

interface PersistedNewSessionLocalDraft extends Omit<NewSessionLocalDraft, "attachments"> {
  readonly attachments: readonly PersistedAttachment[];
}

interface EncryptedSecret {
  readonly profileId: string;
  readonly iv: ArrayBuffer;
  readonly ciphertext: ArrayBuffer;
}

export interface UiPreferences extends AppearancePreferences {
  readonly locale: Locale;
  readonly theme: Theme;
  readonly inspectorOpen: boolean;
  readonly navigationOpen: boolean;
  readonly navigationMode: NavigationMode;
  readonly navigationWidth: number;
  readonly composerSendShortcut: ComposerSendShortcutPreference;
  readonly messageSearchSort: MessageSearchSortPreference;
  /** Local product preference for displaying the message navigation rail. */
  readonly messageNavRailEnabled: boolean;
  /** Owner-scoped custom instructions snapshotted into newly-created tasks. */
  readonly personalizationPrompts: PersonalizationPrompts;
  /** Destination for ordinary HTTP(S) message links. */
  readonly linkOpenPreference: LinkOpenPreference;
  /** Enables a word-level opacity reveal while assistant text streams. */
  readonly streamFadeEnabled: boolean;
  /** Enables local OS notifications for new durable task-attention edges. */
  readonly sessionNotificationsEnabled: boolean;
  /** Default for fresh project tasks; eligibility still fails closed per Target. */
  readonly newSessionWorktreeEnabled: boolean;
  /** The display strategy is local/global; only ordered identities are owner-scoped. */
  readonly sidebarDisplayPreferences: SidebarDisplayPreferences;
  /** Manual project/pinned order and collapsed projects are isolated per Orchestrator owner. */
  readonly sidebarOwnerLayouts: SidebarOwnerLayouts;
  /** Application shortcut overrides; null disables an action. */
  readonly appShortcutOverrides: AppShortcutOverrides;
  /** Explicit opt-in for connecting a remembered Orchestrator as soon as this client opens. */
  readonly automaticConnectionTarget?: AutomaticConnectionTarget;
  /** Local multi-node task filter. `all` is the product default. */
  readonly machineSelection: MachineSelection;
}

export type AutomaticConnectionTarget =
  | { readonly kind: "managedLocal" }
  | { readonly kind: "profile"; readonly profileId: string };

export type ComposerSendShortcutPreference = "enter" | "modifier-enter";
export type MessageSearchSortPreference = "relevance" | "activityDesc" | "activityAsc";
export type LinkOpenPreference = "sidebar" | "external";
export type PersonalizationPrompts = Readonly<Record<string, string>>;

export const PERSONALIZATION_PROMPT_MAX_LENGTH = 8_000;
export const PERSONALIZATION_PROMPT_MAX_OWNERS = 32;

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  ...DEFAULT_APPEARANCE_PREFERENCES,
  locale: "en",
  theme: "dark",
  inspectorOpen: true,
  navigationOpen: true,
  navigationMode: "expanded",
  navigationWidth: NAVIGATION_DEFAULT_WIDTH,
  composerSendShortcut: "enter",
  messageSearchSort: "relevance",
  messageNavRailEnabled: true,
  personalizationPrompts: {},
  linkOpenPreference: "sidebar",
  streamFadeEnabled: true,
  sessionNotificationsEnabled: true,
  newSessionWorktreeEnabled: false,
  sidebarDisplayPreferences: DEFAULT_SIDEBAR_DISPLAY_PREFERENCES,
  sidebarOwnerLayouts: {},
  appShortcutOverrides: {},
  machineSelection: "all"
};

const UI_PREFERENCE_KEYS = [
  "appShortcutOverrides",
  "codeFamily",
  "codeSize",
  "composerSendShortcut",
  "inspectorOpen",
  "linkOpenPreference",
  "locale",
  "machineSelection",
  "messageNavRailEnabled",
  "messageSearchSort",
  "navigationMode",
  "navigationOpen",
  "navigationWidth",
  "newSessionWorktreeEnabled",
  "personalizationPrompts",
  "sessionNotificationsEnabled",
  "sidebarDisplayPreferences",
  "sidebarOwnerLayouts",
  "streamFadeEnabled",
  "theme",
  "uiFamily",
  "uiSize",
  "windowZoom"
] as const;

/** Treat IndexedDB data as untrusted and accept only current keys and values. */
export function normalizeUiPreferences(value: unknown): UiPreferences {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return DEFAULT_UI_PREFERENCES;
  const persisted = value as Record<string, unknown>;
  const allowed = new Set<string>([...UI_PREFERENCE_KEYS, "automaticConnectionTarget"]);
  if (Object.keys(persisted).some((key) => !allowed.has(key))) return DEFAULT_UI_PREFERENCES;

  // The durable representation intentionally contains only non-default
  // overrides. Rehydrate omitted fields before validating the exact current
  // schema so one restored default never discards unrelated saved choices.
  const record: Record<string, unknown> = { ...DEFAULT_UI_PREFERENCES, ...persisted };

  const appearance = normalizeAppearancePreferences(record);
  const personalizationPrompts = normalizePersonalizationPrompts(record["personalizationPrompts"]);
  const sidebarDisplayPreferences = normalizeSidebarDisplayPreferences(record["sidebarDisplayPreferences"]);
  const sidebarOwnerLayouts = normalizeSidebarOwnerLayouts(record["sidebarOwnerLayouts"]);
  const appShortcutOverrides = normalizeAppShortcutOverrides(record["appShortcutOverrides"]);
  const machineSelection = normalizeMachineSelection(record["machineSelection"]);
  const automaticConnectionTarget = Object.hasOwn(persisted, "automaticConnectionTarget")
    ? normalizeAutomaticConnectionTarget(persisted["automaticConnectionTarget"])
    : undefined;
  if (
    !samePersistedValue(appearance, {
      uiFamily: record["uiFamily"],
      codeFamily: record["codeFamily"],
      uiSize: record["uiSize"],
      codeSize: record["codeSize"],
      windowZoom: record["windowZoom"]
    })
    || (record["locale"] !== "en" && record["locale"] !== "zh-CN" && record["locale"] !== "en-XA")
    || (record["theme"] !== "dark" && record["theme"] !== "light" && record["theme"] !== "system")
    || typeof record["inspectorOpen"] !== "boolean"
    || !isNavigationMode(record["navigationMode"])
    || typeof record["navigationOpen"] !== "boolean"
    || record["navigationOpen"] !== (record["navigationMode"] !== "hidden")
    || normalizeNavigationWidth(record["navigationWidth"]) !== record["navigationWidth"]
    || (record["composerSendShortcut"] !== "enter" && record["composerSendShortcut"] !== "modifier-enter")
    || (record["messageSearchSort"] !== "relevance" && record["messageSearchSort"] !== "activityDesc" && record["messageSearchSort"] !== "activityAsc")
    || typeof record["messageNavRailEnabled"] !== "boolean"
    || !samePersistedValue(personalizationPrompts, record["personalizationPrompts"])
    || (record["linkOpenPreference"] !== "sidebar" && record["linkOpenPreference"] !== "external")
    || typeof record["streamFadeEnabled"] !== "boolean"
    || typeof record["sessionNotificationsEnabled"] !== "boolean"
    || typeof record["newSessionWorktreeEnabled"] !== "boolean"
    || !samePersistedValue(sidebarDisplayPreferences, record["sidebarDisplayPreferences"])
    || !samePersistedValue(sidebarOwnerLayouts, record["sidebarOwnerLayouts"])
    || !samePersistedValue(appShortcutOverrides, record["appShortcutOverrides"])
    || !samePersistedValue(machineSelection, record["machineSelection"])
    || (Object.hasOwn(persisted, "automaticConnectionTarget") && automaticConnectionTarget === undefined)
  ) return DEFAULT_UI_PREFERENCES;

  return {
    ...appearance,
    locale: record["locale"],
    theme: record["theme"],
    inspectorOpen: record["inspectorOpen"],
    navigationOpen: record["navigationOpen"],
    navigationMode: record["navigationMode"],
    navigationWidth: record["navigationWidth"] as number,
    composerSendShortcut: record["composerSendShortcut"],
    messageSearchSort: record["messageSearchSort"],
    messageNavRailEnabled: record["messageNavRailEnabled"],
    personalizationPrompts,
    linkOpenPreference: record["linkOpenPreference"],
    streamFadeEnabled: record["streamFadeEnabled"],
    sessionNotificationsEnabled: record["sessionNotificationsEnabled"],
    newSessionWorktreeEnabled: record["newSessionWorktreeEnabled"],
    sidebarDisplayPreferences,
    sidebarOwnerLayouts,
    appShortcutOverrides,
    machineSelection,
    ...(automaticConnectionTarget === undefined ? {} : { automaticConnectionTarget })
  };
}

function normalizeAutomaticConnectionTarget(value: unknown): AutomaticConnectionTarget | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record["kind"] === "managedLocal" && exactKeys(record, ["kind"])) return { kind: "managedLocal" };
  if (
    record["kind"] === "profile"
    && exactKeys(record, ["kind", "profileId"])
    && typeof record["profileId"] === "string"
    && record["profileId"].length > 0
    && record["profileId"].length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(record["profileId"])
  ) return { kind: "profile", profileId: record["profileId"] };
  return undefined;
}

function exactKeys(record: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}

function samePersistedValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => samePersistedValue(item, right[index]));
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return keys.length === Object.keys(rightRecord).length
    && keys.every((key) => Object.hasOwn(rightRecord, key) && samePersistedValue(leftRecord[key], rightRecord[key]));
}

function normalizeConnectionProfile(value: unknown): ConnectionProfile | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const required = ["deviceId", "id", "name", "origin", "serverId"];
  const allowed = new Set([...required, "lastConnectedAt", "managedLocal"]);
  if (required.some((key) => !Object.hasOwn(record, key)) || Object.keys(record).some((key) => !allowed.has(key))) {
    return undefined;
  }
  if (
    !validConnectionIdentity(record["id"], 128)
    || !validConnectionIdentity(record["deviceId"], 256)
    || !validConnectionIdentity(record["serverId"], 256)
    || typeof record["name"] !== "string"
    || record["name"].length === 0
    || record["name"].length > 256
    || record["name"].trim() !== record["name"]
    || (Object.hasOwn(record, "managedLocal") && typeof record["managedLocal"] !== "boolean")
    || (Object.hasOwn(record, "lastConnectedAt") && (
      typeof record["lastConnectedAt"] !== "number"
      || !Number.isSafeInteger(record["lastConnectedAt"])
      || record["lastConnectedAt"] < 0
    ))
  ) return undefined;
  if (typeof record["origin"] !== "string") return undefined;
  let origin: URL;
  try {
    origin = new URL(record["origin"]);
  } catch {
    return undefined;
  }
  if (
    (origin.protocol !== "http:" && origin.protocol !== "https:")
    || origin.username !== ""
    || origin.password !== ""
    || origin.search !== ""
    || origin.hash !== ""
    || origin.origin !== record["origin"]
  ) return undefined;
  return {
    id: record["id"],
    deviceId: record["deviceId"],
    serverId: record["serverId"],
    name: record["name"],
    origin: record["origin"],
    ...(Object.hasOwn(record, "managedLocal") ? { managedLocal: record["managedLocal"] as boolean } : {}),
    ...(Object.hasOwn(record, "lastConnectedAt") ? { lastConnectedAt: record["lastConnectedAt"] as number } : {})
  };
}

function validConnectionIdentity(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

export class LocalState {
  readonly #database: IDBDatabase;
  readonly #volatileSecrets = new Map<string, string>();

  private constructor(database: IDBDatabase) {
    this.#database = database;
  }

  static async open(): Promise<LocalState> {
    const database = await openCurrentDatabase();
    return new LocalState(database);
  }

  async listProfiles(): Promise<readonly ConnectionProfile[]> {
    const values = await this.getAll<unknown>(PROFILE_STORE);
    return values.map(normalizeConnectionProfile).filter((value): value is ConnectionProfile => value !== undefined);
  }

  async listMachineCaches(): Promise<readonly MachineCacheView[]> {
    const values = await this.getAll<unknown>(MACHINE_CACHE_STORE);
    return values.map(normalizeMachineCache).filter((value): value is MachineCacheView => value !== undefined);
  }

  async saveMachineCache(cache: MachineCacheView): Promise<void> {
    const normalized = normalizeMachineCache(cache);
    if (normalized === undefined) throw new Error("The machine cache is invalid.");
    await this.put(MACHINE_CACHE_STORE, normalized.profileId, normalized);
  }

  async deleteMachineCache(profileId: string): Promise<void> {
    const transaction = this.#database.transaction(MACHINE_CACHE_STORE, "readwrite");
    transaction.objectStore(MACHINE_CACHE_STORE).delete(profileId);
    await transactionDone(transaction);
  }

  async saveProfile(profile: ConnectionProfile, authKey: string): Promise<void> {
    const normalized = normalizeConnectionProfile(profile);
    if (normalized === undefined) throw new Error("The connection profile is invalid.");
    const desktopCredentials = window.jokoDesktop?.credentials;
    if (desktopCredentials !== undefined) {
      await desktopCredentials.set(normalized.id, authKey);
      await this.put(PROFILE_STORE, normalized.id, normalized);
      return;
    }
    if (!persistentWebSecretEncryptionAvailable()) {
      const transaction = this.#database.transaction([PROFILE_STORE, SECRET_STORE], "readwrite");
      transaction.objectStore(PROFILE_STORE).put(normalized, normalized.id);
      transaction.objectStore(SECRET_STORE).delete(normalized.id);
      await transactionDone(transaction);
      // Plain-LAN Web pages are not secure contexts. Keep the Auth Key only
      // for this tab rather than weakening the credential-at-rest boundary.
      this.#volatileSecrets.set(normalized.id, authKey);
      return;
    }
    const key = await this.originKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(normalized.origin) },
      key,
      new TextEncoder().encode(authKey)
    );
    const transaction = this.#database.transaction([PROFILE_STORE, SECRET_STORE], "readwrite");
    transaction.objectStore(PROFILE_STORE).put(normalized, normalized.id);
    transaction.objectStore(SECRET_STORE).put({
      profileId: normalized.id,
      iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength),
      ciphertext
    } satisfies EncryptedSecret, normalized.id);
    await transactionDone(transaction);
  }

  async readAuthKey(profile: ConnectionProfile): Promise<string | undefined> {
    const desktopCredentials = window.jokoDesktop?.credentials;
    if (desktopCredentials !== undefined) return desktopCredentials.get(profile.id);
    const volatile = this.#volatileSecrets.get(profile.id);
    if (volatile !== undefined) return volatile;
    if (!persistentWebSecretEncryptionAvailable()) return undefined;
    const encrypted = await this.get<EncryptedSecret>(SECRET_STORE, profile.id);
    if (encrypted === undefined) return undefined;
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: encrypted.iv, additionalData: new TextEncoder().encode(profile.origin) },
        await this.originKey(),
        encrypted.ciphertext
      );
      return new TextDecoder().decode(plaintext);
    } catch {
      return undefined;
    }
  }

  async deleteAuthKey(profileId: string): Promise<void> {
    this.#volatileSecrets.delete(profileId);
    await window.jokoDesktop?.credentials.delete(profileId);
    const transaction = this.#database.transaction(SECRET_STORE, "readwrite");
    transaction.objectStore(SECRET_STORE).delete(profileId);
    await transactionDone(transaction);
  }

  async deleteProfile(id: string): Promise<void> {
    this.#volatileSecrets.delete(id);
    await window.jokoDesktop?.credentials.delete(id);
    const transaction = this.#database.transaction([PROFILE_STORE, SECRET_STORE, MACHINE_CACHE_STORE], "readwrite");
    transaction.objectStore(PROFILE_STORE).delete(id);
    transaction.objectStore(SECRET_STORE).delete(id);
    transaction.objectStore(MACHINE_CACHE_STORE).delete(id);
    await transactionDone(transaction);
  }

  async saveDraft(sessionId: string, draft: ComposerDraft): Promise<void> {
    const browserComments = normalizeLiveBrowserComments(draft.browserComments);
    const extraDirectoryIds = normalizeExtraDirectoryIds(draft.extraDirectoryIds);
    const persisted: PersistedComposerDraft = {
      text: draft.text,
      deliveryMode: draft.deliveryMode,
      mentions: normalizeComposerMentions(draft.mentions),
      ...(draft.editorDocument === undefined ? {} : { editorDocument: normalizeComposerDocument(draft.editorDocument, draft.text) }),
      ...(extraDirectoryIds === undefined ? {} : { extraDirectoryIds }),
      attachments: draft.attachments.map(persistAttachment),
      browserComments: browserComments.map((item) => ({ ...item, screenshot: persistAttachment(item.screenshot) }))
    };
    await this.put(DRAFT_STORE, sessionId, persisted);
  }

  async readDraft(sessionId: string): Promise<ComposerDraft | undefined> {
    const persisted = await this.get<PersistedComposerDraft>(DRAFT_STORE, sessionId);
    if (persisted === undefined) return undefined;
    const attachments = restorePersistedAttachments(persisted.attachments);
    const browserComments = restorePersistedBrowserComments(persisted.browserComments);
    const extraDirectoryIds = normalizeExtraDirectoryIds(persisted.extraDirectoryIds);
    return {
      text: persisted.text,
      deliveryMode: persisted.deliveryMode,
      mentions: normalizeComposerMentions(persisted.mentions),
      ...(persisted.editorDocument === undefined ? {} : { editorDocument: normalizeComposerDocument(persisted.editorDocument, persisted.text) }),
      attachments,
      browserComments,
      ...(extraDirectoryIds === undefined ? {} : { extraDirectoryIds })
    };
  }

  async saveNewSessionDraft(scope: string, draft: NewSessionLocalDraft): Promise<void> {
    const normalized = normalizeNewSessionLocalDraft(draft);
    if (normalized === undefined) throw new Error("The new-task draft is invalid.");
    const persisted: PersistedNewSessionLocalDraft = {
      ...normalized,
      attachments: normalized.attachments.map(persistAttachment)
    };
    await this.put(DRAFT_STORE, newSessionDraftKey(scope), persisted);
  }

  async readNewSessionDraft(scope: string): Promise<NewSessionLocalDraft | undefined> {
    const value = await this.get<unknown>(DRAFT_STORE, newSessionDraftKey(scope));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const attachments = restorePersistedAttachments(record["attachments"]);
    return normalizeNewSessionLocalDraft({ ...record, attachments });
  }

  async clearNewSessionDraft(scope: string): Promise<void> {
    const transaction = this.#database.transaction(DRAFT_STORE, "readwrite");
    transaction.objectStore(DRAFT_STORE).delete(newSessionDraftKey(scope));
    await transactionDone(transaction);
  }

  async savePreferences(value: UiPreferences): Promise<void> {
    // Store only non-default overrides so untouched controls continue
    // to follow future product defaults.
    const persisted: { -readonly [Key in keyof UiPreferences]?: UiPreferences[Key] } = { ...value };
    if (value.messageNavRailEnabled) delete persisted.messageNavRailEnabled;
    if (value.linkOpenPreference === "sidebar") delete persisted.linkOpenPreference;
    if (value.streamFadeEnabled) delete persisted.streamFadeEnabled;
    if (value.sessionNotificationsEnabled) delete persisted.sessionNotificationsEnabled;
    if (!value.newSessionWorktreeEnabled) delete persisted.newSessionWorktreeEnabled;
    if (Object.keys(value.personalizationPrompts).length === 0) delete persisted.personalizationPrompts;
    if (value.automaticConnectionTarget === undefined) delete persisted.automaticConnectionTarget;
    if (value.machineSelection === "all") delete persisted.machineSelection;
    await this.put(PREFERENCE_STORE, "ui", persisted);
  }

  async readPreferences(): Promise<UiPreferences | undefined> {
    const value = await this.get<unknown>(PREFERENCE_STORE, "ui");
    return value === undefined ? undefined : normalizeUiPreferences(value);
  }

  private async originKey(): Promise<CryptoKey> {
    if (!persistentWebSecretEncryptionAvailable()) throw new Error("Persistent Web credentials require HTTPS or the Desktop application.");
    const existing = await this.get<CryptoKey>(KEY_STORE, "origin-aes-gcm");
    if (existing !== undefined) return existing;
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await this.put(KEY_STORE, "origin-aes-gcm", key);
    return key;
  }

  private async get<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
    const transaction = this.#database.transaction(store, "readonly");
    const request = transaction.objectStore(store).get(key);
    const value = await requestResult<T | undefined>(request);
    await transactionDone(transaction);
    return value;
  }

  private async getAll<T>(store: string): Promise<readonly T[]> {
    const transaction = this.#database.transaction(store, "readonly");
    const request = transaction.objectStore(store).getAll();
    const value = await requestResult<T[]>(request);
    await transactionDone(transaction);
    return value;
  }

  private async put(store: string, key: IDBValidKey, value: unknown): Promise<void> {
    const transaction = this.#database.transaction(store, "readwrite");
    transaction.objectStore(store).put(value, key);
    await transactionDone(transaction);
  }
}

/** Reads only the active Orchestrator owner's instructions; owners never share text. */
export function personalizationPromptForOwner(prompts: PersonalizationPrompts, ownerId: string | undefined): string {
  if (!validPersonalizationOwnerId(ownerId)) return "";
  return Object.prototype.hasOwnProperty.call(prompts, ownerId) ? prompts[ownerId] ?? "" : "";
}

/**
 * Returns a bounded owner map. Re-saving an owner moves it to the newest end,
 * so the least recently changed entry is the one discarded at the cap.
 */
export function withPersonalizationPrompt(
  prompts: PersonalizationPrompts,
  ownerId: string,
  value: string
): PersonalizationPrompts {
  if (!validPersonalizationOwnerId(ownerId)) throw new Error("A valid service owner is required for personalization.");
  if (value.length > PERSONALIZATION_PROMPT_MAX_LENGTH) {
    throw new Error(`Personalization instructions cannot exceed ${PERSONALIZATION_PROMPT_MAX_LENGTH} characters.`);
  }
  if (value.includes("\0")) throw new Error("Personalization instructions cannot contain null characters.");
  const entries = Object.entries(normalizePersonalizationPrompts(prompts))
    .filter(([candidate]) => candidate !== ownerId);
  if (value.length > 0) entries.push([ownerId, value]);
  return Object.fromEntries(entries.slice(-PERSONALIZATION_PROMPT_MAX_OWNERS));
}

export function normalizePersonalizationPrompts(value: unknown): PersonalizationPrompts {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const entries: [string, string][] = [];
  for (const [ownerId, prompt] of Object.entries(value as Record<string, unknown>)) {
    if (!validPersonalizationOwnerId(ownerId)) continue;
    if (typeof prompt !== "string" || prompt.length === 0 || prompt.length > PERSONALIZATION_PROMPT_MAX_LENGTH || prompt.includes("\0")) continue;
    entries.push([ownerId, prompt]);
  }
  return Object.fromEntries(entries.slice(-PERSONALIZATION_PROMPT_MAX_OWNERS));
}

function validPersonalizationOwnerId(value: string | undefined): value is string {
  return value !== undefined
    && value.length > 0
    && value.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && value !== "__proto__"
    && value !== "constructor"
    && value !== "prototype";
}

export function normalizeNewSessionLocalDraft(value: unknown): NewSessionLocalDraft | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const rawSelection = record["selection"];
  if (rawSelection === null || typeof rawSelection !== "object" || Array.isArray(rawSelection)) return undefined;
  const selectionRecord = rawSelection as Record<string, unknown>;
  const selection = selectionRecord["kind"] === "target" && validId(selectionRecord["targetId"])
    ? { kind: "target" as const, targetId: selectionRecord["targetId"] }
    : selectionRecord["kind"] === "dialogue" && validId(selectionRecord["backendId"])
      ? { kind: "dialogue" as const, backendId: selectionRecord["backendId"] }
      : undefined;
  if (selection === undefined || typeof record["text"] !== "string") return undefined;
  const rawEditorDocument = record["editorDocument"];
  if (rawEditorDocument === null || typeof rawEditorDocument !== "object" || Array.isArray(rawEditorDocument)) return undefined;
  const editorRecord = rawEditorDocument as Record<string, unknown>;
  if (editorRecord["type"] !== "doc" || !Array.isArray(editorRecord["content"])) return undefined;
  const editorDocument = normalizeComposerDocument(rawEditorDocument);
  const nativeRecord = record["nativeStart"];
  const nativeStart = nativeRecord !== null && typeof nativeRecord === "object" && !Array.isArray(nativeRecord)
    ? normalizeNativeStart(nativeRecord as Record<string, unknown>)
    : undefined;
  if (nativeStart === undefined) return undefined;
  const permissionMode = normalizePermissionMode(record["permissionMode"]);
  const mentions = normalizeComposerMentions(record["mentions"]);
  const attachments = normalizeLiveAttachments(record["attachments"]);
  const extraDirectoryIds = normalizeExtraDirectoryIds(record["extraDirectoryIds"]);
  const rawWorktree = record["worktree"];
  const worktree = normalizeNewSessionWorktreeDraft(rawWorktree);
  if (rawWorktree !== undefined && worktree === undefined) return undefined;
  return {
    selection,
    nativeStart,
    providerId: typeof record["providerId"] === "string" ? record["providerId"] : "",
    modelId: typeof record["modelId"] === "string" ? record["modelId"] : "",
    ...(typeof record["effort"] === "string" && record["effort"].length > 0 ? { effort: record["effort"] } : {}),
    fastMode: record["fastMode"] === true,
    permissionMode,
    planMode: record["planMode"] === true,
    ...(worktree === undefined ? {} : { worktree }),
    text: record["text"],
    editorDocument,
    mentions,
    attachments,
    ...(extraDirectoryIds === undefined ? {} : { extraDirectoryIds })
  };
}

function normalizeNewSessionWorktreeDraft(
  value: unknown
): NewSessionLocalDraft["worktree"] | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const sourceRef = record["sourceRef"];
  if (sourceRef !== undefined && (
    typeof sourceRef !== "string" || sourceRef.length === 0 || sourceRef.length > 1_024
    || sourceRef !== sourceRef.trim() || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(sourceRef)
  )) return undefined;
  return {
    enabled: record["enabled"] === true,
    ...(sourceRef === undefined ? {} : { sourceRef }),
    refreshRemote: record["refreshRemote"] === true
  };
}

function normalizeNativeStart(value: Record<string, unknown>): NewSessionLocalDraft["nativeStart"] | undefined {
  if (value["kind"] === "fresh") return { kind: "fresh" };
  return value["kind"] === "attach" && validId(value["reference"])
    ? { kind: "attach", reference: value["reference"] }
    : undefined;
}

function normalizePermissionMode(value: unknown): PermissionMode {
  return value === "auto" || value === "bypassPermissions" ? value : "ask";
}

export function normalizeComposerMentions(value: unknown): readonly ComposerMentionDraft[] {
  if (!Array.isArray(value)) return [];
  const result: ComposerMentionDraft[] = [];
  const seenIds = new Set<string>();
  for (const candidate of value) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    if (!validId(record["id"]) || !validId(record["reference"]) || typeof record["label"] !== "string") continue;
    if (record["kind"] === "message") {
      if (
        !validMessageIdentity(record["id"])
        || !validMessageIdentity(record["sessionId"])
        || !validMessageIdentity(record["reference"])
        || (record["role"] !== "user" && record["role"] !== "assistant")
        || (record["sourceEventId"] !== undefined && !validMessageIdentity(record["sourceEventId"]))
      ) continue;
      if (seenIds.has(record["id"])) continue;
      result.push({
        id: record["id"],
        kind: "message",
        reference: record["reference"],
        label: record["label"].trim().slice(0, 120) || "Untitled task",
        sessionId: record["sessionId"],
        role: record["role"],
        ...(record["sourceEventId"] === undefined ? {} : { sourceEventId: record["sourceEventId"] })
      });
      seenIds.add(record["id"]);
      continue;
    }
    if ((record["kind"] !== "workspace" && record["kind"] !== "resource") || typeof record["token"] !== "string") continue;
    if (seenIds.has(record["id"])) continue;
    result.push({
      id: record["id"],
      kind: record["kind"],
      reference: record["reference"],
      label: record["label"],
      token: record["token"],
      ...(validId(record["workspaceId"]) ? { workspaceId: record["workspaceId"] } : {})
    });
    seenIds.add(record["id"]);
  }
  return result;
}

function validMessageIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1_024 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096;
}

function normalizeExtraDirectoryIds(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const ids = value
    .filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0 && candidate.length <= 256 && !/[\\/\u0000-\u001f\u007f]/u.test(candidate))
    .slice(0, 32);
  return [...new Set(ids)];
}

function normalizeLiveAttachments(value: unknown): readonly AttachmentDraft[] {
  if (!Array.isArray(value)) return [];
  const attachments: AttachmentDraft[] = [];
  for (const candidate of value) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    if (!validAttachmentId(record["id"]) || (record["kind"] !== "image" && record["kind"] !== "file") || !(record["file"] instanceof File)) continue;
    attachments.push({ id: record["id"], kind: record["kind"], file: record["file"] });
  }
  return attachments;
}

function normalizeLiveBrowserComments(value: unknown): readonly BrowserCommentDraftItem[] {
  if (!Array.isArray(value)) return [];
  const items: BrowserCommentDraftItem[] = [];
  const ids = new Set<string>();
  const markers = new Set<number>();
  for (const candidate of value) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    const id = record["id"];
    const markerNumber = record["markerNumber"];
    const pageUrl = record["pageUrl"];
    const comment = record["comment"];
    const target = normalizeBrowserCommentTarget(record["target"]);
    const styleChanges = normalizeBrowserCommentStyleChanges(record["styleChanges"]);
    const screenshot = normalizeLiveAttachments([record["screenshot"]])[0];
    if (
      !validAttachmentId(id)
      || ids.has(id)
      || typeof markerNumber !== "number"
      || !Number.isSafeInteger(markerNumber)
      || markerNumber < 1
      || markerNumber > MAXIMUM_BROWSER_COMMENT_MARKER_NUMBER
      || markers.has(markerNumber)
      || typeof pageUrl !== "string"
      || typeof comment !== "string"
      || target === undefined
      || screenshot?.kind !== "image"
    ) continue;
    ids.add(id);
    markers.add(markerNumber);
    items.push({
      id,
      markerNumber,
      pageUrl: sanitizeBrowserCommentPageUrl(pageUrl),
      target,
      comment: comment.trim().slice(0, 8_000),
      screenshot,
      ...(styleChanges.length === 0 ? {} : { styleChanges })
    });
  }
  return items;
}

function restorePersistedBrowserComments(value: unknown): readonly BrowserCommentDraftItem[] {
  if (!Array.isArray(value)) return [];
  const restored = value.map((candidate) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
    const record = candidate as Record<string, unknown>;
    const screenshot = restorePersistedAttachments([record["screenshot"]])[0];
    if (screenshot === undefined) return undefined;
    return { ...record, screenshot };
  }).filter((item): item is Record<string, unknown> & { readonly screenshot: AttachmentDraft } => item !== undefined);
  return normalizeLiveBrowserComments(restored);
}

function restorePersistedAttachments(value: unknown): readonly AttachmentDraft[] {
  if (!Array.isArray(value)) return [];
  const attachments: AttachmentDraft[] = [];
  for (const candidate of value) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    if (
      !validAttachmentId(record["id"])
      || (record["kind"] !== "image" && record["kind"] !== "file")
      || !(record["bytes"] instanceof Blob)
    ) continue;
    const name = safeAttachmentName(record["name"]);
    const mediaType = safeMediaType(record["mediaType"]);
    const lastModified = typeof record["lastModified"] === "number" && Number.isSafeInteger(record["lastModified"]) && record["lastModified"] >= 0
      ? record["lastModified"]
      : 0;
    attachments.push({
      id: record["id"],
      kind: record["kind"],
      file: new File([record["bytes"]], name, { type: mediaType, lastModified })
    });
  }
  return attachments;
}

function persistAttachment(attachment: AttachmentDraft): PersistedAttachment {
  return {
    id: attachment.id,
    kind: attachment.kind,
    name: safeAttachmentName(attachment.file.name),
    mediaType: safeMediaType(attachment.file.type),
    lastModified: Number.isSafeInteger(attachment.file.lastModified) && attachment.file.lastModified >= 0 ? attachment.file.lastModified : 0,
    bytes: attachment.file
  };
}

function validAttachmentId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function safeAttachmentName(value: unknown): string {
  if (typeof value !== "string") return "attachment";
  const basename = value.split(/[\\/]/u).at(-1)?.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, 255);
  return basename || "attachment";
}

function safeMediaType(value: unknown): string {
  return typeof value === "string" && value.length <= 255 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : "";
}

function newSessionDraftKey(scope: string): string {
  if (scope.length === 0) throw new Error("A new-task draft scope is required.");
  return `${NEW_SESSION_DRAFT_PREFIX}${scope}`;
}

function openCurrentDatabase(): Promise<IDBDatabase> {
  if (databaseOpenInFlight !== undefined) return databaseOpenInFlight;
  const pending = openAndValidateCurrentDatabase();
  databaseOpenInFlight = pending;
  void pending.then(
    () => {
      if (databaseOpenInFlight === pending) databaseOpenInFlight = undefined;
    },
    () => {
      if (databaseOpenInFlight === pending) databaseOpenInFlight = undefined;
    }
  );
  return pending;
}

async function openAndValidateCurrentDatabase(): Promise<IDBDatabase> {
  const database = await openDatabase();
  if (!hasCurrentDatabaseSchema(database)) {
    database.close();
    throw new Error("The local UI state schema is unsupported.");
  }
  return prepareOpenDatabase(database);
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolvePromise, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const store of CURRENT_OBJECT_STORES) {
        if (!database.objectStoreNames.contains(store)) database.createObjectStore(store);
      }
    };
    request.onsuccess = () => resolvePromise(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open local UI state."));
  });
}

function hasCurrentDatabaseSchema(database: IDBDatabase): boolean {
  return database.version === DATABASE_VERSION
    && database.objectStoreNames.length === CURRENT_OBJECT_STORES.length
    && CURRENT_OBJECT_STORES.every((store) => database.objectStoreNames.contains(store));
}

function prepareOpenDatabase(database: IDBDatabase): IDBDatabase {
  database.onversionchange = () => database.close();
  return database;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    request.onsuccess = () => resolvePromise(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB operation failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    transaction.oncomplete = () => resolvePromise();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction was aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
  });
}
