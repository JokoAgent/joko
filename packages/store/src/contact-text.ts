const FORBIDDEN_INLINE = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const FORBIDDEN_MULTILINE = /\r(?!\n)|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export function isContactText(value: unknown, minimum: number, maximum: number, multiline = false): value is string {
  return typeof value === "string" && value === value.trim() && value.length >= minimum && value.length <= maximum
    && !(multiline ? FORBIDDEN_MULTILINE : FORBIDDEN_INLINE).test(value);
}
