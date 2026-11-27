export interface MobileTaskModelGroupCatalog {
  readonly revision: string;
  readonly groups: readonly { readonly id: string; readonly name: string }[];
}

export interface MobileTaskModelGroupChoice {
  readonly groupId: string;
  readonly revision: string;
}

export interface MobileTaskModelGroupMedia {
  readonly backendId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly supportsImages: boolean;
}

export interface MobileGroupCatalogTransport {
  readonly ownerKey: string;
  list(signal: AbortSignal): Promise<MobileTaskModelGroupCatalog | undefined>;
}

export interface MobileTaskModelGroupTransport extends MobileGroupCatalogTransport {
  preview(choice: MobileTaskModelGroupChoice, hasImages: boolean, signal: AbortSignal): Promise<MobileTaskModelGroupMedia | undefined>;
}

export function mobileTaskModelGroupChoice(value: unknown): MobileTaskModelGroupChoice {
  if (!value || typeof value !== "object" || !("groupId" in value) || typeof value.groupId !== "string"
    || !value.groupId.trim() || value.groupId !== value.groupId.trim() || value.groupId.length > 96
    || !("revision" in value) || typeof value.revision !== "string" || !/^[1-9]\d{0,19}$/.test(value.revision)
    || BigInt(value.revision) > 0xffffffffffffffffn) throw new Error("Select a current task model group.");
  return { groupId: value.groupId, revision: value.revision };
}
