import { capabilityNames, supportedExtraDirectoryAccessModes } from "@joko/contracts";
import type { BackendView, ExtraDirectoryView } from "./model.js";

export function extraDirectoryAccessChoices(backend: BackendView | undefined): readonly ExtraDirectoryView["access"][] {
  const modes = supportedExtraDirectoryAccessModes(backend?.capabilities.get(capabilityNames.workspaceExtraDirs));
  return modes.map(mode => mode === "read_only" ? "readOnly" : "readWrite");
}
