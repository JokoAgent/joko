import { createHash } from "node:crypto";
import { readPublicSearchInput, readPublicSearchResponse, type PublicSearchRequest } from "./browser-public-recipe.js";

export const STACK_OVERFLOW_ADAPTER_RECIPE = {
  id: "opencli:stackoverflow/search",
  description: "Search Stack Overflow questions",
  access: "read",
  match: ["stackoverflow.com", "api.stackexchange.com"],
  inputs: {
    query: { required: true, type: "string", description: "Search query" },
    limit: { required: false, type: "int", default: 10, description: "Maximum results (up to 100)" }
  },
  steps: []
} as const;

export function prepareStackOverflowSearch(input: Readonly<Record<string, unknown>>): PublicSearchRequest {
  const { query, limit } = readPublicSearchInput(input, STACK_OVERFLOW_ADAPTER_RECIPE.inputs.limit.default, 100);
  const url = new URL("https://api.stackexchange.com/2.3/search/advanced");
  url.search = new URLSearchParams({ order: "desc", sort: "relevance", q: query, site: "stackoverflow", pagesize: String(limit) }).toString();
  return { url: url.href, limit };
}

export class StackOverflowPublicSearch {
  #backoffUntil = 0;
  readonly #recent = new Map<string, { readonly expiresAt: number; readonly questions: readonly StackOverflowQuestion[] }>();

  async execute(request: PublicSearchRequest, fetcher: typeof fetch, signal?: AbortSignal): Promise<readonly StackOverflowQuestion[]> {
    signal?.throwIfAborted();
    const now = Date.now();
    const key = createHash("sha256").update(request.url).digest("hex");
    for (const [cachedKey, entry] of this.#recent) if (entry.expiresAt <= now) this.#recent.delete(cachedKey);
    const previous = this.#recent.get(key);
    if (previous !== undefined) return previous.questions;
    if (this.#backoffUntil > now) throw new Error("Stack Exchange requested a pause before searching again.");
    const body = await readPublicSearchResponse(request, fetcher, "application/json", signal);
    let value: Readonly<Record<string, unknown>> | undefined;
    try { value = record(JSON.parse(body)); } catch { /* Keep the upstream body private. */ }
    const backoff = value?.["backoff"];
    if (typeof backoff === "number" && Number.isSafeInteger(backoff) && backoff > 0) {
      this.#backoffUntil = Math.max(this.#backoffUntil, Date.now() + backoff * 1_000);
    }
    if (value === undefined || value["error_id"] !== undefined || !Array.isArray(value["items"])) {
      throw new Error("The Stack Exchange search response is unavailable.");
    }
    const questions = value["items"].slice(0, request.limit).flatMap((item, index) => {
      const question = readQuestion(item, index + 1);
      return question === undefined ? [] : [question];
    });
    if (this.#recent.size >= 32) {
      const oldest = this.#recent.keys().next();
      if (!oldest.done) this.#recent.delete(oldest.value);
    }
    this.#recent.set(key, { expiresAt: Date.now() + 60_000, questions });
    return questions;
  }
}

interface StackOverflowQuestion {
  readonly rank: number;
  readonly id: number;
  readonly title: string;
  readonly score?: number;
  readonly answers?: number;
  readonly views?: number;
  readonly is_answered?: boolean;
  readonly tags: string;
  readonly author: string;
  readonly creation_date?: number;
  readonly url: string;
}

function readQuestion(value: unknown, rank: number): StackOverflowQuestion | undefined {
  const item = record(value), id = integer(item?.["question_id"]);
  if (item === undefined || id === undefined || id <= 0 || typeof item["title"] !== "string" || typeof item["link"] !== "string") return undefined;
  let url: URL;
  try { url = new URL(item["link"]); } catch { return undefined; }
  if (url.origin !== "https://stackoverflow.com" || url.username || url.password || url.hash || url.search
    || !new RegExp(`^/questions/${id}(?:/|$)`, "u").test(url.pathname)) return undefined;
  const score = integer(item["score"]), answers = integer(item["answer_count"]), views = integer(item["view_count"]);
  const created = integer(item["creation_date"]), author = record(item["owner"])?.["display_name"];
  return { rank, id, title: item["title"].slice(0, 2_048),
    ...(score === undefined ? {} : { score }), ...(answers === undefined ? {} : { answers }),
    ...(views === undefined ? {} : { views }),
    ...(typeof item["is_answered"] !== "boolean" ? {} : { is_answered: item["is_answered"] }),
    tags: Array.isArray(item["tags"]) ? item["tags"].filter(tag => typeof tag === "string").slice(0, 12).join(", ").slice(0, 512) : "",
    author: typeof author === "string" ? author.slice(0, 512) : "",
    ...(created === undefined ? {} : { creation_date: created }), url: `${url.origin}/questions/${id}` };
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined;
}

function integer(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined; }
