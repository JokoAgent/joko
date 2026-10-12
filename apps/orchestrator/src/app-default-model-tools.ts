import { Code, ConnectError } from "@connectrpc/connect";
import type { AppDefaultModelCoordinator } from "./app-default-model.js";
import type { PartnerProfileTools } from "./partner-profile-tools.js";
import type { BridgeToolCallContext, BridgeToolProvider } from "./mcp-router.js";

export class AppDefaultModelTools implements BridgeToolProvider {
  readonly canonicalPartnerOnly = true;
  readonly id = "joko_app_default_model"; readonly generation = 1; readonly available = true;
  readonly tools = [
    { serverId: this.id, name: "get_app_default_model", description: "Read the application's current UI-owned default model and the enabled model ids, efforts and Fast support. The default configures future tasks and Partners that follow the uncustomized defaults. It does not describe this turn's running model.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false }, requiresPermission: false },
    { serverId: this.id, name: "set_app_default_model", description: "Change the application default only when the user explicitly requests a global default model change. First read get_app_default_model and use its enabled opaque id. Preserve tuning unless requested. Waits up to five seconds for the actual UI picker to confirm. Existing tasks and customized global/Partner model chains remain unchanged. On failure read current state before an explicit retry; never assume the UI changed.",
      inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 2_048 }, effort: { type: "string", maxLength: 64 }, fast_mode: { type: "boolean" } }, required: ["id"], additionalProperties: false }, requiresPermission: true }
  ];
  constructor(readonly defaults: AppDefaultModelCoordinator, readonly profiles: PartnerProfileTools) {}
  includeForTarget(targetId: string) { return this.profiles.includeForTarget(targetId); }
  async callTool(name: string, input: Readonly<Record<string, unknown>>, signal: AbortSignal | undefined, context: BridgeToolCallContext) {
    try {
      const caller = this.profiles.currentCaller(context, signal); let value;
      if (name === "get_app_default_model") {
        if (Object.keys(input).length) throw new ConnectError("This tool has no arguments.", Code.InvalidArgument);
        value = this.defaults.read(); caller.assertCurrent();
      } else if (name === "set_app_default_model") {
        if (Object.keys(input).some(key => !["id", "effort", "fast_mode"].includes(key)) || typeof input["id"] !== "string"
          || input["id"].length < 1 || input["id"].length > 2_048 || input["effort"] !== undefined && (typeof input["effort"] !== "string" || input["effort"].length > 64)
          || input["fast_mode"] !== undefined && typeof input["fast_mode"] !== "boolean") throw new ConnectError("Read the enabled default models before choosing a route and tuning.", Code.InvalidArgument);
        value = await this.defaults.select({ sessionId: context.sessionId, id: input["id"],
          ...(input["effort"] === undefined ? {} : { effort: input["effort"] as string }),
          ...(input["fast_mode"] === undefined ? {} : { fastMode: input["fast_mode"] as boolean }), assertCaller: caller.assertCurrent,
          ...(signal === undefined ? {} : { signal }) });
        caller.assertCurrent(this.profiles.partners.getPartner(caller.profile.id));
      } else throw new ConnectError("Application default model tool is unavailable.", Code.NotFound);
      return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value, isError: false };
    } catch (error) {
      signal?.throwIfAborted(); return { content: [{ type: "text" as const, text: error instanceof ConnectError ? error.rawMessage
        : "The application default model was not confirmed. Read the current default before explicitly retrying." }], isError: true };
    }
  }
}
