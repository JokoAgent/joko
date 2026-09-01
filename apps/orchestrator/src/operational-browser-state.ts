import { createHash } from "node:crypto";

import { redactSecrets, type BlobRef } from "@joko/core";
import type { OperationalStore, SettingRecord } from "@joko/store";
import { validateTakeoverNavigationUrl, type BrowserActivity } from "@joko/tool-browser";

import type {
  BrowserTransferRepository,
  PersistedBrowserTransfer
} from "./browser-transfers.js";

const SCOPE = "service" as const;
const SCOPE_ID = "orchestrator";
const ACTIVITY_KEY = "browser_activity.v1";
const TRANSFER_PREFIX = "browser_transfer.v1.";
const SCREENSHOT_PREFIX = "browser_screenshot.v1.";
const PAGE_CATALOG_KEY = "browser_pages.v1";

interface StoredActivityLog {
  readonly version: 1;
  readonly entries: readonly BrowserActivity[];
}

export interface BrowserScreenshotRecord {
  readonly browserProviderId: string;
  readonly pageId: string;
  readonly generation: number;
  readonly artifactId: string;
  readonly blob: BlobRef;
  readonly capturedAt: number;
  readonly widthPixels?: number;
  readonly heightPixels?: number;
}

export interface RecoverableBrowserPageRecord {
  readonly browserProviderId: string;
  readonly pageId: string;
  readonly generation: number;
  readonly sessionId: string;
  readonly targetId: string;
  readonly bindingGeneration: number;
  readonly url: string;
  readonly title: string;
  readonly state: "open" | "closed";
  readonly updatedAt: number;
}

export interface BrowserSessionAuthority {
  readonly sessionId: string;
  readonly targetId: string;
  readonly bindingGeneration: number;
}

export interface BrowserPageAuthority extends BrowserSessionAuthority {
  readonly browserProviderId: string;
  readonly pageId: string;
  readonly browserGeneration: number;
}

export interface BrowserBridgeEffectAuthority extends BrowserSessionAuthority {
  readonly requestIdentity: string;
  readonly effectIdentity: string;
  readonly requestBodyHash: string;
  readonly browserProviderId: string;
  readonly providerGeneration: number;
}

export interface BrowserPageOpenClaim<T> {
  readonly operationId: string;
  readonly bodyHash: string;
  readonly replayed: boolean;
  readonly value?: T;
}

export class BrowserSessionAuthorityError extends Error {
  constructor(message = "Browser page authority is unavailable or fenced.") {
    super(message);
    this.name = "BrowserSessionAuthorityError";
  }
}

interface StoredActivePage {
  readonly browserProviderId: string;
  readonly pageId: string;
}

interface StoredGenerationWatermark {
  readonly browserProviderId: string;
  readonly generation: number;
}

interface StoredPageCatalog {
  readonly version: 1;
  /** Only open pages retain descriptors; closed pages collapse into lastGenerations. */
  readonly openEntries: readonly RecoverableBrowserPageRecord[];
  readonly activePages: readonly StoredActivePage[];
  readonly lastGenerations: readonly StoredGenerationWatermark[];
}

/**
 * Durable public Browser projection. It deliberately stores no profile path,
 * page handle, cookie, request header, lease secret, or service-local blob path.
 */
export class OperationalBrowserState implements BrowserTransferRepository {
  readonly #store: OperationalStore;
  readonly #maximumActivities: number;
  readonly #activities: BrowserActivity[];
  #pageCatalog: StoredPageCatalog;

  constructor(store: OperationalStore, maximumActivities = 2_000) {
    if (!Number.isSafeInteger(maximumActivities) || maximumActivities < 1 || maximumActivities > 20_000) {
      throw new RangeError("maximumActivities must be between 1 and 20,000.");
    }
    this.#store = store;
    this.#maximumActivities = maximumActivities;
    const stored = store.findSetting<unknown>(SCOPE, SCOPE_ID, ACTIVITY_KEY)?.value;
    this.#activities = stored === undefined ? [] : parseActivityLog(stored, maximumActivities);
    const storedCatalog = store.findSetting<unknown>(SCOPE, SCOPE_ID, PAGE_CATALOG_KEY);
    this.#pageCatalog = storedCatalog === undefined ? emptyPageCatalog() : parsePageCatalog(storedCatalog.value);
  }

  get activities(): readonly BrowserActivity[] {
    return this.#activities;
  }

  recordActivity(activity: BrowserActivity): void {
    const parsed = parseActivity(activity);
    if (parsed === undefined) return;
    this.#activities.push(parsed);
    if (this.#activities.length > this.#maximumActivities) {
      this.#activities.splice(0, this.#activities.length - this.#maximumActivities);
    }
    this.#store.setSetting<StoredActivityLog>(SCOPE, SCOPE_ID, ACTIVITY_KEY, {
      version: 1,
      entries: this.#activities
    });
  }

  list(browserProviderId: string): readonly PersistedBrowserTransfer[] {
    if (!safeOpaqueId(browserProviderId)) return [];
    return this.#store.listSettings(SCOPE, SCOPE_ID)
      .filter((setting) => setting.key.startsWith(TRANSFER_PREFIX))
      .map(parseTransferSetting)
      .filter((item): item is PersistedBrowserTransfer => item !== undefined && item.browserProviderId === browserProviderId);
  }

  put(record: PersistedBrowserTransfer): void {
    if (!safeOpaqueId(record.browserProviderId) || !safeOpaqueId(record.id)) {
      throw new Error("Browser transfer contains an invalid opaque identifier.");
    }
    this.#store.setSetting(SCOPE, SCOPE_ID, transferKey(record.browserProviderId, record.id), record);
  }

  delete(browserProviderId: string, browserTransferId: string): void {
    if (!safeOpaqueId(browserProviderId) || !safeOpaqueId(browserTransferId)) return;
    this.#store.deleteSetting(SCOPE, SCOPE_ID, transferKey(browserProviderId, browserTransferId));
  }

  recordScreenshot(record: BrowserScreenshotRecord): void {
    if (
      !safeOpaqueId(record.browserProviderId) ||
      record.pageId.trim() === "" ||
      !safeOpaqueId(record.artifactId) ||
      !Number.isSafeInteger(record.generation) ||
      record.generation < 0 ||
      !Number.isSafeInteger(record.capturedAt)
    ) throw new Error("Browser screenshot projection is invalid.");
    this.#store.setSetting(SCOPE, SCOPE_ID, screenshotKey(record.browserProviderId, record.pageId), record);
  }

  findScreenshot(browserProviderId: string, pageId: string, generation: number): BrowserScreenshotRecord | undefined {
    if (!safeOpaqueId(browserProviderId) || pageId.trim() === "" || !Number.isSafeInteger(generation)) return undefined;
    const value = this.#store.findSetting<unknown>(
      SCOPE,
      SCOPE_ID,
      screenshotKey(browserProviderId, pageId)
    )?.value;
    const parsed = parseScreenshot(value);
    return parsed?.browserProviderId === browserProviderId && parsed.pageId === pageId && parsed.generation === generation
      ? parsed
      : undefined;
  }

  lastBrowserGeneration(browserProviderId: string): number {
    if (!safeOpaqueId(browserProviderId)) return 0;
    return this.#pageCatalog.lastGenerations.find((item) => item.browserProviderId === browserProviderId)?.generation ?? 0;
  }

  activePageId(browserProviderId: string): string | undefined {
    if (!safeOpaqueId(browserProviderId)) return undefined;
    const activePageId = this.#pageCatalog.activePages.find((item) => item.browserProviderId === browserProviderId)?.pageId;
    if (activePageId === undefined) return undefined;
    return this.#pageCatalog.openEntries.some((item) => item.browserProviderId === browserProviderId && item.pageId === activePageId)
      ? activePageId
      : undefined;
  }

  recoverablePages(browserProviderId: string, livePageIds: ReadonlySet<string>): readonly RecoverableBrowserPageRecord[] {
    if (!safeOpaqueId(browserProviderId)) return [];
    const active = this.activePageId(browserProviderId);
    return this.#pageCatalog.openEntries
      .filter((item) => item.browserProviderId === browserProviderId && !livePageIds.has(item.pageId))
      .sort((left, right) => {
        if (left.pageId === active && right.pageId !== active) return -1;
        if (right.pageId === active && left.pageId !== active) return 1;
        return right.updatedAt - left.updatedAt;
      });
  }

  findRecoverablePage(browserProviderId: string, pageId: string): RecoverableBrowserPageRecord | undefined {
    if (!safeOpaqueId(browserProviderId) || !safePageId(pageId)) return undefined;
    return this.#pageCatalog.openEntries.find((item) => item.browserProviderId === browserProviderId && item.pageId === pageId);
  }

  assertSessionAuthority(authority: BrowserSessionAuthority): void {
    assertSessionAuthority(this.#store, authority);
  }

  assertPageAuthority(authority: BrowserPageAuthority): RecoverableBrowserPageRecord {
    assertSessionAuthority(this.#store, authority);
    const page = this.findRecoverablePage(authority.browserProviderId, authority.pageId);
    if (
      page === undefined ||
      page.state !== "open" ||
      page.generation !== authority.browserGeneration ||
      page.sessionId !== authority.sessionId ||
      page.targetId !== authority.targetId ||
      page.bindingGeneration !== authority.bindingGeneration
    ) {
      throw new BrowserSessionAuthorityError();
    }
    return page;
  }

  claimBrowserPageOpen<T>(authority: BrowserBridgeEffectAuthority): BrowserPageOpenClaim<T> {
    const parsed = parseBridgeEffectAuthority(authority);
    assertSessionAuthority(this.#store, parsed);
    const claim = this.#store.claimDeferredEffectOperation<T>({
      id: `browser-page-open-${parsed.requestIdentity}`,
      kind: "browser_page_open",
      body: {
        format: 1,
        requestIdentity: parsed.requestIdentity,
        effectIdentity: parsed.effectIdentity,
        requestBodyHash: parsed.requestBodyHash,
        browserProviderId: parsed.browserProviderId,
        providerGeneration: parsed.providerGeneration,
        sessionId: parsed.sessionId,
        targetId: parsed.targetId,
        bindingGeneration: parsed.bindingGeneration
      }
    }, (store) => assertSessionAuthority(store, parsed));
    return {
      operationId: claim.operation.id,
      bodyHash: claim.operation.bodyHash,
      replayed: claim.replayed,
      ...(claim.replayed ? { value: claim.value } : {})
    };
  }

  completeBrowserPageOpen<T>(
    claim: BrowserPageOpenClaim<T>,
    authority: BrowserBridgeEffectAuthority,
    record: Omit<RecoverableBrowserPageRecord, "state">,
    value: T
  ): T {
    if (claim.replayed) {
      if (claim.value === undefined) throw new BrowserSessionAuthorityError("Browser page effect replay is incomplete.");
      return claim.value;
    }
    const parsedAuthority = parseBridgeEffectAuthority(authority);
    const parsedPage = parseRecoverablePage({ ...record, state: "open" });
    if (
      parsedPage === undefined ||
      parsedPage.browserProviderId !== parsedAuthority.browserProviderId ||
      parsedPage.sessionId !== parsedAuthority.sessionId ||
      parsedPage.targetId !== parsedAuthority.targetId ||
      parsedPage.bindingGeneration !== parsedAuthority.bindingGeneration ||
      parsedPage.generation < parsedAuthority.providerGeneration ||
      parsedPage.generation > parsedAuthority.providerGeneration + 1
    ) {
      throw new BrowserSessionAuthorityError("Browser page effect completion is stale or mismatched.");
    }
    let committedCatalog: StoredPageCatalog | undefined;
    const execution = this.#store.completeDeferredEffectOperation<T>(claim.operationId, claim.bodyHash, (store) => {
      assertSessionAuthority(store, parsedAuthority);
      const stored = store.findSetting<unknown>(SCOPE, SCOPE_ID, PAGE_CATALOG_KEY)?.value;
      const current = stored === undefined ? emptyPageCatalog() : parsePageCatalog(stored);
      const existing = current.openEntries.find((item) =>
        item.browserProviderId === parsedPage.browserProviderId && item.pageId === parsedPage.pageId
      );
      if (existing !== undefined && !samePageOwner(existing, parsedPage)) {
        throw new BrowserSessionAuthorityError("Browser page identity is already owned by another authority.");
      }
      committedCatalog = catalogWithOpenPage(current, parsedPage, { active: false });
      store.setSetting<StoredPageCatalog>(SCOPE, SCOPE_ID, PAGE_CATALOG_KEY, committedCatalog);
      return value;
    });
    if (committedCatalog === undefined) throw new BrowserSessionAuthorityError("Browser page effect did not commit its descriptor.");
    this.#pageCatalog = committedCatalog;
    return execution.value;
  }

  failBrowserPageOpen<T>(claim: BrowserPageOpenClaim<T>): void {
    if (claim.replayed) return;
    this.#store.failEffectOperation(
      claim.operationId,
      claim.bodyHash,
      new BrowserSessionAuthorityError("Browser page creation did not commit.")
    );
  }

  recordHumanPage(
    record: Omit<RecoverableBrowserPageRecord, "state">,
    options: { readonly active: boolean; readonly replacesPageId?: string }
  ): void {
    const parsed = parseRecoverablePage({ ...record, state: "open" });
    if (parsed === undefined) throw new Error("Browser recovery page projection is invalid.");
    const existing = this.#pageCatalog.openEntries.find((item) =>
      item.browserProviderId === parsed.browserProviderId && item.pageId === parsed.pageId
    );
    if (existing !== undefined && !samePageOwner(existing, parsed)) {
      throw new BrowserSessionAuthorityError("Browser page identity is already owned by another authority.");
    }
    this.#pageCatalog = catalogWithOpenPage(this.#pageCatalog, parsed, options);
    this.persistPageCatalog();
  }

  closeHumanPage(browserProviderId: string, pageId: string, generation: number, nextActivePageId?: string): void {
    if (
      !safeOpaqueId(browserProviderId) ||
      !safePageId(pageId) ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      (nextActivePageId !== undefined && !safePageId(nextActivePageId))
    ) {
      throw new Error("Browser closed-page projection is invalid.");
    }
    const openEntries = this.#pageCatalog.openEntries.filter((item) =>
      item.browserProviderId !== browserProviderId || item.pageId !== pageId
    );
    const candidateActivePages = nextActivePageId === undefined
      ? this.#pageCatalog.activePages
      : replaceActivePage(this.#pageCatalog.activePages, browserProviderId, nextActivePageId);
    this.#pageCatalog = {
      version: 1,
      openEntries,
      activePages: retainActivePages(candidateActivePages, openEntries),
      lastGenerations: advanceGeneration(this.#pageCatalog.lastGenerations, browserProviderId, generation)
    };
    this.persistPageCatalog();
  }

  private persistPageCatalog(): void {
    this.#store.setSetting<StoredPageCatalog>(SCOPE, SCOPE_ID, PAGE_CATALOG_KEY, this.#pageCatalog);
  }
}

function transferKey(browserProviderId: string, browserTransferId: string): string {
  return `${TRANSFER_PREFIX}${browserProviderId}.${browserTransferId}`;
}

function screenshotKey(browserProviderId: string, pageId: string): string {
  const digest = createHash("sha256").update(pageId).digest("hex").slice(0, 32);
  return `${SCREENSHOT_PREFIX}${browserProviderId}.${digest}`;
}

function parseTransferSetting(setting: SettingRecord): PersistedBrowserTransfer | undefined {
  const value = setting.value;
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== "string" ||
    typeof value.browserProviderId !== "string" ||
    typeof value.pageId !== "string" ||
    typeof value.toolCallId !== "string" ||
    typeof value.direction !== "number" ||
    typeof value.initiatedAt !== "number" ||
    typeof value.generation !== "number" ||
    typeof value.state !== "number"
  ) return undefined;
  return value as unknown as PersistedBrowserTransfer;
}

function parseActivity(value: unknown): BrowserActivity | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.at !== "number" ||
    !Number.isSafeInteger(value.at) ||
    typeof value.type !== "string" ||
    !["started", "stopped", "page", "navigation", "action", "download", "crashed", "takeover"].includes(value.type) ||
    typeof value.detail !== "string" ||
    value.detail.length > 16_384 ||
    (value.pageId !== undefined && typeof value.pageId !== "string")
  ) return undefined;
  return {
    at: value.at,
    type: value.type as BrowserActivity["type"],
    detail: value.detail,
    ...(typeof value.pageId === "string" ? { pageId: value.pageId } : {})
  };
}

function parseScreenshot(value: unknown): BrowserScreenshotRecord | undefined {
  if (!isRecord(value) || !isRecord(value.blob)) return undefined;
  if (
    typeof value.browserProviderId !== "string" ||
    typeof value.pageId !== "string" ||
    typeof value.generation !== "number" ||
    typeof value.artifactId !== "string" ||
    typeof value.capturedAt !== "number" ||
    typeof value.blob.id !== "string" ||
    typeof value.blob.sha256 !== "string" ||
    typeof value.blob.byteLength !== "number" ||
    typeof value.blob.mimeType !== "string"
  ) return undefined;
  return value as unknown as BrowserScreenshotRecord;
}

function parseActivityLog(value: unknown, maximumActivities: number): BrowserActivity[] {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries)) {
    throw new Error("Stored Browser activity log has an unsupported format.");
  }
  const activities: BrowserActivity[] = [];
  for (const candidate of value.entries) {
    const activity = parseActivity(candidate);
    if (activity === undefined) throw new Error("Stored Browser activity log contains an invalid entry.");
    activities.push(activity);
  }
  return activities.slice(-maximumActivities);
}

function parsePageCatalog(value: unknown): StoredPageCatalog {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.openEntries) ||
    !Array.isArray(value.activePages) ||
    !Array.isArray(value.lastGenerations)
  ) {
    throw new Error("Stored Browser page catalog has an unsupported format.");
  }
  const parsedEntries: RecoverableBrowserPageRecord[] = [];
  for (const candidate of value.openEntries) {
    const page = parseRecoverablePage(candidate);
    if (page === undefined || page.state !== "open") {
      throw new Error("Stored Browser page catalog contains an invalid open page.");
    }
    parsedEntries.push(page);
  }
  const openEntries = sortOpenPages(parsedEntries);
  if (openEntries.length !== parsedEntries.length) {
    throw new Error("Stored Browser page catalog contains a duplicate open page.");
  }

  const parsedActivePages: StoredActivePage[] = [];
  for (const candidate of value.activePages) {
    const activePage = parseActivePage(candidate);
    if (activePage === undefined) throw new Error("Stored Browser page catalog contains an invalid active page.");
    parsedActivePages.push(activePage);
  }
  const activePages = retainActivePages(parsedActivePages, openEntries);
  if (activePages.length !== parsedActivePages.length) {
    throw new Error("Stored Browser page catalog contains an unavailable or duplicate active page.");
  }

  const persistedGenerations: StoredGenerationWatermark[] = [];
  for (const candidate of value.lastGenerations) {
    const watermark = parseGenerationWatermark(candidate);
    if (watermark === undefined) throw new Error("Stored Browser page catalog contains an invalid generation watermark.");
    persistedGenerations.push(watermark);
  }
  const lastGenerations = mergeGenerationWatermarks(persistedGenerations, []);
  if (lastGenerations.length !== persistedGenerations.length) {
    throw new Error("Stored Browser page catalog contains a duplicate generation watermark.");
  }
  for (const page of openEntries) {
    const watermark = lastGenerations.find((item) => item.browserProviderId === page.browserProviderId);
    if (watermark === undefined || watermark.generation < page.generation) {
      throw new Error("Stored Browser page catalog has an incomplete generation watermark.");
    }
  }
  return {
    version: 1,
    openEntries,
    activePages,
    lastGenerations
  };
}

function emptyPageCatalog(): StoredPageCatalog {
  return { version: 1, openEntries: [], activePages: [], lastGenerations: [] };
}

function catalogWithOpenPage(
  catalog: StoredPageCatalog,
  page: RecoverableBrowserPageRecord,
  options: { readonly active: boolean; readonly replacesPageId?: string }
): StoredPageCatalog {
  const entries = catalog.openEntries.filter((item) => options.replacesPageId === undefined
    || item.browserProviderId !== page.browserProviderId
    || item.pageId !== options.replacesPageId);
  const existing = entries.findIndex((item) => item.browserProviderId === page.browserProviderId && item.pageId === page.pageId);
  if (existing < 0) entries.push(page);
  else entries[existing] = page;
  const openEntries = sortOpenPages(entries);
  const activePages = retainActivePages(
    options.active
      ? replaceActivePage(catalog.activePages, page.browserProviderId, page.pageId)
      : catalog.activePages,
    openEntries
  );
  return {
    version: 1,
    openEntries,
    activePages,
    lastGenerations: advanceGeneration(catalog.lastGenerations, page.browserProviderId, page.generation)
  };
}

function sortOpenPages(entries: readonly RecoverableBrowserPageRecord[]): RecoverableBrowserPageRecord[] {
  const byIdentity = new Map<string, RecoverableBrowserPageRecord>();
  for (const entry of entries) {
    if (entry.state !== "open") continue;
    const identity = pageIdentity(entry.browserProviderId, entry.pageId);
    const current = byIdentity.get(identity);
    if (current === undefined || entry.updatedAt >= current.updatedAt) byIdentity.set(identity, entry);
  }
  return [...byIdentity.values()].sort((left, right) =>
    left.updatedAt - right.updatedAt ||
    left.browserProviderId.localeCompare(right.browserProviderId, "en-US") ||
    left.pageId.localeCompare(right.pageId, "en-US")
  );
}

function retainActivePages(
  candidates: readonly StoredActivePage[],
  openEntries: readonly RecoverableBrowserPageRecord[]
): StoredActivePage[] {
  const open = new Set(openEntries.map((item) => pageIdentity(item.browserProviderId, item.pageId)));
  const byProvider = new Map<string, StoredActivePage>();
  for (const candidate of candidates) {
    if (open.has(pageIdentity(candidate.browserProviderId, candidate.pageId))) {
      byProvider.set(candidate.browserProviderId, candidate);
    }
  }
  return [...byProvider.values()].sort((left, right) => left.browserProviderId.localeCompare(right.browserProviderId, "en-US"));
}

function replaceActivePage(
  activePages: readonly StoredActivePage[],
  browserProviderId: string,
  pageId: string
): StoredActivePage[] {
  return [
    ...activePages.filter((item) => item.browserProviderId !== browserProviderId),
    { browserProviderId, pageId }
  ];
}

function advanceGeneration(
  generations: readonly StoredGenerationWatermark[],
  browserProviderId: string,
  generation: number
): StoredGenerationWatermark[] {
  return mergeGenerationWatermarks([...generations, { browserProviderId, generation }], []);
}

function mergeGenerationWatermarks(
  watermarks: readonly StoredGenerationWatermark[],
  entries: readonly RecoverableBrowserPageRecord[]
): StoredGenerationWatermark[] {
  const maximumByProvider = new Map<string, number>();
  for (const item of watermarks) {
    maximumByProvider.set(item.browserProviderId, Math.max(maximumByProvider.get(item.browserProviderId) ?? 0, item.generation));
  }
  for (const item of entries) {
    maximumByProvider.set(item.browserProviderId, Math.max(maximumByProvider.get(item.browserProviderId) ?? 0, item.generation));
  }
  return [...maximumByProvider]
    .map(([browserProviderId, generation]) => ({ browserProviderId, generation }))
    .sort((left, right) => left.browserProviderId.localeCompare(right.browserProviderId, "en-US"));
}

function parseActivePage(value: unknown): StoredActivePage | undefined {
  if (
    !isRecord(value) ||
    typeof value.browserProviderId !== "string" ||
    !safeOpaqueId(value.browserProviderId) ||
    typeof value.pageId !== "string" ||
    !safePageId(value.pageId)
  ) return undefined;
  return { browserProviderId: value.browserProviderId, pageId: value.pageId };
}

function parseGenerationWatermark(value: unknown): StoredGenerationWatermark | undefined {
  if (
    !isRecord(value) ||
    typeof value.browserProviderId !== "string" ||
    !safeOpaqueId(value.browserProviderId) ||
    typeof value.generation !== "number" ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1
  ) return undefined;
  return { browserProviderId: value.browserProviderId, generation: value.generation };
}

function pageIdentity(browserProviderId: string, pageId: string): string {
  return `${browserProviderId}\u0000${pageId}`;
}

function parseRecoverablePage(value: unknown): RecoverableBrowserPageRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.browserProviderId !== "string" || !safeOpaqueId(value.browserProviderId) ||
    typeof value.pageId !== "string" || !safePageId(value.pageId) ||
    typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 1 ||
    typeof value.sessionId !== "string" || !safeProductId(value.sessionId) ||
    typeof value.targetId !== "string" || !safeProductId(value.targetId) ||
    typeof value.bindingGeneration !== "number" || !Number.isSafeInteger(value.bindingGeneration) || value.bindingGeneration < 0 ||
    typeof value.url !== "string" ||
    typeof value.title !== "string" || value.title.length > 1_024 || value.title.includes("\u0000") ||
    (value.state !== "open" && value.state !== "closed") ||
    typeof value.updatedAt !== "number" || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0
  ) return undefined;
  let url: string;
  try { url = validateTakeoverNavigationUrl(value.url); } catch { return undefined; }
  return {
    browserProviderId: value.browserProviderId,
    pageId: value.pageId,
    generation: value.generation,
    sessionId: value.sessionId,
    targetId: value.targetId,
    bindingGeneration: value.bindingGeneration,
    url,
    title: redactSecrets(value.title),
    state: value.state,
    updatedAt: value.updatedAt
  };
}

function parseBridgeEffectAuthority(value: BrowserBridgeEffectAuthority): BrowserBridgeEffectAuthority {
  if (
    !safeProductId(value.sessionId) ||
    !safeProductId(value.targetId) ||
    !Number.isSafeInteger(value.bindingGeneration) || value.bindingGeneration < 0 ||
    !safeOpaqueId(value.browserProviderId) ||
    !Number.isSafeInteger(value.providerGeneration) || value.providerGeneration < 1 ||
    !/^[a-f0-9]{64}$/u.test(value.requestIdentity) ||
    !/^[a-f0-9]{64}$/u.test(value.effectIdentity) ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.requestBodyHash)
  ) throw new BrowserSessionAuthorityError("Browser bridge effect authority is invalid.");
  return { ...value };
}

function assertSessionAuthority(store: OperationalStore, authority: BrowserSessionAuthority): void {
  if (
    !safeProductId(authority.sessionId) ||
    !safeProductId(authority.targetId) ||
    !Number.isSafeInteger(authority.bindingGeneration) || authority.bindingGeneration < 0
  ) throw new BrowserSessionAuthorityError();
  try {
    const session = store.getSession(authority.sessionId).descriptor;
    if (
      session.targetId !== authority.targetId ||
      session.binding.generation !== authority.bindingGeneration ||
      session.archived ||
      session.deletedAt !== undefined ||
      store.findPendingSessionLifecycleCleanup(authority.sessionId) !== undefined
    ) throw new BrowserSessionAuthorityError();
  } catch (error) {
    if (error instanceof BrowserSessionAuthorityError) throw error;
    throw new BrowserSessionAuthorityError();
  }
}

function samePageOwner(left: RecoverableBrowserPageRecord, right: RecoverableBrowserPageRecord): boolean {
  return left.sessionId === right.sessionId &&
    left.targetId === right.targetId &&
    left.bindingGeneration === right.bindingGeneration &&
    left.generation === right.generation;
}

function safeOpaqueId(value: string): boolean {
  return value.length >= 1 && value.length <= 512 && /^[A-Za-z0-9_-]+$/u.test(value);
}

function safePageId(value: string): boolean {
  return value.length >= 1 && value.length <= 1_024 && !value.includes("\u0000");
}

function safeProductId(value: string): boolean {
  return value.length >= 1 && value.length <= 1_024 && !value.includes("\u0000");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
