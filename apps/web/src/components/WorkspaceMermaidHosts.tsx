import { Check, Copy, Minus, Plus, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";

import {
  WORKSPACE_MERMAID_EDIT_EVENT,
  WORKSPACE_MERMAID_OPEN_EVENT,
  copyWorkspaceMermaid,
  type WorkspaceMermaidEditDetail,
  type WorkspaceMermaidOpenDetail
} from "./workspace-markdown-mermaid.js";
import { Button, IconButton, Modal } from "./ui.js";
import "./workspace-mermaid-hosts.css";

export interface WorkspaceMermaidHostLabels {
  readonly editTitle: string;
  readonly source: string;
  readonly cancel: string;
  readonly apply: string;
  readonly targetMissing: string;
  readonly zoomOut: string;
  readonly zoomIn: string;
  readonly copy: string;
  readonly copied: string;
  readonly copyFailed: string;
  readonly close: string;
}

type WorkspaceMermaidEditShortcut = "apply" | "cancel" | undefined;

/** The source editor treats an unchanged Cmd/Ctrl+Enter as cancel. */
export function workspaceMermaidEditShortcutAction(
  input: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey">,
  dirty: boolean
): WorkspaceMermaidEditShortcut {
  if (input.key !== "Enter" || (!input.ctrlKey && !input.metaKey)) return undefined;
  return dirty ? "apply" : "cancel";
}

export function WorkspaceMermaidHosts({ labels }: { readonly labels: WorkspaceMermaidHostLabels }): JSX.Element {
  const [open, setOpen] = useState<WorkspaceMermaidOpenDetail>();
  const [edit, setEdit] = useState<WorkspaceMermaidEditDetail>();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dirty = edit !== undefined && draft !== edit.source;

  useEffect(() => {
    const onOpen = (event: Event): void => setOpen((event as CustomEvent<WorkspaceMermaidOpenDetail>).detail);
    const onEdit = (event: Event): void => {
      const detail = (event as CustomEvent<WorkspaceMermaidEditDetail>).detail;
      setEdit(detail);
      setDraft(detail.source);
      setError(undefined);
    };
    window.addEventListener(WORKSPACE_MERMAID_OPEN_EVENT, onOpen);
    window.addEventListener(WORKSPACE_MERMAID_EDIT_EVENT, onEdit);
    return () => {
      window.removeEventListener(WORKSPACE_MERMAID_OPEN_EVENT, onOpen);
      window.removeEventListener(WORKSPACE_MERMAID_EDIT_EVENT, onEdit);
    };
  }, []);

  const closeEdit = useCallback((): void => {
    setEdit(undefined);
    setError(undefined);
  }, []);
  const apply = useCallback((): void => {
    if (edit === undefined || draft === edit.source) return;
    if (edit.apply(draft) === "target-missing") {
      setError(labels.targetMissing);
      return;
    }
    closeEdit();
  }, [closeEdit, draft, edit, labels.targetMissing]);

  useEffect(() => {
    if (edit === undefined) return;
    document.body.dataset.mermaidEditorOpen = "1";
    const keydown = (event: KeyboardEvent): void => {
      const action = workspaceMermaidEditShortcutAction(event, draft !== edit.source);
      if (action === undefined) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (action === "apply") apply();
      else closeEdit();
    };
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("keydown", keydown);
      delete document.body.dataset.mermaidEditorOpen;
    };
  }, [apply, closeEdit, draft, edit]);

  return <>
    {open !== undefined && <WorkspaceMermaidLightbox detail={open} labels={labels} onClose={() => setOpen(undefined)} />}
    <Modal
      open={edit !== undefined}
      title={labels.editTitle}
      onClose={closeEdit}
      size="large"
      className="workspace-mermaid-source-modal"
      initialFocus={() => textareaRef.current}
    >
      <label className="workspace-mermaid-source-modal__field">
        <span>{labels.source}</span>
        <textarea ref={textareaRef} value={draft} spellCheck={false} onChange={(event) => setDraft(event.target.value)} />
      </label>
      {error !== undefined && <p className="workspace-mermaid-source-modal__error" role="alert">{error}</p>}
      <footer className="workspace-mermaid-source-modal__actions">
        <Button tone="ghost" onClick={closeEdit}>{labels.cancel}</Button>
        <Button tone="primary" disabled={!dirty} onClick={apply}>{labels.apply}</Button>
      </footer>
    </Modal>
  </>;
}

export function WorkspaceMermaidLightbox({ detail, labels, onClose }: {
  readonly detail: WorkspaceMermaidOpenDetail;
  readonly labels: WorkspaceMermaidHostLabels;
  readonly onClose: () => void;
}): JSX.Element {
  const [visible, setVisible] = useState(false);
  const [viewport, setViewport] = useState({ scale: 1, x: 0, y: 0 });
  const viewportRef = useRef(viewport);
  const applyViewport = useCallback((next: { readonly scale: number; readonly x: number; readonly y: number }): void => {
    viewportRef.current = next;
    setViewport(next);
  }, []);
  const [drag, setDrag] = useState<{ readonly x: number; readonly y: number; readonly viewportX: number; readonly viewportY: number }>();
  const [wheeling, setWheeling] = useState(false);
  const wheelTimer = useRef<number | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closingRef = useRef(false);

  const close = useCallback((): void => {
    if (closingRef.current) return;
    closingRef.current = true;
    setVisible(false);
    window.setTimeout(() => onCloseRef.current(), 200);
  }, []);

  useEffect(() => {
    document.body.classList.add("workspace-mermaid-lightbox-open", "modal-open");
    const frame = window.requestAnimationFrame(() => setVisible(true));
    const keydown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    document.addEventListener("keydown", keydown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", keydown, true);
      if (wheelTimer.current !== undefined) window.clearTimeout(wheelTimer.current);
      document.body.classList.remove("workspace-mermaid-lightbox-open");
      if (document.querySelector(".modal-layer, .image-lightbox, .workspace-image-lightbox") === null) document.body.classList.remove("modal-open");
    };
  }, [close]);

  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const current = viewportRef.current;
      if (event.ctrlKey || event.metaKey) {
        const rect = stage.getBoundingClientRect();
        const point = { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
        const factor = workspaceMermaidWheelZoomFactor(event.deltaY, event.deltaMode);
        applyViewport(mermaidZoomAt(current, point, current.scale * factor));
      } else if (current.scale > 1 && (event.deltaX !== 0 || event.deltaY !== 0)) {
        applyViewport({
          ...current,
          x: current.x - normalizeWorkspaceMermaidWheelDelta(event.deltaX, event.deltaMode),
          y: current.y - normalizeWorkspaceMermaidWheelDelta(event.deltaY, event.deltaMode)
        });
      } else return;
      setWheeling(true);
      if (wheelTimer.current !== undefined) window.clearTimeout(wheelTimer.current);
      wheelTimer.current = window.setTimeout(() => setWheeling(false), 120);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [applyViewport]);

  useEffect(() => {
    if (drag === undefined) return;
    const move = (event: MouseEvent): void => applyViewport({
      ...viewportRef.current,
      x: drag.viewportX + event.clientX - drag.x,
      y: drag.viewportY + event.clientY - drag.y
    });
    const end = (): void => setDrag(undefined);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", end);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", end);
    };
  }, [applyViewport, drag]);

  const zoomBy = (factor: number): void => {
    const current = viewportRef.current;
    applyViewport(mermaidZoomAt(current, { x: 0, y: 0 }, current.scale * factor));
  };
  const copy = (): void => {
    const card = cardRef.current;
    if (card === null) return;
    setCopyFailed(false);
    void copyWorkspaceMermaid(detail.svg, detail.source, card).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    }).catch(() => setCopyFailed(true));
  };

  return createPortal(<div className={`workspace-mermaid-lightbox${visible ? " is-visible" : ""}`} role="dialog" aria-modal="true" aria-label={labels.close} onMouseDown={(event) => {
    if (event.target === event.currentTarget) close();
  }}>
    <div
      ref={stageRef}
      className={`workspace-mermaid-lightbox__stage${drag !== undefined ? " is-dragging" : ""}`}
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const current = viewportRef.current;
        setDrag({ x: event.clientX, y: event.clientY, viewportX: current.x, viewportY: current.y });
      }}
      onDoubleClick={() => applyViewport({ scale: 1, x: 0, y: 0 })}
    >
      <div
        ref={cardRef}
        className="workspace-mermaid-lightbox__card"
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
          transition: drag !== undefined || wheeling ? "none" : "transform 80ms ease-out"
        }}
        dangerouslySetInnerHTML={{ __html: detail.svg }}
      />
    </div>
    <div className="workspace-mermaid-lightbox__toolbar" onMouseDown={(event) => event.stopPropagation()}>
      <ToolbarButton label={labels.zoomOut} onClick={() => zoomBy(1 / 1.2)}><Minus /></ToolbarButton>
      <span>{Math.round(viewport.scale * 100)}%</span>
      <ToolbarButton label={labels.zoomIn} onClick={() => zoomBy(1.2)}><Plus /></ToolbarButton>
      <i aria-hidden="true" />
      <ToolbarButton label={copied ? labels.copied : copyFailed ? labels.copyFailed : labels.copy} onClick={copy}>{copied ? <Check /> : <Copy />}</ToolbarButton>
      <ToolbarButton label={labels.close} onClick={close}><X /></ToolbarButton>
    </div>
  </div>, document.body);
}

function ToolbarButton({ label, onClick, children }: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}): JSX.Element {
  return <IconButton label={label} onClick={onClick}>{children}</IconButton>;
}

export function mermaidZoomAt(
  viewport: { readonly scale: number; readonly x: number; readonly y: number },
  point: { readonly x: number; readonly y: number },
  scale: number
): { readonly scale: number; readonly x: number; readonly y: number } {
  const bounded = Math.min(8, Math.max(0.2, scale));
  const ratio = bounded / viewport.scale;
  return {
    scale: bounded,
    x: point.x - (point.x - viewport.x) * ratio,
    y: point.y - (point.y - viewport.y) * ratio
  };
}

/** Normalize WheelEvent line/page units to the pixel units used by the stage. */
export function normalizeWorkspaceMermaidWheelDelta(delta: number, deltaMode = 0): number {
  if (deltaMode === 1) return delta * 16;
  if (deltaMode === 2) return delta * 800;
  return delta;
}

/** Continuous focal-zoom curve after wheel-unit normalization. */
export function workspaceMermaidWheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const pixels = normalizeWorkspaceMermaidWheelDelta(deltaY, deltaMode);
  const clamped = Math.min(40, Math.max(-40, pixels));
  return Math.exp(-clamped * 0.01);
}
