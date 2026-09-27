import { describe, expect, it } from "vitest";

import { DesktopAttentionBadgeController } from "./attention-badge.js";
import { DesktopMainDocumentOccurrenceAuthority } from "./main-document-occurrence.js";

describe("Desktop main Document occurrence authority", () => {
  const firstClaim = "00000000-0000-4000-8000-000000000001";
  const secondClaim = "00000000-0000-4000-8000-000000000002";

  it("rotates only when a replacement preload captures its occurrence", () => {
    const endpoint = {};
    let next = 0;
    const authority = new DesktopMainDocumentOccurrenceAuthority<object>(() => `document-${++next}`);

    expect(authority.currentFor(endpoint)).toBeUndefined();
    expect(authority.capture(endpoint, firstClaim)).toEqual({
      current: { endpoint, claim: firstClaim, occurrence: "document-1" },
      created: true
    });

    // A navigation attempt does not interact with this authority. If the old
    // Document survives beforeunload or a failed navigation, it remains exact.
    expect(authority.currentFor(endpoint)).toBe("document-1");
    expect(authority.isCurrent(endpoint, "document-1")).toBe(true);

    expect(authority.capture(endpoint, secondClaim)).toEqual({
      current: { endpoint, claim: secondClaim, occurrence: "document-2" },
      created: true,
      retired: { endpoint, claim: firstClaim, occurrence: "document-1" }
    });
    expect(authority.isCurrent(endpoint, "document-1")).toBe(false);
    expect(authority.isCurrent(endpoint, "document-2")).toBe(true);
  });

  it("returns the same host occurrence when one preload repeats its private claim", () => {
    const endpoint = {};
    let created = 0;
    const authority = new DesktopMainDocumentOccurrenceAuthority<object>(() => `document-${++created}`);
    const first = authority.capture(endpoint, firstClaim);

    expect(authority.capture(endpoint, firstClaim)).toEqual({ current: first.current, created: false });
    expect(created).toBe(1);
    expect(authority.currentFor(endpoint)).toBe("document-1");
  });

  it("keeps surviving-Document attention through attempts and idempotent capture", () => {
    const endpoint = { id: 7 };
    let created = 0;
    const authority = new DesktopMainDocumentOccurrenceAuthority<typeof endpoint>(
      () => `document-${++created}`
    );
    const attention = new DesktopAttentionBadgeController({ clear: () => undefined, show: () => undefined });
    authority.capture(endpoint, firstClaim);
    attention.mark(endpoint.id, { ownerId: "owner-one", sessionId: "task-one" });

    // A cancelled/failed navigation attempt performs no capture and cannot
    // release the still-live source. Repeating the same private preload claim
    // is also idempotent and must not be treated as a replacement.
    expect(attention.count).toBe(1);
    const repeated = authority.capture(endpoint, firstClaim);
    if (repeated.created && repeated.retired !== undefined) {
      attention.releaseSource(repeated.retired.endpoint.id);
    }
    expect(repeated.created).toBe(false);
    expect(attention.count).toBe(1);

    const replacement = authority.capture(endpoint, secondClaim);
    if (replacement.created && replacement.retired !== undefined) {
      attention.releaseSource(replacement.retired.endpoint.id);
    }
    expect(attention.count).toBe(0);
  });

  it("retires only the exact endpoint and never lends its occurrence to a replacement", () => {
    const first = {};
    const replacement = {};
    const authority = new DesktopMainDocumentOccurrenceAuthority<object>(() => "document-one");
    authority.capture(first, firstClaim);

    expect(authority.currentFor(replacement)).toBeUndefined();
    expect(authority.retire(replacement)).toBeUndefined();
    expect(authority.currentFor(first)).toBe("document-one");
    expect(authority.retire(first)).toEqual({ endpoint: first, claim: firstClaim, occurrence: "document-one" });
    expect(authority.currentFor(first)).toBeUndefined();
  });

  it("rejects an invalid occurrence before it can replace the current owner", () => {
    const endpoint = {};
    const occurrences = ["document-one", " invalid"];
    const authority = new DesktopMainDocumentOccurrenceAuthority<object>(() => occurrences.shift()!);
    authority.capture(endpoint, firstClaim);

    expect(() => authority.capture(endpoint, secondClaim)).toThrow(/invalid identity/u);
    expect(authority.currentFor(endpoint)).toBe("document-one");
  });

  it("rejects a malformed renderer claim before issuing authority", () => {
    const endpoint = {};
    let created = 0;
    const authority = new DesktopMainDocumentOccurrenceAuthority<object>(() => `document-${++created}`);

    expect(() => authority.capture(endpoint, "renderer-chosen")).toThrow(/preload claim/u);
    expect(created).toBe(0);
    expect(authority.currentFor(endpoint)).toBeUndefined();
  });
});
