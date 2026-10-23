import { z } from "zod";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import type { PiMcpToolDescriptor } from "@joko/adapter-pi";

const id = z.string().min(1).max(1024).refine(value => !/[\x00-\x1f\x7f]/u.test(value));
const args = z.record(z.string(), z.unknown());
export const hostedMcpRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("catalog") }),
  z.strictObject({ kind: z.literal("call"), requestId: id, serverId: id, toolName: id, arguments: args, root: z.boolean(), modelCallId: id.optional() }),
  z.strictObject({ kind: z.literal("model_open"), pipeId: z.uuid(), serverId: id }),
  z.strictObject({ kind: z.literal("model_send"), pipeId: z.uuid(), message: JSONRPCMessageSchema }),
  z.strictObject({ kind: z.literal("model_poll"), pipeId: z.uuid() }),
  z.strictObject({ kind: z.literal("model_reply"), pipeId: z.uuid(), callId: id, ok: z.boolean() }),
  z.strictObject({ kind: z.literal("model_close"), pipeId: z.uuid() })
]);
export type HostedMcpRequest = z.infer<typeof hostedMcpRequestSchema>;
export type HostedMcpMessage = z.infer<typeof JSONRPCMessageSchema>;
export interface HostedMcpCatalog { readonly tools: readonly PiMcpToolDescriptor[]; readonly modelServerIds: readonly string[] }
export type HostedMcpFrame = { readonly kind: "message"; readonly message: HostedMcpMessage; readonly relatedRequestId?: string | number } | {
  readonly kind: "native_call"; readonly callId: string; readonly serverId: string; readonly toolName: string; readonly requestId: string;
  readonly arguments: Readonly<Record<string, unknown>>; readonly metadata?: Readonly<Record<string, unknown>>;
};
