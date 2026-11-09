import { ProviderModelInheritedField } from "@joko/contracts";
import type { ProviderModelInheritedFieldView } from "./model.js";

const FIELDS = [
  ["name", ProviderModelInheritedField.DISPLAY_NAME],
  ["contextWindowTokens", ProviderModelInheritedField.CONTEXT_WINDOW],
  ["maximumOutputTokens", ProviderModelInheritedField.MAXIMUM_OUTPUT],
  ["inputModalities", ProviderModelInheritedField.INPUT_MODALITIES],
  ["reasoning", ProviderModelInheritedField.REASONING],
  ["thinkingLevels", ProviderModelInheritedField.THINKING_LEVELS],
  ["supportsFastMode", ProviderModelInheritedField.FAST_MODE],
  ["supportsTools", ProviderModelInheritedField.TOOLS]
] as const;

export function protoProviderModelInheritedField(field: ProviderModelInheritedFieldView): ProviderModelInheritedField {
  const value = FIELDS.find(([key]) => key === field)?.[1];
  if (value === undefined) throw new Error("Invalid inherited model field.");
  return value;
}
export function providerModelInheritedField(field: ProviderModelInheritedField): ProviderModelInheritedFieldView {
  const value = FIELDS.find(([, key]) => key === field)?.[0];
  if (value === undefined) throw new Error("Invalid inherited model field.");
  return value;
}
