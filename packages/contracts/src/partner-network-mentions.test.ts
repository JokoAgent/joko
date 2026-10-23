import { expect, it } from "vitest";
import { resolveNetworkMentions, retainNetworkTrackedMentions } from "./partner-network-mentions.js";

it("retains exact picked identities through edits and membership removal without retargeting namesakes", () => {
  const members = [{ actorId: "a", name: "Nova" }, { actorId: "b", name: "Nova" }], text = "@Nova please", tracked = [{ actorId: "b", label: "Nova", start: 0 }];
  expect(resolveNetworkMentions(text, { members, allLabels: ["Everyone"], tracked })).toEqual({ all: false, actorIds: ["b"] });
  const next = "Hi @Nova please", moved = retainNetworkTrackedMentions(text, next, { members, allLabels: ["Everyone"], tracked });
  expect(moved).toEqual([{ actorId: "b", label: "Nova", start: 3 }]);
  expect(resolveNetworkMentions(next, { members: [members[0]!], allLabels: ["Everyone"], tracked: moved }).actorIds).toEqual(["b"]);
  expect(retainNetworkTrackedMentions(next, "Hi please", { members, allLabels: ["Everyone"], tracked: moved })).toEqual([]);
});
it("resolves typed targets in text order and distinguishes a picked namesake from everyone", () => {
  const members = [{ actorId: "a", name: "Nova" }, { actorId: "b", name: "Kai" }, { actorId: "c", name: "Everyone" }];
  expect(resolveNetworkMentions("@Kai @Nova", { members, allLabels: ["Everyone"] }).actorIds).toEqual(["b", "a"]);
  expect(resolveNetworkMentions("@Everyone", { members, allLabels: ["Everyone"] })).toEqual({ all: true, actorIds: [] });
  expect(resolveNetworkMentions("@Everyone", { members, allLabels: ["Everyone"], tracked: [{ actorId: "c", label: "Everyone", start: 0 }] })).toEqual({ all: false, actorIds: ["c"] });
  expect(resolveNetworkMentions("name@Nova.invalid", { members, allLabels: [] }).actorIds).toEqual([]);
});
