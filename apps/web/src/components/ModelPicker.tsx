import {
  Bot,
  Check,
  ChevronDown,
  Search,
  SlidersHorizontal,
  Star,
  Unplug,
  X,
  Zap
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type { CSSProperties, JSX, KeyboardEvent, MouseEvent, RefObject } from "react";
import { createPortal } from "react-dom";

import {
  addModelFavorite,
  isModelVisible,
  readModelConfiguration,
  removeModelFavorite,
  seedModelFavorite,
  setModelConfiguration,
  setModelPickerLayout,
  updateModelFavorite,
  useModelPickerLayout,
  useModelPickerOwnerPreferences,
  providerPreferenceKey,
  type ModelFavoriteConfiguration,
  type ModelPickerLayout
} from "../model-picker-preferences.js";
import type { ModelView } from "../model.js";
import { isConversationModel, isRoutableConversationModel } from "../model-capabilities.js";
import { applyProviderDisplayOrder } from "../provider-display-order.js";
import { placeModelPickerConfigFlyout, type ModelPickerConfigFlyoutRect } from "./model-picker-config-flyout.js";
import type { Translator } from "./types.js";
import { Button, IconButton, Tip, cx, CheckboxControl } from "./ui.js";
import { MorphPopover } from "./MorphPopover.js";

export interface ModelPickerSelection {
  readonly backendId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly effort?: string;
  readonly fastMode: boolean;
  readonly favoriteUid?: string;
}

export interface ModelPickerProps {
  readonly models: readonly ModelView[];
  readonly ownerId: string | undefined;
  readonly value: ModelPickerSelection | undefined;
  readonly t: Translator;
  readonly onSelect: (value: ModelPickerSelection | undefined) => void;
  /** Called after a committed selection so an adjacent composer can reclaim focus. */
  readonly onSelectionFocus?: () => void;
  readonly onOpen?: () => void | Promise<void>;
  /** Opens the capability-owned Provider recovery surface when no route remains. */
  readonly onConnectSource?: () => void;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly allowDefault?: boolean;
  readonly defaultLabel?: string;
  readonly ariaLabel?: string;
  readonly className?: string;
  readonly seedDefault?: ModelPickerSelection;
  readonly effortEnabled?: boolean;
  readonly fastEnabled?: boolean;
  readonly useMorphPopover?: boolean;
}

interface PickerRow {
  readonly key: string;
  readonly model: ModelView;
  readonly favorite?: ModelFavoriteConfiguration;
  readonly effort?: string;
  readonly fastMode: boolean;
}

interface RowConfiguration {
  readonly effort?: string;
  readonly fastMode: boolean;
}

interface BinaryThinkingEfforts {
  readonly disabled: string;
  readonly enabled: string;
}

type RailSelection = "favorites" | "all" | `provider:${string}`;

export function ModelPicker({
  models,
  ownerId,
  value,
  t,
  onSelect,
  onSelectionFocus,
  onOpen,
  onConnectSource,
  disabled = false,
  disabledReason,
  allowDefault = false,
  defaultLabel,
  ariaLabel,
  className,
  seedDefault,
  effortEnabled = true,
  fastEnabled = true,
  useMorphPopover = false
}: ModelPickerProps): JSX.Element {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const configFlyoutRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const feedbackTimerRef = useRef<number | undefined>(undefined);
  const listboxId = useId();
  const layout = useModelPickerLayout();
  const preferences = useModelPickerOwnerPreferences(ownerId);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [rail, setRail] = useState<RailSelection>("all");
  const [activeRowKey, setActiveRowKey] = useState<string>();
  const [configRowKey, setConfigRowKey] = useState<string>();
  const [rowConfigurations, setRowConfigurations] = useState<ReadonlyMap<string, RowConfiguration>>(new Map());
  const [justFavoritedKey, setJustFavoritedKey] = useState<string>();
  const [panelStyle, setPanelStyle] = useState<CSSProperties>();

  const modelsByKey = useMemo(() => new Map(models.map((model) => [modelKey(model), model] as const)), [models]);
  const visibleModels = useMemo(() => models.filter((model) =>
    isRoutableConversationModel(model)
    && isModelVisible(preferences, model.backendId, model.providerId, model.modelId, model.defaultVisible ?? true)
  ), [models, preferences]);
  const routableModels = useMemo(() => models.filter(isRoutableConversationModel), [models]);
  const selectedModel = value === undefined ? undefined : modelsByKey.get(modelKey(value));
  const selectedModelUnavailable = value !== undefined
    && (selectedModel === undefined || !isRoutableConversationModel(selectedModel));
  const connectSourceRequired = routableModels.length === 0 && onConnectSource !== undefined;
  const providerGroups = useMemo(() => {
    const groups = new Map<string, { readonly id: string; readonly providerId: string; readonly name: string; readonly models: ModelView[] }>();
    for (const model of visibleModels) {
      const id = providerPreferenceKey(model.backendId, model.providerId);
      const group = groups.get(id) ?? { id, providerId: model.providerId, name: model.providerName, models: [] };
      group.models.push(model);
      groups.set(id, group);
    }
    return applyProviderDisplayOrder([...groups.values()], preferences.providerOrder);
  }, [preferences.providerOrder, visibleModels]);
  const orderedVisibleModels = useMemo(
    () => providerGroups.flatMap((provider) => provider.models),
    [providerGroups]
  );

  useEffect(() => {
    if (seedDefault === undefined || preferences.seeded) return;
    const model = modelsByKey.get(modelKey(seedDefault));
    if (model === undefined || !model.available) return;
    seedModelFavorite(ownerId, {
      backendId: model.backendId,
      providerId: model.providerId,
      modelId: model.modelId,
      ...(!effortEnabled || seedDefault.effort === undefined ? {} : { effort: seedDefault.effort }),
      ...(fastEnabled && seedDefault.fastMode && model.supportsFast ? { fast: true } : {})
    });
  }, [modelsByKey, ownerId, preferences.seeded, seedDefault]);

  const favoriteRows = useMemo(() => preferences.favorites.flatMap((favorite): PickerRow[] => {
    const model = modelsByKey.get(modelKey(favorite));
    if (model === undefined || !isConversationModel(model) || !model.available || model.routingEnabled === false || !isModelVisible(
      preferences,
      favorite.backendId,
      favorite.providerId,
      favorite.modelId,
      model.defaultVisible ?? true
    )) return [];
    const effort = effortEnabled ? validEffort(model, favorite.effort) : undefined;
    return [{
      key: `favorite:${favorite.uid}`,
      model,
      favorite,
      ...(effort === undefined ? {} : { effort }),
      fastMode: fastEnabled && favorite.fast === true && model.supportsFast
    }];
  }), [modelsByKey, preferences]);

  const regularRows = useMemo(() => orderedVisibleModels.map((model): PickerRow => {
    const key = `model:${modelKey(model)}`;
    const selected = value !== undefined && model.backendId === value.backendId && model.providerId === value.providerId && model.modelId === value.modelId;
    const storedConfiguration = readModelConfiguration(preferences, model.backendId, model.providerId, model.modelId);
    const configured = selected
      ? undefined
      : rowConfigurations.get(key) ?? (storedConfiguration === undefined ? undefined : {
          ...(storedConfiguration.effort === undefined ? {} : { effort: storedConfiguration.effort }),
          fastMode: storedConfiguration.fast === true
        });
    const effort = effortEnabled
      ? configured?.effort ?? (selected ? validEffort(model, value.effort) : model.efforts[0])
      : undefined;
    return {
      key,
      model,
      ...(effort === undefined ? {} : { effort }),
      fastMode: fastEnabled && (configured?.fastMode ?? (selected && value.fastMode && model.supportsFast))
    };
  }), [orderedVisibleModels, rowConfigurations, value]);

  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const matches = (row: PickerRow): boolean => normalizedQuery.length === 0 || [
      row.model.name,
      row.model.modelId,
      row.model.providerName,
      row.model.providerId,
      row.effort ?? "",
      row.fastMode ? "fast" : ""
    ].some((field) => field.toLocaleLowerCase().includes(normalizedQuery));
    if (rail === "favorites") return favoriteRows.filter(matches);
    if (rail.startsWith("provider:")) {
      const providerId = rail.slice("provider:".length);
      return regularRows.filter((row) => providerPreferenceKey(row.model.backendId, row.model.providerId) === providerId && matches(row));
    }
    return [...favoriteRows, ...regularRows].filter(matches);
  }, [favoriteRows, query, rail, regularRows]);

  const rowsByKey = useMemo(() => new Map(filteredRows.map((row) => [row.key, row] as const)), [filteredRows]);
  const activeIndex = Math.max(0, filteredRows.findIndex((row) => row.key === activeRowKey));
  const priceTiers = useMemo(() => priceTierMap(visibleModels), [visibleModels]);

  const updatePosition = useCallback((): void => {
    const trigger = triggerRef.current;
    if (trigger === null || typeof window === "undefined") return;
    const rect = trigger.getBoundingClientRect();
    if (window.innerWidth <= 640) {
      const width = Math.max(1, window.innerWidth - 16);
      const height = Math.max(1, window.innerHeight - 16);
      setPanelStyle({
        left: 8,
        right: 8,
        top: 8,
        bottom: 8,
        transformOrigin: "center bottom",
        "--morph-popover-scale-x": Math.max(0.04, Math.min(1, rect.width / width)),
        "--morph-popover-scale-y": Math.max(0.04, Math.min(1, rect.height / height)),
        "--morph-popover-start-radius": `${rect.height / 2}px`
      } as CSSProperties);
      return;
    }
    const width = layout === "original" ? 440 : layout === "classic" ? 620 : 680;
    const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.left));
    const opensAbove = rect.top >= Math.min(520, window.innerHeight * 0.58);
    const maxHeight = opensAbove ? Math.min(560, rect.top - 20) : Math.min(560, window.innerHeight - rect.bottom - 20);
    const morphStyle = {
      width,
      left,
      maxHeight,
      transformOrigin: `left ${opensAbove ? "bottom" : "top"}`,
      "--morph-popover-scale-x": Math.max(0.04, Math.min(1, rect.width / width)),
      "--morph-popover-scale-y": Math.max(0.04, Math.min(1, rect.height / Math.max(maxHeight, 1))),
      "--morph-popover-start-radius": `${rect.height / 2}px`
    } as CSSProperties;
    setPanelStyle(opensAbove
      ? { ...morphStyle, bottom: Math.max(12, window.innerHeight - rect.top + 8) }
      : { ...morphStyle, top: rect.bottom + 8 });
  }, [layout]);

  const close = useCallback((restoreFocus = true): void => {
    setOpen(false);
    setQuery("");
    setConfigRowKey(undefined);
    setActiveRowKey(undefined);
    if (restoreFocus && !useMorphPopover) window.setTimeout(() => triggerRef.current?.focus(), 0);
  }, [useMorphPopover]);

  const closeAfterSelection = (): void => {
    if (onSelectionFocus === undefined) {
      close();
      return;
    }
    close(false);
    window.requestAnimationFrame(onSelectionFocus);
  };

  useLayoutEffect(() => {
    if (!open || useMorphPopover) return;
    updatePosition();
    const update = (): void => updatePosition();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, updatePosition, useMorphPopover]);

  useEffect(() => {
    if (!open) return;
    const first = filteredRows.find((row) => isSelectedRow(row, value)) ?? filteredRows[0];
    setActiveRowKey(first?.key);
    if (useMorphPopover) return;
    window.setTimeout(() => searchRef.current?.focus(), 0);
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node) || triggerRef.current?.contains(target) || panelRef.current?.contains(target) || configFlyoutRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, useMorphPopover]);

  useEffect(() => () => {
    if (feedbackTimerRef.current !== undefined) window.clearTimeout(feedbackTimerRef.current);
  }, []);

  useEffect(() => {
    if (activeRowKey === undefined) return;
    rowRefs.current.get(activeRowKey)?.scrollIntoView?.({ block: "nearest" });
  }, [activeRowKey]);

  const selectRow = (row: PickerRow): void => {
    if (!row.model.available) return;
    onSelect({
      backendId: row.model.backendId,
      providerId: row.model.providerId,
      modelId: row.model.modelId,
      ...(row.effort === undefined ? {} : { effort: row.effort }),
      fastMode: fastEnabled && row.fastMode && row.model.supportsFast,
      ...(row.favorite === undefined ? {} : { favoriteUid: row.favorite.uid })
    });
    closeAfterSelection();
  };

  const configureRow = (row: PickerRow, patch: Partial<RowConfiguration>): void => {
    const effort = effortEnabled && patch.effort === undefined ? row.effort : effortEnabled ? validEffort(row.model, patch.effort) : undefined;
    const fastMode = fastEnabled && (patch.fastMode === undefined ? row.fastMode : patch.fastMode && row.model.supportsFast);
    if (row.favorite !== undefined) {
      updateModelFavorite(ownerId, row.favorite.uid, {
        ...(effortEnabled ? { effort: effort ?? null } : {}),
        ...(fastEnabled ? { fast: fastMode } : {})
      });
      if (isSelectedRow(row, value)) onSelect({
        backendId: row.model.backendId,
        providerId: row.model.providerId,
        modelId: row.model.modelId,
        ...(effort === undefined ? {} : { effort }),
        fastMode,
        favoriteUid: row.favorite.uid
      });
      return;
    }
    const storedConfiguration = readModelConfiguration(preferences, row.model.backendId, row.model.providerId, row.model.modelId);
    setModelConfiguration(ownerId, row.model.backendId, row.model.providerId, row.model.modelId, {
      ...(effortEnabled ? { effort } : storedConfiguration?.effort === undefined ? {} : { effort: storedConfiguration.effort }),
      fast: fastEnabled ? fastMode : storedConfiguration?.fast === true
    });
    setRowConfigurations((current) => {
      const next = new Map(current);
      next.set(row.key, { ...(effort === undefined ? {} : { effort }), fastMode });
      return next;
    });
    if (isSelectedRow(row, value)) onSelect({
      backendId: row.model.backendId,
      providerId: row.model.providerId,
      modelId: row.model.modelId,
      ...(effort === undefined ? {} : { effort }),
      fastMode
    });
  };

  const toggleFavorite = (event: MouseEvent, row: PickerRow): void => {
    event.stopPropagation();
    if (row.favorite !== undefined) {
      removeModelFavorite(ownerId, row.favorite.uid);
      if (configRowKey === row.key) setConfigRowKey(undefined);
      return;
    }
    const added = addModelFavorite(ownerId, {
      backendId: row.model.backendId,
      providerId: row.model.providerId,
      modelId: row.model.modelId,
      ...(row.effort === undefined ? {} : { effort: row.effort }),
      ...(row.fastMode ? { fast: true } : {})
    });
    if (added === undefined) return;
    setJustFavoritedKey(row.key);
    if (feedbackTimerRef.current !== undefined) window.clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = window.setTimeout(() => setJustFavoritedKey(undefined), 700);
  };

  const handlePanelKey = (event: KeyboardEvent): void => {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "ArrowLeft" && activeRowKey !== undefined) {
      event.preventDefault();
      const row = rowsByKey.get(activeRowKey);
      if (row !== undefined && (effortEnabled && row.model.efforts.length > 0 || fastEnabled && row.model.supportsFast)) {
        setConfigRowKey(activeRowKey);
        window.requestAnimationFrame(() => configFlyoutRef.current
          ?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled)")
          ?.focus());
      }
      return;
    }
    if (event.key === "ArrowRight" && configRowKey !== undefined) {
      event.preventDefault();
      setConfigRowKey(undefined);
      searchRef.current?.focus();
      return;
    }
    const move = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (move !== 0 && filteredRows.length > 0) {
      event.preventDefault();
      const next = (activeIndex + move + filteredRows.length) % filteredRows.length;
      setActiveRowKey(filteredRows[next]?.key);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActiveRowKey(filteredRows[event.key === "Home" ? 0 : filteredRows.length - 1]?.key);
      return;
    }
    if (event.key === "Enter" && document.activeElement === searchRef.current) {
      const row = filteredRows[activeIndex];
      if (row !== undefined) {
        event.preventDefault();
        selectRow(row);
      }
    }
  };

  const selectedLabel = connectSourceRequired
    ? t("modelPicker.connectSource")
    : selectedModel?.name ?? (value === undefined ? defaultLabel ?? t("modelPicker.default") : value.modelId);
  const selectedEffortLabel = effortEnabled && selectedModel !== undefined && value?.effort !== undefined
    ? effortLabel(selectedModel, value.effort, t)
    : undefined;
  const panelContents = <>
      <header className="model-picker__header">
        <Search aria-hidden="true" />
        <input
          ref={searchRef}
          type="search"
          role="combobox"
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-expanded="true"
          aria-activedescendant={activeRowKey === undefined ? undefined : rowDomId(listboxId, activeRowKey)}
          placeholder={t("modelPicker.search")}
          value={query}
          onChange={(event) => { setQuery(event.target.value); setActiveRowKey(undefined); }}
        />
        <IconButton label={t("common.close")} onClick={() => close()}><X aria-hidden="true" /></IconButton>
      </header>
      <div className="model-picker__body">
        <nav className="model-picker__rail" aria-label={t("modelPicker.filters")}>
          <RailButton active={rail === "favorites"} label={t("modelPicker.favorites")} onClick={() => { setRail("favorites"); setActiveRowKey(undefined); setConfigRowKey(undefined); }}><Star aria-hidden="true" /></RailButton>
          <RailButton active={rail === "all"} label={t("modelPicker.all")} onClick={() => { setRail("all"); setActiveRowKey(undefined); setConfigRowKey(undefined); }}><Bot aria-hidden="true" /></RailButton>
          {providerGroups.map((provider) => <RailButton
            key={provider.id}
            active={rail === `provider:${provider.id}`}
            label={provider.name}
            mark={providerMark(provider.name, provider.id)}
            onClick={() => { setRail(`provider:${provider.id}`); setActiveRowKey(undefined); setConfigRowKey(undefined); }}
          />)}
        </nav>
        <div className="model-picker__content">
          {allowDefault && query.trim() === "" && rail === "all" && <button
            type="button"
            className={cx("model-picker__default-row", value === undefined && "is-selected")}
            onClick={() => { onSelect(undefined); closeAfterSelection(); }}
          ><span><Bot aria-hidden="true" /></span><strong>{defaultLabel ?? t("modelPicker.default")}</strong>{value === undefined && <Check aria-hidden="true" />}</button>}
          <div id={listboxId} className="model-picker__list" role="listbox">
            <ModelRows
              rows={filteredRows}
              value={value}
              activeRowKey={activeRowKey}
              configRowKey={configRowKey}
              justFavoritedKey={justFavoritedKey}
              layout={layout}
              listboxId={listboxId}
              priceTiers={priceTiers}
              rowRefs={rowRefs.current}
              panelElement={panelRef.current}
              configFlyoutRef={configFlyoutRef}
              t={t}
              onActivate={setActiveRowKey}
              onConfigure={setConfigRowKey}
              onSelect={selectRow}
              onToggleFavorite={toggleFavorite}
              onChangeConfiguration={configureRow}
              effortEnabled={effortEnabled}
              fastEnabled={fastEnabled}
            />
            {filteredRows.length === 0 && (routableModels.length === 0 && onConnectSource !== undefined
              ? <div className="model-picker__empty"><Unplug aria-hidden="true" /><strong>{t("modelPicker.noSources")}</strong><span>{t("modelPicker.noSourcesBody")}</span><Button tone="primary" onClick={() => { close(false); onConnectSource(); }}>{t("modelPicker.connectSource")}</Button></div>
              : <div className="model-picker__empty"><Search aria-hidden="true" /><strong>{t("modelPicker.empty")}</strong><span>{t("modelPicker.emptyBody")}</span></div>)}
          </div>
        </div>
      </div>
      <footer className="model-picker__footer">
        <span>{t("modelPicker.keyboardHint")}</span>
        <div>{layout === "original"
          ? <button type="button" onClick={() => setModelPickerLayout("classic")}>{t("modelPicker.tryNew")}</button>
          : <>
              <button
                type="button"
                aria-label={t(layout === "classic" ? "modelPicker.badgeLayout" : "modelPicker.classicLayout")}
                title={t(layout === "classic" ? "modelPicker.badgeLayout" : "modelPicker.classicLayout")}
                onClick={() => setModelPickerLayout(layout === "classic" ? "badge" : "classic")}
              >{layout === "classic" ? "B" : "A"}</button>
              <button type="button" onClick={() => setModelPickerLayout("original")}>{t("modelPicker.original")}</button>
            </>}
        </div>
      </footer>
    </>;
  const standalonePanel = !useMorphPopover && open && panelStyle !== undefined ? createPortal(
    <div
      ref={panelRef}
      className={cx("model-picker", `model-picker--${layout}`)}
      style={panelStyle}
      role="dialog"
      aria-label={t("modelPicker.title")}
      onKeyDown={handlePanelKey}
    >{panelContents}</div>,
    document.body
  ) : null;

  const trigger = <button
      ref={triggerRef}
      type="button"
      className={cx("model-picker-trigger", className)}
      aria-label={connectSourceRequired
        ? t("modelPicker.connectSource")
        : selectedModelUnavailable
        ? `${ariaLabel ?? t("controls.model")}: ${selectedLabel} · ${t("modelPicker.sourceDisconnected")}`
        : ariaLabel ?? t("controls.model")}
      aria-haspopup="dialog"
      aria-expanded={open}
      disabled={disabled}
      onMouseDown={useMorphPopover && onSelectionFocus !== undefined ? (event) => event.preventDefault() : undefined}
      onClick={() => {
        if (!open) void onOpen?.();
        setOpen((current) => !current);
      }}
    >
      <span className="model-picker-trigger__mark">{providerMark(selectedModel?.providerName ?? "", selectedModel?.providerId ?? value?.providerId ?? "")}</span>
      <span className={cx("model-picker-trigger__label", selectedModelUnavailable && !connectSourceRequired && "is-unavailable")}><strong>{selectedLabel}</strong>{value !== undefined && !connectSourceRequired && <small>{selectedModel?.providerName ?? value.providerId}{selectedModelUnavailable ? ` · ${t("modelPicker.sourceDisconnected")}` : ""}</small>}</span>
      <span className="model-picker-trigger__configuration">
        {selectedEffortLabel !== undefined && <small>{selectedEffortLabel}</small>}
        {fastEnabled && selectedModel !== undefined && value !== undefined && value.fastMode && selectedModel.supportsFast && <Zap aria-label={t("controls.fast")} />}
      </span>
      <ChevronDown aria-hidden="true" />
    </button>;
  const renderedTrigger = disabled && disabledReason !== undefined
    ? <Tip text={disabledReason} focusable>{trigger}</Tip>
    : trigger;
  if (useMorphPopover) return <MorphPopover
    open={open}
    onOpenChange={(next) => { if (!next) close(false); }}
    label={t("modelPicker.title")}
    trigger={renderedTrigger}
    panelWidth={modelPickerWidth(layout)}
    align="end"
    panelClassName={cx("model-picker", "model-picker--morph", `model-picker--${layout}`)}
    panelElementRef={panelRef}
    additionalOwnedElementRef={configFlyoutRef}
    initialFocus={() => searchRef.current}
    onPanelKeyDown={handlePanelKey}
  >{panelContents}</MorphPopover>;
  return <>{renderedTrigger}{standalonePanel}</>;
}

function ModelRows({
  rows,
  value,
  activeRowKey,
  configRowKey,
  justFavoritedKey,
  layout,
  listboxId,
  priceTiers,
  rowRefs,
  panelElement,
  configFlyoutRef,
  t,
  onActivate,
  onConfigure,
  onSelect,
  onToggleFavorite,
  onChangeConfiguration,
  effortEnabled,
  fastEnabled
}: {
  readonly rows: readonly PickerRow[];
  readonly value: ModelPickerSelection | undefined;
  readonly activeRowKey: string | undefined;
  readonly configRowKey: string | undefined;
  readonly justFavoritedKey: string | undefined;
  readonly layout: ModelPickerLayout;
  readonly listboxId: string;
  readonly priceTiers: ReadonlyMap<string, 0 | 1 | 2 | 3>;
  readonly rowRefs: Map<string, HTMLDivElement>;
  readonly panelElement: HTMLDivElement | null;
  readonly configFlyoutRef: RefObject<HTMLDivElement | null>;
  readonly t: Translator;
  readonly onActivate: (key: string) => void;
  readonly onConfigure: (key: string | undefined) => void;
  readonly onSelect: (row: PickerRow) => void;
  readonly onToggleFavorite: (event: MouseEvent, row: PickerRow) => void;
  readonly onChangeConfiguration: (row: PickerRow, patch: Partial<RowConfiguration>) => void;
  readonly effortEnabled: boolean;
  readonly fastEnabled: boolean;
}): JSX.Element {
  let previousSection = "";
  return <>{rows.map((row) => {
    const section = row.favorite === undefined ? row.model.providerName : t("modelPicker.favorites");
    const showSection = layout !== "original" && section !== previousSection;
    previousSection = section;
    const selected = isSelectedRow(row, value);
    const active = activeRowKey === row.key;
    const tier = priceTiers.get(modelKey(row.model)) ?? 0;
    const rowEffortLabel = row.effort === undefined ? undefined : effortLabel(row.model, row.effort, t);
    return <div className="model-picker__section-fragment" key={row.key}>
      {showSection && <div className="model-picker__section-label">{section}</div>}
      <div
        ref={(element) => { if (element === null) rowRefs.delete(row.key); else rowRefs.set(row.key, element); }}
        id={rowDomId(listboxId, row.key)}
        className={cx(
          "model-picker__row",
          selected && "is-selected",
          active && "is-active",
          !row.model.available && "is-unavailable",
          row.favorite !== undefined && "is-favorite"
        )}
        role="option"
        aria-selected={selected}
        aria-disabled={!row.model.available}
        aria-keyshortcuts="ArrowLeft"
        tabIndex={row.model.available ? 0 : -1}
        onFocus={() => onActivate(row.key)}
        onPointerMove={() => onActivate(row.key)}
        onPointerEnter={() => { onActivate(row.key); if (row.model.available && layout !== "original") onConfigure(row.key); }}
        onClick={() => onSelect(row)}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || !row.model.available) return;
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            onConfigure(row.key);
            return;
          }
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onSelect(row);
        }}
      >
        <span className="model-picker__row-mark">{layout === "badge" ? <Bot aria-hidden="true" /> : providerMark(row.model.providerName, row.model.providerId)}</span>
        <span className="model-picker__row-copy">
          <span><strong>{row.model.name}</strong>{row.favorite !== undefined && <small>{t("modelPicker.savedConfiguration")}</small>}</span>
          {layout !== "badge" && <small>{row.model.modelId}</small>}
        </span>
        <PriceMark model={row.model} tier={tier} t={t} />
        <span className="model-picker__row-config-summary">
          {rowEffortLabel !== undefined && <span>{rowEffortLabel}</span>}
          {row.fastMode && <Zap aria-label={t("controls.fast")} />}
          {layout === "badge" && <small>{row.model.providerName}</small>}
        </span>
        <IconButton
          className={cx("model-picker__star", (row.favorite !== undefined || justFavoritedKey === row.key) && "is-on")}
          disabled={!row.model.available}
          label={row.favorite === undefined ? t("modelPicker.addFavorite") : t("modelPicker.removeFavorite")}
          disabledReason={!row.model.available ? t("common.unavailable") : undefined}
          onClick={(event) => onToggleFavorite(event, row)}
        ><Star aria-hidden="true" fill={row.favorite !== undefined || justFavoritedKey === row.key ? "currentColor" : "none"} /></IconButton>
        {(effortEnabled && row.model.efforts.length > 0 || fastEnabled && row.model.supportsFast) && <IconButton
          className="model-picker__configure"
          disabled={!row.model.available}
          label={t("modelPicker.configure")}
          disabledReason={!row.model.available ? t("common.unavailable") : undefined}
          aria-expanded={configRowKey === row.key}
          onClick={(event) => { event.stopPropagation(); onConfigure(configRowKey === row.key ? undefined : row.key); }}
        ><SlidersHorizontal aria-hidden="true" /></IconButton>}
        {selected && <Check className="model-picker__check" aria-hidden="true" />}
        {configRowKey === row.key && <RowConfigurationFlyout
          row={row}
          anchorElement={rowRefs.get(row.key) ?? null}
          panelElement={panelElement}
          flyoutRef={configFlyoutRef}
          t={t}
          effortEnabled={effortEnabled}
          fastEnabled={fastEnabled}
          onChange={(patch) => onChangeConfiguration(row, patch)}
        />}
      </div>
    </div>;
  })}</>;
}

function RowConfigurationFlyout({ row, anchorElement, panelElement, flyoutRef, t, effortEnabled, fastEnabled, onChange }: {
  readonly row: PickerRow;
  readonly anchorElement: HTMLDivElement | null;
  readonly panelElement: HTMLDivElement | null;
  readonly flyoutRef: RefObject<HTMLDivElement | null>;
  readonly t: Translator;
  readonly effortEnabled: boolean;
  readonly fastEnabled: boolean;
  readonly onChange: (patch: Partial<RowConfiguration>) => void;
}): JSX.Element | null {
  const thinkingEfforts = effortEnabled ? binaryThinkingEfforts(row.model) : undefined;
  useLayoutEffect(() => {
    const flyout = flyoutRef.current;
    if (flyout === null || anchorElement === null || typeof window === "undefined") return;
    let frame: number | undefined;
    const update = (): void => {
      frame = undefined;
      const anchorRect = anchorElement.getBoundingClientRect();
      const content = anchorElement.closest<HTMLElement>(".model-picker__content");
      const contentRect = content?.getBoundingClientRect();
      if (contentRect !== undefined && (anchorRect.bottom <= contentRect.top || anchorRect.top >= contentRect.bottom)) {
        flyout.style.visibility = "hidden";
        return;
      }
      const bounds = configFlyoutBounds(panelElement);
      const preferredWidth = window.innerWidth <= 640
        ? bounds.right - bounds.left
        : Math.min(280, Math.max(1, anchorRect.width - 42));
      flyout.style.width = `${preferredWidth}px`;
      flyout.style.maxHeight = "none";
      const naturalHeight = Math.max(flyout.scrollHeight, flyout.getBoundingClientRect().height, 1);
      const position = placeModelPickerConfigFlyout(anchorRect, bounds, preferredWidth, naturalHeight);
      flyout.style.left = `${position.left}px`;
      flyout.style.top = `${position.top}px`;
      flyout.style.width = `${position.width}px`;
      flyout.style.maxHeight = `${position.maxHeight}px`;
      flyout.style.visibility = "visible";
      flyout.dataset.side = position.side;
    };
    const requestUpdate = (): void => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("resize", requestUpdate);
    window.addEventListener("scroll", requestUpdate, true);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(requestUpdate);
    observer?.observe(flyout);
    if (panelElement !== null) observer?.observe(panelElement);
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", requestUpdate);
      window.removeEventListener("scroll", requestUpdate, true);
    };
  }, [anchorElement, flyoutRef, panelElement]);

  if (typeof document === "undefined") return null;
  return createPortal(<div
    ref={flyoutRef}
    className="model-picker__config-flyout"
    role="group"
    aria-label={t("modelPicker.configure")}
    style={{ left: -9_999, top: -9_999, visibility: "hidden" }}
    onClick={(event) => event.stopPropagation()}
  >
    <strong>{row.model.name}</strong>
    {thinkingEfforts !== undefined && <label>
      <span>{t("controls.thinking")}</span>
      <CheckboxControl
        checked={row.effort === thinkingEfforts.enabled}
        onChange={(event) => onChange({ effort: event.target.checked ? thinkingEfforts.enabled : thinkingEfforts.disabled })}
      />
    </label>}
    {thinkingEfforts === undefined && effortEnabled && row.model.efforts.length > 0 && <fieldset><legend>{t("controls.effort")}</legend><div>{row.model.efforts.map((effort) => <button
      type="button"
      className={row.effort === effort ? "is-selected" : undefined}
      aria-pressed={row.effort === effort}
      key={effort}
      onClick={() => onChange({ effort })}
    >{effort}</button>)}</div></fieldset>}
    {fastEnabled && <label className={cx(!row.model.supportsFast && "is-disabled")}>
      <span><Zap aria-hidden="true" />{t("controls.fast")}</span>
      <CheckboxControl
        disabled={!row.model.supportsFast}
        checked={row.fastMode}
        onChange={(event) => onChange({ fastMode: event.target.checked })}
      />
    </label>}
    <small>{row.favorite === undefined ? t("modelPicker.configureHint") : t("modelPicker.favoriteEditHint")}</small>
  </div>, document.body);
}

function configFlyoutBounds(panelElement: HTMLDivElement | null): ModelPickerConfigFlyoutRect {
  const viewportPadding = 8;
  const viewport = {
    left: viewportPadding,
    right: Math.max(viewportPadding + 1, window.innerWidth - viewportPadding),
    top: viewportPadding,
    bottom: Math.max(viewportPadding + 1, window.innerHeight - viewportPadding)
  };
  if (panelElement === null) return viewport;
  const panel = panelElement.getBoundingClientRect();
  const contentBottom = panelElement.querySelector<HTMLElement>(".model-picker__content")?.getBoundingClientRect().bottom;
  const bounds = {
    left: Math.max(viewport.left, panel.left + viewportPadding),
    right: Math.min(viewport.right, panel.right - viewportPadding),
    top: viewport.top,
    bottom: Math.min(viewport.bottom, contentBottom ?? panel.bottom - viewportPadding)
  };
  return bounds.right > bounds.left && bounds.bottom > bounds.top ? bounds : viewport;
}

function RailButton({ active, label, mark, onClick, children }: {
  readonly active: boolean;
  readonly label: string;
  readonly mark?: string;
  readonly onClick: () => void;
  readonly children?: JSX.Element;
}): JSX.Element {
  return <button type="button" className={active ? "is-active" : undefined} aria-pressed={active} onClick={onClick}>
    <span>{children ?? mark}</span><small>{label}</small>
  </button>;
}

function PriceMark({ model, tier, t }: { readonly model: ModelView; readonly tier: 0 | 1 | 2 | 3; readonly t: Translator }): JSX.Element | null {
  const pricingUnavailable = model.pricingSource === undefined
    || model.pricingKnown === false
    || model.inputCostMicrosPerMillion < 0
    || model.outputCostMicrosPerMillion < 0;
  if (model.providerAccessKind === "subscription"
    && (model.pricingSource === undefined || model.pricingSource === "providerReference")) {
    return <span className="model-picker__price is-subscription" title={t("modelPicker.subscription")}>{t("modelPicker.subscription")}</span>;
  }
  if (pricingUnavailable) return null;
  const title = t("modelPicker.priceTitle", {
    input: model.inputCostMicrosPerMillion,
    output: model.outputCostMicrosPerMillion,
    currency: model.currencyCode
  });
  if (tier === 0) return <span className="model-picker__price is-free" title={title}>{t("modelPicker.free")}</span>;
  return <span className={cx("model-picker__price", `is-tier-${tier}`)} title={title}>{currencySymbol(model.currencyCode).repeat(tier)}</span>;
}

function priceTierMap(models: readonly ModelView[]): ReadonlyMap<string, 0 | 1 | 2 | 3> {
  const totals = models.map((model) => ({ key: modelKey(model), total: model.inputCostMicrosPerMillion + model.outputCostMicrosPerMillion }))
    .filter((item) => item.total > 0)
    .sort((left, right) => left.total - right.total);
  const result = new Map<string, 0 | 1 | 2 | 3>();
  for (const model of models) {
    const total = model.inputCostMicrosPerMillion + model.outputCostMicrosPerMillion;
    if (total === 0) result.set(modelKey(model), 0);
  }
  totals.forEach((item, index) => result.set(item.key, Math.min(3, Math.floor(index * 3 / Math.max(1, totals.length)) + 1) as 1 | 2 | 3));
  return result;
}

function currencySymbol(currency: string): string {
  if (currency.toUpperCase() === "CNY") return "¥";
  if (currency.toUpperCase() === "EUR") return "€";
  if (currency.toUpperCase() === "GBP") return "£";
  return "$";
}

function providerMark(providerName: string, providerId: string): string {
  return providerName.trim().slice(0, 1).toLocaleUpperCase() || providerId.trim().slice(0, 1).toLocaleUpperCase() || "·";
}

function modelPickerWidth(layout: ModelPickerLayout): number {
  return layout === "original" ? 440 : layout === "classic" ? 620 : 680;
}

function validEffort(model: ModelView, effort: string | undefined): string | undefined {
  return effort !== undefined && model.efforts.includes(effort) ? effort : model.efforts[0];
}

function binaryThinkingEfforts(model: ModelView): BinaryThinkingEfforts | undefined {
  if (model.efforts.length !== 2 || !model.efforts.includes("off")) return undefined;
  const enabled = model.efforts.find((effort) => effort !== "off");
  return enabled === undefined ? undefined : { disabled: "off", enabled };
}

function effortLabel(model: ModelView, effort: string, t: Translator): string | undefined {
  if (!model.efforts.includes(effort)) return undefined;
  const thinkingEfforts = binaryThinkingEfforts(model);
  if (thinkingEfforts === undefined) return effort;
  return effort === thinkingEfforts.enabled ? t("controls.thinking") : undefined;
}

function isSelectedRow(row: PickerRow, value: ModelPickerSelection | undefined): boolean {
  if (value === undefined || row.model.backendId !== value.backendId || row.model.providerId !== value.providerId || row.model.modelId !== value.modelId) return false;
  if (row.favorite === undefined) return true;
  return row.favorite.uid === value.favoriteUid ||
    (row.effort === value.effort && row.fastMode === value.fastMode);
}

function modelKey(value: Pick<ModelView, "backendId" | "providerId" | "modelId"> | Pick<ModelPickerSelection, "backendId" | "providerId" | "modelId"> | Pick<ModelFavoriteConfiguration, "backendId" | "providerId" | "modelId">): string {
  return `${value.backendId}\u0000${value.providerId}\u0000${value.modelId}`;
}

function rowDomId(listboxId: string, rowKey: string): string {
  return `${listboxId}-${rowKey.replace(/[^A-Za-z0-9_-]/gu, "-")}`;
}
