import { CheckboxControl, SwitchControl } from "./ui.js";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type JSX, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, RotateCcw, Search } from "lucide-react";

import type { AppController } from "../controller.js";
import type { AppSnapshot, ModelRouteRefView } from "../model.js";
import type { RunAction, Translator } from "./types.js";
import "./personalization-features.css";

type Capability = "vision" | "noVision" | "unknown";

export function VisionBridgeSection({ controller, snapshot, runAction, t }: {
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly runAction: RunAction;
  readonly t: Translator;
}): JSX.Element {
  const authoritative = snapshot.settings.visionBridge;
  const [enabled, setEnabled] = useState(authoritative.enabled);
  const [targetModels, setTargetModels] = useState(authoritative.targetModels);
  const [primary, setPrimary] = useState<ModelRouteRefView | undefined>(authoritative.primary);
  const [fallback, setFallback] = useState<ModelRouteRefView | undefined>(authoritative.fallback);
  const [pending, setPending] = useState(false);

  useEffect(() => setEnabled(authoritative.enabled), [authoritative.enabled]);
  useEffect(() => setTargetModels(authoritative.targetModels), [authoritative.targetModels]);
  useEffect(() => setPrimary(authoritative.primary), [authoritative.primary]);
  useEffect(() => setFallback(authoritative.fallback), [authoritative.fallback]);

  const rows = useMemo(() => {
    const unique = new Map<string, AppSnapshot["models"][number]>();
    for (const model of snapshot.models) unique.set(referenceKey(model), model);
    return [...unique.values()].sort(compareTargetRows);
  }, [snapshot.models]);
  const backendNames = useMemo(() => new Map(snapshot.backends.map((backend) => [backend.id, backend.name] as const)), [snapshot.backends]);
  const credentialProviderKeys = useMemo(() => new Set(snapshot.providers
    .filter((provider) => provider.ownerManaged)
    .map((provider) => providerRouteKey(provider.backendId, provider.id))), [snapshot.providers]);
  const ambiguousTargetKeys = useMemo(() => new Set(rows.flatMap((model, index) =>
    rows.some((candidate, candidateIndex) => candidateIndex !== index &&
      (candidate.modelId === model.modelId || candidate.name === model.name))
      ? [referenceKey(model)]
      : []
  )), [rows]);
  // SPEC requires a positive image capability for an inference route. The
  // unknown candidates stay visible in target rows, but they cannot silently
  // become credential-bearing Vision backends until the Provider declares it.
  const backendCandidates = useMemo(() => rows
    .filter((model) => classifyCapability(model) === "vision" && model.available &&
      credentialProviderKeys.has(providerRouteKey(model.backendId, model.providerId)))
    .sort((left, right) =>
      left.providerName.localeCompare(right.providerName) ||
      left.name.localeCompare(right.name) ||
      referenceKey(left).localeCompare(referenceKey(right))
    ), [credentialProviderKeys, rows]);
  const defaultTargets = rows
    .filter((model) => classifyCapability(model) === "noVision")
    .map(toReference);
  const selectedTargets = new Set(targetModels.map(referenceKey));
  const targetsCustomized = authoritative.customizedFields.includes("targetModels");
  const customized = authoritative.customizedFields.length > 0;

  const apply = (
    action: string,
    patch: Parameters<AppController["updateVisionBridgeSettings"]>[0],
    optimistic: () => void,
    rollback: () => void
  ): void => {
    if (pending) return;
    optimistic();
    setPending(true);
    runAction(action, async () => {
      try {
        await controller.updateVisionBridgeSettings(patch);
      } catch (error) {
        rollback();
        throw error;
      } finally {
        setPending(false);
      }
    });
  };

  const toggleTarget = (model: AppSnapshot["models"][number]): void => {
    const previous = targetModels;
    const key = referenceKey(model);
    const next = selectedTargets.has(key)
      ? targetModels.filter((candidate) => referenceKey(candidate) !== key)
      : [...targetModels, toReference(model)];
    apply("vision-bridge-target", { targetModels: next }, () => setTargetModels(next), () => setTargetModels(previous));
  };

  const setBackend = (slot: "primary" | "fallback", next: ModelRouteRefView | undefined): void => {
    const previous = slot === "primary" ? primary : fallback;
    apply(
      `vision-bridge-${slot}`,
      { [slot]: next ?? null },
      () => slot === "primary" ? setPrimary(next) : setFallback(next),
      () => slot === "primary" ? setPrimary(previous) : setFallback(previous)
    );
  };

  const restoreDefaults = (): void => {
    const previous = { enabled, targetModels, primary, fallback };
    apply(
      "vision-bridge-reset",
      { resetAll: true },
      () => {
        setEnabled(false);
        setTargetModels(defaultTargets);
        setPrimary(undefined);
        setFallback(undefined);
      },
      () => {
        setEnabled(previous.enabled);
        setTargetModels(previous.targetModels);
        setPrimary(previous.primary);
        setFallback(previous.fallback);
      }
    );
  };

  return (
    <section className="vision-bridge" aria-labelledby="vision-bridge-title">
      <header className="vision-bridge__heading">
        <div><h2 id="vision-bridge-title">{t("settings.visionBridge.title")}</h2>
          <p>{t("settings.visionBridge.description")}</p></div>
        {customized && <div className="personalization-default-controls"><span>{t("settings.defaults.customized")}</span><button type="button" className="icon-button" aria-label={t("settings.defaults.restore")} disabled={pending} onClick={restoreDefaults}><RotateCcw aria-hidden="true" /></button></div>}
      </header>

      <div className="vision-bridge__card vision-bridge__enable-row">
        <div><strong>{t("settings.visionBridge.enableLabel")}</strong><span>{t("settings.visionBridge.enableHint")}</span></div>
        <Toggle
          checked={enabled}
          disabled={pending}
          label={t("settings.visionBridge.enableAria")}
          onChange={(next) => apply(
            "vision-bridge-enabled",
            { enabled: next },
            () => setEnabled(next),
            () => setEnabled(enabled)
          )}
        />
      </div>

      <div className="vision-bridge__card">
        <div className="vision-bridge__card-heading">
          <div><strong>{t("settings.visionBridge.targetModels.label")}</strong><span>{t("settings.visionBridge.targetModels.hint")}</span></div>
          {targetsCustomized && <button
            type="button"
            className="vision-bridge__reset"
            disabled={pending}
            aria-label={t("settings.defaults.restore")}
            onClick={() => {
              const previous = targetModels;
              apply(
                "vision-bridge-target-reset",
                { resetTargetModels: true },
                () => setTargetModels(defaultTargets),
                () => setTargetModels(previous)
              );
            }}
          ><span>{t("settings.defaults.customized")}</span><RotateCcw aria-hidden="true" /></button>}
        </div>
        <div className="vision-bridge__divider" />
        {rows.length === 0
          ? <p className="vision-bridge__empty">{t("settings.visionBridge.targetModels.empty")}</p>
          : <div className="vision-bridge__model-list">
              {rows.map((model) => {
                const capability = classifyCapability(model);
                const source = modelSourceName(model, backendNames);
                return <div className={enabled ? "vision-bridge__model-row" : "vision-bridge__model-row is-disabled"} key={referenceKey(model)}>
                  <div>
                    <strong title={`${source} · ${model.name}`}>{model.name}</strong>
                    <span>{ambiguousTargetKeys.has(referenceKey(model)) ? `${source} · ` : ""}
                      {t(`settings.visionBridge.capability.${capability}`)}</span>
                  </div>
                  <Toggle
                    checked={selectedTargets.has(referenceKey(model))}
                    disabled={pending || !enabled}
                    label={t("settings.visionBridge.targetModels.toggleAria", { model: ambiguousTargetKeys.has(referenceKey(model)) ? `${source} · ${model.name}` : model.name })}
                    onChange={() => toggleTarget(model)}
                  />
                </div>;
              })}
            </div>}
      </div>

      <div className="vision-bridge__card">
        <div className="vision-bridge__card-heading">
          <div><strong>{t("settings.visionBridge.backends.label")}</strong><span>{t("settings.visionBridge.backends.hint")}</span></div>
        </div>
        <div className="vision-bridge__divider" />
        <div className={enabled ? "vision-bridge__backend-fields" : "vision-bridge__backend-fields is-disabled"}>
          <VisionBackendSelector
            label={t("settings.visionBridge.backends.primary")}
            emptyLabel={t("settings.visionBridge.backends.unset")}
            searchPlaceholder={t("settings.visionBridge.backends.searchPlaceholder")}
            noResultsLabel={t("settings.visionBridge.backends.noResults")}
            value={primary}
            candidates={backendCandidates}
            backendNames={backendNames}
            disabled={pending || !enabled}
            onChange={(next) => setBackend("primary", next)}
          />
          <VisionBackendSelector
            label={t("settings.visionBridge.backends.fallback")}
            emptyLabel={t("settings.visionBridge.backends.noBackup")}
            searchPlaceholder={t("settings.visionBridge.backends.searchPlaceholder")}
            noResultsLabel={t("settings.visionBridge.backends.noResults")}
            value={fallback}
            candidates={backendCandidates}
            backendNames={backendNames}
            disabled={pending || !enabled}
            onChange={(next) => setBackend("fallback", next)}
          />
        </div>
        <p className="vision-bridge__secondary-hint">{t("settings.visionBridge.backends.hintSecondary")}</p>
        {enabled && !authoritative.available && <p className="vision-bridge__unavailable" role="status">
          {authoritative.unavailableReason || t("settings.visionBridge.unavailable")}
        </p>}
      </div>
    </section>
  );
}

function Toggle({ checked, disabled, label, onChange }: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly label: string;
  readonly onChange: (checked: boolean) => void;
}): JSX.Element {
  return <SwitchControl checked={checked} disabled={disabled} aria-label={label} onChange={(event) => onChange(event.target.checked)} />;
}

export function VisionBackendSelector({ label, emptyLabel, searchPlaceholder, noResultsLabel, value, candidates, backendNames, disabled, onChange }: {
  readonly label: string;
  readonly emptyLabel: string;
  readonly searchPlaceholder: string;
  readonly noResultsLabel: string;
  readonly value: ModelRouteRefView | undefined;
  readonly candidates: readonly AppSnapshot["models"][number][];
  readonly backendNames: ReadonlyMap<string, string>;
  readonly disabled: boolean;
  readonly onChange: (value: ModelRouteRefView | undefined) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState("");
  const [positioned, setPositioned] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const typeaheadRef = useRef({ value: "", at: 0 });
  const listboxId = `vision-backend-${useId().replace(/:/gu, "")}`;
  const selected = value === undefined
    ? undefined
    : candidates.find((candidate) => referenceKey(candidate) === referenceKey(value));
  const selectedName = value === undefined ? emptyLabel : selected?.name ?? value.modelId;
  const selectedProviderName = value === undefined ? undefined : selected === undefined
    ? `${value.providerId} · ${backendNames.get(value.backendId) ?? value.backendId}`
    : modelSourceName(selected, backendNames);
  const providerMark = selectedProviderName?.trim().slice(0, 1).toLocaleUpperCase();
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredCandidates = useMemo(() => normalizedQuery.length === 0
    ? candidates
    : candidates.filter((model) => [model.name, model.modelId, model.providerName, model.providerId, model.backendId, backendNames.get(model.backendId) ?? ""]
      .some((field) => field.toLocaleLowerCase().includes(normalizedQuery))), [backendNames, candidates, normalizedQuery]);
  const providers = useMemo(() => {
    const grouped = new Map<string, { readonly id: string; readonly name: string; readonly models: AppSnapshot["models"][number][] }>();
    for (const model of filteredCandidates) {
      const id = providerRouteKey(model.backendId, model.providerId);
      const group = grouped.get(id) ?? { id, name: modelSourceName(model, backendNames), models: [] };
      group.models.push(model);
      grouped.set(id, group);
    }
    return [...grouped.values()];
  }, [backendNames, filteredCandidates]);
  const options = useMemo(() => [
    { key: "", label: emptyLabel, value: undefined },
    ...filteredCandidates.map((model) => ({ key: referenceKey(model), label: `${model.name} ${backendNames.get(model.backendId) ?? model.backendId}`, value: toReference(model) }))
  ], [backendNames, emptyLabel, filteredCandidates]);
  const selectedKey = value === undefined ? "" : referenceKey(value);

  const positionPopover = (): void => {
    const trigger = triggerRef.current;
    if (trigger === null) return;
    const rect = trigger.getBoundingClientRect();
    const viewportWidth = Math.max(document.documentElement.clientWidth, window.innerWidth);
    const viewportHeight = Math.max(document.documentElement.clientHeight, window.innerHeight);
    const width = Math.min(rect.width, Math.max(0, viewportWidth - 16));
    const left = Math.min(Math.max(8, rect.left), Math.max(8, viewportWidth - width - 8));
    const below = viewportHeight - rect.bottom - 4;
    const above = rect.top - 4;
    const desiredHeight = popoverRef.current?.scrollHeight || 400;
    const opensAbove = below < desiredHeight && above > below;
    const maxHeight = Math.max(80, (opensAbove ? above : below) - 8);
    setPopoverStyle({
      position: "fixed",
      left,
      width,
      maxHeight,
      ...(opensAbove ? { bottom: viewportHeight - rect.top + 4 } : { top: rect.bottom + 4 })
    });
  };

  const focusOption = (key: string): void => {
    setActiveKey(key);
    // Programmatic focus is valid on a roving option while it still has
    // tabIndex=-1. Move it synchronously so a fast follow-up key cannot be
    // delivered to the search field before React commits activeKey.
    optionRefs.current.get(key)?.focus();
  };
  const close = (restoreFocus: boolean): void => {
    setOpen(false);
    setPositioned(false);
    setQuery("");
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const openMenu = (): void => {
    setQuery("");
    setPositioned(false);
    positionPopover();
    setOpen(true);
  };
  const choose = (next: ModelRouteRefView | undefined): void => {
    onChange(next);
    close(true);
  };
  const move = (edge: "first" | "last" | "next" | "previous"): void => {
    const currentIndex = Math.max(0, options.findIndex((option) => option.key === activeKey));
    const index = edge === "first"
      ? 0
      : edge === "last"
        ? options.length - 1
        : edge === "next"
          ? (currentIndex + 1) % options.length
          : (currentIndex - 1 + options.length) % options.length;
    const next = options[index];
    if (next !== undefined) focusOption(next.key);
  };

  useEffect(() => {
    if (!open) return;
    const initialKey = options.some((option) => option.key === selectedKey) ? selectedKey : options[0]?.key ?? "";
    setActiveKey(initialKey);
    const initialFrame = requestAnimationFrame(() => {
      // The first estimate runs before the portal exists. Re-measure after
      // mount so collision direction follows the actual panel.
      positionPopover();
      setPositioned(true);
    });
    const closeOutside = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) close(false);
    };
    const closeOnFocusOutside = (event: FocusEvent): void => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) close(false);
    };
    const reposition = (): void => positionPopover();
    document.addEventListener("pointerdown", closeOutside, true);
    document.addEventListener("focusin", closeOnFocusOutside, true);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      cancelAnimationFrame(initialFrame);
      document.removeEventListener("pointerdown", closeOutside, true);
      document.removeEventListener("focusin", closeOnFocusOutside, true);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !positioned) return;
    // Run after React has committed visibility. Chromium ignores focus calls
    // made while the portaled field is still visibility:hidden.
    searchRef.current?.focus({ preventScroll: true });
  }, [open, positioned]);

  useEffect(() => {
    if (open && !options.some((option) => option.key === activeKey)) setActiveKey(options[0]?.key ?? "");
  }, [activeKey, open, options]);

  useEffect(() => {
    if (!open || !positioned) return;
    const frame = requestAnimationFrame(() => positionPopover());
    return () => cancelAnimationFrame(frame);
  }, [filteredCandidates.length, normalizedQuery, open, positioned]);

  const handleListboxKey = (event: ReactKeyboardEvent): void => {
    if (event.key === "Tab") {
      if (event.target instanceof HTMLInputElement && !event.shiftKey) {
        const next = options.find((option) => option.key === activeKey) ?? options[0];
        if (next !== undefined) {
          event.preventDefault();
          focusOption(next.key);
        }
      } else if (event.target instanceof HTMLButtonElement && event.shiftKey) {
        event.preventDefault();
        searchRef.current?.focus();
      } else {
        close(false);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.target instanceof HTMLInputElement) {
      if (event.key === "ArrowDown" && options[0] !== undefined) {
        event.preventDefault();
        const next = options.find((option) => option.key !== "") ?? options[0];
        focusOption(next.key);
      }
      return;
    }
    const movement = event.key === "ArrowDown" ? "next"
      : event.key === "ArrowUp" ? "previous"
        : event.key === "Home" ? "first"
          : event.key === "End" ? "last"
            : undefined;
    if (movement !== undefined) {
      event.preventDefault();
      move(movement);
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && event.target instanceof HTMLButtonElement) {
      event.preventDefault();
      event.target.click();
      return;
    }
    if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;
    const now = Date.now();
    const previous = typeaheadRef.current;
    const query = `${now - previous.at > 700 ? "" : previous.value}${event.key}`.toLocaleLowerCase();
    typeaheadRef.current = { value: query, at: now };
    const start = Math.max(0, options.findIndex((option) => option.key === activeKey));
    const ordered = [...options.slice(start + 1), ...options.slice(0, start + 1)];
    const match = ordered.find((option) => option.label.toLocaleLowerCase().startsWith(query));
    if (match !== undefined) {
      event.preventDefault();
      focusOption(match.key);
    }
  };

  return <div className="vision-bridge__backend-row">
    <span>{label}</span>
    <div className="vision-backend-selector" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`vision-backend-selector__trigger${selectedProviderName === undefined ? "" : " has-source"}`}
        disabled={disabled}
        aria-label={`${label}: ${value === undefined ? emptyLabel : `${selectedProviderName} · ${selectedName}`}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => open ? close(false) : openMenu()}
        onKeyDown={(event) => {
          if (!open && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            openMenu();
          }
        }}
      >
        {selectedProviderName !== undefined && <span className="vision-backend-selector__source-mark" aria-hidden="true">
          {providerMark || "·"}
        </span>}
        <span className="vision-backend-selector__model-name">{selectedName}</span>
        <ChevronDown aria-hidden="true" />
      </button>
      {open && createPortal(<div
        ref={popoverRef}
        className="vision-backend-selector__popover"
        style={{ ...popoverStyle, visibility: positioned ? "visible" : "hidden" }}
        onKeyDown={handleListboxKey}
      >
        <button
          ref={(node) => { if (node === null) optionRefs.current.delete(""); else optionRefs.current.set("", node); }}
          type="button"
          role="option"
          aria-selected={value === undefined}
          tabIndex={activeKey === "" ? 0 : -1}
          className="vision-backend-selector__option vision-backend-selector__fallback-option"
          onFocus={() => setActiveKey("")}
          onClick={() => choose(undefined)}
        >
          <span>{emptyLabel}</span>{value === undefined && <Check aria-hidden="true" />}
        </button>
        <div className="vision-backend-selector__divider" />
        <label className="vision-backend-selector__search">
          <Search aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div id={listboxId} className="vision-backend-selector__options" role="listbox" aria-label={label}>
          {providers.map((provider) => <div
            className="vision-backend-selector__provider"
            role="group"
            aria-label={provider.name}
            key={provider.id}
          >
            <div className="vision-backend-selector__provider-name">{provider.name}</div>
            {provider.models.map((model) => {
              const active = value !== undefined && referenceKey(value) === referenceKey(model);
              const key = referenceKey(model);
              return <button
                ref={(node) => { if (node === null) optionRefs.current.delete(key); else optionRefs.current.set(key, node); }}
                type="button"
                role="option"
                aria-selected={active}
                tabIndex={activeKey === key ? 0 : -1}
                className="vision-backend-selector__option"
                key={key}
                onFocus={() => setActiveKey(key)}
              onClick={() => choose(toReference(model))}
            >
                <span className="vision-backend-selector__option-main">
                  <span className="vision-backend-selector__source-mark" aria-hidden="true">
                    {model.providerName.trim().slice(0, 1).toLocaleUpperCase() || model.providerId.slice(0, 1).toLocaleUpperCase() || "·"}
                  </span>
                  <span>{model.name}</span>
                </span>
                {active && <Check aria-hidden="true" />}
              </button>;
            })}
          </div>)}
          {filteredCandidates.length === 0 && <div className="vision-backend-selector__no-results">{noResultsLabel}</div>}
        </div>
      </div>, document.body)}
    </div>
  </div>;
}

function classifyCapability(model: AppSnapshot["models"][number]): Capability {
  if (model.supportsImages || model.inputModalities.includes("image")) return "vision";
  return model.inputModalities.length === 0 ? "unknown" : "noVision";
}

function compareTargetRows(
  left: AppSnapshot["models"][number],
  right: AppSnapshot["models"][number]
): number {
  const capabilityOrder: Record<Capability, number> = { noVision: 0, unknown: 1, vision: 2 };
  return capabilityOrder[classifyCapability(left)] - capabilityOrder[classifyCapability(right)] ||
    left.modelId.localeCompare(right.modelId, "en") ||
    left.providerId.localeCompare(right.providerId, "en") ||
    left.backendId.localeCompare(right.backendId, "en");
}

function toReference(value: Pick<ModelRouteRefView, "backendId" | "providerId" | "modelId">): ModelRouteRefView {
  return { backendId: value.backendId, providerId: value.providerId, modelId: value.modelId };
}

function referenceKey(value: Pick<ModelRouteRefView, "backendId" | "providerId" | "modelId">): string {
  return `${value.backendId}\0${value.providerId}\0${value.modelId}`;
}

function providerRouteKey(backendId: string, providerId: string): string {
  return `${backendId}\0${providerId}`;
}

function modelSourceName(model: AppSnapshot["models"][number], backendNames: ReadonlyMap<string, string>): string {
  return `${model.providerName} · ${backendNames.get(model.backendId) ?? model.backendId}`;
}
