import type { DevelopmentChannel, DevelopmentSourceLatestVersion } from "./types.js";
import { PersonalDevelopmentError } from "./types.js";
import { HASH } from "./storage.js";

const API = "https://api.github.com/repos/JokoAgent/joko";
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
class MissingSourceRef extends Error {}

/** Fixed public upstream lookup. Its comparison describes the local official branch, never a running native version. */
export function createLatestDevelopmentSourceReader(fetcher: typeof fetch = fetch, now: () => number = Date.now) {
  const cache = new Map<DevelopmentChannel, { readonly mainCommit?: string; readonly expires: number; readonly value: Promise<DevelopmentSourceLatestVersion> }>();
  async function query(channel: DevelopmentChannel, mainCommit: string | undefined, signal: AbortSignal): Promise<DevelopmentSourceLatestVersion> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    const result = (status: DevelopmentSourceLatestVersion["status"]): DevelopmentSourceLatestVersion => ({ channel, status, checkedAt: now() });
    const read = async (endpoint: string): Promise<unknown> => {
      const response = await fetcher(`${API}/${endpoint}`, { signal: deadline, redirect: "error", credentials: "omit",
        headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } });
      if (response.status === 404) throw new MissingSourceRef();
      if (!response.ok || !response.body) throw new Error();
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        for (;;) { deadline.throwIfAborted(); const item = await reader.read(); if (item.done) break; bytes += item.value.length;
          if (bytes > 4 * 1024 ** 2) throw new Error(); chunks.push(item.value); }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    };
    const releaseTag = (value: unknown): string | undefined => {
      const release = record(value), tag = release.tag_name;
      const pattern = channel === "beta" ? /^v\d+\.\d+\.\d+-beta(?:\.[0-9A-Za-z.-]+)?$/u : /^v\d+\.\d+\.\d+$/u;
      return release.draft === false && release.prerelease === (channel === "beta") && typeof tag === "string" && pattern.test(tag) ? tag : undefined;
    };
    try {
      let ref = channel === "dev" ? "main" : undefined;
      if (channel === "release") ref = releaseTag(await read("releases/latest"));
      if (channel === "beta") for (let page = 1; page <= 3 && !ref; page++) {
        const releases = await read(`releases?per_page=100&page=${page}`); if (!Array.isArray(releases)) throw new Error();
        ref = releases.map(releaseTag).find((tag): tag is string => tag !== undefined); if (releases.length < 100) break;
      }
      if (!ref) return result("missing");
      const commit = record(await read(`commits/${encodeURIComponent(ref)}`)).sha;
      if (typeof commit !== "string" || !HASH.test(commit)) return result("unavailable");
      const latest: DevelopmentSourceLatestVersion = { ...result("ready"), ref, commit };
      if (!mainCommit || !HASH.test(mainCommit)) return latest;
      if (mainCommit === commit) return { ...latest, ahead: 0, behind: 0 };
      try {
        const comparison = record(await read(`compare/${mainCommit}...${commit}?per_page=1`));
        const ahead = comparison.behind_by, behind = comparison.ahead_by;
        if (record(comparison.base_commit).sha === mainCommit && Number.isSafeInteger(ahead) && Number(ahead) >= 0 && Number.isSafeInteger(behind) && Number(behind) >= 0) {
          return { ...latest, ahead: Number(ahead), behind: Number(behind) };
        }
      } catch { signal.throwIfAborted(); /* A local-only official branch has no public comparison proof. */ }
      return latest;
    } catch (error) {
      if (signal.aborted) throw new PersonalDevelopmentError("CANCELLED");
      return result(error instanceof MissingSourceRef ? "missing" : "unavailable");
    }
  }
  return async (channel: DevelopmentChannel, mainCommit: string | undefined, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!["dev", "beta", "release"].includes(channel)) throw new PersonalDevelopmentError("INVALID_ARGUMENT");
    let cached = cache.get(channel);
    if (!cached || cached.mainCommit !== mainCommit || cached.expires <= now()) {
      cached = { mainCommit, expires: now() + 60_000, value: query(channel, mainCommit, signal) }; cache.set(channel, cached);
    }
    try {
      const value = await cached.value; if (value.status !== "ready" && cache.get(channel) === cached) cache.delete(channel); return value;
    } catch (error) { if (cache.get(channel) === cached) cache.delete(channel); throw error; }
  };
}
