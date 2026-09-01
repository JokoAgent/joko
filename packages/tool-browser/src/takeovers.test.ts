import { describe, expect, it } from "vitest";
import {
  BrowserTakeoverConflictError,
  BrowserTakeoverInputError,
  BrowserTakeoverRegistry,
  validateTakeoverInput,
  validateTakeoverNavigationUrl,
  type BrowserTakeoverFence
} from "./takeovers.js";

describe("BrowserTakeoverRegistry", () => {
  it("binds a takeover to provider, page, generation, owner, and a fresh ID", () => {
    const takeovers = new BrowserTakeoverRegistry(() => 1_000);
    const takeover = takeovers.begin({
      providerId: "provider-a",
      pageId: "page-a",
      generation: 7,
      owner: "connection-a"
    }, 5_000);

    expect(takeover).toMatchObject({
      providerId: "provider-a",
      pageId: "page-a",
      generation: 7,
      owner: "connection-a",
      startedAt: 1_000,
      expiresAt: 6_000
    });
    expect(takeover.takeoverId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(takeovers.assert(takeover)).toEqual(takeover);
  });

  it("rejects every mismatched takeover fence component without ending the live takeover", () => {
    const takeovers = new BrowserTakeoverRegistry(() => 1_000);
    const takeover = takeovers.begin({
      providerId: "provider-a",
      pageId: "page-a",
      generation: 7,
      owner: "connection-a"
    }, 5_000);
    const mutations: readonly BrowserTakeoverFence[] = [
      { ...takeover, providerId: "provider-b" },
      { ...takeover, pageId: "page-b" },
      { ...takeover, generation: 8 },
      { ...takeover, owner: "connection-b" },
      { ...takeover, takeoverId: "wrong-takeover" }
    ];

    for (const fence of mutations) {
      expect(() => takeovers.assert(fence)).toThrow(BrowserTakeoverConflictError);
      expect(() => takeovers.end(fence)).toThrow(BrowserTakeoverConflictError);
    }
    expect(takeovers.current()).toEqual(takeover);
  });

  it("fences old generations, exact closed pages, and expiry", () => {
    let now = 1_000;
    const takeovers = new BrowserTakeoverRegistry(() => now);
    const first = takeovers.begin({ providerId: "provider-a", pageId: "page-a", generation: 3, owner: "owner" }, 1_000);
    takeovers.fencePage({ providerId: first.providerId, pageId: "another-page", generation: first.generation });
    expect(takeovers.current()).toEqual(first);
    takeovers.fence(4);
    expect(takeovers.current()).toBeUndefined();

    const second = takeovers.begin({ providerId: "provider-a", pageId: "page-b", generation: 4, owner: "owner" }, 1_000);
    takeovers.fencePage(second);
    expect(takeovers.current()).toBeUndefined();

    takeovers.begin({ providerId: "provider-a", pageId: "page-c", generation: 4, owner: "owner" }, 1_000);
    now = 2_000;
    expect(takeovers.current()).toBeUndefined();
  });
});

describe("Browser takeover bounded chrome input", () => {
  it("accepts modifier chords and typed navigation controls", () => {
    expect(() => validateTakeoverInput({
      type: "keyPress",
      key: "l",
      modifiers: ["Control", "Shift"]
    })).not.toThrow();
    expect(() => validateTakeoverInput({ type: "navigationCommand", command: "forward" })).not.toThrow();
    expect(validateTakeoverNavigationUrl("https://example.test/path?q=short")).toBe("https://example.test/path?q=short");
    expect(validateTakeoverNavigationUrl("about:blank")).toBe("about:blank");
  });

  it("rejects duplicate modifiers and durable credential-shaped URL material", () => {
    expect(() => validateTakeoverInput({
      type: "keyPress",
      key: "c",
      modifiers: ["Control", "Control"]
    })).toThrow(BrowserTakeoverInputError);
    expect(() => validateTakeoverNavigationUrl("https://user:secret@example.test/"))
      .toThrow(BrowserTakeoverInputError);
    expect(() => validateTakeoverNavigationUrl("https://example.test/callback?access_token=secret"))
      .toThrow(BrowserTakeoverInputError);
    expect(() => validateTakeoverNavigationUrl("https://example.test/#token"))
      .toThrow(BrowserTakeoverInputError);
  });
});
