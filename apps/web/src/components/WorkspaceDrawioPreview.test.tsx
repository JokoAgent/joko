import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceDrawioPreview, WorkspaceDrawioUnavailable } from "./WorkspaceDrawioPreview.js";

describe("WorkspaceDrawioPreview", () => {
  it("renders a stable offline loading stage", () => {
    const markup = renderToStaticMarkup(<WorkspaceDrawioPreview
      workspaceId="workspace-1"
      path="architecture.drawio"
      name="architecture.drawio"
      theme="light"
      xml="<mxfile />"
      metadata={["1.5 KB", "Modified at 2024-01-02 03:04"]}
      loadingLabel="Rendering diagram…"
      unavailableLabel="Unavailable"
      retryLabel="Retry"
      onRetry={async () => undefined}
    />);
    expect(markup).toContain("Rendering diagram…");
  });

  it("renders an unavailable-preview card with file metadata and a real retry action", () => {
    const markup = renderToStaticMarkup(<WorkspaceDrawioUnavailable
      name="architecture.drawio"
      metadata={["1.5 KB", "Modified at 2024-01-02 03:04"]}
      unavailableLabel="This diagram could not be previewed in Joko."
      retryLabel="Retry"
      onRetry={() => undefined}
    />);
    expect(markup).toContain("architecture.drawio");
    expect(markup).toContain("1.5 KB · Modified at 2024-01-02 03:04");
    expect(markup).toContain("Retry");
  });
});
