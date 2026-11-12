import { describe, expect, it, vi } from "vitest";
import { contactImportDecisions, type ContactImportSelection } from "./components/ContactsSettings.js";
import type { ContactProfileView, ContactVCardImportPreviewView } from "./model.js";

describe("Contact vCard review", () => {
  it("resolves external merge targets to current revisions while preserving staged entry targets", async () => {
    const getContact = vi.fn(async (id: string, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      return { id, revision: id === "person-existing" ? 11n : 13n } as ContactProfileView;
    });
    const signal = new AbortController().signal;
    const preview: ContactVCardImportPreviewView = {
      previewId: "preview",
      directoryRevision: 7n,
      expiresAt: Date.now() + 60_000,
      rejectedEntries: [{ entryId: "invalid-entry", displayName: "Invalid name", reason: "Contact display name is invalid." }],
      entries: [
        {
          entryId: "entry-one",
          contact: draft("Person One"),
          disposition: "needsReview",
          candidates: [{ matchType: "name", contactId: "person-existing", displayName: "Person 1", kind: "person", status: "confirmed", summary: "" }],
          similarEntryIds: [],
          groups: [],
          organizationName: "Example Org",
          organizationCandidates: [{ matchType: "name", contactId: "org-existing", displayName: "Example Organization", kind: "organization", status: "confirmed", summary: "" }]
        },
        {
          entryId: "entry-two",
          contact: draft("Person Two"),
          disposition: "needsReview",
          candidates: [],
          similarEntryIds: ["entry-one"],
          groups: [],
          organizationCandidates: []
        }
      ]
    };
    const selections: readonly ContactImportSelection[] = [
      { entryId: "entry-one", decision: "merge", target: "contact:person-existing", organizationDecision: "merge", organizationTarget: "contact:org-existing" },
      { entryId: "entry-two", decision: "merge", target: "entry:entry-one" }
    ];

    await expect(contactImportDecisions({ getContact }, preview, selections, signal)).resolves.toEqual([
      expect.objectContaining({
        entryId: "entry-one",
        decision: "merge",
        targetContactId: "person-existing",
        expectedTargetRevision: 11n,
        organizationDecision: "merge",
        organizationTargetContactId: "org-existing",
        expectedOrganizationTargetRevision: 13n
      }),
      expect.objectContaining({ entryId: "entry-two", decision: "merge", targetEntryId: "entry-one" })
    ]);
    expect(getContact).toHaveBeenCalledTimes(2);
    expect(getContact).toHaveBeenCalledWith("person-existing", signal);
    expect(getContact).toHaveBeenCalledWith("org-existing", signal);
  });
});

function draft(displayName: string) {
  return {
    kind: "person" as const,
    displayName,
    aliases: [],
    summary: "",
    narrative: "",
    agentNotes: "",
    status: "confirmed" as const,
    source: "import" as const,
    identities: []
  };
}
