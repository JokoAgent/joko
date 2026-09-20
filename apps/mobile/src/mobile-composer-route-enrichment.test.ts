import { describe, expect, it, vi } from "vitest";
import {
  emptyMobileComposerDraft,
  insertMobileStructuredClipboardText,
  mobileComposerDraftsEqual
} from "./mobile-composer-document";
import { enrichMobileComposerRouteReferences } from "./mobile-composer-route-enrichment";

describe("mobile composer task-link enrichment", () => {
  it("resolves every pending atom once, skips explicit labels, and preserves the final caret", async () => {
    const inserted = insertMobileStructuredClipboardText(
      emptyMobileComposerDraft(),
      { start: 0, end: 0 },
      "#/tasks/one [Explicit](#/tasks/two) #/tasks/three?message=message-three",
      (index) => `route-${index}`
    );
    const resolver = vi.fn(async (target: { readonly kind: "session" | "message" }) =>
      target.kind === "session" ? "Task One" : "Resolved message body");

    const enriched = await enrichMobileComposerRouteReferences(
      inserted.draft,
      inserted.selection,
      inserted.insertedAtomIds,
      resolver
    );

    expect(resolver).toHaveBeenCalledTimes(2);
    expect(enriched.draft.text).toBe(
      "[Task One](#/tasks/one) [Explicit](#/tasks/two) #/tasks/three?message=message-three"
    );
    expect(enriched.draft.atoms).toMatchObject([
      { atomId: "route-0", displayText: "Task One", serialized: "[Task One](#/tasks/one)" },
      { atomId: "route-1", displayText: "Explicit", serialized: "[Explicit](#/tasks/two)" },
      { atomId: "route-2", displayText: "Resolved message body", serialized: "#/tasks/three?message=message-three" }
    ]);
    expect(enriched.selection).toEqual({
      start: enriched.draft.text.length,
      end: enriched.draft.text.length
    });
  });

  it("keeps the immediate sanitized links when resolution fails", async () => {
    const inserted = insertMobileStructuredClipboardText(
      emptyMobileComposerDraft(),
      { start: 0, end: 0 },
      "https://user:pass@example.test/?token=secret#/tasks/one",
      () => "route"
    );
    const enriched = await enrichMobileComposerRouteReferences(
      inserted.draft,
      inserted.selection,
      inserted.insertedAtomIds,
      async () => { throw new Error("offline"); }
    );
    expect(mobileComposerDraftsEqual(enriched.draft, inserted.draft)).toBe(true);
    expect(JSON.stringify(enriched.draft)).not.toContain("secret");
    expect(JSON.stringify(enriched.draft)).not.toContain("user:pass");
  });
});
