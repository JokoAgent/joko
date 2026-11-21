import { publicProviderCatalogId, publicProviderInterfaces } from "@joko/contracts";
import type { ProviderInferenceRoute } from "./credential-manager.js";

const THREAD_HISTORY_LIMIT = 1_024;

type JsonObject = Record<string, unknown>;

function record(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,256}$/u.test(value);
}

export function supportsManagedAnthropicToolIdRepair(route: ProviderInferenceRoute): boolean {
  if (route.api !== "anthropic-messages" || route.requestPath !== undefined) return false;
  const endpoint = route.baseUrl.replace(/\/+$/u, "");
  const provider = publicProviderCatalogId(endpoint);
  return provider !== undefined && publicProviderInterfaces(provider, endpoint, route.modelId).some(profile =>
    profile.api === route.api && profile.baseUrl.replace(/\/+$/u, "") === endpoint
    && profile.compatibility?.includes("kimi-tool-ids-v1"));
}

/** Upstream IDs can be minted from the number of tool calls still visible after compaction. */
export class ManagedAnthropicToolIds {
  readonly #recent = new Set<string>();

  prepare(request: JsonObject): { readonly changed: boolean; readonly repair: (value: unknown) => JsonObject | undefined } {
    const calls: Array<{ id: string; block: JsonObject }> = [];
    const results: Array<{ id: string; block: JsonObject }> = [];
    for (const message of Array.isArray(request["messages"]) ? request["messages"] : []) {
      if (!record(message) || !Array.isArray(message["content"])) continue;
      for (const block of message["content"]) {
        if (!record(block)) continue;
        if (message["role"] === "assistant" && block["type"] === "tool_use" && toolId(block["id"])) {
          calls.push({ id: block["id"], block });
        } else if (message["role"] === "user" && block["type"] === "tool_result" && toolId(block["tool_use_id"])) {
          results.push({ id: block["tool_use_id"], block });
        }
      }
    }
    const used = new Set(calls.map(({ id }) => id));
    const nextSuffix = new Map<string, number>();
    const nextUnused = (id: string, occupied: (candidate: string) => boolean): string => {
      let suffix = nextSuffix.get(id) ?? 2;
      let candidate = `${id}_dup${suffix}`;
      while (occupied(candidate)) candidate = `${id}_dup${++suffix}`;
      nextSuffix.set(id, suffix + 1);
      used.add(candidate);
      return candidate;
    };
    let changed = false;
    if (used.size < calls.length) {
      const byOccurrence = new Map<string, string[]>();
      for (const { id, block } of calls) {
        const occurrences = byOccurrence.get(id);
        if (occurrences === undefined) {
          byOccurrence.set(id, [id]);
          continue;
        }
        const replacement = nextUnused(id, candidate => used.has(candidate));
        occurrences.push(replacement);
        block["id"] = replacement;
        changed = true;
      }
      const consumed = new Map<string, number>();
      for (const { id, block } of results) {
        const index = consumed.get(id) ?? 0;
        consumed.set(id, index + 1);
        const replacement = byOccurrence.get(id)?.[index];
        if (replacement !== undefined && replacement !== id) block["tool_use_id"] = replacement;
      }
    }
    for (const id of used) this.#observe(id);

    return { changed, repair: value => {
      if (!record(value) || value["type"] !== "content_block_start") return undefined;
      const block = value["content_block"];
      if (!record(block) || block["type"] !== "tool_use" || !toolId(block["id"])) return undefined;
      const id = block["id"];
      const occupied = (candidate: string) => used.has(candidate) || this.#recent.has(candidate);
      const replacement = occupied(id) ? nextUnused(id, occupied) : id;
      used.add(replacement);
      this.#observe(replacement);
      return replacement === id ? undefined : { ...value, content_block: { ...block, id: replacement } };
    } };
  }

  #observe(id: string): void {
    this.#recent.delete(id);
    this.#recent.add(id);
    if (this.#recent.size > THREAD_HISTORY_LIMIT) this.#recent.delete(this.#recent.values().next().value!);
  }
}
