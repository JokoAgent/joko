import { expect, it } from "vitest";
import { richAnswerText, richMediaNetworkUrl, richMediaWorkspacePath } from "@joko/contracts";
it("limits public media to unauthenticated HTTP and workspace media to its current root", () => {
  expect(richMediaNetworkUrl("https://example.org/clip.mp4?version=2")).toBe("https://example.org/clip.mp4?version=2");
  for (const value of ["https://user:password@example.org/a", "file:///secret", "javascript:alert(1)", "data:video/mp4,a", "//example.org/a"]) expect(richMediaNetworkUrl(value)).toBeUndefined();
  expect(richMediaWorkspacePath("file:///D:/Repo/media/one.mp4", "d:\\repo")).toBe("media/one.mp4");
  expect(richMediaWorkspacePath("./media/../one.wav", "/repo")).toBe("one.wav");
  for (const value of ["/repo-other/one.mp4", "../secret.mp3", "file://other/repo/one.mp4", "https://example.org/a", "file:///repo/%2e%2e/secret.mp4"]) expect(richMediaWorkspacePath(value, "/repo")).toBeUndefined();
});
it("copies meaningful rich answer text and preserves ordinary Markdown and nested protocol examples", () => {
  const source = 'Intro\n```joko-ui\n{"seq":1,"op":"create","id":"text","kind":"text","props":{"text":"Readable answer"}}\n```\nTail';
  expect(richAnswerText(source)).toContain("Readable answer");
  expect(richAnswerText(source)).not.toContain('"op"');
  const example = "````markdown\n" + source + "\n````";
  expect(richAnswerText(example)).toBe(example);
});
