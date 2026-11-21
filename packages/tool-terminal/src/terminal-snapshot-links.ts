import type { Terminal } from "@xterm/headless";
import type { SerializeAddon } from "@xterm/addon-serialize";

type BufferView = Terminal["buffer"]["active"];
type BufferLine = NonNullable<ReturnType<BufferView["getLine"]>>;
type BufferCell = ReturnType<BufferView["getNullCell"]>;
type LinkCell = BufferCell & { hasExtendedAttrs(): number; readonly extended?: { readonly urlId: number } };
type LinkService = {
  readonly _dataByLinkId: ReadonlyMap<number, unknown>;
  getLinkData(id: number): { readonly id?: string; readonly uri: string } | undefined;
};
type LinkLookup = (id: number) => string;
const CLOSE_LINK = "\x1b]8;;\x1b\\";
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

/** The pinned serializer preserves screen geometry and SGR. Expose OSC 8 on
 * its scratch glyphs using the pinned headless terminal's link service. */
export function serializeTerminalScreen(screen: Terminal, serializer: SerializeAddon, scrollback: number, restoreActiveLink: boolean): string {
  const core = (screen as unknown as { readonly _core: {
    readonly _oscLinkService: LinkService;
    readonly _inputHandler: { getAttrData(): { readonly extended?: { readonly urlId: number } } };
  } })._core;
  const links = core._oscLinkService;
  if (links._dataByLinkId.size === 0) return serializer.serialize({ scrollback });

  const cache = new Map<number, string>();
  const openLink: LinkLookup = (id) => {
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    const link = links.getLinkData(id);
    let open = "";
    if (link && !CONTROL_CHARACTER.test(link.uri)) {
      const url = URL.parse(link.uri);
      if (url?.protocol === "https:" || url?.protocol === "http:") {
        // Xterm uses an explicit id to group fragments of a link across rows.
        const label = link.id && !/[:;\s]/u.test(link.id) && !CONTROL_CHARACTER.test(link.id)
          ? link.id : `joko-screen-${id}`;
        open = `\x1b]8;id=${label};${link.uri}\x1b\\`;
      }
    }
    cache.set(id, open);
    return open;
  };
  const namespace = screen.buffer;
  const normal = decorateBuffer(namespace.normal, openLink);
  const alternate = decorateBuffer(namespace.alternate, openLink);
  const active = namespace.active.type === "normal" ? normal : alternate;
  const buffer = new Proxy(namespace, { get(target, key) {
    if (key === "normal") return normal;
    if (key === "alternate") return alternate;
    if (key === "active") return active;
    return Reflect.get(target, key, target);
  } });
  const decorated = new Proxy(screen, { get(target, key) {
    return key === "buffer" ? buffer : Reflect.get(target, key, target);
  } });
  type AddonTerminal = Parameters<SerializeAddon["activate"]>[0];
  serializer.activate(decorated as unknown as AddonTerminal);
  try {
    const result = serializer.serialize({ scrollback });
    return restoreActiveLink ? result + openLink(core._inputHandler.getAttrData().extended?.urlId ?? 0) : result;
  } finally {
    serializer.activate(screen as unknown as AddonTerminal);
  }
}

function decorateBuffer(buffer: BufferView, openLink: LinkLookup): BufferView {
  const scratch = new WeakMap<BufferCell, { prefix: string; suffix: string; readonly chars: () => string }>();
  const lines = new Map<number, BufferLine>();
  const neighbor = buffer.getNullCell();
  const getNullCell = () => {
    const cell = buffer.getNullCell();
    const link = { prefix: "", suffix: "", chars: cell.getChars.bind(cell) };
    cell.getChars = () => link.prefix + link.chars() + link.suffix;
    scratch.set(cell, link);
    return cell;
  };
  const getLine = (row: number) => {
    const previous = lines.get(row);
    if (previous) return previous;
    const source = buffer.getLine(row);
    if (!source) return undefined;
    const line: BufferLine = {
      length: source.length,
      isWrapped: source.isWrapped,
      translateToString: source.translateToString.bind(source),
      getCell(column, cell) {
        const result = source.getCell(column, cell);
        const link = result && scratch.get(result);
        if (!result || !link) return result;
        link.prefix = "";
        link.suffix = "";
        const id = cellLinkId(result);
        if (id === 0 || result.getWidth() === 0 || link.chars() === "") return result;
        const open = openLink(id);
        if (open === "") return result;
        const left = column === 0 ? undefined : source.getCell(column - 1, neighbor);
        const preceding = left?.getWidth() === 0 && column > 1 ? source.getCell(column - 2, neighbor) : left;
        if (glyphLinkId(preceding) !== id) link.prefix = open;
        const next = source.getCell(column + result.getWidth(), neighbor);
        if (glyphLinkId(next) !== id) link.suffix = CLOSE_LINK;
        return result;
      }
    };
    lines.set(row, line);
    return line;
  };
  return new Proxy(buffer, { get(target, key) {
    if (key === "getNullCell") return getNullCell;
    if (key === "getLine") return getLine;
    return Reflect.get(target, key, target);
  } });
}

function cellLinkId(cell: BufferCell): number {
  const data = cell as LinkCell;
  return data.hasExtendedAttrs() ? data.extended?.urlId ?? 0 : 0;
}

function glyphLinkId(cell: BufferCell | undefined): number {
  return cell && cell.getWidth() > 0 && cell.getChars() !== "" ? cellLinkId(cell) : 0;
}
