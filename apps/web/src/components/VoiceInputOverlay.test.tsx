import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { translate } from "../i18n.js";
import { VoiceInputOverlay } from "./VoiceInputOverlay.js";

const t = (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]): string => translate("en", key, values);

describe("VoiceInputOverlay", () => {
  it("renders live text and accessible stop/cancel controls while listening", () => {
    const markup = renderToStaticMarkup(<VoiceInputOverlay
      state="listening"
      transcript="draft words"
      stallWarning={false}
      t={t}
      onStop={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />);

    expect(markup).toContain("draft words");
    expect(markup).toContain('aria-label="Use transcription"');
    expect(markup).toContain('aria-label="Cancel voice input"');
  });

  it("renders a recoverable error without exposing raw host details", () => {
    const markup = renderToStaticMarkup(<VoiceInputOverlay
      state="error"
      transcript=""
      error="Microphone permission is required."
      stallWarning={false}
      t={t}
      onStop={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />);

    expect(markup).toContain("Microphone permission is required.");
    expect(markup).toContain('aria-label="Retry"');

  });

  it("keeps a salvaged transcript visible behind an explicit use action", () => {
    const markup = renderToStaticMarkup(<VoiceInputOverlay
      state="error"
      transcript="salvaged words"
      error="The service connection ended."
      stallWarning={false}
      canUseTranscript
      t={t}
      onStop={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
      onUseTranscript={vi.fn()}
    />);

    expect(markup).toContain("salvaged words");
    expect(markup).toContain('aria-label="Use transcription"');
  });
});
