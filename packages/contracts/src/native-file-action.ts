const ORDERED_ID = /^([a-f0-9]{8})-([a-f0-9]{4})-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const ENTROPY_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

/** Current Desktop requestId: a Document-local sequence and opaque UUID entropy. */
export function nativeFileActionRequestId(sequence: number, entropy: string): string {
  if (!Number.isSafeInteger(sequence) || sequence <= 0 || sequence > 0xffff_ffff_ffff || !ENTROPY_ID.test(entropy)) {
    throw new TypeError("Invalid native file action identity.");
  }
  const ordinal = sequence.toString(16).padStart(12, "0");
  return `${ordinal.slice(0, 8)}-${ordinal.slice(8)}-8${entropy.slice(15)}`;
}

export function nativeFileActionSequence(requestId: string): number | undefined {
  const match = ORDERED_ID.exec(requestId);
  if (match === null) return undefined;
  const sequence = Number.parseInt(`${match[1]}${match[2]}`, 16);
  return sequence > 0 ? sequence : undefined;
}
