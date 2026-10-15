import type { DevelopmentUpstreamItem, DevelopmentUpstreamQuery, DevelopmentUpstreamRuntime } from "./personal-development-doctor-types.js";

const REPOSITORY = "JokoAgent/joko", SEARCH_PAGE_SIZE = 10, TIMEOUT_MS = 25_000, MAX_ITEMS = 5, MAX_CANDIDATES = 20;
const FILLER = new Set(("我 我们 希望 想要 想 可以 能够 需要 帮我 请 一个 一下 这个 那个 功能 问题 修复 新增 增加 支持 修改 优化 时候 之后 然后 出现 发生 使用 用户 不能 无法 "
  + "i we you want would like please help can could should need needs have has when after before this that there here are was were does how make a an the to of in on for with and or not is it my fix bug feature add support joko repo issue pr").split(" "));
type Inclusion = "included" | "notIncluded" | "unknown";
export interface PersonalDevelopmentUpstreamOptions {
  readonly fetch: typeof fetch; readonly runtime?: DevelopmentUpstreamRuntime;
  readonly isCurrent?: () => boolean | Promise<boolean>;
  readonly containsCommit?: (commit: string, signal: AbortSignal) => Promise<Inclusion>;
}
export function personalDevelopmentSearchTerms(request: string): string[] {
  const words = [...new Intl.Segmenter(undefined, { granularity: "word" }).segment(request.slice(0, 4_000))]
    .filter(part => part.isWordLike).map(part => part.segment.toLowerCase())
    .filter(word => /^[\p{L}\p{N}]+$/u.test(word) && word.length >= 2 && word.length <= 48 && !FILLER.has(word));
  return [...new Set(words)].slice(0, 3);
}
class QueryFailure extends Error {
  constructor(readonly reason: NonNullable<DevelopmentUpstreamQuery["failure"]>) { super(reason); }
}
async function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted(); let stop!: () => void;
  const abort = new Promise<never>((_resolve, reject) => { stop = () => reject(new Error("Upstream lookup stopped.")); signal.addEventListener("abort", stop, { once: true }); });
  try { return await Promise.race([operation, abort]); } finally { signal.removeEventListener("abort", stop); }
}
/** Public fixed-origin literal queries. No account, credential, checkout or Agent turn. */
export async function searchPersonalDevelopmentUpstream(request: string, signal: AbortSignal, options: PersonalDevelopmentUpstreamOptions): Promise<DevelopmentUpstreamQuery> {
  const terms = personalDevelopmentSearchTerms(request); if (!terms.length) return { status: "needsRequest", items: [], terms };
  const controller = new AbortController(), abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort("timeout"), TIMEOUT_MS); timeout.unref();
  const read = async (url: string): Promise<Record<string, unknown>> => {
    const response = await untilAborted(options.fetch(url, { signal: controller.signal, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer",
      headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } }), controller.signal);
    if (!response.ok) { await response.body?.cancel(); throw new QueryFailure(response.status === 403 || response.status === 429 ? "rateLimit" : "network"); }
    const reader = response.body?.getReader(); if (!reader) throw new QueryFailure("invalidResponse");
    const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const chunk = await untilAborted(reader.read(), controller.signal); if (chunk.done) break;
      if ((size += chunk.value.length) > 2 * 1024 * 1024) throw new QueryFailure("invalidResponse"); chunks.push(chunk.value); }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    let body: unknown; try { body = JSON.parse(Buffer.concat(chunks, size).toString("utf8")); } catch { throw new QueryFailure("invalidResponse"); }
    const value = record(body); if (!value) throw new QueryFailure("invalidResponse"); return value;
  };
  try {
    controller.signal.throwIfAborted();
    const pages = await Promise.all(terms.flatMap(term => ["is:open", "is:merged"].map(async scope => {
      const url = new URL("https://api.github.com/search/issues");
      url.searchParams.set("q", `repo:${REPOSITORY} is:pr ${scope} in:title,body "${term}"`);
      url.searchParams.set("per_page", String(SEARCH_PAGE_SIZE)); url.searchParams.set("sort", "updated"); url.searchParams.set("order", "desc");
      const body = await read(url.toString());
      if (!Array.isArray(body.items) || body.incomplete_results !== false || !Number.isSafeInteger(body.total_count)
        || Number(body.total_count) < body.items.length || Number(body.total_count) > 0 && body.items.length === 0) throw new QueryFailure("invalidResponse");
      return { items: body.items.slice(0, SEARCH_PAGE_SIZE).map(parseItem), hasMore: Number(body.total_count) > Math.min(body.items.length, SEARCH_PAGE_SIZE) };
    })));
    const hits = new Map<number, { item: DevelopmentUpstreamItem; count: number; rank: number }>();
    for (const page of pages) page.items.forEach((item, rank) => { const previous = hits.get(item.number);
      hits.set(item.number, { item, count: (previous?.count ?? 0) + 1, rank: Math.min(previous?.rank ?? rank, rank) }); });
    const candidates = [...hits.values()].sort((a, b) => b.count - a.count || a.rank - b.rank).map(hit => hit.item);
    const filtered = await filterCandidates(candidates, read, controller.signal, options); controller.signal.throwIfAborted();
    return { ...filtered, status: filtered.items.length ? "found" : "notFound", terms, hasMore: filtered.hasMore || pages.some(page => page.hasMore) };
  } catch (error) { return { status: signal.aborted ? "cancelled" : "failed", items: [], terms,
    failure: controller.signal.reason === "timeout" ? "timeout" : error instanceof QueryFailure ? error.reason : "network" };
  } finally { clearTimeout(timeout); signal.removeEventListener("abort", abort); controller.abort(); }
}
async function filterCandidates(candidates: readonly DevelopmentUpstreamItem[], read: (url: string) => Promise<Record<string, unknown>>,
  signal: AbortSignal, options: PersonalDevelopmentUpstreamOptions) {
  const runtime = options.runtime ? { ...options.runtime } : undefined, inspected: DevelopmentUpstreamItem[] = [], comparisons = new Map<string, Promise<Inclusion>>();
  const current = async () => { try { return options.isCurrent ? await untilAborted(Promise.resolve(options.isCurrent()), signal) : true; } catch { return false; } };
  const contains = async (commit: string): Promise<Inclusion> => {
    if (runtime?.confidence !== "exact" || !validCommit(runtime.commit) || !await current()) return "unknown";
    if (commit === runtime.commit) return "included";
    try {
      const local = options.containsCommit ? await untilAborted(options.containsCommit(commit, signal), signal) : "unknown"; if (local !== "unknown") return local;
      const comparison = await read(`https://api.github.com/repos/${REPOSITORY}/compare/${commit}...${runtime.commit}`);
      const base = record(comparison.base_commit)?.sha, common = record(comparison.merge_base_commit)?.sha;
      if (base !== commit) return "unknown";
      if ((comparison.status === "ahead" || comparison.status === "identical") && common === commit && comparison.behind_by === 0
        && Array.isArray(comparison.commits) && comparison.total_commits === comparison.commits.length && !comparison.commits.some(entry => {
          const message = record(record(entry)?.commit)?.message; return typeof message !== "string" || /revert/iu.test(message) && message.includes(commit);
        })) return "included";
      if (comparison.status === "behind" && common === runtime.commit && comparison.ahead_by === 0 && typeof comparison.behind_by === "number" && comparison.behind_by > 0) return "notIncluded";
      return "unknown";
    } catch { return "unknown"; }
  };
  const inspect = async (item: DevelopmentUpstreamItem): Promise<DevelopmentUpstreamItem | null> => {
    let detail: Record<string, unknown>;
    try {
      detail = await read(`https://api.github.com/repos/${REPOSITORY}/pulls/${item.number}`);
      if (detail.number !== item.number || detail.html_url !== item.htmlUrl || record(record(detail.base)?.repo)?.full_name !== REPOSITORY
        || typeof detail.merged !== "boolean" || !["open", "closed"].includes(String(detail.state)) || detail.merged && detail.state !== "closed") throw new Error("Invalid upstream pull request.");
    } catch { return { ...item, inclusion: "unknown" }; }
    if (!detail.merged && detail.state === "closed") return null;
    const commit = detail.merged ? detail.merge_commit_sha : record(detail.head)?.sha; let inclusion: Inclusion = "unknown";
    if (validCommit(commit)) { if (!comparisons.has(commit)) comparisons.set(commit, contains(commit)); inclusion = await comparisons.get(commit)!; }
    return { ...item, state: detail.merged ? "merged" : "open", draft: detail.draft === true, inclusion };
  };
  let inspectedCount = 0;
  for (let offset = 0; offset < Math.min(candidates.length, MAX_CANDIDATES); offset += 2) {
    signal.throwIfAborted(); const batch = candidates.slice(offset, Math.min(offset + 2, MAX_CANDIDATES)); inspectedCount += batch.length;
    inspected.push(...(await Promise.all(batch.map(inspect))).filter((item): item is DevelopmentUpstreamItem => item !== null));
    if (inspected.filter(item => item.inclusion !== "included").length >= MAX_ITEMS) break;
  }
  if (!await current()) { if (runtime) runtime.confidence = "unknown"; for (let i = 0; i < inspected.length; i++) inspected[i] = { ...inspected[i]!, inclusion: "unknown" }; }
  signal.throwIfAborted(); const available = inspected.filter(item => item.inclusion !== "included");
  return { items: available.slice(0, MAX_ITEMS), ...(runtime ? { runtime } : {}), excludedIncluded: inspected.filter(item => item.inclusion === "included").length,
    hasMore: candidates.length > inspectedCount || available.length > MAX_ITEMS };
}
function parseItem(value: unknown): DevelopmentUpstreamItem {
  const row = record(value); if (!row) throw new QueryFailure("invalidResponse"); const number = row.number, htmlUrl = `https://github.com/${REPOSITORY}/pull/${number}`;
  if (!Number.isSafeInteger(number) || Number(number) <= 0 || typeof row.title !== "string" || !row.title.trim() || row.html_url !== htmlUrl
    || !record(row.pull_request) || row.state !== "open" && row.state !== "closed") throw new QueryFailure("invalidResponse");
  const author = record(row.user)?.login;
  return { number: Number(number), title: row.title.slice(0, 300), htmlUrl, state: row.state === "open" ? "open" : "unknown",
    ...(typeof author === "string" ? { author: author.slice(0, 80) } : {}),
    ...(typeof row.updated_at === "string" && Number.isFinite(Date.parse(row.updated_at)) ? { updatedAt: new Date(row.updated_at).toISOString() } : {}),
    ...(typeof row.body === "string" ? { summary: row.body.replace(/<!--[\s\S]*?-->/gu, "").replace(/\s+/gu, " ").trim().slice(0, 280) } : {}) };
}
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const validCommit = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
