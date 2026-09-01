import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import {
  chromium,
  type APIResponse,
  type BrowserContext,
  type Dialog,
  type Download,
  type Locator,
  type Page,
  type Response
} from "playwright-core";
import { isWithin } from "@joko/core/policy";
import {
  BrowserLeaseConflictError,
  BrowserLeaseRegistry,
  type BrowserLease,
  type BrowserLeaseFence
} from "./leases.js";
import {
  BrowserTakeoverConflictError,
  BrowserTakeoverRateLimitError,
  BrowserTakeoverRegistry,
  validateTakeoverInput,
  validateTakeoverFence,
  validateTakeoverNavigationUrl,
  validateTakeoverRequest,
  validateTakeoverTtl,
  type BrowserTakeover,
  type BrowserTakeoverFence,
  type BrowserTakeoverInput,
  type BrowserTakeoverKeyModifier,
  type BrowserTakeoverRequest
} from "./takeovers.js";

const DEFAULT_MAXIMUM_SCREENSHOT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAXIMUM_PDF_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAXIMUM_CONSOLE_MESSAGES = 200;
const DEFAULT_MAXIMUM_HTTP_REQUEST_SUMMARIES = 200;
const ABSOLUTE_MAXIMUM_CAPTURE_BYTES = 64 * 1024 * 1024;
const ABSOLUTE_MAXIMUM_DIAGNOSTIC_ITEMS = 1_000;
const MAXIMUM_DIAGNOSTIC_ITEMS_PER_READ = 100;
const MAXIMUM_SELECTOR_LENGTH = 4_096;
const MAXIMUM_ACTION_TEXT_LENGTH = 64 * 1024;
const MAXIMUM_KEY_LENGTH = 64;
const MAXIMUM_UPLOAD_PATHS = 16;
const MAXIMUM_PATH_LENGTH = 32_768;
const MAXIMUM_SCROLL_DELTA = 100_000;
const MAXIMUM_VIEWPORT_EDGE = 8_192;
const MAXIMUM_WAIT_MILLISECONDS = 30_000;
const MAXIMUM_EVALUATE_SOURCE_LENGTH = 64 * 1024;
const MAXIMUM_EVALUATE_RESULT_BYTES = 200_000;
const MAXIMUM_RESPONSE_BODY_CHARACTERS = 200_000;
const DEFAULT_RESPONSE_BODY_TIMEOUT_MS = 20_000;
const MAXIMUM_RESOURCE_BYTES = 10 * 1024 * 1024;
const MAXIMUM_EXTRACT_FIELDS = 128;
const MAXIMUM_EXTRACT_RECORDS = 1_000;
const MAXIMUM_SNAPSHOT_CHARACTERS = 200_000;
const MAXIMUM_CONSOLE_TEXT_LENGTH = 4_096;
const MAXIMUM_PUBLIC_URL_LENGTH = 8_192;
const MAXIMUM_PUBLIC_TITLE_LENGTH = 1_024;
const MAXIMUM_PUBLIC_ID_LENGTH = 1_024;
const BROWSER_COMMENT_ELEMENT_ATTRIBUTE = "data-joko-browser-comment-target";
const BROWSER_COMMENT_DESIGN_PROPERTIES = ["color", "background-color", "font-size", "font-weight", "padding", "border-radius"] as const;
const MAXIMUM_BROWSER_COMMENT_TEXT = 8_000;
const MAXIMUM_BROWSER_COMMENT_EVIDENCE = 2_048;
const MAXIMUM_BROWSER_COMMENT_MARKER_NUMBER = 0xffff_ffff;

export type BrowserCommentDesignProperty = typeof BROWSER_COMMENT_DESIGN_PROPERTIES[number];

export interface BrowserCommentRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BrowserCommentDesignBaseline {
  readonly styles: Readonly<Record<BrowserCommentDesignProperty, string>>;
  readonly editableText?: string;
  readonly provenance: Readonly<Partial<Record<BrowserCommentDesignProperty, string>>>;
}

export interface BrowserCommentTarget {
  readonly kind: "element" | "region" | "text";
  readonly point: { readonly x: number; readonly y: number };
  readonly viewport: { readonly width: number; readonly height: number };
  readonly region?: BrowserCommentRegion;
  readonly textRegions?: readonly BrowserCommentRegion[];
  readonly selectedText?: string;
  readonly targetTag?: string;
  readonly targetLabel?: string;
  readonly targetRole?: string;
  readonly targetSelector?: string;
  readonly targetPath?: string;
  readonly nearbyText?: string;
  readonly themeVariant?: "light" | "dark";
  readonly designBaseline?: BrowserCommentDesignBaseline;
}

export interface BrowserCommentPlacement {
  readonly markerNumber: number;
  readonly point: { readonly x: number; readonly y: number };
  readonly viewport: { readonly width: number; readonly height: number };
  readonly pending: boolean;
  readonly region?: BrowserCommentRegion;
  readonly textRegions?: readonly BrowserCommentRegion[];
}

export type BrowserCommentInspectionInput =
  | { readonly intent: "element"; readonly markerNumber: number; readonly normalizedX: number; readonly normalizedY: number }
  | { readonly intent: "region"; readonly markerNumber: number; readonly normalizedPoint: { readonly x: number; readonly y: number }; readonly normalizedRegion: BrowserCommentRegion }
  | { readonly intent: "existingText"; readonly markerNumber: number };

export type BrowserCommentDesignUpdate =
  | {
      readonly action: "apply";
      readonly targetToken: string;
      readonly styles: Readonly<Partial<Record<BrowserCommentDesignProperty, string>>>;
      readonly text?: string;
    }
  | { readonly action: "reset"; readonly targetToken: string }
  | { readonly action: "commit"; readonly targetToken: string; readonly markerNumber: number }
  | { readonly action: "reconcile"; readonly validMarkerNumbers: readonly number[] }
  | { readonly action: "resetAll" };

interface BrowserCommentInlineStyle {
  value: string;
  priority: string;
}

interface BrowserCommentDesignRecord {
  readonly token: string;
  readonly markerNumber: number;
  readonly sequence: number;
  readonly documentPoint: { readonly x: number; readonly y: number };
  readonly documentRegion?: BrowserCommentRegion;
  readonly documentTextRegions?: readonly BrowserCommentRegion[];
  readonly elementId?: string;
  readonly originalStyles?: Record<BrowserCommentDesignProperty, BrowserCommentInlineStyle>;
  originalText?: string;
  preview: { readonly styles: Readonly<Partial<Record<BrowserCommentDesignProperty, string>>>; readonly text?: string };
  pending: boolean;
}

type BrowserCommentElementDesignRecord = BrowserCommentDesignRecord & {
  readonly elementId: string;
  readonly originalStyles: Record<BrowserCommentDesignProperty, BrowserCommentInlineStyle>;
};

export type BrowserDownloadHandler = (
  pageId: string,
  verifiedLocalPath: string,
  sanitizedFileName: string
) => Promise<void> | void;

/**
 * Selects where the persistent Browser surface is presented.
 *
 * `sidebar` keeps the Provider headless for the governed in-product surface;
 * `external` launches a headed, dedicated Browser window. Each mode must use
 * its own persistent profile so cookies and authenticated state never cross
 * the presentation boundary.
 */
export type BrowserTargetMode = "sidebar" | "external";

export interface BrowserTargetProfileDirectories {
  readonly sidebar: string;
  readonly external: string;
}

export class BrowserTargetModeConflictError extends Error {
  readonly code = "BROWSER_TARGET_MODE_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "BrowserTargetModeConflictError";
  }
}

export interface BrowserProviderOptions {
  /** Stable public identity used in every lease and takeover fence. */
  readonly providerId?: string;
  /** Last durably observed generation, used to keep page fences monotonic after host restart. */
  readonly initialGeneration?: number;
  readonly executablePath: string;
  /**
   * Distinct persistent profiles keep sidebar and external Browser authority
   * isolated. The target defaults to `external` when targetMode is omitted.
   */
  readonly profileDirectories: BrowserTargetProfileDirectories;
  /** Product-owned name written only into the managed external Chrome profile. */
  readonly profileDisplayName?: string | (() => string);
  readonly targetMode?: BrowserTargetMode;
  readonly downloadDirectory: string;
  readonly uploadRoots: readonly string[];
  /** Live host policy checked when a page file input action is attempted. */
  readonly canUpload?: () => boolean;
  /** Live host policy checked before a download is allowed to reach staging. */
  readonly canDownload?: () => boolean;
  readonly launchArgs?: readonly string[];
  readonly onActivity?: (activity: BrowserActivity) => Promise<void> | void;
  /**
   * Receives a private, canonical path that is guaranteed to be a regular file
   * inside downloadDirectory. The path is never copied into public activity.
   * Consumers should finish ingesting the file before the returned promise
   * settles; the provider removes the staging file afterwards.
   */
  readonly onDownload?: BrowserDownloadHandler;
  readonly maximumDownloadBytes?: number;
  /** Maximum bytes returned by one screenshot-only capture. */
  readonly maximumScreenshotBytes?: number;
  /** Maximum bytes returned by one in-memory PDF capture. */
  readonly maximumPdfBytes?: number;
  /** Per-page retained, sanitized console-message count. */
  readonly maximumConsoleMessages?: number;
  /** Per-page retained HTTP(S) request-summary count. */
  readonly maximumHttpRequestSummaries?: number;
  /** Clock seam for takeover expiry/rate-bound lifecycle tests. */
  readonly now?: () => number;
  /** Runtime seam for embedders and deterministic lifecycle tests. */
  readonly launchPersistentContext?: BrowserContextLauncher;
}

export type BrowserContextLauncher = (
  profileDirectory: string,
  options: NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>
) => Promise<BrowserContext>;

export interface BrowserActivity {
  readonly at: number;
  readonly type: "started" | "stopped" | "page" | "navigation" | "action" | "download" | "crashed" | "takeover";
  readonly pageId?: string;
  readonly detail: string;
}

export interface BrowserPageState {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly state: "ready" | "loading" | "closed" | "crashed";
  readonly canGoBack?: boolean;
  readonly canGoForward?: boolean;
}

export interface BrowserSnapshot {
  readonly page: BrowserPageState;
  readonly aria: string;
  readonly screenshot: Uint8Array;
}

export interface BrowserElementQuery {
  readonly css?: string;
  readonly role?: string;
  readonly name?: string;
  readonly text?: string;
  readonly label?: string;
  readonly placeholder?: string;
  readonly testId?: string;
  readonly exact?: boolean;
  readonly index?: number;
}

export interface BrowserElementTarget {
  readonly selector?: string;
  readonly ref?: string;
  readonly query?: BrowserElementQuery;
}

export interface BrowserSnapshotOptions {
  readonly fullPage?: boolean;
  readonly selector?: string;
  readonly interactive?: boolean;
  readonly compact?: boolean;
  readonly depth?: number;
  readonly labels?: boolean;
  readonly urls?: boolean;
  readonly maxChars?: number;
  readonly timeoutMs?: number;
  readonly frame?: string;
}

export interface BrowserDialogSnapshot {
  readonly id: string;
  readonly pageId: string;
  readonly type: string;
  readonly message: string;
  readonly defaultValue: string;
}

export type BrowserExtractField = string | {
  readonly selector?: string;
  readonly attr?: string;
  readonly type?: "text" | "html" | "attr" | "href";
};

export interface BrowserExtractSpec {
  readonly from?: string;
  readonly multiple?: boolean;
  readonly fields: Readonly<Record<string, BrowserExtractField>>;
  readonly limit?: number;
}

export interface BrowserExtractResult {
  readonly ok: true;
  readonly count: number;
  readonly records: readonly Readonly<Record<string, string | null>>[];
}

export interface BrowserResponseBodySnapshot {
  readonly url: string;
  readonly status: number;
  readonly mediaType: string;
  readonly body: string;
  readonly truncated: boolean;
}

export interface BrowserResourceSnapshot {
  readonly url: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export type BrowserAutomationAction =
  | "doctor" | "status" | "start" | "stop" | "profiles" | "tabs" | "open" | "focus" | "close"
  | "snapshot" | "screenshot" | "navigate" | "console" | "pdf" | "upload" | "dialog" | "act"
  | "requests" | "responseBody" | "extract" | "recipe" | "siteguide" | "saveRecipe";

export type BrowserAutomationActKind =
  | "click" | "clickCoords" | "type" | "press" | "hover" | "drag" | "select" | "fill" | "resize"
  | "wait" | "evaluate" | "saveResource" | "close";

export type BrowserRemoteNodeCapability =
  | `action:${BrowserAutomationAction}`
  | `act:${BrowserAutomationActKind}`
  | "semantic-query"
  | "artifact-upload"
  | "binary-result";

export interface BrowserRemoteAutomationRequest {
  readonly action: BrowserAutomationAction;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface BrowserRemoteAutomationResult {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly errorCode?: string;
  readonly message?: string;
  readonly binary?: {
    readonly bytes: Uint8Array;
    readonly mediaType: "image/png" | "image/jpeg" | "application/pdf" | "application/octet-stream";
    readonly fileName?: string;
  };
}

/** Capability-driven hook implemented by a host-owned remote Browser adapter. */
export interface BrowserRemoteNodeRoute {
  readonly id: string;
  readonly generation: number;
  readonly available: boolean;
  readonly capabilities: ReadonlySet<BrowserRemoteNodeCapability>;
  call(request: BrowserRemoteAutomationRequest, signal?: AbortSignal): Promise<BrowserRemoteAutomationResult>;
}

export interface BrowserRemoteNodeRouter {
  resolve(nodeId: string): BrowserRemoteNodeRoute | undefined | Promise<BrowserRemoteNodeRoute | undefined>;
  list(): readonly Pick<BrowserRemoteNodeRoute, "id" | "generation" | "available" | "capabilities">[];
}

export type BrowserKeyModifier = "Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift";

export interface BrowserScreenshotOptions {
  readonly fullPage?: boolean;
  readonly selector?: string;
  readonly type?: "png" | "jpeg";
  readonly labels?: boolean;
}

export interface BrowserDiagnosticReadOptions {
  readonly limit?: number;
  readonly filter?: string;
  readonly level?: string;
  readonly clear?: boolean;
}

export interface BrowserConsoleMessageSnapshot {
  readonly sequence: number;
  readonly at: number;
  readonly level: string;
  readonly text: string;
}

/** Deliberately excludes headers, cookies, request bodies, and response data. */
export interface BrowserHttpRequestSummary {
  readonly sequence: number;
  readonly at: number;
  readonly method: string;
  readonly url: string;
  readonly resourceType: string;
  readonly navigation: boolean;
}

export interface BrowserHumanPageRequest {
  readonly providerId: string;
  readonly generation: number;
  readonly owner: string;
  readonly url: string;
}

export type BrowserAction =
  | { readonly type: "navigate"; readonly url: string }
  | { readonly type: "click"; readonly selector: string; readonly button?: "left" | "middle" | "right"; readonly doubleClick?: boolean; readonly modifiers?: readonly BrowserKeyModifier[] }
  | { readonly type: "doubleClick"; readonly selector: string }
  | { readonly type: "rightClick"; readonly selector: string }
  | { readonly type: "hover"; readonly selector: string }
  | { readonly type: "clickCoords"; readonly x: number; readonly y: number; readonly button?: "left" | "middle" | "right"; readonly doubleClick?: boolean }
  | { readonly type: "drag"; readonly sourceSelector: string; readonly targetSelector: string }
  | { readonly type: "type"; readonly selector: string; readonly text: string; readonly submit?: boolean; readonly slowly?: boolean; readonly delayMs?: number }
  | { readonly type: "fill"; readonly selector: string; readonly text: string }
  | { readonly type: "press"; readonly key: string; readonly selector?: string }
  | { readonly type: "hotkey"; readonly key: string; readonly modifiers?: readonly BrowserKeyModifier[]; readonly selector?: string }
  | { readonly type: "scroll"; readonly deltaX: number; readonly deltaY: number }
  | { readonly type: "resize"; readonly width: number; readonly height: number }
  | { readonly type: "wait"; readonly milliseconds?: number; readonly selector?: string; readonly url?: string; readonly textGone?: string; readonly loadState?: "load" | "domcontentloaded" | "networkidle"; readonly timeoutMs?: number }
  | { readonly type: "select"; readonly selector: string; readonly value?: string; readonly values?: readonly string[] }
  | { readonly type: "upload"; readonly selector: string; readonly paths: readonly string[] }
  | { readonly type: "back" }
  | { readonly type: "forward" }
  | { readonly type: "reload" };

export class BrowserProvider {
  readonly id: string;
  readonly #options: BrowserProviderOptions;
  readonly #leases = new BrowserLeaseRegistry();
  readonly #takeovers: BrowserTakeoverRegistry;
  #context: BrowserContext | undefined;
  readonly #profileDirectories: BrowserTargetProfileDirectories;
  readonly #maximumScreenshotBytes: number;
  readonly #maximumPdfBytes: number;
  readonly #maximumConsoleMessages: number;
  readonly #maximumHttpRequestSummaries: number;
  #targetMode: BrowserTargetMode;
  #generation = 0;
  #pageIds = new WeakMap<Page, string>();
  #nextPageId = 1;
  readonly #pageStates = new WeakMap<Page, BrowserPageState["state"]>();
  readonly #consoleMessages = new WeakMap<Page, BrowserConsoleMessageSnapshot[]>();
  readonly #httpRequestSummaries = new WeakMap<Page, BrowserHttpRequestSummary[]>();
  readonly #dialogs = new WeakMap<Page, Map<string, Dialog>>();
  readonly #snapshotRefs = new WeakMap<Page, Map<string, string>>();
  readonly #pageLabels = new WeakMap<Page, string>();
  readonly #browserCommentDesignRecords = new WeakMap<Page, Map<string, BrowserCommentDesignRecord>>();
  #nextBrowserCommentDesignSequence = 1;
  #nextConsoleMessageSequence = 1;
  #nextHttpRequestSequence = 1;
  #nextDialogId = 1;
  #lifecycleTail: Promise<void> = Promise.resolve();
  #lifecycleEpoch = 0;
  #recoveryInFlight: Promise<void> | undefined;
  #stopInFlight: Promise<void> | undefined;
  #generationAbort = new AbortController();
  #downloadHandler: BrowserDownloadHandler | undefined;
  #takeoverRequestPending = false;
  #takeoverRateWindow: { takeoverId: string; startedAt: number; count: number } | undefined;

  constructor(options: BrowserProviderOptions) {
    this.id = validateProviderId(options.providerId ?? "browser");
    this.#options = options;
    this.#generation = validateInitialBrowserGeneration(options.initialGeneration ?? 0);
    const launchTargets = resolveBrowserLaunchTargets(options);
    this.#profileDirectories = launchTargets.profileDirectories;
    this.#targetMode = launchTargets.targetMode;
    this.#maximumScreenshotBytes = validateBoundedPositiveInteger(
      options.maximumScreenshotBytes ?? DEFAULT_MAXIMUM_SCREENSHOT_BYTES,
      "maximumScreenshotBytes",
      ABSOLUTE_MAXIMUM_CAPTURE_BYTES
    );
    this.#maximumPdfBytes = validateBoundedPositiveInteger(
      options.maximumPdfBytes ?? DEFAULT_MAXIMUM_PDF_BYTES,
      "maximumPdfBytes",
      ABSOLUTE_MAXIMUM_CAPTURE_BYTES
    );
    this.#maximumConsoleMessages = validateBoundedPositiveInteger(
      options.maximumConsoleMessages ?? DEFAULT_MAXIMUM_CONSOLE_MESSAGES,
      "maximumConsoleMessages",
      ABSOLUTE_MAXIMUM_DIAGNOSTIC_ITEMS
    );
    this.#maximumHttpRequestSummaries = validateBoundedPositiveInteger(
      options.maximumHttpRequestSummaries ?? DEFAULT_MAXIMUM_HTTP_REQUEST_SUMMARIES,
      "maximumHttpRequestSummaries",
      ABSOLUTE_MAXIMUM_DIAGNOSTIC_ITEMS
    );
    this.#takeovers = new BrowserTakeoverRegistry(options.now);
    this.#downloadHandler = options.onDownload;
  }

  get generation(): number {
    return this.#generation;
  }

  get running(): boolean {
    return this.#context !== undefined;
  }

  get targetMode(): BrowserTargetMode {
    return this.#targetMode;
  }

  start(): Promise<void> {
    return this.queueLifecycle(() => this.startNow());
  }

  stop(): Promise<void> {
    if (this.#stopInFlight !== undefined) return this.#stopInFlight;
    this.#lifecycleEpoch += 1;
    const context = this.detachContext();
    const task = (async () => {
      if (context !== undefined) await context.close().catch(() => undefined);
      await this.emit({ at: Date.now(), type: "stopped", detail: "Browser stopped." });
    })();
    let stopping!: Promise<void>;
    stopping = task.finally(() => {
      if (this.#stopInFlight === stopping) this.#stopInFlight = undefined;
    });
    this.#stopInFlight = stopping;
    this.#lifecycleTail = stopping.then(() => undefined, () => undefined);
    return stopping;
  }

  recover(): Promise<void> {
    if (this.#recoveryInFlight !== undefined) return this.#recoveryInFlight;

    // Recovery is deliberately not queued behind page operations. A wedged
    // CDP call must not prevent the host from fencing that generation and
    // launching a replacement context. Old work can settle in the background,
    // but its exit fence can no longer publish a result.
    this.#lifecycleEpoch += 1;
    const recoveryEpoch = this.#lifecycleEpoch;
    const previous = this.detachContext();
    if (previous !== undefined) void previous.close().catch(() => undefined);
    const task = (async () => {
      await this.emit({ at: Date.now(), type: "stopped", detail: "Browser stopped for recovery." });
      if (recoveryEpoch !== this.#lifecycleEpoch) {
        throw new BrowserLeaseConflictError("Browser recovery was superseded by a newer generation.");
      }
      await this.startNow();
    })();
    let recovery!: Promise<void>;
    recovery = task.finally(() => {
      if (this.#recoveryInFlight === recovery) this.#recoveryInFlight = undefined;
    });
    this.#recoveryInFlight = recovery;
    this.#lifecycleTail = recovery.then(() => undefined, () => undefined);
    return recovery;
  }

  /**
   * Changes the next launch target without implicitly terminating live work.
   * Callers must stop the Provider first; stop fences leases/takeovers and
   * closes every page before the profile boundary may change.
   */
  setTargetMode(targetMode: BrowserTargetMode): Promise<void> {
    const next = validateBrowserTargetMode(targetMode);
    return this.queueLifecycle(async () => {
      if (next === this.#targetMode) return;
      if (this.#leases.current() !== undefined) {
        throw new BrowserTargetModeConflictError("Browser target cannot change while an agent lease is active.");
      }
      if (this.#takeoverRequestPending || this.#takeovers.current() !== undefined) {
        throw new BrowserTargetModeConflictError("Browser target cannot change while a human takeover is active.");
      }
      if (this.#context !== undefined) {
        throw new BrowserTargetModeConflictError("Stop the Browser Provider before changing its target.");
      }
      this.#targetMode = next;
    });
  }

  /**
   * Brings up the dedicated headed Browser without revealing its profile path.
   * The first existing tab is focused; a blank tab is created only when the
   * persistent context has no tabs, so repeated calls never multiply tabs.
   */
  showExternalWindow(): Promise<void> {
    return this.queueLifecycle(async () => {
      if (this.#targetMode !== "external") {
        throw new BrowserTargetModeConflictError("The dedicated Browser window requires the external target.");
      }
      if (this.#takeoverRequestPending || this.#leases.current() !== undefined || this.#takeovers.current() !== undefined) {
        throw new BrowserTargetModeConflictError("The dedicated Browser window cannot be shown during active control.");
      }
      if (this.#context === undefined) await this.startNow();
      const context = this.requireContext();
      const page = context.pages()[0] ?? await context.newPage();
      await page.bringToFront();
    });
  }

  acquireAgentLease(owner: string, ttlMs = 5 * 60 * 1_000): BrowserLease {
    if (owner.trim() === "") throw new Error("A browser agent lease requires an owner.");
    this.requireContext();
    if (this.#takeoverRequestPending || this.#takeovers.current() !== undefined) {
      throw new BrowserLeaseConflictError("Browser Provider is reserved for human takeover.");
    }
    return this.#leases.acquire({ providerId: this.id, owner, generation: this.#generation }, ttlMs);
  }

  releaseAgentLease(lease: BrowserLeaseFence): Promise<void> {
    const fence = copyAgentFence(lease);
    return this.queueLifecycle(async () => {
      this.#leases.release(fence);
    });
  }

  currentAgentLease(): BrowserLease | undefined {
    return this.#leases.current();
  }

  currentHumanTakeover(): BrowserTakeover | undefined {
    const current = this.#takeovers.current();
    if (current === undefined) this.#takeoverRateWindow = undefined;
    return current;
  }

  /** Installs the private download ingest hook before the provider is started. */
  setDownloadHandler(handler: BrowserDownloadHandler | undefined): void {
    this.#downloadHandler = handler;
  }

  private async startNow(): Promise<void> {
    if (this.#context !== undefined) return;
    const lifecycleEpoch = this.#lifecycleEpoch;
    const profileDirectory = this.#profileDirectories[this.#targetMode];
    await Promise.all([
      mkdir(profileDirectory, { recursive: true }),
      mkdir(this.#options.downloadDirectory, { recursive: true })
    ]);
    if (this.#targetMode === "external") {
      const displayName = typeof this.#options.profileDisplayName === "function"
        ? this.#options.profileDisplayName()
        : this.#options.profileDisplayName;
      if (displayName !== undefined) await decorateManagedChromeProfile(profileDirectory, displayName);
    }
    const launch = this.#options.launchPersistentContext ?? ((profileDirectory, launchOptions) =>
      chromium.launchPersistentContext(profileDirectory, launchOptions));
    const context = await launch(profileDirectory, {
      executablePath: this.#options.executablePath,
      headless: this.#targetMode === "sidebar",
      acceptDownloads: true,
      downloadsPath: this.#options.downloadDirectory,
      args: [...(this.#options.launchArgs ?? [])]
    });
    if (lifecycleEpoch !== this.#lifecycleEpoch) {
      void context.close().catch(() => undefined);
      throw new BrowserLeaseConflictError("Browser start was superseded by recovery.");
    }
    this.#generation += 1;
    this.#generationAbort = new AbortController();
    this.#context = context;
    context.on("page", (page) => this.bindPage(page));
    for (const page of context.pages()) this.bindPage(page);
    await this.emit({ at: Date.now(), type: "started", detail: `Browser generation ${this.#generation} started.` });
  }

  private detachContext(): BrowserContext | undefined {
    const context = this.#context;
    this.#context = undefined;
    if (!this.#generationAbort.signal.aborted) {
      this.#generationAbort.abort(new BrowserLeaseConflictError("Browser generation was interrupted."));
    }
    this.#leases.fence(this.#generation + 1);
    this.#takeovers.fence(this.#generation + 1);
    this.#takeoverRateWindow = undefined;
    return context;
  }

  /**
   * Begins human control of exactly one page. The request fences the generation
   * observed by the caller. Human input remains remote and authoritative; the
   * active target is never changed as a side effect of takeover.
   */
  beginHumanTakeover(request: BrowserTakeoverRequest, ttlMs = 15 * 60 * 1_000): Promise<BrowserTakeover> {
    const requested = copyTakeoverRequest(request);
    validateTakeoverRequest(requested);
    validateTakeoverTtl(ttlMs);
    if (this.#takeoverRequestPending) {
      return Promise.reject(new BrowserTakeoverConflictError("A Browser takeover transition is already pending."));
    }
    // Reserve synchronously so an agent cannot slip in before the lifecycle
    // task begins on the next microtask.
    this.#takeoverRequestPending = true;
    const result = this.queueLifecycle(async () => {
      const originalPage = this.requireRequestedTakeoverPage(requested);
      if (this.#leases.current() !== undefined) {
        throw new BrowserTakeoverConflictError("Browser Provider has an active agent control lease.");
      }
      if (this.#takeovers.current() !== undefined) {
        throw new BrowserTakeoverConflictError("Browser Provider already has an active human takeover.");
      }

      const page = originalPage;
      const pageId = this.idFor(page);
      const takeover = this.#takeovers.begin({
        providerId: this.id,
        pageId,
        generation: this.#generation,
        owner: requested.owner
      }, ttlMs);
      this.#takeoverRateWindow = undefined;
      try {
        await page.bringToFront();
        this.assertHumanTakeover(takeover);
        await this.emit({
          at: Date.now(),
          type: "takeover",
          pageId,
          detail: `Human takeover ${takeover.takeoverId} started.`
        });
        return takeover;
      } catch (error) {
        try {
          this.#takeovers.end(takeover);
          this.#takeoverRateWindow = undefined;
        } catch {
          // Page close/recovery may have already fenced the failed begin.
        }
        throw error;
      }
    });
    return result.finally(() => {
      this.#takeoverRequestPending = false;
    });
  }

  /**
   * Opens a fresh page and atomically transfers this owner's human takeover to
   * it. Navigation completes before the previous page is released, so a failed
   * link open never destroys the currently presented page.
   */
  openHumanPage(request: BrowserHumanPageRequest, ttlMs = 15 * 60 * 1_000): Promise<BrowserTakeover> {
    const requested = {
      providerId: request.providerId,
      generation: request.generation,
      owner: request.owner,
      url: validateTakeoverNavigationUrl(request.url)
    };
    if (requested.providerId !== this.id || !Number.isSafeInteger(requested.generation) || requested.generation < 1) {
      throw new BrowserTakeoverConflictError("Browser page-open request has a stale Provider or generation fence.");
    }
    if (requested.owner.trim() === "" || requested.owner.length > 512 || requested.owner.includes("\u0000")) {
      throw new BrowserTakeoverConflictError("A Browser page-open request requires a bounded owner.");
    }
    validateTakeoverTtl(ttlMs);
    if (this.#takeoverRequestPending) {
      return Promise.reject(new BrowserTakeoverConflictError("A Browser takeover transition is already pending."));
    }
    this.#takeoverRequestPending = true;
    const result = this.queueLifecycle(async () => {
      const context = this.requireContext();
      if (requested.providerId !== this.id || requested.generation !== this.#generation) {
        throw new BrowserTakeoverConflictError("Browser page-open request has a stale Provider or generation fence.");
      }
      if (this.#leases.current() !== undefined) {
        throw new BrowserTakeoverConflictError("Browser Provider has an active agent control lease.");
      }
      const previous = this.#takeovers.current();
      if (previous !== undefined && previous.owner !== requested.owner) {
        throw new BrowserTakeoverConflictError("Browser Provider already has a human takeover owned by another Connection.");
      }

      let page: Page | undefined;
      let takeover: BrowserTakeover | undefined;
      try {
        page = await context.newPage();
        this.#pageStates.set(page, "loading");
        await page.goto(requested.url, { waitUntil: "domcontentloaded" });
        const pageId = this.idFor(page);
        if (previous !== undefined) {
          await this.resetHumanCommentDesigns(this.requirePageNow(previous.pageId));
          this.#takeovers.end(previous);
          this.#takeoverRateWindow = undefined;
          await this.emit({
            at: Date.now(),
            type: "takeover",
            pageId: previous.pageId,
            detail: `Human takeover ${previous.takeoverId} ended.`
          });
        }
        takeover = this.#takeovers.begin({
          providerId: this.id,
          pageId,
          generation: this.#generation,
          owner: requested.owner
        }, ttlMs);
        await page.bringToFront();
        this.assertHumanTakeover(takeover);
        await this.emit({
          at: Date.now(),
          type: "takeover",
          pageId,
          detail: `Human takeover ${takeover.takeoverId} started.`
        });
        return takeover;
      } catch (error) {
        if (takeover !== undefined) {
          try {
            this.#takeovers.end(takeover);
          } catch {
            // Closing the new page may already have fenced the failed takeover.
          }
        }
        await page?.close().catch(() => undefined);
        throw error;
      }
    });
    return result.finally(() => {
      this.#takeoverRequestPending = false;
    });
  }

  /**
   * Transfers an exact, authenticated human takeover to another live page in
   * the same Provider generation. Bringing the target forward happens before
   * the capability changes, so a failed focus never strands the current page.
   */
  focusHumanPage(
    fence: BrowserTakeoverFence,
    targetPageId: string,
    ttlMs = 15 * 60 * 1_000
  ): Promise<BrowserTakeover> {
    const expected = copyTakeoverFence(fence);
    const safeTargetPageId = validatePublicPageId(targetPageId);
    validateTakeoverFence(expected);
    validateTakeoverTtl(ttlMs);
    if (this.#takeoverRequestPending) {
      return Promise.reject(new BrowserTakeoverConflictError("A Browser takeover transition is already pending."));
    }
    this.#takeoverRequestPending = true;
    const result = this.queueLifecycle(async () => {
      const current = this.assertHumanTakeover(expected);
      const target = this.requirePageNow(safeTargetPageId);
      await target.bringToFront();
      this.assertHumanTakeover(expected);
      if (current.pageId === safeTargetPageId) return current;
      await this.resetHumanCommentDesigns(this.requirePageNow(current.pageId));

      this.#takeovers.end(expected);
      this.#takeoverRateWindow = undefined;
      const takeover = this.#takeovers.begin({
        providerId: this.id,
        pageId: safeTargetPageId,
        generation: this.#generation,
        owner: expected.owner
      }, ttlMs);
      await this.emit({
        at: Date.now(),
        type: "takeover",
        pageId: current.pageId,
        detail: `Human takeover ${current.takeoverId} ended.`
      });
      await this.emit({
        at: Date.now(),
        type: "takeover",
        pageId: safeTargetPageId,
        detail: `Human takeover ${takeover.takeoverId} started.`
      });
      return takeover;
    });
    return result.finally(() => {
      this.#takeoverRequestPending = false;
    });
  }

  /**
   * Closes one page under an exact human capability. Closing a background page
   * preserves the takeover. Closing the active page transfers control to the
   * nearest remaining page, or releases control when it was the last page.
   */
  closeHumanPage(
    fence: BrowserTakeoverFence,
    targetPageId: string,
    ttlMs = 15 * 60 * 1_000
  ): Promise<BrowserTakeover | undefined> {
    const expected = copyTakeoverFence(fence);
    const safeTargetPageId = validatePublicPageId(targetPageId);
    validateTakeoverFence(expected);
    validateTakeoverTtl(ttlMs);
    if (this.#takeoverRequestPending) {
      return Promise.reject(new BrowserTakeoverConflictError("A Browser takeover transition is already pending."));
    }
    this.#takeoverRequestPending = true;
    const result = this.queueLifecycle(async () => {
      const current = this.assertHumanTakeover(expected);
      const target = this.requirePageNow(safeTargetPageId);
      if (current.pageId !== safeTargetPageId) {
        await this.resetHumanCommentDesigns(target);
        await target.close();
        this.assertHumanTakeover(expected);
        await this.emit({ at: Date.now(), type: "page", pageId: safeTargetPageId, detail: "Page closed." });
        return current;
      }

      const replacement = this.requireContext().pages().find((candidate) => candidate !== target && !candidate.isClosed());
      if (replacement !== undefined) await replacement.bringToFront();
      this.assertHumanTakeover(expected);
      await this.resetHumanCommentDesigns(target);
      this.#takeovers.end(expected);
      this.#takeoverRateWindow = undefined;
      const takeover = replacement === undefined ? undefined : this.#takeovers.begin({
        providerId: this.id,
        pageId: this.idFor(replacement),
        generation: this.#generation,
        owner: expected.owner
      }, ttlMs);
      await target.close();
      await this.emit({
        at: Date.now(),
        type: "takeover",
        pageId: current.pageId,
        detail: `Human takeover ${current.takeoverId} ended.`
      });
      if (takeover !== undefined) {
        await this.emit({
          at: Date.now(),
          type: "takeover",
          pageId: takeover.pageId,
          detail: `Human takeover ${takeover.takeoverId} started.`
        });
      }
      await this.emit({ at: Date.now(), type: "page", pageId: safeTargetPageId, detail: "Page closed." });
      return takeover;
    });
    return result.finally(() => {
      this.#takeoverRequestPending = false;
    });
  }

  /** Ends only the exact takeover capability supplied by its authenticated owner. */
  endHumanTakeover(fence: BrowserTakeoverFence): Promise<void> {
    const expected = copyTakeoverFence(fence);
    validateTakeoverFence(expected);
    return this.queueLifecycle(async () => {
      const current = this.assertHumanTakeover(expected);
      await this.resetHumanCommentDesigns(this.requirePageNow(current.pageId));
      this.#takeovers.end(expected);
      this.#takeoverRateWindow = undefined;
      await this.emit({
        at: Date.now(),
        type: "takeover",
        pageId: current.pageId,
        detail: `Human takeover ${current.takeoverId} ended.`
      });
    });
  }

  /** Validates provider, page, generation, owner, and takeover ID as one fence. */
  assertHumanTakeover(fence: BrowserTakeoverFence): BrowserTakeover {
    const expected = copyTakeoverFence(fence);
    validateTakeoverFence(expected);
    if (expected.providerId !== this.id || expected.generation !== this.#generation) {
      throw new BrowserTakeoverConflictError("Browser takeover is missing, expired, or fenced.");
    }
    this.requireContext();
    const current = this.#takeovers.assert(expected);
    this.requirePageNow(current.pageId);
    return current;
  }

  /**
   * Runs a page operation in the same lifecycle critical section as recovery.
   * Both sides of the asynchronous operation revalidate the complete fence.
   */
  runHumanTakeoverOperation<T>(
    fence: BrowserTakeoverFence,
    operation: (page: Page) => Promise<T>
  ): Promise<T> {
    const expected = copyTakeoverFence(fence);
    validateTakeoverFence(expected);
    return this.queueLifecycle(async () => {
      const current = this.assertHumanTakeover(expected);
      const page = this.requirePageNow(current.pageId);
      const result = await raceAgainstAbort(operation(page), this.#generationAbort.signal);
      this.assertHumanTakeover(expected);
      return result;
    });
  }

  inspectHumanCommentTarget(
    fence: BrowserTakeoverFence,
    input: BrowserCommentInspectionInput
  ): Promise<{ readonly target?: BrowserCommentTarget; readonly targetToken?: string }> {
    let inspection: BrowserCommentInspectionInput;
    try {
      inspection = validateBrowserCommentInspection(input);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.runHumanTakeoverOperation(fence, async (page) => {
      const records = this.#browserCommentDesignRecords.get(page) ?? new Map<string, BrowserCommentDesignRecord>();
      this.#browserCommentDesignRecords.set(page, records);
      if ([...records.values()].some((record) => record.pending)) {
        throw new BrowserTakeoverConflictError("A pending Browser comment target must be committed or reset first.");
      }
      if ([...records.values()].some((record) => record.markerNumber === inspection.markerNumber)) {
        throw new BrowserTakeoverConflictError("Browser comment marker number is already live on this page.");
      }
      const suggestedElementId = randomUUID();
      const result = await inspectBrowserCommentTargetOnPage(
        page,
        inspection,
        suggestedElementId,
        [...new Set([...records.values()].flatMap((record) => record.elementId === undefined ? [] : [record.elementId]))]
      );
      if (result === undefined) return {};
      const token = randomUUID();
      records.set(token, {
        token,
        markerNumber: inspection.markerNumber,
        sequence: this.#nextBrowserCommentDesignSequence++,
        documentPoint: result.privatePlacement.documentPoint,
        ...(result.privatePlacement.documentRegion === undefined ? {} : { documentRegion: result.privatePlacement.documentRegion }),
        ...(result.privatePlacement.documentTextRegions === undefined ? {} : { documentTextRegions: result.privatePlacement.documentTextRegions }),
        ...(result.privateElement === undefined ? {} : {
          elementId: result.privateElement.elementId,
          originalStyles: result.privateElement.originalStyles,
          ...(result.privateElement.originalText === undefined ? {} : { originalText: result.privateElement.originalText })
        }),
        preview: { styles: {} },
        pending: true
      });
      return { target: result.target, targetToken: token };
    });
  }

  updateHumanCommentDesign(
    fence: BrowserTakeoverFence,
    input: BrowserCommentDesignUpdate
  ): Promise<{ readonly placements: readonly BrowserCommentPlacement[] }> {
    let update: BrowserCommentDesignUpdate;
    try {
      update = validateBrowserCommentDesignUpdate(input);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.runHumanTakeoverOperation(fence, async (page) => {
      const records = this.#browserCommentDesignRecords.get(page) ?? new Map<string, BrowserCommentDesignRecord>();
      this.#browserCommentDesignRecords.set(page, records);
      switch (update.action) {
        case "apply": {
          const record = requireBrowserCommentElementDesignRecord(records, update.targetToken, false);
          record.preview = { styles: { ...update.styles }, ...("text" in update ? { text: update.text } : {}) };
          await applyBrowserCommentDesignRecord(page, record);
          return { placements: [] };
        }
        case "reset": {
          const record = requireBrowserCommentDesignRecord(records, update.targetToken);
          await removeBrowserCommentDesignRecord(page, records, record);
          return { placements: [] };
        }
        case "commit": {
          const record = requireBrowserCommentDesignRecord(records, update.targetToken, false);
          if (record.markerNumber !== update.markerNumber) {
            throw new BrowserTakeoverConflictError("Browser comment marker number does not match its pending target.");
          }
          record.pending = false;
          return { placements: [] };
        }
        case "reconcile": {
          await reconcileBrowserCommentDesignRecords(page, records, new Set(update.validMarkerNumbers));
          return { placements: await projectBrowserCommentPlacements(page, records) };
        }
        case "resetAll": {
          await resetAllBrowserCommentDesignRecords(page, records);
          return { placements: [] };
        }
      }
    });
  }

  private async resetHumanCommentDesigns(page: Page): Promise<void> {
    const records = this.#browserCommentDesignRecords.get(page);
    if (records === undefined || records.size === 0) return;
    await resetAllBrowserCommentDesignRecords(page, records);
  }

  private fenceHumanCommentLedgerForNavigation(page: Page): void {
    const records = this.#browserCommentDesignRecords.get(page);
    this.#browserCommentDesignRecords.delete(page);
    if (records === undefined || records.size === 0) return;
    // Fence every old target synchronously. Restoration is serialized behind
    // the navigation that emitted this event, which also covers same-document
    // and hash navigations where the old DOM remains live.
    void this.queueLifecycle(async () => resetAllBrowserCommentDesignRecords(page, records)).catch(() => undefined);
  }

  /** Executes one bounded remote-human input under the exact active fence. */
  performHumanTakeoverAction(fence: BrowserTakeoverFence, input: BrowserTakeoverInput): Promise<void> {
    let action: BrowserTakeoverInput;
    try {
      validateTakeoverInput(input);
      action = copyTakeoverInput(input);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.runHumanTakeoverOperation(fence, async (page) => {
      this.consumeTakeoverRate(fence.takeoverId);
      const navigation = action.type === "navigate" || action.type === "navigationCommand";
      try {
        switch (action.type) {
      case "mouseClick": {
        const viewport = page.viewportSize();
        if (viewport === null || viewport.width < 1 || viewport.height < 1) {
          throw new BrowserTakeoverConflictError("Browser page does not expose a bounded CSS viewport.");
        }
        const x = action.normalizedX * Math.max(0, viewport.width - 1);
        const y = action.normalizedY * Math.max(0, viewport.height - 1);
        await page.mouse.click(x, y, { button: mapMouseButton(action.button), clickCount: action.clickCount ?? 1 });
        break;
      }
      case "mouseMove": {
        const viewport = page.viewportSize();
        if (viewport === null || viewport.width < 1 || viewport.height < 1) {
          throw new BrowserTakeoverConflictError("Browser page does not expose a bounded CSS viewport.");
        }
        await page.mouse.move(
          action.normalizedX * Math.max(0, viewport.width - 1),
          action.normalizedY * Math.max(0, viewport.height - 1)
        );
        break;
      }
      case "mouseDrag": {
        const viewport = page.viewportSize();
        if (viewport === null || viewport.width < 1 || viewport.height < 1) {
          throw new BrowserTakeoverConflictError("Browser page does not expose a bounded CSS viewport.");
        }
        const button = mapMouseButton(action.button);
        const startX = action.startNormalizedX * Math.max(0, viewport.width - 1);
        const startY = action.startNormalizedY * Math.max(0, viewport.height - 1);
        const endX = action.endNormalizedX * Math.max(0, viewport.width - 1);
        const endY = action.endNormalizedY * Math.max(0, viewport.height - 1);
        await page.mouse.move(startX, startY);
        await page.mouse.down({ button });
        try {
          await page.mouse.move(endX, endY, { steps: 10 });
        } finally {
          await page.mouse.up({ button });
        }
        break;
      }
      case "scroll":
        await page.mouse.wheel(action.deltaX, action.deltaY);
        break;
      case "keyPress":
        await page.keyboard.press(browserTakeoverChord(action.key, action.modifiers ?? []));
        break;
      case "textInput":
        await page.keyboard.insertText(action.text);
        break;
      case "navigate":
        this.#pageStates.set(page, "loading");
        await page.goto(validateTakeoverNavigationUrl(action.url), { waitUntil: "commit" });
        break;
      case "navigationCommand":
        switch (action.command) {
        case "back":
          this.#pageStates.set(page, "loading");
          if (await page.goBack({ waitUntil: "commit" }) === null) this.#pageStates.set(page, "ready");
          break;
        case "forward":
          this.#pageStates.set(page, "loading");
          if (await page.goForward({ waitUntil: "commit" }) === null) this.#pageStates.set(page, "ready");
          break;
        case "reload":
          this.#pageStates.set(page, "loading");
          await page.reload({ waitUntil: "commit" });
          break;
        case "stop":
          await page.evaluate("window.stop()");
          this.#pageStates.set(page, "ready");
          break;
        }
        break;
        }
      } catch (error) {
        if (navigation && !page.isClosed()) this.#pageStates.set(page, "ready");
        throw error;
      }
      await this.emit({
        at: Date.now(),
        type: navigation ? "navigation" : "action",
        pageId: fence.pageId,
        detail: navigation ? sanitizeBrowserUrlForDisplay(page.url()) : action.type
      });
    });
  }

  async listPages(): Promise<readonly BrowserPageState[]> {
    const context = this.requireContext();
    return Promise.all(context.pages().map((page) => this.pageState(page)));
  }

  createPage(lease: BrowserLeaseFence, url?: string, label?: string): Promise<BrowserPageState> {
    const fence = copyAgentFence(lease);
    return this.withAgentControl(fence, async () => {
      const page = await this.requireContext().newPage();
      if (url !== undefined) await page.goto(validateWebUrl(url), { waitUntil: "domcontentloaded" });
      if (label !== undefined) this.#pageLabels.set(page, validateBoundedString(label, "Browser page label", 256));
      return this.pageState(page);
    });
  }

  resolvePageId(targetId?: string, label?: string): string {
    if (targetId !== undefined) {
      const safeTargetId = validatePublicPageId(targetId);
      this.requirePageNow(safeTargetId);
      return safeTargetId;
    }
    if (label !== undefined) {
      const safeLabel = validateBoundedString(label, "Browser page label", 256);
      const page = this.requireContext().pages().find((candidate) => this.#pageLabels.get(candidate) === safeLabel);
      if (page === undefined) throw new Error(`Browser page label '${safeLabel}' does not exist.`);
      return this.idFor(page);
    }
    const page = this.requireContext().pages().at(-1);
    if (page === undefined) throw new Error("Browser has no open pages.");
    return this.idFor(page);
  }

  focusPage(pageId: string, lease: BrowserLeaseFence): Promise<BrowserPageState> {
    const fence = copyAgentFence(lease);
    const safePageId = validatePublicPageId(pageId);
    return this.withAgentControl(fence, async () => {
      const page = this.requirePageNow(safePageId);
      await page.bringToFront();
      return this.pageState(page);
    });
  }

  resolveElementSelector(pageId: string, input: BrowserElementTarget): string {
    const page = this.requirePageNow(validatePublicPageId(pageId));
    const selector = input.selector;
    if (selector !== undefined) return validateSelector(selector);
    if (input.ref !== undefined) {
      const ref = validateBoundedString(input.ref, "Browser snapshot reference", 256);
      const resolved = this.#snapshotRefs.get(page)?.get(ref);
      if (resolved === undefined) throw new Error("Browser snapshot reference is stale or unknown; take a new snapshot.");
      return resolved;
    }
    if (input.query !== undefined) return selectorFromElementQuery(input.query);
    throw new Error("Browser element action requires selector, ref, or query.");
  }

  closePage(pageId: string, lease: BrowserLeaseFence): Promise<void> {
    const fence = copyAgentFence(lease);
    return this.withAgentControl(fence, async () => {
      await this.requirePageNow(pageId).close();
    });
  }

  act(pageId: string, lease: BrowserLeaseFence, action: BrowserAction): Promise<BrowserPageState> {
    const fence = copyAgentFence(lease);
    let safeAction: BrowserAction;
    let safePageId: string;
    try {
      safeAction = validateAndCopyBrowserAction(action);
      safePageId = validatePublicPageId(pageId);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.withAgentControl(fence, async () => {
      const page = this.requirePageNow(safePageId);
      if (safeAction.type !== "navigate") assertBrowserPageContentReadable(page);
      switch (safeAction.type) {
      case "navigate":
        await page.goto(safeAction.url, { waitUntil: "domcontentloaded" });
        break;
      case "click":
        await page.locator(safeAction.selector).click({
          button: safeAction.button,
          ...(safeAction.doubleClick === true ? { clickCount: 2 } : {}),
          ...(safeAction.modifiers === undefined ? {} : { modifiers: [...safeAction.modifiers] })
        });
        break;
      case "doubleClick":
        await page.locator(safeAction.selector).dblclick();
        break;
      case "rightClick":
        await page.locator(safeAction.selector).click({ button: "right" });
        break;
      case "hover":
        await page.locator(safeAction.selector).hover();
        break;
      case "clickCoords":
        await page.mouse.click(safeAction.x, safeAction.y, {
          button: safeAction.button,
          clickCount: safeAction.doubleClick === true ? 2 : 1
        });
        break;
      case "drag":
        await page.locator(safeAction.sourceSelector).dragTo(page.locator(safeAction.targetSelector));
        break;
      case "type":
        if (safeAction.slowly === true) {
          await page.locator(safeAction.selector).fill("");
          await page.locator(safeAction.selector).pressSequentially(safeAction.text, { delay: safeAction.delayMs ?? 50 });
        } else {
          await page.locator(safeAction.selector).fill(safeAction.text);
        }
        if (safeAction.submit === true) await page.locator(safeAction.selector).press("Enter");
        break;
      case "fill":
        await page.locator(safeAction.selector).fill(safeAction.text);
        break;
      case "press":
        if (safeAction.selector === undefined) await page.keyboard.press(safeAction.key);
        else await page.locator(safeAction.selector).press(safeAction.key);
        break;
      case "hotkey":
        if (safeAction.selector === undefined) {
          await page.keyboard.press(browserActionChord(safeAction.key, safeAction.modifiers ?? []));
        } else {
          await page.locator(safeAction.selector).press(browserActionChord(safeAction.key, safeAction.modifiers ?? []));
        }
        break;
      case "scroll":
        await page.mouse.wheel(safeAction.deltaX, safeAction.deltaY);
        break;
      case "resize":
        await page.setViewportSize({ width: safeAction.width, height: safeAction.height });
        break;
      case "wait":
        if (safeAction.milliseconds !== undefined) await page.waitForTimeout(safeAction.milliseconds);
        if (safeAction.selector !== undefined) {
          await page.locator(safeAction.selector).waitFor({ state: "visible", timeout: safeAction.timeoutMs });
        }
        if (safeAction.url !== undefined) await page.waitForURL(safeAction.url, { timeout: safeAction.timeoutMs });
        if (safeAction.textGone !== undefined) {
          await page.getByText(safeAction.textGone, { exact: true }).waitFor({ state: "hidden", timeout: safeAction.timeoutMs });
        }
        if (safeAction.loadState !== undefined) {
          await page.waitForLoadState(safeAction.loadState, { timeout: safeAction.timeoutMs });
        }
        break;
      case "select":
        await page.locator(safeAction.selector).selectOption(safeAction.values ?? safeAction.value ?? []);
        break;
      case "upload":
        if (this.#options.canUpload?.() === false) {
          throw new Error("Browser uploads are disabled by the active host policy.");
        }
        await page.locator(safeAction.selector).setInputFiles(
          await Promise.all(safeAction.paths.map((path) => this.safeUploadPath(path)))
        );
        break;
      case "back":
        await page.goBack({ waitUntil: "domcontentloaded" });
        break;
      case "forward":
        await page.goForward({ waitUntil: "domcontentloaded" });
        break;
      case "reload":
        await page.reload({ waitUntil: "domcontentloaded" });
        break;
      }
      await this.emit({ at: Date.now(), type: "action", pageId: safePageId, detail: safeAction.type });
      return this.pageState(page);
    });
  }

  listDialogs(pageId: string, lease: BrowserLeaseFence): Promise<readonly BrowserDialogSnapshot[]> {
    const fence = copyAgentFence(lease);
    const safePageId = validatePublicPageId(pageId);
    return this.withAgentControl(fence, async () => {
      const page = this.requirePageNow(safePageId);
      return [...(this.#dialogs.get(page)?.entries() ?? [])].map(([id, dialog]) => ({
        id,
        pageId: safePageId,
        type: sanitizeDiagnosticLabel(dialog.type(), "dialog"),
        message: sanitizeConsoleMessageText(dialog.message()),
        defaultValue: sanitizeConsoleMessageText(dialog.defaultValue())
      }));
    });
  }

  handleDialog(
    pageId: string,
    lease: BrowserLeaseFence,
    input: { readonly dialogId?: string; readonly accept: boolean; readonly promptText?: string }
  ): Promise<void> {
    const fence = copyAgentFence(lease);
    const safePageId = validatePublicPageId(pageId);
    if (typeof input.accept !== "boolean") return Promise.reject(new TypeError("Browser dialog accept must be a boolean."));
    const promptText = input.promptText === undefined
      ? undefined
      : validateBoundedString(input.promptText, "Browser dialog prompt text", MAXIMUM_ACTION_TEXT_LENGTH, true);
    return this.withAgentControl(fence, async () => {
      const page = this.requirePageNow(safePageId);
      const dialogs = this.#dialogs.get(page);
      const id = input.dialogId === undefined
        ? dialogs === undefined ? undefined : [...dialogs.keys()].at(-1)
        : validateBoundedString(input.dialogId, "Browser dialog ID", 256);
      const dialog = id === undefined ? undefined : dialogs?.get(id);
      if (dialog === undefined || id === undefined) throw new Error("Browser dialog does not exist or is no longer pending.");
      if (input.accept) await dialog.accept(promptText);
      else await dialog.dismiss();
      dialogs?.delete(id);
    });
  }

  /** Captures image bytes only; no page metadata or local path is returned. */
  captureScreenshot(
    pageId: string,
    lease: BrowserLeaseFence,
    options: BrowserScreenshotOptions = {}
  ): Promise<Uint8Array> {
    const fence = copyAgentFence(lease);
    let fullPage: boolean;
    let selector: string | undefined;
    let type: "png" | "jpeg";
    let labels: boolean;
    let safePageId: string;
    try {
      fullPage = validateOptionalBoolean(options.fullPage, "fullPage") ?? false;
      selector = options.selector === undefined ? undefined : validateSelector(options.selector);
      type = options.type === undefined ? "png" : validateImageType(options.type);
      labels = validateOptionalBoolean(options.labels, "labels") ?? false;
      safePageId = validatePublicPageId(pageId);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.withAgentControl(fence, async () => {
      const page = this.requirePageNow(safePageId);
      assertBrowserPageContentReadable(page);
      if (labels) await installScreenshotLabels(page);
      try {
        const bytes = selector === undefined
          ? await page.screenshot({ type, animations: "disabled", caret: "hide", fullPage })
          : await page.locator(selector).screenshot({ type, animations: "disabled", caret: "hide" });
        return copyBoundedBytes(bytes, this.#maximumScreenshotBytes, "Browser screenshot");
      } finally {
        if (labels) await removeScreenshotLabels(page);
      }
    });
  }

  /** Renders a bounded PDF in memory without writing or disclosing a local path. */
  capturePdf(pageId: string, lease: BrowserLeaseFence): Promise<Uint8Array> {
    const fence = copyAgentFence(lease);
    let safePageId: string;
    try {
      safePageId = validatePublicPageId(pageId);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.withAgentControl(fence, async () => {
      const page = this.requirePageNow(safePageId);
      assertBrowserPageContentReadable(page);
      const bytes = await page.pdf({ printBackground: true, preferCSSPageSize: true });
      return copyBoundedBytes(bytes, this.#maximumPdfBytes, "Browser PDF");
    });
  }

  /** Reads only retained, sanitized console text; argument handles are never inspected. */
  readConsoleMessages(
    pageId: string,
    lease: BrowserLeaseFence,
    options: BrowserDiagnosticReadOptions = {}
  ): Promise<readonly BrowserConsoleMessageSnapshot[]> {
    const fence = copyAgentFence(lease);
    let limit: number;
    let safePageId: string;
    try {
      limit = validateDiagnosticReadLimit(options.limit, this.#maximumConsoleMessages);
      safePageId = validatePublicPageId(pageId);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.withAgentControl(fence, async () => {
      const page = this.requirePageNow(safePageId);
      assertBrowserPageContentReadable(page);
      const retained = this.#consoleMessages.get(page) ?? [];
      const filter = options.filter === undefined
        ? undefined
        : validateBoundedString(options.filter, "Browser console filter", 4_096, true);
      const level = options.level === undefined
        ? undefined
        : sanitizeDiagnosticLabel(options.level, "log");
      const selected = retained
        .filter((message) => (filter === undefined || message.text.includes(filter)) && (level === undefined || message.level === level))
        .slice(-limit)
        .map((message) => ({ ...message }));
      if (options.clear === true) retained.splice(0, retained.length);
      return selected;
    });
  }

  /** Reads HTTP(S)-only request metadata without headers, cookies, bodies, or response data. */
  readHttpRequestSummaries(
    pageId: string,
    lease: BrowserLeaseFence,
    options: BrowserDiagnosticReadOptions = {}
  ): Promise<readonly BrowserHttpRequestSummary[]> {
    const fence = copyAgentFence(lease);
    let limit: number;
    let safePageId: string;
    try {
      limit = validateDiagnosticReadLimit(options.limit, this.#maximumHttpRequestSummaries);
      safePageId = validatePublicPageId(pageId);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.withAgentControl(fence, async () => {
      const page = this.requirePageNow(safePageId);
      assertBrowserPageContentReadable(page);
      const retained = this.#httpRequestSummaries.get(page) ?? [];
      const filter = options.filter === undefined
        ? undefined
        : validateBoundedString(options.filter, "Browser request filter", 4_096, true);
      const selected = retained
        .filter((request) => filter === undefined || request.url.includes(filter))
        .slice(-limit)
        .map((request) => ({ ...request }));
      if (options.clear === true) retained.splice(0, retained.length);
      return selected;
    });
  }

  evaluatePage(
    pageId: string,
    lease: BrowserLeaseFence,
    source: string,
    timeoutMs = 10_000
  ): Promise<unknown> {
    const fence = copyAgentFence(lease);
    const safePageId = validatePublicPageId(pageId);
    const safeSource = validateEvaluateSource(source);
    const safeTimeout = validateIntegerInRange(timeoutMs, "Browser evaluate timeout", 1, MAXIMUM_WAIT_MILLISECONDS);
    return this.withAgentControl(fence, async () => {
      const page = this.requirePageNow(safePageId);
      assertBrowserPageContentReadable(page);
      const value = await withTimeout(page.evaluate(`(${safeSource})()`), safeTimeout, "Browser evaluate timed out.");
      return boundedModelValue(value);
    });
  }

  /** Executes only a function sourced from the immutable bundled recipe catalog. */
  evaluateBundledRecipe(
    pageId: string,
    lease: BrowserLeaseFence,
    source: string,
    timeoutMs = 10_000
  ): Promise<unknown> {
    const fence = copyAgentFence(lease);
    const safePageId = validatePublicPageId(pageId);
    const safeSource = validateBundledRecipeEvaluateSource(source);
    const safeTimeout = validateIntegerInRange(timeoutMs, "Browser recipe evaluate timeout", 1, MAXIMUM_WAIT_MILLISECONDS);
    return this.withAgentControl(fence, async () => {
      const page = this.requirePageNow(safePageId);
      assertBrowserPageContentReadable(page);
      const value = await withTimeout(page.evaluate(`(${safeSource})()`), safeTimeout, "Browser recipe evaluate timed out.");
      return boundedModelValue(value);
    });
  }

  extract(
    pageId: string,
    lease: BrowserLeaseFence,
    spec: BrowserExtractSpec,
    timeoutMs = 10_000,
    frame?: string
  ): Promise<BrowserExtractResult> {
    const fence = copyAgentFence(lease);
    const safePageId = validatePublicPageId(pageId);
    const safeSpec = validateExtractSpec(spec);
    const safeTimeout = validateIntegerInRange(timeoutMs, "Browser extract timeout", 1, MAXIMUM_WAIT_MILLISECONDS);
    const safeFrame = frame === undefined ? undefined : validateSelector(frame);
    return this.withAgentControl(fence, async () => {
      const page = this.requirePageNow(safePageId);
      assertBrowserPageContentReadable(page);
      const scope = safeFrame === undefined ? page.locator("html") : page.frameLocator(safeFrame).locator("html");
      const result = await withTimeout(scope.evaluate((documentRoot, input) => {
        const roots = input.from
          ? input.multiple
            ? [...documentRoot.querySelectorAll(input.from)]
            : [documentRoot.querySelector(input.from)].filter((item): item is Element => item !== null)
          : [documentRoot];
        const records = roots.slice(0, input.limit).map((root) => {
          const record: Record<string, string | null> = {};
          for (const [name, field] of Object.entries(input.fields)) {
            const element = field.selector === undefined ? root : root.querySelector(field.selector);
            if (element === null) {
              record[name] = null;
            } else if (field.type === "html") {
              record[name] = element.innerHTML;
            } else if (field.type === "href") {
              const value = element.getAttribute("href");
              record[name] = value === null ? null : new URL(value, documentRoot.ownerDocument.location.href).href;
            } else if (field.type === "attr") {
              record[name] = field.attr === undefined ? null : element.getAttribute(field.attr);
            } else {
              record[name] = (element.textContent ?? "").trim();
            }
          }
          return record;
        });
        return { ok: true as const, count: records.length, records };
      }, safeSpec), safeTimeout, "Browser extract timed out.");
      return boundedModelValue(result) as BrowserExtractResult;
    });
  }

  readResponseBody(
    pageId: string,
    lease: BrowserLeaseFence,
    pattern: string,
    maxChars = 50_000,
    timeoutMs = DEFAULT_RESPONSE_BODY_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<BrowserResponseBodySnapshot> {
    const fence = copyAgentFence(lease);
    const safePageId = validatePublicPageId(pageId);
    const safePattern = validateBoundedString(pattern, "Browser response URL pattern", 4_096);
    const safeMaxChars = validateIntegerInRange(maxChars, "Browser response character limit", 0, MAXIMUM_RESPONSE_BODY_CHARACTERS);
    const safeTimeout = validateIntegerInRange(timeoutMs, "Browser response timeout", 1, MAXIMUM_WAIT_MILLISECONDS);
    const generationSignal = this.#generationAbort.signal;
    return this.withAgentControl(fence, async () => {
      const page = this.requirePageNow(safePageId);
      assertBrowserPageContentReadable(page);
      const response = await waitForNextMatchingResponse(page, safePattern, safeTimeout, signal, generationSignal);
      const raw = await withTimeout(response.text(), safeTimeout, "Browser response body timed out.");
      const body = redactCredentialMaterial(raw.slice(0, safeMaxChars));
      return {
        url: sanitizeBrowserUrlForDisplay(response.url()),
        status: response.status(),
        mediaType: sanitizeMediaType(await response.headerValue("content-type")),
        body,
        truncated: raw.length > safeMaxChars
      };
    });
  }

  captureResource(
    pageId: string,
    lease: BrowserLeaseFence,
    value: string,
    maximumBytes = MAXIMUM_RESOURCE_BYTES
  ): Promise<BrowserResourceSnapshot> {
    const fence = copyAgentFence(lease);
    const safePageId = validatePublicPageId(pageId);
    const safeUrl = validatePublicResourceUrl(value);
    const safeMaximum = validateIntegerInRange(maximumBytes, "Browser resource byte limit", 1, MAXIMUM_RESOURCE_BYTES);
    return this.withAgentControl(fence, async () => {
      const page = this.requirePageNow(safePageId);
      assertBrowserPageContentReadable(page);
      const response = await page.context().request.get(safeUrl, { timeout: MAXIMUM_WAIT_MILLISECONDS });
      return resourceFromResponse(response, safeMaximum);
    });
  }

  snapshot(
    pageId: string,
    lease: BrowserLeaseFence,
    options: BrowserSnapshotOptions = {}
  ): Promise<BrowserSnapshot> {
    const fence = copyAgentFence(lease);
    const safePageId = validatePublicPageId(pageId);
    return this.withAgentControl(fence, async () => this.snapshotPage(this.requirePageNow(safePageId), safePageId, options));
  }

  snapshotHumanTakeover(
    takeover: BrowserTakeoverFence,
    options: BrowserSnapshotOptions = {}
  ): Promise<BrowserSnapshot> {
    const fence = copyTakeoverFence(takeover);
    return this.runHumanTakeoverOperation(fence, (page) => this.snapshotPage(page, fence.pageId, options));
  }

  private async snapshotPage(page: Page, pageId: string, options: BrowserSnapshotOptions): Promise<BrowserSnapshot> {
    assertBrowserPageContentReadable(page);
    const takeover = this.#takeovers.current();
    const requestedFullPage = validateOptionalBoolean(options.fullPage, "Browser snapshot fullPage") ?? false;
    const fullPage = takeover?.pageId === pageId && takeover.generation === this.#generation
      ? false
      : requestedFullPage;
    const selector = options.selector === undefined ? undefined : validateSelector(options.selector);
    const maxChars = options.maxChars === undefined
      ? MAXIMUM_SNAPSHOT_CHARACTERS
      : validateIntegerInRange(options.maxChars, "Browser snapshot character limit", 0, MAXIMUM_SNAPSHOT_CHARACTERS);
    const timeout = options.timeoutMs === undefined
      ? 10_000
      : validateIntegerInRange(options.timeoutMs, "Browser snapshot timeout", 1, MAXIMUM_WAIT_MILLISECONDS);
    const frame = options.frame === undefined ? undefined : validateSelector(options.frame);
    const scope = frame === undefined ? page : page.frameLocator(frame);
    const root = scope.locator(selector ?? "body");
    if (options.labels === true) await installScreenshotLabels(page);
    let state: BrowserPageState;
    let rawAria: string;
    let rawScreenshot: Uint8Array;
    try {
      [state, rawAria, rawScreenshot] = await Promise.all([
        this.pageState(page),
        root.ariaSnapshot({ timeout }).catch(() => ""),
        page.screenshot({ type: "png", animations: "disabled", fullPage })
      ]);
    } finally {
      if (options.labels === true) await removeScreenshotLabels(page);
    }
    const aria = this.withSnapshotRefs(page, rawAria, maxChars, options);
    const screenshot = copyBoundedBytes(rawScreenshot, this.#maximumScreenshotBytes, "Browser snapshot screenshot");
    return { page: state, aria, screenshot };
  }

  private bindPage(page: Page): void {
    const pageId = this.idFor(page);
    const generation = this.#generation;
    if (!this.#consoleMessages.has(page)) this.#consoleMessages.set(page, []);
    if (!this.#httpRequestSummaries.has(page)) this.#httpRequestSummaries.set(page, []);
    if (!this.#dialogs.has(page)) this.#dialogs.set(page, new Map());
    const fenceTakeover = () => {
      this.#takeovers.fencePage({ providerId: this.id, pageId, generation });
      if (this.#takeovers.current() === undefined) this.#takeoverRateWindow = undefined;
    };
    page.on("crash", () => {
      this.#pageStates.set(page, "crashed");
      fenceTakeover();
      void this.emit({ at: Date.now(), type: "crashed", pageId, detail: "Page crashed." });
    });
    page.on("close", () => {
      this.#pageStates.set(page, "closed");
      fenceTakeover();
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        this.#pageStates.set(page, "loading");
        this.fenceHumanCommentLedgerForNavigation(page);
      }
    });
    page.on("domcontentloaded", () => {
      this.#pageStates.set(page, "ready");
      void this.emit({
        at: Date.now(),
        type: "navigation",
        pageId,
        detail: sanitizeBrowserUrlForDisplay(page.url())
      });
    });
    page.on("console", (message) => {
      try {
        appendBoundedItem(this.#consoleMessages.get(page) ?? [], {
          sequence: this.#nextConsoleMessageSequence++,
          at: (this.#options.now ?? Date.now)(),
          level: sanitizeDiagnosticLabel(message.type(), "log"),
          text: sanitizeConsoleMessageText(message.text())
        }, this.#maximumConsoleMessages);
      } catch {
        // Diagnostics must never destabilize page control.
      }
    });
    page.on("request", (request) => {
      try {
        const url = sanitizeHttpRequestSummaryUrl(request.url());
        if (url === undefined) return;
        appendBoundedItem(this.#httpRequestSummaries.get(page) ?? [], {
          sequence: this.#nextHttpRequestSequence++,
          at: (this.#options.now ?? Date.now)(),
          method: sanitizeHttpMethod(request.method()),
          url,
          resourceType: sanitizeDiagnosticLabel(request.resourceType(), "other"),
          navigation: request.isNavigationRequest()
        }, this.#maximumHttpRequestSummaries);
      } catch {
        // Network summaries are best-effort and deliberately omit raw data.
      }
    });
    page.on("dialog", (dialog) => {
      const id = `dialog-${this.#nextDialogId++}`;
      this.#dialogs.get(page)?.set(id, dialog);
    });
    page.on("download", (download) => void this.handleDownload(pageId, generation, download).catch(() => undefined));
    void this.emit({ at: Date.now(), type: "page", pageId, detail: "Page opened." });
  }

  private withSnapshotRefs(
    page: Page,
    aria: string,
    maximumCharacters: number,
    options: BrowserSnapshotOptions
  ): string {
    const refs = new Map<string, string>();
    const occurrences = new Map<string, number>();
    const interactiveRoles = new Set([
      "button", "checkbox", "combobox", "link", "listbox", "menuitem", "option", "radio", "searchbox",
      "slider", "spinbutton", "switch", "tab", "textbox", "treeitem"
    ]);
    let next = 1;
    const lines = aria.split(/\r?\n/gu).filter((line) => {
      if (options.compact === true && line.trim() === "") return false;
      if (options.depth !== undefined) {
        const indentation = line.match(/^\s*/u)?.[0].length ?? 0;
        if (Math.floor(indentation / 2) > options.depth) return false;
      }
      if (options.interactive !== true) return true;
      const role = line.match(/^\s*-\s+([A-Za-z][A-Za-z0-9_-]*)/u)?.[1];
      return role !== undefined && interactiveRoles.has(role);
    }).map((line) => {
      const match = line.match(/^(\s*-\s+)([A-Za-z][A-Za-z0-9_-]*)(?:\s+"([^"]*)")?/u);
      if (match === null || next > 1_000) return line;
      const role = match[2] ?? "";
      const name = match[3];
      const base = name === undefined
        ? `role=${role}`
        : `role=${role}[name=${JSON.stringify(name)}]`;
      const index = occurrences.get(base) ?? 0;
      occurrences.set(base, index + 1);
      const ref = `r${next++}`;
      refs.set(ref, index === 0 ? base : `${base} >> nth=${index}`);
      return `${line} [ref=${ref}]`;
    });
    this.#snapshotRefs.set(page, refs);
    const value = lines.join("\n");
    return value.length <= maximumCharacters ? value : `${value.slice(0, Math.max(0, maximumCharacters - 1))}…`;
  }

  private async handleDownload(pageId: string, generation: number, download: Download): Promise<void> {
    if (generation !== this.#generation || this.#context === undefined) {
      await download.cancel().catch(() => undefined);
      return;
    }
    if (this.#options.canDownload?.() === false) {
      await download.cancel().catch(() => undefined);
      await this.emit({ at: Date.now(), type: "download", pageId, detail: "A browser download was blocked by host policy." });
      return;
    }
    let staged: StagedBrowserDownload | undefined;
    const handler = this.#downloadHandler;
    try {
      staged = await stageBrowserDownload(download, this.#options.downloadDirectory, this.#options.maximumDownloadBytes);
      if (generation !== this.#generation || this.#context === undefined) return;
      await handler?.(pageId, staged.verifiedLocalPath, staged.fileName);
      await this.emit({ at: Date.now(), type: "download", pageId, detail: "Browser download completed." });
    } catch {
      await this.emit({ at: Date.now(), type: "download", pageId, detail: "A browser download failed validation or ingest." });
    } finally {
      if (staged !== undefined) {
        await rm(staged.verifiedLocalPath, { force: true }).catch(() => undefined);
      }
    }
  }

  private idFor(page: Page): string {
    let id = this.#pageIds.get(page);
    if (id === undefined) {
      id = `page-${this.#generation}-${this.#nextPageId++}`;
      this.#pageIds.set(page, id);
    }
    return id;
  }

  private requirePageNow(pageId: string): Page {
    const page = this.requireContext().pages().find((candidate) => this.idFor(candidate) === pageId);
    if (page === undefined) throw new Error(`Browser page ${pageId} does not exist.`);
    return page;
  }

  private requireRequestedTakeoverPage(request: BrowserTakeoverRequest): Page {
    if (request.providerId !== this.id || request.generation !== this.#generation) {
      throw new BrowserTakeoverConflictError("Browser takeover request has a stale Provider or generation fence.");
    }
    return this.requirePageNow(request.pageId);
  }

  private withAgentControl<T>(fence: BrowserLeaseFence, operation: () => Promise<T>): Promise<T> {
    return this.queueLifecycle(async () => {
      if (fence.providerId !== this.id || fence.generation !== this.#generation || this.#takeovers.current() !== undefined) {
        throw new BrowserLeaseConflictError("Browser agent lease is missing, expired, or fenced.");
      }
      this.#leases.assert(fence);
      const result = await raceAgainstAbort(operation(), this.#generationAbort.signal);
      this.#leases.assert(fence);
      if (this.#takeovers.current() !== undefined) {
        throw new BrowserLeaseConflictError("Browser agent lease was fenced by human takeover.");
      }
      return result;
    });
  }

  private consumeTakeoverRate(takeoverId: string): void {
    const now = (this.#options.now ?? Date.now)();
    const current = this.#takeoverRateWindow;
    if (current === undefined || current.takeoverId !== takeoverId || now - current.startedAt >= 1_000) {
      this.#takeoverRateWindow = { takeoverId, startedAt: now, count: 1 };
      return;
    }
    if (current.count >= 30) throw new BrowserTakeoverRateLimitError();
    current.count += 1;
  }

  private requireContext(): BrowserContext {
    if (this.#context === undefined) throw new Error("Browser provider is not running.");
    return this.#context;
  }

  private async pageState(page: Page): Promise<BrowserPageState> {
    const navigation = await browserNavigationAvailability(page);
    const currentUrl = page.url();
    const contentReadable = browserPageContentIsReadable(currentUrl);
    return {
      id: this.idFor(page),
      url: sanitizeBrowserUrlForDisplay(currentUrl),
      title: contentReadable
        ? truncatePublicText(sanitizeConsoleMessageText(await page.title().catch(() => "")), MAXIMUM_PUBLIC_TITLE_LENGTH)
        : "",
      state: page.isClosed() ? "closed" : this.#pageStates.get(page) ?? "ready",
      canGoBack: navigation.canGoBack,
      canGoForward: navigation.canGoForward
    };
  }

  private async emit(activity: BrowserActivity): Promise<void> {
    await this.#options.onActivity?.(activity);
  }

  private async safeUploadPath(value: string): Promise<string> {
    const canonical = await realpath(value);
    const roots = await Promise.all(this.#options.uploadRoots.map((root) => realpath(root)));
    if (!roots.some((root) => isWithin(canonical, root))) {
      throw new Error("Upload path is outside the approved artifact and workspace roots.");
    }
    return canonical;
  }

  private queueLifecycle<T>(task: () => Promise<T>): Promise<T> {
    const epoch = this.#lifecycleEpoch;
    const invoke = (): Promise<T> => {
      if (epoch !== this.#lifecycleEpoch) {
        return Promise.reject(new BrowserLeaseConflictError("Browser operation was interrupted by recovery."));
      }
      return task();
    };
    const queued = this.#lifecycleTail.then(invoke, invoke);
    this.#lifecycleTail = queued.then(() => undefined, () => undefined);
    return queued;
  }
}

async function decorateManagedChromeProfile(userDataDirectory: string, value: string): Promise<void> {
  const displayName = validateProfileDisplayName(value);
  const localStatePath = join(userDataDirectory, "Local State");
  const preferencesPath = join(userDataDirectory, "Default", "Preferences");
  const [localState, preferences] = await Promise.all([
    readJsonObject(localStatePath),
    readJsonObject(preferencesPath)
  ]);
  setNested(localState, ["profile", "info_cache", "Default", "name"], displayName);
  setNested(localState, ["profile", "info_cache", "Default", "shortcut_name"], displayName);
  setNested(localState, ["profile", "info_cache", "Default", "user_name"], displayName);
  setNested(preferences, ["profile", "name"], displayName);
  await Promise.all([
    atomicWriteJson(localStatePath, localState),
    atomicWriteJson(preferencesPath, preferences)
  ]);
}

function validateProfileDisplayName(value: string): string {
  if (typeof value !== "string" || value !== value.trim() || value.length === 0 || [...value].length > 128
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError("Browser profile display name is invalid.");
  }
  return value;
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  let source: string;
  try { source = await readFile(path, "utf8"); }
  catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    throw error;
  }
  const value: unknown = JSON.parse(source);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Managed Chrome profile JSON root must be an object.");
  }
  return value as Record<string, unknown>;
}

function setNested(root: Record<string, unknown>, path: readonly string[], value: string): void {
  let current = root;
  for (const key of path.slice(0, -1)) {
    const nested = current[key];
    if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
      current = nested as Record<string, unknown>;
    } else {
      const replacement: Record<string, unknown> = {};
      current[key] = replacement;
      current = replacement;
    }
  }
  current[path.at(-1)!] = value;
}

async function atomicWriteJson(path: string, value: Readonly<Record<string, unknown>>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function validateAndCopyBrowserAction(action: BrowserAction): BrowserAction {
  if (typeof action !== "object" || action === null) throw new TypeError("Browser action must be an object.");
  switch (action.type) {
  case "navigate":
    return { type: action.type, url: validateWebUrl(action.url) };
  case "doubleClick":
  case "rightClick":
  case "hover":
    return { type: action.type, selector: validateSelector(action.selector) };
  case "click":
    return {
      type: action.type,
      selector: validateSelector(action.selector),
      ...(action.button === undefined ? {} : { button: validateMouseButton(action.button) }),
      ...(action.doubleClick === undefined ? {} : {
        doubleClick: validateOptionalBoolean(action.doubleClick, "Browser click doubleClick")
      }),
      ...(action.modifiers === undefined ? {} : { modifiers: validateBrowserActionModifiers(action.modifiers) })
    };
  case "clickCoords":
    return {
      type: action.type,
      x: validateBoundedNumber(action.x, "Browser click X coordinate", MAXIMUM_VIEWPORT_EDGE),
      y: validateBoundedNumber(action.y, "Browser click Y coordinate", MAXIMUM_VIEWPORT_EDGE),
      button: validateMouseButton(action.button),
      ...(action.doubleClick === undefined ? {} : {
        doubleClick: validateOptionalBoolean(action.doubleClick, "Browser coordinate doubleClick")
      })
    };
  case "drag":
    return {
      type: action.type,
      sourceSelector: validateSelector(action.sourceSelector),
      targetSelector: validateSelector(action.targetSelector)
    };
  case "type":
    if (action.submit !== undefined && typeof action.submit !== "boolean") {
      throw new TypeError("Browser type submit must be a boolean.");
    }
    return {
      type: action.type,
      selector: validateSelector(action.selector),
      text: validateBoundedString(action.text, "Browser action text", MAXIMUM_ACTION_TEXT_LENGTH, true),
      ...(action.submit === undefined ? {} : { submit: action.submit }),
      ...(action.slowly === undefined ? {} : { slowly: validateOptionalBoolean(action.slowly, "Browser type slowly") }),
      ...(action.delayMs === undefined ? {} : {
        delayMs: validateIntegerInRange(action.delayMs, "Browser type delay", 0, 5_000)
      })
    };
  case "fill":
    return {
      type: action.type,
      selector: validateSelector(action.selector),
      text: validateBoundedString(action.text, "Browser fill text", MAXIMUM_ACTION_TEXT_LENGTH, true)
    };
  case "press":
    return {
      type: action.type,
      key: validateBrowserActionKey(action.key),
      ...(action.selector === undefined ? {} : { selector: validateSelector(action.selector) })
    };
  case "hotkey":
    return {
      type: action.type,
      key: validateBrowserActionKey(action.key),
      modifiers: validateBrowserActionModifiers(action.modifiers),
      ...(action.selector === undefined ? {} : { selector: validateSelector(action.selector) })
    };
  case "scroll":
    return {
      type: action.type,
      deltaX: validateBoundedNumber(action.deltaX, "Browser horizontal scroll delta", MAXIMUM_SCROLL_DELTA),
      deltaY: validateBoundedNumber(action.deltaY, "Browser vertical scroll delta", MAXIMUM_SCROLL_DELTA)
    };
  case "resize":
    return {
      type: action.type,
      width: validateIntegerInRange(action.width, "Browser viewport width", 1, MAXIMUM_VIEWPORT_EDGE),
      height: validateIntegerInRange(action.height, "Browser viewport height", 1, MAXIMUM_VIEWPORT_EDGE)
    };
  case "wait":
    {
      const safe = {
      type: action.type,
      ...(action.milliseconds === undefined ? {} : {
        milliseconds: validateIntegerInRange(
          action.milliseconds,
          "Browser wait duration",
          0,
          MAXIMUM_WAIT_MILLISECONDS
        )
      }),
      ...(action.selector === undefined ? {} : { selector: validateSelector(action.selector) }),
      ...(action.url === undefined ? {} : { url: validateBoundedString(action.url, "Browser wait URL pattern", 8_192) }),
      ...(action.textGone === undefined ? {} : {
        textGone: validateBoundedString(action.textGone, "Browser wait text", MAXIMUM_ACTION_TEXT_LENGTH)
      }),
      ...(action.loadState === undefined ? {} : { loadState: validateLoadState(action.loadState) }),
      ...(action.timeoutMs === undefined ? {} : {
        timeoutMs: validateIntegerInRange(action.timeoutMs, "Browser wait timeout", 1, MAXIMUM_WAIT_MILLISECONDS)
      })
      } as const;
      if (Object.keys(safe).length === 1) throw new TypeError("Browser wait requires at least one condition.");
      return safe;
    }
  case "select":
    {
      const values = action.values ?? (action.value === undefined ? undefined : [action.value]);
      if (values === undefined || !Array.isArray(values) || values.length < 1 || values.length > 100) {
        throw new TypeError("Browser select requires one through 100 values.");
      }
      return {
      type: action.type,
      selector: validateSelector(action.selector),
      ...(action.value === undefined ? {} : {
        value: validateBoundedString(action.value, "Browser select value", MAXIMUM_ACTION_TEXT_LENGTH, true)
      }),
      ...(action.values === undefined ? {} : {
        values: values.map((value) => validateBoundedString(value, "Browser select value", MAXIMUM_ACTION_TEXT_LENGTH, true))
      })
      };
    }
  case "upload": {
    if (!Array.isArray(action.paths) || action.paths.length > MAXIMUM_UPLOAD_PATHS) {
      throw new RangeError(`Browser upload accepts at most ${MAXIMUM_UPLOAD_PATHS} paths.`);
    }
    return {
      type: action.type,
      selector: validateSelector(action.selector),
      paths: action.paths.map((path) => validateBoundedString(path, "Browser upload path", MAXIMUM_PATH_LENGTH))
    };
  }
  case "back":
  case "forward":
  case "reload":
    return { type: action.type };
  default:
    throw new TypeError("Browser action type is invalid.");
  }
}

function validateSelector(value: string): string {
  return validateBoundedString(value, "Browser selector", MAXIMUM_SELECTOR_LENGTH);
}

function validatePublicPageId(value: string): string {
  return validateBoundedString(value, "Browser page ID", MAXIMUM_PUBLIC_ID_LENGTH);
}

function waitForNextMatchingResponse(
  page: Page,
  pattern: string,
  timeoutMs: number,
  signal?: AbortSignal,
  generationSignal?: AbortSignal
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const signals = [...new Set([signal, generationSignal].filter((item): item is AbortSignal => item !== undefined))];
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      page.off("response", onResponse);
      page.off("close", onClose);
      for (const abortSignal of signals) abortSignal.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onResponse = (response: Response): void => {
      if (settled) return;
      try {
        validateWebUrl(response.url());
        if (!urlPatternMatches(response.url(), pattern)) return;
      } catch {
        return;
      }
      settled = true;
      cleanup();
      resolve(response);
    };
    const onClose = (): void => fail(new Error("Browser page closed while waiting for a response."));
    const onAbort = (): void => fail(abortSignalError(signals.find((abortSignal) => abortSignal.aborted)));

    const alreadyAborted = signals.find((abortSignal) => abortSignal.aborted);
    if (alreadyAborted !== undefined) {
      fail(abortSignalError(alreadyAborted));
      return;
    }
    page.on("response", onResponse);
    page.on("close", onClose);
    for (const abortSignal of signals) abortSignal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => fail(new Error("Browser response wait timed out.")), timeoutMs);
    if (page.isClosed()) onClose();
  });
}

function abortSignalError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error("Browser response wait was aborted.");
}

async function raceAgainstAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortSignalError(signal);
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortSignalError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, interrupted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function assertBrowserPageContentReadable(page: Page): void {
  if (!browserPageContentIsReadable(page.url())) {
    throw new Error("Browser page content is available only for HTTP(S) pages or a blank page.");
  }
}

function browserPageContentIsReadable(value: string): boolean {
  if (value === "about:blank") return true;
  try {
    validateWebUrl(value);
    return true;
  } catch {
    return false;
  }
}

function validateBoundedString(value: string, label: string, maximumLength: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.includes("\u0000") || value.length > maximumLength) {
    throw new RangeError(`${label} exceeds its safe bound.`);
  }
  if (!allowEmpty && value.trim() === "") throw new TypeError(`${label} must not be empty.`);
  return value;
}

function validateBrowserActionKey(value: string): string {
  const key = validateBoundedString(value, "Browser key", MAXIMUM_KEY_LENGTH);
  if (key.includes("+")) throw new TypeError("Browser key modifiers must be supplied separately.");
  return key;
}

function validateBrowserActionModifiers(value: readonly BrowserKeyModifier[] | undefined): readonly BrowserKeyModifier[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) throw new RangeError("Browser hotkey accepts at most four modifiers.");
  const accepted: readonly BrowserKeyModifier[] = ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"];
  const modifiers = value.map((modifier) => {
    if (!accepted.includes(modifier)) throw new TypeError("Browser hotkey modifier is invalid.");
    return modifier;
  });
  if (new Set(modifiers).size !== modifiers.length) throw new TypeError("Browser hotkey modifiers must be unique.");
  return modifiers;
}

function validateBoundedNumber(value: number, label: string, maximumMagnitude: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > maximumMagnitude) {
    throw new RangeError(`${label} exceeds its safe bound.`);
  }
  return value;
}

function validateIntegerInRange(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function validateOptionalBoolean(value: boolean | undefined, label: string): boolean | undefined {
  if (value !== undefined && typeof value !== "boolean") throw new TypeError(`${label} must be a boolean.`);
  return value;
}

function validateBrowserCommentInspection(input: BrowserCommentInspectionInput): BrowserCommentInspectionInput {
  if (input === null || typeof input !== "object") throw new TypeError("Browser comment inspection is invalid.");
  const markerNumber = validateIntegerInRange(input.markerNumber, "Browser comment marker number", 1, MAXIMUM_BROWSER_COMMENT_MARKER_NUMBER);
  if (input.intent === "existingText") return { intent: input.intent, markerNumber };
  if (input.intent === "element") {
    return {
      intent: input.intent,
      markerNumber,
      normalizedX: validateBrowserCommentRatio(input.normalizedX, "Browser comment X coordinate"),
      normalizedY: validateBrowserCommentRatio(input.normalizedY, "Browser comment Y coordinate")
    };
  }
  if (input.intent !== "region") throw new TypeError("Browser comment inspection intent is invalid.");
  return {
    intent: input.intent,
    markerNumber,
    normalizedPoint: {
      x: validateBrowserCommentRatio(input.normalizedPoint?.x, "Browser comment point X coordinate"),
      y: validateBrowserCommentRatio(input.normalizedPoint?.y, "Browser comment point Y coordinate")
    },
    normalizedRegion: {
      x: validateBrowserCommentRatio(input.normalizedRegion?.x, "Browser comment region X coordinate"),
      y: validateBrowserCommentRatio(input.normalizedRegion?.y, "Browser comment region Y coordinate"),
      width: validateBrowserCommentRatio(input.normalizedRegion?.width, "Browser comment region width"),
      height: validateBrowserCommentRatio(input.normalizedRegion?.height, "Browser comment region height")
    }
  };
}

function validateBrowserCommentDesignUpdate(input: BrowserCommentDesignUpdate): BrowserCommentDesignUpdate {
  if (input === null || typeof input !== "object") throw new TypeError("Browser comment design update is invalid.");
  switch (input.action) {
    case "apply": {
      const styles: Partial<Record<BrowserCommentDesignProperty, string>> = {};
      if (input.styles === null || typeof input.styles !== "object" || Array.isArray(input.styles)) {
        throw new TypeError("Browser comment preview styles are invalid.");
      }
      for (const [property, value] of Object.entries(input.styles)) {
        if (!isBrowserCommentDesignProperty(property)) throw new TypeError("Browser comment preview property is invalid.");
        styles[property] = validateBoundedString(value, "Browser comment preview value", 512);
      }
      const hasText = Object.prototype.hasOwnProperty.call(input, "text");
      return {
        action: input.action,
        targetToken: validateBoundedString(input.targetToken, "Browser comment target token", 128),
        styles,
        ...(hasText ? { text: validateBoundedString(input.text ?? "", "Browser comment preview text", MAXIMUM_BROWSER_COMMENT_TEXT, true) } : {})
      };
    }
    case "reset":
      return { action: input.action, targetToken: validateBoundedString(input.targetToken, "Browser comment target token", 128) };
    case "commit":
      return {
        action: input.action,
        targetToken: validateBoundedString(input.targetToken, "Browser comment target token", 128),
        markerNumber: validateIntegerInRange(input.markerNumber, "Browser comment marker number", 1, MAXIMUM_BROWSER_COMMENT_MARKER_NUMBER)
      };
    case "reconcile": {
      if (!Array.isArray(input.validMarkerNumbers)) throw new RangeError("Browser comment marker whitelist is invalid.");
      const validMarkerNumbers = [...new Set(input.validMarkerNumbers.map((value) => validateIntegerInRange(value, "Browser comment marker number", 1, MAXIMUM_BROWSER_COMMENT_MARKER_NUMBER)))];
      return { action: input.action, validMarkerNumbers };
    }
    case "resetAll":
      return { action: input.action };
    default:
      throw new TypeError("Browser comment design action is invalid.");
  }
}

function validateBrowserCommentRatio(value: number | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${label} must be a finite normalized coordinate.`);
  }
  return value;
}

function isBrowserCommentDesignProperty(value: string): value is BrowserCommentDesignProperty {
  return (BROWSER_COMMENT_DESIGN_PROPERTIES as readonly string[]).includes(value);
}

interface RawBrowserCommentInspectionResult {
  readonly target: BrowserCommentTarget;
  readonly privatePlacement: {
    readonly documentPoint: { readonly x: number; readonly y: number };
    readonly documentRegion?: BrowserCommentRegion;
    readonly documentTextRegions?: readonly BrowserCommentRegion[];
  };
  readonly privateElement?: {
    readonly elementId: string;
    readonly originalStyles: Record<BrowserCommentDesignProperty, BrowserCommentInlineStyle>;
    readonly originalText?: string;
  };
}

async function inspectBrowserCommentTargetOnPage(
  page: Page,
  inspection: BrowserCommentInspectionInput,
  suggestedElementId: string,
  knownElementIds: readonly string[]
): Promise<RawBrowserCommentInspectionResult | undefined> {
  const raw = await page.evaluate(({ request, attribute, designProperties, elementId, knownIds }) => {
    const maximumEvidence = 2_048;
    const normalizeText = (value: string | null | undefined, maximum = maximumEvidence): string | undefined => {
      const normalized = (value ?? "").replace(/\s+/gu, " ").trim().slice(0, maximum);
      return normalized.length === 0 ? undefined : normalized;
    };
    const clamp = (value: number, maximum: number): number => Math.max(0, Math.min(maximum, value));
    const viewport = { width: Math.max(1, window.innerWidth), height: Math.max(1, window.innerHeight) };
    const documentScroll = {
      x: Number.isFinite(window.scrollX) ? window.scrollX : 0,
      y: Number.isFinite(window.scrollY) ? window.scrollY : 0
    };
    const cssEscape = (value: string): string => globalThis.CSS?.escape?.(value) ?? value.replace(/[^a-zA-Z0-9_-]/gu, (character) => `\\${character}`);
    const segment = (element: Element): string => {
      const tag = element.tagName.toLowerCase();
      const classes = [...element.classList]
        .filter((value) => /^[a-z_-][a-z\d_-]{0,63}$/iu.test(value))
        .slice(0, 2)
        .map((value) => `.${cssEscape(value)}`)
        .join("");
      const parent = element.parentElement;
      if (parent === null) return tag + classes;
      const siblings = [...parent.children].filter((candidate) => candidate.tagName === element.tagName);
      return tag + classes + (siblings.length <= 1 ? "" : `:nth-of-type(${siblings.indexOf(element) + 1})`);
    };
    const selector = (element: Element): string | undefined => {
      const id = element.getAttribute("id");
      if (id !== null && id.length > 0 && id.length <= 256) {
        const candidate = `#${cssEscape(id)}`;
        try { if (document.querySelectorAll(candidate).length === 1) return candidate; } catch { /* Ignore invalid page identifiers. */ }
      }
      const parts: string[] = [];
      let current: Element | null = element;
      for (let depth = 0; current !== null && depth < 7; depth += 1) {
        parts.unshift(segment(current));
        const candidate = parts.join(" > ");
        try { if (document.querySelectorAll(candidate).length === 1) return candidate.slice(0, 1_024); } catch { /* Ignore invalid page classes. */ }
        current = current.parentElement;
      }
      return parts.length === 0 ? undefined : parts.join(" > ").slice(0, 1_024);
    };
    const path = (element: Element): string | undefined => {
      const parts: string[] = [];
      let current: Element | null = element;
      for (let depth = 0; current !== null && depth < 9; depth += 1) {
        parts.unshift(segment(current));
        current = current.parentElement;
      }
      return parts.length === 0 ? undefined : parts.join(" > ").slice(0, maximumEvidence);
    };
    const label = (element: HTMLElement): string | undefined => {
      const direct = normalizeText(element.getAttribute("aria-label"), 512);
      if (direct !== undefined) return direct;
      const labelledBy = normalizeText(element.getAttribute("aria-labelledby"), 512);
      if (labelledBy !== undefined) {
        const joined = labelledBy.split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
        const normalized = normalizeText(joined, 512);
        if (normalized !== undefined) return normalized;
      }
      if (element instanceof HTMLImageElement) return normalizeText(element.alt || element.title, 512);
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        const fromLabels = normalizeText([...element.labels ?? []].map((item) => item.textContent ?? "").join(" "), 512);
        if (fromLabels !== undefined) return fromLabels;
        return normalizeText(element.placeholder || (element instanceof HTMLInputElement && ["button", "submit", "reset"].includes(element.type) ? element.value : ""), 512);
      }
      return normalizeText(element.getAttribute("title") || element.innerText || element.textContent, 512);
    };
    const role = (element: HTMLElement): string | undefined => {
      const explicit = normalizeText(element.getAttribute("role"), 80)?.split(" ")[0];
      if (explicit !== undefined) return explicit.toLowerCase();
      const tag = element.tagName.toLowerCase();
      if (tag === "button") return "button";
      if (tag === "a" && element.hasAttribute("href")) return "link";
      if (tag === "img") return "img";
      if (/^h[1-6]$/u.test(tag)) return "heading";
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      if (tag === "input") {
        const type = (element.getAttribute("type") ?? "text").toLowerCase();
        if (["button", "submit", "reset"].includes(type)) return "button";
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "range") return "slider";
        if (type !== "hidden") return "textbox";
      }
      return undefined;
    };
    const nearby = (element: HTMLElement): string | undefined => {
      let current: HTMLElement | null = element;
      for (let depth = 0; current !== null && depth < 5; depth += 1) {
        const text = normalizeText(current.innerText, 1_024);
        if (text !== undefined && text !== normalizeText(element.innerText, 1_024)) return text;
        current = current.parentElement;
      }
      return normalizeText(element.innerText, 1_024);
    };
    const theme = (element?: Element): "light" | "dark" | undefined => {
      const candidates: Element[] = [];
      let current: Element | null = element ?? null;
      while (current !== null && candidates.length < 8) { candidates.push(current); current = current.parentElement; }
      if (document.body !== null) candidates.push(document.body);
      candidates.push(document.documentElement);
      for (const candidate of candidates) {
        const match = getComputedStyle(candidate).backgroundColor.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)(?:\D+(\d*(?:\.\d+)?))?\s*\)$/u);
        if (match === null || (match[4] !== undefined && Number(match[4]) < 0.05)) continue;
        const channels = [Number(match[1]), Number(match[2]), Number(match[3])].map((value) => {
          const normalized = value / 255;
          return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]! < 0.42 ? "dark" : "light";
      }
      return matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    };
    const provenance = (element: HTMLElement): Record<string, string> => {
      const output: Record<string, string> = {};
      let visited = 0;
      const visit = (rules: CSSRuleList, href: string): void => {
        for (const rule of [...rules]) {
          if (visited++ >= 5_000) return;
          const candidate = rule as CSSRule & { selectorText?: string; style?: CSSStyleDeclaration; cssRules?: CSSRuleList };
          if (candidate.selectorText !== undefined && candidate.style !== undefined) {
            let matches = false;
            try { matches = element.matches(candidate.selectorText); } catch { /* Ignore unsupported selectors. */ }
            if (matches) {
              for (const property of designProperties) {
                if (candidate.style.getPropertyValue(property).length > 0) output[property] = `selector ${candidate.selectorText}${href.length > 0 ? `, ${href}` : ""}`.slice(0, maximumEvidence);
              }
            }
          }
          if (candidate.cssRules !== undefined) visit(candidate.cssRules, href);
        }
      };
      for (const sheet of [...document.styleSheets]) {
        try { visit(sheet.cssRules, sheet.href ?? ""); } catch { /* Cross-origin stylesheets are intentionally skipped. */ }
        if (visited >= 5_000) break;
      }
      return output;
    };
    const targetEvidence = (element: HTMLElement) => ({
      targetTag: element.tagName.toLowerCase().slice(0, 64),
      targetLabel: label(element),
      targetRole: role(element),
      targetSelector: selector(element),
      targetPath: path(element),
      nearbyText: nearby(element)
    });

    if (request.intent === "existingText") {
      const selection = window.getSelection();
      if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return undefined;
      const selectedText = normalizeText(selection.toString(), 2_000);
      if (selectedText === undefined) return undefined;
      const range = selection.getRangeAt(0);
      const rectangles = [...range.getClientRects()].filter((rect) => rect.width > 1 && rect.height > 1).slice(0, 50);
      const last = rectangles.at(-1) ?? range.getBoundingClientRect();
      const common = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer as Element
        : range.commonAncestorContainer.parentElement;
      const htmlElement = common instanceof HTMLElement ? common : common?.parentElement;
      return {
        documentScroll,
        target: {
          kind: "text",
          point: { x: clamp(last.right + 4, Math.max(0, viewport.width - 4)), y: clamp(last.top + last.height / 2, viewport.height) },
          viewport,
          selectedText,
          textRegions: rectangles.map((rect) => ({ x: clamp(rect.x, viewport.width), y: clamp(rect.y, viewport.height), width: clamp(rect.width, viewport.width), height: clamp(rect.height, viewport.height) })),
          ...(htmlElement === undefined || htmlElement === null ? {} : targetEvidence(htmlElement)),
          themeVariant: theme(htmlElement ?? undefined)
        }
      };
    }

    if (request.intent === "region") {
      const region = {
        x: request.normalizedRegion.x * viewport.width,
        y: request.normalizedRegion.y * viewport.height,
        width: request.normalizedRegion.width * viewport.width,
        height: request.normalizedRegion.height * viewport.height
      };
      return {
        documentScroll,
        target: {
          kind: "region",
          point: { x: request.normalizedPoint.x * viewport.width, y: request.normalizedPoint.y * viewport.height },
          viewport,
          region,
          themeVariant: theme()
        }
      };
    }

    const x = request.normalizedX * Math.max(0, viewport.width - 1);
    const y = request.normalizedY * Math.max(0, viewport.height - 1);
    const found = document.elementFromPoint(x, y);
    const element = found instanceof HTMLElement ? found : found?.parentElement;
    if (element === undefined || element === null) return undefined;
    const existingId = element.getAttribute(attribute);
    const reusable = existingId !== null && knownIds.includes(existingId)
      && document.querySelectorAll(`[${attribute}="${cssEscape(existingId)}"]`).length === 1;
    const resolvedElementId = reusable ? existingId : elementId;
    element.setAttribute(attribute, resolvedElementId);
    const computed = getComputedStyle(element);
    const styles = Object.fromEntries(designProperties.map((property) => [property, computed.getPropertyValue(property).trim().slice(0, 512)]));
    const originalStyles = Object.fromEntries(designProperties.map((property) => [property, {
      value: element.style.getPropertyValue(property).slice(0, 512),
      priority: element.style.getPropertyPriority(property).slice(0, 32)
    }]));
    const editableText = element.childElementCount === 0 ? (element.textContent ?? "").slice(0, 8_000) : undefined;
    return {
      documentScroll,
      target: {
        kind: "element",
        point: { x, y },
        viewport,
        ...targetEvidence(element),
        themeVariant: theme(element),
        designBaseline: { styles, ...(editableText === undefined ? {} : { editableText }), provenance: provenance(element) }
      },
      privateElement: {
        elementId: resolvedElementId,
        originalStyles,
        ...(editableText === undefined ? {} : { originalText: editableText })
      }
    };
  }, {
    request: inspection,
    attribute: BROWSER_COMMENT_ELEMENT_ATTRIBUTE,
    designProperties: BROWSER_COMMENT_DESIGN_PROPERTIES,
    elementId: suggestedElementId,
    knownIds: knownElementIds
  });
  return normalizeRawBrowserCommentInspection(raw);
}

function normalizeRawBrowserCommentInspection(value: unknown): RawBrowserCommentInspectionResult | undefined {
  if (!isUnknownRecord(value) || !isUnknownRecord(value["target"])) return undefined;
  const rawTarget = value["target"];
  const kind = rawTarget["kind"];
  if (kind !== "element" && kind !== "region" && kind !== "text") return undefined;
  const viewport = normalizeBrowserCommentSize(rawTarget["viewport"]);
  const point = normalizeBrowserCommentPoint(rawTarget["point"], viewport);
  if (viewport === undefined || point === undefined) return undefined;
  const documentScroll = normalizeBrowserCommentDocumentScroll(value["documentScroll"]);
  if (documentScroll === undefined) return undefined;
  const region = normalizeBrowserCommentRegion(rawTarget["region"], viewport);
  const textRegions = Array.isArray(rawTarget["textRegions"])
    ? rawTarget["textRegions"].slice(0, 50).map((candidate) => normalizeBrowserCommentRegion(candidate, viewport)).filter((candidate): candidate is BrowserCommentRegion => candidate !== undefined)
    : [];
  const selectedText = boundedBrowserCommentEvidence(rawTarget["selectedText"], 2_000);
  if (kind === "region" && region === undefined) return undefined;
  if (kind === "text" && selectedText === undefined) return undefined;
  const designBaseline = kind === "element" ? normalizeBrowserCommentBaseline(rawTarget["designBaseline"]) : undefined;
  const target: BrowserCommentTarget = {
    kind,
    point,
    viewport,
    ...(region === undefined ? {} : { region }),
    ...(textRegions.length === 0 ? {} : { textRegions }),
    ...(selectedText === undefined ? {} : { selectedText }),
    ...optionalBrowserCommentEvidence("targetTag", rawTarget["targetTag"], 64, true),
    ...optionalBrowserCommentEvidence("targetLabel", rawTarget["targetLabel"], 512),
    ...optionalBrowserCommentEvidence("targetRole", rawTarget["targetRole"], 80, true),
    ...optionalBrowserCommentEvidence("targetSelector", rawTarget["targetSelector"], 1_024),
    ...optionalBrowserCommentEvidence("targetPath", rawTarget["targetPath"], MAXIMUM_BROWSER_COMMENT_EVIDENCE),
    ...optionalBrowserCommentEvidence("nearbyText", rawTarget["nearbyText"], 1_024),
    ...(rawTarget["themeVariant"] === "light" || rawTarget["themeVariant"] === "dark" ? { themeVariant: rawTarget["themeVariant"] } : {}),
    ...(designBaseline === undefined ? {} : { designBaseline })
  };
  const privatePlacement = {
    documentPoint: { x: point.x + documentScroll.x, y: point.y + documentScroll.y },
    ...(region === undefined ? {} : {
      documentRegion: { x: region.x + documentScroll.x, y: region.y + documentScroll.y, width: region.width, height: region.height }
    }),
    ...(textRegions.length === 0 ? {} : {
      documentTextRegions: textRegions.map((candidate) => ({
        x: candidate.x + documentScroll.x,
        y: candidate.y + documentScroll.y,
        width: candidate.width,
        height: candidate.height
      }))
    })
  };
  if (kind !== "element" || designBaseline === undefined || !isUnknownRecord(value["privateElement"])) return { target, privatePlacement };
  const privateElement = value["privateElement"];
  const elementId = typeof privateElement["elementId"] === "string" && /^[\da-f-]{36}$/iu.test(privateElement["elementId"])
    ? privateElement["elementId"]
    : undefined;
  const originalStyles = normalizeBrowserCommentOriginalStyles(privateElement["originalStyles"]);
  if (elementId === undefined || originalStyles === undefined) return { target: { ...target, designBaseline: undefined }, privatePlacement };
  const originalText = typeof privateElement["originalText"] === "string" ? privateElement["originalText"].slice(0, MAXIMUM_BROWSER_COMMENT_TEXT) : undefined;
  return { target, privatePlacement, privateElement: { elementId, originalStyles, ...(originalText === undefined ? {} : { originalText }) } };
}

function normalizeBrowserCommentDocumentScroll(value: unknown): { readonly x: number; readonly y: number } | undefined {
  if (!isUnknownRecord(value)) return undefined;
  const x = value["x"];
  const y = value["y"];
  const maximumDocumentOffset = 1_000_000_000;
  return typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)
    && Math.abs(x) <= maximumDocumentOffset && Math.abs(y) <= maximumDocumentOffset
    ? { x, y }
    : undefined;
}

function normalizeBrowserCommentBaseline(value: unknown): BrowserCommentDesignBaseline | undefined {
  if (!isUnknownRecord(value) || !isUnknownRecord(value["styles"]) || !isUnknownRecord(value["provenance"])) return undefined;
  const styles = {} as Record<BrowserCommentDesignProperty, string>;
  const provenance: Partial<Record<BrowserCommentDesignProperty, string>> = {};
  for (const property of BROWSER_COMMENT_DESIGN_PROPERTIES) {
    const style = boundedBrowserCommentEvidence(value["styles"][property], 512, false);
    if (style === undefined) return undefined;
    styles[property] = style;
    const source = boundedBrowserCommentEvidence(value["provenance"][property], MAXIMUM_BROWSER_COMMENT_EVIDENCE);
    if (source !== undefined) provenance[property] = source;
  }
  const editableText = typeof value["editableText"] === "string" ? sanitizeBrowserCommentEvidence(value["editableText"].slice(0, MAXIMUM_BROWSER_COMMENT_TEXT)) : undefined;
  return { styles, provenance, ...(editableText === undefined ? {} : { editableText }) };
}

function normalizeBrowserCommentOriginalStyles(value: unknown): Record<BrowserCommentDesignProperty, BrowserCommentInlineStyle> | undefined {
  if (!isUnknownRecord(value)) return undefined;
  const result = {} as Record<BrowserCommentDesignProperty, BrowserCommentInlineStyle>;
  for (const property of BROWSER_COMMENT_DESIGN_PROPERTIES) {
    const raw = value[property];
    if (!isUnknownRecord(raw) || typeof raw["value"] !== "string" || typeof raw["priority"] !== "string") return undefined;
    result[property] = { value: raw["value"].slice(0, 512), priority: raw["priority"].slice(0, 32) };
  }
  return result;
}

function normalizeBrowserCommentPoint(value: unknown, viewport?: { readonly width: number; readonly height: number }): { readonly x: number; readonly y: number } | undefined {
  if (!isUnknownRecord(value) || viewport === undefined) return undefined;
  const x = value["x"];
  const y = value["y"];
  return typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x <= viewport.width && y <= viewport.height
    ? { x, y }
    : undefined;
}

function normalizeBrowserCommentSize(value: unknown): { readonly width: number; readonly height: number } | undefined {
  if (!isUnknownRecord(value)) return undefined;
  const width = value["width"];
  const height = value["height"];
  return typeof width === "number" && typeof height === "number" && Number.isFinite(width) && Number.isFinite(height) && width >= 1 && height >= 1 && width <= MAXIMUM_VIEWPORT_EDGE && height <= MAXIMUM_VIEWPORT_EDGE
    ? { width, height }
    : undefined;
}

function normalizeBrowserCommentRegion(value: unknown, viewport?: { readonly width: number; readonly height: number }): BrowserCommentRegion | undefined {
  if (!isUnknownRecord(value) || viewport === undefined) return undefined;
  const x = value["x"];
  const y = value["y"];
  const width = value["width"];
  const height = value["height"];
  if (![x, y, width, height].every((item) => typeof item === "number" && Number.isFinite(item))) return undefined;
  if ((x as number) < 0 || (y as number) < 0 || (width as number) <= 0 || (height as number) <= 0 || (x as number) > viewport.width || (y as number) > viewport.height) return undefined;
  return { x: x as number, y: y as number, width: Math.min(width as number, viewport.width - (x as number)), height: Math.min(height as number, viewport.height - (y as number)) };
}

function optionalBrowserCommentEvidence<Key extends string>(key: Key, value: unknown, maximum: number, lowercase = false): { readonly [Property in Key]?: string } {
  const bounded = boundedBrowserCommentEvidence(value, maximum);
  return bounded === undefined ? {} : { [key]: lowercase ? bounded.toLowerCase() : bounded } as { readonly [Property in Key]?: string };
}

function boundedBrowserCommentEvidence(value: unknown, maximum: number, normalizeWhitespace = true): string | undefined {
  if (typeof value !== "string") return undefined;
  const bounded = (normalizeWhitespace ? value.replace(/\s+/gu, " ").trim() : value.trim()).slice(0, maximum);
  return bounded.length === 0 ? undefined : sanitizeBrowserCommentEvidence(bounded);
}

function sanitizeBrowserCommentEvidence(value: string): string {
  let safe = value.replaceAll("\u0000", "");
  safe = safe.replace(/https?:\/\/[^\s<>"']+/giu, (candidate) => sanitizeBrowserUrlForDisplay(candidate));
  safe = safe.replace(/\b(?:access[_-]?token|api[_-]?key|authorization|bearer|credential|password|secret|session[_-]?token)\s*[:=]\s*[^\s,;]+/giu, (match) => `${match.split(/[:=]/u, 1)[0]}=[redacted]`);
  return safe;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireBrowserCommentDesignRecord(
  records: Map<string, BrowserCommentDesignRecord>,
  token: string,
  allowCommitted = true
): BrowserCommentDesignRecord {
  const record = records.get(token);
  if (record === undefined || (!allowCommitted && !record.pending)) {
    throw new BrowserTakeoverConflictError("Browser comment target is missing, committed, or fenced.");
  }
  return record;
}

function requireBrowserCommentElementDesignRecord(
  records: Map<string, BrowserCommentDesignRecord>,
  token: string,
  allowCommitted = true
): BrowserCommentElementDesignRecord {
  const record = requireBrowserCommentDesignRecord(records, token, allowCommitted);
  if (record.elementId === undefined || record.originalStyles === undefined) {
    throw new BrowserTakeoverConflictError("Browser comment target does not expose an editable element design baseline.");
  }
  return record as BrowserCommentElementDesignRecord;
}

function isBrowserCommentElementDesignRecord(record: BrowserCommentDesignRecord): record is BrowserCommentElementDesignRecord {
  return record.elementId !== undefined && record.originalStyles !== undefined;
}

async function applyBrowserCommentDesignRecord(page: Page, record: BrowserCommentElementDesignRecord): Promise<void> {
  const applied = await page.evaluate(({ attribute, elementId, originals, hasText, originalText, preview }) => {
    const escape = (value: string): string => globalThis.CSS?.escape?.(value) ?? value.replace(/[^a-zA-Z0-9_-]/gu, (character) => `\\${character}`);
    const elements = document.querySelectorAll<HTMLElement>(`[${attribute}="${escape(elementId)}"]`);
    if (elements.length !== 1) return false;
    const element = elements[0]!;
    for (const [property, original] of Object.entries(originals)) {
      if (original.value.length === 0) element.style.removeProperty(property);
      else element.style.setProperty(property, original.value, original.priority);
    }
    if (hasText) element.textContent = originalText ?? "";
    for (const [property, value] of Object.entries(preview.styles)) element.style.setProperty(property, value, "important");
    if (Object.prototype.hasOwnProperty.call(preview, "text")) element.textContent = preview.text ?? "";
    return element.isConnected;
  }, {
    attribute: BROWSER_COMMENT_ELEMENT_ATTRIBUTE,
    elementId: record.elementId,
    originals: record.originalStyles,
    hasText: record.originalText !== undefined,
    originalText: record.originalText,
    preview: record.preview
  });
  if (!applied) throw new BrowserTakeoverConflictError("Browser comment target is no longer attached to this page.");
}

async function restoreBrowserCommentDesignRecord(page: Page, record: BrowserCommentElementDesignRecord): Promise<void> {
  await page.evaluate(({ attribute, elementId, originals, hasText, originalText }) => {
    const escape = (value: string): string => globalThis.CSS?.escape?.(value) ?? value.replace(/[^a-zA-Z0-9_-]/gu, (character) => `\\${character}`);
    const elements = document.querySelectorAll<HTMLElement>(`[${attribute}="${escape(elementId)}"]`);
    if (elements.length !== 1) return;
    const element = elements[0]!;
    for (const [property, original] of Object.entries(originals)) {
      if (original.value.length === 0) element.style.removeProperty(property);
      else element.style.setProperty(property, original.value, original.priority);
    }
    if (hasText) element.textContent = originalText ?? "";
  }, {
    attribute: BROWSER_COMMENT_ELEMENT_ATTRIBUTE,
    elementId: record.elementId,
    originals: record.originalStyles,
    hasText: record.originalText !== undefined,
    originalText: record.originalText
  }).catch(() => undefined);
}

async function resetAllBrowserCommentDesignRecords(page: Page, records: Map<string, BrowserCommentDesignRecord>): Promise<void> {
  for (const record of [...records.values()].sort((left, right) => right.sequence - left.sequence)) {
    if (isBrowserCommentElementDesignRecord(record)) await restoreBrowserCommentDesignRecord(page, record);
  }
  records.clear();
  await page.evaluate((attribute) => document.querySelectorAll(`[${attribute}]`).forEach((element) => element.removeAttribute(attribute)), BROWSER_COMMENT_ELEMENT_ATTRIBUTE).catch(() => undefined);
}

async function reconcileBrowserCommentDesignRecords(page: Page, records: Map<string, BrowserCommentDesignRecord>, validMarkers: ReadonlySet<number>): Promise<void> {
  const ordered = [...records.values()].sort((left, right) => left.sequence - right.sequence);
  const attachedElementIds = await liveBrowserCommentElementIds(page, ordered);
  const invalid = ordered.filter((record) =>
    (!record.pending && !validMarkers.has(record.markerNumber))
    || (record.elementId !== undefined && !attachedElementIds.has(record.elementId))
  );
  repairBrowserCommentDesignChains(ordered, invalid);
  for (const record of [...ordered].reverse()) {
    if (isBrowserCommentElementDesignRecord(record)) await restoreBrowserCommentDesignRecord(page, record);
  }
  for (const record of invalid) records.delete(record.token);
  for (const record of [...records.values()].sort((left, right) => left.sequence - right.sequence)) {
    if (isBrowserCommentElementDesignRecord(record)
      && (Object.keys(record.preview.styles).length > 0 || Object.prototype.hasOwnProperty.call(record.preview, "text"))) {
      await applyBrowserCommentDesignRecord(page, record);
    }
  }
  const liveIds = new Set([...records.values()].flatMap((record) => record.elementId === undefined ? [] : [record.elementId]));
  await page.evaluate(({ attribute, ids }) => document.querySelectorAll(`[${attribute}]`).forEach((element) => {
    if (!ids.includes(element.getAttribute(attribute) ?? "")) element.removeAttribute(attribute);
  }), { attribute: BROWSER_COMMENT_ELEMENT_ATTRIBUTE, ids: [...liveIds] }).catch(() => undefined);
  // Let layout and paint settle before the caller captures the annotated page.
  // Two frames match the page-comment screenshot fence and prevent a stale
  // pre-preview frame from being accepted as the saved evidence.
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

async function removeBrowserCommentDesignRecord(
  page: Page,
  records: Map<string, BrowserCommentDesignRecord>,
  removed: BrowserCommentDesignRecord
): Promise<void> {
  const ordered = [...records.values()].sort((left, right) => left.sequence - right.sequence);
  repairBrowserCommentDesignChains(ordered, [removed]);
  for (const record of [...ordered].reverse()) {
    if (isBrowserCommentElementDesignRecord(record)) await restoreBrowserCommentDesignRecord(page, record);
  }
  records.delete(removed.token);
  for (const record of [...records.values()].sort((left, right) => left.sequence - right.sequence)) {
    if (isBrowserCommentElementDesignRecord(record)
      && (Object.keys(record.preview.styles).length > 0 || Object.prototype.hasOwnProperty.call(record.preview, "text"))) {
      await applyBrowserCommentDesignRecord(page, record);
    }
  }
  if (removed.elementId !== undefined) await removeUnusedBrowserCommentElementAttribute(page, records, removed.elementId);
}

function repairBrowserCommentDesignChains(
  ordered: readonly BrowserCommentDesignRecord[],
  removedRecords: readonly BrowserCommentDesignRecord[]
): void {
  for (const removed of removedRecords) {
    if (!isBrowserCommentElementDesignRecord(removed)) continue;
    for (const property of BROWSER_COMMENT_DESIGN_PROPERTIES) {
      if (removed.preview.styles[property] === undefined) continue;
      for (const successor of ordered) {
        if (successor.sequence <= removed.sequence || successor.elementId !== removed.elementId
          || !isBrowserCommentElementDesignRecord(successor)) continue;
        successor.originalStyles[property] = { ...removed.originalStyles[property] };
        if (successor.preview.styles[property] !== undefined) break;
      }
    }
    if (Object.prototype.hasOwnProperty.call(removed.preview, "text")) {
      for (const successor of ordered) {
        if (successor.sequence <= removed.sequence || successor.elementId !== removed.elementId) continue;
        if (removed.originalText !== undefined) successor.originalText = removed.originalText;
        if (Object.prototype.hasOwnProperty.call(successor.preview, "text")) break;
      }
    }
  }
}

async function liveBrowserCommentElementIds(
  page: Page,
  records: readonly BrowserCommentDesignRecord[]
): Promise<ReadonlySet<string>> {
  const elementIds = [...new Set(records.flatMap((record) => record.elementId === undefined ? [] : [record.elementId]))];
  if (elementIds.length === 0) return new Set();
  const live = await page.evaluate(({ attribute, ids }) => {
    const escape = (value: string): string => globalThis.CSS?.escape?.(value) ?? value.replace(/[^a-zA-Z0-9_-]/gu, (character) => `\\${character}`);
    return ids.filter((id) => {
      const matches = document.querySelectorAll(`[${attribute}="${escape(id)}"]`);
      return matches.length === 1 && matches[0]?.isConnected === true;
    });
  }, { attribute: BROWSER_COMMENT_ELEMENT_ATTRIBUTE, ids: elementIds }).catch(() => []);
  return new Set(Array.isArray(live) ? live.filter((value): value is string => typeof value === "string" && elementIds.includes(value)) : []);
}

async function projectBrowserCommentPlacements(
  page: Page,
  records: ReadonlyMap<string, BrowserCommentDesignRecord>
): Promise<readonly BrowserCommentPlacement[]> {
  const projection = await page.evaluate(() => ({
    scrollX: Number.isFinite(window.scrollX) ? window.scrollX : 0,
    scrollY: Number.isFinite(window.scrollY) ? window.scrollY : 0,
    viewport: { width: Math.max(1, window.innerWidth), height: Math.max(1, window.innerHeight) }
  }));
  if (!isUnknownRecord(projection) || !isUnknownRecord(projection["viewport"])) {
    throw new BrowserTakeoverConflictError("Browser comment placement projection is unavailable.");
  }
  const scroll = normalizeBrowserCommentDocumentScroll({ x: projection["scrollX"], y: projection["scrollY"] });
  const viewport = normalizeBrowserCommentSize(projection["viewport"]);
  if (scroll === undefined || viewport === undefined) {
    throw new BrowserTakeoverConflictError("Browser comment placement projection is invalid.");
  }
  return [...records.values()].sort((left, right) => left.sequence - right.sequence).map((record) => ({
    markerNumber: record.markerNumber,
    point: { x: record.documentPoint.x - scroll.x, y: record.documentPoint.y - scroll.y },
    viewport,
    pending: record.pending,
    ...(record.pending && record.documentRegion !== undefined ? {
      region: {
        x: record.documentRegion.x - scroll.x,
        y: record.documentRegion.y - scroll.y,
        width: record.documentRegion.width,
        height: record.documentRegion.height
      }
    } : {}),
    ...(record.pending && record.documentTextRegions !== undefined ? {
      textRegions: record.documentTextRegions.map((region) => ({
        x: region.x - scroll.x,
        y: region.y - scroll.y,
        width: region.width,
        height: region.height
      }))
    } : {})
  }));
}

async function removeUnusedBrowserCommentElementAttribute(page: Page, records: Map<string, BrowserCommentDesignRecord>, elementId: string): Promise<void> {
  if ([...records.values()].some((record) => record.elementId === elementId)) return;
  await page.evaluate(({ attribute, id }) => {
    const escape = (value: string): string => globalThis.CSS?.escape?.(value) ?? value.replace(/[^a-zA-Z0-9_-]/gu, (character) => `\\${character}`);
    document.querySelectorAll(`[${attribute}="${escape(id)}"]`).forEach((element) => element.removeAttribute(attribute));
  }, { attribute: BROWSER_COMMENT_ELEMENT_ATTRIBUTE, id: elementId }).catch(() => undefined);
}

function validateMouseButton(value: "left" | "middle" | "right" | undefined): "left" | "middle" | "right" {
  if (value === undefined) return "left";
  if (value !== "left" && value !== "middle" && value !== "right") {
    throw new TypeError("Browser mouse button is invalid.");
  }
  return value;
}

function validateLoadState(value: "load" | "domcontentloaded" | "networkidle"): "load" | "domcontentloaded" | "networkidle" {
  if (value !== "load" && value !== "domcontentloaded" && value !== "networkidle") {
    throw new TypeError("Browser load state is invalid.");
  }
  return value;
}

function validateImageType(value: "png" | "jpeg"): "png" | "jpeg" {
  if (value !== "png" && value !== "jpeg") throw new TypeError("Browser image type is invalid.");
  return value;
}

async function installScreenshotLabels(page: Page): Promise<void> {
  await page.evaluate(() => {
    const attribute = "data-joko-browser-label-overlay";
    document.querySelectorAll(`[${attribute}]`).forEach((item) => item.remove());
    const layer = document.createElement("div");
    layer.setAttribute(attribute, "");
    Object.assign(layer.style, {
      position: "fixed",
      inset: "0",
      pointerEvents: "none",
      zIndex: "2147483647"
    });
    const elements = [...document.querySelectorAll<HTMLElement>(
      "a,button,input,select,textarea,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab]"
    )].slice(0, 500);
    elements.forEach((element, index) => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || rect.bottom < 0 || rect.right < 0) return;
      const marker = document.createElement("span");
      marker.textContent = String(index + 1);
      Object.assign(marker.style, {
        position: "fixed",
        left: `${Math.max(0, rect.left)}px`,
        top: `${Math.max(0, rect.top)}px`,
        color: "#ffffff",
        background: "#e5484d",
        border: "1px solid #ffffff",
        borderRadius: "3px",
        font: "600 11px/16px system-ui, sans-serif",
        minWidth: "16px",
        height: "16px",
        padding: "0 2px",
        textAlign: "center",
        boxSizing: "border-box"
      });
      layer.append(marker);
    });
    document.documentElement.append(layer);
  });
}

async function removeScreenshotLabels(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll("[data-joko-browser-label-overlay]").forEach((item) => item.remove());
  }).catch(() => undefined);
}

function selectorFromElementQuery(value: BrowserElementQuery): string {
  if (typeof value !== "object" || value === null) throw new TypeError("Browser element query is invalid.");
  const index = value.index === undefined
    ? undefined
    : validateIntegerInRange(value.index, "Browser element query index", 0, 10_000);
  const exact = value.exact === true;
  const populated = [value.css, value.role, value.name, value.text, value.label, value.placeholder, value.testId]
    .filter((item): item is string => item !== undefined)
    .map((item) => validateBoundedString(item, "Browser element query", MAXIMUM_SELECTOR_LENGTH));
  if (populated.length === 0) throw new TypeError("Browser element query requires at least one lookup field.");
  let selector: string;
  if (value.css !== undefined) {
    selector = validateSelector(value.css);
  } else if (value.role !== undefined) {
    const role = validateBoundedString(value.role, "Browser element role", 128);
    selector = value.name === undefined
      ? `role=${role}`
      : `role=${role}[name=${JSON.stringify(validateBoundedString(value.name, "Browser element name", 2_048))}${exact ? "][exact=true" : ""}]`;
  } else if (value.label !== undefined) {
    selector = `label=${JSON.stringify(validateBoundedString(value.label, "Browser element label", 2_048))}`;
  } else if (value.placeholder !== undefined) {
    selector = `css=[placeholder=${JSON.stringify(validateBoundedString(value.placeholder, "Browser element placeholder", 2_048))}]`;
  } else if (value.testId !== undefined) {
    selector = `css=[data-testid=${JSON.stringify(validateBoundedString(value.testId, "Browser element test ID", 2_048))}]`;
  } else {
    selector = `text=${JSON.stringify(validateBoundedString(value.text ?? value.name ?? "", "Browser element text", 2_048))}`;
  }
  return index === undefined ? selector : `${selector} >> nth=${index}`;
}

function validateEvaluateSource(value: string): string {
  const source = validateBoundedString(value, "Browser evaluate source", MAXIMUM_EVALUATE_SOURCE_LENGTH);
  if (!/^(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/u.test(source.trim())) {
    throw new TypeError("Browser evaluate source must be a function expression.");
  }
  if (
    /\b(?:document\s*\.\s*cookie|localStorage|sessionStorage|indexedDB|caches|navigator\s*\.\s*credentials|eval\s*\(|Function\s*\(|WebSocket|XMLHttpRequest)\b/iu.test(source)
    || /\b(?:password|passwd|secret|token|api[-_]?key|credential|authorization|cookie)\b/iu.test(source)
  ) {
    throw new Error("Browser evaluate cannot access credential, storage, or dynamic-code surfaces.");
  }
  return source;
}

function validateBundledRecipeEvaluateSource(value: string): string {
  const source = validateBoundedString(value, "Browser bundled recipe source", MAXIMUM_EVALUATE_SOURCE_LENGTH);
  if (!/^(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/u.test(source.trim())) {
    throw new TypeError("Browser bundled recipe source must be a function expression.");
  }
  if (/\b(?:localStorage|sessionStorage|indexedDB|caches|navigator\s*\.\s*credentials|eval\s*\(|Function\s*\(|WebSocket|XMLHttpRequest)\b/iu.test(source)) {
    throw new Error("Browser bundled recipe cannot access storage or dynamic-code surfaces.");
  }
  return source;
}

export function validateBrowserEvaluateSource(value: string): string {
  return validateEvaluateSource(value);
}

function validateExtractSpec(value: BrowserExtractSpec): {
  readonly from?: string;
  readonly multiple: boolean;
  readonly limit: number;
  readonly fields: Readonly<Record<string, { readonly selector?: string; readonly attr?: string; readonly type: "text" | "html" | "attr" | "href" }>>;
} {
  if (typeof value !== "object" || value === null || typeof value.fields !== "object" || value.fields === null) {
    throw new TypeError("Browser extract spec is invalid.");
  }
  const entries = Object.entries(value.fields);
  if (entries.length < 1 || entries.length > MAXIMUM_EXTRACT_FIELDS) {
    throw new RangeError(`Browser extract accepts one through ${MAXIMUM_EXTRACT_FIELDS} fields.`);
  }
  const fields: Record<string, { selector?: string; attr?: string; type: "text" | "html" | "attr" | "href" }> = {};
  for (const [rawName, rawField] of entries) {
    const name = validateBoundedString(rawName, "Browser extract field name", 256);
    const field = typeof rawField === "string" ? { selector: rawField } : rawField;
    if (typeof field !== "object" || field === null) throw new TypeError("Browser extract field is invalid.");
    const selector = field.selector === undefined ? undefined : validateSelector(field.selector);
    if (selector?.includes("@")) throw new Error("Browser extract selectors must not append attribute names with '@'.");
    const attr = field.attr === undefined ? undefined : validateBoundedString(field.attr, "Browser extract attribute", 256);
    const type = field.type ?? (attr === undefined ? "text" : "attr");
    if (type !== "text" && type !== "html" && type !== "attr" && type !== "href") {
      throw new TypeError("Browser extract field type is invalid.");
    }
    fields[name] = { ...(selector === undefined ? {} : { selector }), ...(attr === undefined ? {} : { attr }), type };
  }
  const from = value.from === undefined ? undefined : validateSelector(value.from);
  const limit = value.limit === undefined
    ? value.multiple === true ? 100 : 1
    : validateIntegerInRange(value.limit, "Browser extract record limit", 1, MAXIMUM_EXTRACT_RECORDS);
  return { ...(from === undefined ? {} : { from }), multiple: value.multiple === true, limit, fields };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function boundedModelValue(value: unknown): unknown {
  const sanitized = sanitizeModelValue(value, 0);
  const json = JSON.stringify(sanitized);
  if (json === undefined) return null;
  if (Buffer.byteLength(json, "utf8") > MAXIMUM_EVALUATE_RESULT_BYTES) {
    throw new RangeError("Browser model-visible result exceeds its safe byte limit.");
  }
  return sanitized;
}

function sanitizeModelValue(value: unknown, depth: number): unknown {
  if (depth > 16) return "[truncated depth]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactCredentialMaterial(value);
  if (Array.isArray(value)) {
    const selected = value.slice(0, 1_000).map((item) => sanitizeModelValue(item, depth + 1));
    if (value.length > 1_000) selected.push(`[truncated ${value.length - 1_000} items]`);
    return selected;
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    const entries = Object.entries(value);
    for (const [key, item] of entries.slice(0, 1_000)) {
      if (isCredentialKey(key)) output[key] = "[redacted]";
      else output[key] = sanitizeModelValue(item, depth + 1);
    }
    if (entries.length > 1_000) output["[truncated fields]"] = entries.length - 1_000;
    return output;
  }
  return String(value);
}

function isCredentialKey(value: string): boolean {
  return /(?:^|[_-])(?:access|auth|bearer|cookie|credential|jwt|key|password|secret|session|signature|token)(?:$|[_-])/iu.test(value);
}

function redactCredentialMaterial(value: string): string {
  let safe = value.replaceAll("\u0000", "");
  safe = safe.replace(/https?:\/\/[^\s<>"']+/giu, (candidate) => sanitizeBrowserUrlForDisplay(candidate));
  safe = safe.replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]*/giu, "[redacted header]");
  safe = safe.replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu, "[redacted authorization]");
  safe = safe.replace(
    /(["']?)(?:access[_-]?token|api[_-]?key|auth|credential|jwt|password|secret|session|signature|token)\1\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)/giu,
    "credential=[redacted]"
  );
  safe = safe.replace(/[A-Za-z0-9._~+/=-]{48,}/gu, "[redacted opaque value]");
  safe = safe.replace(/[A-Za-z]:\\(?:[^\s<>:"|?*]+\\)+[^\s<>:"|?*]*/gu, "[redacted local path]");
  return safe;
}

function urlPatternMatches(value: string, pattern: string): boolean {
  if (!pattern.includes("*")) return value.includes(pattern);
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*");
  return new RegExp(escaped, "u").test(value);
}

function sanitizeMediaType(value: string | null): string {
  if (value === null) return "application/octet-stream";
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mediaType)
    ? mediaType
    : "application/octet-stream";
}

function validatePublicResourceUrl(value: string): string {
  const normalized = validateWebUrl(value);
  if (sanitizeBrowserUrlForDisplay(normalized) !== normalized) {
    throw new Error("Browser resource URL contains credential-shaped material.");
  }
  const hostname = new URL(normalized).hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (
    hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname === "0.0.0.0"
    || hostname === "::1"
    || /^127\./u.test(hostname)
    || /^10\./u.test(hostname)
    || /^192\.168\./u.test(hostname)
    || /^169\.254\./u.test(hostname)
    || /^172\.(?:1[6-9]|2\d|3[01])\./u.test(hostname)
  ) throw new Error("Browser resource URL must address a public HTTP(S) host.");
  return normalized;
}

export function validatePublicBrowserResourceUrl(value: string): string {
  return validatePublicResourceUrl(value);
}

async function resourceFromResponse(response: APIResponse, maximumBytes: number): Promise<BrowserResourceSnapshot> {
  const finalUrl = validatePublicResourceUrl(response.url());
  if (!response.ok()) throw new Error(`Browser resource request failed with HTTP ${response.status()}.`);
  const contentLength = Number(response.headers()["content-length"] ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new RangeError("Browser resource exceeds its safe byte limit.");
  }
  const bytes = await response.body();
  if (bytes.byteLength > maximumBytes) throw new RangeError("Browser resource exceeds its safe byte limit.");
  const url = new URL(finalUrl);
  const fileName = sanitizeBrowserFileName(decodeURIComponent(url.pathname.split("/").at(-1) ?? "resource"));
  return {
    url: sanitizeBrowserUrlForDisplay(finalUrl),
    fileName,
    mediaType: sanitizeMediaType(response.headers()["content-type"] ?? null),
    bytes: Uint8Array.from(bytes)
  };
}

function validateBoundedPositiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} must be a positive integer no greater than ${maximum}.`);
  }
  return value;
}

function validateDiagnosticReadLimit(value: number | undefined, retainedMaximum: number): number {
  const maximum = Math.min(retainedMaximum, MAXIMUM_DIAGNOSTIC_ITEMS_PER_READ);
  if (value === undefined) return maximum;
  return validateIntegerInRange(value, "Browser diagnostic read limit", 1, maximum);
}

function browserActionChord(key: string, modifiers: readonly BrowserKeyModifier[]): string {
  return [...modifiers, key].join("+");
}

function copyBoundedBytes(bytes: Uint8Array, maximumBytes: number, label: string): Uint8Array {
  if (bytes.byteLength > maximumBytes) throw new RangeError(`${label} exceeds the configured byte limit.`);
  return Uint8Array.from(bytes);
}

function appendBoundedItem<T>(items: T[], item: T, maximumItems: number): void {
  items.push(item);
  if (items.length > maximumItems) items.splice(0, items.length - maximumItems);
}

function sanitizeDiagnosticLabel(value: string, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const safe = value.slice(0, 32).replace(/[^A-Za-z0-9_-]/gu, "_");
  return safe === "" ? fallback : safe;
}

function sanitizeHttpMethod(value: string): string {
  const method = typeof value === "string" ? value.slice(0, 17).toUpperCase() : "";
  return /^[A-Z]{1,16}$/u.test(method) ? method : "OTHER";
}

function sanitizeHttpRequestSummaryUrl(value: string): string | undefined {
  if (typeof value !== "string" || value.length > MAXIMUM_PUBLIC_URL_LENGTH * 4) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  url.username = "";
  url.password = "";
  return sanitizeBrowserUrlForDisplay(url.href);
}

function sanitizeConsoleMessageText(value: string): string {
  if (typeof value !== "string") return "";
  let safe = value.slice(0, MAXIMUM_CONSOLE_TEXT_LENGTH * 4).replaceAll("\u0000", "");
  safe = safe.replace(/https?:\/\/[^\s<>"']+/giu, (candidate) => sanitizeBrowserUrlForDisplay(candidate));
  safe = safe.replace(
    /\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]*/giu,
    "[redacted header]"
  );
  safe = safe.replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu, "[redacted authorization]");
  safe = safe.replace(
    /(["']?)(?:access[_-]?token|api[_-]?key|auth|credential|jwt|password|secret|session|signature|token)\1\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)/giu,
    "credential=[redacted]"
  );
  safe = safe.replace(/[A-Za-z0-9._~+/=-]{32,}/gu, "[redacted]");
  return truncatePublicText(safe, MAXIMUM_CONSOLE_TEXT_LENGTH);
}

function truncatePublicText(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) return value;
  return `${value.slice(0, maximumLength - 1)}…`;
}

interface ResolvedBrowserLaunchTargets {
  readonly profileDirectories: BrowserTargetProfileDirectories;
  readonly targetMode: BrowserTargetMode;
}

function resolveBrowserLaunchTargets(options: BrowserProviderOptions): ResolvedBrowserLaunchTargets {
  const targetProfiles = options.profileDirectories;
  const sidebar = validateBrowserProfileDirectory(targetProfiles.sidebar, "sidebar");
  const external = validateBrowserProfileDirectory(targetProfiles.external, "external");
  const sidebarRoot = resolve(sidebar);
  const externalRoot = resolve(external);
  if (sidebarRoot === externalRoot || isWithin(sidebarRoot, externalRoot) || isWithin(externalRoot, sidebarRoot)) {
    throw new TypeError("Sidebar and external Browser profiles must use non-overlapping directories.");
  }
  return {
    profileDirectories: { sidebar, external },
    targetMode: validateBrowserTargetMode(options.targetMode ?? "external")
  };
}

function validateBrowserTargetMode(value: BrowserTargetMode): BrowserTargetMode {
  if (value !== "sidebar" && value !== "external") throw new TypeError("Browser target mode is invalid.");
  return value;
}

function validateBrowserProfileDirectory(value: string | undefined, label: string): string {
  if (value === undefined || value.trim() === "" || value.includes("\u0000")) {
    throw new TypeError(`${label} Browser profile directory must be a non-empty path.`);
  }
  return value;
}

function validateProviderId(providerId: string): string {
  if (providerId.trim() === "" || providerId.length > 1_024) {
    throw new TypeError("Browser Provider ID must be a non-empty opaque identifier.");
  }
  return providerId;
}

function validateInitialBrowserGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Initial Browser generation must be a non-negative safe integer with room for restart.");
  }
  return value;
}

function copyAgentFence(fence: BrowserLeaseFence): BrowserLeaseFence {
  return {
    id: fence.id,
    providerId: fence.providerId,
    owner: fence.owner,
    generation: fence.generation
  };
}

function copyTakeoverRequest(request: BrowserTakeoverRequest): BrowserTakeoverRequest {
  return {
    providerId: request.providerId,
    pageId: request.pageId,
    generation: request.generation,
    owner: request.owner
  };
}

function copyTakeoverFence(fence: BrowserTakeoverFence): BrowserTakeoverFence {
  return {
    ...copyTakeoverRequest(fence),
    takeoverId: fence.takeoverId
  };
}

function copyTakeoverInput(input: BrowserTakeoverInput): BrowserTakeoverInput {
  switch (input.type) {
  case "mouseClick":
    return {
      type: input.type,
      normalizedX: input.normalizedX,
      normalizedY: input.normalizedY,
      button: input.button,
      ...(input.clickCount === undefined ? {} : { clickCount: input.clickCount })
    };
  case "mouseMove":
    return { type: input.type, normalizedX: input.normalizedX, normalizedY: input.normalizedY };
  case "mouseDrag":
    return {
      type: input.type,
      startNormalizedX: input.startNormalizedX,
      startNormalizedY: input.startNormalizedY,
      endNormalizedX: input.endNormalizedX,
      endNormalizedY: input.endNormalizedY,
      button: input.button
    };
  case "scroll":
    return { type: input.type, deltaX: input.deltaX, deltaY: input.deltaY };
  case "keyPress":
    return { type: input.type, key: input.key, modifiers: [...(input.modifiers ?? [])] };
  case "textInput":
    return { type: input.type, text: input.text };
  case "navigate":
    return { type: input.type, url: input.url };
  case "navigationCommand":
    return { type: input.type, command: input.command };
  }
}

function browserTakeoverChord(
  key: Extract<BrowserTakeoverInput, { type: "keyPress" }>["key"],
  modifiers: readonly BrowserTakeoverKeyModifier[]
): string {
  return [...modifiers, key].join("+");
}

async function browserNavigationAvailability(page: Page): Promise<{ canGoBack: boolean; canGoForward: boolean }> {
  if (page.isClosed()) return { canGoBack: false, canGoForward: false };
  let session: Awaited<ReturnType<BrowserContext["newCDPSession"]>> | undefined;
  try {
    session = await page.context().newCDPSession(page);
    const history = await session.send("Page.getNavigationHistory");
    return {
      canGoBack: history.currentIndex > 0,
      canGoForward: history.currentIndex >= 0 && history.currentIndex < history.entries.length - 1
    };
  } catch {
    return { canGoBack: false, canGoForward: false };
  } finally {
    await session?.detach().catch(() => undefined);
  }
}

function mapMouseButton(button: "primary" | "middle" | "secondary"): "left" | "middle" | "right" {
  switch (button) {
  case "primary": return "left";
  case "middle": return "middle";
  case "secondary": return "right";
  }
}

export function validateWebUrl(value: string): string {
  validateBoundedString(value, "Browser URL", MAXIMUM_PUBLIC_URL_LENGTH);
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only HTTP(S) browser navigation is allowed.");
  if (url.username !== "" || url.password !== "") throw new Error("Credentials must not be embedded in browser URLs.");
  if (url.href.length > MAXIMUM_PUBLIC_URL_LENGTH) throw new RangeError("Browser URL exceeds its safe bound.");
  return url.href;
}

/** Strip credential-shaped URL material before state reaches Event/UI/model projections. */
export function sanitizeBrowserUrlForDisplay(value: string): string {
  if (typeof value !== "string" || value.length > MAXIMUM_PUBLIC_URL_LENGTH * 4) return "about:blank";
  if (value === "about:blank") return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "about:blank";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "about:blank";
  url.username = "";
  url.password = "";
  url.hash = "";
  for (const [name, item] of [...url.searchParams.entries()]) {
    if (
      /(?:^|[_-])(?:access|auth|bearer|code|credential|jwt|key|password|secret|session|signature|token)(?:$|[_-])/iu.test(name) ||
      (item.length >= 32 && /^[A-Za-z0-9._~+/=-]+$/u.test(item))
    ) url.searchParams.set(name, "[redacted]");
  }
  return truncatePublicText(url.href, MAXIMUM_PUBLIC_URL_LENGTH);
}

export interface StagedBrowserDownload {
  readonly verifiedLocalPath: string;
  readonly fileName: string;
  readonly byteLength: number;
}

interface BrowserDownloadSource {
  suggestedFilename(): string;
  saveAs(path: string): Promise<void>;
}

/** Stages and validates a browser download without publishing its local path. */
export async function stageBrowserDownload(
  download: BrowserDownloadSource,
  downloadDirectory: string,
  maximumBytes = 256 * 1024 * 1024
): Promise<StagedBrowserDownload> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new RangeError("maximumBytes must be a positive safe integer.");
  await mkdir(downloadDirectory, { recursive: true });
  const canonicalRoot = await realpath(downloadDirectory);
  const fileName = sanitizeBrowserFileName(download.suggestedFilename());
  const extension = extname(fileName).slice(0, 32);
  const destination = resolve(canonicalRoot, `${randomUUID()}${extension}`);
  if (!isWithin(destination, canonicalRoot)) throw new Error("Browser download staging path escaped its root.");
  try {
    await download.saveAs(destination);
    const directInfo = await lstat(destination);
    if (!directInfo.isFile() || directInfo.isSymbolicLink()) throw new Error("Browser download staging entry is not a regular file.");
    if (directInfo.size > maximumBytes) throw new Error("Browser download exceeds the configured size limit.");
    const canonical = await realpath(destination);
    if (!isWithin(canonical, canonicalRoot)) throw new Error("Browser download staging path escaped its root.");
    const canonicalInfo = await stat(canonical);
    if (!canonicalInfo.isFile() || canonicalInfo.size !== directInfo.size) throw new Error("Browser download changed during validation.");
    return { verifiedLocalPath: canonical, fileName, byteLength: canonicalInfo.size };
  } catch (error) {
    await rm(destination, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function sanitizeBrowserFileName(value: string): string {
  const leaf = value.replaceAll("\\", "/").split("/").at(-1) ?? "";
  let safe = leaf.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().replace(/[. ]+$/u, "");
  if (safe === "" || safe === "." || safe === "..") safe = `download-${Date.now()}`;
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(safe)) safe = `_${safe}`;
  return safe.slice(0, 180);
}
