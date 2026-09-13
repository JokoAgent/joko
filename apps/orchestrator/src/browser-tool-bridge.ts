import { createHash, randomUUID } from "node:crypto";

import {
  sanitizeBrowserFileName,
  sanitizeBrowserUrlForDisplay,
  validateBrowserEvaluateSource,
  validatePublicBrowserResourceUrl,
  validateTakeoverNavigationUrl,
  validateWebUrl,
  type BrowserAutomationAction,
  type BrowserAutomationActKind,
  type BrowserElementQuery,
  type BrowserExtractSpec,
  type BrowserConsoleMessageSnapshot,
  type BrowserHttpRequestSummary,
  type BrowserKeyModifier,
  type BrowserLease,
  type BrowserPageState,
  type BrowserProvider,
  type BrowserRemoteAutomationResult,
  type BrowserRemoteNodeRoute,
  type BrowserRemoteNodeRouter
} from "@joko/tool-browser";

import type { ArtifactStore } from "./artifact-store.js";
import { BUILTIN_BROWSER_RECIPES, BUILTIN_BROWSER_SITE_GUIDES } from "./browser-builtin-catalog.js";
import { BROWSER_RECIPE_AUTHOR_RULES, BROWSER_WORKFLOW_RULES } from "./browser-rules.js";
import type { BrowserTransferCoordinator } from "./browser-transfers.js";
import type { BridgeToolCallContext, BridgeToolProvider, McpCallResult, McpToolDescriptor } from "./mcp-router.js";
import type {
  BrowserBridgeEffectAuthority,
  OperationalBrowserState,
  RecoverableBrowserPageRecord
} from "./operational-browser-state.js";

export const BROWSER_BRIDGE_PROVIDER_ID = "joko_browser";

const objectSchema = (
  properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  required: readonly string[] = []
): Readonly<Record<string, unknown>> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false
});

const pageIdProperty = {
  type: "string",
  minLength: 1,
  maxLength: 512,
  description: "Opaque page_id returned by list_pages or open_page."
} as const;
const selectorProperty = {
  type: "string",
  minLength: 1,
  maxLength: 4_096,
  description: "A Playwright locator selector, for example role=button[name=Submit], text=Continue, or a CSS selector."
} as const;
const keyProperty = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  description: "One Playwright key name without modifier prefixes."
} as const;
const modifierProperty = {
  type: "string",
  enum: ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"]
} as const;

const MAXIMUM_ACTION_TEXT_LENGTH = 64 * 1024;
const MAXIMUM_SCROLL_DELTA = 100_000;
const MAXIMUM_VIEWPORT_EDGE = 8_192;
const MAXIMUM_WAIT_MILLISECONDS = 30_000;
const MAXIMUM_DIAGNOSTIC_READ_LIMIT = 100;
const MAXIMUM_INLINE_BINARY_BYTES = 10 * 1024 * 1024;
const MAXIMUM_UNIFIED_RESULT_BYTES = 200_000;

const unifiedActions = [
  "doctor", "status", "start", "stop", "profiles", "tabs", "open", "focus", "close",
  "snapshot", "screenshot", "navigate", "console", "pdf", "upload", "dialog", "act",
  "requests", "responseBody", "extract", "recipe", "siteguide", "saveRecipe"
] as const;

const actKinds = [
  "click", "clickCoords", "type", "press", "hover", "drag", "select", "fill", "resize",
  "wait", "evaluate", "saveResource", "close"
] as const;

const elementQuerySchema = objectSchema({
  css: { type: "string", minLength: 1, maxLength: 4_096 },
  role: { type: "string", minLength: 1, maxLength: 128 },
  name: { type: "string", minLength: 1, maxLength: 2_048 },
  text: { type: "string", minLength: 1, maxLength: 2_048 },
  label: { type: "string", minLength: 1, maxLength: 2_048 },
  placeholder: { type: "string", minLength: 1, maxLength: 2_048 },
  testId: { type: "string", minLength: 1, maxLength: 2_048 },
  exact: { type: "boolean" },
  index: { type: "integer", minimum: 0, maximum: 10_000 }
});

const extractFieldSchema = {
  anyOf: [
    { type: "string", maxLength: 4_096 },
    objectSchema({
      selector: { type: "string", maxLength: 4_096 },
      attr: { type: "string", maxLength: 256 },
      type: { type: "string", enum: ["text", "html", "attr", "href"] }
    })
  ]
} as const;

const extractSchema = objectSchema({
  from: { type: "string", minLength: 1, maxLength: 4_096 },
  multiple: { type: "boolean" },
  fields: { type: "object", minProperties: 1, maxProperties: 128, additionalProperties: extractFieldSchema },
  limit: { type: "integer", minimum: 1, maximum: 1_000 }
}, ["fields"]);

const actRequestSchema = objectSchema({
  kind: { type: "string", enum: actKinds },
  targetId: pageIdProperty,
  ref: { type: "string", minLength: 1, maxLength: 256 },
  query: elementQuerySchema,
  doubleClick: { type: "boolean" },
  button: { type: "string", enum: ["left", "middle", "right"] },
  modifiers: { type: "array", items: modifierProperty, uniqueItems: true, maxItems: 4 },
  x: { type: "number", minimum: -MAXIMUM_VIEWPORT_EDGE, maximum: MAXIMUM_VIEWPORT_EDGE },
  y: { type: "number", minimum: -MAXIMUM_VIEWPORT_EDGE, maximum: MAXIMUM_VIEWPORT_EDGE },
  text: { type: "string", maxLength: MAXIMUM_ACTION_TEXT_LENGTH },
  submit: { type: "boolean" },
  slowly: { type: "boolean" },
  key: keyProperty,
  delayMs: { type: "integer", minimum: 0, maximum: 5_000 },
  startRef: { type: "string", minLength: 1, maxLength: 256 },
  endRef: { type: "string", minLength: 1, maxLength: 256 },
  values: { type: "array", items: { type: "string", maxLength: 16_384 }, minItems: 1, maxItems: 100 },
  fields: { type: "array", items: { type: "object" }, maxItems: 128 },
  width: { type: "integer", minimum: 1, maximum: MAXIMUM_VIEWPORT_EDGE },
  height: { type: "integer", minimum: 1, maximum: MAXIMUM_VIEWPORT_EDGE },
  timeMs: { type: "integer", minimum: 0, maximum: MAXIMUM_WAIT_MILLISECONDS },
  selector: selectorProperty,
  url: { type: "string", minLength: 1, maxLength: 8_192 },
  loadState: { type: "string", enum: ["load", "domcontentloaded", "networkidle"] },
  textGone: { type: "string", minLength: 1, maxLength: MAXIMUM_ACTION_TEXT_LENGTH },
  timeoutMs: { type: "integer", minimum: 1, maximum: MAXIMUM_WAIT_MILLISECONDS },
  fn: { type: "string", minLength: 1, maxLength: 64 * 1024 }
}, ["kind"]);

const unifiedSchema = objectSchema({
  action: { type: "string", enum: unifiedActions },
  profile: { type: "string", minLength: 1, maxLength: 256 },
  target: { type: "string", enum: ["sandbox", "host", "node"] },
  node: { type: "string", minLength: 1, maxLength: 512 },
  url: { type: "string", minLength: 1, maxLength: 8_192 },
  targetId: pageIdProperty,
  label: { type: "string", minLength: 1, maxLength: 256 },
  limit: { type: "integer", minimum: 1, maximum: 1_000 },
  maxChars: { type: "integer", minimum: 0, maximum: 200_000 },
  mode: { type: "string", enum: ["efficient"] },
  snapshotFormat: { type: "string", enum: ["aria", "ai"] },
  refs: { type: "string", enum: ["role", "aria"] },
  interactive: { type: "boolean" },
  compact: { type: "boolean" },
  depth: { type: "integer", minimum: 0, maximum: 64 },
  selector: selectorProperty,
  frame: { type: "string", minLength: 1, maxLength: 4_096 },
  labels: { type: "boolean" },
  urls: { type: "boolean" },
  fullPage: { type: "boolean" },
  ref: { type: "string", minLength: 1, maxLength: 256 },
  type: { type: "string", enum: ["png", "jpeg"] },
  level: { type: "string", minLength: 1, maxLength: 32 },
  paths: { type: "array", items: { type: "string", minLength: 1, maxLength: 512 }, maxItems: 16 },
  inputRef: { type: "string", minLength: 1, maxLength: 256 },
  query: elementQuerySchema,
  timeoutMs: { type: "integer", minimum: 1, maximum: MAXIMUM_WAIT_MILLISECONDS },
  dialogId: { type: "string", minLength: 1, maxLength: 256 },
  accept: { type: "boolean" },
  promptText: { type: "string", maxLength: MAXIMUM_ACTION_TEXT_LENGTH },
  filter: { type: "string", maxLength: 4_096 },
  clear: { type: "boolean" },
  extract: extractSchema,
  recipeId: { type: "string", minLength: 1, maxLength: 256 },
  inputs: { type: "object", additionalProperties: true },
  site: { type: "string", minLength: 1, maxLength: 256 },
  recipeDraft: { type: "object", additionalProperties: true },
  siteGuideDraft: { type: "object", additionalProperties: true },
  request: actRequestSchema
}, ["action"]);

interface BrowserRecipeStep {
  readonly action: "navigate" | "click" | "type" | "select" | "wait" | "extract" | "evaluate" | "requests" | "responseBody";
  readonly url?: string;
  readonly selector?: string;
  readonly fn?: string;
  readonly value?: string;
  readonly values?: readonly string[];
  readonly submit?: boolean;
  readonly loadState?: "load" | "domcontentloaded" | "networkidle";
  readonly textGone?: string;
  readonly timeoutMs?: number;
  readonly filter?: string;
  readonly maxChars?: number;
  readonly extract?: BrowserExtractSpec;
  readonly as?: string;
  readonly optional?: boolean;
}

interface BrowserRecipe {
  readonly id: string;
  readonly match?: readonly string[];
  readonly description?: string;
  readonly inputs?: Readonly<Record<string, { readonly required?: boolean }>>;
  readonly steps: readonly BrowserRecipeStep[];
  readonly output?: string;
}

interface BrowserSiteGuide {
  readonly site: string;
  readonly auth?: string;
  readonly entry?: Readonly<Record<string, string>>;
  readonly pages?: readonly unknown[];
  readonly recipes?: readonly string[];
  readonly notes?: string;
  readonly [key: string]: unknown;
}

export interface BrowserUserKnowledgeLayer {
  readonly recipes?: readonly unknown[];
  readonly siteGuides?: readonly unknown[];
  save(input: {
    readonly site: string;
    readonly recipe: Readonly<Record<string, unknown>>;
    readonly siteGuide?: Readonly<Record<string, unknown>>;
  }): Promise<void>;
}

/**
 * The public, generation-independent Browser tool catalog.  Orchestrator projects
 * this same descriptor set through ToolService and installs it in the Pi MCP
 * bridge, so the UI never advertises a different surface from the one the
 * agent can actually call.
 */
const BROWSER_RUNTIME_TOOLS: readonly McpToolDescriptor[] = [
  tool(
    "browser",
    "Unified browser automation entry point covering lifecycle, profiles, tabs, snapshots, navigation, interactions, diagnostics, extraction, resources, and reusable recipes.",
    unifiedSchema,
    true
  ),
  tool("list_pages", "List the live browser pages and their opaque IDs.", objectSchema({}), false),
  tool("open_page", "Open a browser page, optionally navigating to an HTTP(S) URL.", objectSchema({
    url: { type: "string", minLength: 1, maxLength: 8_192, description: "Optional HTTP(S) URL without embedded credentials." }
  }), true),
  tool("snapshot", "Read a page's current accessibility snapshot and PNG screenshot before choosing an action.", objectSchema({
    page_id: pageIdProperty
  }, ["page_id"]), false),
  tool("screenshot", "Capture a bounded PNG screenshot from a browser page.", objectSchema({
    page_id: pageIdProperty,
    full_page: { type: "boolean", description: "Capture the full scrollable page instead of the viewport." }
  }, ["page_id"]), false),
  tool("pdf", "Render a bounded in-memory PDF from a browser page.", objectSchema({
    page_id: pageIdProperty
  }, ["page_id"]), false),
  tool("console_messages", "Read retained, sanitized console messages without inspecting argument handles.", objectSchema({
    page_id: pageIdProperty,
    limit: { type: "integer", minimum: 1, maximum: MAXIMUM_DIAGNOSTIC_READ_LIMIT }
  }, ["page_id"]), false),
  tool("http_requests", "Read sanitized HTTP request summaries without headers, cookies, bodies, or responses.", objectSchema({
    page_id: pageIdProperty,
    limit: { type: "integer", minimum: 1, maximum: MAXIMUM_DIAGNOSTIC_READ_LIMIT }
  }, ["page_id"]), false),
  tool("navigate", "Navigate an existing page to an HTTP(S) URL.", objectSchema({
    page_id: pageIdProperty,
    url: { type: "string", minLength: 1, maxLength: 8_192, description: "HTTP(S) URL without embedded credentials." }
  }, ["page_id", "url"]), true),
  tool("click", "Click one element on a browser page.", objectSchema({
    page_id: pageIdProperty,
    selector: selectorProperty
  }, ["page_id", "selector"]), true),
  tool("double_click", "Double-click one element on a browser page.", objectSchema({
    page_id: pageIdProperty,
    selector: selectorProperty
  }, ["page_id", "selector"]), true),
  tool("right_click", "Right-click one element on a browser page.", objectSchema({
    page_id: pageIdProperty,
    selector: selectorProperty
  }, ["page_id", "selector"]), true),
  tool("hover", "Move the pointer over one element on a browser page.", objectSchema({
    page_id: pageIdProperty,
    selector: selectorProperty
  }, ["page_id", "selector"]), true),
  tool("drag", "Drag one element onto another element.", objectSchema({
    page_id: pageIdProperty,
    source_selector: selectorProperty,
    target_selector: selectorProperty
  }, ["page_id", "source_selector", "target_selector"]), true),
  tool("type_text", "Replace an input's value and optionally press Enter.", objectSchema({
    page_id: pageIdProperty,
    selector: selectorProperty,
    text: { type: "string", maxLength: MAXIMUM_ACTION_TEXT_LENGTH, description: "Text to enter. Never place secrets here unless the user explicitly supplied them for this action." },
    submit: { type: "boolean", description: "Press Enter after filling the input." }
  }, ["page_id", "selector", "text"]), true),
  tool("fill", "Replace an input's value without submitting it.", objectSchema({
    page_id: pageIdProperty,
    selector: selectorProperty,
    text: { type: "string", maxLength: MAXIMUM_ACTION_TEXT_LENGTH }
  }, ["page_id", "selector", "text"]), true),
  tool("press", "Press one key on the active browser page.", objectSchema({
    page_id: pageIdProperty,
    key: keyProperty
  }, ["page_id", "key"]), true),
  tool("hotkey", "Press one key with an optional, unique set of modifiers.", objectSchema({
    page_id: pageIdProperty,
    key: keyProperty,
    modifiers: { type: "array", items: modifierProperty, uniqueItems: true, maxItems: 4 }
  }, ["page_id", "key"]), true),
  tool("scroll", "Scroll the active browser page by bounded pixel deltas.", objectSchema({
    page_id: pageIdProperty,
    delta_x: { type: "number", minimum: -MAXIMUM_SCROLL_DELTA, maximum: MAXIMUM_SCROLL_DELTA },
    delta_y: { type: "number", minimum: -MAXIMUM_SCROLL_DELTA, maximum: MAXIMUM_SCROLL_DELTA }
  }, ["page_id", "delta_x", "delta_y"]), true),
  tool("resize", "Resize the browser viewport within safe dimensions.", objectSchema({
    page_id: pageIdProperty,
    width: { type: "integer", minimum: 1, maximum: MAXIMUM_VIEWPORT_EDGE },
    height: { type: "integer", minimum: 1, maximum: MAXIMUM_VIEWPORT_EDGE }
  }, ["page_id", "width", "height"]), true),
  tool("wait", "Wait for a bounded duration on the active browser page.", objectSchema({
    page_id: pageIdProperty,
    milliseconds: { type: "integer", minimum: 0, maximum: MAXIMUM_WAIT_MILLISECONDS }
  }, ["page_id", "milliseconds"]), true),
  tool("select_option", "Select an option value in a select element.", objectSchema({
    page_id: pageIdProperty,
    selector: selectorProperty,
    value: { type: "string", maxLength: 16_384 }
  }, ["page_id", "selector", "value"]), true),
  tool("go_back", "Navigate one page back in browser history.", objectSchema({ page_id: pageIdProperty }, ["page_id"]), true),
  tool("reload", "Reload an existing browser page.", objectSchema({ page_id: pageIdProperty }, ["page_id"]), true),
  tool("close_page", "Close an existing browser page.", objectSchema({ page_id: pageIdProperty }, ["page_id"]), true),
  tool("upload_artifact", "Set a durable Joko artifact on a page's file input without exposing its service-local path.", objectSchema({
    page_id: pageIdProperty,
    selector: selectorProperty,
    artifact_id: { type: "string", minLength: 1, maxLength: 512, description: "Artifact ID already present in the Joko session or workspace." }
  }, ["page_id", "selector", "artifact_id"]), true),
  tool("list_transfers", "List recent browser uploads and downloads without exposing service-local paths.", objectSchema({
    page_id: { ...pageIdProperty, description: "Optional page filter." }
  }), false)
];

/** Progressive public Browser discovery. Nested runtime tools never enter a new Pi grant directly. */
export const BROWSER_TOOLS: readonly McpToolDescriptor[] = [
  tool(
    "list_tools",
    "Discover Browser automation categories and the shared rules for a selected category.",
    objectSchema({ category: { type: "string", enum: ["browser"] } }),
    true
  ),
  tool(
    "call_tool",
    "Call a nested Browser tool discovered through list_tools.",
    objectSchema({
      name: { type: "string", minLength: 1, maxLength: 128 },
      args: { type: "object", additionalProperties: true }
    }, ["name", "args"]),
    true
  )
];

/** Makes the independently supervised Browser Provider callable by Pi. */
export class BrowserToolBridgeProvider implements BridgeToolProvider {
  readonly id = BROWSER_BRIDGE_PROVIDER_ID;
  readonly policySubject = "browser" as const;
  readonly tools = BROWSER_TOOLS;
  readonly #browser: BrowserProvider;
  readonly #transfers: BrowserTransferCoordinator;
  readonly #artifacts: ArtifactStore;
  readonly #state: OperationalBrowserState | undefined;
  readonly #enabledForNewSessions: (targetId: string) => boolean;
  readonly #remoteNodes: BrowserRemoteNodeRouter | undefined;
  readonly #userKnowledge: BrowserUserKnowledgeLayer | undefined;
  readonly #recipes = new Map<string, BrowserRecipe>();
  readonly #siteGuides = new Map<string, BrowserSiteGuide>();
  readonly #builtinRecipeIds = new Set<string>();
  readonly #builtinSiteGuideIds = new Set<string>();
  readonly #userRecipeIds = new Set<string>();
  readonly #userSiteGuideIds = new Set<string>();
  #tail: Promise<void> = Promise.resolve();
  #activeContext: BridgeToolCallContext | undefined;
  #activePageIds = new Set<string>();

  constructor(input: {
    readonly browser: BrowserProvider;
    readonly transfers: BrowserTransferCoordinator;
    readonly artifacts: ArtifactStore;
    readonly state?: OperationalBrowserState;
    readonly enabledForNewSessions?: (targetId: string) => boolean;
    readonly remoteNodes?: BrowserRemoteNodeRouter;
    readonly userKnowledge?: BrowserUserKnowledgeLayer;
  }) {
    this.#browser = input.browser;
    this.#transfers = input.transfers;
    this.#artifacts = input.artifacts;
    this.#state = input.state;
    this.#enabledForNewSessions = input.enabledForNewSessions ?? (() => true);
    this.#remoteNodes = input.remoteNodes;
    this.#userKnowledge = input.userKnowledge;
    for (const raw of BUILTIN_BROWSER_RECIPES) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("Built-in Browser recipe is invalid.");
      const recipe = validateRecipe(raw as Readonly<Record<string, unknown>>);
      if (this.#recipes.has(recipe.id)) throw new Error(`Built-in Browser recipe '${recipe.id}' is duplicated.`);
      this.#recipes.set(recipe.id, recipe);
      this.#builtinRecipeIds.add(recipe.id);
    }
    for (const raw of BUILTIN_BROWSER_SITE_GUIDES) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("Built-in Browser site guide is invalid.");
      const guide = validateSiteGuide(raw as Readonly<Record<string, unknown>>);
      if (this.#siteGuides.has(guide.site)) throw new Error(`Built-in Browser site guide '${guide.site}' is duplicated.`);
      this.#siteGuides.set(guide.site, guide);
      this.#builtinSiteGuideIds.add(guide.site);
    }
    for (const raw of input.userKnowledge?.recipes ?? []) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("User Browser recipe is invalid.");
      const recipe = validateRecipe(raw as Readonly<Record<string, unknown>>);
      validateUserRecipeSafety(recipe);
      this.#recipes.set(recipe.id, recipe);
      this.#userRecipeIds.add(recipe.id);
    }
    for (const raw of input.userKnowledge?.siteGuides ?? []) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("User Browser site guide is invalid.");
      const guide = validateSiteGuide(raw as Readonly<Record<string, unknown>>);
      this.#siteGuides.set(guide.site, guide);
      this.#userSiteGuideIds.add(guide.site);
    }
  }

  get generation(): number {
    // A cold Browser has not launched a Playwright generation yet, but the
    // bridge still needs a valid immutable generation so Pi can discover the
    // explicit lifecycle actions without opening a window at startup.
    return Math.max(1, this.#browser.generation);
  }

  get available(): boolean {
    return true;
  }

  get includeInSnapshot(): boolean {
    return true;
  }

  includeForTarget(targetId: string): boolean {
    return this.#enabledForNewSessions(targetId);
  }

  callTool(
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    context?: BridgeToolCallContext
  ): Promise<McpCallResult> {
    const task = this.#tail.then(
      () => this.#executeWithContext(name, arguments_, signal, context),
      () => this.#executeWithContext(name, arguments_, signal, context)
    );
    this.#tail = task.then(() => undefined, () => undefined);
    return task;
  }

  async #executeWithContext(
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    context: BridgeToolCallContext | undefined
  ): Promise<McpCallResult> {
    this.#activeContext = context;
    this.#activePageIds = new Set<string>();
    try {
      if (context !== undefined && (
        !Number.isSafeInteger(context.providerGeneration) || (context.providerGeneration ?? 0) < 1 ||
        !/^[a-f0-9]{64}$/u.test(context.requestIdentity ?? "") ||
        !/^[a-f0-9]{64}$/u.test(context.effectIdentity ?? "") ||
        !/^sha256:[a-f0-9]{64}$/u.test(context.requestBodyHash ?? "")
      )) throw new Error("Browser bridge request authority is invalid.");
      this.#assertSessionContext();
      const result = await this.#execute(name, arguments_, signal);
      this.#assertSessionContext();
      for (const pageId of this.#activePageIds) this.#assertPageContext(pageId);
      return result;
    } finally {
      this.#activeContext = undefined;
      this.#activePageIds = new Set<string>();
    }
  }

  async #execute(
    name: string,
    input: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined
  ): Promise<McpCallResult> {
    signal?.throwIfAborted();
    assertKnownArguments(name, input);
    switch (name) {
      case "list_tools": {
        const category = optionalEnum(input, "category", ["browser"] as const);
        if (category === undefined) {
          return publicTextResult({
            ok: true,
            categories: [{ name: "browser", tool_count: 1 }],
            hint: "Call list_tools with category 'browser' to discover its nested tool and shared rules."
          });
        }
        const nested = BROWSER_RUNTIME_TOOLS[0];
        if (nested === undefined || nested.name !== "browser") throw new Error("Browser nested catalog is unavailable.");
        return publicTextResult({
          ok: true,
          category,
          tools: [{
            name: nested.name,
            description: nested.description,
            rules: ["browser-workflow", "recipe-author"]
          }],
          rules: {
            "browser-workflow": BROWSER_WORKFLOW_RULES,
            "recipe-author": BROWSER_RECIPE_AUTHOR_RULES
          },
          hint: "Call call_tool with the discovered name and an args object. Each rule body is bundled once in the top-level rules map."
        });
      }
      case "call_tool": {
        const nestedName = requiredString(input, "name", 128);
        const args = requiredRecord(input, "args");
        if (nestedName !== "browser") {
          return publicTextResult({
            ok: false,
            errorCode: "UNKNOWN_TOOL",
            data: { requested: nestedName, available: ["browser"], hint: "Call list_tools to discover nested tools." }
          }, true);
        }
        try {
          const result = await this.#execute("browser", args, signal);
          return { content: result.content, isError: result.isError };
        } catch (error) {
          return publicTextResult({
            ok: false,
            errorCode: "INVALID_ARGS",
            data: {
              tool: "browser",
              validation_errors: [error instanceof Error ? error.message : String(error)],
              schema: unifiedSchema,
              hint: "Correct the arguments using the schema and retry."
            }
          }, true);
        }
      }
      case "browser":
        return this.#executeUnified(input, signal);
      case "list_pages":
        return this.#withLease(async () => textResult({ pages: (await this.#listVisiblePages()).map(publicPage) }));
      case "open_page": {
        const candidate = optionalString(input, "url", 8_192);
        const url = candidate === undefined ? undefined : agentUrl(candidate);
        return this.#openOwnedPage(url, undefined, (page) => textResult({ page: publicPage(page) }));
      }
      case "snapshot": {
        const pageId = requiredString(input, "page_id", 512);
        this.#assertPageContext(pageId);
        return this.#withLease(async (lease) => {
          const snapshot = await this.#browser.snapshot(pageId, lease);
          const screenshot = boundedInlineBytes(snapshot.screenshot, "Browser snapshot screenshot");
          await this.#recordScreenshot(pageId, screenshot);
          return {
            content: [
              { type: "text", text: JSON.stringify({ page: publicPage(snapshot.page), accessibility: snapshot.aria }) },
              { type: "image", data: Buffer.from(screenshot).toString("base64"), mimeType: "image/png" }
            ],
            structuredContent: { page: publicPage(snapshot.page), accessibility: snapshot.aria },
            isError: false
          };
        });
      }
      case "screenshot": {
        const pageId = requiredString(input, "page_id", 512);
        this.#assertPageContext(pageId);
        const fullPage = optionalBoolean(input, "full_page");
        return this.#withLease(async (lease) => {
          const screenshot = boundedInlineBytes(
            await this.#browser.captureScreenshot(pageId, lease, fullPage === undefined ? {} : { fullPage }),
            "Browser screenshot"
          );
          await this.#recordScreenshot(pageId, screenshot);
          return {
            content: [{ type: "image", data: Buffer.from(screenshot).toString("base64"), mimeType: "image/png" }],
            structuredContent: {
              media_type: "image/png",
              byte_size: screenshot.byteLength,
              full_page: fullPage ?? false
            },
            isError: false
          };
        });
      }
      case "pdf": {
        const pageId = requiredString(input, "page_id", 512);
        this.#assertPageContext(pageId);
        return this.#withLease(async (lease) => {
          const pdf = boundedInlineBytes(await this.#browser.capturePdf(pageId, lease), "Browser PDF");
          const data = Buffer.from(pdf).toString("base64");
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ media_type: "application/pdf", encoding: "base64", data })
            }],
            structuredContent: {
              media_type: "application/pdf",
              encoding: "base64",
              byte_size: pdf.byteLength
            },
            isError: false
          };
        });
      }
      case "console_messages": {
        const pageId = requiredString(input, "page_id", 512);
        this.#assertPageContext(pageId);
        const limit = optionalInteger(input, "limit", 1, MAXIMUM_DIAGNOSTIC_READ_LIMIT);
        return this.#withLease(async (lease) => textResult({
          messages: (await this.#browser.readConsoleMessages(
            pageId,
            lease,
            limit === undefined ? {} : { limit }
          )).map(publicConsoleMessage)
        }));
      }
      case "http_requests": {
        const pageId = requiredString(input, "page_id", 512);
        this.#assertPageContext(pageId);
        const limit = optionalInteger(input, "limit", 1, MAXIMUM_DIAGNOSTIC_READ_LIMIT);
        return this.#withLease(async (lease) => textResult({
          requests: (await this.#browser.readHttpRequestSummaries(
            pageId,
            lease,
            limit === undefined ? {} : { limit }
          )).map(publicHttpRequestSummary)
        }));
      }
      case "navigate":
        return this.#act(input, { type: "navigate", url: agentUrl(requiredString(input, "url", 8_192)) });
      case "click":
        return this.#act(input, { type: "click", selector: agentSelector(input) });
      case "double_click":
        return this.#act(input, { type: "doubleClick", selector: agentSelector(input) });
      case "right_click":
        return this.#act(input, { type: "rightClick", selector: agentSelector(input) });
      case "hover":
        return this.#act(input, { type: "hover", selector: agentSelector(input) });
      case "drag":
        return this.#act(input, {
          type: "drag",
          sourceSelector: requiredString(input, "source_selector", 4_096),
          targetSelector: requiredString(input, "target_selector", 4_096)
        });
      case "type_text": {
        const selector = agentWritableSelector(input);
        return this.#act(input, {
          type: "type",
          selector,
          text: requiredString(input, "text", MAXIMUM_ACTION_TEXT_LENGTH, true),
          ...(input["submit"] === undefined ? {} : { submit: requiredBoolean(input, "submit") })
        });
      }
      case "fill":
        return this.#act(input, {
          type: "fill",
          selector: agentWritableSelector(input),
          text: requiredString(input, "text", MAXIMUM_ACTION_TEXT_LENGTH, true)
        });
      case "press":
        return this.#act(input, { type: "press", key: agentKey(input) });
      case "hotkey":
        {
          const modifiers = optionalModifiers(input, "modifiers");
          return this.#act(input, {
            type: "hotkey",
            key: agentKey(input),
            ...(modifiers === undefined ? {} : { modifiers })
          });
        }
      case "scroll":
        return this.#act(input, {
          type: "scroll",
          deltaX: requiredBoundedNumber(input, "delta_x", MAXIMUM_SCROLL_DELTA),
          deltaY: requiredBoundedNumber(input, "delta_y", MAXIMUM_SCROLL_DELTA)
        });
      case "resize":
        return this.#act(input, {
          type: "resize",
          width: requiredInteger(input, "width", 1, MAXIMUM_VIEWPORT_EDGE),
          height: requiredInteger(input, "height", 1, MAXIMUM_VIEWPORT_EDGE)
        });
      case "wait":
        return this.#act(input, {
          type: "wait",
          milliseconds: requiredInteger(input, "milliseconds", 0, MAXIMUM_WAIT_MILLISECONDS)
        });
      case "select_option":
        return this.#act(input, {
          type: "select",
          selector: agentSelector(input),
          value: requiredString(input, "value", 16_384, true)
        });
      case "go_back":
        return this.#act(input, { type: "back" });
      case "reload":
        return this.#act(input, { type: "reload" });
      case "close_page": {
        const pageId = requiredString(input, "page_id", 512);
        return this.#closeOwnedPage(pageId, () => textResult({ closed_page_id: pageId }));
      }
      case "upload_artifact": {
        const pageId = requiredString(input, "page_id", 512);
        this.#assertPageContext(pageId);
        const selector = agentSelector(input);
        const artifactId = requiredString(input, "artifact_id", 512);
        const artifact = await this.#artifacts.get(artifactId);
        const transfer = await this.#transfers.upload(artifact, pageId, selector, {
          id: `pi-browser:${this.generation}`
        });
        this.#assertPageContext(pageId);
        return textResult({ transfer: publicTransfer(transfer) });
      }
      case "list_transfers": {
        const pageId = optionalString(input, "page_id", 512);
        if (pageId !== undefined) this.#assertPageContext(pageId);
        const visiblePageIds = pageId === undefined && this.#activeContext !== undefined
          ? new Set((await this.#listVisiblePages()).map((page) => page.id))
          : undefined;
        return textResult({
          transfers: this.#transfers.list(pageId === undefined ? {} : { pageId })
            .filter((transfer) => visiblePageIds === undefined || visiblePageIds.has(transfer.pageId))
            .map(publicTransfer)
        });
      }
      default:
        throw new Error("Browser bridge tool is not available in this generation.");
    }
  }

  async #executeUnified(
    input: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined
  ): Promise<McpCallResult> {
    signal?.throwIfAborted();
    const action = requiredEnum(input, "action", unifiedActions);
    if (input["target"] === "node") return this.#executeRemote(action, input, signal);
    assertUnifiedRoute(input, this.#browser.targetMode);
    switch (action) {
      case "doctor": {
        const pages = this.#browser.running ? await this.#listVisiblePages() : [];
        return browserResult(action, {
          healthy: this.#browser.running,
          running: this.#browser.running,
          generation: this.#browser.generation,
          target: this.#browser.targetMode,
          pageCount: pages.length,
          ...(this.#browser.running ? {} : { fix: "Call action=start, then open an HTTP(S) page." })
        });
      }
      case "status":
        return browserResult(action, {
          running: this.#browser.running,
          generation: this.#browser.generation,
          target: this.#browser.targetMode,
          pages: this.#browser.running ? (await this.#listVisiblePages()).map(publicPage) : []
        });
      case "start":
        await this.#browser.start();
        return browserResult(action, { running: true, generation: this.#browser.generation, target: this.#browser.targetMode });
      case "stop":
        await this.#assertNoForeignLivePages();
        await this.#browser.stop();
        return browserResult(action, { running: false, generation: this.#browser.generation, target: this.#browser.targetMode });
      case "profiles":
        return browserResult(action, {
          profiles: [
            { name: "sidebar", target: "sandbox", active: this.#browser.targetMode === "sidebar" },
            { name: "external", target: "host", active: this.#browser.targetMode === "external" }
          ],
          nodes: (this.#remoteNodes?.list() ?? []).map((node) => ({
            id: node.id,
            generation: node.generation,
            available: node.available,
            capabilities: [...node.capabilities].sort()
          }))
        });
      case "tabs":
        return browserResult(action, { tabs: (await this.#listVisiblePages()).map(publicPage) });
      case "open": {
        const candidate = optionalString(input, "url", 8_192);
        const label = optionalString(input, "label", 256);
        return this.#openOwnedPage(
          candidate === undefined ? undefined : agentUrl(candidate),
          label,
          (page) => browserResult(action, { tab: publicPage(page) })
        );
      }
      case "focus": {
        const pageId = this.#unifiedPageId(input);
        return this.#withLease(async (lease) => browserResult(action, {
          tab: publicPage(await this.#browser.focusPage(pageId, lease))
        }));
      }
      case "close": {
        const pageId = this.#unifiedPageId(input);
        return this.#closeOwnedPage(pageId, () => browserResult(action, { closedTargetId: pageId }));
      }
      case "snapshot": {
        const pageId = this.#unifiedPageId(input);
        return this.#withLease(async (lease) => {
          const snapshot = await this.#browser.snapshot(pageId, lease, {
            ...(input["fullPage"] === undefined ? {} : { fullPage: requiredBoolean(input, "fullPage") }),
            ...(input["selector"] === undefined ? {} : { selector: requiredString(input, "selector", 4_096) }),
            ...(input["interactive"] === undefined ? {} : { interactive: requiredBoolean(input, "interactive") }),
            ...(input["compact"] === undefined ? {} : { compact: requiredBoolean(input, "compact") }),
            ...(input["depth"] === undefined ? {} : { depth: requiredInteger(input, "depth", 0, 64) }),
            ...(input["labels"] === undefined ? {} : { labels: requiredBoolean(input, "labels") }),
            ...(input["urls"] === undefined ? {} : { urls: requiredBoolean(input, "urls") }),
            ...(input["maxChars"] === undefined ? {} : { maxChars: requiredInteger(input, "maxChars", 0, 200_000) }),
            ...(input["timeoutMs"] === undefined ? {} : { timeoutMs: requiredInteger(input, "timeoutMs", 1, MAXIMUM_WAIT_MILLISECONDS) }),
            ...(input["frame"] === undefined ? {} : { frame: requiredString(input, "frame", 4_096) })
          });
          const screenshot = boundedInlineBytes(snapshot.screenshot, "Browser snapshot screenshot");
          await this.#recordScreenshot(pageId, screenshot);
          return browserMixedResult(action, {
            page: publicPage(snapshot.page),
            snapshot: snapshot.aria
          }, [{ type: "image", data: Buffer.from(screenshot).toString("base64"), mimeType: "image/png" }]);
        });
      }
      case "screenshot": {
        const pageId = this.#unifiedPageId(input);
        const type = optionalEnum(input, "type", ["png", "jpeg"] as const) ?? "png";
        const target = unifiedElementTarget(input);
        const selector = hasElementTarget(target) ? this.#browser.resolveElementSelector(pageId, target) : undefined;
        return this.#withLease(async (lease) => {
          const bytes = boundedInlineBytes(await this.#browser.captureScreenshot(pageId, lease, {
            ...(input["fullPage"] === undefined ? {} : { fullPage: requiredBoolean(input, "fullPage") }),
            ...(selector === undefined ? {} : { selector }),
            ...(input["labels"] === undefined ? {} : { labels: requiredBoolean(input, "labels") }),
            type
          }), "Browser screenshot");
          const mimeType = type === "jpeg" ? "image/jpeg" : "image/png";
          await this.#recordScreenshot(pageId, bytes, mimeType);
          return browserMixedResult(action, { targetId: pageId, mediaType: mimeType, byteSize: bytes.byteLength }, [{
            type: "image", data: Buffer.from(bytes).toString("base64"), mimeType
          }]);
        });
      }
      case "navigate":
        return this.#unifiedActResult(action, input, {
          type: "navigate",
          url: agentUrl(requiredString(input, "url", 8_192))
        });
      case "console": {
        const pageId = this.#unifiedPageId(input);
        return this.#withLease(async (lease) => browserResult(action, {
          messages: (await this.#browser.readConsoleMessages(pageId, lease, {
            ...(input["limit"] === undefined ? {} : { limit: requiredInteger(input, "limit", 1, MAXIMUM_DIAGNOSTIC_READ_LIMIT) }),
            ...(input["filter"] === undefined ? {} : { filter: requiredString(input, "filter", 4_096, true) }),
            ...(input["level"] === undefined ? {} : { level: requiredString(input, "level", 32) }),
            ...(input["clear"] === undefined ? {} : { clear: requiredBoolean(input, "clear") })
          })).map(publicConsoleMessage)
        }));
      }
      case "pdf": {
        const pageId = this.#unifiedPageId(input);
        return this.#withLease(async (lease) => {
          const pdf = await this.#browser.capturePdf(pageId, lease);
          const artifact = await this.#artifacts.ingestBytes(pdf, {
            fileName: `${pageId}.pdf`, mimeType: "application/pdf", expiresAt: Date.now() + 24 * 60 * 60_000
          });
          return browserResult(action, { artifact: publicArtifact(artifact), mediaType: "application/pdf" });
        });
      }
      case "upload": {
        const pageId = this.#unifiedPageId(input);
        const artifactIds = requiredStringArray(input, "paths", 16, 512);
        const selector = this.#browser.resolveElementSelector(pageId, unifiedElementTarget(input, "inputRef"));
        const uploaded = [];
        for (const artifactId of artifactIds) {
          signal?.throwIfAborted();
          const artifact = await this.#artifacts.get(artifactId);
          const transfer = await this.#transfers.upload(artifact, pageId, selector, { id: `pi-browser:${this.generation}` });
          uploaded.push(publicTransfer(transfer));
        }
        this.#assertPageContext(pageId);
        return browserResult(action, { transfers: uploaded });
      }
      case "dialog": {
        const pageId = this.#unifiedPageId(input);
        return this.#withLease(async (lease) => {
          if (input["accept"] === undefined) {
            return browserResult(action, { dialogs: await this.#browser.listDialogs(pageId, lease) });
          }
          await this.#browser.handleDialog(pageId, lease, {
            dialogId: optionalString(input, "dialogId", 256),
            accept: requiredBoolean(input, "accept"),
            promptText: optionalString(input, "promptText", MAXIMUM_ACTION_TEXT_LENGTH)
          });
          return browserResult(action, { handled: true });
        });
      }
      case "act":
        return this.#executeUnifiedAct(input, signal);
      case "requests": {
        const pageId = this.#unifiedPageId(input);
        return this.#withLease(async (lease) => browserResult(action, {
          requests: (await this.#browser.readHttpRequestSummaries(pageId, lease, {
            ...(input["limit"] === undefined ? {} : { limit: requiredInteger(input, "limit", 1, MAXIMUM_DIAGNOSTIC_READ_LIMIT) }),
            ...(input["filter"] === undefined ? {} : { filter: requiredString(input, "filter", 4_096, true) }),
            ...(input["clear"] === undefined ? {} : { clear: requiredBoolean(input, "clear") })
          })).map(publicHttpRequestSummary)
        }));
      }
      case "responseBody": {
        const pageId = this.#unifiedPageId(input);
        return this.#withLease(async (lease) => browserResult(action, await this.#browser.readResponseBody(
          pageId,
          lease,
          requiredString(input, "url", 4_096),
          input["maxChars"] === undefined ? undefined : requiredInteger(input, "maxChars", 0, 200_000),
          input["timeoutMs"] === undefined ? undefined : requiredInteger(input, "timeoutMs", 1, MAXIMUM_WAIT_MILLISECONDS),
          signal
        )));
      }
      case "extract": {
        const pageId = this.#unifiedPageId(input);
        const spec = requiredRecord(input, "extract") as unknown as BrowserExtractSpec;
        return this.#withLease(async (lease) => browserResult(action, await this.#browser.extract(
          pageId,
          lease,
          spec,
          input["timeoutMs"] === undefined ? undefined : requiredInteger(input, "timeoutMs", 1, MAXIMUM_WAIT_MILLISECONDS),
          optionalString(input, "frame", 4_096)
        )));
      }
      case "recipe":
        return this.#runRecipe(input, signal);
      case "siteguide":
        return this.#readSiteGuide(input);
      case "saveRecipe":
        return this.#saveRecipe(input);
    }
  }

  async #executeUnifiedAct(
    input: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined
  ): Promise<McpCallResult> {
    const request = requiredRecord(input, "request");
    const kind = requiredEnum(request, "kind", actKinds);
    const pageId = request["targetId"] === undefined
      ? this.#unifiedPageId(input)
      : this.#browser.resolvePageId(requiredString(request, "targetId", 512));
    this.#assertPageContext(pageId);
    const target = unifiedElementTarget(request);
    switch (kind) {
      case "click": {
        const selector = this.#browser.resolveElementSelector(pageId, target);
        const modifiers = optionalModifiers(request, "modifiers");
        return this.#unifiedActResult("act", { targetId: pageId }, {
          type: "click",
          selector,
          ...(request["button"] === undefined ? {} : {
            button: requiredEnum(request, "button", ["left", "middle", "right"] as const)
          }),
          ...(request["doubleClick"] === undefined ? {} : { doubleClick: requiredBoolean(request, "doubleClick") }),
          ...(modifiers === undefined ? {} : { modifiers })
        });
      }
      case "clickCoords":
        return this.#unifiedActResult("act", { targetId: pageId }, {
          type: "clickCoords",
          x: requiredBoundedNumber(request, "x", MAXIMUM_VIEWPORT_EDGE),
          y: requiredBoundedNumber(request, "y", MAXIMUM_VIEWPORT_EDGE),
          button: optionalEnum(request, "button", ["left", "middle", "right"] as const),
          ...(request["doubleClick"] === undefined ? {} : { doubleClick: requiredBoolean(request, "doubleClick") })
        });
      case "type":
        return this.#unifiedActResult("act", { targetId: pageId }, {
          type: "type",
          selector: agentWritableResolvedSelector(this.#browser, pageId, target),
          text: requiredString(request, "text", MAXIMUM_ACTION_TEXT_LENGTH, true),
          ...(request["submit"] === undefined ? {} : { submit: requiredBoolean(request, "submit") }),
          ...(request["slowly"] === undefined ? {} : { slowly: requiredBoolean(request, "slowly") }),
          ...(request["delayMs"] === undefined ? {} : { delayMs: requiredInteger(request, "delayMs", 0, 5_000) })
        });
      case "press": {
        const key = agentKey(request);
        const modifiers = optionalModifiers(request, "modifiers");
        return this.#unifiedActResult("act", { targetId: pageId }, modifiers === undefined
          ? {
            type: "press",
            key,
            ...(hasElementTarget(target) ? { selector: this.#browser.resolveElementSelector(pageId, target) } : {})
          }
          : {
            type: "hotkey",
            key,
            modifiers,
            ...(hasElementTarget(target) ? { selector: this.#browser.resolveElementSelector(pageId, target) } : {})
          });
      }
      case "hover":
        return this.#unifiedActResult("act", { targetId: pageId }, {
          type: "hover", selector: this.#browser.resolveElementSelector(pageId, target)
        });
      case "drag": {
        const sourceSelector = this.#browser.resolveElementSelector(pageId, {
          ref: requiredString(request, "startRef", 256)
        });
        const targetSelector = this.#browser.resolveElementSelector(pageId, {
          ref: requiredString(request, "endRef", 256)
        });
        return this.#unifiedActResult("act", { targetId: pageId }, { type: "drag", sourceSelector, targetSelector });
      }
      case "select":
        return this.#unifiedActResult("act", { targetId: pageId }, {
          type: "select",
          selector: this.#browser.resolveElementSelector(pageId, target),
          values: requiredStringArray(request, "values", 100, 16_384, true)
        });
      case "fill": {
        const fields = request["fields"];
        if (fields !== undefined) {
          if (!Array.isArray(fields) || fields.length > 128) throw new Error("Browser fill fields are invalid.");
          const pages = [];
          for (const field of fields) {
            signal?.throwIfAborted();
            if (typeof field !== "object" || field === null || Array.isArray(field)) throw new Error("Browser fill field is invalid.");
            const record = field as Readonly<Record<string, unknown>>;
            const selector = agentWritableResolvedSelector(this.#browser, pageId, unifiedElementTarget(record));
            const text = requiredString(record, "text", MAXIMUM_ACTION_TEXT_LENGTH, true);
            const result = await this.#unifiedActResult("act", { targetId: pageId }, {
              type: "fill", selector, text
            });
            pages.push(result.structuredContent);
          }
          return browserResult("act", { kind, fields: pages.length, page: publicPage((await this.#listVisiblePages()).find((page) => page.id === pageId) ?? invalidPage()) });
        }
        return this.#unifiedActResult("act", { targetId: pageId }, {
          type: "fill",
          selector: agentWritableResolvedSelector(this.#browser, pageId, target),
          text: requiredString(request, "text", MAXIMUM_ACTION_TEXT_LENGTH, true)
        });
      }
      case "resize":
        return this.#unifiedActResult("act", { targetId: pageId }, {
          type: "resize",
          width: requiredInteger(request, "width", 1, MAXIMUM_VIEWPORT_EDGE),
          height: requiredInteger(request, "height", 1, MAXIMUM_VIEWPORT_EDGE)
        });
      case "wait": {
        if (request["fn"] !== undefined) {
          const timeout = request["timeoutMs"] === undefined
            ? 10_000
            : requiredInteger(request, "timeoutMs", 1, MAXIMUM_WAIT_MILLISECONDS);
          const started = Date.now();
          while (true) {
            signal?.throwIfAborted();
            const ready = await this.#withLease((lease) => this.#browser.evaluatePage(
              pageId, lease, requiredString(request, "fn", 64 * 1024), Math.min(2_000, timeout)
            ));
            if (ready === true) return browserResult("act", { kind, ready: true });
            if (Date.now() - started >= timeout) throw new Error("Browser wait predicate timed out.");
            await delay(100, signal);
          }
        }
        return this.#unifiedActResult("act", { targetId: pageId }, {
          type: "wait",
          ...(request["timeMs"] === undefined ? {} : { milliseconds: requiredInteger(request, "timeMs", 0, MAXIMUM_WAIT_MILLISECONDS) }),
          ...(request["selector"] === undefined ? {} : { selector: requiredString(request, "selector", 4_096) }),
          ...(request["url"] === undefined ? {} : { url: requiredString(request, "url", 8_192) }),
          ...(request["textGone"] === undefined ? {} : { textGone: requiredString(request, "textGone", MAXIMUM_ACTION_TEXT_LENGTH) }),
          ...(request["loadState"] === undefined ? {} : {
            loadState: requiredEnum(request, "loadState", ["load", "domcontentloaded", "networkidle"] as const)
          }),
          ...(request["timeoutMs"] === undefined ? {} : {
            timeoutMs: requiredInteger(request, "timeoutMs", 1, MAXIMUM_WAIT_MILLISECONDS)
          })
        });
      }
      case "evaluate": {
        const result = await this.#withLease((lease) => this.#browser.evaluatePage(
          pageId,
          lease,
          requiredString(request, "fn", 64 * 1024),
          request["timeoutMs"] === undefined ? undefined : requiredInteger(request, "timeoutMs", 1, MAXIMUM_WAIT_MILLISECONDS)
        ));
        return browserResult("act", { kind, result });
      }
      case "saveResource": {
        const resource = await this.#withLease((lease) => this.#browser.captureResource(
          pageId, lease, requiredString(request, "url", 8_192)
        ));
        const artifact = await this.#artifacts.ingestBytes(resource.bytes, {
          fileName: resource.fileName, mimeType: resource.mediaType, expiresAt: Date.now() + 24 * 60 * 60_000
        });
        return browserResult("act", { kind, url: resource.url, artifact: publicArtifact(artifact) });
      }
      case "close":
        return this.#closeOwnedPage(pageId, () => browserResult("act", { kind, closedTargetId: pageId }));
    }
  }

  async #executeRemote(
    action: BrowserAutomationAction,
    input: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined
  ): Promise<McpCallResult> {
    const nodeId = requiredString(input, "node", 512);
    const route = await this.#remoteNodes?.resolve(nodeId);
    if (route === undefined || route.id !== nodeId || !route.available) {
      throw new Error("Requested remote Browser node is unavailable.");
    }
    if (!Number.isSafeInteger(route.generation) || route.generation < 1) {
      throw new Error("Remote Browser node generation is invalid.");
    }
    const generation = route.generation;
    if (!route.capabilities.has(`action:${action}`)) {
      throw new Error(`Remote Browser node does not advertise action:${action}.`);
    }
    const actKind = validateRemoteBrowserInput(action, input);
    if (actKind !== undefined && !route.capabilities.has(`act:${actKind}`)) {
      throw new Error(`Remote Browser node does not advertise act:${actKind}.`);
    }
    if (containsSemanticQuery(input) && !route.capabilities.has("semantic-query")) {
      throw new Error("Remote Browser node does not advertise semantic-query.");
    }
    if (action === "upload" && !route.capabilities.has("artifact-upload")) {
      throw new Error("Remote Browser node does not advertise artifact-upload.");
    }
    const remoteProviderId = remoteBrowserAuthorityId(nodeId);
    const context = this.#activeContext;
    if (context !== undefined && action === "stop") {
      throw new Error("A Session-scoped call cannot stop a shared remote Browser node.");
    }
    const pageId = context === undefined ? undefined : scopedRemotePageId(action, input);
    if (pageId !== undefined) this.#assertRemotePageContext(remoteProviderId, pageId, generation);

    if (context !== undefined && action === "open") {
      if (this.#state === undefined) throw new Error("Browser product authority is unavailable.");
      const authority = this.#bridgeEffectAuthority(remoteProviderId, generation);
      const claim = this.#state.claimBrowserPageOpen<McpCallResult>(authority);
      if (claim.replayed) {
        if (claim.value === undefined) throw new Error("Browser page effect replay is incomplete.");
        return claim.value;
      }
      try {
        const result = await route.call({ action, arguments: copyRemoteArguments(input) }, signal);
        this.#assertRemoteRoute(route, generation);
        if (!result.ok) throw remoteBrowserFailure();
        if (result.binary !== undefined) throw new Error("Remote Browser open returned an unexpected binary result.");
        this.#assertSessionContext();
        const page = remoteOpenedPage(result.data);
        const value = await this.#remoteResult(action, nodeId, generation, route, result, result.data);
        return this.#state.completeBrowserPageOpen(claim, authority, {
          browserProviderId: remoteProviderId,
          pageId: page.id,
          generation,
          sessionId: context.sessionId,
          targetId: context.targetId,
          bindingGeneration: context.generation,
          url: validateTakeoverNavigationUrl(page.url),
          title: page.title,
          updatedAt: Date.now()
        }, value);
      } catch (error) {
        try { this.#state.failBrowserPageOpen(claim); } catch { /* Preserve the original bounded failure. */ }
        throw error;
      }
    }

    const result = await route.call({ action, arguments: copyRemoteArguments(input) }, signal);
    this.#assertRemoteRoute(route, generation);
    if (context !== undefined) {
      this.#assertSessionContext();
      if (pageId !== undefined) {
        this.#assertRemotePageContext(remoteProviderId, pageId, generation);
        if (result.ok && (action === "close" || remoteActClosesPage(action, input))) {
          this.#state?.closeHumanPage(remoteProviderId, pageId, generation);
        }
      }
    }
    const projected = context === undefined
      ? result.data
      : this.#projectRemoteOwnedData(action, result.data, remoteProviderId, generation);
    return this.#remoteResult(action, nodeId, generation, route, result, projected);
  }

  #assertRemoteRoute(
    route: BrowserRemoteNodeRoute,
    generation: number
  ): void {
    if (!route.available || route.generation !== generation) {
      throw new Error("Remote Browser node was fenced during the action.");
    }
  }

  #assertRemotePageContext(
    browserProviderId: string,
    pageId: string,
    browserGeneration: number
  ): RecoverableBrowserPageRecord {
    const context = this.#activeContext;
    if (context === undefined || this.#state === undefined) {
      throw new Error("Remote Browser page authority is unavailable.");
    }
    return this.#state.assertPageAuthority({
      browserProviderId,
      pageId,
      browserGeneration,
      sessionId: context.sessionId,
      targetId: context.targetId,
      bindingGeneration: context.generation
    });
  }

  #projectRemoteOwnedData(
    action: BrowserAutomationAction,
    data: unknown,
    browserProviderId: string,
    browserGeneration: number
  ): unknown {
    if (!isRecord(data)) return data;
    const listKey = action === "tabs" ? "tabs" : action === "status" ? "pages" : undefined;
    if (listKey !== undefined) {
      const candidates = Array.isArray(data[listKey]) ? data[listKey] : [];
      const visible = candidates.filter((candidate) => {
        if (!isRecord(candidate) || typeof candidate["id"] !== "string") return false;
        try {
          this.#assertRemotePageContext(browserProviderId, candidate["id"], browserGeneration);
          return true;
        } catch {
          return false;
        }
      });
      return { ...data, [listKey]: visible };
    }
    if (action === "doctor") {
      return { ...data, pageCount: this.#ownedRemotePageCount(browserProviderId, browserGeneration) };
    }
    return data;
  }

  #ownedRemotePageCount(browserProviderId: string, browserGeneration: number): number {
    const context = this.#activeContext;
    if (context === undefined || this.#state === undefined) return 0;
    return this.#state.recoverablePages(browserProviderId, new Set()).filter((page) =>
      page.generation === browserGeneration &&
      page.sessionId === context.sessionId &&
      page.targetId === context.targetId &&
      page.bindingGeneration === context.generation
    ).length;
  }

  async #remoteResult(
    action: BrowserAutomationAction,
    nodeId: string,
    generation: number,
    route: BrowserRemoteNodeRoute,
    result: BrowserRemoteAutomationResult,
    data: unknown
  ): Promise<McpCallResult> {
    if (!result.ok) {
      return browserError(action, {
        node: nodeId,
        generation,
        errorCode: safeRemoteLabel(result.errorCode, "REMOTE_BROWSER_ACTION_FAILED"),
        message: redactModelText(result.message ?? "Remote Browser action failed.")
      });
    }
    if (result.binary === undefined) {
      return browserResult(action, { node: nodeId, generation, result: data });
    }
    if (!route.capabilities.has("binary-result")) {
      throw new Error("Remote Browser node returned binary data without advertising binary-result.");
    }
    const bytes = boundedInlineBytes(result.binary.bytes, "Remote Browser binary result");
    if (result.binary.mediaType === "image/png" || result.binary.mediaType === "image/jpeg") {
      return browserMixedResult(action, {
        node: nodeId,
        generation,
        result: data,
        mediaType: result.binary.mediaType,
        byteSize: bytes.byteLength
      }, [{ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: result.binary.mediaType }]);
    }
    const artifact = await this.#artifacts.ingestBytes(bytes, {
      fileName: sanitizeRemoteFileName(result.binary.fileName, result.binary.mediaType),
      mimeType: result.binary.mediaType,
      expiresAt: Date.now() + 24 * 60 * 60_000
    });
    return browserResult(action, {
      node: nodeId,
      generation,
      result: data,
      artifact: publicArtifact(artifact)
    });
  }

  async #unifiedActResult(
    action: string,
    input: Readonly<Record<string, unknown>>,
    browserAction: Parameters<BrowserProvider["act"]>[2]
  ): Promise<McpCallResult> {
    const pageId = this.#unifiedPageId(input);
    return this.#withLease(async (lease) => browserResult(action, {
      page: publicPage(await this.#browser.act(pageId, lease, browserAction))
    }));
  }

  #unifiedPageId(input: Readonly<Record<string, unknown>>): string {
    const pageId = this.#browser.resolvePageId(optionalString(input, "targetId", 512), optionalString(input, "label", 256));
    this.#assertPageContext(pageId);
    return pageId;
  }

  async #runRecipe(input: Readonly<Record<string, unknown>>, signal: AbortSignal | undefined): Promise<McpCallResult> {
    const id = requiredString(input, "recipeId", 256);
    const recipe = this.#recipes.get(id);
    if (recipe === undefined) throw new Error(`Unknown browser recipe '${id}'.`);
    const vars: Record<string, unknown> = { ...(optionalRecord(input, "inputs") ?? {}) };
    for (const [name, spec] of Object.entries(recipe.inputs ?? {})) {
      if (spec.required === true && (vars[name] === undefined || vars[name] === null)) {
        throw new Error(`Browser recipe is missing required input '${name}'.`);
      }
    }
    const completed: Array<{ action: string; ok: boolean }> = [];
    for (let index = 0; index < recipe.steps.length; index += 1) {
      signal?.throwIfAborted();
      const step = recipe.steps[index]!;
      try {
        let result: McpCallResult;
        if (step.action === "evaluate" && this.#recipeProvenance(id) === "builtin") {
          if (step.fn === undefined) throw new Error("Browser recipe evaluate step requires fn.");
          const pageId = this.#unifiedPageId(input);
          const source = interpolateRecipe(step.fn, vars);
          const value = await this.#withLease((lease) => this.#browser.evaluateBundledRecipe(
            pageId,
            lease,
            source,
            step.timeoutMs
          ));
          result = browserResult("act", { kind: "evaluate", result: value });
        } else {
          const call = recipeStepInput(step, vars, input);
          result = await this.#executeUnified(call, signal);
        }
        completed.push({ action: step.action, ok: !result.isError });
        if (step.as !== undefined) vars[step.as] = recipeStepValue(step, result);
      } catch (error) {
        completed.push({ action: step.action, ok: false });
        if (step.optional === true) continue;
        return browserError("recipe", {
          recipe: id,
          steps: completed,
          failedStep: index,
          failedAction: step.action,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return browserResult("recipe", {
      recipe: id,
      provenance: this.#recipeProvenance(id),
      steps: completed,
      ...(recipe.output === undefined ? {} : { output: resolveRecipeOutput(recipe.output, vars) })
    });
  }

  #readSiteGuide(input: Readonly<Record<string, unknown>>): McpCallResult {
    const site = optionalString(input, "site", 256);
    if (site === undefined) {
      const guided = new Set([...this.#siteGuides.values()].flatMap((guide) => [...(guide.recipes ?? [])]));
      return browserResult("siteguide", {
        sites: [...this.#siteGuides.values()].map((guide) => ({
          site: guide.site,
          provenance: this.#siteGuideProvenance(guide.site),
          auth: guide.auth,
          recipes: (guide.recipes ?? []).map((id) => ({
            ...recipeSummary(this.#recipes.get(id), id), provenance: this.#recipeProvenance(id)
          }))
        })).sort((left, right) => left.site.localeCompare(right.site)),
        recipesWithoutGuide: [...this.#recipes.values()]
          .filter((recipe) => !guided.has(recipe.id))
          .map((recipe) => ({ ...recipeSummary(recipe, recipe.id), provenance: this.#recipeProvenance(recipe.id) }))
      });
    }
    const guide = this.#siteGuides.get(site);
    if (guide === undefined) throw new Error(`No browser site guide exists for '${site}'.`);
    return browserResult("siteguide", {
      provenance: this.#siteGuideProvenance(site),
      data: guide,
      recipes: (guide.recipes ?? []).map((id) => ({
        ...recipeSummary(this.#recipes.get(id), id), provenance: this.#recipeProvenance(id)
      }))
    });
  }

  async #saveRecipe(input: Readonly<Record<string, unknown>>): Promise<McpCallResult> {
    const site = requiredString(input, "site", 256);
    const recipe = validateRecipe(requiredRecord(input, "recipeDraft"));
    validateUserRecipeSafety(recipe);
    const guideValue = optionalRecord(input, "siteGuideDraft");
    const guide = guideValue === undefined ? undefined : validateSiteGuide(guideValue);
    if (guide !== undefined && guide.site !== site) throw new Error("Browser site guide must match the requested site.");
    await this.#userKnowledge?.save({
      site,
      recipe: recipe as unknown as Readonly<Record<string, unknown>>,
      ...(guide === undefined ? {} : { siteGuide: guide as Readonly<Record<string, unknown>> })
    });
    this.#recipes.set(recipe.id, recipe);
    this.#userRecipeIds.add(recipe.id);
    if (guide !== undefined) {
      this.#siteGuides.set(site, guide);
      this.#userSiteGuideIds.add(site);
    }
    return browserResult("saveRecipe", {
      saved: true,
      site,
      recipeId: recipe.id,
      provenance: this.#recipeProvenance(recipe.id)
    });
  }

  #recipeProvenance(id: string): "builtin" | "user" | "overridden" {
    if (this.#userRecipeIds.has(id)) return this.#builtinRecipeIds.has(id) ? "overridden" : "user";
    return "builtin";
  }

  #siteGuideProvenance(site: string): "builtin" | "user" | "overridden" {
    if (this.#userSiteGuideIds.has(site)) return this.#builtinSiteGuideIds.has(site) ? "overridden" : "user";
    return "builtin";
  }

  async #act(
    input: Readonly<Record<string, unknown>>,
    action: Parameters<BrowserProvider["act"]>[2]
  ): Promise<McpCallResult> {
    const pageId = requiredString(input, "page_id", 512);
    this.#assertPageContext(pageId);
    return this.#withLease(async (lease) => textResult({
      page: publicPage(await this.#browser.act(pageId, lease, action))
    }));
  }

  async #recordScreenshot(pageId: string, screenshot: Uint8Array, mimeType = "image/png"): Promise<void> {
    if (this.#state === undefined) return;
    this.#assertPageContext(pageId);
    const capturedAt = Date.now();
    const artifact = await this.#artifacts.ingestBytes(screenshot, {
      fileName: `${pageId}.${mimeType === "image/jpeg" ? "jpg" : "png"}`,
      mimeType,
      expiresAt: capturedAt + 24 * 60 * 60_000
    });
    this.#assertPageContext(pageId);
    this.#state.recordScreenshot({
      browserProviderId: this.#browser.id,
      pageId,
      generation: this.generation,
      artifactId: artifact.id,
      blob: {
        id: artifact.id,
        sha256: artifact.sha256,
        byteLength: artifact.byteLength,
        mimeType: artifact.mimeType,
        ...(artifact.fileName === undefined ? {} : { fileName: artifact.fileName })
      },
      capturedAt
    });
    this.#state.recordActivity({
      at: capturedAt,
      type: "action",
      pageId,
      detail: "screenshot"
    });
  }

  async #withLease<T>(callback: (lease: BrowserLease) => Promise<T>): Promise<T> {
    this.#assertSessionContext();
    for (const pageId of this.#activePageIds) this.#assertPageContext(pageId);
    const leaseOwner = this.#activeContext === undefined
      ? `pi-browser:${randomUUID()}`
      : `pi-browser:${this.#activeContext.requestIdentity!}`;
    const lease = this.#browser.acquireAgentLease(leaseOwner, 60_000);
    try {
      const result = await callback(lease);
      await this.#refreshActivePageDescriptors();
      this.#assertSessionContext();
      for (const pageId of this.#activePageIds) this.#assertPageContext(pageId);
      return result;
    } finally {
      try {
        await this.#browser.releaseAgentLease(lease);
      } catch {
        // Browser recovery intentionally fences stale leases.
      }
    }
  }

  async #startForExplicitOpen(): Promise<void> {
    if (!this.#browser.running) await this.#browser.start();
  }

  #assertSessionContext(): void {
    const context = this.#activeContext;
    if (context === undefined) return;
    if (this.#state === undefined) throw new Error("Browser product authority is unavailable.");
    this.#state.assertSessionAuthority({
      sessionId: context.sessionId,
      targetId: context.targetId,
      bindingGeneration: context.generation
    });
  }

  #assertPageContext(pageId: string): RecoverableBrowserPageRecord | undefined {
    const context = this.#activeContext;
    if (context === undefined) return undefined;
    if (this.#state === undefined) throw new Error("Browser product authority is unavailable.");
    const page = this.#state.assertPageAuthority({
      browserProviderId: this.#browser.id,
      pageId,
      browserGeneration: this.#browser.generation,
      sessionId: context.sessionId,
      targetId: context.targetId,
      bindingGeneration: context.generation
    });
    this.#activePageIds.add(pageId);
    return page;
  }

  async #listVisiblePages(): Promise<readonly BrowserPageState[]> {
    const context = this.#activeContext;
    const generation = this.#browser.generation;
    this.#assertSessionContext();
    const pages = await this.#browser.listPages();
    if (context === undefined) return pages;
    if (this.#state === undefined || this.#browser.generation !== generation) {
      throw new Error("Browser page authority changed during enumeration.");
    }
    const visible = pages.filter((page) => {
      const owner = this.#state?.findRecoverablePage(this.#browser.id, page.id);
      return owner?.generation === generation &&
        owner.sessionId === context.sessionId &&
        owner.targetId === context.targetId &&
        owner.bindingGeneration === context.generation;
    });
    this.#assertSessionContext();
    return visible;
  }

  async #assertNoForeignLivePages(): Promise<void> {
    if (this.#activeContext === undefined || !this.#browser.running) return;
    const generation = this.#browser.generation;
    const all = await this.#browser.listPages();
    const visible = await this.#listVisiblePages();
    if (this.#browser.generation !== generation || all.length !== visible.length) {
      throw new Error("Browser lifecycle action is fenced by another page authority.");
    }
  }

  async #refreshActivePageDescriptors(): Promise<void> {
    const context = this.#activeContext;
    if (context === undefined || this.#activePageIds.size === 0) return;
    if (this.#state === undefined) throw new Error("Browser product authority is unavailable.");
    const generation = this.#browser.generation;
    const pages = await this.#browser.listPages();
    if (this.#browser.generation !== generation) throw new Error("Browser generation changed during page publication.");
    this.#assertSessionContext();
    for (const pageId of this.#activePageIds) {
      const owner = this.#assertPageContext(pageId);
      const page = pages.find((candidate) => candidate.id === pageId);
      if (owner === undefined || page === undefined) throw new Error("Browser page was fenced before publication.");
      this.#state.recordHumanPage({
        browserProviderId: this.#browser.id,
        pageId,
        generation,
        sessionId: owner.sessionId,
        targetId: owner.targetId,
        bindingGeneration: owner.bindingGeneration,
        url: validateTakeoverNavigationUrl(page.url),
        title: page.title,
        updatedAt: Date.now()
      }, { active: this.#state.activePageId(this.#browser.id) === pageId });
    }
  }

  #bridgeEffectAuthority(
    browserProviderId = this.#browser.id,
    providerGeneration = this.#activeContext?.providerGeneration
  ): BrowserBridgeEffectAuthority {
    const context = this.#activeContext;
    if (context === undefined || this.#state === undefined) throw new Error("Browser bridge effect authority is unavailable.");
    return {
      sessionId: context.sessionId,
      targetId: context.targetId,
      bindingGeneration: context.generation,
      requestIdentity: context.requestIdentity!,
      effectIdentity: context.effectIdentity!,
      requestBodyHash: context.requestBodyHash!,
      browserProviderId,
      providerGeneration: providerGeneration!
    };
  }

  async #openOwnedPage(
    url: string | undefined,
    label: string | undefined,
    result: (page: BrowserPageState) => McpCallResult
  ): Promise<McpCallResult> {
    if (this.#activeContext === undefined) {
      await this.#startForExplicitOpen();
      return this.#withLease(async (lease) => result(await this.#browser.createPage(lease, url, label)));
    }
    if (this.#state === undefined) throw new Error("Browser product authority is unavailable.");
    const authority = this.#bridgeEffectAuthority();
    const claim = this.#state.claimBrowserPageOpen<McpCallResult>(authority);
    if (claim.replayed) {
      if (claim.value === undefined) throw new Error("Browser page effect replay is incomplete.");
      return claim.value;
    }
    let page: BrowserPageState | undefined;
    let lease: BrowserLease | undefined;
    let committed = false;
    try {
      await this.#startForExplicitOpen();
      this.#assertSessionContext();
      lease = this.#browser.acquireAgentLease(`pi-browser:${authority.requestIdentity}`, 60_000);
      const browserGeneration = this.#browser.generation;
      page = await this.#browser.createPage(lease, url, label);
      if (this.#browser.generation !== browserGeneration) {
        throw new Error("Browser page generation changed before publication.");
      }
      const value = result(page);
      const completed = this.#state.completeBrowserPageOpen(claim, authority, {
        browserProviderId: this.#browser.id,
        pageId: page.id,
        generation: this.#browser.generation,
        sessionId: authority.sessionId,
        targetId: authority.targetId,
        bindingGeneration: authority.bindingGeneration,
        url: validateTakeoverNavigationUrl(page.url),
        title: page.title,
        updatedAt: Date.now()
      }, value);
      committed = true;
      return completed;
    } catch (error) {
      if (page !== undefined && lease !== undefined) {
        await this.#browser.closePage(page.id, lease).catch(() => undefined);
      }
      if (!committed) {
        try { this.#state.failBrowserPageOpen(claim); } catch { /* Preserve the original bounded failure. */ }
      }
      throw error;
    } finally {
      if (lease !== undefined) await this.#browser.releaseAgentLease(lease).catch(() => undefined);
    }
  }

  async #closeOwnedPage(pageId: string, result: () => McpCallResult): Promise<McpCallResult> {
    this.#assertPageContext(pageId);
    return this.#withLease(async (lease) => {
      await this.#browser.closePage(pageId, lease);
      this.#state?.closeHumanPage(this.#browser.id, pageId, lease.generation);
      this.#activePageIds.delete(pageId);
      this.#assertSessionContext();
      return result();
    });
  }
}

function browserResult(action: string, data: unknown): McpCallResult {
  return browserMixedResult(action, data, []);
}

function browserMixedResult(action: string, data: unknown, extraContent: readonly unknown[]): McpCallResult {
  const payload = { ok: true, action, data: sanitizePublicPayload(data, 0) };
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf8") > MAXIMUM_UNIFIED_RESULT_BYTES) {
    const byteSize = Buffer.byteLength(serialized, "utf8");
    let previewCharacters = Math.min(serialized.length, Math.floor(MAXIMUM_UNIFIED_RESULT_BYTES / 2));
    let limited = truncatedBrowserPayload(action, byteSize, serialized.slice(0, previewCharacters));
    let limitedText = JSON.stringify(limited);
    while (Buffer.byteLength(limitedText, "utf8") > MAXIMUM_UNIFIED_RESULT_BYTES && previewCharacters > 0) {
      previewCharacters = Math.max(0, previewCharacters - Math.ceil(previewCharacters / 8));
      limited = truncatedBrowserPayload(action, byteSize, serialized.slice(0, previewCharacters));
      limitedText = JSON.stringify(limited);
    }
    return {
      content: [{ type: "text", text: limitedText }, ...extraContent],
      structuredContent: limited,
      isError: false
    };
  }
  return {
    content: [{ type: "text", text: serialized }, ...extraContent],
    structuredContent: payload,
    isError: false
  };
}

function truncatedBrowserPayload(action: string, byteSize: number, preview: string): {
  readonly ok: true;
  readonly action: string;
  readonly data: Readonly<Record<string, unknown>>;
} {
  return {
    ok: true,
    action,
    data: { truncated: true, byteSize, limit: MAXIMUM_UNIFIED_RESULT_BYTES, preview }
  };
}

function browserError(action: string, data: Readonly<Record<string, unknown>>): McpCallResult {
  const payload = { ok: false, action, ...sanitizePublicPayload(data, 0) as Readonly<Record<string, unknown>> };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true
  };
}

function sanitizePublicPayload(value: unknown, depth: number): unknown {
  if (depth > 16) return "[truncated depth]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactModelText(value);
  if (Array.isArray(value)) {
    const selected = value.slice(0, 1_000).map((item) => sanitizePublicPayload(item, depth + 1));
    if (value.length > 1_000) selected.push(`[truncated:${value.length - 1_000} items]`);
    return selected;
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    const entries = Object.entries(value);
    for (const [key, item] of entries.slice(0, 1_000)) {
      output[key] = /(?:^|[_-])(?:access|auth|bearer|cookie|credential|jwt|key|password|secret|session|signature|token)(?:$|[_-])/iu.test(key)
        ? "[redacted]"
        : sanitizePublicPayload(item, depth + 1);
    }
    if (entries.length > 1_000) output["[truncated:properties]"] = entries.length - 1_000;
    return output;
  }
  return String(value);
}

function redactModelText(value: string): string {
  let safe = value.replaceAll("\0", "");
  safe = safe.replace(/https?:\/\/[^\s<>"']+/giu, (candidate) => sanitizeBrowserUrlForDisplay(candidate));
  safe = safe.replace(
    /\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]*/giu,
    "[redacted header]"
  );
  safe = safe.replace(/[A-Za-z0-9._~+/=-]{48,}/gu, "[redacted opaque value]");
  safe = safe.replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu, "[redacted authorization]");
  safe = safe.replace(
    /(["']?)(?:access[_-]?token|api[_-]?key|auth|credential|jwt|password|secret|session|signature|token)\1\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)/giu,
    "credential=[redacted]"
  );
  safe = safe.replace(/[A-Za-z]:\\(?:[^\s<>:"|?*]+\\)+[^\s<>:"|?*]*/gu, "[redacted local path]");
  return safe;
}

function publicArtifact(value: {
  readonly id: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mimeType: string;
  readonly fileName?: string;
}): Readonly<Record<string, unknown>> {
  return {
    id: value.id,
    sha256: value.sha256,
    byteSize: value.byteLength,
    mediaType: value.mimeType,
    ...(value.fileName === undefined ? {} : { fileName: value.fileName })
  };
}

function requiredRecord(
  value: Readonly<Record<string, unknown>>,
  key: string
): Readonly<Record<string, unknown>> {
  const candidate = value[key];
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new Error(`Browser tool argument '${key}' is invalid.`);
  }
  return candidate as Readonly<Record<string, unknown>>;
}

function optionalRecord(
  value: Readonly<Record<string, unknown>>,
  key: string
): Readonly<Record<string, unknown>> | undefined {
  return value[key] === undefined ? undefined : requiredRecord(value, key);
}

function requiredStringArray(
  value: Readonly<Record<string, unknown>>,
  key: string,
  maximumItems: number,
  maximumLength: number,
  allowEmpty = false
): readonly string[] {
  const candidate = value[key];
  if (!Array.isArray(candidate) || candidate.length < 1 || candidate.length > maximumItems) {
    throw new Error(`Browser tool argument '${key}' is invalid.`);
  }
  return candidate.map((item) => requiredString({ value: item }, "value", maximumLength, allowEmpty));
}

function requiredEnum<const T extends readonly string[]>(
  value: Readonly<Record<string, unknown>>,
  key: string,
  accepted: T
): T[number] {
  const candidate = requiredString(value, key, 256);
  if (!accepted.includes(candidate)) throw new Error(`Browser tool argument '${key}' is invalid.`);
  return candidate as T[number];
}

function optionalEnum<const T extends readonly string[]>(
  value: Readonly<Record<string, unknown>>,
  key: string,
  accepted: T
): T[number] | undefined {
  return value[key] === undefined ? undefined : requiredEnum(value, key, accepted);
}

function optionalElementQuery(
  value: Readonly<Record<string, unknown>>,
  key: string
): BrowserElementQuery | undefined {
  const record = optionalRecord(value, key);
  if (record === undefined) return undefined;
  const query: BrowserElementQuery = {
    ...(record["css"] === undefined ? {} : { css: requiredString(record, "css", 4_096) }),
    ...(record["role"] === undefined ? {} : { role: requiredString(record, "role", 128) }),
    ...(record["name"] === undefined ? {} : { name: requiredString(record, "name", 2_048) }),
    ...(record["text"] === undefined ? {} : { text: requiredString(record, "text", 2_048) }),
    ...(record["label"] === undefined ? {} : { label: requiredString(record, "label", 2_048) }),
    ...(record["placeholder"] === undefined ? {} : { placeholder: requiredString(record, "placeholder", 2_048) }),
    ...(record["testId"] === undefined ? {} : { testId: requiredString(record, "testId", 2_048) }),
    ...(record["exact"] === undefined ? {} : { exact: requiredBoolean(record, "exact") }),
    ...(record["index"] === undefined ? {} : { index: requiredInteger(record, "index", 0, 10_000) })
  };
  return query;
}

function unifiedElementTarget(
  value: Readonly<Record<string, unknown>>,
  alternateRefKey?: string
): { readonly selector?: string; readonly ref?: string; readonly query?: BrowserElementQuery } {
  return {
    ...(value["selector"] === undefined ? {} : { selector: requiredString(value, "selector", 4_096) }),
    ...(
      value[alternateRefKey ?? "ref"] === undefined
        ? {}
        : { ref: requiredString(value, alternateRefKey ?? "ref", 256) }
    ),
    ...(value["query"] === undefined ? {} : { query: optionalElementQuery(value, "query") })
  };
}

function hasElementTarget(value: { readonly selector?: string; readonly ref?: string; readonly query?: BrowserElementQuery }): boolean {
  return value.selector !== undefined || value.ref !== undefined || value.query !== undefined;
}

function agentWritableResolvedSelector(
  browser: BrowserProvider,
  pageId: string,
  target: { readonly selector?: string; readonly ref?: string; readonly query?: BrowserElementQuery }
): string {
  const selector = browser.resolveElementSelector(pageId, target);
  if (/(?:password|passwd|secret|token|api[-_]?key|credential)/iu.test(selector)) {
    throw new Error("Credential fields require human browser takeover and cannot be filled from model-visible arguments.");
  }
  return selector;
}

function assertUnifiedRoute(input: Readonly<Record<string, unknown>>, current: "sidebar" | "external"): void {
  const profile = optionalString(input, "profile", 256);
  const target = optionalEnum(input, "target", ["sandbox", "host", "node"] as const);
  if (target === "node" || input["node"] !== undefined) throw new Error("Remote Browser node routing is not configured for this provider.");
  const requested = profile === undefined || profile === "default"
    ? target === undefined ? current : target === "sandbox" ? "sidebar" : "external"
    : profile === "sidebar" || profile === "external" ? profile : undefined;
  if (requested === undefined) throw new Error("Browser profile must be default, sidebar, or external.");
  if (requested !== current) throw new Error("Browser profile routing must match the target selected in Automation settings.");
}

function validateRemoteBrowserInput(
  action: BrowserAutomationAction,
  input: Readonly<Record<string, unknown>>
): BrowserAutomationActKind | undefined {
  if (action === "navigate") agentUrl(requiredString(input, "url", 8_192));
  if (action === "open") {
    const value = optionalString(input, "url", 8_192);
    if (value !== undefined) agentUrl(value);
  }
  if (action === "upload") {
    for (const id of requiredStringArray(input, "paths", 16, 512)) {
      if (/[\\/\0]/u.test(id) || /^[A-Za-z]:/u.test(id)) {
        throw new Error("Remote Browser uploads accept artifact IDs, never service-local paths.");
      }
    }
  }
  if (action === "saveRecipe") {
    validateUserRecipeSafety(validateRecipe(requiredRecord(input, "recipeDraft")));
    const guide = optionalRecord(input, "siteGuideDraft");
    if (guide !== undefined) validateSiteGuide(guide);
  }
  if (action !== "act") return undefined;
  const request = requiredRecord(input, "request");
  assertObjectArguments(request, actRequestSchema, "Browser act request");
  const kind = requiredEnum(request, "kind", actKinds);
  if (kind === "evaluate") validateBrowserEvaluateSource(requiredString(request, "fn", 64 * 1024));
  if (kind === "saveResource") validatePublicBrowserResourceUrl(requiredString(request, "url", 8_192));
  if (kind === "type" || kind === "fill") {
    const serialized = JSON.stringify({
      selector: request["selector"],
      ref: request["ref"],
      query: request["query"],
      fields: request["fields"]
    });
    if (/(?:password|passwd|secret|token|api[-_]?key|credential)/iu.test(serialized)) {
      throw new Error("Credential fields require human Browser takeover and cannot be filled by a remote model action.");
    }
  }
  return kind;
}

function remoteBrowserAuthorityId(nodeId: string): string {
  return `browser_node_${createHash("sha256").update(nodeId, "utf8").digest("hex")}`;
}

function scopedRemotePageId(
  action: BrowserAutomationAction,
  input: Readonly<Record<string, unknown>>
): string | undefined {
  switch (action) {
    case "doctor":
    case "status":
    case "start":
    case "stop":
    case "profiles":
    case "tabs":
    case "open":
    case "siteguide":
    case "saveRecipe":
      return undefined;
    case "act": {
      const request = requiredRecord(input, "request");
      const candidate = request["targetId"] ?? input["targetId"];
      if (typeof candidate !== "string") {
        throw new Error("Session-scoped remote Browser actions require an exact targetId.");
      }
      return requiredString({ targetId: candidate }, "targetId", 512);
    }
    case "focus":
    case "close":
    case "snapshot":
    case "screenshot":
    case "navigate":
    case "console":
    case "pdf":
    case "upload":
    case "dialog":
    case "requests":
    case "responseBody":
    case "extract":
    case "recipe":
      if (typeof input["targetId"] !== "string") {
        throw new Error("Session-scoped remote Browser actions require an exact targetId.");
      }
      return requiredString(input, "targetId", 512);
  }
}

function remoteActClosesPage(
  action: BrowserAutomationAction,
  input: Readonly<Record<string, unknown>>
): boolean {
  if (action !== "act") return false;
  const request = input["request"];
  return isRecord(request) && request["kind"] === "close";
}

function remoteOpenedPage(data: unknown): BrowserPageState {
  if (!isRecord(data) || !isRecord(data["tab"])) {
    throw new Error("Remote Browser open did not return a bounded page descriptor.");
  }
  const tab = data["tab"];
  const state = tab["state"];
  if (state !== "ready" && state !== "loading" && state !== "crashed") {
    throw new Error("Remote Browser open returned an invalid page state.");
  }
  return {
    id: requiredString(tab, "id", 512),
    url: requiredString(tab, "url", 8_192, true),
    title: requiredString(tab, "title", 1_024, true),
    state,
    ...(typeof tab["canGoBack"] === "boolean" ? { canGoBack: tab["canGoBack"] } : {}),
    ...(typeof tab["canGoForward"] === "boolean" ? { canGoForward: tab["canGoForward"] } : {})
  };
}

function remoteBrowserFailure(): Error {
  return new Error("Remote Browser page creation failed before its owner descriptor committed.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertObjectArguments(
  value: Readonly<Record<string, unknown>>,
  schema: Readonly<Record<string, unknown>>,
  label: string
): void {
  const properties = schema["properties"];
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    throw new Error(`${label} schema is invalid.`);
  }
  for (const key of Object.keys(value)) {
    if (!Object.prototype.hasOwnProperty.call(properties, key)) throw new Error(`${label} argument '${key}' is not allowed.`);
  }
}

function containsSemanticQuery(input: Readonly<Record<string, unknown>>): boolean {
  if (input["query"] !== undefined) return true;
  const request = optionalRecord(input, "request");
  if (request === undefined) return false;
  if (request["query"] !== undefined) return true;
  const fields = request["fields"];
  return Array.isArray(fields) && fields.some((field) =>
    typeof field === "object" && field !== null && !Array.isArray(field) && "query" in field
  );
}

function copyRemoteArguments(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const arguments_: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key !== "target" && key !== "node") arguments_[key] = value;
  }
  const serialized = JSON.stringify(arguments_);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAXIMUM_UNIFIED_RESULT_BYTES) {
    throw new Error("Remote Browser request exceeds its safe byte limit.");
  }
  const parsed = JSON.parse(serialized) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Remote Browser request is invalid.");
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function safeRemoteLabel(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const safe = value.slice(0, 128).replace(/[^A-Za-z0-9_-]/gu, "_");
  return safe === "" ? fallback : safe;
}

function sanitizeRemoteFileName(value: string | undefined, mediaType: string): string {
  if (value !== undefined) return sanitizeBrowserFileName(value);
  if (mediaType === "application/pdf") return "browser-result.pdf";
  return "browser-result.bin";
}

function invalidPage(): BrowserPageState {
  throw new Error("Browser page closed before the action result was projected.");
}

function validateRecipe(value: Readonly<Record<string, unknown>>): BrowserRecipe {
  const id = requiredString(value, "id", 256);
  const rawSteps = value["steps"];
  if (!Array.isArray(rawSteps) || rawSteps.length < 1 || rawSteps.length > 256) {
    throw new Error("Browser recipe requires one through 256 steps.");
  }
  const accepted = ["navigate", "click", "type", "select", "wait", "extract", "evaluate", "requests", "responseBody"] as const;
  const steps = rawSteps.map((raw, index): BrowserRecipeStep => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`Browser recipe step ${index} is invalid.`);
    const step = raw as Readonly<Record<string, unknown>>;
    const action = requiredEnum(step, "action", accepted);
    const fn = optionalString(step, "fn", 64 * 1024);
    if ((action === "evaluate" || action === "wait") && fn !== undefined) {
      for (const match of fn.matchAll(/\{\{\s*[\w-]+\s*(?:\|\s*([a-z]+)\s*)?\}\}/gu)) {
        if (match[1] !== "js") throw new Error(`Browser recipe step ${index} has unsafe function interpolation.`);
      }
    }
    return {
      action,
      ...(step["url"] === undefined ? {} : { url: requiredString(step, "url", 8_192) }),
      ...(step["selector"] === undefined ? {} : { selector: requiredString(step, "selector", 4_096) }),
      ...(fn === undefined ? {} : { fn }),
      ...(step["value"] === undefined ? {} : { value: requiredString(step, "value", MAXIMUM_ACTION_TEXT_LENGTH, true) }),
      ...(step["values"] === undefined ? {} : { values: requiredStringArray(step, "values", 100, 16_384, true) }),
      ...(step["submit"] === undefined ? {} : { submit: requiredBoolean(step, "submit") }),
      ...(step["loadState"] === undefined ? {} : {
        loadState: requiredEnum(step, "loadState", ["load", "domcontentloaded", "networkidle"] as const)
      }),
      ...(step["textGone"] === undefined ? {} : { textGone: requiredString(step, "textGone", MAXIMUM_ACTION_TEXT_LENGTH) }),
      ...(step["timeoutMs"] === undefined ? {} : { timeoutMs: requiredInteger(step, "timeoutMs", 1, MAXIMUM_WAIT_MILLISECONDS) }),
      ...(step["filter"] === undefined ? {} : { filter: requiredString(step, "filter", 4_096, true) }),
      ...(step["maxChars"] === undefined ? {} : { maxChars: requiredInteger(step, "maxChars", 1, 200_000) }),
      ...(step["extract"] === undefined ? {} : { extract: requiredRecord(step, "extract") as unknown as BrowserExtractSpec }),
      ...(step["as"] === undefined ? {} : { as: requiredString(step, "as", 256) }),
      ...(step["optional"] === undefined ? {} : { optional: requiredBoolean(step, "optional") })
    };
  });
  const rawInputs = optionalRecord(value, "inputs");
  const inputs: Record<string, { required?: boolean }> = {};
  for (const [name, raw] of Object.entries(rawInputs ?? {})) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("Browser recipe input spec is invalid.");
    const spec = raw as Readonly<Record<string, unknown>>;
    inputs[requiredString({ name }, "name", 256)] = spec["required"] === undefined
      ? {}
      : { required: requiredBoolean(spec, "required") };
  }
  return {
    id,
    ...(value["match"] === undefined ? {} : { match: requiredStringArray(value, "match", 256, 256) }),
    ...(value["description"] === undefined ? {} : { description: requiredString(value, "description", 4_096, true) }),
    ...(rawInputs === undefined ? {} : { inputs }),
    steps,
    ...(value["output"] === undefined ? {} : { output: requiredString(value, "output", 4_096, true) })
  };
}

function validateUserRecipeSafety(recipe: BrowserRecipe): void {
  for (const [index, step] of recipe.steps.entries()) {
    if ((step.action === "evaluate" || step.action === "wait") && step.fn !== undefined) {
      validateBrowserEvaluateSource(step.fn);
    }
    if (step.action === "navigate" && step.url !== undefined) {
      const sample = step.url.replace(/\{\{\s*[\w-]+\s*(?:\|\s*[a-z]+\s*)?\}\}/gu, "sample");
      try {
        agentUrl(sample);
      } catch (error) {
        throw new Error(`Browser recipe step ${index} has an unsafe navigation URL: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if ((step.action === "type" || step.action === "click" || step.action === "select") && step.selector !== undefined) {
      if (/(?:password|passwd|secret|token|api[-_]?key|credential)/iu.test(step.selector)) {
        throw new Error(`Browser recipe step ${index} targets a credential-shaped field.`);
      }
    }
  }

}

function validateSiteGuide(value: Readonly<Record<string, unknown>>): BrowserSiteGuide {
  const site = requiredString(value, "site", 256);
  const extra: Record<string, unknown> = {};
  const known = new Set(["site", "auth", "entry", "pages", "recipes", "notes"]);
  for (const [key, item] of Object.entries(value)) {
    if (!known.has(key)) extra[key] = sanitizePublicPayload(item, 0);
  }
  return {
    ...extra,
    site,
    ...(value["auth"] === undefined ? {} : { auth: requiredString(value, "auth", 1_024, true) }),
    ...(value["entry"] === undefined ? {} : { entry: stringRecord(requiredRecord(value, "entry"), 256, 8_192) }),
    ...(value["pages"] === undefined ? {} : {
      pages: Array.isArray(value["pages"]) ? value["pages"].map((item) => sanitizePublicPayload(item, 0)) : []
    }),
    ...(value["recipes"] === undefined ? {} : { recipes: requiredStringArray(value, "recipes", 256, 256) }),
    ...(value["notes"] === undefined ? {} : { notes: requiredString(value, "notes", 8_192, true) })
  };
}

function stringRecord(
  value: Readonly<Record<string, unknown>>,
  maximumKeyLength: number,
  maximumValueLength: number
): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    output[requiredString({ key }, "key", maximumKeyLength)] = requiredString({ item }, "item", maximumValueLength);
  }
  return output;
}

function recipeSummary(recipe: BrowserRecipe | undefined, id: string): Readonly<Record<string, unknown>> {
  return {
    id,
    description: recipe?.description,
    inputs: Object.keys(recipe?.inputs ?? {}),
    required: Object.entries(recipe?.inputs ?? {}).filter(([, spec]) => spec.required === true).map(([name]) => name),
    match: recipe?.match ?? []
  };
}

function recipeStepInput(
  step: BrowserRecipeStep,
  vars: Readonly<Record<string, unknown>>,
  routing: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  const targetId = optionalString(routing, "targetId", 512);
  const profile = optionalString(routing, "profile", 256);
  const target = optionalEnum(routing, "target", ["sandbox", "host", "node"] as const);
  const node = optionalString(routing, "node", 512);
  const route = {
    ...(targetId === undefined ? {} : { targetId }),
    ...(profile === undefined ? {} : { profile }),
    ...(target === undefined ? {} : { target }),
    ...(node === undefined ? {} : { node })
  };
  switch (step.action) {
    case "navigate":
      if (step.url === undefined) throw new Error("Browser recipe navigate step requires url.");
      return { action: "navigate", url: interpolateRecipe(step.url, vars), ...route };
    case "click":
      if (step.selector === undefined) throw new Error("Browser recipe click step requires selector.");
      return { action: "act", request: { kind: "click", selector: interpolateRecipe(step.selector, vars), timeoutMs: step.timeoutMs }, ...route };
    case "type":
      if (step.selector === undefined || step.value === undefined) throw new Error("Browser recipe type step requires selector and value.");
      return { action: "act", request: { kind: "type", selector: interpolateRecipe(step.selector, vars), text: interpolateRecipe(step.value, vars), submit: step.submit, timeoutMs: step.timeoutMs }, ...route };
    case "select":
      if (step.selector === undefined || step.values === undefined) throw new Error("Browser recipe select step requires selector and values.");
      return { action: "act", request: { kind: "select", selector: interpolateRecipe(step.selector, vars), values: step.values.map((item) => interpolateRecipe(item, vars)), timeoutMs: step.timeoutMs }, ...route };
    case "wait":
      return { action: "act", request: {
        kind: "wait",
        selector: step.selector === undefined ? undefined : interpolateRecipe(step.selector, vars),
        url: step.url === undefined ? undefined : interpolateRecipe(step.url, vars),
        fn: step.fn === undefined ? undefined : interpolateRecipe(step.fn, vars),
        loadState: step.loadState,
        textGone: step.textGone === undefined ? undefined : interpolateRecipe(step.textGone, vars),
        timeoutMs: step.timeoutMs
      }, ...route };
    case "extract":
      if (step.extract === undefined) throw new Error("Browser recipe extract step requires extract spec.");
      return { action: "extract", extract: step.extract, timeoutMs: step.timeoutMs, ...route };
    case "evaluate":
      if (step.fn === undefined) throw new Error("Browser recipe evaluate step requires fn.");
      return { action: "act", request: { kind: "evaluate", fn: interpolateRecipe(step.fn, vars), timeoutMs: step.timeoutMs }, ...route };
    case "requests":
      return { action: "requests", filter: step.filter === undefined ? undefined : interpolateRecipe(step.filter, vars), ...route };
    case "responseBody":
      if (step.url === undefined) throw new Error("Browser recipe responseBody step requires url.");
      return { action: "responseBody", url: interpolateRecipe(step.url, vars), maxChars: step.maxChars, timeoutMs: step.timeoutMs, ...route };
  }
}

function recipeStepValue(step: BrowserRecipeStep, result: McpCallResult): unknown {
  const data = result.structuredContent?.["data"];
  if (step.action === "evaluate" && typeof data === "object" && data !== null && !Array.isArray(data) && "result" in data) {
    return (data as Readonly<Record<string, unknown>>)["result"];
  }
  return data ?? result.structuredContent;
}

function interpolateRecipe(template: string, vars: Readonly<Record<string, unknown>>): string {
  return template.replace(/\{\{\s*([\w-]+)\s*(?:\|\s*([a-z]+)\s*)?\}\}/gu, (_match, name: string, modifier?: string) => {
    if (!(name in vars)) throw new Error(`Browser recipe variable '${name}' is missing.`);
    const raw = vars[name];
    if (raw !== null && typeof raw === "object") throw new Error(`Browser recipe variable '${name}' must be scalar.`);
    const value = String(raw ?? "");
    if (modifier === undefined) return value;
    if (modifier === "url") return encodeURIComponent(value);
    if (modifier === "js") return value
      .replaceAll("\\", "\\\\")
      .replaceAll("'", "\\'")
      .replaceAll("\"", "\\\"")
      .replaceAll("`", "\\`")
      .replaceAll("$", "\\$")
      .replaceAll("\r", "\\r")
      .replaceAll("\n", "\\n");
    throw new Error(`Browser recipe interpolation modifier '${modifier}' is invalid.`);
  });
}

function resolveRecipeOutput(template: string, vars: Readonly<Record<string, unknown>>): unknown {
  const exact = template.match(/^\{\{\s*([\w-]+)\s*\}\}$/u);
  if (exact !== null) {
    const name = exact[1];
    if (name === undefined || !(name in vars)) throw new Error("Browser recipe output variable is missing.");
    return vars[name];
  }
  return interpolateRecipe(template, vars);
}

function delay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

function tool(
  name: string,
  description: string,
  inputSchema: Readonly<Record<string, unknown>>,
  requiresPermission: boolean
): McpToolDescriptor {
  return {
    serverId: BROWSER_BRIDGE_PROVIDER_ID,
    name,
    description,
    inputSchema,
    requiresPermission
  };
}

function assertKnownArguments(name: string, value: Readonly<Record<string, unknown>>): void {
  const descriptor = [...BROWSER_TOOLS, ...BROWSER_RUNTIME_TOOLS].find((candidate) => candidate.name === name);
  if (descriptor === undefined) throw new Error("Browser bridge tool is not available in this generation.");
  const properties = descriptor.inputSchema["properties"];
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    throw new Error("Browser bridge tool schema is invalid.");
  }
  for (const key of Object.keys(value)) {
    if (!Object.prototype.hasOwnProperty.call(properties, key)) {
      throw new Error(`Browser tool argument '${key}' is not allowed.`);
    }
  }
}

function publicTextResult(value: Readonly<Record<string, unknown>>, isError = false): McpCallResult {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAXIMUM_UNIFIED_RESULT_BYTES) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        ok: false,
        errorCode: "RESULT_TOO_LARGE",
        data: { limit: MAXIMUM_UNIFIED_RESULT_BYTES, hint: "Narrow the requested catalog or result." }
      }) }],
      isError: true
    };
  }
  return { content: [{ type: "text", text: serialized }], isError };
}

function textResult(value: Readonly<Record<string, unknown>>): McpCallResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false
  };
}

function publicPage(page: BrowserPageState): Readonly<Record<string, unknown>> {
  return {
    id: page.id,
    url: sanitizeBrowserUrlForDisplay(page.url),
    title: redactModelText(page.title),
    state: page.state,
    ...(page.canGoBack === undefined ? {} : { canGoBack: page.canGoBack }),
    ...(page.canGoForward === undefined ? {} : { canGoForward: page.canGoForward })
  };
}

function publicTransfer(value: {
  readonly browserTransferId: string;
  readonly browserProviderId: string;
  readonly pageId: string;
  readonly toolCallId: string;
  readonly direction: number;
  readonly state: number;
  readonly blob?: { readonly blobId: string; readonly fileName: string; readonly mediaType: string; readonly byteSize: bigint; readonly sha256Hex: string };
  readonly artifact?: { readonly artifactId: string; readonly title: string };
  readonly error?: { readonly code: string; readonly message: string };
}): Readonly<Record<string, unknown>> {
  return {
    id: value.browserTransferId,
    provider_id: value.browserProviderId,
    page_id: value.pageId,
    tool_call_id: value.toolCallId,
    direction: value.direction,
    state: value.state,
    ...(value.blob === undefined ? {} : {
      blob: {
        id: value.blob.blobId,
        file_name: value.blob.fileName,
        media_type: value.blob.mediaType,
        byte_size: value.blob.byteSize.toString(10),
        sha256: value.blob.sha256Hex
      }
    }),
    ...(value.artifact === undefined ? {} : { artifact: { id: value.artifact.artifactId, title: value.artifact.title } }),
    ...(value.error === undefined ? {} : { error: { code: value.error.code, message: value.error.message } })
  };
}

function requiredString(
  value: Readonly<Record<string, unknown>>,
  key: string,
  maximumLength: number,
  allowEmpty = false
): string {
  const candidate = value[key];
  if (
    typeof candidate !== "string" ||
    candidate.length > maximumLength ||
    candidate.includes("\0") ||
    (!allowEmpty && candidate.trim() === "")
  ) throw new Error(`Browser tool argument '${key}' is invalid.`);
  return candidate;
}

function optionalString(value: Readonly<Record<string, unknown>>, key: string, maximumLength: number): string | undefined {
  return value[key] === undefined ? undefined : requiredString(value, key, maximumLength);
}

function requiredBoolean(value: Readonly<Record<string, unknown>>, key: string): boolean {
  const candidate = value[key];
  if (typeof candidate !== "boolean") throw new Error(`Browser tool argument '${key}' is invalid.`);
  return candidate;
}

function optionalBoolean(value: Readonly<Record<string, unknown>>, key: string): boolean | undefined {
  return value[key] === undefined ? undefined : requiredBoolean(value, key);
}

function requiredBoundedNumber(
  value: Readonly<Record<string, unknown>>,
  key: string,
  maximumMagnitude: number
): number {
  const candidate = value[key];
  if (typeof candidate !== "number" || !Number.isFinite(candidate) || Math.abs(candidate) > maximumMagnitude) {
    throw new Error(`Browser tool argument '${key}' is invalid.`);
  }
  return candidate;
}

function requiredInteger(
  value: Readonly<Record<string, unknown>>,
  key: string,
  minimum: number,
  maximum: number
): number {
  const candidate = value[key];
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new Error(`Browser tool argument '${key}' is invalid.`);
  }
  return candidate;
}

function optionalInteger(
  value: Readonly<Record<string, unknown>>,
  key: string,
  minimum: number,
  maximum: number
): number | undefined {
  return value[key] === undefined ? undefined : requiredInteger(value, key, minimum, maximum);
}

function agentSelector(value: Readonly<Record<string, unknown>>): string {
  return requiredString(value, "selector", 4_096);
}

function agentWritableSelector(value: Readonly<Record<string, unknown>>): string {
  const selector = agentSelector(value);
  if (/(?:password|passwd|secret|token|api[-_]?key|credential)/iu.test(selector)) {
    throw new Error("Credential fields require human browser takeover and cannot be filled from model-visible arguments.");
  }
  return selector;
}

function agentKey(value: Readonly<Record<string, unknown>>): string {
  const key = requiredString(value, "key", 64);
  if (key.includes("+")) throw new Error("Browser key modifiers must be supplied separately.");
  return key;
}

function optionalModifiers(
  value: Readonly<Record<string, unknown>>,
  key: string
): readonly BrowserKeyModifier[] | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (!Array.isArray(candidate) || candidate.length > 4) {
    throw new Error(`Browser tool argument '${key}' is invalid.`);
  }
  const accepted: readonly BrowserKeyModifier[] = ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"];
  const modifiers = candidate.map((item) => {
    if (typeof item !== "string" || !accepted.includes(item as BrowserKeyModifier)) {
      throw new Error(`Browser tool argument '${key}' is invalid.`);
    }
    return item as BrowserKeyModifier;
  });
  if (new Set(modifiers).size !== modifiers.length) {
    throw new Error(`Browser tool argument '${key}' is invalid.`);
  }
  return modifiers;
}

function boundedInlineBytes(value: Uint8Array, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength > MAXIMUM_INLINE_BINARY_BYTES) {
    throw new Error(`${label} exceeds the bridge inline result limit.`);
  }
  return value;
}

function publicConsoleMessage(value: BrowserConsoleMessageSnapshot): Readonly<Record<string, unknown>> {
  return {
    sequence: publicDiagnosticInteger(value.sequence),
    at: publicDiagnosticInteger(value.at),
    level: diagnosticLabel(value.level, "log"),
    text: redactDiagnosticText(value.text)
  };
}

function publicHttpRequestSummary(value: BrowserHttpRequestSummary): Readonly<Record<string, unknown>> {
  return {
    sequence: publicDiagnosticInteger(value.sequence),
    at: publicDiagnosticInteger(value.at),
    method: diagnosticLabel(typeof value.method === "string" ? value.method.toUpperCase() : "", "OTHER"),
    url: sanitizeBrowserUrlForDisplay(value.url),
    resource_type: diagnosticLabel(value.resourceType, "other"),
    navigation: value.navigation === true
  };
}

function publicDiagnosticInteger(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function diagnosticLabel(value: string, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const safe = value.slice(0, 32).replace(/[^A-Za-z0-9_-]/gu, "_");
  return safe === "" ? fallback : safe;
}

function redactDiagnosticText(value: string): string {
  if (typeof value !== "string") return "";
  let safe = value.slice(0, 16_384).replaceAll("\0", "");
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
  return safe.length <= 4_096 ? safe : `${safe.slice(0, 4_095)}…`;
}

function agentUrl(value: string): string {
  const normalized = validateWebUrl(value);
  if (sanitizeBrowserUrlForDisplay(normalized) !== normalized) {
    throw new Error("Browser navigation URLs containing fragments or credential-shaped query values require human takeover.");
  }
  return normalized;
}
