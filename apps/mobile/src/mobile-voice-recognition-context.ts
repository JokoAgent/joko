export interface MobileVoiceRecognitionContext {
  readonly contextData: readonly { readonly text: string }[];
}

export function normalizeMobileVoiceRecognitionContext(value: unknown,
  limits = { maximumItems: 20, maximumItemBytes: 2_048, maximumBytes: 8_192 }): MobileVoiceRecognitionContext {
  const invalid = (): never => { throw new Error("Recognition context must contain at most 20 text items, 2 KiB per item and 8 KiB in total."); };
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1
    || !("contextData" in value) || !Array.isArray(value.contextData)
    || value.contextData.length > Math.min(20, limits.maximumItems)) return invalid();
  const texts = value.contextData.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).length !== 1 || !("text" in item)
      || typeof item.text !== "string") return invalid();
    return item.text;
  });
  return voiceInputRecognitionContextFromTexts(texts, {
    recognitionContextMaximumItems: Math.min(20, limits.maximumItems),
    recognitionContextMaximumItemBytes: Math.min(2_048, limits.maximumItemBytes),
    recognitionContextMaximumBytes: Math.min(8_192, limits.maximumBytes)
  }) ?? Object.freeze({ contextData: Object.freeze([]) });
}
import { voiceInputRecognitionContextFromTexts } from "@joko/contracts";
