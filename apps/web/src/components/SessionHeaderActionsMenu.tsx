import { useEffect, useId, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import {
  Archive,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Ellipsis,
  ExternalLink,
  FileOutput,
  FolderKanban,
  GitBranch,
  MessageSquare,
  PanelRight,
  Pencil,
  Pin,
  Rows2,
  Trash2,
  Undo2
} from "lucide-react";
import type { SessionView, TargetView } from "../model.js";
import type { SessionProjectNavigationPlacement } from "../session-project-navigation.js";
import type { Translator } from "./types.js";
import { TipSummary } from "./ui.js";
import { CodeHostPullRequestSummary } from "./CodeHostPullRequestSummary.js";

export interface SessionHeaderActionsMenuProps {
  readonly session: SessionView;
  readonly projectTargets: readonly TargetView[];
  readonly movingProject?: boolean;
  readonly t: Translator;
  readonly onRename: () => void;
  readonly onPin: () => void;
  readonly onArchive: () => void;
  readonly onDelete: () => void;
  readonly onMoveSessionProject?: (placement: SessionProjectNavigationPlacement) => void;
  readonly onCopyTaskLink?: () => void;
  readonly onExportPortableSession?: () => void;
  readonly onExportHtml?: () => void;
  readonly onClone?: () => void;
  readonly onSplitSession?: (side: "right" | "bottom") => void;
  readonly onOpenSessionWindow?: () => void;
  readonly onOpenCodeHostPullRequest?: (url: string) => void;
}

export function SessionHeaderActionsMenu({
  session,
  projectTargets,
  movingProject = false,
  t,
  onRename,
  onPin,
  onArchive,
  onDelete,
  onMoveSessionProject,
  onCopyTaskLink,
  onExportPortableSession,
  onExportHtml,
  onClone,
  onSplitSession,
  onOpenSessionWindow,
  onOpenCodeHostPullRequest
}: SessionHeaderActionsMenuProps): JSX.Element {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const menuId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const canMove = !session.archived && session.remoteWorkspace !== true && onMoveSessionProject !== undefined;

  const close = (): void => {
    detailsRef.current?.removeAttribute("open");
    setMenuOpen(false);
    setProjectMenuOpen(false);
  };
  const run = (action: () => void): void => {
    close();
    action();
  };
  const move = (placement: SessionProjectNavigationPlacement): void => {
    close();
    onMoveSessionProject?.(placement);
  };

  useEffect(() => {
    if (!menuOpen) return;
    const details = detailsRef.current;
    const ownerDocument = details?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (details === null || details === undefined || ownerDocument === undefined || ownerWindow === null || ownerWindow === undefined) return;
    const closeOutside = (event: globalThis.PointerEvent): void => {
      const node = event.target;
      if (node instanceof Node && details.contains(node)) return;
      close();
    };
    const closeForViewportChange = (): void => close();
    ownerDocument.addEventListener("pointerdown", closeOutside, true);
    ownerDocument.addEventListener("scroll", closeForViewportChange, true);
    ownerWindow.addEventListener("resize", closeForViewportChange);
    return () => {
      ownerDocument.removeEventListener("pointerdown", closeOutside, true);
      ownerDocument.removeEventListener("scroll", closeForViewportChange, true);
      ownerWindow.removeEventListener("resize", closeForViewportChange);
    };
  }, [menuOpen]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (projectMenuOpen) {
        setProjectMenuOpen(false);
      } else {
        close();
        detailsRef.current?.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
      }
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      close();
      detailsRef.current?.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
      return;
    }
    if (projectMenuOpen && event.key === "ArrowLeft") {
      event.preventDefault();
      setProjectMenuOpen(false);
      return;
    }
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not([disabled])")];
    const activeIndex = items.indexOf(event.currentTarget.ownerDocument.activeElement as HTMLButtonElement);
    const nextIndex = event.key === "ArrowDown"
      ? (activeIndex + 1 + items.length) % items.length
      : event.key === "ArrowUp"
        ? (activeIndex - 1 + items.length) % items.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : undefined;
    if (nextIndex === undefined || items.length === 0) return;
    event.preventDefault();
    items[nextIndex]?.focus({ preventScroll: true });
  };

  return <><CodeHostPullRequestSummary pullRequests={session.codeHostPullRequests} t={t} onOpen={onOpenCodeHostPullRequest} /><details
    ref={detailsRef}
    className="header-menu session-header-menu"
    onToggle={(event) => {
      setMenuOpen(event.currentTarget.open);
      if (!event.currentTarget.open) setProjectMenuOpen(false);
    }}
  >
    <TipSummary
      label={t("a11y.sessionActions", { name: session.name })}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      aria-controls={menuOpen ? menuId : undefined}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        const details = event.currentTarget.parentElement as HTMLDetailsElement | null;
        if (details !== null) details.open = true;
        event.currentTarget.ownerDocument.defaultView?.requestAnimationFrame(() => {
          const items = detailsRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not([disabled])");
          const item = event.key === "ArrowUp" ? items?.item((items?.length ?? 1) - 1) : items?.item(0);
          item?.focus({ preventScroll: true });
        });
      }}
    ><Ellipsis aria-hidden="true" /></TipSummary>
    <div
      id={menuId}
      className="menu-popover menu-popover--right session-header-menu__popover"
      role="menu"
      aria-label={projectMenuOpen ? t("session.moveToProject") : t("a11y.sessionActions", { name: session.name })}
      onKeyDown={onMenuKeyDown}
    >
      {projectMenuOpen ? <>
        <button type="button" role="menuitem" className="session-header-menu__back" onClick={() => setProjectMenuOpen(false)}>
          <ChevronLeft aria-hidden="true" />
          <span>{t("session.moveToProject")}</span>
        </button>
        <div className="menu-separator" role="separator" />
        <div className="session-header-menu__projects">
          {projectTargets.map((target) => <button
            key={target.id}
            type="button"
            role="menuitem"
            disabled={session.projectId === target.id || movingProject}
            aria-current={session.projectId === target.id ? "true" : undefined}
            onClick={() => move({ kind: "project", projectId: target.id })}
          >
            <FolderKanban aria-hidden="true" />
            <span>{target.name}</span>
            {session.projectId === target.id && <Check aria-hidden="true" />}
          </button>)}
          {projectTargets.length === 0 && <small className="session-project-menu__empty">{t("session.noProjectsAvailable")}</small>}
        </div>
        <div className="menu-separator" role="separator" />
        <button
          type="button"
          role="menuitem"
          disabled={session.projectId === undefined || movingProject}
          aria-current={session.projectId === undefined ? "true" : undefined}
          onClick={() => move({ kind: "dialogue" })}
        >
          <MessageSquare aria-hidden="true" />
          <span>{t("session.moveToDialogue")}</span>
          {session.projectId === undefined && <Check aria-hidden="true" />}
        </button>
      </> : <>
        {!session.archived && <button type="button" role="menuitem" onClick={() => run(onPin)}>
          <Pin aria-hidden="true" />
          {session.pinned ? t("session.unpin") : t("session.pin")}
        </button>}
        <button type="button" role="menuitem" onClick={() => run(onRename)}>
          <Pencil aria-hidden="true" />
          {t("session.rename")}
        </button>
        {canMove && <button
          type="button"
          role="menuitem"
          className="session-menu__submenu-trigger"
          disabled={movingProject}
          aria-haspopup="menu"
          aria-expanded="false"
          onClick={() => setProjectMenuOpen(true)}
        >
          <FolderKanban aria-hidden="true" />
          <span>{movingProject ? t("session.movingProject") : t("session.moveToProject")}</span>
          <ChevronRight aria-hidden="true" />
        </button>}
        <div className="menu-separator" role="separator" />
        {onCopyTaskLink !== undefined && <button type="button" role="menuitem" onClick={() => run(onCopyTaskLink)}>
          <Copy aria-hidden="true" />
          {t("session.copyTaskLink")}
        </button>}
        {onExportPortableSession !== undefined && <button type="button" role="menuitem" onClick={() => run(onExportPortableSession)}>
          <FileOutput aria-hidden="true" />
          {t("session.exportPortable")}
        </button>}
        {onExportHtml !== undefined && <button type="button" role="menuitem" onClick={() => run(onExportHtml)}>
          <Download aria-hidden="true" />
          {t("session.export")}
        </button>}
        {onClone !== undefined && <button type="button" role="menuitem" onClick={() => run(onClone)}>
          <GitBranch aria-hidden="true" />
          {t("session.clone")}
        </button>}
        {!session.archived && onSplitSession !== undefined && <>
          <button type="button" role="menuitem" onClick={() => run(() => onSplitSession("right"))}>
            <PanelRight aria-hidden="true" />
            {t("session.splitRight")}
          </button>
          <button type="button" role="menuitem" onClick={() => run(() => onSplitSession("bottom"))}>
            <Rows2 aria-hidden="true" />
            {t("session.splitDown")}
          </button>
        </>}
        {!session.archived && onOpenSessionWindow !== undefined && <button type="button" role="menuitem" onClick={() => run(onOpenSessionWindow)}>
          <ExternalLink aria-hidden="true" />
          {t("session.openNewWindow")}
        </button>}
        <div className="menu-separator" role="separator" />
        <button type="button" role="menuitem" onClick={() => run(onArchive)}>
          {session.archived ? <Undo2 aria-hidden="true" /> : <Archive aria-hidden="true" />}
          {session.archived ? t("session.unarchive") : t("session.archive")}
        </button>
        <button type="button" role="menuitem" className="danger-text" onClick={() => run(onDelete)}>
          <Trash2 aria-hidden="true" />
          {t("session.delete")}
        </button>
      </>}
    </div>
  </details></>;
}
