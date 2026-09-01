import { FileInput } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { isPortableSessionFile, PORTABLE_SESSION_MEDIA_TYPE } from "../portable-session-ui.js";

export function PortableSessionDropTarget({ label, onFile }: {
  readonly label: string;
  readonly onFile: (file: File) => void;
}): JSX.Element | null {
  const [active, setActive] = useState(false);
  const onFileRef = useRef(onFile);
  onFileRef.current = onFile;

  useEffect(() => {
    let depth = 0;
    let intercepting = false;
    const reset = (): void => {
      depth = 0;
      intercepting = false;
      setActive(false);
    };
    const onDragEnter = (event: DragEvent): void => {
      depth += 1;
      if (portableSessionDragHint(event.dataTransfer)) {
        intercepting = true;
        setActive(true);
      }
      if (!intercepting) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const onDragLeave = (event: DragEvent): void => {
      if (intercepting) event.stopPropagation();
      depth = Math.max(0, depth - 1);
      if (depth === 0) reset();
    };
    const onDragOver = (event: DragEvent): void => {
      if (!intercepting) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (event: DragEvent): void => {
      const file = portableSessionDropFile(event.dataTransfer);
      reset();
      if (file === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      clearNestedFileDropState(event.target);
      onFileRef.current(file);
    };
    const onBlur = (): void => reset();
    window.addEventListener("dragenter", onDragEnter, true);
    window.addEventListener("dragleave", onDragLeave, true);
    window.addEventListener("dragover", onDragOver, true);
    window.addEventListener("drop", onDrop, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("dragenter", onDragEnter, true);
      window.removeEventListener("dragleave", onDragLeave, true);
      window.removeEventListener("dragover", onDragOver, true);
      window.removeEventListener("drop", onDrop, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  if (!active) return null;
  return <div className="portable-session-drop-overlay" role="status" aria-live="polite">
    <span><FileInput aria-hidden="true" />{label}</span>
  </div>;
}

export function portableSessionDragHint(dataTransfer: DataTransfer | null): boolean {
  if (dataTransfer === null || dataTransfer.items.length !== 1) return false;
  const item = dataTransfer.items[0];
  return item?.kind === "file" && item.type.toLocaleLowerCase("en-US") === PORTABLE_SESSION_MEDIA_TYPE;
}

export function portableSessionDropFile(dataTransfer: DataTransfer | null): File | undefined {
  if (dataTransfer === null || dataTransfer.files.length !== 1) return undefined;
  const file = dataTransfer.files[0];
  return file !== undefined && isPortableSessionFile(file) ? file : undefined;
}

function clearNestedFileDropState(target: EventTarget | null): void {
  if (!(target instanceof Element)) return;
  target.dispatchEvent(new Event("dragleave", { bubbles: true }));
}
