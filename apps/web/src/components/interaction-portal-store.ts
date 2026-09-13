type InteractionPromptSlotSubscriber = () => void;

let slotElement: HTMLElement | null = null;
const subscribers = new Set<InteractionPromptSlotSubscriber>();

/**
 * Registers the single interaction target owned by the currently mounted
 * route. The ownership check in the cleanup prevents an older slot from
 * clearing a newer route's target during a transition.
 */
export function registerInteractionPromptSlot(element: HTMLElement): () => void {
  setInteractionPromptSlot(element);
  return () => {
    if (slotElement === element) setInteractionPromptSlot(null);
  };
}

export function getInteractionPromptSlot(): HTMLElement | null {
  return slotElement;
}

export function subscribeInteractionPromptSlot(subscriber: InteractionPromptSlotSubscriber): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

function setInteractionPromptSlot(element: HTMLElement | null): void {
  if (slotElement === element) return;
  slotElement = element;
  for (const subscriber of subscribers) subscriber();
}
