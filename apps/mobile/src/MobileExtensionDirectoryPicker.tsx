import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { ExtensionDirectoryPickerPage, ExtensionSettingsDirectoryChoice } from "@joko/contracts";
import type { MobilePartnersColors } from "./MobilePartnersScreen";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { MobileExtensionDirectoryPickerView } from "./MobileExtensionDirectoryPickerView";
import { mobileMessage } from "./mobile-messages";

export interface MobileExtensionDirectoryRequest {
  readonly id: string; readonly choice: ExtensionSettingsDirectoryChoice; readonly signal: AbortSignal;
  readonly current: () => boolean; readonly finish: (entryId: string | undefined) => void;
}

/** Only trusted native UI receives directory metadata from the original picker. */
export function MobileExtensionDirectoryPicker({ request, colors, locale }: { readonly request: MobileExtensionDirectoryRequest;
  readonly colors: MobilePartnersColors; readonly locale: MobileSupportedLocale }) {
  const [page, setPage] = useState<ExtensionDirectoryPickerPage | undefined>(request.choice.initialPage);
  const [path, setPath] = useState(request.choice.initialPage.directory?.displayPath ?? "");
  const [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const live = useRef(true), generation = useRef(0), lock = useRef(false), answered = useRef(false);
  const finish = (entryId: string | undefined) => { if (!answered.current) { answered.current = true; request.finish(entryId); } };
  const last = useRef<Parameters<ExtensionSettingsDirectoryChoice["browse"]>[0]>({});
  const original = request.choice.initialPage.picker;
  const expiry = original?.expiresAt ? Number(original.expiresAt.seconds * 1000n) + Math.floor(original.expiresAt.nanos / 1_000_000) : 0;
  const current = () => !answered.current && live.current && request.current() && !request.signal.aborted && AppState.currentState === "active"
    && Number.isSafeInteger(expiry) && Date.now() < expiry;
  useEffect(() => {
    live.current = true;
    const cancel = () => finish(undefined);
    const timer = setTimeout(cancel, Math.max(0, Math.min(120_000, expiry - Date.now())));
    request.signal.addEventListener("abort", cancel, { once: true });
    const listener = AppState.addEventListener("change", value => { if (value !== "active") cancel(); });
    if (!current()) cancel();
    return () => { live.current = false; generation.current++; clearTimeout(timer); listener.remove(); request.signal.removeEventListener("abort", cancel); finish(undefined); };
  }, [expiry, request]);
  const browse = async (input: Parameters<ExtensionSettingsDirectoryChoice["browse"]>[0], append = false) => {
    if (lock.current || !current()) return;
    lock.current = true; const attempt = ++generation.current; const previous = page;
    last.current = input; setBusy(true); setError(false);
    try {
      const next = await request.choice.browse(input);
      if (!current() || generation.current !== attempt) return;
      if (!original || next.picker?.pickerId !== original.pickerId || next.picker.extensionId !== original.extensionId
        || next.picker.expiresAt?.seconds !== original.expiresAt?.seconds || next.picker.expiresAt?.nanos !== original.expiresAt?.nanos
        || next.entries.length > 100 || append && next.directory?.entryId !== previous?.directory?.entryId) throw new Error("Directory picker changed.");
      const entries = append ? [...(previous?.entries ?? []), ...next.entries] : next.entries;
      if (entries.length > 10_000 || new Set(entries.map(entry => entry.entryId)).size !== entries.length) throw new Error("Directory listing changed.");
      setPage({ ...next, entries }); setPath(next.directory?.displayPath ?? "");
    } catch { if (current() && generation.current === attempt) { setPage(undefined); setError(true); } }
    finally { if (live.current && generation.current === attempt) { lock.current = false; setBusy(false); } }
  };
  return <MobileExtensionDirectoryPickerView title={request.choice.name} purpose={request.choice.title} colors={colors} locale={locale} path={path}
    busy={busy} error={error ? mobileMessage(locale, "extension.directory.failed") : undefined} directory={page?.directory} entries={page?.entries ?? []}
    canChoose={!!page?.directory && !busy && !error && current()} canMore={!!page?.nextPageToken && !busy}
    onPath={setPath} onGo={() => { if (path && path.length <= 4096 && !/[\u0000-\u001f]/u.test(path)) void browse({ directoryPath: path }); }}
    onBrowse={entryId => { void browse({ entryId }); }} onMore={() => { if (page?.nextPageToken) void browse({ ...(page.directory ? { entryId: page.directory.entryId } : {}), pageToken: page.nextPageToken }, true); }}
    onRetry={() => { void browse(last.current); }} onCancel={() => finish(undefined)}
    onChoose={() => { if (current() && !busy && !error && page?.directory) finish(page.directory.entryId); }} />;
}
