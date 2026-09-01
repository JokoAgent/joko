import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { translate } from "../i18n.js";
import { RetryStatusIndicator } from "./RetryStatusIndicator.js";

describe("Pi retry status text", () => {
  it("shows later overload retries with capacity-specific copy and a cancellable progress status", () => {
    const auto = renderToStaticMarkup(<RetryStatusIndicator retry={{
      itemId: "auto",
      runId: "run",
      source: "auto",
      attemptNumber: 2,
      maxAttempts: 5,
      error: retryError("UPSTREAM_OVERLOAD")
    }} t={(key, values) => translate("en", key, values)} />);
    expect(auto).toContain("no available capacity");
    expect(auto).toContain("Retrying (2/5)");
    expect(auto).toContain("Esc to cancel");
    expect(auto).toContain('role="status"');
  });

  it("keeps the first overload and later non-overload auto-retries silent", () => {
    for (const retry of [
      { itemId: "first", runId: "run", source: "auto" as const, attemptNumber: 1, maxAttempts: 5, error: retryError("UPSTREAM_OVERLOAD") },
      { itemId: "stream", runId: "run", source: "auto" as const, attemptNumber: 2, maxAttempts: 5, error: retryError("UPSTREAM_STREAM_INTERRUPTED") },
      { itemId: "generic", runId: "run", source: "auto" as const, attemptNumber: 2, maxAttempts: 5, error: retryError("PI_TRANSIENT_PROVIDER_ERROR") },
      { itemId: "unclassified", runId: "run", source: "auto" as const, attemptNumber: 2, maxAttempts: 5 }
    ]) {
      expect(renderToStaticMarkup(<RetryStatusIndicator retry={retry} t={(key, values) => translate("en", key, values)} />)).toBe("");
    }
  });

  it("retains non-cancellable summarization progress without an auto-retry notice", () => {
    const summarization = renderToStaticMarkup(<RetryStatusIndicator retry={{ itemId: "summary", runId: "run", source: "summarization", attemptNumber: 2, maxAttempts: 5 }} t={(key, values) => translate("en", key, values)} />);
    expect(summarization).not.toContain("Esc to cancel");
    expect(summarization).toContain("Retrying (2/5)");
  });
});

function retryError(code: string) {
  return {
    code,
    message: "redacted provider detail",
    phase: "retry",
    severity: "retryable" as const,
    retryable: true,
    recovery: []
  };
}
