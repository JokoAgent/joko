import type { ResourceView } from "./model.js";
import type { Translator } from "./components/types.js";

export function resourceSourceKindLabel(resource: ResourceView, t: Translator): string | undefined {
  switch (resource.sourceKind) {
    case "local": return t("settings.resourceSourceLocal");
    case "npm": return t("settings.resourceSourceNpm");
    case "git": return t("settings.resourceSourceGit");
    case "extensionSource": return t("resource.sourceExtension");
    case "skillMarket": return t("resource.sourceMarket");
    case "learned": return t("resource.sourceLearned");
    case "remoteProject": return t("resource.sourceRemoteProject");
    case undefined: return undefined;
  }
}

export function resourceStateLabel(state: ResourceView["state"], t: Translator): string {
  switch (state) {
    case "discovered": return t("resource.stateDiscovered");
    case "awaitingApproval": return t("resource.stateAwaitingApproval");
    case "approved": return t("resource.stateApproved");
    case "installing": return t("resource.stateInstalling");
    case "installed": return t("resource.stateInstalled");
    case "loaded": return t("resource.runtimeLoaded");
    case "disabled": return t("resource.stateDisabled");
    case "updateAvailable": return t("resource.stateUpdateAvailable");
    case "removed": return t("resource.stateRemoved");
    case "error": return t("resource.stateError");
  }
}
