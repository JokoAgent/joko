import type { MobileOfflineCacheStorage } from "./mobile-offline-cache";

const PREFIX = "joko.mobile.offline-cache.v1.";
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const DIRECTORY = "joko-mobile-history-v1";
const MAXIMUM_BYTES = 12 * 1024 * 1024;

export interface MobileHistoryDiskIO {
  read(parts: readonly string[]): Promise<string | null>;
  write(parts: readonly string[], text: string): Promise<void>;
  remove(parts: readonly string[]): Promise<void>;
  list(): Promise<readonly (readonly string[])[]>;
}

function partsFor(key: string): readonly string[] {
  if (!key.startsWith(PREFIX)) throw new Error("The offline history key is invalid.");
  const parts = key.slice(PREFIX.length).split(".");
  if (!ID.test(parts[0] ?? "") || !(parts.length === 2 && ["manifest", "retired"].includes(parts[1]!)
    || parts.length === 4 && parts[1] === "detail" && ID.test(parts[2]!) && ID.test(parts[3]!))) {
    throw new Error("The offline history key is invalid.");
  }
  return parts;
}

export function createMobileHistoryDiskStorage(io: MobileHistoryDiskIO): MobileOfflineCacheStorage {
  return {
    getItem: key => io.read(partsFor(key)),
    setItem: (key, text) => {
      const parts = partsFor(key);
      if (new TextEncoder().encode(text).byteLength > MAXIMUM_BYTES) throw new Error("The offline history record is too large.");
      return io.write(parts, text);
    },
    removeItem: key => io.remove(partsFor(key)),
    getAllKeys: async () => (await io.list()).flatMap(parts => {
      const key = PREFIX + parts.join(".");
      try { partsFor(key); return [key]; } catch { return []; }
    }),
    multiRemove: async keys => {
      const results = await Promise.allSettled(keys.map(key => io.remove(partsFor(key))));
      const failed = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed.length) throw new AggregateError(failed.map(result => result.reason), "The saved history could not be cleared.");
    }
  };
}

export function createExpoMobileHistoryDiskIO(load: () => Promise<Pick<typeof import("expo-file-system"), "Directory" | "File" | "Paths">>
  = () => import("expo-file-system")): MobileHistoryDiskIO {
  const writing = new Set<string>();
  async function root() { const { Directory, Paths } = await load(); return new Directory(Paths.cache, DIRECTORY); }
  async function location(parts: readonly string[]) {
    const { Directory, File } = await load();
    const directory = new Directory(await root(), ...parts.slice(0, -1));
    return { directory, file: new File(directory, parts.at(-1)! + ".json") };
  }
  return {
  async read(parts) {
    const { file } = await location(parts); if (!file.exists) return null;
    if (file.size > MAXIMUM_BYTES) throw new Error("The saved history record exceeds its size limit.");
    const text = await file.text();
    if (new TextEncoder().encode(text).byteLength > MAXIMUM_BYTES) throw new Error("The saved history grew during reading.");
    return text;
  },
  async write(parts, text) {
    const key = parts.join("."); writing.add(key);
    try {
      const { File } = await load();
      const { directory, file } = await location(parts); directory.create({ intermediates: true, idempotent: true });
      const stage = new File(directory, parts.at(-1)! + ".tmp");
      try {
        stage.create({ overwrite: true }); stage.write(text);
        if (await stage.text() !== text) throw new Error("The saved history write could not be verified.");
        if (file.exists) file.delete(); stage.moveSync(file);
      } finally { const remaining = new File(directory, parts.at(-1)! + ".tmp"); if (remaining.exists) remaining.delete(); }
    } finally { writing.delete(key); }
  },
  async remove(parts) { const { file } = await location(parts); if (file.exists) file.delete(); },
  async list() {
    const { Directory, File } = await load(); const directory = await root(); if (!directory.exists) return [];
    const result: string[][] = [];
    const visit = (parent: InstanceType<typeof Directory>, parts: readonly string[]): void => {
      for (const entry of parent.list()) {
        if (entry instanceof Directory && parts.length < 3 && (ID.test(entry.name) || parts.length === 1 && entry.name === "detail")) visit(entry, [...parts, entry.name]);
        else if (entry instanceof File && entry.name.endsWith(".json")) result.push([...parts, entry.name.slice(0, -5)]);
        else if (entry instanceof File && entry.name.endsWith(".tmp") && !writing.has([...parts, entry.name.slice(0, -4)].join("."))) entry.delete();
      }
    };
    visit(directory, []); return result;
  }
  };
}

export const expoMobileHistoryDiskIO = createExpoMobileHistoryDiskIO();
export const mobileHistoryDiskStorage = createMobileHistoryDiskStorage(expoMobileHistoryDiskIO);
