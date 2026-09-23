export class PdfResourceError extends Error {
  constructor(readonly code: "PATH_NOT_ALLOWED" | "FILE_TOO_LARGE" | "UNSUPPORTED_ENCODING", message: string, readonly hint = message) {
    super(message);
    this.name = "PdfResourceError";
  }
}

const CSS_CHARSET_PREFIX = /^@charset\s+["']([^"']+)["']\s*;/i;

export function decodePdfText(bytes: Buffer): string {
  let encoding: "utf-8" | "utf-16le" | "utf-16be" = "utf-8";
  let offset = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) offset = 3;
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = "utf-16le"; offset = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = "utf-16be"; offset = 2; }
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(offset));
  } catch {
    throw new PdfResourceError("UNSUPPORTED_ENCODING", "HTML or CSS text has an unsupported encoding.");
  }
}

export function decodeCssText(bytes: Buffer): string {
  const hasBom = (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    || (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
  if (hasBom) return decodePdfText(bytes).replace(CSS_CHARSET_PREFIX, "");
  const declared = bytes.subarray(0, 256).toString("latin1").match(CSS_CHARSET_PREFIX)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(declared, { fatal: true }).decode(bytes).replace(CSS_CHARSET_PREFIX, "");
  } catch {
    throw new PdfResourceError("UNSUPPORTED_ENCODING", "Local stylesheet has an unsupported encoding.");
  }
}
