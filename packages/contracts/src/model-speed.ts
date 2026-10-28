/** Ordinary Fast and Ultrafast are distinct choices throughout the product. */
export type ModelSpeedValue = boolean | "ultrafast";

export function encodeModelSpeed(value: ModelSpeedValue): { readonly fastMode: boolean; readonly ultrafastMode: boolean } {
  if (typeof value !== "boolean" && value !== "ultrafast") throw new Error("Invalid model speed.");
  return { fastMode: value === true, ultrafastMode: value === "ultrafast" };
}

export function decodeModelSpeed(value: { readonly fastMode?: boolean; readonly ultrafastMode?: boolean }): ModelSpeedValue {
  if (value.fastMode !== undefined && typeof value.fastMode !== "boolean" || value.ultrafastMode !== undefined && typeof value.ultrafastMode !== "boolean") throw new Error("Invalid wire model speed.");
  if (value.fastMode === true && value.ultrafastMode === true) throw new Error("Conflicting model speeds.");
  return value.ultrafastMode === true ? "ultrafast" : value.fastMode === true;
}

export function supportsModelSpeed(model: { readonly supportsFastMode?: boolean; readonly supportsUltrafastMode?: boolean }, value: ModelSpeedValue): boolean {
  return value === false || (value === "ultrafast" ? model.supportsUltrafastMode === true : value === true && model.supportsFastMode === true);
}
