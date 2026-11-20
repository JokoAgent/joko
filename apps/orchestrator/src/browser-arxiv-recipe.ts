import { readPublicSearchInput, readPublicSearchResponse, type PublicSearchRequest } from "./browser-public-recipe.js";

export const ARXIV_ADAPTER_RECIPE = {
  id: "opencli:arxiv/search",
  description: "Search arXiv papers",
  access: "read",
  match: ["arxiv.org", "export.arxiv.org"],
  inputs: {
    query: { required: true, type: "str", description: "Paper search keywords" },
    limit: { required: false, type: "int", default: 10, description: "Maximum results (up to 25)" }
  },
  steps: []
} as const;

export function prepareArxivSearch(input: Readonly<Record<string, unknown>>): PublicSearchRequest {
  const { query, limit } = readPublicSearchInput(input, ARXIV_ADAPTER_RECIPE.inputs.limit.default, 25);
  return { url: `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(`all:${query}`)}&max_results=${limit}&sortBy=relevance`, limit };
}

export async function executeArxivSearch(input: PublicSearchRequest, fetcher: typeof fetch, signal?: AbortSignal) {
  const xml = await readPublicSearchResponse(input, fetcher, "application/atom+xml, application/xml", signal);
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gu)].slice(0, input.limit).flatMap(([, entry]) => {
    const id = text(entry!, "id").replace(/^https?:\/\/arxiv\.org\/abs\//u, "").replace(/v\d+$/u, "");
    if (!/^(?:[a-z][a-z.-]*\/\d{7}|\d{4}\.\d{4,5})$/iu.test(id)) return [];
    return [{ id, title: text(entry!, "title").replace(/\s+/gu, " "),
      authors: [...entry!.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gu)]
        .map(match => decodeXmlText(match[1]!.trim())).join(", "),
      published: text(entry!, "published").slice(0, 10),
      primary_category: /<arxiv:primary_category\b[^>]*\bterm="([^"]*)"/u.exec(entry!)?.[1] ?? "",
      url: `https://arxiv.org/abs/${id}` }];
  });
  if (!entries.length) throw new Error("No papers found. Try a different keyword.");
  return entries;
}

function text(entry: string, tag: "id" | "title" | "published"): string {
  return decodeXmlText(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "u").exec(entry)?.[1]?.trim() ?? "");
}

const XML_ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", "#39": "'" };

function decodeXmlText(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos|#39);/gu, (_whole, name: string) => XML_ENTITIES[name]!);
}
