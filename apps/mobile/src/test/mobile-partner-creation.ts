import type { MobilePartnerCreationSnapshot } from "../mobile-partner-creation";
import { profileSnapshot } from "./mobile-partner-profile";

export const creationSnapshot: MobilePartnerCreationSnapshot = {
  ownerKey: "owner", options: { ...profileSnapshot.options, templates: [
    { templateId: "general", displayName: "General", description: "Ongoing product work", identitySource: "Product work" }
  ] }, names: profileSnapshot.names,
  backends: [{ backendId: "backend", displayName: "Local executor", models: profileSnapshot.models,
    canSwitchModel: true, canSetEffort: true, canSetFastMode: true, canSetPlanMode: true, permissionModes: ["ask", "auto"] }]
};
