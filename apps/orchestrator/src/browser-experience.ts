export const BROWSER_EXPERIENCE_ACTIONS = ["navigate", "click", "type", "select", "press", "wait", "extract", "evaluate"] as const;
export type BrowserExperienceAction = typeof BROWSER_EXPERIENCE_ACTIONS[number];
export interface BrowserExperience {
  readonly site: string;
  readonly actions: readonly BrowserExperienceAction[];
  readonly observations: number;
  readonly updatedAt: number;
}
export function browserExperienceSite(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/u.test(value);
}
export function validBrowserExperience(value: unknown): value is BrowserExperience {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).sort().join("|") === "actions|observations|site|updatedAt" && browserExperienceSite(row["site"])
    && Array.isArray(row["actions"]) && row["actions"].length >= 2 && row["actions"].length <= 32
    && row["actions"].every(action => BROWSER_EXPERIENCE_ACTIONS.includes(action))
    && Number.isSafeInteger(row["observations"]) && Number(row["observations"]) > 0 && Number(row["observations"]) <= 1_000_000
    && typeof row["updatedAt"] === "number" && Number.isFinite(row["updatedAt"]);
}

/** A navigation starts a bounded flow; its first successful read ends it. Never retain action arguments. */
export class BrowserExperienceRecorder {
  readonly #flows = new Map<string, { site: string; actions: BrowserExperienceAction[] }>();
  clear(target?: string): void { if (target === undefined) this.#flows.clear(); else this.#flows.delete(target); }
  start(target: string, url: string): void {
    this.clear(target);
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || !browserExperienceSite(parsed.hostname)) return;
      if (this.#flows.size >= 32) this.#flows.delete(this.#flows.keys().next().value!);
      this.#flows.set(target, { site: parsed.hostname, actions: ["navigate"] });
    } catch { /* Only observable HTTP(S) flows are useful. */ }
  }
  step(target: string, action: BrowserExperienceAction): Pick<BrowserExperience, "site" | "actions"> | undefined {
    const flow = this.#flows.get(target); if (!flow) return;
    if (flow.actions.length >= 32) { this.clear(target); return; }
    flow.actions.push(action);
    if (action !== "extract" && action !== "evaluate") return;
    this.clear(target); return flow;
  }
}

export interface SuggestibleBrowserRecipe {
  readonly id: string; readonly match?: readonly string[]; readonly description?: string;
  readonly access?: "read" | "write";
  readonly validation?: { readonly site: string; readonly profile?: string; readonly state: "candidate" | "active" | "suspended" };
  readonly steps: readonly { readonly action: string; readonly fn?: string }[];
}
export function deferredBrowserRecipeIssue(recipe: Pick<SuggestibleBrowserRecipe, "access" | "steps">): string | undefined {
  if (recipe.access !== "read") return "Deferred validation requires access=read.";
  if (recipe.steps.some(step => step.fn !== undefined || !["navigate", "wait", "extract", "requests", "responseBody"].includes(step.action))) {
    return "Deferred candidates may only use navigate, wait without a function, extract, requests and responseBody. Validate interactive or script steps during their real task.";
  }
  return undefined;
}
export function suggestBrowserRecipes<T extends SuggestibleBrowserRecipe>(recipes: readonly T[], site: string, intent: string, profile: string): readonly T[] {
  const terms = intent.toLocaleLowerCase("en-US").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return recipes.filter(recipe => recipe.validation?.state !== "suspended"
    && (recipe.validation?.state !== "candidate" || !deferredBrowserRecipeIssue(recipe))
    && (recipe.validation?.profile === undefined || recipe.validation.profile === profile)
    && [recipe.validation?.site, ...recipe.match ?? []].some(host => {
      const normalized = host?.toLocaleLowerCase("en-US").replace(/^www\./u, "");
      return !!normalized && (site === normalized || site.endsWith(`.${normalized}`));
    })).map(recipe => ({ recipe, score: terms.filter(term => `${recipe.id} ${recipe.description ?? ""}`.toLocaleLowerCase("en-US").includes(term)).length }))
    .filter(entry => !terms.length || entry.score > 0).sort((a, b) => b.score - a.score || a.recipe.id.localeCompare(b.recipe.id))
    .slice(0, 3).map(entry => entry.recipe);
}
