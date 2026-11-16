import { useState, type CSSProperties, type JSX } from "react";
import type { ImageAnnotationStroke } from "../image-annotations.js";
import { WORKSPACE_IMAGE_ANNOTATION_COLOR, WORKSPACE_IMAGE_ANNOTATION_OUTLINE, workspaceImageStrokePath, workspaceImageStrokeWidth } from "./workspace-image-annotations.js";

export function AnnotatedImage({ src, strokes, className, imageStyle, cover = false }: {
  readonly src: string;
  readonly strokes?: readonly ImageAnnotationStroke[];
  readonly className?: string;
  readonly imageStyle?: CSSProperties;
  readonly cover?: boolean;
}): JSX.Element {
  const [size, setSize] = useState<{ readonly src: string; readonly width: number; readonly height: number }>();
  const current = size?.src === src && size.width > 0 && size.height > 0 ? size : undefined;
  const width = current === undefined ? 0 : workspaceImageStrokeWidth(current.width, current.height);
  return <span className={`annotated-image${className === undefined ? "" : ` ${className}`}`}>
    <img src={src} alt="" draggable={false} style={imageStyle} onLoad={event => setSize({ src, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
    {current !== undefined && !!strokes?.length && <svg aria-hidden="true" viewBox={`0 0 ${current.width} ${current.height}`} preserveAspectRatio={cover ? "xMidYMid slice" : "xMidYMid meet"}>
      {[{ color: WORKSPACE_IMAGE_ANNOTATION_OUTLINE, width: Math.round(width * 1.8) }, { color: WORKSPACE_IMAGE_ANNOTATION_COLOR, width }].map((pass, passIndex) =>
        <g key={passIndex} fill="none" stroke={pass.color} strokeWidth={pass.width} strokeLinecap="round" strokeLinejoin="round">
          {strokes.map((stroke, index) => <path key={index} d={workspaceImageStrokePath(stroke, current.width, current.height)} />)}
        </g>)}
    </svg>}
  </span>;
}
