export type ConnectionArtworkVariant = "base" | "alt";

export interface ConnectionArtworkFrame {
  readonly id: string;
  readonly variant: ConnectionArtworkVariant;
  readonly lightUrl: string;
  readonly darkUrl: string;
}

export interface ConnectionArtworkGroup {
  readonly id: string;
  readonly base: ConnectionArtworkFrame;
  readonly alt: ConnectionArtworkFrame;
}

interface MutableThemePair {
  lightUrl?: string;
  darkUrl?: string;
}

interface MutableConnectionArtworkGroup {
  readonly id: string;
  readonly base: MutableThemePair;
  readonly alt: MutableThemePair;
}

const DEFAULT_CONNECTION_ARTWORK_GROUP = "jogging";
const CONNECTION_ARTWORK_FILE = /^(?<group>[a-z0-9]+(?:-[a-z0-9]+)*)-(?<theme>light|dark)(?<alt>-alt)?\.svg$/u;

const bundledConnectionArtwork = import.meta.glob("./landing-artwork/*.svg", {
  eager: true,
  import: "default",
  query: "?url"
}) as Readonly<Record<string, string>>;

/**
 * Builds theme-paired base/alt groups from the landing-artwork directory.
 * Adding four consistently named SVGs is enough to add another group; tabs
 * only advance this sequence and are intentionally absent from the registry.
 */
export function buildConnectionArtworkGroups(
  modules: Readonly<Record<string, string>>,
  defaultGroup = DEFAULT_CONNECTION_ARTWORK_GROUP
): readonly ConnectionArtworkGroup[] {
  const mutableGroups = new Map<string, MutableConnectionArtworkGroup>();

  for (const [path, url] of Object.entries(modules)) {
    const fileName = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
    const match = CONNECTION_ARTWORK_FILE.exec(fileName);
    if (match?.groups === undefined) throw new Error(`Unsupported connection artwork filename: ${fileName}`);

    const groupId = match.groups.group;
    const theme = match.groups.theme;
    if (groupId === undefined || (theme !== "light" && theme !== "dark")) {
      throw new Error(`Unsupported connection artwork filename: ${fileName}`);
    }

    const variant: ConnectionArtworkVariant = match.groups.alt === undefined ? "base" : "alt";
    const group = mutableGroups.get(groupId) ?? { id: groupId, base: {}, alt: {} };
    const frame = group[variant];
    if (theme === "light") {
      if (frame.lightUrl !== undefined) throw new Error(`Duplicate light connection artwork: ${groupId}-${variant}`);
      frame.lightUrl = url;
    } else {
      if (frame.darkUrl !== undefined) throw new Error(`Duplicate dark connection artwork: ${groupId}-${variant}`);
      frame.darkUrl = url;
    }
    mutableGroups.set(groupId, group);
  }

  const groups = [...mutableGroups.values()].map((group): ConnectionArtworkGroup => Object.freeze({
    id: group.id,
    base: completeFrame(group.id, "base", group.base),
    alt: completeFrame(group.id, "alt", group.alt)
  }));

  groups.sort((left, right) => {
    const leftDefault = left.id === defaultGroup;
    const rightDefault = right.id === defaultGroup;
    if (leftDefault !== rightDefault) return leftDefault ? -1 : 1;
    return compareAscii(left.id, right.id);
  });

  if (groups[0]?.id !== defaultGroup) throw new Error(`Missing default connection artwork group: ${defaultGroup}`);
  return Object.freeze(groups);
}

export const CONNECTION_ARTWORK_GROUPS = buildConnectionArtworkGroups(bundledConnectionArtwork);

export function connectionArtworkGroupAt(index: number): ConnectionArtworkGroup {
  const group = CONNECTION_ARTWORK_GROUPS[index];
  if (group === undefined) throw new RangeError(`Unknown connection artwork group index: ${index}`);
  return group;
}

export function nextConnectionArtworkGroupIndex(currentIndex: number, length = CONNECTION_ARTWORK_GROUPS.length): number {
  if (!Number.isInteger(currentIndex) || currentIndex < 0) throw new RangeError("Connection artwork group index must be a non-negative integer.");
  if (!Number.isInteger(length) || length < 1) throw new RangeError("Connection artwork groups must not be empty.");
  return (currentIndex + 1) % length;
}

function completeFrame(groupId: string, variant: ConnectionArtworkVariant, pair: MutableThemePair): ConnectionArtworkFrame {
  if (pair.lightUrl === undefined || pair.darkUrl === undefined) {
    throw new Error(`Connection artwork requires light and dark files: ${groupId}-${variant}`);
  }
  return Object.freeze({
    id: variant === "base" ? groupId : `${groupId}-alt`,
    variant,
    lightUrl: pair.lightUrl,
    darkUrl: pair.darkUrl
  });
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
