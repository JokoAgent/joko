import type { OperationalStore } from "@joko/store";

import type { BrowserUserKnowledgeLayer } from "./browser-tool-bridge.js";

export const BROWSER_USER_KNOWLEDGE_SETTING_KEY = "settings.browser.user_knowledge";

const BROWSER_USER_KNOWLEDGE_FORMAT = 1;
const MAXIMUM_CATALOG_ITEMS = 256;
const MAXIMUM_CATALOG_BYTES = 1_000_000;

interface StoredBrowserUserKnowledge {
  readonly format: 1;
  readonly catalogVersion: number;
  readonly recipes: readonly Readonly<Record<string, unknown>>[];
  readonly siteGuides: readonly Readonly<Record<string, unknown>>[];
}

/**
 * Service-scoped durable layer for user-authored Browser knowledge.  Recipes
 * and guides share one setting row so an override is published atomically.
 */
export class BrowserUserKnowledgeStore implements BrowserUserKnowledgeLayer {
  readonly #store: OperationalStore;
  readonly #scopeId: string;
  #catalog: StoredBrowserUserKnowledge;
  #tail: Promise<void> = Promise.resolve();

  constructor(store: OperationalStore, scopeId = "orchestrator") {
    this.#store = store;
    this.#scopeId = requiredIdentifier(scopeId, "Browser knowledge scope");
    const stored = store.findSetting<unknown>(
      "service",
      this.#scopeId,
      BROWSER_USER_KNOWLEDGE_SETTING_KEY
    )?.value;
    this.#catalog = stored === undefined ? emptyCatalog() : validateCatalog(stored);
  }

  get recipes(): readonly Readonly<Record<string, unknown>>[] {
    return this.#catalog.recipes.map(cloneRecord);
  }

  get siteGuides(): readonly Readonly<Record<string, unknown>>[] {
    return this.#catalog.siteGuides.map(cloneRecord);
  }

  get catalogVersion(): number {
    return this.#catalog.catalogVersion;
  }

  save(input: {
    readonly site: string;
    readonly recipe: Readonly<Record<string, unknown>>;
    readonly siteGuide?: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    const task = this.#tail.then(() => this.#saveNow(input), () => this.#saveNow(input));
    this.#tail = task.then(() => undefined, () => undefined);
    return task;
  }

  async #saveNow(input: {
    readonly site: string;
    readonly recipe: Readonly<Record<string, unknown>>;
    readonly siteGuide?: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    const site = requiredIdentifier(input.site, "Browser site guide site");
    const recipe = cloneRecord(input.recipe);
    const recipeId = recordIdentifier(recipe, "id", "Browser recipe ID");
    const siteGuide = input.siteGuide === undefined ? undefined : cloneRecord(input.siteGuide);
    if (siteGuide !== undefined && recordIdentifier(siteGuide, "site", "Browser site guide site") !== site) {
      throw new Error("Browser site guide does not match its durable catalog key.");
    }
    const recipes = new Map(this.#catalog.recipes.map((item) => [recordIdentifier(item, "id", "Browser recipe ID"), item]));
    const siteGuides = new Map(this.#catalog.siteGuides.map((item) => [recordIdentifier(item, "site", "Browser site guide site"), item]));
    recipes.set(recipeId, recipe);
    if (siteGuide !== undefined) siteGuides.set(site, siteGuide);
    const next = validateCatalog({
      format: BROWSER_USER_KNOWLEDGE_FORMAT,
      catalogVersion: this.#catalog.catalogVersion + 1,
      recipes: [...recipes.values()].sort(compareRecordId("id")),
      siteGuides: [...siteGuides.values()].sort(compareRecordId("site"))
    });
    // OperationalStore commits this single row in one SQLite transaction.  Do
    // not publish the in-memory projection until that commit has succeeded.
    this.#store.setSetting(
      "service",
      this.#scopeId,
      BROWSER_USER_KNOWLEDGE_SETTING_KEY,
      next
    );
    this.#catalog = next;
  }
}

function emptyCatalog(): StoredBrowserUserKnowledge {
  return { format: BROWSER_USER_KNOWLEDGE_FORMAT, catalogVersion: 0, recipes: [], siteGuides: [] };
}

function validateCatalog(value: unknown): StoredBrowserUserKnowledge {
  if (!isRecord(value) || value["format"] !== BROWSER_USER_KNOWLEDGE_FORMAT) {
    throw new Error("Stored Browser user knowledge has an unsupported format.");
  }
  const catalogVersion = value["catalogVersion"];
  if (!Number.isSafeInteger(catalogVersion) || (catalogVersion as number) < 0) {
    throw new Error("Stored Browser user knowledge has an invalid version.");
  }
  const recipes = recordArray(value["recipes"], "Browser recipes", "id");
  const siteGuides = recordArray(value["siteGuides"], "Browser site guides", "site");
  const catalog: StoredBrowserUserKnowledge = {
    format: BROWSER_USER_KNOWLEDGE_FORMAT,
    catalogVersion: catalogVersion as number,
    recipes,
    siteGuides
  };
  const serialized = JSON.stringify(catalog);
  if (Buffer.byteLength(serialized, "utf8") > MAXIMUM_CATALOG_BYTES) {
    throw new Error("Stored Browser user knowledge exceeds its byte limit.");
  }
  return catalog;
}

function recordArray(value: unknown, label: string, key: "id" | "site"): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value) || value.length > MAXIMUM_CATALOG_ITEMS) {
    throw new Error(`${label} are invalid.`);
  }
  const records = value.map((item) => {
    if (!isRecord(item)) throw new Error(`${label} contain an invalid entry.`);
    return cloneRecord(item);
  });
  const ids = new Set<string>();
  for (const record of records) {
    const id = recordIdentifier(record, key, `${label} key`);
    if (ids.has(id)) throw new Error(`${label} contain a duplicate entry.`);
    ids.add(id);
  }
  return records.sort(compareRecordId(key));
}

function compareRecordId(key: "id" | "site"): (left: Readonly<Record<string, unknown>>, right: Readonly<Record<string, unknown>>) => number {
  return (left, right) => String(left[key]).localeCompare(String(right[key]), "en");
}

function cloneRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Browser user knowledge is not JSON serializable.");
  const parsed = JSON.parse(serialized) as unknown;
  if (!isRecord(parsed)) throw new Error("Browser user knowledge must be a JSON object.");
  return parsed;
}

function recordIdentifier(value: Readonly<Record<string, unknown>>, key: string, label: string): string {
  return requiredIdentifier(value[key], label);
}

function requiredIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid.`);
  const normalized = value.trim();
  if (normalized === "" || normalized.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
