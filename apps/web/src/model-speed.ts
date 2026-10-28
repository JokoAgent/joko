import type { ModelView } from "./model.js";

export function resolveModelSpeed(model: Pick<ModelView, "supportsFast" | "supportsUltrafast"> | undefined, value: boolean | "ultrafast" | undefined, enabled = true): boolean | "ultrafast" {
  if (!enabled || !model || value === undefined || value === false) return false;
  return (value === "ultrafast" ? model.supportsUltrafast === true : model.supportsFast) ? value : false;
}
