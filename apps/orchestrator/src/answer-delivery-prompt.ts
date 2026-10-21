import { ANSWER_DELIVERY_PROMPT } from "@joko/contracts";

/** Host instructions remain private; the caller's original prompt stays intact. */
export function answerDeliveryPrompt(base: string | undefined): string {
  return base ? `${base}\n\n${ANSWER_DELIVERY_PROMPT}` : ANSWER_DELIVERY_PROMPT;
}
