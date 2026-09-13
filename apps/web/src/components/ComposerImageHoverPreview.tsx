import { useLayoutEffect, useState, type JSX, type RefObject } from "react";
import { createPortal } from "react-dom";

const MAXIMUM_WIDTH = 224;
const MAXIMUM_HEIGHT = 168;
const EDGE_PADDING = 12;
const ANCHOR_GAP = 12;

interface HoverPlacement {
  readonly top: number;
  readonly left: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly side: "above" | "below";
}

/** A non-interactive preview that follows its attachment trigger without escaping the viewport. */
export function ComposerImageHoverPreview({ open, anchorRef, src }: {
  readonly open: boolean;
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly src: string;
}): JSX.Element | null {
  const [placement, setPlacement] = useState<HoverPlacement>();

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const ownerWindow = anchor?.ownerDocument.defaultView;
    if (!open || anchor === null || anchor === undefined || ownerWindow === null || ownerWindow === undefined) {
      setPlacement(undefined);
      return;
    }

    const update = (): void => {
      const current = anchorRef.current;
      if (current === null) return;
      const rect = current.getBoundingClientRect();
      const above = Math.max(0, rect.top - EDGE_PADDING - ANCHOR_GAP);
      const below = Math.max(0, ownerWindow.innerHeight - rect.bottom - EDGE_PADDING - ANCHOR_GAP);
      const side = above >= MAXIMUM_HEIGHT || above >= below ? "above" : "below";
      const maxWidth = Math.max(0, Math.min(MAXIMUM_WIDTH, ownerWindow.innerWidth - EDGE_PADDING * 2));
      const maxHeight = Math.max(0, Math.min(MAXIMUM_HEIGHT, side === "above" ? above : below));
      const halfWidth = maxWidth / 2;
      const minimumLeft = EDGE_PADDING + halfWidth;
      const maximumLeft = ownerWindow.innerWidth - EDGE_PADDING - halfWidth;
      const center = rect.left + rect.width / 2;
      setPlacement({
        top: side === "above" ? rect.top - ANCHOR_GAP : rect.bottom + ANCHOR_GAP,
        left: minimumLeft <= maximumLeft
          ? Math.min(Math.max(center, minimumLeft), maximumLeft)
          : ownerWindow.innerWidth / 2,
        maxWidth,
        maxHeight,
        side
      });
    };

    update();
    ownerWindow.addEventListener("resize", update);
    ownerWindow.addEventListener("scroll", update, { capture: true, passive: true });
    return () => {
      ownerWindow.removeEventListener("resize", update);
      ownerWindow.removeEventListener("scroll", update, true);
    };
  }, [anchorRef, open]);

  const host = anchorRef.current?.ownerDocument.body;
  if (!open || placement === undefined || host === undefined || placement.maxWidth <= 0 || placement.maxHeight <= 0) return null;
  return createPortal(<div
    className="composer-image-hover-preview"
    aria-hidden="true"
    style={{
      top: placement.top,
      left: placement.left,
      maxWidth: placement.maxWidth,
      maxHeight: placement.maxHeight,
      transform: placement.side === "above" ? "translate(-50%, -100%)" : "translate(-50%, 0)"
    }}
  >
    <img src={src} alt="" draggable={false} style={{ maxWidth: placement.maxWidth, maxHeight: placement.maxHeight }} />
  </div>, host);
}
