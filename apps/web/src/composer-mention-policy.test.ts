import { describe, expect, it } from "vitest";

import type { ComposerMentionDraft, SessionResourceView } from "./model.js";
import { composerMentionsAllowed, resolveComposerMentionPolicy } from "./composer-mention-policy.js";

const policy = resolveComposerMentionPolicy({
  name: "input.mention",
  supported: true,
  options: ["resource"]
});
const resource: SessionResourceView = {
  sessionId: "session-one",
  id: "resource-one",
  name: "Release",
  kind: "prompt",
  discoveredRevision: "sha256:exact",
  resourceVersion: "7",
  runtimeGeneration: 3
};
const mention: ComposerMentionDraft = {
  id: "resource:one:7:3",
  kind: "resource",
  reference: resource.id,
  label: resource.name,
  token: "@Release",
  discoveredRevision: resource.discoveredRevision,
  resourceVersion: resource.resourceVersion,
  runtimeGeneration: resource.runtimeGeneration
};

describe("composer resource mention admission", () => {
  it("requires the exact identity in the current task catalog", () => {
    expect(composerMentionsAllowed([mention], policy, [resource])).toBe(true);
    expect(composerMentionsAllowed([mention], policy, [])).toBe(false);
    for (const stale of [
      { ...resource, id: "resource-other" },
      { ...resource, discoveredRevision: "sha256:other" },
      { ...resource, resourceVersion: "8" },
      { ...resource, runtimeGeneration: 4 }
    ]) expect(composerMentionsAllowed([mention], policy, [stale])).toBe(false);
  });

  it("fails closed when the Backend no longer advertises resource mentions", () => {
    const unavailable = resolveComposerMentionPolicy({ name: "input.mention", supported: true, options: [] });
    expect(composerMentionsAllowed([mention], unavailable, [resource])).toBe(false);
  });

  it("admits historical task context only through the explicit session option", () => {
    const sessionMention: ComposerMentionDraft = {
      id: "session:task-two",
      kind: "session",
      reference: "task-two",
      label: "Earlier investigation",
      token: '@"Earlier investigation"'
    };
    expect(composerMentionsAllowed([sessionMention], resolveComposerMentionPolicy({
      name: "input.mention", supported: true, options: ["session"]
    }), [])).toBe(true);
    expect(composerMentionsAllowed([sessionMention], policy, [])).toBe(false);
  });
});
