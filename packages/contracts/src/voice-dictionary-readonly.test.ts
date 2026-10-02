import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { VoiceInputDictionaryReadOnlySnapshotSchema } from "./gen/joko/v1/voice_pb.js";
import { isNewerSameHostVoiceDictionary, projectVoiceDictionaryReadOnly,
  readVoiceDictionaryReadOnlyView, voiceDictionaryVectorDominates } from "./voice-dictionary-readonly.js";

const stamp = (n: number, node = "node-a") => `${n.toString(36).padStart(10, "0")}.0000.${node}`;
function wire() { return create(VoiceInputDictionaryReadOnlySnapshotSchema, { revision: 2n, syncEnabled: true,
  entries: [{ text: "Joko", frequency: 3n, aliases: [{ text: "jo ko", count: 2n }] }],
  stateVector: { versions: [{ nodeId: "node-a", stamp: stamp(1) }] } }); }

describe("current-v1 read-only dictionary contract", () => {
  it("requires the causal vector even for an empty or disabled projection and detaches every field", () => {
    const source = wire(); const view = projectVoiceDictionaryReadOnly(source);
    expect(view).toEqual({ revision: 2n, syncEnabled: true, entries: [{ text: "Joko", frequency: 3, aliases: [{ text: "jo ko", count: 2 }] }], stateVector: { "node-a": stamp(1) } });
    source.entries[0]!.text = "Changed";
    expect(view.entries[0]!.text).toBe("Joko"); expect(Object.isFrozen(view.stateVector)).toBe(true);
    expect(projectVoiceDictionaryReadOnly(create(VoiceInputDictionaryReadOnlySnapshotSchema, { revision: 1n, stateVector: {} })).entries).toEqual([]);
    expect(() => projectVoiceDictionaryReadOnly(create(VoiceInputDictionaryReadOnlySnapshotSchema, { revision: 1n }))).toThrow(/read-only/u);
    const off = wire(); off.syncEnabled = false;
    expect(() => projectVoiceDictionaryReadOnly(off)).toThrow(/read-only/u);
    off.entries = []; expect(projectVoiceDictionaryReadOnly(off).stateVector).toEqual({ "node-a": stamp(1) });
  });

  it("rejects duplicate or forged observations, invalid counts, term aliases and unbounded fields", () => {
    for (const change of [
      (value: ReturnType<typeof wire>) => { value.revision = 0n; },
      (value: ReturnType<typeof wire>) => { value.stateVector!.versions.push({ ...value.stateVector!.versions[0]! }); },
      (value: ReturnType<typeof wire>) => { value.stateVector!.versions[0]!.stamp = stamp(1, "other"); },
      (value: ReturnType<typeof wire>) => { value.stateVector!.versions[0]!.stamp = "1.0.node-a"; },
      (value: ReturnType<typeof wire>) => { value.entries[0]!.frequency = BigInt(Number.MAX_SAFE_INTEGER) + 1n; },
      (value: ReturnType<typeof wire>) => { value.entries[0]!.aliases[0]!.text = "JOKO"; },
      (value: ReturnType<typeof wire>) => { value.entries.push(...Array.from({ length: 1_000 }, () => value.entries[0]!)); }
    ]) { const value = wire(); change(value); expect(() => projectVoiceDictionaryReadOnly(value)).toThrow(/read-only/u); }
    expect(() => readVoiceDictionaryReadOnlyView({ ...projectVoiceDictionaryReadOnly(wire()), credential: "private" })).toThrow(/read-only/u);
    const special = wire(); special.stateVector!.versions[0]!.nodeId = "__proto__"; special.stateVector!.versions[0]!.stamp = stamp(1, "__proto__");
    expect(Object.keys(projectVoiceDictionaryReadOnly(special).stateVector)).toEqual(["__proto__"]);
  });

  it("compares all causal components and uses durable host-local revision for unchanged-vector toggles", () => {
    const initial = projectVoiceDictionaryReadOnly(wire());
    const disabled = readVoiceDictionaryReadOnlyView({ ...initial, revision: 3n, syncEnabled: false, entries: [] });
    expect(isNewerSameHostVoiceDictionary(disabled, initial)).toBe(true);
    expect(isNewerSameHostVoiceDictionary(initial, disabled)).toBe(false);
    expect(isNewerSameHostVoiceDictionary({ ...initial, revision: 4n, stateVector: {} }, disabled)).toBe(false);
    expect(voiceDictionaryVectorDominates({ a: stamp(99, "a") }, { b: stamp(1, "b") })).toBe(false);
    expect(voiceDictionaryVectorDominates({ a: stamp(2, "a"), b: stamp(1, "b") }, { a: stamp(1, "a"), b: stamp(1, "b") })).toBe(true);
  });
});
