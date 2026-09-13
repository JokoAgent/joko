// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  extensionMainViewLink,
  isExtensionApplicationWindow,
  openExtensionWindowFallback,
  validExtensionWindowId
} from "./extension-window-navigation.js";

const EXTENSION_ID = "extension_0123456789abcdef0123456789abcdef";

afterEach(() => vi.restoreAllMocks());

describe("Extension main-view window navigation", () => {
  it("builds a credential-free route and validates only exact v1 identities", () => {
    expect(validExtensionWindowId(EXTENSION_ID)).toBe(true);
    expect(validExtensionWindowId(EXTENSION_ID.toUpperCase())).toBe(false);
    expect(validExtensionWindowId(`${EXTENSION_ID}0`)).toBe(false);
    expect(extensionMainViewLink(
      { href: "https://user:secret@joko.example/app?auth=discard#/tasks/old" } as Location,
      EXTENSION_ID
    )).toBe(`https://joko.example/app#/extensions/${EXTENSION_ID}`);
    expect(() => extensionMainViewLink({ href: "https://joko.example/" } as Location, "../extension"))
      .toThrow(/identity/u);
  });

  it("recognizes only the exact independent-window query and uses a noopener fallback", () => {
    expect(isExtensionApplicationWindow({ search: `?extensionWindow=1&bootExtension=${EXTENSION_ID}` } as Location)).toBe(true);
    expect(isExtensionApplicationWindow({ search: `?bootExtension=${EXTENSION_ID}&extensionWindow=1` } as Location)).toBe(true);
    expect(isExtensionApplicationWindow({ search: `?extensionWindow=1&bootExtension=${EXTENSION_ID}&auth=secret` } as Location)).toBe(false);
    expect(isExtensionApplicationWindow({ search: `?extensionWindow=1&bootExtension=${EXTENSION_ID}&bootExtension=${EXTENSION_ID}` } as Location)).toBe(false);

    const opened = {} as Window;
    const open = vi.spyOn(window, "open").mockReturnValue(opened);
    expect(openExtensionWindowFallback({ href: "https://joko.example/app?discard=1" } as Location, EXTENSION_ID)).toBe(opened);
    expect(open).toHaveBeenCalledWith(
      `https://joko.example/app#/extensions/${EXTENSION_ID}`,
      "_blank",
      "noopener,noreferrer"
    );
  });
});
