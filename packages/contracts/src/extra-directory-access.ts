import { ExtraDirectoryAccess } from "./gen/joko/v1/workspace_pb.js";

const extraDirectoryAccessModes = ["read_only", "read_write"] as const;
export type ExtraDirectoryAccessMode = typeof extraDirectoryAccessModes[number];

export function supportedExtraDirectoryAccessModes(capability: {
  readonly supported: boolean;
  readonly options?: readonly string[];
} | undefined): readonly ExtraDirectoryAccessMode[] {
  if (!capability?.supported) return [];
  const options = capability.options;
  return options === undefined ? extraDirectoryAccessModes : extraDirectoryAccessModes.filter(mode => options.includes(mode));
}

export function extraDirectoryAccessMode(value: ExtraDirectoryAccess): ExtraDirectoryAccessMode | undefined {
  switch (value) {
    case ExtraDirectoryAccess.READ_ONLY: return "read_only";
    case ExtraDirectoryAccess.READ_WRITE: return "read_write";
    default: return undefined;
  }
}

export function extraDirectoryAccessProto(mode: ExtraDirectoryAccessMode): ExtraDirectoryAccess {
  return mode === "read_write" ? ExtraDirectoryAccess.READ_WRITE : ExtraDirectoryAccess.READ_ONLY;
}
