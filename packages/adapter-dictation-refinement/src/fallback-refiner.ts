import type { RefinementRequest, RefinementResult, VoiceRefiner } from "@joko/voice-input";

/** Bounded primary/backup refinement without retrying quality decisions. */
export class FallbackDictationRefiner implements VoiceRefiner {
  readonly #refiners: readonly VoiceRefiner[];

  constructor(refiners: readonly VoiceRefiner[]) {
    if (refiners.length === 0 || refiners.length > 2) {
      throw new TypeError("Dictation refinement requires one primary and at most one backup route.");
    }
    this.#refiners = [...refiners];
  }

  async refine(input: RefinementRequest): Promise<RefinementResult> {
    let result: RefinementResult = { accepted: false, reason: "unavailable" };
    for (const refiner of this.#refiners) {
      if (input.signal.aborted) return { accepted: false, reason: "unavailable" };
      result = await refiner.refine(input);
      if (result.accepted || (result.reason !== "unavailable" && result.reason !== "invalid_output")) return result;
    }
    return result;
  }
}
