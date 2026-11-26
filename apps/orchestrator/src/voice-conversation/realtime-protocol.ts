import type { PiManagedModel } from "@joko/adapter-pi";

export type RealtimeProtocol = "openai-realtime" | "qwen-audio-realtime";
export function isRealtimeProtocol(value: string): value is RealtimeProtocol {
  return value === "openai-realtime" || value === "qwen-audio-realtime";
}
export function officialRealtimeProtocol(url: URL, model: string): RealtimeProtocol | undefined {
  if (url.protocol !== "https:" || url.port) return;
  if (url.hostname === "api.openai.com") {
    if (/^gpt-realtime(?:-(?:mini|\d+(?:\.\d+)*(?:-mini)?))?(?:-\d{4}-\d{2}-\d{2})?$/.test(model)
      || /^gpt-4o(?:-mini)?-realtime-preview(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) return "openai-realtime";
    return;
  }
  if (!/^qwen-audio-3\.[01]-realtime-(plus|flash)$/.test(model)) return;
  if (url.hostname === "token-plan.cn-beijing.maas.aliyuncs.com") return model === "qwen-audio-3.0-realtime-plus" ? "qwen-audio-realtime" : undefined;
  if (["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com"].includes(url.hostname)
    || /^(?!token-plan\.)[a-z0-9-]+\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(url.hostname)) return "qwen-audio-realtime";
}
export function realtimeModelAllowed(model: PiManagedModel, ownerBase: string, credentialOrigin: string): boolean {
  const mode = model.mode ?? model.discoveredMetadata?.mode;
  if (mode !== "realtime" && mode !== "audio_realtime") return false;
  try {
    const url = new URL(model.baseUrl ?? ownerBase);
    if (url.origin !== new URL(ownerBase).origin || url.origin !== credentialOrigin || url.search || url.hash || url.username || url.password
      || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) return false;
    const input = model.declaredInputModalities ?? model.discoveredMetadata?.inputModalities;
    const output = model.declaredOutputModalities ?? model.discoveredMetadata?.outputModalities;
    if (input && !input.includes("audio") || output && !output.includes("audio")) return false;
    if (officialRealtimeProtocol(url, model.id)) return true;
    return url.hostname !== "api.openai.com" && !url.hostname.endsWith(".aliyuncs.com") && input?.includes("audio") === true && output?.includes("audio") === true;
  } catch { return false; }
}
