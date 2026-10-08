export type MobileConnectionActionName =
  | "connect" | "pair" | "disconnect" | "forgetProfile" | "refreshDiscoveredNodes"
  | "retryManagedOrchestrator" | "cancelAutomaticConnectionAttempt"
  | "setAutomaticConnectionEnabled" | "setTheme" | "inspect" | "requestPairing"
  | "cancelPairing" | "recheckSavedProfiles" | "goBack" | "selectMode";

export type MobileConnectionMessage =
  | { readonly type: "ready"; readonly instanceId: string }
  | { readonly type: "action"; readonly instanceId: string; readonly id: number;
      readonly name: MobileConnectionActionName; readonly args: readonly unknown[] };

/** Only the local connection surface may request these host capabilities. */
export function parseMobileConnectionMessage(raw: string, instanceId: string): MobileConnectionMessage | undefined {
  if (raw.length > 16_384) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  if (!record(value) || value.instanceId !== instanceId) return undefined;
  if (value.type === "ready" && exactKeys(value, ["type", "instanceId"])) {
    return { type: "ready", instanceId };
  }
  if (value.type !== "action" || !exactKeys(value, ["type", "instanceId", "id", "name", "args"])
    || !Number.isSafeInteger(value.id) || (value.id as number) < 1 || !Array.isArray(value.args)) return undefined;
  const args: readonly unknown[] = value.args;
  const text = (index: number, maximum: number): boolean => typeof args[index] === "string"
    && (args[index] as string).length > 0 && (args[index] as string).length <= maximum;
  const choice = (index: number): boolean => args[index] === undefined || (record(args[index])
    && exactKeys(args[index], ["automatic"]) && typeof args[index].automatic === "boolean");
  let valid = false;
  switch (value.name) {
    case "connect": valid = (args.length === 1 || args.length === 2) && text(0, 256) && choice(1); break;
    case "pair": valid = (args.length === 3 || args.length === 4)
      && text(0, 2_048) && text(1, 128) && text(2, 256) && choice(3); break;
    case "forgetProfile": valid = args.length === 1 && text(0, 256); break;
    case "inspect": valid = args.length === 1 && text(0, 2_048); break;
    case "requestPairing": valid = args.length === 2 && text(0, 2_048) && text(1, 256); break;
    case "setTheme": valid = args.length === 1 && (args[0] === "light" || args[0] === "dark" || args[0] === "system"); break;
    case "setAutomaticConnectionEnabled": valid = args.length === 1 && typeof args[0] === "boolean"; break;
    case "selectMode": valid = args.length === 1 && (args[0] === "nearby" || args[0] === "saved" || args[0] === "pair"); break;
    case "disconnect": case "refreshDiscoveredNodes": case "retryManagedOrchestrator":
    case "cancelAutomaticConnectionAttempt": case "cancelPairing": case "recheckSavedProfiles": case "goBack":
      valid = args.length === 0; break;
  }
  if (!valid) return undefined;
  return { type: "action", instanceId, id: value.id as number,
    name: value.name as MobileConnectionActionName, args };
}

export function mobileConnectionJson(value: unknown): string {
  return (JSON.stringify(value) ?? "null").replace(/</gu, "\\u003c").replace(/>/gu, "\\u003e")
    .replace(/&/gu, "\\u0026").replace(/\u2028/gu, "\\u2028").replace(/\u2029/gu, "\\u2029");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}
