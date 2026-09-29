import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import {
  AddVoiceInputDictionaryTermsRequestSchema,
  ApplyVoiceInputDictionaryLearningRequestSchema,
  EditVoiceInputDictionaryEntryRequestSchema,
  GetVoiceInputDictionaryRequestSchema,
  SetVoiceInputDictionarySyncEnabledRequestSchema,
  VoiceInputDictionaryLearningActionType
} from "@joko/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { OrchestratorE2eFixture } from "./fixture.js";

describe("durable voice dictionary through authenticated generated RPCs", () => {
  let fixture: OrchestratorE2eFixture | undefined;
  afterEach(async () => { await fixture?.close({ removeRoot: true }); fixture = undefined; });

  it("shares one service revision between clients, rejects late learning and restores the same projection after restart", async () => {
    fixture = await OrchestratorE2eFixture.start({ keepRoot: true });
    const request = create(GetVoiceInputDictionaryRequestSchema);
    await expect(fixture.anonymous.voiceInput.getVoiceInputDictionary(request)).rejects.toMatchObject({ code: Code.Unauthenticated });
    await expect(fixture.anonymous.voiceInput.addVoiceInputDictionaryTerms(create(AddVoiceInputDictionaryTermsRequestSchema, {
      expectedRevision: 1n, terms: ["UnpairedTerm"]
    }))).rejects.toMatchObject({ code: Code.Unauthenticated });
    const first = await fixture.pair("Dictionary editor");
    const second = await fixture.pair("Dictionary learner");
    const editor = first.clients.voiceInput;
    const learner = second.clients.voiceInput;
    const initial = (await editor.getVoiceInputDictionary(request)).dictionary!;
    expect(initial.entries).toEqual([]);
    const imported = (await editor.addVoiceInputDictionaryTerms(create(AddVoiceInputDictionaryTermsRequestSchema, {
      expectedRevision: initial.revision, terms: ["Joko", "Orchestrator", "joko"]
    }))).dictionary!;
    const learningBasis = (await learner.getVoiceInputDictionary(request)).dictionary!;
    expect(learningBasis).toEqual(imported);
    const entry = imported.entries.find((value) => value.text === "Joko")!;
    const edited = (await editor.editVoiceInputDictionaryEntry(create(EditVoiceInputDictionaryEntryRequestSchema, {
      expectedRevision: imported.revision, entryId: entry.entryId, text: "Joko Core", aliases: ["jo ko"]
    }))).dictionary!;
    await expect(learner.applyVoiceInputDictionaryLearning(create(ApplyVoiceInputDictionaryLearningRequestSchema, {
      expectedRevision: learningBasis.revision,
      actions: [{ action: VoiceInputDictionaryLearningActionType.ADD_ENTRY, term: "LateTerm", aliases: ["late term"] }]
    }))).rejects.toMatchObject({ code: Code.Aborted });
    expect((await learner.getVoiceInputDictionary(request)).dictionary).toEqual(edited);
    const enabled = (await editor.setVoiceInputDictionarySyncEnabled(create(SetVoiceInputDictionarySyncEnabledRequestSchema, {
      expectedRevision: edited.revision, enabled: true
    }))).dictionary!;
    const committed = (await learner.applyVoiceInputDictionaryLearning(create(ApplyVoiceInputDictionaryLearningRequestSchema, {
      expectedRevision: enabled.revision,
      actions: [{ action: VoiceInputDictionaryLearningActionType.ADD_CANDIDATE, term: "VoiceKit", aliases: ["voice kit"] }]
    }))).dictionary!;
    expect(committed.refinementTerms).toEqual(expect.arrayContaining(["Joko Core", "Orchestrator"]));
    expect(committed.candidates).toMatchObject([{ text: "VoiceKit", evidenceCount: 1n }]);
    const rootDirectory = fixture.rootDirectory;
    await fixture.close({ removeRoot: false });
    fixture = await OrchestratorE2eFixture.start({ rootDirectory });
    const restored = fixture.clients(first.authKey).voiceInput;
    expect((await restored.getVoiceInputDictionary(request)).dictionary).toEqual(committed);
    await expect(restored.editVoiceInputDictionaryEntry(create(EditVoiceInputDictionaryEntryRequestSchema, {
      expectedRevision: committed.revision,
      entryId: committed.entries.find((value) => value.text === "Joko Core")!.entryId,
      text: "Joko Core", aliases: []
    }))).resolves.toMatchObject({ dictionary: { revision: committed.revision + 1n, syncEnabled: true } });
  });
});
