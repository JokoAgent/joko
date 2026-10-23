import { create } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import { PartnerNetworkExecutionSchema, type PartnerNetworkExecution } from "./gen/joko/v1/partner_network_pb.js";
import { networkFailureSourceBatches, PartnerNetworkFailureProjection } from "./partner-network-failure-projection.js";

it("queries every loaded source in bounded deduplicated batches without creating history messages", async () => {
  const messages = Array.from({ length: 247 }, (_, index) => ({ id: String(index) })), projection = new PartnerNetworkFailureProjection(), requested: readonly string[][] = networkFailureSourceBatches([...messages, messages[0]!, { id: "deleted", deleted: true }]);
  expect(requested.map(batch => batch.length)).toEqual([100, 100, 47]);
  await projection.refresh(messages, async ids => ids.includes("0") ? [create(PartnerNetworkExecutionSchema, { id: "failed", sourceMessageId: "0", status: "failed", failureCode: "network" })] : [], new AbortController().signal);
  expect(projection.rows).toHaveLength(1); expect(messages).toHaveLength(247);
  await projection.refresh(messages, async () => [], new AbortController().signal); expect(projection.rows).toEqual([]);
});
it("does not revive an old epoch after a newer refresh, source removal or permission rejection", async () => {
  const projection = new PartnerNetworkFailureProjection(); let release!: (rows: readonly PartnerNetworkExecution[]) => void;
  const old = projection.refresh([{ id: "source" }], () => new Promise(resolve => { release = resolve; }), new AbortController().signal);
  await projection.refresh([{ id: "source" }, { id: "new-page" }], async () => [], new AbortController().signal);
  release([create(PartnerNetworkExecutionSchema, { id: "old", sourceMessageId: "source", status: "failed" })]); expect(await old).toBe(false); expect(projection.rows).toEqual([]);
  const aborted = new AbortController(); const late = projection.refresh([{ id: "source" }], async () => [create(PartnerNetworkExecutionSchema, { id: "old", sourceMessageId: "source", status: "failed" })], aborted.signal); projection.clear(); aborted.abort(); await late; expect(projection.rows).toEqual([]);
});
