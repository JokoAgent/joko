import { create } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import type { HostedAgentFrame } from "./hosted-agent-exchange.js";
import type { HostedAgentOpen } from "./hosted-agent-host.js";
import type { HostedAgentTransport } from "./hosted-agent-poller.js";
import type { HostedAgentCall } from "./hosted-agent-run.js";
import type { HostedNativeInferenceRequest } from "@joko/adapter-hosted";
import { HOSTED_AGENT_WIRE_FORMAT, HostedAgentWireError, assertHostedAgentWireFormat, decodeHostedAgentValue, encodeHostedAgentValue } from "./hosted-agent-wire.js";

/** The saved node/grant owner supplies the authenticated generated client.
 * This transport never accepts an arbitrary URL, bearer or inferred local route. */
export class HostedAgentConnectClient implements HostedAgentTransport {
  readonly #client: Client<typeof contract.HostedAgentService>;
  readonly #assertCurrent: () => void;
  constructor(client: Client<typeof contract.HostedAgentService>, assertCurrent: () => void) { this.#client = client; this.#assertCurrent = assertCurrent; }
  async catalog(signal: AbortSignal): Promise<contract.GetHostedAgentCatalogResponse> {
    this.#check(signal);
    const result = await this.#client.getHostedAgentCatalog({ format: HOSTED_AGENT_WIRE_FORMAT }, { signal });
    this.#check(signal); assertHostedAgentWireFormat(result.format); return result;
  }
  async open(input: HostedAgentOpen, signal: AbortSignal): Promise<{ readonly runId: string; readonly virtualRoot: string }> {
    this.#check(signal);
    const result = await this.#client.openHostedAgent(create(contract.OpenHostedAgentRequestSchema, { format: HOSTED_AGENT_WIRE_FORMAT, openJson: encodeHostedAgentValue(input) }), { signal });
    this.#check(signal); assertHostedAgentWireFormat(result.format);
    if (result.runId !== input.runId || !result.virtualRoot || result.virtualRoot.length > 16_384 || result.virtualRoot.includes("\0")) throw new HostedAgentWireError();
    return { runId: result.runId, virtualRoot: result.virtualRoot };
  }
  async call(runId: string, callId: string, command: HostedAgentCall, signal: AbortSignal): Promise<unknown> {
    this.#check(signal);
    const result = await this.#client.callHostedAgent(create(contract.CallHostedAgentRequestSchema, { format: HOSTED_AGENT_WIRE_FORMAT, runId, callId, commandJson: encodeHostedAgentValue(command) }), { signal });
    this.#check(signal); assertHostedAgentWireFormat(result.format); return decodeHostedAgentValue(result.resultJson);
  }
  async infer(request: HostedNativeInferenceRequest, signal: AbortSignal): Promise<string> {
    this.#check(signal);
    const result = await this.#client.callHostedAgent(create(contract.CallHostedAgentRequestSchema, { format: HOSTED_AGENT_WIRE_FORMAT,
      runId: request.requestId, callId: request.requestId, commandJson: encodeHostedAgentValue({ kind: "infer", request }) }), { signal });
    this.#check(signal); assertHostedAgentWireFormat(result.format);
    const text = decodeHostedAgentValue(result.resultJson);
    if (typeof text !== "string" || text.length > 4_000_000) throw new HostedAgentWireError();
    return text;
  }
  async poll(cursors: Parameters<HostedAgentTransport["poll"]>[0], signal: AbortSignal): ReturnType<HostedAgentTransport["poll"]> {
    this.#check(signal);
    const result = await this.#client.pollHostedAgents(create(contract.PollHostedAgentsRequestSchema, { format: HOSTED_AGENT_WIRE_FORMAT,
      cursors: cursors.map(cursor => ({ runId: cursor.runId, after: BigInt(cursor.after) })) }), { signal });
    this.#check(signal); assertHostedAgentWireFormat(result.format);
    return result.runs.map(run => {
      const frames = decodeHostedAgentValue(run.framesJson), cursor = Number(run.cursor);
      if (!Array.isArray(frames) || !Number.isSafeInteger(cursor) || cursor < 0) throw new HostedAgentWireError();
      return { runId: run.runId, cursor, finished: run.finished, frames: frames as HostedAgentFrame[] };
    });
  }
  async reply(runId: string, id: string, value: Parameters<HostedAgentTransport["reply"]>[2], signal: AbortSignal): Promise<void> {
    this.#check(signal);
    const result = await this.#client.replyHostedAgent(create(contract.ReplyHostedAgentRequestSchema, { format: HOSTED_AGENT_WIRE_FORMAT, runId, requestId: id, resultJson: encodeHostedAgentValue(value) }), { signal });
    this.#check(signal); assertHostedAgentWireFormat(result.format);
  }
  async readArtifact(runId: string, id: string, offset: number, maximum: number, signal: AbortSignal): Promise<{ readonly data: string }> {
    this.#check(signal);
    const result = await this.#client.readHostedAgentArtifact(create(contract.ReadHostedAgentArtifactRequestSchema,
      { format: HOSTED_AGENT_WIRE_FORMAT, runId, artifactId: id, offset: BigInt(offset), maximumBytes: maximum }), { signal });
    this.#check(signal); assertHostedAgentWireFormat(result.format);
    if (result.data.byteLength > maximum) throw new HostedAgentWireError(); return { data: Buffer.from(result.data).toString("base64") };
  }
  async close(runId: string, signal: AbortSignal): Promise<void> {
    this.#check(signal);
    const result = await this.#client.closeHostedAgent(create(contract.CloseHostedAgentRequestSchema, { format: HOSTED_AGENT_WIRE_FORMAT, runId }), { signal });
    this.#check(signal); assertHostedAgentWireFormat(result.format);
  }
  #check(signal: AbortSignal): void { signal.throwIfAborted(); this.#assertCurrent(); }
}
