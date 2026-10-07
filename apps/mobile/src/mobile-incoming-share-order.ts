export interface MobileIncomingSharePartIdentity {
  readonly batchKey: string;
  readonly ordinal: number;
}

const incomingSharePartPattern = /^share_([0-9a-f]{32})_([0-9]{2})_[0-9a-f]{32}$/u;
const incomingShareUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function mobileIncomingShareStorageId(batchId: string, itemId: string, ordinal: number): string {
  assertIncomingShareUuid(batchId, "incoming share");
  assertIncomingShareUuid(itemId, "incoming-share item");
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal > 19) {
    throw new Error("The incoming-share item ordinal is invalid.");
  }
  return `share_${batchId.replaceAll("-", "")}_${ordinal.toString(10).padStart(2, "0")}_${itemId.replaceAll("-", "")}`;
}

export function parseMobileIncomingSharePartIdentity(value: string): MobileIncomingSharePartIdentity | undefined {
  if (typeof value !== "string") return undefined;
  const match = incomingSharePartPattern.exec(value);
  if (!match) return undefined;
  const ordinal = Number(match[2]);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal > 19) return undefined;
  return { batchKey: match[1]!, ordinal };
}

function assertIncomingShareUuid(value: string, name: string): void {
  if (!incomingShareUuidPattern.test(value)) throw new Error(`The ${name} identity is invalid.`);
}
