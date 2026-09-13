import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { InteractionPromptHost } from "./InteractionPortal.js";

describe("Files interaction portal", () => {
  it("keeps ordinary sessions inline when no route slot is mounted", () => {
    const markup = renderToStaticMarkup(
      <InteractionPromptHost hasInteraction><span>Inline prompt</span></InteractionPromptHost>
    );
    expect(markup).toContain("Inline prompt");
  });

});
