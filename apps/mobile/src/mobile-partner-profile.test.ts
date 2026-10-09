import { create } from "@bufbuild/protobuf";
import { PartnerDirectorySchema, UpdatePartnerResponseSchema } from "@joko/contracts";
import { describe, expect, it } from "vitest";
import { mobilePartnerProfileDraft, projectMobilePartnerProfileOptions, projectMobilePartnerProfileUpdate,
  validateMobilePartnerProfileDraft } from "./mobile-partner-profile";
import { profilePartner, profilePartnerWire, profileSnapshot } from "./test/mobile-partner-profile";

describe("mobile Partner profile validation", () => {
  it("normalizes names, preserves identity and rejects normalized collisions and bad text", () => {
    const draft = mobilePartnerProfileDraft(profilePartner);
    expect(validateMobilePartnerProfileDraft(profileSnapshot, { ...draft, displayName: "  Ａｄａ  Two ", identitySource: " Work \n More " }))
      .toMatchObject({ displayName: "Ada Two", identitySource: "Work \n More" });
    expect(() => validateMobilePartnerProfileDraft(profileSnapshot, { ...draft, displayName: "Ｂｅａ" })).toThrow(/already/u);
    expect(() => validateMobilePartnerProfileDraft(profileSnapshot, { ...draft, identitySource: "" })).toThrow(/identity/u);
    expect(() => validateMobilePartnerProfileDraft(profileSnapshot, { ...draft, avatar: "other" })).toThrow(/avatar/u);
  });

  it("requires current models, unique same-Backend ordered routes and advertised options", () => {
    const draft = mobilePartnerProfileDraft(profilePartner);
    const first = draft.capabilities.modelChain[0]!;
    expect(() => validateMobilePartnerProfileDraft(profileSnapshot, { ...draft, capabilities: { ...draft.capabilities,
      modelChain: [first, first] } })).toThrow(/unique/u);
    expect(() => validateMobilePartnerProfileDraft(profileSnapshot, { ...draft, capabilities: { ...draft.capabilities,
      modelChain: [{ ...first, backendId: "other" }] } })).toThrow(/available/u);
    expect(() => validateMobilePartnerProfileDraft(profileSnapshot, { ...draft, capabilities: { ...draft.capabilities,
      modelChain: [{ ...first, effort: undefined }] } })).toThrow(/available/u);
    expect(() => validateMobilePartnerProfileDraft({ ...profileSnapshot, canSetFastMode: false }, { ...draft,
      capabilities: { ...draft.capabilities, modelChain: [{ ...first, fastMode: true }] } })).toThrow(/available/u);
    expect(() => validateMobilePartnerProfileDraft({ ...profileSnapshot, permissionModes: ["ask"] }, { ...draft,
      capabilities: { ...draft.capabilities, permissionMode: "auto" } })).toThrow(/capability/u);
  });

  it("uses current directory defaults and rejects absent defaults", () => {
    const draft = { ...mobilePartnerProfileDraft(profilePartner), usesDirectoryDefaults: true };
    expect(validateMobilePartnerProfileDraft(profileSnapshot, draft).capabilities).toEqual(profilePartner.capabilities);
    expect(() => validateMobilePartnerProfileDraft({ ...profileSnapshot, options: {
      ...profileSnapshot.options, defaultCapabilities: undefined } }, draft)).toThrow(/defaults/u);
  });

  it("projects current choices and requires an exact non-regressing update acknowledgement", () => {
    const directory = create(PartnerDirectorySchema, { revision: { value: 4n }, avatarPresets: ["orbit", "spark"] });
    expect(projectMobilePartnerProfileOptions(directory).avatarPresets).toEqual(["orbit", "spark"]);
    const response = create(UpdatePartnerResponseSchema, { partner: profilePartnerWire(), directory });
    expect(projectMobilePartnerProfileUpdate("partner-a", 2n, response).displayName).toBe("Ada");
    expect(() => projectMobilePartnerProfileUpdate("partner-b", 2n, response)).toThrow(/mismatched/u);
    expect(() => projectMobilePartnerProfileUpdate("partner-a", 3n, response)).toThrow(/mismatched/u);
    directory.avatarPresets.push("orbit");
    expect(() => projectMobilePartnerProfileOptions(directory)).toThrow(/invalid/u);
  });
});
