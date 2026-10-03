import { createContext, useContext } from "react";

export const RENDERED_SHARE_MESSAGE_ATTRIBUTE = "data-rendered-share-message-id";
export const RENDERED_SHARE_EXCLUDE_ATTRIBUTE = "data-rendered-share-exclude";
export const RENDERED_SHARE_CONTENT_PENDING_ATTRIBUTE = "data-rendered-share-content-pending";

export const RenderedShareSelectionContext = createContext(false);

export function useRenderedShareSelection(): boolean {
  return useContext(RenderedShareSelectionContext);
}
