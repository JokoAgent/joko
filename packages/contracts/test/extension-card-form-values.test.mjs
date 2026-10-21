import assert from "node:assert/strict";
import test from "node:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { ExtensionCardServiceDispatchRequestSchema, extensionCardFormValuesFromEntries, extensionCardFormValuesToEntries } from "../dist/index.js";

test("card form values cross the generated typed contract without losing text", () => {
  const values = { subject: "Example", bodyHtml: "<p>Draft</p>", attachmentItems: "[]" };
  const request = create(ExtensionCardServiceDispatchRequestSchema, { sessionId: "task", cardId: "card", formValues: extensionCardFormValuesToEntries(values) });
  const decoded = fromBinary(ExtensionCardServiceDispatchRequestSchema, toBinary(ExtensionCardServiceDispatchRequestSchema, request));
  assert.deepEqual(extensionCardFormValuesFromEntries(decoded.formValues), values);
  assert.deepEqual(extensionCardFormValuesFromEntries([]), {});
});

test("ambiguous, reserved and oversized form entries cannot reach a card action", () => {
  for (const entries of [
    [{ name: "subject", value: "one" }, { name: "subject", value: "two" }],
    [{ name: "__proto__", value: "value" }], [{ name: "constructor", value: "value" }],
    [{ name: "subject", value: "a".repeat(16001) }], [{ name: "bodyHtml", value: "a".repeat(64001) }],
    Array.from({ length: 17 }, (_, index) => ({ name: `field${index}`, value: "value" })),
  ]) assert.throws(() => extensionCardFormValuesFromEntries(entries));
  assert.equal(extensionCardFormValuesFromEntries([{ name: "bodyHtml", value: "a".repeat(64000) }]).bodyHtml.length, 64000);
});
