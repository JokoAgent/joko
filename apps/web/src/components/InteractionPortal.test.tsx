import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { translate } from "../i18n.js";
import { InteractionPromptHost } from "./InteractionPortal.js";

describe("Files interaction portal", () => {
  it("keeps ordinary sessions inline when no route slot is mounted", () => {
    const markup = renderToStaticMarkup(
      <InteractionPromptHost hasInteraction><span>Inline prompt</span></InteractionPromptHost>
    );
    expect(markup).toContain("Inline prompt");
  });

  it("localizes the rail placeholder in English and Simplified Chinese", () => {
    expect(translate("en", "interaction.waitForReply")).toBe("Waiting for your reply in the document area…");
    expect(translate("zh-CN", "interaction.waitForReply")).toBe("等待你在文档区回复…");
  });
});
