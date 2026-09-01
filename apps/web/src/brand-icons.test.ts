/// <reference types="node" />

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const darkAvatar = readFileSync(new URL("./avatar-dark.svg", import.meta.url), "utf8");
const lightAvatar = readFileSync(new URL("./avatar-light.svg", import.meta.url), "utf8");
const darkLoading = readFileSync(new URL("./loading-dark.svg", import.meta.url), "utf8");
const lightLoading = readFileSync(new URL("./loading-light.svg", import.meta.url), "utf8");
const darkAppIcon = readFileSync(new URL("./icon-dark.svg", import.meta.url), "utf8");
const lightAppIcon = readFileSync(new URL("./icon-light.svg", import.meta.url), "utf8");
const landingArtwork = readdirSync(new URL("./landing-artwork/", import.meta.url))
  .filter((name) => name.endsWith(".svg"))
  .map((name) => readFileSync(new URL(`./landing-artwork/${name}`, import.meta.url), "utf8"));

describe("Joko brand icon assets", () => {
  it("keeps the supplied SVGs self-contained and script-free", () => {
    for (const icon of [lightAvatar, darkAvatar, lightLoading, darkLoading, lightAppIcon, darkAppIcon, ...landingArtwork]) {
      expect(icon).not.toMatch(/<(?:script|image|use|foreignObject|iframe|object|embed)\b/i);
      expect(icon).not.toMatch(/\b(?:href|xlink:href|on[a-z]+)\s*=/i);
      expect(icon).not.toMatch(/\b(?:javascript:|data:)/i);
    }
  });
});
