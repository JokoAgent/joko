import type { PiMcpToolDescriptor } from "./config.js";
import type { PiMcpBridgeOptions } from "./adapter.js";

export const NATIVE_ROOT_REQUEST_PREFIX = "joko:native-root-call/v1/";
interface RootCall { readonly tool: PiMcpToolDescriptor; readonly scope: object; readonly arguments: Readonly<Record<string, unknown>>; readonly current: () => boolean; claimed: boolean }

/** Only the parent Pi RPC transport may feed this registry. A descendant's
 * inherited bearer or forwarded UI title cannot create a native ToolStart. */
export class PiNativeRootTools {
  readonly #calls = new Map<string, RootCall>();
  constructor(readonly tools: readonly PiMcpToolDescriptor[], readonly capture: PiMcpBridgeOptions["captureRootCall"]) {}
  observe(event: Readonly<Record<string, unknown>>, scope: object | undefined, current: () => boolean): void {
    const id = event["toolCallId"];
    if (typeof id !== "string" || !id || id.length > 1_024) return;
    if (event["type"] === "tool_execution_end") { if (this.#calls.get(id)?.scope === scope) this.#calls.delete(id); return; }
    if (event["type"] !== "tool_execution_start" || !scope || !current()) return;
    for (const [key, call] of this.#calls) if (call.scope !== scope || !call.current()) this.#calls.delete(key);
    const tool = this.tools.find(candidate => candidate.requiresNativeRoot && (candidate.runtimeName ?? `mcp__${candidate.serverId}__${candidate.name}`) === event["toolName"]);
    const args = event["args"];
    if (!tool || !args || typeof args !== "object" || Array.isArray(args) || this.#calls.has(id)) return;
    if (this.#calls.size >= 256) return;
    this.#calls.set(id, { tool, scope, arguments: structuredClone(args) as Readonly<Record<string, unknown>>, current, claimed: false });
  }
  request(event: Readonly<Record<string, unknown>>, scope: object | undefined): { readonly id: string; readonly value: string } | { readonly id: string; readonly cancelled: true } | undefined {
    if (event["method"] !== "input" || typeof event["title"] !== "string" || !event["title"].startsWith(NATIVE_ROOT_REQUEST_PREFIX)) return undefined;
    const id = typeof event["id"] === "string" ? event["id"] : "", refuse = { id, cancelled: true as const };
    if (!id || !scope || !this.capture || event["title"].length > 8_192) return refuse;
    try {
      const encoded = event["title"].slice(NATIVE_ROOT_REQUEST_PREFIX.length), bytes = Buffer.from(encoded, "base64url");
      if (bytes.toString("base64url") !== encoded) return refuse;
      const raw: unknown = JSON.parse(bytes.toString("utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).sort().join(",") !== "requestId,serverId,toolName") return refuse;
      const request = raw as Record<string, unknown>, requestId = request["requestId"];
      if (typeof requestId !== "string") return refuse;
      const call = this.#calls.get(requestId);
      if (!call || call.claimed || call.scope !== scope || !call.current() || request["serverId"] !== call.tool.serverId || request["toolName"] !== call.tool.name) return refuse;
      const assertCurrent = () => { if (this.#calls.get(requestId) !== call || !call.current()) throw new Error("The native root tool turn retired."); };
      assertCurrent(); call.claimed = true;
      const proof = this.capture({ requestId, serverId: call.tool.serverId, toolName: call.tool.name, arguments: call.arguments, assertCurrent });
      if (!/^[A-Za-z0-9_-]{43}$/u.test(proof)) return refuse;
      assertCurrent(); return { id, value: proof };
    } catch { return refuse; }
  }
  clear(): void { this.#calls.clear(); }
}
