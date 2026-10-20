import { observeElementOffset } from "@tanstack/react-virtual";

// The pinned observer removes its listeners but leaves a queued scroll reset.
// Retire its callback with this viewport so it cannot dispatch into an unmounted
// React tree or a replacement viewport. Keep the library's live scroll behavior.
export const observeActiveElementOffset: typeof observeElementOffset = (instance, changed) => {
  let active = true;
  const detach = observeElementOffset(instance, (offset, scrolling) => {
    if (active) changed(offset, scrolling);
  });
  return () => {
    active = false;
    detach?.();
  };
};
