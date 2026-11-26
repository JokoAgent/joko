import { lstat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { readCodexOwnedAuthentication } from "./hosted-authentication.js";
import { readNativeCatalog } from "./smart-subagent-routing.js";

export interface CodexCatalogAccount {
  readonly key: string;
  readonly modifiedAt: number;
}

export interface CodexModelContext {
  readonly contextWindow?: number;
  readonly contextWindowMax?: number;
}

export async function readCodexCatalogAccount(home: string): Promise<CodexCatalogAccount | undefined> {
  if (!isAbsolute(home)) return undefined;
  try {
    const path = join(home, "auth.json");
    const before = await lstat(path);
    const account = await readCodexOwnedAuthentication(home);
    const after = await lstat(path);
    if (account.kind !== "chatgpt" || before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs) return undefined;
    return { key: JSON.stringify([home, account.principal, account.tokens.chatgptPlanType]), modifiedAt: after.mtimeMs };
  } catch { return undefined; }
}

export async function readCodexModelContextCatalog(home: string): Promise<{
  readonly identity: string; readonly fetchedAt: number; readonly models: ReadonlyMap<string, CodexModelContext>;
} | undefined> {
  try {
    const { value } = await readNativeCatalog(home);
    if (!record(value) || typeof value["identity"] !== "string" || !/^[a-f0-9]{64}$/u.test(value["identity"])
      || typeof value["fetched_at"] !== "string" || !Array.isArray(value["models"]) || value["models"].length > 4096) return undefined;
    const fetchedAt = Date.parse(value["fetched_at"]);
    if (!Number.isFinite(fetchedAt)) return undefined;
    const models = new Map<string, CodexModelContext>();
    const seen = new Set<string>();
    for (const raw of value["models"]) {
      if (!record(raw) || typeof raw["slug"] !== "string") continue;
      const slug = raw["slug"];
      if (seen.has(slug)) { models.delete(slug); continue; }
      seen.add(slug);
      if (raw["visibility"] !== "list" || raw["supported_in_api"] !== true) continue;
      const contextWindow = tokens(raw["context_window"]);
      const maximum = tokens(raw["max_context_window"]);
      const contextWindowMax = maximum !== undefined && (contextWindow === undefined || maximum >= contextWindow) ? maximum : undefined;
      models.set(slug, { contextWindow, contextWindowMax });
    }
    return { identity: value["identity"], fetchedAt, models };
  } catch { return undefined; }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function tokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
