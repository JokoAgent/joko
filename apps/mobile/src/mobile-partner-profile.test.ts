import { create } from "@bufbuild/protobuf";
import { PartnerDirectorySchema, PartnerModelRouteSchema, UpdatePartnerResponseSchema } from "@joko/contracts";
import { describe, expect, it } from "vitest";
import { mobilePartnerProfileDraft, projectMobilePartnerProfileOptions, projectMobilePartnerProfileUpdate,
  validateMobilePartnerProfileDraft, mobilePartnerDraftCatalogIdentity } from "./mobile-partner-profile";
import { PermissionMode } from "@joko/contracts";
import { projectMobilePartnerCapabilities, mobilePartnerPermissionToProto } from "./mobile-partner-directory";
import { profilePartner, profilePartnerWire, profileSnapshot } from "./test/mobile-partner-profile";

describe("mobile Partner profile validation", () => {
  it("defaults input handoff on, preserves explicit false, and uses current inherited owner defaults", () => {
    const wire = profilePartnerWire().capabilities!;
    expect(projectMobilePartnerCapabilities({ ...wire, inputHandoff: undefined }).inputHandoff).toBe(true);
    expect(projectMobilePartnerCapabilities({ ...wire, inputHandoff: false }).inputHandoff).toBe(false);
    const draft = { ...mobilePartnerProfileDraft(profilePartner), capabilities: { ...profilePartner.capabilities, inputHandoff: false } };
    expect(validateMobilePartnerProfileDraft(profileSnapshot, draft).capabilities.inputHandoff).toBe(false);
    expect(mobilePartnerProfileDraft({ ...profilePartner, capabilities: draft.capabilities }).capabilities.inputHandoff).toBe(false);
    expect(validateMobilePartnerProfileDraft({ ...profileSnapshot, options: { ...profileSnapshot.options,
      defaultCapabilities: { ...profilePartner.capabilities, inputHandoff: false } } }, { ...draft, usesDirectoryDefaults: true }).capabilities.inputHandoff).toBe(false);
  });
  it("keeps all three exact permission values and refuses full access after any selected route loses support", () => {
    const snapshot = { ...profileSnapshot, permissionModes: ["ask", "auto", "bypassPermissions"] as const };
    const draft = { ...mobilePartnerProfileDraft(profilePartner), capabilities: { ...profilePartner.capabilities, permissionMode: "bypassPermissions" as const } };
    expect(validateMobilePartnerProfileDraft(snapshot, draft).capabilities.permissionMode).toBe("bypassPermissions");
    const inherited = { ...snapshot, options: { ...snapshot.options, defaultCapabilities: draft.capabilities } };
    expect(validateMobilePartnerProfileDraft(inherited, { ...draft, usesDirectoryDefaults: true }).capabilities.permissionMode).toBe("bypassPermissions");
    expect(() => validateMobilePartnerProfileDraft(profileSnapshot, draft)).toThrow(/available/u);
    const identity = mobilePartnerDraftCatalogIdentity(snapshot);
    expect(mobilePartnerDraftCatalogIdentity({ ...snapshot, permissionModes: ["ask", "auto"] })).not.toBe(identity);
    expect(mobilePartnerDraftCatalogIdentity({ ...snapshot, options: { ...snapshot.options, revision: 5n } })).not.toBe(identity);
    expect(mobilePartnerDraftCatalogIdentity({ ...snapshot, models: snapshot.models.map(model => ({ ...model, supportsFastMode: false })) })).not.toBe(identity);
    for (const [mode, wire] of [["ask", PermissionMode.ASK], ["auto", PermissionMode.AUTO], ["bypassPermissions", PermissionMode.BYPASS_PERMISSIONS]] as const) {
      expect(mobilePartnerPermissionToProto(mode)).toBe(wire);
      expect(projectMobilePartnerCapabilities({ ...profilePartnerWire().capabilities!, permissionMode: wire }).permissionMode).toBe(mode);
    }
    expect(() => projectMobilePartnerCapabilities({ ...profilePartnerWire().capabilities!, permissionMode: 99 as PermissionMode })).toThrow(/unsupported/u);
    expect(() => mobilePartnerPermissionToProto("trusted" as never)).toThrow(/supported/u);
  });
  it("admits the same model identity on two Backends and checks each route's actual capabilities", () => {
    const first = profilePartner.capabilities.modelChain[0]!, second = { ...first, backendId: "other-runtime" };
    const axes = { ...profileSnapshot.models[0]!, canSwitchModel: true, canSetEffort: true, canSetFastMode: true,
      canSetPlanMode: true, permissionModes: ["ask", "auto"] as const };
    const snapshot = { ...profileSnapshot, models: [axes, { ...axes, backendId: second.backendId }],
      taskModels: [axes, { ...axes, backendId: second.backendId, canSwitchModel: false, permissionModes: ["ask"] as const }] };
    const draft = { ...mobilePartnerProfileDraft(profilePartner), capabilities: { ...profilePartner.capabilities, modelChain: [first, second] } };
    expect(validateMobilePartnerProfileDraft(snapshot, draft).capabilities.modelChain).toEqual([first, second]);
    expect(() => validateMobilePartnerProfileDraft(snapshot, { ...draft, capabilities: { ...draft.capabilities, permissionMode: "auto" } })).toThrow(/available/u);
  });
  it("projects and validates an independent task route without changing inherited primary settings", () => {
    const task = { ...profilePartner.capabilities.modelChain[0]!, backendId: "task-backend", modelId: "task-model" };
    const model = { ...profileSnapshot.models[0]!, backendId: task.backendId, modelId: task.modelId,
      canSetEffort: true, canSetFastMode: true, canSetPlanMode: true, permissionModes: ["ask", "auto"] as const };
    const snapshot = { ...profileSnapshot, taskModels: [model] };
    const draft = { ...mobilePartnerProfileDraft(profilePartner), usesDirectoryDefaults: true, taskModelOverride: task };
    expect(validateMobilePartnerProfileDraft(snapshot, draft)).toMatchObject({ taskModelOverride: task, capabilities: profilePartner.capabilities });
    const wire = profilePartnerWire({ ...profilePartner, taskModelOverride: task });
    expect(projectMobilePartnerProfileUpdate(profilePartner.partnerId, profilePartner.revision, create(UpdatePartnerResponseSchema, {
      partner: wire, directory: { revision: { value: 4n }, avatarPresets: ["orbit"] }
    })).taskModelOverride).toEqual(task);
    expect(() => validateMobilePartnerProfileDraft({ ...snapshot, taskModels: [] }, draft)).toThrow(/task model/u);
    const selected = { ...snapshot, partner: { ...profilePartner, taskModelOverride: task }, taskModels: [] };
    expect(validateMobilePartnerProfileDraft(selected, { ...draft, displayName: "Ada Two" }).taskModelOverride).toEqual(task);
  });

  it("normalizes names, preserves identity and rejects normalized collisions and bad text", () => {
    const draft = mobilePartnerProfileDraft(profilePartner);
    expect(validateMobilePartnerProfileDraft(profileSnapshot, { ...draft, displayName: "  Ａｄａ  Two ", identitySource: " Work \n More " }))
      .toMatchObject({ displayName: "Ada Two", identitySource: "Work \n More" });
    expect(() => validateMobilePartnerProfileDraft(profileSnapshot, { ...draft, displayName: "Ｂｅａ" })).toThrow(/already/u);
    expect(() => validateMobilePartnerProfileDraft(profileSnapshot, { ...draft, identitySource: "" })).toThrow(/identity/u);
    expect(() => validateMobilePartnerProfileDraft(profileSnapshot, { ...draft, avatar: "other" })).toThrow(/avatar/u);
  });

  it("requires current models, unique ordered routes and advertised options", () => {
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

  it("accepts a current five-route profile and wire projection without accepting a sixth", () => {
    const models = Array.from({ length: 6 }, (_, index) => ({ ...profileSnapshot.models[0]!, key: `route-${index}`, modelId: `model-${index}` }));
    const modelChain = models.map(model => ({ ...profilePartner.capabilities.modelChain[0]!, modelId: model.modelId }));
    const partner = { ...profilePartner, capabilities: { ...profilePartner.capabilities, modelChain: modelChain.slice(0, 5) } };
    const snapshot = { ...profileSnapshot, partner, models };
    expect(validateMobilePartnerProfileDraft(snapshot, mobilePartnerProfileDraft(partner)).capabilities.modelChain).toHaveLength(5);
    const response = create(UpdatePartnerResponseSchema, { partner: profilePartnerWire(partner),
      directory: { revision: { value: 4n }, avatarPresets: ["orbit"] } });
    expect(projectMobilePartnerProfileUpdate(partner.partnerId, 1n, response).capabilities.modelChain).toEqual(partner.capabilities.modelChain);
    expect(() => validateMobilePartnerProfileDraft(snapshot, { ...mobilePartnerProfileDraft(partner),
      capabilities: { ...partner.capabilities, modelChain } })).toThrow(/1–5/u);
    response.partner!.capabilities!.modelChain.push(create(PartnerModelRouteSchema, modelChain[5]!));
    expect(() => projectMobilePartnerProfileUpdate(partner.partnerId, 1n, response)).toThrow(/model chain/u);
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
