import { TerminalError, type TerminalPalette } from "./types.js";

export const TERMINAL_COLOR_OSC_IDENTIFIERS = [4, 10, 11, 12, 104, 110, 111, 112] as const;

export interface TerminalColorResult {
  readonly handled: boolean;
  readonly replies: readonly string[];
}

const MAXIMUM_OSC_CHARACTERS = 65_536;
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

/** A process has one bounded color state, independent of the number of attached views. */
export class TerminalColorState {
  readonly #defaults: Uint32Array;
  readonly #colors: Uint32Array;
  readonly #modified = new Uint8Array(259);

  constructor(defaults: TerminalPalette) {
    const initial = copyTerminalPalette(defaults);
    const palette = [...initial.ansiRgb];
    for (const red of CUBE_LEVELS) for (const green of CUBE_LEVELS) for (const blue of CUBE_LEVELS) palette.push(red * 65_536 + green * 256 + blue);
    for (let gray = 8; gray <= 238; gray += 10) palette.push(gray * 65_793);
    palette.push(initial.foregroundRgb, initial.backgroundRgb, initial.cursorRgb);
    this.#defaults = new Uint32Array(palette);
    this.#colors = this.#defaults.slice();
  }

  defaults(): TerminalPalette {
    return { ansiRgb: [...this.#defaults.slice(0, 16)], foregroundRgb: this.#defaults[256]!, backgroundRgb: this.#defaults[257]!, cursorRgb: this.#defaults[258]! };
  }

  replaceDefaults(value: TerminalPalette): void {
    const palette = copyTerminalPalette(value);
    for (let index = 0; index < 16; index += 1) this.#defaults[index] = palette.ansiRgb[index]!;
    this.#defaults.set([palette.foregroundRgb, palette.backgroundRgb, palette.cursorRgb], 256);
    for (let index = 0; index < this.#defaults.length; index += 1) {
      if (this.#modified[index] === 0) this.#colors[index] = this.#defaults[index]!;
    }
  }

  /** OSC syntax and color quantization follow https://xtermjs.org/docs/api/vtfeatures/#osc. */
  consumeOsc(identifier: number, data: string): TerminalColorResult {
    const replies: string[] = [];
    if (data.length > MAXIMUM_OSC_CHARACTERS) return { handled: false, replies };
    let handled = false;
    if (identifier === 4) {
      const slots = data.split(";");
      for (let offset = 0; offset + 1 < slots.length; offset += 2) {
        const index = paletteIndex(slots[offset]!);
        if (index === undefined) continue;
        const value = slots[offset + 1]!;
        if (value === "?") { replies.push(osc(4, `${index};${rgb(this.#colors[index]!)}`)); handled = true; }
        else {
          const color = parseColor(value);
          if (color !== undefined) { this.#colors[index] = color; this.#modified[index] = 1; handled = true; }
        }
      }
    } else if (identifier >= 10 && identifier <= 12 && Number.isInteger(identifier)) {
      const slots = data.split(";");
      for (let offset = 0; offset < slots.length && identifier + offset <= 12; offset += 1) {
        const operation = identifier + offset;
        const index = 256 + operation - 10;
        const value = slots[offset]!;
        if (value === "?") { replies.push(osc(operation, rgb(this.#colors[index]!))); handled = true; }
        else {
          const color = parseColor(value);
          if (color !== undefined) { this.#colors[index] = color; this.#modified[index] = 1; handled = true; }
        }
      }
    } else if (identifier === 104) {
      if (data === "") { this.#colors.set(this.#defaults.subarray(0, 256)); this.#modified.fill(0, 0, 256); handled = true; }
      else for (const slot of data.split(";")) {
        const index = paletteIndex(slot);
        if (index !== undefined) { this.#colors[index] = this.#defaults[index]!; this.#modified[index] = 0; handled = true; }
      }
    } else if (identifier >= 110 && identifier <= 112 && Number.isInteger(identifier)) {
      // These operations ignore their payload, as the browser terminal does.
      const index = 256 + identifier - 110;
      this.#colors[index] = this.#defaults[index]!;
      this.#modified[index] = 0;
      handled = true;
    }
    return { handled, replies };
  }

  /** Replay active process overrides without replacing a view's unmodified theme colors. */
  replayColors(): string {
    const indexed: string[] = [];
    for (let index = 0; index < 256; index += 1) if (this.#modified[index] === 1) indexed.push(String(index), rgb(this.#colors[index]!));
    let result = indexed.length === 0 ? "" : osc(4, indexed.join(";"));
    for (let index = 256; index <= 258; index += 1) if (this.#modified[index] === 1) result += osc(index - 246, rgb(this.#colors[index]!));
    return result;
  }
}

function validDefault(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffff) throw new TerminalError("INVALID_ARGUMENT", "A terminal color must be an RGB integer.");
  return value;
}

export function copyTerminalPalette(value: TerminalPalette): TerminalPalette {
  if (value === undefined || value === null || !Array.isArray(value.ansiRgb) || value.ansiRgb.length !== 16) throw new TerminalError("INVALID_ARGUMENT", "A terminal palette must contain exactly sixteen ANSI colors.");
  return { ansiRgb: value.ansiRgb.map(validDefault), foregroundRgb: validDefault(value.foregroundRgb), backgroundRgb: validDefault(value.backgroundRgb), cursorRgb: validDefault(value.cursorRgb) };
}

function paletteIndex(value: string): number | undefined {
  if (!/^\d+$/u.test(value)) return undefined;
  const index = Number(value);
  return index >= 0 && index < 256 && Number.isInteger(index) ? index : undefined;
}

function parseColor(value: string): number | undefined {
  const text = value.toLowerCase();
  let channels: number[];
  if (text.startsWith("rgb:")) {
    const parts = text.slice(4).split("/");
    if (parts.length !== 3 || parts.some((part) => !/^[0-9a-f]{1,4}$/u.test(part) || part.length !== parts[0]!.length)) return undefined;
    const maximum = 16 ** parts[0]!.length - 1;
    channels = parts.map((part) => Math.round(Number.parseInt(part, 16) * 255 / maximum));
  } else if (text.startsWith("#")) {
    const digits = text.slice(1);
    if (![3, 6, 9, 12].includes(digits.length) || !/^[0-9a-f]+$/u.test(digits)) return undefined;
    const width = digits.length / 3;
    channels = [0, 1, 2].map((index) => Math.floor(Number.parseInt(digits.slice(index * width, (index + 1) * width), 16) * 2 ** (8 - width * 4)));
  } else return undefined;
  return channels[0]! * 65_536 + channels[1]! * 256 + channels[2]!;
}

function rgb(color: number): string {
  return "rgb:" + [16, 8, 0].map((shift) => (((color >>> shift) & 255) * 257).toString(16).padStart(4, "0")).join("/");
}

function osc(identifier: number, data: string): string { return `\u001b]${identifier};${data}\u001b\\`; }
