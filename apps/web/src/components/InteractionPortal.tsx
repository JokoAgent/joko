import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { JSX, ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  getInteractionPromptSlot,
  registerInteractionPromptSlot,
  subscribeInteractionPromptSlot
} from "./interaction-portal-store.js";

/** A single, route-owned destination for interaction cards. */
export function InteractionPromptSlot({ className }: { readonly className?: string }): JSX.Element {
  const slotRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = slotRef.current;
    if (element === null) return;
    return registerInteractionPromptSlot(element);
  }, []);

  return <div ref={slotRef} className={className} />;
}

/**
 * Moves the existing interaction subtree when a route slot is mounted. With
 * no slot, children retain their ordinary inline placement.
 */
export function InteractionPromptHost({ enabled = true, hasInteraction, children, placeholder }: {
  readonly enabled?: boolean;
  readonly hasInteraction: boolean;
  readonly children: ReactNode;
  readonly placeholder?: ReactNode;
}): JSX.Element {
  const slot = useSyncExternalStore(
    subscribeInteractionPromptSlot,
    getInteractionPromptSlot,
    getInteractionPromptSlot
  );

  if (!enabled || !hasInteraction || slot === null) return <>{children}</>;
  return <>{createPortal(children, slot)}{placeholder ?? null}</>;
}
