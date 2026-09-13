import type { ModelView } from "./model.js";

export function isConversationModel(model: Pick<ModelView, "outputModalities">): boolean {
  return model.outputModalities.includes("text");
}

export function isRoutableConversationModel(
  model: Pick<ModelView, "available" | "outputModalities" | "routingEnabled">
): boolean {
  return isConversationModel(model) && model.available && model.routingEnabled !== false;
}
