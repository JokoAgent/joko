import { describe, expect, it } from "vitest";
import { managedRuntimeFactorySource } from "./managed-runtime-factory-source.js";

describe("managed runtime factory source", () => {
  it("executes production-shaped serialized factories with bundler name annotations", async () => {
    const source = managedRuntimeFactorySource("createPiAutoReviewer", {
      toString: () => "function productionFactory() { const nested = () => true; __name(nested, 'nested'); return nested.name; }"
    });
    const url = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
    const runtime = await import(url) as { createPiAutoReviewer(): string };

    expect(runtime.createPiAutoReviewer()).toBe("nested");
  });
});
