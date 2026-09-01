import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, JSX, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, WheelEvent as ReactWheelEvent } from "react";
import {
  AlertTriangle,
  Boxes,
  Braces,
  CheckCircle2,
  Download,
  Globe2,
  Image as ImageIcon,
  Menu,
  MessageSquarePlus,
  PackageCheck,
  Play,
  RefreshCcw,
  ShieldCheck,
  Trash2,
  Upload,
  Wrench,
  X
} from "lucide-react";
import type { AppController } from "../controller.js";
import { useLiveBrowserTakeover, withLiveBrowserTakeover } from "../browser-takeover-expiry.js";
import { browserPageKey } from "../browser-page-key.js";
import type { AppSnapshot, BrowserActivityView, BrowserCommentDraftItem, BrowserCommentInspectionInputView, BrowserCommentPlacementView, BrowserCommentStyleChangeView, BrowserCommentTargetView, BrowserPageView, BrowserSettingsView, BrowserTakeoverActionView, BrowserTakeoverKeyModifierView, BrowserTakeoverKeyView, BrowserTransferView, BrowserView, McpServerView, ResourceView, SessionView, TimelineItemView } from "../model.js";
import { nextBrowserCommentMarker, sanitizeBrowserCommentPageUrl } from "../browser-comment-draft.js";
import { randomUuid } from "../web-crypto.js";
import { useAppShortcut } from "../use-app-shortcut.js";
import { BrowserChrome, type BrowserChromeHandle } from "./BrowserChrome.js";
import { BrowserCommentPopover, emptyBrowserCommentEditorDraft, hasBrowserCommentDesignDraft, hasBrowserCommentEditorDraft, type BrowserCommentDesignPreview, type BrowserCommentEditorDraft } from "./BrowserCommentPopover.js";
import { BrowserLostPageCard, BrowserPageRail, type BrowserPageSelection } from "./BrowserPageRail.js";
import { resolveComposerAttachmentPolicy } from "./composer-behavior.js";
import type { RunAction, Translator } from "./types.js";
import { Button, EmptyState, IconButton, Modal, Pill, StatusDot, cx, formatRelativeTime, SelectControl } from "./ui.js";
import { moveTablistSelection } from "./tablist-navigation.js";

type ToolsTab = "browser" | "resources" | "mcp" | "activity";

export function ToolsPage({ controller, snapshot, locale, t, runAction, onOpenNavigation }: {
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly locale: string;
  readonly t: Translator;
  readonly runAction: RunAction;
  readonly onOpenNavigation: () => void;
}): JSX.Element {
  const [tab, setTab] = useState<ToolsTab>("browser");
  const [removeResource, setRemoveResource] = useState<ResourceView>();
  const activity = useMemo(() => [...snapshot.timelineBySession.values()].flat().filter((item) => item.tool !== undefined).sort((a, b) => b.createdAt - a.createdAt), [snapshot.timelineBySession]);
  const mcpBackends = snapshot.backends.filter((backend) => backend.capabilities.get("tool.mcp")?.supported === true);
  const browserSessions = useMemo(() => [...snapshot.sessions]
    .filter((session) => !session.archived && session.state !== "closed")
    .sort((left, right) => right.updatedAt - left.updatedAt), [snapshot.sessions]);
  const browserCommentSessions = useMemo(() => [...snapshot.sessions]
    .filter((session) => {
      if (session.archived || session.state === "closed") return false;
      const backend = snapshot.backends.find((candidate) => candidate.id === session.backendId);
      const bridgeRouted = snapshot.settings.visionBridge.enabled && session.model !== undefined
        && snapshot.settings.visionBridge.targetModels.some((target) => target.backendId === session.backendId && target.providerId === session.model?.providerId && target.modelId === session.model.modelId);
      return resolveComposerAttachmentPolicy(backend, session.model?.supportsImages === true || bridgeRouted).images;
    })
    .sort((left, right) => right.updatedAt - left.updatedAt), [snapshot.backends, snapshot.sessions, snapshot.settings.visionBridge]);
  return (
    <main className="route-page">
      <header className="route-header">
        {!controller.state.preferences.navigationOpen && <IconButton className="mobile-panel-toggle" label={t("a11y.openNavigation")} onClick={onOpenNavigation}><Menu aria-hidden="true" /></IconButton>}
        <div><p className="eyebrow">{t("tools.eyebrow")}</p><h1>{t("tools.title")}</h1><p>{t("tools.subtitle")}</p></div>
        <Pill tone={snapshot.browsers.some((browser) => browser.state === "ready") ? "success" : "neutral"}>{t("tools.providerCount", { count: snapshot.browsers.length })}</Pill>
      </header>
      <div className="route-tabs" role="tablist" aria-label={t("tools.title")} aria-orientation="horizontal">
        <TabButton id="browser" current={tab} onClick={setTab}><Globe2 />{t("tools.browser")}</TabButton>
        <TabButton id="resources" current={tab} onClick={setTab}><Braces />{t("tools.resources")}<span>{snapshot.resources.length}</span></TabButton>
        <TabButton id="mcp" current={tab} onClick={setTab}><Boxes />{t("tools.mcp")}</TabButton>
        <TabButton id="activity" current={tab} onClick={setTab}><Wrench />{t("tools.activity")}<span>{activity.length}</span></TabButton>
      </div>
      <div id="tools-tabpanel" className="route-page__content" role="tabpanel" aria-labelledby={`tools-tab-${tab}`}>
        {tab === "browser" && <BrowserTools controller={controller} browsers={snapshot.browsers} browserSettings={snapshot.settings.browsers} sessions={browserSessions} commentSessions={browserCommentSessions} locale={locale} t={t} runAction={runAction} />}
        {tab === "resources" && <ResourcesTools controller={controller} resources={snapshot.resources} t={t} runAction={runAction} onRemove={setRemoveResource} />}
        {tab === "mcp" && <McpTools controller={controller} backends={mcpBackends} servers={snapshot.settings.mcpServers} t={t} runAction={runAction} />}
        {tab === "activity" && <ActivityTools activity={activity} locale={locale} t={t} />}
      </div>
      <Modal open={removeResource !== undefined} title={t("tools.removeTitle", { name: removeResource?.name ?? t("tools.resources") })} description={t("tools.removeBody")} size="small" onClose={() => setRemoveResource(undefined)}>
        <div className="modal__actions"><Button onClick={() => setRemoveResource(undefined)}>{t("common.cancel")}</Button><Button tone="danger" onClick={() => { const resource = removeResource; setRemoveResource(undefined); if (resource !== undefined) runAction(`remove-resource:${resource.id}`, () => controller.removeResource(resource.id)); }}><Trash2 aria-hidden="true" />{t("common.remove")}</Button></div>
      </Modal>
    </main>
  );
}

function TabButton({ id, current, onClick, children }: { readonly id: ToolsTab; readonly current: ToolsTab; readonly onClick: (id: ToolsTab) => void; readonly children: ReactNode }): JSX.Element {
  return <button type="button" role="tab" id={`tools-tab-${id}`} aria-controls="tools-tabpanel" aria-selected={current === id} tabIndex={current === id ? 0 : -1} className={current === id ? "is-active" : ""} onClick={() => onClick(id)} onKeyDown={(event) => moveTablistSelection(event, "horizontal")}>{children}</button>;
}

function BrowserTools({ controller, browsers, browserSettings, sessions, commentSessions, locale, t, runAction }: { readonly controller: AppController; readonly browsers: readonly BrowserView[]; readonly browserSettings: readonly BrowserSettingsView[]; readonly sessions: readonly SessionView[]; readonly commentSessions: readonly SessionView[]; readonly locale: string; readonly t: Translator; readonly runAction: RunAction }): JSX.Element {
  const [selected, setSelected] = useState<BrowserPageSelection>();
  const [captured, setCaptured] = useState<Readonly<Record<string, string>>>({});
  const capturedRef = useRef(captured);
  const controllerRef = useRef(controller);
  capturedRef.current = captured;
  controllerRef.current = controller;
  useEffect(() => () => {
    for (const blobId of Object.values(capturedRef.current)) controllerRef.current.releaseArtifactUrl(blobId);
  }, []);
  const storeCapture = (browserId: string, pageId: string, blobId: string): void => {
    setCaptured((current) => {
      const key = browserPageKey(browserId, pageId);
      const previous = current[key];
      if (previous !== undefined && previous !== blobId) controller.releaseArtifactUrl(previous);
      return { ...current, [key]: blobId };
    });
  };
  const capture = (browserId: string, pageId: string): void => {
    runAction(`browser-capture:${browserPageKey(browserId, pageId)}`, async () => {
      const blobId = await controller.captureBrowserScreenshot(browserId, pageId, false);
      storeCapture(browserId, pageId, blobId);
    });
  };
  if (browsers.length === 0) return <EmptyState icon={<Globe2 />} title={t("tools.noBrowser")} body={t("tools.browserHelp")} />;
  return <div className="browser-provider-grid">{browsers.map((browser) => <BrowserToolCard
    key={browser.id}
    source={browser}
    allowUploads={browserSettings.find((settings) => settings.browserProviderId === browser.id)?.allowUploads === true}
    selected={selected}
    captured={captured}
    sessions={sessions}
    commentSessions={commentSessions}
    locale={locale}
    controller={controller}
    t={t}
    runAction={runAction}
    onSelect={setSelected}
    onCapture={capture}
    onStoreCapture={storeCapture}
  />)}</div>;
}

function BrowserToolCard({ source, allowUploads, selected, captured, sessions, commentSessions, locale, controller, t, runAction, onSelect, onCapture, onStoreCapture }: {
  readonly source: BrowserView;
  readonly allowUploads: boolean;
  readonly selected?: BrowserPageSelection;
  readonly captured: Readonly<Record<string, string>>;
  readonly sessions: readonly SessionView[];
  readonly commentSessions: readonly SessionView[];
  readonly locale: string;
  readonly controller: AppController;
  readonly t: Translator;
  readonly runAction: RunAction;
  readonly onSelect: (selection: BrowserPageSelection | undefined) => void;
  readonly onCapture: (browserId: string, pageId: string) => void;
  readonly onStoreCapture: (browserId: string, pageId: string, blobId: string) => void;
}): JSX.Element {
  const browser = withLiveBrowserTakeover(source, useLiveBrowserTakeover(source.takeover));
  const page = browser.pages.find((candidate) => candidate.id === selected?.pageId && browser.id === selected.browserId)
    ?? browser.pages.find((candidate) => candidate.id === browser.activePageId)
    ?? browser.pages[0];
  return <article className="browser-provider">
      <header><div><StatusDot state={browser.state} label={browser.state} /><span><h2>{browser.name}</h2><p>{t("browser.generation", { generation: browser.generation.toString() })}</p></span></div><div className="browser-provider__status"><Pill tone={browser.state === "ready" ? "success" : browser.state === "error" ? "danger" : "warning"}>{browser.state}</Pill>{browser.takeover !== undefined && <Pill tone={browser.takeover.state === "active" ? "accent" : "warning"}>{t("browser.takeoverState", { state: browser.takeover.state })}</Pill>}</div></header>
      <div className="browser-provider__layout">
        <BrowserPageRail browser={browser} selectedPageId={page?.id} sessions={sessions} controller={controller} t={t} runAction={runAction} onSelect={onSelect} />
        {page?.recoverable === true ? <BrowserLostPageCard page={page} t={t} /> : <BrowserCanvas browser={browser} page={page} allowUploads={allowUploads} screenshotBlobId={page === undefined ? undefined : captured[browserPageKey(browser.id, page.id)] ?? page.screenshotBlobId} sessions={commentSessions} locale={locale} t={t} controller={controller} runAction={runAction} onCapture={onCapture} onStoreCapture={onStoreCapture} onUpload={(browserId, pageId, file) => {
          runAction(`browser-upload:${browserPageKey(browserId, pageId)}`, () => controller.uploadBrowserFile(browserId, pageId, file));
        }} onAction={async (browserId, pageId, action) => {
          const blobId = await controller.performBrowserTakeoverAction(browserId, pageId, action);
          onStoreCapture(browserId, pageId, blobId);
        }} />}
      </div>
      {page !== undefined && <BrowserLedger controller={controller} browser={browser} page={page} locale={locale} t={t} runAction={runAction} />}
      <footer><Button onClick={() => runAction(`browser-restart:${browser.id}`, () => controller.restartBrowser(browser.id))}><RefreshCcw aria-hidden="true" />{t("browser.recover")}</Button>{browser.takeover?.state === "active" && browser.takeover.connectionId === controller.state.activeProfile?.id && <Button tone="primary" onClick={() => runAction(`browser-release:${browser.id}`, () => controller.endBrowserTakeover(browser.id))}>{t("browser.release")}</Button>}</footer>
    </article>;
}

interface PreparedBrowserComment {
  readonly sessionId: string;
  readonly markerNumber: number;
  readonly target: BrowserCommentTargetView;
  readonly targetToken?: string;
}

type BrowserCommentSaveOutcome = "aborted" | "committed-continuing" | "committed-stopped";

type BrowserCommentSelectionInputView =
  | Omit<Extract<BrowserCommentInspectionInputView, { readonly intent: "existingText" }>, "markerNumber">
  | Omit<Extract<BrowserCommentInspectionInputView, { readonly intent: "element" }>, "markerNumber">
  | Omit<Extract<BrowserCommentInspectionInputView, { readonly intent: "region" }>, "markerNumber">;

export function BrowserCanvas({ browser, page, allowUploads, screenshotBlobId, sessions, locale, t, controller, runAction, onCapture, onStoreCapture, onUpload, onAction }: { readonly browser: BrowserView; readonly page?: BrowserPageView; readonly allowUploads: boolean; readonly screenshotBlobId?: string; readonly sessions: readonly SessionView[]; readonly locale: string; readonly t: Translator; readonly controller: AppController; readonly runAction: RunAction; readonly onCapture: (browserId: string, pageId: string) => void; readonly onStoreCapture: (browserId: string, pageId: string, blobId: string) => void; readonly onUpload: (browserId: string, pageId: string, file: File) => void; readonly onAction: (browserId: string, pageId: string, action: BrowserTakeoverActionView) => Promise<void> }): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const chromeRef = useRef<BrowserChromeHandle>(null);
  const navigationGenerationRef = useRef(0);
  const commentEpochRef = useRef(0);
  const commentPreviewChainRef = useRef<Promise<void>>(Promise.resolve());
  const copyResetRef = useRef<number | undefined>(undefined);
  const [navigationPending, setNavigationPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [commentMode, setCommentMode] = useState(false);
  const [commentPreparing, setCommentPreparing] = useState(false);
  const [commentSaving, setCommentSaving] = useState(false);
  const [commentError, setCommentError] = useState<string>();
  const [commentEditor, setCommentEditor] = useState<BrowserCommentEditorDraft>(emptyBrowserCommentEditorDraft);
  const commentEditorRef = useRef(commentEditor);
  commentEditorRef.current = commentEditor;
  const [preparedComment, setPreparedComment] = useState<PreparedBrowserComment>();
  const [commentPlacements, setCommentPlacements] = useState<readonly BrowserCommentPlacementView[]>([]);
  const commentPlacementsRef = useRef(commentPlacements);
  commentPlacementsRef.current = commentPlacements;
  const preparedCommentRef = useRef(preparedComment);
  preparedCommentRef.current = preparedComment;
  const [targetSessionId, setTargetSessionId] = useState<string | undefined>(sessions[0]?.id);
  useEffect(() => {
    if (targetSessionId !== undefined && sessions.some((session) => session.id === targetSessionId)) return;
    const pending = preparedCommentRef.current;
    if (pending?.targetToken !== undefined && page !== undefined) {
      void controller.updateBrowserCommentDesign(browser.id, page.id, {
        action: "reset",
        targetToken: pending.targetToken
      }).catch(() => undefined);
    }
    setTargetSessionId(sessions[0]?.id);
    setPreparedComment(undefined);
    if (sessions.length === 0) {
      commentEpochRef.current += 1;
      setCommentMode(false);
      setCommentEditor(emptyBrowserCommentEditorDraft());
    }
  }, [browser.id, controller, page, sessions, targetSessionId]);
  useEffect(() => () => {
    if (copyResetRef.current !== undefined) window.clearTimeout(copyResetRef.current);
  }, []);
  useEffect(() => {
    navigationGenerationRef.current += 1;
    commentEpochRef.current += 1;
    setNavigationPending(false);
    setCopied(false);
    setCommentMode(false);
    setCommentPreparing(false);
    setCommentSaving(false);
    setCommentError(undefined);
    setPreparedComment(undefined);
    setCommentPlacements([]);
    if (copyResetRef.current !== undefined) {
      window.clearTimeout(copyResetRef.current);
      copyResetRef.current = undefined;
    }
  }, [browser.generation, page?.id, page?.url]);
  useEffect(() => {
    const pageId = page?.id;
    if (pageId === undefined) return;
    return () => {
      void controller.updateBrowserCommentDesign(browser.id, pageId, { action: "resetAll" }).catch(() => undefined);
    };
  }, [browser.id, controller, page?.id]);
  const ownsPageTakeover = page !== undefined
    && browser.takeover?.state === "active"
    && browser.takeover.connectionId === controller.state.activeProfile?.id
    && browser.takeover.pageId === page.id
    && browser.takeover.generation === browser.generation;
  const runChromeAction = (action: BrowserTakeoverActionView): void => {
    if (page === undefined) return;
    if (commentMode && (action.kind === "navigate" || (action.kind === "navigationCommand" && action.command !== "stop"))) {
      commentEpochRef.current += 1;
      setCommentMode(false);
      setCommentPreparing(false);
      setCommentSaving(false);
      setCommentError(undefined);
      setPreparedComment(undefined);
      setCommentPlacements([]);
      void controller.updateBrowserCommentDesign(browser.id, page.id, { action: "resetAll" }).catch(() => undefined);
    }
    const token = ++navigationGenerationRef.current;
    if (action.kind === "navigationCommand" && action.command === "stop") {
      setNavigationPending(false);
    } else {
      setNavigationPending(true);
    }
    runAction(`browser-chrome:${browserPageKey(browser.id, page.id)}:${action.kind}`, async () => {
      try {
        await onAction(browser.id, page.id, action);
      } finally {
        if (navigationGenerationRef.current === token) setNavigationPending(false);
      }
    });
  };
  const browserShortcutGuard = (event: KeyboardEvent): boolean => {
    if (!ownsPageTakeover || page === undefined || commentMode) return false;
    const target = event.target instanceof Element ? event.target : null;
    if (target !== null && rootRef.current?.contains(target) !== true) return false;
    return !(target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || (target !== null && target.closest("[contenteditable='true']") !== null));
  };
  const shortcutOverrides = controller.state.preferences.appShortcutOverrides;
  useAppShortcut("browser-focus-url", shortcutOverrides, (event) => {
    if (!browserShortcutGuard(event)) return false;
    chromeRef.current?.focusOmnibox();
    return true;
  }, { enabled: ownsPageTakeover });
  useAppShortcut("browser-back", shortcutOverrides, (event) => {
    if (!browserShortcutGuard(event) || page?.canGoBack !== true) return false;
    runChromeAction({ kind: "navigationCommand", command: "back" });
    return true;
  }, { enabled: ownsPageTakeover });
  useAppShortcut("browser-forward", shortcutOverrides, (event) => {
    if (!browserShortcutGuard(event) || page?.canGoForward !== true) return false;
    runChromeAction({ kind: "navigationCommand", command: "forward" });
    return true;
  }, { enabled: ownsPageTakeover });
  useAppShortcut("browser-reload", shortcutOverrides, (event) => {
    if (!browserShortcutGuard(event)) return false;
    runChromeAction({ kind: "navigationCommand", command: "reload" });
    return true;
  }, { enabled: ownsPageTakeover });

  const saveBrowserComment = async (
    prepared: PreparedBrowserComment,
    rawComment: string,
    styleChanges: readonly BrowserCommentStyleChangeView[] = [],
    expectedEpoch = commentEpochRef.current
  ): Promise<BrowserCommentSaveOutcome> => {
    if (page === undefined || commentEpochRef.current !== expectedEpoch) return "aborted";
    const draft = await controller.readDraft(prepared.sessionId);
    if (commentEpochRef.current !== expectedEpoch) return "aborted";
    const markerNumber = prepared.markerNumber;
    const pageUrl = sanitizeBrowserCommentPageUrl(page.url);
    const placements = await controller.updateBrowserCommentDesign(browser.id, page.id, {
      action: "reconcile",
      validMarkerNumbers: (draft?.browserComments ?? []).map((item) => item.markerNumber)
    });
    if (!placements.some((placement) => placement.pending && placement.markerNumber === markerNumber)) {
      throw new Error("The selected Browser annotation is no longer pending on this page.");
    }
    if (commentEpochRef.current !== expectedEpoch) return "aborted";
    const freshBlobId = await controller.captureBrowserScreenshot(browser.id, page.id, false);
    let screenshot: File;
    let retainedCapture = false;
    try {
      screenshot = await annotateBrowserScreenshotUrl(await controller.getArtifactUrl(freshBlobId), placements);
      onStoreCapture(browser.id, page.id, freshBlobId);
      retainedCapture = true;
    } finally {
      if (!retainedCapture) controller.releaseArtifactUrl(freshBlobId);
    }
    if (commentEpochRef.current !== expectedEpoch) return "aborted";
    const item: BrowserCommentDraftItem = {
      id: randomUuid(),
      markerNumber,
      pageUrl,
      target: prepared.target,
      comment: rawComment.trim().slice(0, 8_000),
      screenshot: { id: randomUuid(), kind: "image", file: screenshot },
      ...(styleChanges.length === 0 ? {} : { styleChanges })
    };
    await controller.saveDraft(prepared.sessionId, {
      text: draft?.text ?? "",
      attachments: draft?.attachments ?? [],
      mentions: draft?.mentions ?? [],
      deliveryMode: draft?.deliveryMode ?? "prompt",
      ...(draft?.editorDocument === undefined ? {} : { editorDocument: draft.editorDocument }),
      ...(draft?.extraDirectoryIds === undefined ? {} : { extraDirectoryIds: draft.extraDirectoryIds }),
      browserComments: [...(draft?.browserComments ?? []), item]
    });
    let continuation = commentEpochRef.current === expectedEpoch;
    if (prepared.targetToken !== undefined) {
      try {
        await controller.updateBrowserCommentDesign(browser.id, page.id, {
          action: "commit",
          targetToken: prepared.targetToken,
          markerNumber
        });
      } catch {
        continuation = false;
        await controller.updateBrowserCommentDesign(browser.id, page.id, { action: "resetAll" }).catch(() => undefined);
      }
    }
    const livePlacements: readonly BrowserCommentPlacementView[] = continuation
      ? placements.map((placement) => placement.pending
          ? { markerNumber: placement.markerNumber, point: placement.point, viewport: placement.viewport, pending: false }
          : placement)
      : [];
    commentPlacementsRef.current = livePlacements;
    setCommentPlacements(livePlacements);
    return continuation ? "committed-continuing" : "committed-stopped";
  };

  const inspectAndPrepareBrowserComment = (
    input: BrowserCommentSelectionInputView,
    immediate: boolean,
    allowBeforeMode = false
  ): void => {
    const sessionId = targetSessionId;
    if ((!commentMode && !allowBeforeMode) || sessionId === undefined || page === undefined) return;
    const epoch = ++commentEpochRef.current;
    const previous = preparedCommentRef.current;
    setCommentError(undefined);
    setCommentPreparing(true);
    setPreparedComment(undefined);
    void (async () => {
      if (previous?.targetToken !== undefined) {
        await controller.updateBrowserCommentDesign(browser.id, page.id, { action: "reset", targetToken: previous.targetToken });
        setCommentPlacements((current) => current.filter((placement) => !placement.pending));
      }
      const draft = await controller.readDraft(sessionId);
      if (commentEpochRef.current !== epoch) return;
      const markerNumber = nextBrowserCommentMarker(draft?.browserComments);
      const inspection = await controller.inspectBrowserCommentTarget(browser.id, page.id, { ...input, markerNumber } as BrowserCommentInspectionInputView);
      if (inspection.target === undefined || inspection.targetToken === undefined || commentEpochRef.current !== epoch) return;
      if (inspection.target.designBaseline === undefined && hasBrowserCommentDesignDraft(commentEditorRef.current)) {
        if (inspection.targetToken !== undefined) {
          await controller.updateBrowserCommentDesign(browser.id, page.id, { action: "reset", targetToken: inspection.targetToken });
        }
        return;
      }
      const prepared = {
        sessionId,
        markerNumber,
        target: inspection.target,
        ...(inspection.targetToken === undefined ? {} : { targetToken: inspection.targetToken })
      } satisfies PreparedBrowserComment;
      if (immediate && !hasBrowserCommentEditorDraft(commentEditorRef.current)) {
        setCommentSaving(true);
        try {
          const outcome = await saveBrowserComment(prepared, "", [], epoch);
          if (outcome === "committed-stopped") setCommentMode(false);
        } catch (cause) {
          if (prepared.targetToken !== undefined) {
            await controller.updateBrowserCommentDesign(browser.id, page.id, { action: "reset", targetToken: prepared.targetToken }).catch(() => undefined);
          }
          throw cause;
        }
      } else {
        setPreparedComment(prepared);
      }
    })().catch((cause: unknown) => {
      if (commentEpochRef.current === epoch) setCommentError(cause instanceof Error ? cause.message : t("browser.commentCaptureFailed"));
    }).finally(() => {
      if (commentEpochRef.current === epoch) {
        setCommentPreparing(false);
        setCommentSaving(false);
      }
    });
  };

  const prepareBrowserComment = (target: BrowserCommentTargetView, immediate: boolean): void => {
    if (target.kind === "text") return;
    inspectAndPrepareBrowserComment(target.kind === "element"
      ? { intent: "element", point: target.point, viewport: target.viewport }
      : { intent: "region", point: target.point, viewport: target.viewport, region: target.region }, immediate);
  };

  const abandonPreparedBrowserComment = (): void => {
    const prepared = preparedCommentRef.current;
    ++commentEpochRef.current;
    setPreparedComment(undefined);
    setCommentEditor(emptyBrowserCommentEditorDraft());
    setCommentPlacements((current) => current.filter((placement) => !placement.pending));
    if (prepared?.targetToken !== undefined && page !== undefined) {
      void controller.updateBrowserCommentDesign(browser.id, page.id, { action: "reset", targetToken: prepared.targetToken }).catch(() => undefined);
    }
  };

  const exitBrowserCommentMode = (): void => {
    ++commentEpochRef.current;
    setCommentMode(false);
    setPreparedComment(undefined);
    setCommentEditor(emptyBrowserCommentEditorDraft());
    setCommentPlacements([]);
    if (page !== undefined) void controller.updateBrowserCommentDesign(browser.id, page.id, { action: "resetAll" }).catch(() => undefined);
  };

  const previewBrowserCommentDesign = useCallback((preview: BrowserCommentDesignPreview): void => {
    const prepared = preparedCommentRef.current;
    const pageId = page?.id;
    if (prepared?.targetToken === undefined || pageId === undefined) return;
    const targetToken = prepared.targetToken;
    const epoch = commentEpochRef.current;
    commentPreviewChainRef.current = commentPreviewChainRef.current.catch(() => undefined).then(async () => {
      if (commentEpochRef.current !== epoch || preparedCommentRef.current?.targetToken !== targetToken) return;
      await controller.updateBrowserCommentDesign(browser.id, pageId, {
        action: "apply",
        targetToken,
        styles: preview.styles,
        ...(Object.prototype.hasOwnProperty.call(preview, "text") ? { text: preview.text } : {})
      });
    }).catch((cause: unknown) => {
      if (commentEpochRef.current === epoch) setCommentError(cause instanceof Error ? cause.message : t("browser.commentCaptureFailed"));
    });
  }, [browser.id, controller, page?.id, t]);

  const submitBrowserComment = (text: string, styleChanges: readonly BrowserCommentStyleChangeView[]): void => {
    const prepared = preparedCommentRef.current;
    if (prepared === undefined || commentSaving) return;
    const epoch = commentEpochRef.current;
    setCommentError(undefined);
    setCommentSaving(true);
    runAction(`browser-comment:${page === undefined ? browser.id : browserPageKey(browser.id, page.id)}`, async () => {
      try {
        await commentPreviewChainRef.current;
        const outcome = await saveBrowserComment(prepared, text, styleChanges, epoch);
        if (outcome === "aborted") return;
        setPreparedComment(undefined);
        setCommentEditor(emptyBrowserCommentEditorDraft());
        if (outcome === "committed-stopped") setCommentMode(false);
      } catch (cause: unknown) {
        if (commentEpochRef.current === epoch) setCommentError(cause instanceof Error ? cause.message : t("browser.commentCaptureFailed"));
        throw cause;
      } finally {
        if (commentEpochRef.current === epoch) setCommentSaving(false);
      }
    });
  };

  if (page === undefined) return <div className="browser-canvas browser-canvas--empty"><ImageIcon aria-hidden="true" /><p>{t("browser.noPages")}</p></div>;
  const externalUrl = safeExternalUrl(page.url);
  const takeoverLive = browser.takeover !== undefined && ["requested", "active", "releasing"].includes(browser.takeover.state);
  const copyLink = (): void => runAction(`browser-copy-link:${browserPageKey(browser.id, page.id)}`, async () => {
    await navigator.clipboard.writeText(page.url);
    setCopied(true);
    if (copyResetRef.current !== undefined) window.clearTimeout(copyResetRef.current);
    copyResetRef.current = window.setTimeout(() => setCopied(false), 1_500);
  });
  return <div ref={rootRef} className="browser-canvas"><BrowserChrome
    ref={chromeRef}
    url={page.url}
    enabled={ownsPageTakeover}
    loading={navigationPending || page.state === "loading"}
    canGoBack={page.canGoBack}
    canGoForward={page.canGoForward}
    externalUrl={externalUrl}
    copied={copied}
    commentSupported={ownsPageTakeover && sessions.length > 0 && screenshotBlobId !== undefined}
    commentActive={commentMode}
    t={t}
    onNavigate={(url) => runChromeAction({ kind: "navigate", url })}
    onCommand={(command) => runChromeAction({ kind: "navigationCommand", command })}
    onCapture={() => onCapture(browser.id, page.id)}
    onCopyLink={copyLink}
    onComment={() => {
      if (commentMode) {
        exitBrowserCommentMode();
        return;
      }
      setCommentMode(true);
      setPreparedComment(undefined);
      setCommentPlacements([]);
      setCommentError(undefined);
      inspectAndPrepareBrowserComment({ intent: "existingText" }, false, true);
    }}
  />{screenshotBlobId === undefined ? <div className="browser-canvas__empty"><ImageIcon aria-hidden="true" /><p>{t("browser.noScreenshot")}</p></div> : <RemoteBrowserCanvas browserId={browser.id} blobId={screenshotBlobId} page={page} enabled={ownsPageTakeover && !commentMode} commentMode={commentMode} commentTarget={preparedComment?.target} commentMarker={preparedComment?.markerNumber} commentPlacements={commentPlacements} overlay={preparedComment === undefined ? undefined : <BrowserCommentPopover
    target={preparedComment.target}
    baseline={preparedComment.target.designBaseline}
    editor={commentEditor}
    saving={commentSaving}
    t={t}
    onChange={setCommentEditor}
    onSubmit={submitBrowserComment}
    onCancel={abandonPreparedBrowserComment}
    onPreview={previewBrowserCommentDesign}
    onReset={() => undefined}
  />} getUrl={controller.getArtifactUrl} t={t} runAction={runAction} onCommentTarget={prepareBrowserComment} onCommentExit={exitBrowserCommentMode} onAction={async (action) => {
    await onAction(browser.id, page.id, action);
    if (!commentMode || action.kind !== "scroll") return;
    const placements = await controller.updateBrowserCommentDesign(browser.id, page.id, {
      action: "reconcile",
      validMarkerNumbers: commentPlacementsRef.current.filter((placement) => !placement.pending).map((placement) => placement.markerNumber)
    });
    commentPlacementsRef.current = placements;
    setCommentPlacements(placements);
  }} />}
  {commentMode && <section className="browser-comment-panel" aria-label={t("browser.comment")}>
    <header><MessageSquarePlus aria-hidden="true" /><span><strong>{t("browser.commentModeTitle")}</strong><small>{t("browser.commentModeHelp")}</small></span><IconButton label={t("browser.exitCommentMode")} onClick={exitBrowserCommentMode}><X aria-hidden="true" /></IconButton></header>
    <label><span>{t("browser.commentTargetTask")}</span><SelectControl value={targetSessionId ?? ""} disabled={commentPreparing || commentSaving} onChange={(event) => { abandonPreparedBrowserComment(); setTargetSessionId(event.target.value || undefined); }}><option value="" disabled>{t("browser.commentChooseTask")}</option>{sessions.map((session) => <option key={session.id} value={session.id}>{session.name || t("session.unnamed")}</option>)}</SelectControl></label>
    {preparedComment === undefined && <p>{commentPreparing ? t("browser.commentPreparing") : t("browser.commentSelectTarget")}</p>}
    {commentError !== undefined && <p role="alert"><AlertTriangle aria-hidden="true" />{commentError}</p>}
    <Button tone="ghost" disabled={targetSessionId === undefined} onClick={() => { if (targetSessionId !== undefined) controller.navigate({ kind: "session", sessionId: targetSessionId }); }}>{t("browser.commentOpenTask")}</Button>
  </section>}
  <div className="browser-canvas__takeover"><Pill tone={commentMode ? "accent" : ownsPageTakeover ? "accent" : "neutral"}>{commentMode ? t("browser.commentModeTitle") : ownsPageTakeover ? t("browser.remoteControlActive") : browser.takeover?.state === "active" ? t("browser.remoteControlUnavailable") : t("browser.remoteControlInactive")}</Pill>{browser.takeover?.state === "active" && browser.takeover.pageId !== page.id && <span>{t("browser.takeoverOtherPage")}</span>}</div><div className="browser-canvas__footer"><span>{page.lastActivityAt === undefined ? t("browser.noActivity") : t("browser.activeAgo", { time: formatRelativeTime(page.lastActivityAt, locale) })}</span><input ref={uploadInput} className="sr-only" type="file" tabIndex={-1} aria-hidden="true" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file !== undefined) onUpload(browser.id, page.id, file); }} /><Button disabled={!allowUploads} title={allowUploads ? t("browser.uploadHelp") : t("browser.uploadDisabled")} onClick={() => uploadInput.current?.click()}><Upload aria-hidden="true" />{t("browser.upload")}</Button>{!takeoverLive && <Button tone="primary" onClick={() => runAction(`browser-takeover:${browserPageKey(browser.id, page.id)}`, () => controller.beginBrowserTakeover(browser.id, page.id))}><Play aria-hidden="true" />{t("browser.takeover")}</Button>}</div></div>;
}

function RemoteBrowserCanvas({ browserId, blobId, page, enabled, commentMode, commentTarget, commentMarker, commentPlacements, overlay, getUrl, t, runAction, onCommentTarget, onCommentExit, onAction }: { readonly browserId: string; readonly blobId: string; readonly page: BrowserPageView; readonly enabled: boolean; readonly commentMode: boolean; readonly commentTarget?: BrowserCommentTargetView; readonly commentMarker?: number; readonly commentPlacements: readonly BrowserCommentPlacementView[]; readonly overlay?: ReactNode; readonly getUrl: (blobId: string) => Promise<string>; readonly t: Translator; readonly runAction: RunAction; readonly onCommentTarget: (target: BrowserCommentTargetView, immediate: boolean) => void; readonly onCommentExit: () => void; readonly onAction: (action: BrowserTakeoverActionView) => Promise<void> }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointerStartRef = useRef<{ readonly pointerId: number; readonly x: number; readonly y: number; readonly button: "primary" | "middle" | "secondary"; readonly clickCount: 1 | 2 } | undefined>(undefined);
  const commentStartRef = useRef<{ readonly pointerId: number; readonly x: number; readonly y: number; readonly region: boolean; readonly immediate: boolean } | undefined>(undefined);
  const hoverTimerRef = useRef<number | undefined>(undefined);
  const pendingHoverRef = useRef<{ readonly x: number; readonly y: number } | undefined>(undefined);
  const [source, setSource] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [textInput, setTextInput] = useState("");
  const [commentDrag, setCommentDrag] = useState<{ readonly startX: number; readonly startY: number; readonly endX: number; readonly endY: number }>();
  useEffect(() => () => {
    if (hoverTimerRef.current !== undefined) window.clearTimeout(hoverTimerRef.current);
  }, []);
  useEffect(() => {
    let current = true;
    setSource(undefined);
    setFailed(false);
    void getUrl(blobId).then((url) => { if (current) setSource(url); }).catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [blobId, getUrl]);
  useEffect(() => {
    if (source === undefined) return;
    let current = true;
    const image = new Image();
    image.onload = () => {
      if (!current) return;
      const canvas = canvasRef.current;
      if (canvas === null) return;
      canvas.width = Math.max(1, image.naturalWidth);
      canvas.height = Math.max(1, image.naturalHeight);
      canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
    };
    image.onerror = () => { if (current) setFailed(true); };
    image.src = source;
    return () => { current = false; image.onload = null; image.onerror = null; };
  }, [source]);
  const perform = (action: BrowserTakeoverActionView, allowDuringComment = false): void => {
    if ((!enabled && !(commentMode && allowDuringComment)) || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    runAction(`browser-remote:${browserPageKey(browserId, page.id)}`, async () => {
      try { await onAction(action); } finally { busyRef.current = false; setBusy(false); }
    });
  };
  const pointerPoint = (event: ReactPointerEvent<HTMLCanvasElement>): { readonly x: number; readonly y: number } | undefined => {
    return normalizedBrowserCanvasPoint(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY);
  };
  const pointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const point = pointerPoint(event);
    if (point === undefined) return;
    if (commentMode) {
      if (event.button !== 0 || commentTarget !== undefined) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      commentStartRef.current = {
        pointerId: event.pointerId,
        x: point.x,
        y: point.y,
        region: event.shiftKey,
        immediate: event.ctrlKey || event.metaKey
      };
      setCommentDrag({ startX: point.x, startY: point.y, endX: point.x, endY: point.y });
      return;
    }
    if (!enabled || busy || ![0, 1, 2].includes(event.button)) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerStartRef.current = {
      pointerId: event.pointerId,
      x: point.x,
      y: point.y,
      button: event.button === 1 ? "middle" : event.button === 2 ? "secondary" : "primary",
      clickCount: event.detail >= 2 ? 2 : 1
    };
  };
  const pointerUp = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const commentStart = commentStartRef.current;
    commentStartRef.current = undefined;
    if (commentStart !== undefined && commentStart.pointerId === event.pointerId && commentMode) {
      const point = pointerPoint(event);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      setCommentDrag(undefined);
      if (point === undefined) return;
      event.preventDefault();
      onCommentTarget(browserCommentTargetFromCanvas(event.currentTarget, commentStart, point), commentStart.immediate || event.ctrlKey || event.metaKey);
      return;
    }
    const start = pointerStartRef.current;
    pointerStartRef.current = undefined;
    if (start === undefined || start.pointerId !== event.pointerId || !enabled) return;
    const point = pointerPoint(event);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (point === undefined) return;
    event.preventDefault();
    const moved = Math.hypot(point.x - start.x, point.y - start.y) >= 0.01;
    perform(moved
      ? { kind: "mouseDrag", startNormalizedX: start.x, startNormalizedY: start.y, endNormalizedX: point.x, endNormalizedY: point.y, button: start.button }
      : { kind: "mouseClick", normalizedX: point.x, normalizedY: point.y, button: start.button, clickCount: start.clickCount });
  };
  const pointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const commentStart = commentStartRef.current;
    if (commentStart !== undefined && commentStart.pointerId === event.pointerId && commentMode) {
      const point = pointerPoint(event);
      if (point !== undefined) setCommentDrag({ startX: commentStart.x, startY: commentStart.y, endX: point.x, endY: point.y });
      return;
    }
    if (!enabled || pointerStartRef.current !== undefined) return;
    const point = normalizedBrowserCanvasPoint(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY);
    if (point === undefined) return;
    pendingHoverRef.current = point;
    if (hoverTimerRef.current !== undefined) return;
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = undefined;
      const pending = pendingHoverRef.current;
      pendingHoverRef.current = undefined;
      if (pending !== undefined) perform({ kind: "mouseMove", normalizedX: pending.x, normalizedY: pending.y });
    }, 100);
  };
  const wheel = (event: ReactWheelEvent<HTMLCanvasElement>): void => {
    if ((!enabled && !commentMode) || busy) return;
    const deltaXCssPixels = clampBrowserScrollDelta(event.deltaX);
    const deltaYCssPixels = clampBrowserScrollDelta(event.deltaY);
    if (deltaXCssPixels === 0 && deltaYCssPixels === 0) return;
    event.preventDefault();
    perform({ kind: "scroll", deltaXCssPixels, deltaYCssPixels }, true);
  };
  const keyDown = (event: ReactKeyboardEvent<HTMLCanvasElement>): void => {
    if (commentMode && event.key === "Escape") {
      event.preventDefault();
      onCommentExit();
      return;
    }
    const key = browserTakeoverKey(event.key);
    if (!enabled || busy || key === undefined) return;
    event.preventDefault();
    const modifiers = browserTakeoverModifiers(event);
    perform({ kind: "keyPress", key: browserKeyView(key), ...(modifiers.length === 0 ? {} : { modifiers }) });
  };
  const submitText = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const text = textInput.slice(0, 4_096);
    if (!enabled || busy || text.length === 0) return;
    perform({ kind: "textInput", text });
    setTextInput("");
  };
  if (failed) return <div className="browser-canvas__empty" role="alert"><p>{t("browser.screenshotUnavailable")}</p></div>;
  const hasProjectedPending = commentPlacements.some((placement) => placement.pending);
  return <section className={cx("remote-browser", enabled && "is-enabled", commentMode && "is-commenting", busy && "is-busy")} aria-label={commentMode ? t("browser.commentModeTitle") : t("browser.remoteControl")} aria-busy={busy}>
    <div className="remote-browser__viewport">{source === undefined && <span role="status">{t("browser.loadingScreenshot")}</span>}<div className="remote-browser__stage"><canvas ref={canvasRef} tabIndex={enabled || commentMode ? 0 : -1} role="img" aria-label={`${t("browser.remoteCanvas")}: ${page.title}`} aria-disabled={!enabled && !commentMode} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={(event) => { pointerStartRef.current = undefined; commentStartRef.current = undefined; setCommentDrag(undefined); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onContextMenu={(event) => { if (enabled || commentMode) event.preventDefault(); }} onWheel={wheel} onKeyDown={keyDown} />
      {commentDrag !== undefined && <span className="remote-browser__annotation-region is-draft" style={normalizedAnnotationRegionStyle(commentDrag)} />}
      {commentPlacements.map((placement) => <Fragment key={`${placement.markerNumber}:${placement.pending ? "pending" : "committed"}`}>
        {placement.pending && placement.region !== undefined && <span className="remote-browser__annotation-region" style={browserCommentPlacementRegionStyle(placement.region, placement.viewport)} />}
        {placement.pending && placement.textRegions?.map((region, index) => <span key={index} className="remote-browser__annotation-region is-text" style={browserCommentPlacementRegionStyle(region, placement.viewport)} />)}
        <span className="remote-browser__annotation-marker" style={browserCommentPlacementMarkerStyle(placement)}>{placement.markerNumber}</span>
      </Fragment>)}
      {!hasProjectedPending && commentTarget?.kind === "region" && <span className="remote-browser__annotation-region" style={browserCommentRegionStyle(commentTarget)} />}
      {!hasProjectedPending && commentTarget?.kind === "text" && commentTarget.textRegions?.map((region, index) => <span key={index} className="remote-browser__annotation-region is-text" style={browserCommentTextRegionStyle(commentTarget, region)} />)}
      {!hasProjectedPending && commentTarget !== undefined && commentMarker !== undefined && <span className="remote-browser__annotation-marker" style={browserCommentMarkerStyle(commentTarget)}>{commentMarker}</span>}
      {overlay}</div></div>
    <div className="remote-browser__controls" aria-disabled={!enabled}>
      <div className="remote-browser__scroll" aria-label={t("browser.scrollControls")}><Button disabled={!enabled || busy} onClick={() => perform({ kind: "scroll", deltaXCssPixels: 0, deltaYCssPixels: -640 })}>↑</Button><Button disabled={!enabled || busy} onClick={() => perform({ kind: "scroll", deltaXCssPixels: 0, deltaYCssPixels: 640 })}>↓</Button><Button disabled={!enabled || busy} onClick={() => perform({ kind: "scroll", deltaXCssPixels: -640, deltaYCssPixels: 0 })}>←</Button><Button disabled={!enabled || busy} onClick={() => perform({ kind: "scroll", deltaXCssPixels: 640, deltaYCssPixels: 0 })}>→</Button></div>
      <form onSubmit={submitText}><label><span>{t("browser.textInput")}</span><input value={textInput} maxLength={4_096} disabled={!enabled || busy} onChange={(event) => setTextInput(event.target.value.slice(0, 4_096))} /></label><Button tone="primary" disabled={!enabled || busy || textInput.length === 0} type="submit">{t("browser.sendText")}</Button></form>
    </div>
    <span className="sr-only" aria-live="polite">{busy ? t("browser.remoteActionBusy") : enabled ? t("browser.remoteActionReady") : t("browser.remoteControlUnavailable")}</span>
  </section>;
}

function BrowserLedger({ controller, browser, page, locale, t, runAction }: { readonly controller: AppController; readonly browser: BrowserView; readonly page: BrowserPageView; readonly locale: string; readonly t: Translator; readonly runAction: RunAction }): JSX.Element {
  const [activity, setActivity] = useState<readonly BrowserActivityView[]>([]);
  const [transfers, setTransfers] = useState<readonly BrowserTransferView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const load = useCallback(async () => {
    setError(undefined);
    try {
      const [nextActivity, nextTransfers] = await Promise.all([
        controllerRef.current.listBrowserActivity(browser.id, page.id),
        controllerRef.current.listBrowserTransfers(browser.id, page.id)
      ]);
      setActivity(nextActivity);
      setTransfers(nextTransfers);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("browser.ledgerFailed"));
    } finally {
      setLoading(false);
    }
  }, [browser.id, page.id, t]);
  useEffect(() => {
    setLoading(true);
    void load();
    const timer = window.setInterval(() => void load(), 4_000);
    return () => window.clearInterval(timer);
  }, [load]);
  return <section className="browser-ledger" aria-label={t("browser.durableActivity")}>
    <header><div><h3>{t("browser.durableActivity")}</h3><p>{t("browser.durableActivityBody")}</p></div><Button tone="ghost" disabled={loading} onClick={() => { setLoading(true); void load(); }}><RefreshCcw className={loading ? "spin" : undefined} aria-hidden="true" />{t("common.refresh")}</Button></header>
    {error !== undefined && <p className="browser-ledger__error" role="alert"><AlertTriangle aria-hidden="true" />{error}</p>}
    <div className="browser-ledger__columns">
      <section><h4>{t("browser.transfers")}</h4>{transfers.length === 0 ? <p className="muted">{loading ? t("common.loading") : t("browser.noTransfers")}</p> : <div className="browser-ledger__list">{transfers.map((transfer) => <article key={transfer.id}><span className="browser-ledger__icon">{transfer.direction === "upload" ? <Upload aria-hidden="true" /> : <Download aria-hidden="true" />}</span><span><strong>{transfer.fileName}</strong><small>{t(`browser.direction.${transfer.direction}`)} · {formatBytes(transfer.byteSize)} · {formatRelativeTime(transfer.completedAt ?? transfer.startedAt, locale)}</small>{transfer.error !== undefined && <small className="danger-text">{transfer.error}</small>}</span><Pill tone={transfer.state === "completed" ? "success" : transfer.state === "failed" ? "danger" : transfer.state === "running" ? "accent" : "neutral"}>{transfer.state}</Pill>{transfer.direction === "download" && transfer.state === "completed" && transfer.blobId !== undefined && <Button tone="ghost" onClick={() => runAction(`browser-download:${transfer.id}`, () => controller.downloadArtifact(transfer.blobId as string, transfer.fileName))}>{t("common.download")}</Button>}</article>)}</div>}</section>
      <section><h4>{t("browser.activityLog")}</h4>{activity.length === 0 ? <p className="muted">{loading ? t("common.loading") : t("browser.noDurableActivity")}</p> : <div className="browser-ledger__list">{activity.map((item) => <article key={item.id}><span className="browser-ledger__icon"><Globe2 aria-hidden="true" /></span><span><strong>{t(`browser.activity.${item.kind}`)}</strong><small>{item.description || formatRelativeTime(item.occurredAt, locale)}</small>{item.description && <small>{formatRelativeTime(item.occurredAt, locale)}</small>}</span></article>)}</div>}</section>
    </div>
  </section>;
}

function ResourcesTools({ controller, resources, t, runAction, onRemove }: { readonly controller: AppController; readonly resources: readonly ResourceView[]; readonly t: Translator; readonly runAction: RunAction; readonly onRemove: (resource: ResourceView) => void }): JSX.Element {
  if (resources.length === 0) return <EmptyState icon={<Braces />} title={t("tools.noResources")} body={t("tools.noResourcesBody")} />;
  return <div className="resource-grid">{resources.map((resource) => <article className={cx("resource-card", resource.state === "error" && "resource-card--error")} key={resource.id}><header><span className="resource-card__icon">{resource.kind === "package" ? <PackageCheck /> : <Braces />}</span><div><h2>{resource.name}</h2><p>{resource.kind} · {resource.scope}</p></div><Pill tone={resource.state === "loaded" ? "success" : resource.state === "error" ? "danger" : resource.state === "awaitingApproval" || resource.requiresExtensionApproval ? "warning" : "neutral"}>{resource.state}</Pill></header><dl><div><dt>{t("common.source")}</dt><dd>{resource.source}</dd></div><div><dt>{t("common.runtime")}</dt><dd>{resource.state === "loaded" ? t("tools.reportedRuntime") : t("tools.notLoaded")}</dd></div></dl>{resource.error !== undefined && <p className="resource-card__error"><AlertTriangle aria-hidden="true" />{resource.error}</p>}<footer>{(["discovered", "awaitingApproval"].includes(resource.state) || resource.requiresExtensionApproval) && <Button tone="primary" onClick={() => runAction(`approve-resource:${resource.id}`, () => controller.approveResource(resource.id))}><ShieldCheck aria-hidden="true" />{t("resource.approve")}</Button>}{resource.state === "approved" && resource.scope !== "project" && <Button onClick={() => runAction(`install-resource:${resource.id}`, async () => { await controller.installResource(resource.id); })}>{t("common.install")}</Button>}{resource.state === "updateAvailable" && <Button onClick={() => runAction(`update-resource:${resource.id}`, async () => { await controller.updateResource(resource.id); })}>{t("common.update")}</Button>}{resourceCanToggle(resource) && <Button onClick={() => runAction(`toggle-resource:${resource.id}`, () => controller.setResourceEnabled(resource.id, !resource.enabled))}>{resource.enabled ? t("common.disable") : t("common.enable")}</Button>}<Button tone="ghost" className="danger-text" onClick={() => onRemove(resource)}><Trash2 aria-hidden="true" />{t("common.remove")}</Button></footer></article>)}</div>;
}

function resourceCanToggle(resource: ResourceView): boolean {
  if (!resource.canToggle || resource.requiresExtensionApproval) return false;
  if (resource.scope === "project") return ["approved", "disabled", "loaded"].includes(resource.state);
  return ["installed", "disabled", "loaded"].includes(resource.state);
}

function McpTools({ controller, backends, servers, t, runAction }: { readonly controller: AppController; readonly backends: AppSnapshot["backends"]; readonly servers: readonly McpServerView[]; readonly t: Translator; readonly runAction: RunAction }): JSX.Element {
  if (backends.length === 0 && servers.length === 0) return <EmptyState icon={<Boxes />} title={t("tools.mcpUnavailable")} body={t("tools.mcpUnavailableBody")} />;
  return <div className="mcp-overview"><section className="security-callout"><ShieldCheck aria-hidden="true" /><div><h2>{t("tools.secretRouting")}</h2><p>{t("tools.secretRoutingBody")}</p></div></section>{servers.length === 0 ? <p className="muted">{t("settings.noMcp")}</p> : <div className="settings-list">{servers.map((server) => <article key={server.id}><div><StatusDot state={server.state} label={server.state} /><span><strong>{server.name}</strong><small>{server.transport} · {server.endpoint || t("settings.managedLoopback")} · {t("settings.toolsGeneration", { tools: server.toolCount, generation: server.generation.toString() })}</small>{server.error !== undefined && <small className="danger-text">{server.error}</small>}</span></div><div><Pill tone={mcpServerTone(server.state)}>{server.state}</Pill><Button onClick={() => runAction(`restart-mcp:${server.id}`, () => controller.restartMcpServer(server.id))}><RefreshCcw aria-hidden="true" />{t("common.restart")}</Button></div></article>)}</div>}<h3 className="settings-subheading">{t("tools.mcpRuntimeBackends")}</h3>{backends.length === 0 ? <p className="muted">{t("tools.mcpUnavailableBody")}</p> : <div className="settings-list">{backends.map((backend) => <article key={backend.id}><div><StatusDot state={backend.health} label={backend.health} /><span><strong>{backend.name}</strong><small>tool.mcp · v{backend.version}</small></span></div><Pill tone={backend.health === "healthy" ? "success" : "warning"}>{backend.health}</Pill></article>)}</div>}<p className="muted">{t("tools.mcpGenerationHelp")}</p></div>;
}

export function mcpServerTone(state: McpServerView["state"]): "success" | "danger" | "warning" | "neutral" {
  if (state === "connected") return "success";
  if (state === "error") return "danger";
  if (state === "disabled") return "neutral";
  return "warning";
}

function ActivityTools({ activity, locale, t }: { readonly activity: readonly TimelineItemView[]; readonly locale: string; readonly t: Translator }): JSX.Element {
  if (activity.length === 0) return <EmptyState icon={<Wrench />} title={t("tools.noActivity")} body={t("tools.noActivityBody")} />;
  return <div className="activity-table" role="table" aria-label={t("tools.activity")}><div className="activity-table__head" role="row"><span>{t("timeline.tool")}</span><span>{t("common.input")}</span><span>{t("common.state")}</span><span>{t("common.time")}</span></div>{activity.map((item) => <div role="row" key={item.id}><span><Wrench aria-hidden="true" /><strong>{item.tool?.name}</strong></span><span>{item.tool?.input}</span><span><Pill tone={item.tool?.state === "failed" ? "danger" : item.tool?.state === "succeeded" ? "success" : "neutral"}>{item.tool?.state}</Pill></span><span>{formatRelativeTime(item.createdAt, locale)}</span></div>)}</div>;
}

export function normalizedBrowserCanvasPoint(rect: { readonly left: number; readonly top: number; readonly width: number; readonly height: number }, clientX: number, clientY: number): { readonly x: number; readonly y: number } | undefined {
  if (![rect.left, rect.top, rect.width, rect.height, clientX, clientY].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return undefined;
  return {
    x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
  };
}

export function browserCommentTargetFromCanvas(
  canvas: { readonly width: number; readonly height: number },
  start: { readonly x: number; readonly y: number; readonly region: boolean },
  end: { readonly x: number; readonly y: number }
): BrowserCommentTargetView {
  const viewport = { width: Math.max(1, canvas.width), height: Math.max(1, canvas.height) };
  const point = { x: end.x * viewport.width, y: end.y * viewport.height };
  const moved = Math.hypot(end.x - start.x, end.y - start.y) >= 0.01;
  if (!start.region || !moved) return { kind: "element", point, viewport };
  const left = Math.min(start.x, end.x) * viewport.width;
  const top = Math.min(start.y, end.y) * viewport.height;
  return {
    kind: "region",
    point,
    viewport,
    region: {
      x: left,
      y: top,
      width: Math.abs(end.x - start.x) * viewport.width,
      height: Math.abs(end.y - start.y) * viewport.height
    }
  };
}

function drawBrowserCommentAnnotation(context: CanvasRenderingContext2D, placement: BrowserCommentPlacementView, scale: number): void {
  const markerRadius = 11 * scale;
  context.save();
  context.strokeStyle = "#3b82f6";
  context.fillStyle = "rgba(59, 130, 246, 0.08)";
  context.lineWidth = 2 * scale;
  if (placement.pending && placement.region !== undefined) {
    context.fillRect(placement.region.x, placement.region.y, placement.region.width, placement.region.height);
    context.strokeRect(placement.region.x, placement.region.y, placement.region.width, placement.region.height);
  } else if (placement.pending && placement.textRegions !== undefined) {
    context.fillStyle = "rgba(59, 130, 246, 0.28)";
    for (const region of placement.textRegions) {
      context.fillRect(region.x, region.y, region.width, region.height);
    }
  }
  const x = placement.point.x;
  const y = placement.point.y;
  context.shadowColor = "rgba(0, 0, 0, 0.35)";
  context.shadowBlur = 4 * scale;
  context.shadowOffsetY = 1 * scale;
  context.beginPath();
  context.arc(x, y, markerRadius + 2 * scale, 0, Math.PI * 2);
  context.fillStyle = "#ffffff";
  context.fill();
  context.shadowColor = "transparent";
  context.beginPath();
  context.arc(x, y, markerRadius, 0, Math.PI * 2);
  context.fillStyle = "#3b82f6";
  context.fill();
  context.fillStyle = "#ffffff";
  context.font = `600 ${12 * scale}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(String(placement.markerNumber), x, y);
  context.restore();
}

async function annotateBrowserScreenshotUrl(
  url: string,
  placements: readonly BrowserCommentPlacementView[]
): Promise<File> {
  const image = await loadBrowserScreenshotImage(url);
  const output = document.createElement("canvas");
  output.width = Math.max(1, image.naturalWidth);
  output.height = Math.max(1, image.naturalHeight);
  const context = output.getContext("2d");
  if (context === null) throw new Error("The Browser annotation canvas is unavailable.");
  context.drawImage(image, 0, 0, output.width, output.height);
  for (const placement of placements) {
    const scaleX = output.width / placement.viewport.width;
    const scaleY = output.height / placement.viewport.height;
    const scaledPlacement = scaleBrowserCommentPlacement(placement, output.width, output.height);
    drawBrowserCommentAnnotation(context, scaledPlacement, Math.min(scaleX, scaleY));
  }
  const markerNumber = placements.find((placement) => placement.pending)?.markerNumber ?? placements.at(-1)?.markerNumber ?? 1;
  return new File([await canvasPngBlob(output)], `browser-comment-${markerNumber}.png`, { type: "image/png", lastModified: Date.now() });
}

export function scaleBrowserCommentPlacement(
  placement: BrowserCommentPlacementView,
  width: number,
  height: number
): BrowserCommentPlacementView {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const scaleX = safeWidth / placement.viewport.width;
  const scaleY = safeHeight / placement.viewport.height;
  return {
    ...placement,
    point: { x: placement.point.x * scaleX, y: placement.point.y * scaleY },
    viewport: { width: safeWidth, height: safeHeight },
    ...(placement.region === undefined ? {} : { region: {
      x: placement.region.x * scaleX,
      y: placement.region.y * scaleY,
      width: placement.region.width * scaleX,
      height: placement.region.height * scaleY
    } }),
    ...(placement.textRegions === undefined ? {} : { textRegions: placement.textRegions.map((region) => ({
      x: region.x * scaleX,
      y: region.y * scaleY,
      width: region.width * scaleX,
      height: region.height * scaleY
    })) })
  };
}

function loadBrowserScreenshotImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The Browser screenshot could not be decoded."));
    image.src = url;
  });
}

function canvasPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => {
    if (blob === null) reject(new Error("The Browser annotation could not be encoded."));
    else resolve(blob);
  }, "image/png"));
}

function normalizedAnnotationRegionStyle(region: { readonly startX: number; readonly startY: number; readonly endX: number; readonly endY: number }) {
  return {
    left: `${Math.min(region.startX, region.endX) * 100}%`,
    top: `${Math.min(region.startY, region.endY) * 100}%`,
    width: `${Math.abs(region.endX - region.startX) * 100}%`,
    height: `${Math.abs(region.endY - region.startY) * 100}%`
  };
}

function browserCommentRegionStyle(target: Extract<BrowserCommentTargetView, { readonly kind: "region" }>) {
  return {
    left: `${target.region.x / target.viewport.width * 100}%`,
    top: `${target.region.y / target.viewport.height * 100}%`,
    width: `${target.region.width / target.viewport.width * 100}%`,
    height: `${target.region.height / target.viewport.height * 100}%`
  };
}

function browserCommentTextRegionStyle(
  target: Extract<BrowserCommentTargetView, { readonly kind: "text" }>,
  region: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
) {
  return {
    left: `${region.x / target.viewport.width * 100}%`,
    top: `${region.y / target.viewport.height * 100}%`,
    width: `${region.width / target.viewport.width * 100}%`,
    height: `${region.height / target.viewport.height * 100}%`
  };
}

function browserCommentMarkerStyle(target: BrowserCommentTargetView) {
  return {
    left: `${target.point.x / target.viewport.width * 100}%`,
    top: `${target.point.y / target.viewport.height * 100}%`
  };
}

function browserCommentPlacementRegionStyle(
  region: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number }
) {
  return {
    left: `${region.x / viewport.width * 100}%`,
    top: `${region.y / viewport.height * 100}%`,
    width: `${region.width / viewport.width * 100}%`,
    height: `${region.height / viewport.height * 100}%`
  };
}

function browserCommentPlacementMarkerStyle(placement: BrowserCommentPlacementView) {
  return {
    left: `${placement.point.x / placement.viewport.width * 100}%`,
    top: `${placement.point.y / placement.viewport.height * 100}%`
  };
}

type BrowserNamedKeyView = "enter" | "tab" | "escape" | "backspace" | "delete" | "arrowUp" | "arrowDown" | "arrowLeft" | "arrowRight" | "home" | "end" | "pageUp" | "pageDown" | "space";
type LowercaseLetterOrDigit = Exclude<BrowserTakeoverKeyView, BrowserNamedKeyView>;
type BrowserDomKey = "Enter" | "Tab" | "Escape" | "Backspace" | "Delete" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End" | "PageUp" | "PageDown" | "Space" | LowercaseLetterOrDigit;

export function browserTakeoverKey(key: string, modifiers: { readonly ctrlKey?: boolean; readonly metaKey?: boolean; readonly altKey?: boolean; readonly shiftKey?: boolean } = {}): BrowserDomKey | undefined {
  void modifiers;
  if (key === " ") return "Space";
  if (/^[a-z0-9]$/iu.test(key)) return key.toLowerCase() as LowercaseLetterOrDigit;
  return ["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(key) ? key as BrowserDomKey : undefined;
}

export function browserTakeoverModifiers(modifiers: { readonly ctrlKey?: boolean; readonly metaKey?: boolean; readonly altKey?: boolean; readonly shiftKey?: boolean }): readonly BrowserTakeoverKeyModifierView[] {
  const result: BrowserTakeoverKeyModifierView[] = [];
  if (modifiers.altKey === true) result.push("alt");
  if (modifiers.ctrlKey === true) result.push("control");
  if (modifiers.metaKey === true) result.push("meta");
  if (modifiers.shiftKey === true) result.push("shift");
  return result;
}

export function clampBrowserScrollDelta(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-10_000, Math.min(10_000, Math.trunc(value)));
}

function browserKeyView(key: BrowserDomKey): BrowserTakeoverKeyView {
  return ({
    Enter: "enter",
    Tab: "tab",
    Escape: "escape",
    Backspace: "backspace",
    Delete: "delete",
    ArrowUp: "arrowUp",
    ArrowDown: "arrowDown",
    ArrowLeft: "arrowLeft",
    ArrowRight: "arrowRight",
    Home: "home",
    End: "end",
    PageUp: "pageUp",
    PageDown: "pageDown",
    Space: "space"
  } as const)[key as Exclude<BrowserDomKey, LowercaseLetterOrDigit>] ?? key as BrowserTakeoverKeyView;
}

function safeExternalUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  if (value < 1_073_741_824) return `${(value / 1_048_576).toFixed(1)} MiB`;
  return `${(value / 1_073_741_824).toFixed(1)} GiB`;
}
