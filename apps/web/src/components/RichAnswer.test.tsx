// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { RichAnswer } from "./RichAnswer.js";
import { StreamingMarkdown } from "./Timeline.js";
import type { Translator } from "./types.js";

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(async () => { await act(async () => root.render(null)); });
const line = (seq: number, value: object) => JSON.stringify({ seq, ...value }) + "\n";
const protocol = line(1, { op: "create", id: "months", kind: "range", props: { label: "Months", min: 1, max: 24, default: 6 } })
  + line(2, { op: "create", id: "cost", kind: "stat", props: { label: "Cost", value: { op: "mul", args: [{ ref: "months" }, 10] } } });

it("keeps edits while later model operations arrive and restores them for the exact message owner", async () => {
  const render = async (owner: string, source = protocol) => act(async () => root.render(<RichAnswer source={source} complete stateKey={owner} locale="en" renderMarkdown={text => <p>{text}</p>} />));
  await render("node/task/message-a");
  expect(host.textContent).toContain("60");
  const input = host.querySelector('input[type="range"]')! as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, "9"); input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(host.textContent).toContain("90");
  await render("node/task/message-a", protocol + line(3, { op: "patch", id: "months", props: { default: 12 } }));
  expect(host.textContent).toContain("90");
  await render("other-node/task/message-a"); expect(host.textContent).toContain("60");
  await render("node/task/message-a"); expect(host.textContent).toContain("90");
});

it("renders only assistant answer fences and leaves fenced teaching examples as code", async () => {
  const t = ((key: string) => key) as Translator;
  const source = "Before\n```joko-ui\n" + protocol + "```\nAfter";
  await act(async () => root.render(<StreamingMarkdown text={source} streaming={false} streamFadeKey="session/answer" t={t} />));
  expect(host.querySelector('input[type="range"]')).not.toBeNull();
  expect(host.textContent).not.toContain('"op":"create"');
  await act(async () => root.render(<StreamingMarkdown text={source} streaming={false} t={t} />));
  expect(host.querySelector('input[type="range"]')).toBeNull();
  await act(async () => root.render(<StreamingMarkdown text={"````markdown\n" + source + "\n````"} streaming={false} streamFadeKey="teaching" t={t} />));
  expect(host.querySelector('input[type="range"]')).toBeNull();
  expect(host.textContent).toContain('"op":"create"');
});
