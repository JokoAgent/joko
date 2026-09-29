import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const project = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", project), "utf8"));
const networkModule = JSON.parse(readFileSync(require.resolve("expo-network/expo-module.config.json"), "utf8"));

describe("native mobile OS lifecycle boundary", () => {
  it("declares an autolinked native network path provider for both mobile platforms", () => {
    expect(pkg.dependencies["expo-network"]).toBe("~57.0.1");
    expect(networkModule).toMatchObject({
      platforms: expect.arrayContaining(["apple", "android"]),
      apple: { modules: expect.arrayContaining([expect.any(String)]) },
      android: { modules: expect.arrayContaining([expect.any(String)]) }
    });
  });
});
