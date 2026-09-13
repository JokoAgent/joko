import { TerminalError } from "./types.js";

const MAXIMUM_FRAME_BYTES = 64 * 1024;
const MAXIMUM_SEQUENCE_BYTES = 64 * 1024;

/** Keeps incomplete UTF-16 and VT parser state out of replay checkpoints. */
export class TerminalOutputFramer {
  #mode: "text" | "escape" | "csi" | "string" = "text";
  #escapeIntermediate = false;
  #sequence = "";
  #sequenceBytes = 0;
  #osc = false;
  #surrogate = "";

  push(data: string): string[] {
    let value = this.#surrogate + data;
    this.#surrogate = "";
    if (value.length > 0) {
      const final = value.charCodeAt(value.length - 1);
      if (final >= 0xd800 && final <= 0xdbff) {
        this.#surrogate = value.slice(-1);
        value = value.slice(0, -1);
      }
    }
    const chunks: string[] = [];
    let ready = "";
    let readyBytes = 0;
    const append = (part: string, bytes: number) => {
      if (readyBytes + bytes > MAXIMUM_FRAME_BYTES && ready.length > 0) {
        chunks.push(ready);
        ready = "";
        readyBytes = 0;
      }
      ready += part;
      readyBytes += bytes;
    };
    for (const raw of value) {
      const character = raw.length === 1 && raw.charCodeAt(0) >= 0xd800 && raw.charCodeAt(0) <= 0xdfff ? "\ufffd" : raw;
      const code = character.codePointAt(0)!;
      const bytes = Buffer.byteLength(character);
      if (this.#mode === "text") {
        if (code === 0x1b || code === 0x9b || code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
          this.#sequence = character;
          this.#sequenceBytes = bytes;
          this.#osc = code === 0x9d;
          this.#escapeIntermediate = false;
          this.#mode = code === 0x1b ? "escape" : code === 0x9b ? "csi" : "string";
        } else append(character, bytes);
        continue;
      }
      this.#sequence += character;
      this.#sequenceBytes += bytes;
      if (this.#sequenceBytes > MAXIMUM_SEQUENCE_BYTES) {
        throw new TerminalError("OUTPUT_LIMIT", "A terminal control sequence exceeds the bounded output limit.");
      }
      if (code === 0x1b) { this.#mode = "escape"; this.#escapeIntermediate = false; }
      else if (code === 0x9b) this.#mode = "csi";
      else if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) { this.#mode = "string"; this.#osc = code === 0x9d; }
      else if (code === 0x18 || code === 0x1a || (code >= 0x80 && code <= 0x9c)) this.#mode = "text";
      else if (this.#mode === "escape") {
        if (!this.#escapeIntermediate && character === "[") this.#mode = "csi";
        else if (!this.#escapeIntermediate && ["]", "P", "X", "^", "_"].includes(character)) {
          this.#osc = character === "]";
          this.#mode = "string";
        } else if (code >= 0x20 && code <= 0x2f) this.#escapeIntermediate = true;
        else if ((code >= 0x30 && code <= 0x7e) || code > 0x9f) this.#mode = "text";
      } else if (this.#mode === "csi") {
        if (code >= 0x40 && code <= 0x7e) this.#mode = "text";
      } else if (this.#mode === "string") {
        if (this.#osc && code === 0x07) this.#mode = "text";
      }
      if (this.#mode === "text") {
        append(this.#sequence, this.#sequenceBytes);
        this.#sequence = "";
        this.#sequenceBytes = 0;
      }
    }
    if (ready.length > 0) chunks.push(ready);
    return chunks;
  }
}

const VT_SEQUENCE = /(?:\x1b\[|\u009b)[0-?]*[ -/]*[@-~]|(?:\x1b\]|\u009d)[\s\S]*?(?:\x07|\x1b\\|\u009c|(?=\x1b))|(?:\x1b[PX^_]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\x1b\\|\u009c|(?=\x1b))/gu;

/** The service emulator answers protocol queries; connected views only render their state. */
export function terminalDisplayOutput(data: string): string {
  return data.replace(VT_SEQUENCE, (sequence) => {
    const csi = /^(?:\x1b\[|\u009b)([0-?]*)([ -/]*)([@-~])$/u.exec(sequence);
    if (csi !== null) {
      const [, parameters = "", intermediates = "", final = ""] = csi;
      if (intermediates === "" && (final === "c" && /^(?:>|)[0-9;]*$/u.test(parameters)
        || final === "n" && /^\??[0-9;]*$/u.test(parameters))) return "";
      if (intermediates === "$" && final === "p" && /^\??[0-9;]*$/u.test(parameters)) return "";
      if (intermediates === "" && final === "t" && [11, 13, 14, 15, 16, 18, 19, 20, 21].includes(Number(parameters.split(";")[0]))) return "";
      return sequence;
    }
    if (/^(?:\x1bP|\u0090)[0-?]*\$q/u.test(sequence)) return "";
    const osc = /^(\x1b\]|\u009d)([\s\S]*?)(\x07|\x1b\\|\u009c|)$/u.exec(sequence);
    if (osc === null) return /(?:\x1b\\|\u009c)$/u.test(sequence) ? sequence : `${sequence}\x1b\\`;
    const [, prefix = "", body = "", ending = ""] = osc;
    // An ESC that ended this string can also begin a query that is removed below.
    // Give retained strings an explicit terminator so rendering never retains parser state.
    const terminator = ending || "\x1b\\";
    const [operation = "", ...slots] = body.split(";");
    if (operation === "4") {
      const retained: string[] = [];
      for (let index = 0; index < slots.length; index += 2) {
        if (slots[index + 1] === "?") continue;
        retained.push(slots[index]!);
        if (slots[index + 1] !== undefined) retained.push(slots[index + 1]!);
      }
      return retained.length === 0 ? "" : `${prefix}4;${retained.join(";")}${terminator}`;
    }
    if (["10", "11", "12"].includes(operation) && slots.includes("?")) {
      // Empty slots are ignored by the public parser but retain their foreground/background/cursor offset.
      const retained = slots.map((slot) => slot === "?" ? "" : slot);
      return retained.some((slot) => slot !== "") ? `${prefix}${operation};${retained.join(";")}${terminator}` : "";
    }
    return `${prefix}${body}${terminator}`;
  });
}
