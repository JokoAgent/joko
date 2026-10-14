import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { Search, X } from "lucide-react";
import type { Translator } from "./types.js";
import { searchSettings, type SettingsSearchDocument, type SettingsSearchEntry } from "./settings-search.js";
import { cx } from "./ui.js";
import "./settings-search.css";

export function SettingsSearchBox({ documents, onSelect, t }: {
  readonly documents: readonly SettingsSearchDocument[];
  readonly onSelect: (entry: SettingsSearchEntry) => void;
  readonly t: Translator;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => searchSettings(documents, query), [documents, query]);
  const index = Math.min(activeIndex, Math.max(0, results.length - 1));
  const active = results[index];
  const hasQuery = query.trim().length > 0;
  const id = useId();
  const optionId = (entry: SettingsSearchEntry): string => `${id}-${entry.id}`;
  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(0, results.length - 1)));
  }, [results]);
  useEffect(() => {
    if (active !== undefined) document.getElementById(optionId(active.entry))?.scrollIntoView?.({ block: "nearest" });
  }, [active, id]);
  const clear = (): void => { setQuery(""); setActiveIndex(0); };
  const select = (entry: SettingsSearchEntry): void => { onSelect(entry); clear(); };
  return <div className="settings-search">
    <div className="settings-search__input">
      <Search aria-hidden="true" />
      <input ref={inputRef} type="search" role="combobox" value={query} autoComplete="off" spellCheck={false}
        aria-label={t("settings.search.label")} placeholder={t("settings.search.placeholder")} aria-expanded={hasQuery}
        aria-controls={hasQuery ? `${id}-results` : undefined} aria-autocomplete="list"
        aria-activedescendant={hasQuery && active !== undefined ? optionId(active.entry) : undefined}
        onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
        onKeyDown={(event) => {
          if (!hasQuery || event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault(); event.stopPropagation();
            setActiveIndex(results.length === 0 ? 0 : (index + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
          } else if (event.key === "Enter" && active !== undefined) {
            event.preventDefault(); event.stopPropagation(); select(active.entry);
          } else if (event.key === "Escape") {
            event.preventDefault(); event.stopPropagation(); clear();
          }
        }} />
      {hasQuery && <button type="button" aria-label={t("settings.search.clear")} onClick={() => { clear(); inputRef.current?.focus(); }}><X aria-hidden="true" /></button>}
    </div>
    {hasQuery && <div id={`${id}-results`} role="listbox" aria-label={t("settings.search.results")} className="settings-search__results">
      {results.length > 0 ? results.map((result, resultIndex) => <button type="button" role="option" id={optionId(result.entry)}
        key={result.entry.id} aria-selected={resultIndex === index} className={cx("settings-search__result", resultIndex === index && "is-active")}
        onMouseEnter={() => setActiveIndex(resultIndex)} onClick={() => select(result.entry)}>
        <strong>{result.title}</strong><span>{result.entry.id === result.entry.section ? result.category : `${result.category} · ${result.section}`}</span>
      </button>) : <p role="status">{t("settings.search.empty")}</p>}
    </div>}
  </div>;
}
