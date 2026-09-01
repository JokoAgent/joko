import type { VoiceInputSessionView } from "./model.js";

export interface VoiceInputHistoryEntry {
  readonly id: string;
  readonly text: string;
  readonly createdAt: number;
  readonly audioDurationMs: number;
}

export interface VoiceInputUsageSnapshot {
  readonly entries: readonly VoiceInputHistoryEntry[];
  readonly totalAudioMs: number;
  readonly sessionCount: number;
  readonly noSpeechSessionCount: number;
  readonly failedSessionCount: number;
}

interface StoredVoiceInputUsage extends VoiceInputUsageSnapshot {
  readonly format: 1;
  readonly recentSessionIds: readonly string[];
}

const STORAGE_KEY = "joko.voice-input.usage.v1";
const CHANGE_EVENT = "joko:voice-input-usage";
const MAXIMUM_HISTORY_ENTRIES = 50;
const MAXIMUM_HISTORY_CHARACTERS = 250_000;
const MAXIMUM_ENTRY_CHARACTERS = 20_000;
const MAXIMUM_RECENT_SESSION_IDS = 200;

export const EMPTY_VOICE_INPUT_USAGE: VoiceInputUsageSnapshot = Object.freeze({
  entries: Object.freeze([]),
  totalAudioMs: 0,
  sessionCount: 0,
  noSpeechSessionCount: 0,
  failedSessionCount: 0
});

export function readVoiceInputUsage(
  storage: Pick<Storage, "getItem"> | undefined = browserStorage()
): VoiceInputUsageSnapshot {
  return storedUsage(storage);
}

export function recordVoiceInputSession(
  session: VoiceInputSessionView,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = browserStorage()
): VoiceInputUsageSnapshot {
  if (session.outcome === undefined) return storedUsage(storage);
  const current = storedUsage(storage);
  if (current.recentSessionIds.includes(session.id)) return publicSnapshot(current);
  const resultText = normalizeHistoryText(session.result?.text);
  const nextEntry = resultText === undefined
    ? undefined
    : Object.freeze({
        id: session.id,
        text: resultText,
        createdAt: boundedTimestamp(session.createdAt),
        audioDurationMs: boundedCounter(session.acceptedAudioDurationMs)
      });
  const next: StoredVoiceInputUsage = {
    format: 1,
    entries: boundEntries(nextEntry === undefined ? current.entries : [nextEntry, ...current.entries]),
    recentSessionIds: Object.freeze([session.id, ...current.recentSessionIds].slice(0, MAXIMUM_RECENT_SESSION_IDS)),
    totalAudioMs: safeAdd(current.totalAudioMs, boundedCounter(session.acceptedAudioDurationMs)),
    sessionCount: safeAdd(current.sessionCount, 1),
    noSpeechSessionCount: safeAdd(current.noSpeechSessionCount, session.outcome === "noSpeech" ? 1 : 0),
    failedSessionCount: safeAdd(current.failedSessionCount, session.outcome === "failed" ? 1 : 0)
  };
  persist(next, storage);
  return publicSnapshot(next);
}

export function deleteVoiceInputHistoryEntry(
  id: string,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = browserStorage()
): VoiceInputUsageSnapshot {
  const current = storedUsage(storage);
  const next = { ...current, entries: Object.freeze(current.entries.filter((entry) => entry.id !== id)) };
  persist(next, storage);
  return publicSnapshot(next);
}

export function resetVoiceInputUsage(
  storage: Pick<Storage, "setItem"> | undefined = browserStorage()
): VoiceInputUsageSnapshot {
  const empty = emptyStoredUsage();
  persist(empty, storage);
  return publicSnapshot(empty);
}

export function subscribeVoiceInputUsage(listener: (snapshot: VoiceInputUsageSnapshot) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const changed = (): void => listener(readVoiceInputUsage());
  const storageChanged = (event: StorageEvent): void => {
    if (event.key === STORAGE_KEY) changed();
  };
  window.addEventListener(CHANGE_EVENT, changed);
  window.addEventListener("storage", storageChanged);
  return () => {
    window.removeEventListener(CHANGE_EVENT, changed);
    window.removeEventListener("storage", storageChanged);
  };
}

function storedUsage(storage: Pick<Storage, "getItem"> | undefined): StoredVoiceInputUsage {
  if (storage === undefined) return emptyStoredUsage();
  let value: unknown;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return emptyStoredUsage();
    value = JSON.parse(raw);
  } catch { return emptyStoredUsage(); }
  if (!isRecord(value) || value["format"] !== 1 || !Array.isArray(value["entries"]) || !Array.isArray(value["recentSessionIds"])) {
    return emptyStoredUsage();
  }
  const entries: VoiceInputHistoryEntry[] = [];
  for (const entry of value["entries"].slice(0, MAXIMUM_HISTORY_ENTRIES)) {
    if (!isRecord(entry) || !validSessionId(entry["id"]) || typeof entry["text"] !== "string") return emptyStoredUsage();
    const text = normalizeHistoryText(entry["text"]);
    if (text === undefined || !validCounter(entry["createdAt"]) || !validCounter(entry["audioDurationMs"])) return emptyStoredUsage();
    entries.push(Object.freeze({
      id: entry["id"],
      text,
      createdAt: entry["createdAt"],
      audioDurationMs: entry["audioDurationMs"]
    }));
  }
  const recentSessionIds: string[] = [];
  for (const id of value["recentSessionIds"].slice(0, MAXIMUM_RECENT_SESSION_IDS)) {
    if (!validSessionId(id)) return emptyStoredUsage();
    recentSessionIds.push(id);
  }
  const totalAudioMs = value["totalAudioMs"];
  const sessionCount = value["sessionCount"];
  const noSpeechSessionCount = value["noSpeechSessionCount"];
  const failedSessionCount = value["failedSessionCount"];
  if (
    !validCounter(totalAudioMs) || !validCounter(sessionCount)
    || !validCounter(noSpeechSessionCount) || !validCounter(failedSessionCount)
  ) return emptyStoredUsage();
  return {
    format: 1,
    entries: boundEntries(entries),
    recentSessionIds: Object.freeze([...new Set(recentSessionIds)]),
    totalAudioMs,
    sessionCount,
    noSpeechSessionCount,
    failedSessionCount
  };
}

function persist(value: StoredVoiceInputUsage, storage: Pick<Storage, "setItem"> | undefined): void {
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(value)); }
  catch { return; }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGE_EVENT));
}

function publicSnapshot(value: StoredVoiceInputUsage): VoiceInputUsageSnapshot {
  return Object.freeze({
    entries: value.entries,
    totalAudioMs: value.totalAudioMs,
    sessionCount: value.sessionCount,
    noSpeechSessionCount: value.noSpeechSessionCount,
    failedSessionCount: value.failedSessionCount
  });
}

function emptyStoredUsage(): StoredVoiceInputUsage {
  return {
    format: 1,
    entries: Object.freeze([]),
    recentSessionIds: Object.freeze([]),
    totalAudioMs: 0,
    sessionCount: 0,
    noSpeechSessionCount: 0,
    failedSessionCount: 0
  };
}

function boundEntries(entries: readonly VoiceInputHistoryEntry[]): readonly VoiceInputHistoryEntry[] {
  const kept: VoiceInputHistoryEntry[] = [];
  let characters = 0;
  for (const entry of entries) {
    if (kept.length >= MAXIMUM_HISTORY_ENTRIES || characters + entry.text.length > MAXIMUM_HISTORY_CHARACTERS) break;
    kept.push(entry);
    characters += entry.text.length;
  }
  return Object.freeze(kept);
}

function normalizeHistoryText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if (normalized.length === 0) return undefined;
  return [...normalized].slice(0, MAXIMUM_ENTRY_CHARACTERS).join("");
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function validCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function boundedCounter(value: number): number {
  return validCounter(value) ? value : 0;
}

function boundedTimestamp(value: number): number {
  return validCounter(value) ? value : Date.now();
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  return Number.isSafeInteger(result) ? result : Number.MAX_SAFE_INTEGER;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function browserStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try { return window.localStorage; } catch { return undefined; }
}
