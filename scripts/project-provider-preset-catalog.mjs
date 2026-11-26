import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

const installed = new URL("../packages/adapter-pi/node_modules/@earendil-works/pi-ai", import.meta.url);
const directory = realpathSync(process.argv[2] ?? installed);
const exactVersion = JSON.parse(readFileSync(new URL("../packages/adapter-pi/package.json", import.meta.url), "utf8"))
  .dependencies["@earendil-works/pi-ai"];
const identity = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
if (identity.name !== "@earendil-works/pi-ai" || identity.version !== exactVersion) {
  throw new Error(`Expected published @earendil-works/pi-ai@${exactVersion}.`);
}

const sources = new Set([
  "ant-ling", "anthropic", "azure", "baseten", "cerebras", "cloudflare-ai-gateway", "cloudflare-workers-ai",
  "deepseek", "fireworks", "github-copilot", "google", "groq", "huggingface", "kimi-coding",
  "minimax", "minimax-cn", "moonshotai", "moonshotai-cn", "nvidia", "openai", "opencode", "opencode-go",
  "openrouter", "qwen-token-plan", "qwen-token-plan-cn", "qwen-token-plan-individual", "together", "vercel-ai-gateway",
  "xai", "xiaomi", "xiaomi-token-plan-ams", "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp", "zai", "zai-coding-cn"
]);
const compatible = new Set(["anthropic-messages", "openai-completions", "openai-responses", "google-generative-ai"]);
const groups = new Map();
const data = join(directory, "dist/providers/data");
for (const filename of readdirSync(data).sort()) {
  const source = filename.replace(/\.json$/u, "");
  if (!sources.has(source)) continue;
  const catalogs = JSON.parse(readFileSync(join(data, filename), "utf8"));
  for (const row of Object.values(catalogs).flatMap(catalog => Object.values(catalog))) {
    if (row.type !== "chat") continue;
    const azure = source === "azure" && row.api === "azure-openai-responses";
    const endpoint = azure ? "https://{resource}.openai.azure.com/openai/v1" : row.baseUrl;
    const api = azure ? "openai-responses" : row.api;
    if (!compatible.has(api) || !endpoint.startsWith("https://")) continue;
    const id = azure ? "azure-openai-responses" : source;
    const groupKey = JSON.stringify([id, endpoint, api]);
    const group = groups.get(groupKey) ?? { source: id, endpoint, api, models: [] };
    const levels = Object.entries(row.thinkingLevelMap ?? {}).filter(([, value]) => value !== null).map(([level]) => level);
    group.models.push([row.id, row.name, row.contextWindow, row.maxTokens, row.input.includes("image"), row.reasoning, levels]);
    groups.set(groupKey, group);
  }
}

const requested = new Set(process.argv.slice(3));
const selected = [...groups.values()].filter(group => requested.size === 0 || requested.has(group.source));
process.stdout.write(JSON.stringify(selected));
