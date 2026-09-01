import { describe, expect, it } from "vitest";

import { LocalRuntimeError, pullError } from "./errors.js";
import {
  assertActiveOwner,
  assertArchiveEntrySafe,
  canonicalModelName,
  modelNamesEqual,
  normalizeOllamaModelName
} from "./security.js";

describe("local runtime input fences", () => {
  it("normalizes model aliases and approved repository URLs", () => {
    expect(canonicalModelName("glm-4.7-flash")).toBe("glm-4.7-flash:latest");
    expect(modelNamesEqual("glm-4.7-flash", "glm-4.7-flash:latest")).toBe(true);
    expect(normalizeOllamaModelName("https://huggingface.co/org/repository/tree/main")).toBe("hf.co/org/repository");
    expect(normalizeOllamaModelName("https://huggingface.co/org/repository/blob/main/model-Q4_K_M.gguf")).toBe("hf.co/org/repository:Q4_K_M");
    expect(() => normalizeOllamaModelName("https://example.invalid/model")).toThrow(LocalRuntimeError);
  });

  it("rejects archive traversal and absolute paths", () => {
    expect(() => assertArchiveEntrySafe("bin/ollama")).not.toThrow();
    expect(() => assertArchiveEntrySafe("../outside")).toThrow(LocalRuntimeError);
    expect(() => assertArchiveEntrySafe("C:/outside")).toThrow(LocalRuntimeError);
    expect(() => assertArchiveEntrySafe("/outside")).toThrow(LocalRuntimeError);
  });

  it("fences every operation to the exact owner generation", () => {
    const expected = { ownerId: "owner-a", generation: 4 };
    expect(() => assertActiveOwner(expected, () => expected)).not.toThrow();
    expect(() => assertActiveOwner(expected, () => ({ ownerId: "owner-a", generation: 5 }))).toThrowError(expect.objectContaining({ code: "OWNER_CHANGED" }));
  });

  it("maps untrusted pull failures to stable public codes", () => {
    expect(pullError(new Error("401 /private/credential-path"), "model-a")).toMatchObject({ code: "MODEL_UNAUTHORIZED" });
    expect(pullError(new Error("not compatible with llama.cpp"), "model-a")).toMatchObject({ code: "MODEL_INCOMPATIBLE" });
    expect(pullError(new Error("arbitrary /Users/private/token"), "model-a").message).toBe("The local model operation failed.");
  });
});
