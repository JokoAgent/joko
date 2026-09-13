import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  JSX,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode
} from "react";
import { Columns2, Focus, GripVertical, PanelBottomClose, Rows2, X } from "lucide-react";
import type { SessionView } from "../model.js";
import {
  resizeSessionSplit,
  sessionSplitPanes,
  setRootSessionSplitAxis,
  type SessionSplitBranch,
  type SessionSplitLayout,
  type SessionSplitNode,
  type SessionSplitSide
} from "../session-split-layout.js";
import type { Translator } from "./types.js";
import { IconButton, cx } from "./ui.js";
import { moveTablistSelection } from "./tablist-navigation.js";

export const SESSION_SPLIT_DRAG_TYPE = "application/x-joko-session";
export const SESSION_SPLIT_MINIMUM_WIDTH = 280;
export const SESSION_SPLIT_MINIMUM_HEIGHT = 220;
const SESSION_SPLIT_GUTTER_SIZE = 6;

export interface SessionSplitViewProps {
  readonly layout: SessionSplitLayout;
  readonly currentSessionId: string;
  readonly focusedSessionId: string;
  readonly sessions: readonly SessionView[];
  readonly t: Translator;
  readonly renderPane: (sessionId: string) => ReactNode;
  readonly onLayoutChange: (layout: SessionSplitLayout) => void;
  readonly onFocus: (sessionId: string) => void;
  readonly onPreviewFocus?: (sessionId: string) => void;
  readonly onClose: (sessionId: string) => void;
  readonly onDropSession: (sessionId: string, anchorSessionId: string, side: SessionSplitSide) => void;
}

export function SessionSplitView(props: SessionSplitViewProps): JSX.Element {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const panes = sessionSplitPanes(props.layout.root);
  const sessionNames = useMemo(() => new Map(props.sessions.map((session) => [session.id, session.name])), [props.sessions]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (surface === null) return;
    const minimum = sessionSplitMinimumSize(props.layout.root);
    const update = (): void => setCompact(
      surface.clientWidth < minimum.width || surface.clientHeight < minimum.height
    );
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [props.layout.root]);

  const compactSessionId = panes.some((pane) => pane.sessionId === props.focusedSessionId)
    ? props.focusedSessionId
    : panes[0]?.sessionId ?? props.currentSessionId;
  const content = props.layout.root === undefined
    ? <SessionSplitLeaf
        sessionId={props.currentSessionId}
        name={sessionNames.get(props.currentSessionId) ?? props.t("session.unnamed")}
        active
        only
        t={props.t}
        onFocus={props.onFocus}
        onPreviewFocus={props.onPreviewFocus}
        onClose={props.onClose}
        onDropSession={props.onDropSession}
      >{props.renderPane(props.currentSessionId)}</SessionSplitLeaf>
    : compact
      ? <div className="session-split-compact">
          <div className="session-split-compact__tabs" role="tablist" aria-label={props.t("split.tasks")} aria-orientation="horizontal">
            {panes.map((pane) => <button
              key={pane.key}
              type="button"
              role="tab"
              aria-selected={pane.sessionId === compactSessionId}
              tabIndex={pane.sessionId === compactSessionId ? 0 : -1}
              className={cx(pane.sessionId === compactSessionId && "is-active")}
              onClick={() => props.onFocus(pane.sessionId)}
              onKeyDown={(event) => moveTablistSelection(event, "horizontal")}
            >{sessionNames.get(pane.sessionId) ?? props.t("session.unnamed")}</button>)}
          </div>
          <SessionSplitLeaf
            sessionId={compactSessionId}
            name={sessionNames.get(compactSessionId) ?? props.t("session.unnamed")}
            active
            only={false}
            t={props.t}
            onFocus={props.onFocus}
            onPreviewFocus={props.onPreviewFocus}
            onClose={props.onClose}
            onDropSession={props.onDropSession}
          >{props.renderPane(compactSessionId)}</SessionSplitLeaf>
        </div>
      : <SessionSplitTree {...props} node={props.layout.root} sessionNames={sessionNames} />;

  return <div ref={surfaceRef} className={cx("session-split-view", compact && "is-compact")}>
    {props.layout.root?.kind === "split" && !compact && <div className="session-split-view__toolbar" role="toolbar" aria-label={props.t("split.layout")}>
      <IconButton
        className={cx(props.layout.root.axis === "row" && "is-active")}
        label={props.t("split.rootHorizontal")}
        onClick={() => props.onLayoutChange(setRootSessionSplitAxis(props.layout, "row"))}
      ><Columns2 aria-hidden="true" /></IconButton>
      <IconButton
        className={cx(props.layout.root.axis === "column" && "is-active")}
        label={props.t("split.rootVertical")}
        onClick={() => props.onLayoutChange(setRootSessionSplitAxis(props.layout, "column"))}
      ><Rows2 aria-hidden="true" /></IconButton>
    </div>}
    {content}
  </div>;
}

function SessionSplitTree(props: SessionSplitViewProps & {
  readonly node: SessionSplitNode;
  readonly sessionNames: ReadonlyMap<string, string>;
}): JSX.Element {
  if (props.node.kind === "pane") {
    return <SessionSplitLeaf
      sessionId={props.node.sessionId}
      name={props.sessionNames.get(props.node.sessionId) ?? props.t("session.unnamed")}
      active={props.node.sessionId === props.focusedSessionId}
      only={false}
      t={props.t}
      onFocus={props.onFocus}
      onPreviewFocus={props.onPreviewFocus}
      onClose={props.onClose}
      onDropSession={props.onDropSession}
    >{props.renderPane(props.node.sessionId)}</SessionSplitLeaf>;
  }
  return <SessionSplitBranchView
    branch={props.node}
    layout={props.layout}
    t={props.t}
    onLayoutChange={props.onLayoutChange}
  >
    <SessionSplitTree {...props} node={props.node.first} />
    <SessionSplitTree {...props} node={props.node.second} />
  </SessionSplitBranchView>;
}

function SessionSplitBranchView({ branch, layout, t, onLayoutChange, children }: {
  readonly branch: SessionSplitBranch;
  readonly layout: SessionSplitLayout;
  readonly t: Translator;
  readonly onLayoutChange: (layout: SessionSplitLayout) => void;
  readonly children: readonly [ReactNode, ReactNode];
}): JSX.Element {
  const branchRef = useRef<HTMLDivElement>(null);
  const [pointerId, setPointerId] = useState<number>();
  const applyPointer = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (pointerId !== event.pointerId) return;
    const bounds = branchRef.current?.getBoundingClientRect();
    if (bounds === undefined) return;
    const size = branch.axis === "row" ? bounds.width : bounds.height;
    if (size <= 0) return;
    const offset = branch.axis === "row" ? event.clientX - bounds.left : event.clientY - bounds.top;
    onLayoutChange(resizeSessionSplit(layout, branch.key, ratioWithPixelMinimum(
      offset / size,
      size,
      branch.axis,
      sessionSplitMinimumAlongAxis(branch.first, branch.axis),
      sessionSplitMinimumAlongAxis(branch.second, branch.axis)
    )));
  };
  const finish = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setPointerId(undefined);
  };
  const resizeByKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const direction = branch.axis === "row"
      ? event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0
      : event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    const next = event.key === "Home" ? 0.5 : direction === 0 ? undefined : branch.ratio + direction * (event.shiftKey ? 0.1 : 0.025);
    if (next === undefined) return;
    event.preventDefault();
    const size = branch.axis === "row" ? branchRef.current?.clientWidth ?? 0 : branchRef.current?.clientHeight ?? 0;
    onLayoutChange(resizeSessionSplit(layout, branch.key, ratioWithPixelMinimum(
      next,
      size,
      branch.axis,
      sessionSplitMinimumAlongAxis(branch.first, branch.axis),
      sessionSplitMinimumAlongAxis(branch.second, branch.axis)
    )));
  };
  return <div
    ref={branchRef}
    className={cx("session-split-branch", `is-${branch.axis}`, pointerId !== undefined && "is-resizing")}
    style={{ "--session-split-ratio": branch.ratio } as CSSProperties}
  >
    <div className="session-split-branch__first">{children[0]}</div>
    <div
      className="session-split-gutter"
      role="separator"
      aria-orientation={branch.axis === "row" ? "vertical" : "horizontal"}
      aria-label={t("split.resize")}
      aria-valuemin={10}
      aria-valuemax={90}
      aria-valuenow={Math.round(branch.ratio * 100)}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setPointerId(event.pointerId);
      }}
      onPointerMove={applyPointer}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={() => setPointerId(undefined)}
      onDoubleClick={() => onLayoutChange(resizeSessionSplit(layout, branch.key, 0.5))}
      onKeyDown={resizeByKey}
    ><GripVertical aria-hidden="true" /></div>
    <div className="session-split-branch__second">{children[1]}</div>
  </div>;
}

function SessionSplitLeaf({ sessionId, name, active, only, t, onFocus, onPreviewFocus, onClose, onDropSession, children }: {
  readonly sessionId: string;
  readonly name: string;
  readonly active: boolean;
  readonly only: boolean;
  readonly t: Translator;
  readonly onFocus: (sessionId: string) => void;
  readonly onPreviewFocus?: (sessionId: string) => void;
  readonly onClose: (sessionId: string) => void;
  readonly onDropSession: (sessionId: string, anchorSessionId: string, side: SessionSplitSide) => void;
  readonly children: ReactNode;
}): JSX.Element {
  const [dragActive, setDragActive] = useState(false);
  const drop = (event: ReactDragEvent<HTMLElement>, side: SessionSplitSide): void => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    const droppedSessionId = event.dataTransfer.getData(SESSION_SPLIT_DRAG_TYPE).trim();
    if (droppedSessionId !== "") onDropSession(droppedSessionId, sessionId, side);
  };
  return <section
    className={cx("session-split-pane", active && "is-focused", dragActive && "is-drag-target")}
    data-session-split-pane={sessionId}
    onPointerDown={() => onPreviewFocus?.(sessionId)}
    onDragEnter={(event) => {
      if (event.dataTransfer.types.includes(SESSION_SPLIT_DRAG_TYPE)) {
        event.preventDefault();
        setDragActive(true);
      }
    }}
    onDragOver={(event) => {
      if (!event.dataTransfer.types.includes(SESSION_SPLIT_DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }}
    onDragLeave={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
    }}
    onDrop={(event) => drop(event, "right")}
  >
    {!only && <header className="session-split-pane__header">
      <button type="button" className="session-split-pane__focus" onClick={() => onFocus(sessionId)} title={t("split.focusTask")}>
        <Focus aria-hidden="true" /><span>{name}</span>
      </button>
      <IconButton label={t("split.closePane", { name })} onClick={() => onClose(sessionId)}><X aria-hidden="true" /></IconButton>
    </header>}
    <div className="session-split-pane__body">{children}</div>
    {dragActive && <div className="session-split-drop-zones" aria-hidden="true">
      {(["left", "right", "top", "bottom"] as const).map((side) => <div
        key={side}
        className={`session-split-drop-zone is-${side}`}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => drop(event, side)}
      ><PanelBottomClose /></div>)}
    </div>}
  </section>;
}

export function ratioWithPixelMinimum(
  ratio: number,
  size: number,
  axis: "row" | "column",
  firstMinimumPixels = axis === "row" ? SESSION_SPLIT_MINIMUM_WIDTH : SESSION_SPLIT_MINIMUM_HEIGHT,
  secondMinimumPixels = axis === "row" ? SESSION_SPLIT_MINIMUM_WIDTH : SESSION_SPLIT_MINIMUM_HEIGHT
): number {
  if (!Number.isFinite(ratio)) return 0.5;
  if (size <= 0) return Math.max(0.1, Math.min(0.9, ratio));
  const usableSize = Math.max(1, size - SESSION_SPLIT_GUTTER_SIZE);
  const lower = Math.max(0.1, firstMinimumPixels / usableSize);
  const upper = Math.min(0.9, 1 - secondMinimumPixels / usableSize);
  if (lower > upper) {
    const totalMinimum = firstMinimumPixels + secondMinimumPixels;
    return totalMinimum <= 0 ? 0.5 : Math.max(0.1, Math.min(0.9, firstMinimumPixels / totalMinimum));
  }
  return Math.max(lower, Math.min(upper, ratio));
}

export function sessionSplitMinimumSize(node: SessionSplitNode | undefined): { readonly width: number; readonly height: number } {
  if (node === undefined || node.kind === "pane") {
    return { width: SESSION_SPLIT_MINIMUM_WIDTH, height: SESSION_SPLIT_MINIMUM_HEIGHT };
  }
  const first = sessionSplitMinimumSize(node.first);
  const second = sessionSplitMinimumSize(node.second);
  return node.axis === "row"
    ? {
        width: first.width + SESSION_SPLIT_GUTTER_SIZE + second.width,
        height: Math.max(first.height, second.height)
      }
    : {
        width: Math.max(first.width, second.width),
        height: first.height + SESSION_SPLIT_GUTTER_SIZE + second.height
      };
}

function sessionSplitMinimumAlongAxis(node: SessionSplitNode, axis: "row" | "column"): number {
  const minimum = sessionSplitMinimumSize(node);
  return axis === "row" ? minimum.width : minimum.height;
}
