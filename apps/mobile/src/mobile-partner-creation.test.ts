import { describe, expect, it } from "vitest";
import { mobilePartnerCreationDraft, validateMobilePartnerCreationDraft } from "./mobile-partner-creation";
import { creationSnapshot } from "./test/mobile-partner-creation";

describe("Partner creation draft", () => {
  it("validates the complete creation fields, name collision and fresh capabilities without a synthetic Partner", () => {
    const initial = mobilePartnerCreationDraft(creationSnapshot)!;
    const draft = { ...initial, displayName: "N".repeat(200), avatar: { base64: "/9j/2w==" } };
    expect(validateMobilePartnerCreationDraft(creationSnapshot, draft)).toMatchObject({ displayName: draft.displayName, avatar: draft.avatar });
    expect(() => validateMobilePartnerCreationDraft(creationSnapshot, { ...draft, displayName: "Ａｄａ" })).toThrow(/already/u);
    expect(() => validateMobilePartnerCreationDraft(creationSnapshot, { ...draft, displayName: "N".repeat(201) })).toThrow(/200/u);
    expect(() => validateMobilePartnerCreationDraft(creationSnapshot, { ...draft, templateId: "missing" })).toThrow(/template/u);
    expect(() => validateMobilePartnerCreationDraft(creationSnapshot, { ...draft, avatar: { base64: "bad" } })).toThrow(/avatar/u);
    expect(() => validateMobilePartnerCreationDraft({ ...creationSnapshot, backends: [] }, draft)).toThrow(/Backend/u);
  });

  it("does not create without real models and requires the selected Backend for inherited defaults", () => {
    expect(mobilePartnerCreationDraft({ ...creationSnapshot, backends: [] })).toBeUndefined();
    const draft = { ...mobilePartnerCreationDraft(creationSnapshot)!, displayName: "Nova", usesDirectoryDefaults: false };
    expect(() => validateMobilePartnerCreationDraft(creationSnapshot, { ...draft, capabilities: { ...draft.capabilities,
      modelChain: [{ ...draft.capabilities.modelChain[0]!, effort: "missing" }] } })).toThrow(/no longer/u);
    expect(() => validateMobilePartnerCreationDraft({ ...creationSnapshot, options: { ...creationSnapshot.options,
      defaultCapabilities: { ...draft.capabilities, modelChain: [{ ...draft.capabilities.modelChain[0]!, backendId: "other" }] } } },
    { ...draft, usesDirectoryDefaults: true })).toThrow(/no longer/u);
  });
});
