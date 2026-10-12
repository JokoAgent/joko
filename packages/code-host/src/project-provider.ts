import { createGhCliTokenSource, type GhCliTokenSource } from "./gh-cli-token-source.js";

export interface CodeHostProjectItems {
  readonly pullRequests: readonly CodeHostProjectItem[];
  readonly issues: readonly CodeHostProjectItem[];
  readonly unavailable?: "no_credential" | "unavailable";
}
export interface CodeHostProjectItem { readonly number: number; readonly title: string; readonly url: string; readonly updatedAt: number }

/** The same configured credential owner used by the existing code-host
 * projection. A project grant is checked before and after every outbound read. */
export class CodeHostProjectProvider {
  readonly #credentials: Pick<GhCliTokenSource, "readCredential" | "isCurrent">;
  readonly #fetch: typeof globalThis.fetch;
  constructor(options: { readonly credentials?: Pick<GhCliTokenSource, "readCredential" | "isCurrent">; readonly fetch?: typeof globalThis.fetch } = {}) {
    this.#credentials = options.credentials ?? createGhCliTokenSource();
    this.#fetch = options.fetch ?? globalThis.fetch;
  }
  async read(repository: string, assertScope: () => void): Promise<CodeHostProjectItems> {
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(repository)) throw new TypeError("Invalid code-host repository.");
    assertScope();
    const credential = await this.#credentials.readCredential();
    assertScope();
    if (credential === undefined) return { pullRequests: [], issues: [], unavailable: "no_credential" };
    const assertCurrent = (): void => {
      assertScope();
      if (!this.#credentials.isCurrent(credential)) throw new Error("The code-host credential owner changed.");
    };
    const read = async (path: string): Promise<unknown> => {
      assertCurrent();
      const response = await this.#fetch(new URL(path, "https://api.github.com"), { headers: {
        accept: "application/vnd.github+json", authorization: `Bearer ${credential.token}`,
        "x-github-api-version": "2022-11-28", "user-agent": "Joko-Code-Host/0.1"
      }, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(10_000) });
      if (!response.ok || !response.headers.get("content-type")?.includes("json")) throw new Error("The code-host project read failed.");
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error("The code-host response is unavailable.");
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > 256 * 1024) throw new Error("The code-host response limit was exceeded.");
          chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      assertCurrent();
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    };
    try {
      const viewer = await read("/user");
      if (!record(viewer) || typeof viewer["login"] !== "string" || !/^[A-Za-z0-9-]{1,100}$/u.test(viewer["login"])) throw new Error("The code-host owner is unavailable.");
      const search = async (query: string): Promise<readonly CodeHostProjectItem[]> => {
        const result = await read(`/search/issues?${new URLSearchParams({ q: `repo:${repository} is:open ${query}`, sort: "updated", per_page: "10" })}`);
        if (!record(result) || !Array.isArray(result["items"])) throw new Error("The code-host project result is invalid.");
        return result["items"].slice(0, 10).flatMap((item: unknown) => {
          if (!record(item) || !Number.isSafeInteger(item["number"]) || Number(item["number"]) < 1 || typeof item["title"] !== "string" || typeof item["html_url"] !== "string") return [];
          const url = new URL(item["html_url"]);
          if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || !url.pathname.startsWith(`/${repository}/`) || url.toString().includes(credential.token)) return [];
          const at = typeof item["updated_at"] === "string" ? Date.parse(item["updated_at"]) : NaN;
          return [{ number: Number(item["number"]), title: item["title"].replaceAll(credential.token, "[redacted]").slice(0, 200), url: url.toString(), updatedAt: Number.isFinite(at) ? at : 0 }];
        });
      };
      const [pullRequests, authored, assigned] = await Promise.all([
        search(`is:pr author:${viewer["login"]}`), search(`is:issue author:${viewer["login"]}`), search(`is:issue assignee:${viewer["login"]}`)
      ]);
      assertCurrent();
      const issues = new Map([...assigned, ...authored].map((item) => [item.number, item]));
      return { pullRequests, issues: [...issues.values()].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 10) };
    } catch {
      assertScope();
      return { pullRequests: [], issues: [], unavailable: "unavailable" };
    }
  }
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
