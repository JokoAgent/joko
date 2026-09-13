import { Plus, RotateCcw, X } from "lucide-react";
import { useEffect, useState, type JSX } from "react";

import type { AppController } from "../controller.js";
import { browserPageKey } from "../browser-page-key.js";
import type { BrowserPageView, BrowserView, SessionView } from "../model.js";
import type { RunAction, Translator } from "./types.js";
import { IconButton, StatusDot, SelectControl } from "./ui.js";

export interface BrowserPageSelection {
  readonly browserId: string;
  readonly pageId: string;
}

export function BrowserPageRail({ browser, selectedPageId, sessions, controller, t, runAction, onSelect }: {
  readonly browser: BrowserView;
  readonly selectedPageId?: string;
  readonly sessions: readonly SessionView[];
  readonly controller: AppController;
  readonly t: Translator;
  readonly runAction: RunAction;
  readonly onSelect: (selection: BrowserPageSelection | undefined) => void;
}): JSX.Element {
  const [sessionId, setSessionId] = useState<string | undefined>(sessions[0]?.id);
  useEffect(() => {
    if (sessionId !== undefined && sessions.some((session) => session.id === sessionId)) return;
    setSessionId(sessions[0]?.id);
  }, [sessionId, sessions]);

  const activeTakeover = browser.takeover?.state === "active" ? browser.takeover : undefined;
  const ownsTakeover = activeTakeover !== undefined
    && activeTakeover.connectionId === controller.state.activeProfile?.id
    && activeTakeover.generation === browser.generation;
  const controlledElsewhere = activeTakeover !== undefined && !ownsTakeover;

  const selectPage = (page: BrowserPageView): void => {
    onSelect({ browserId: browser.id, pageId: page.id });
    if (page.recoverable || controlledElsewhere) return;
    if (ownsTakeover) {
      if (activeTakeover.pageId === page.id) return;
      runAction(`browser-focus:${browserPageKey(browser.id, page.id)}`, async () => {
        const pageId = await controller.focusBrowserPage(browser.id, page.id);
        onSelect({ browserId: browser.id, pageId });
      });
      return;
    }
    runAction(`browser-takeover:${page.id}`, () => controller.beginBrowserTakeover(browser.id, page.id));
  };

  const createPage = (): void => {
    if (sessionId === undefined || controlledElsewhere) return;
    runAction(`browser-open:${browser.id}`, async () => {
      const pageId = await controller.openBrowserPage(browser.id, sessionId, "about:blank");
      onSelect({ browserId: browser.id, pageId });
    });
  };

  const restorePage = (page: BrowserPageView): void => {
    if (sessionId === undefined || controlledElsewhere) return;
    runAction(`browser-restore:${browserPageKey(browser.id, page.id)}`, async () => {
      const pageId = await controller.recoverBrowserPage(browser.id, sessionId, page.id, page.url);
      onSelect({ browserId: browser.id, pageId });
    });
  };

  const closePage = (page: BrowserPageView): void => {
    if (!ownsTakeover || page.recoverable) return;
    runAction(`browser-close:${browserPageKey(browser.id, page.id)}`, async () => {
      const pageId = await controller.closeBrowserPage(browser.id, page.id);
      onSelect(pageId === undefined ? undefined : { browserId: browser.id, pageId });
    });
  };

  return <div className="browser-page-rail">
    <div className="browser-page-rail__header">
      <h3>{t("browser.pages")}</h3>
      <IconButton
        label={sessions.length === 0 ? t("browser.pageSessionRequired") : controlledElsewhere ? t("browser.pageControlledElsewhere") : t("browser.addPage")}
        disabled={sessions.length === 0 || controlledElsewhere}
        onClick={createPage}
      ><Plus aria-hidden="true" /></IconButton>
    </div>
    {sessions.length > 1 && <SelectControl aria-label={t("browser.pageSession")} value={sessionId ?? ""} onChange={(event) => setSessionId(event.currentTarget.value)}>
      {sessions.map((session) => <option key={session.id} value={session.id}>{session.name}</option>)}
    </SelectControl>}
    {sessions.length === 0 && <small className="browser-page-rail__hint">{t("browser.pageSessionRequired")}</small>}
    {browser.pages.length === 0 ? <p>{t("browser.noPages")}</p> : <div className="browser-page-rail__list">{browser.pages.map((page) => <div className="browser-page-rail__item" key={page.id}>
      <button
        type="button"
        className={selectedPageId === page.id ? "is-active" : ""}
        title={controlledElsewhere && !page.recoverable ? t("browser.pageControlledElsewhere") : page.url}
        onClick={() => selectPage(page)}
      >
        <StatusDot state={page.recoverable ? "disconnected" : page.state} label={page.recoverable ? t("browser.pageLost") : page.state} />
        <span><strong>{page.title || t("browser.untitled")}</strong><small>{page.recoverable ? t("browser.pageLostGeneration", { generation: page.lastKnownGeneration.toString() }) : hostOf(page.url)}</small></span>
      </button>
      {page.recoverable
        ? <IconButton label={sessions.length === 0 ? t("browser.pageSessionRequired") : t("browser.restorePage")} disabled={sessions.length === 0 || controlledElsewhere} onClick={() => restorePage(page)}><RotateCcw aria-hidden="true" /></IconButton>
        : <IconButton label={ownsTakeover ? t("browser.closePage") : t("browser.takeoverRequiredForChrome")} disabled={!ownsTakeover} onClick={() => closePage(page)}><X aria-hidden="true" /></IconButton>}
    </div>)}</div>}
  </div>;
}

export function BrowserLostPageCard({ page, t }: { readonly page: BrowserPageView; readonly t: Translator }): JSX.Element {
  return <section className="browser-lost-page" role="status">
    <RotateCcw aria-hidden="true" />
    <div><h3>{t("browser.pageLost")}</h3><p>{t("browser.pageLostGeneration", { generation: page.lastKnownGeneration.toString() })}</p><small>{page.url}</small></div>
  </section>;
}

function hostOf(url: string): string {
  try { return new URL(url).host || url; } catch { return url; }
}
