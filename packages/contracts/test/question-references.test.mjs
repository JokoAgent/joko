import assert from "node:assert/strict";
import { test } from "node:test";
import { questionWorkspaceReference, splitQuestionReferences } from "../dist/question-references.js";

test("question references preserve answer keys, prose and authored spaced paths", () => {
  const parts = splitQuestionReferences('1. Read [source](</work/my project/a.ts:12>) or `src/b.ts:4`, then https://example.com/a_(b).');
  assert.deepEqual(parts.filter(part => part.href).map(part => [part.text, part.href]), [
    ["source", "/work/my project/a.ts:12"], ["src/b.ts:4", "src/b.ts:4"],
    ["https://example.com/a_(b)", "https://example.com/a_(b)"]
  ]);
  assert.equal(parts[0].text, "1. Read ");
  assert.equal(parts.at(-1).text, ".");
});

test("unquoted spaced absolute paths do not turn their trailing fragments into links", () => {
  assert.equal(splitQuestionReferences("Read /my project/src/a.ts before answering").some(part => part.href), false);
});

test("question references never activate arbitrary schemes, credentials or home expansion", () => {
  for (const text of ["[run](javascript:alert(1))", "`data:text/plain,a.ts`", "[secret](https://user:pass@example.com)", "`~/private/a.ts`", "`custom:a.ts`"]) {
    assert.equal(splitQuestionReferences(text).some(part => part.href), false, text);
  }
});

test("URL clipping can reuse each client's existing prose boundary", () => {
  const parts = splitQuestionReferences("https://example.com/a（说明）", raw => raw.slice(0, raw.indexOf("（")));
  assert.deepEqual(parts, [{ text: "https://example.com/a", href: "https://example.com/a" }, { text: "（说明）" }]);
});

test("absolute question file candidates stay within the original Workspace", () => {
  assert.equal(questionWorkspaceReference("D:\\repo\\src\\file.ts:12-14", "D:\\repo"), "src/file.ts:12");
  assert.equal(questionWorkspaceReference("file:///work/my%20project/a.ts:4:2", "/work"), "my%20project/a.ts:4:2");
  for (const href of ["D:\\other\\a.ts", "D:\\repo-other\\a.ts", "D:\\repo\\..\\private\\a.ts", "../private.ts", "%2e%2e/private.ts", "file://other/work/a.ts"]) {
    assert.equal(questionWorkspaceReference(href, "D:\\repo"), undefined, href);
  }
  assert.equal(questionWorkspaceReference("/work/a.ts"), undefined);
});
