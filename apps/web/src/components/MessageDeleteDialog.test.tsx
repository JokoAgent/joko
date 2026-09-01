import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { TimelineItemView } from "../model.js";
import { translate } from "../i18n.js";
import { MessageDeleteDialog } from "./MessageDeleteDialog.js";

const item: TimelineItemView = {
  id: "event-message",
  sequence: 1n,
  kind: "assistant",
  createdAt: 1,
  text: "answer"
};

describe("message delete confirmation", () => {
  it("explains the destructive context", () => {
    const markup = renderToStaticMarkup(<MessageDeleteDialog
      item={item}
      busy={false}
      t={(key, values) => translate("en", key, values)}
      onClose={vi.fn()}
      onConfirm={vi.fn()}
    />);
    expect(markup).toContain("Delete this message?");
    expect(markup).toContain("A user message is removed on its own.");
    expect(markup).toContain("AI context is rebuilt from the remaining history.");
    expect(markup).toContain("Delete message");
  });

  it("disables both actions while the durable mutation is pending", () => {
    const markup = renderToStaticMarkup(<MessageDeleteDialog
      item={item}
      busy
      error="retryable failure"
      t={(key, values) => translate("en", key, values)}
      onClose={vi.fn()}
      onConfirm={vi.fn()}
    />);
    expect(markup.match(/disabled=""/gu)).toHaveLength(2);
    expect(markup).toContain("aria-busy=\"true\"");
    expect(markup).toContain("role=\"alert\"");
  });

  it("keeps cancel available but disables confirmation with the existing busy explanation", () => {
    const markup = renderToStaticMarkup(<MessageDeleteDialog
      item={item}
      busy={false}
      blockedReason="Wait for the current response to finish before deleting a message."
      t={(key, values) => translate("en", key, values)}
      onClose={vi.fn()}
      onConfirm={vi.fn()}
    />);
    expect(markup.match(/disabled=""/gu)).toHaveLength(1);
    expect(markup).toContain("role=\"status\"");
    expect(markup).toContain("Wait for the current response to finish");
  });
});
