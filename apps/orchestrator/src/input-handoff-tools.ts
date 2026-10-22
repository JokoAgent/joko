import { z } from "zod";
import type { OperationalStore } from "@joko/store";
import type { BridgeToolCallContext, BridgeToolProvider } from "./mcp-router.js";
import type { InputHandoffCoordinator } from "./input-handoff/coordinator.js";

export const INPUT_HANDOFF_TOOL_PROVIDER_ID = "joko_input_handoff";
const text = (maximum: number) => z.string().trim().min(1).max(maximum).refine(value => !value.includes("\0"));
const schema = z.object({ purpose: text(200), note: text(500).optional(), target: z.object({ app: text(200).optional(),
  pid: z.number().int().positive().safe().optional(), window_title: text(300).optional() }).strict(),
  complete_when: z.object({ window_closed: z.boolean().optional(), text_appears: text(200).optional(), url_contains: text(500).optional() }).strict().optional(),
  timeout_minutes: z.number().int().min(1).max(60).optional() }).strict();

export class InputHandoffTools implements BridgeToolProvider {
  readonly id = INPUT_HANDOFF_TOOL_PROVIDER_ID; readonly generation = 1;
  readonly configurablePolicy = { id: INPUT_HANDOFF_TOOL_PROVIDER_ID, displayName: "Input handoff", description: "Ask the owner to fill private fields on this computer.", productDefaultEnabled: true,
    localizations: { "zh-CN": { displayName: "输入代填", description: "请主人在自己的设备填写此电脑上的私密字段。" } } };
  get available(): boolean { return (this.options.platform ?? process.platform) === "darwin"; }
  readonly tools = [{ serverId: INPUT_HANDOFF_TOOL_PROVIDER_ID, name: "request_input_handoff", requiresPermission: false, requiresNativeRoot: true as const,
    description: "Ask the owner to fill a sign-in name, password, verification code or other private text in a window on this computer. The owner can also scan a sign-in QR code. Buttons and consent choices remain your responsibility. Values never return to the model. Returns a pending receipt; leave this window alone until the hidden input handoff completion arrives. Terminal sudo -A, ssh and HTTPS git prompts on macOS/Linux use the same owner channel automatically.",
    inputSchema: z.toJSONSchema(schema) }];
  constructor(readonly options: { readonly store: OperationalStore; readonly coordinator: () => InputHandoffCoordinator | undefined; readonly platform?: NodeJS.Platform }) {}
  includeForTarget(targetId: string): boolean { return this.available && this.options.store.getTarget(targetId).descriptor.remoteWorkspace === undefined; }
  async callTool(name: string, input: Readonly<Record<string, unknown>>, signal: AbortSignal | undefined, context: BridgeToolCallContext) {
    const result = (value: Record<string, unknown>, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value, isError });
    try {
      signal?.throwIfAborted(); context.assertCurrent?.();
      if (!context.assertNativeRoot) throw new Error("A native root tool call is required.");
      context.assertNativeRoot();
      if (name !== "request_input_handoff" || !this.available || context.providerGeneration !== undefined && context.providerGeneration !== this.generation) throw new Error();
      const session = this.options.store.getSession(context.sessionId).descriptor;
      if (session.targetId !== context.targetId || session.binding.generation !== context.generation || session.archived || session.deletedAt
        || session.remoteWorkspace || this.options.store.getTarget(context.targetId).descriptor.remoteWorkspace
        || this.options.store.findCollaborationWorkerBySession(context.sessionId)) throw new Error();
      const coordinator = this.options.coordinator(); if (!coordinator) throw new Error();
      const args = schema.parse(input), target = args.target, completion = args.complete_when;
      const started = await coordinator.start({ sessionId: context.sessionId, targetId: context.targetId, generation: context.generation }, {
        purpose: args.purpose, ...(args.note ? { note: args.note } : {}), requester: session.title,
        target: { ...(target.app ? { app: target.app } : {}), ...(target.pid ? { pid: target.pid } : {}), ...(target.window_title ? { windowTitle: target.window_title } : {}) },
        ...(completion ? { completeWhen: { ...(completion.window_closed === undefined ? {} : { windowClosed: completion.window_closed }),
          ...(completion.text_appears ? { textAppears: completion.text_appears } : {}), ...(completion.url_contains ? { urlContains: completion.url_contains } : {}) } } : {}),
        ...(args.timeout_minutes ? { timeoutMinutes: args.timeout_minutes } : {}) });
      signal?.throwIfAborted(); context.assertCurrent?.();
      return started.ok ? result({ request_id: started.requestId, status: "pending", next: "End your turn or do unrelated work. Leave that window alone until the input handoff ends." })
        : result({ errorCode: started.errorCode, message: started.message }, true);
    } catch {
      signal?.throwIfAborted(); return result({ errorCode: "HANDOFF_UNAVAILABLE", message: "The current local task cannot start input handoff. Tell the owner what is needed." }, true);
    }
  }
}
