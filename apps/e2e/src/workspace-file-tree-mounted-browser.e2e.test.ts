import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { RunState, WorkspaceEntryListingPolicy } from "@joko/contracts";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { chromium, type Browser } from "playwright-core";
import { expect, it } from "vitest";

import { OrchestratorE2eFixture, waitFor } from "./fixture.js";
import { createSessionMutation, sessionIdFrom, submit } from "./operations.js";

const browserPath = process.env.JOKO_BROWSER_EXECUTABLE?.trim();
const webDirectory = process.env.JOKO_MOUNTED_WEB_DIR?.trim();
const mountedIt = browserPath && webDirectory ? it : it.skip;

mountedIt("restores the Files visibility preference and keeps a sent file quote out of the task draft", { timeout: 90_000 }, async () => {
  const profile = { ...PI_LIKE_PROFILE, capabilities: [...PI_LIKE_PROFILE.capabilities, { key: "workspace.files", supported: true }] };
  let fixture: OrchestratorE2eFixture | undefined;
  let browser: Browser | undefined;
  try {
    fixture = await OrchestratorE2eFixture.start({ profiles: [profile], webDirectory });
    const root = fixture.workspaceDirectory;
    for (const parent of ["build", "src/bin", ".svn", ".git"]) await mkdir(join(root, parent), { recursive: true });
    const body = "This project note is inside an ignored source directory.";
    await Promise.all([
      writeFile(join(root, "build", "generated.txt"), "Generated summary"),
      writeFile(join(root, "build", "generated.txt.meta"), "Hidden metadata"),
      writeFile(join(root, "src", "bin", "note.txt"), body)
    ]);
    const manager = await fixture.pair("Files tree Owner");
    const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId, createSessionMutation({
      backendId: profile.id, targetId: fixture.targetId(profile.id), displayName: "Files visibility test"
    })));
    const list = (parentRelativePath: string, listingPolicy: WorkspaceEntryListingPolicy) => manager.clients.workspace.listWorkspaceEntries({
      workspaceId: "workspace-main", parentRelativePath, includeHidden: true, listingPolicy
    });
    const shown = WorkspaceEntryListingPolicy.DOCUMENT_TREE_SHOW_IGNORED;
    const current = WorkspaceEntryListingPolicy.DOCUMENT_TREE;
    expect((await list("", current)).entries.map(entry => entry.relativePath)).not.toContain("build");
    const visible = (await list("", shown)).entries.map(entry => entry.relativePath);
    expect(visible).toEqual(expect.arrayContaining(["build", "src", "README.md"]));
    expect(visible).not.toContain(".git");
    expect(visible).not.toContain(".svn");
    expect((await list("build", shown)).entries.map(entry => entry.relativePath)).toEqual(["build/generated.txt"]);
    expect((await list("src", current)).entries).toEqual([]);
    expect((await list("src", shown)).entries.map(entry => entry.relativePath)).toEqual(["src/bin"]);

    const device = "Files tree Browser";
    const challenge = (await fixture.anonymous.connection.beginPairing({ deviceDisplayName: device })).challenge!;
    browser = await chromium.launch({ executablePath: browserPath!, headless: true });
    const page = await browser.newPage({ locale: "en-US", viewport: { width: 1440, height: 960 } });
    await page.goto(`${fixture.baseUrl}/#/files/${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Add Joko node", exact: true }).click();
    await page.locator("details.device-authorization__manual > summary").click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challengeId));
    await page.getByLabel("Device name").fill(device);
    await page.locator("form.pair-form button[type=submit]").click();

    const toggle = page.getByRole("button", { name: "Show ignored directories", exact: true });
    const row = (path: string) => page.locator(`[data-workspace-tree-row][data-relative-path="${path}"]`);
    await row("README.md").waitFor({ state: "visible" });
    expect(await toggle.getAttribute("aria-pressed")).toBe("false");
    expect(await row("build").count()).toBe(0);
    await toggle.click();
    await row("build").waitFor({ state: "visible" });
    expect(await toggle.getAttribute("aria-pressed")).toBe("true");
    await row("src").click();
    await row("src/bin").click();
    await row("src/bin/note.txt").click();
    const document = page.locator(".workspace-files-route__document");
    await document.getByText(body, { exact: true }).waitFor({ state: "visible" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Saved nodes", exact: true }).click();
    await page.locator(".connection-card .profile-card").filter({ hasText: fixture.baseUrl })
      .getByRole("button", { name: "Connect", exact: true }).click();
    await row("build").waitFor({ state: "visible" });
    expect(await toggle.getAttribute("aria-pressed")).toBe("true");
    await document.getByText(body, { exact: true }).waitFor({ state: "visible" });

    await toggle.click();
    await row("build").waitFor({ state: "hidden" });
    await row("README.md").waitFor({ state: "visible" });
    expect(await row("src/bin").count()).toBe(0);
    expect(await toggle.getAttribute("aria-pressed")).toBe("false");
    expect(await document.getByText(body, { exact: true }).isVisible()).toBe(true);

    const editor = document.locator(".cm-content");
    await editor.click();
    await editor.press("ControlOrMeta+a");
    await editor.dispatchEvent("mouseup", { bubbles: true });
    await page.locator(".selection-quote-actions").getByRole("button", { name: "Add to chat", exact: true }).click();
    const filesPane = page.locator(".session-pane--files-rail");
    await filesPane.locator(".composer-rich-editor__content [data-selection-quote-chip]").getByText(body, { exact: true }).waitFor();
    const store = fixture.application.store;
    await filesPane.locator(".send-button").click();
    const accepted = await waitFor(async () => store.listQueueItems({ sessionId })[0], value => value !== undefined, "the original file quote");
    if (accepted === undefined) throw new Error("The file quote did not reach the task queue.");
    expect(accepted.body.quotesEncoded).toBe(true);
    expect(accepted.body.text).toContain("src/bin/note.txt");
    expect(accepted.body.text).toContain(body);
    await waitFor(() => manager.clients.run.getRun({ runId: accepted.runId }), value => value.run?.state === RunState.SUCCEEDED,
      "the task's original file quote to settle");

    await page.locator(".workspace-files-sidebar__back-slot button").click();
    const task = page.locator(`.session-pane:not(.session-pane--files-rail)[data-input-session-id="${sessionId}"]`);
    const draft = task.locator(".composer-rich-editor__content");
    await draft.focus();
    await draft.press("ControlOrMeta+End");
    const freshPrompt = "New task input after leaving Files";
    await page.keyboard.insertText(freshPrompt);
    expect(await draft.locator("[data-selection-quote-chip]").count()).toBe(0);
    await task.locator(".send-button").click();
    const next = await waitFor(async () => store.listQueueItems({ sessionId }).find(item => item.runId !== accepted.runId),
      value => value !== undefined, "the new input from the same task");
    expect(next?.body.text).toBe(freshPrompt);
    expect(next?.body.quotesEncoded).not.toBe(true);
  } finally {
    await browser?.close();
    await fixture?.close();
  }
});
