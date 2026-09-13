import type { ITheme } from "@xterm/xterm";
import type { TerminalPaletteView } from "./model.js";

/** Both creation and live views read the colors of their own Document. */
export function readTerminalAppearance(element: HTMLElement): { readonly theme: ITheme; readonly palette: TerminalPaletteView } {
  const window = element.ownerDocument.defaultView;
  if (window === null || window.closed || window.document !== element.ownerDocument) throw new Error("Terminal appearance document is unavailable.");
  const style = window.getComputedStyle(element);
  const color = (name: string) => style.getPropertyValue(name).trim();
  const theme = { background: color("--surface"), foreground: color("--text"), cursor: color("--text"), cursorAccent: color("--surface"), selectionBackground: color("--surface-hover"), black: color("--text"), brightBlack: color("--text-soft"), white: color("--text"), brightWhite: color("--text"), red: color("--red"), brightRed: color("--red"), green: color("--green"), brightGreen: color("--green"), yellow: color("--amber"), brightYellow: color("--amber"), blue: color("--blue"), brightBlue: color("--blue"), magenta: color("--purple"), brightMagenta: color("--purple"), cyan: color("--blue"), brightCyan: color("--blue") };
  const rgb = (value: string): number => {
    if (/^#[0-9a-f]{6}$/iu.test(value)) return Number.parseInt(value.slice(1), 16);
    if (/^#[0-9a-f]{3}$/iu.test(value)) return Number.parseInt([...value.slice(1)].map((digit) => digit + digit).join(""), 16);
    if (value === "" || !window.CSS.supports("color", value)) throw new Error("Terminal theme contains an invalid color.");
    const canvas = element.ownerDocument.createElement("canvas");
    canvas.width = canvas.height = 1;
    try {
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("Terminal color conversion is unavailable.");
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
      if (alpha !== 255 || red === undefined || green === undefined || blue === undefined) throw new Error("Terminal colors must be opaque.");
      return red * 65536 + green * 256 + blue;
    } finally { canvas.width = canvas.height = 0; }
  };
  return { theme, palette: {
    ansiRgb: [theme.black, theme.red, theme.green, theme.yellow, theme.blue, theme.magenta, theme.cyan, theme.white, theme.brightBlack, theme.brightRed, theme.brightGreen, theme.brightYellow, theme.brightBlue, theme.brightMagenta, theme.brightCyan, theme.brightWhite].map(rgb),
    foregroundRgb: rgb(theme.foreground), backgroundRgb: rgb(theme.background), cursorRgb: rgb(theme.cursor)
  } };
}
