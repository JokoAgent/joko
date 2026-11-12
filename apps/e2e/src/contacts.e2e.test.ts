import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { ContactKind, ContactSource, ContactStatus, ContactVCardImportDisposition } from "@joko/contracts";
import { chromium, type Browser } from "playwright-core";
import { afterEach, expect, it } from "vitest";
import { OrchestratorE2eFixture } from "./fixture.js";

const mountedIt = process.env.JOKO_BROWSER_EXECUTABLE?.trim() && process.env.JOKO_MOUNTED_WEB_DIR?.trim() ? it : it.skip;
let fixture: OrchestratorE2eFixture | undefined;
let browser: Browser | undefined;
let rootDirectory: string | undefined;

afterEach(async () => {
  await browser?.close();
  browser = undefined;
  await fixture?.close({ removeRoot: false });
  fixture = undefined;
  if (rootDirectory !== undefined) await rm(rootDirectory, { recursive: true, force: true, maxRetries: 3 });
  rootDirectory = undefined;
});

mountedIt("imports valid cards beside rejected cards and shows an all-invalid result without effects", { timeout: 90_000 }, async () => {
  fixture = await OrchestratorE2eFixture.start({ webDirectory: resolve(process.env.JOKO_MOUNTED_WEB_DIR!) });
  rootDirectory = fixture.rootDirectory;
  const { clients: { contact } } = await fixture.pair("Contact import observer");
  const initial = (await contact.getContactDirectory({})).directory!;
  await contact.setContactDirectoryEnabled({ expectedDirectoryRevision: initial.revision, enabled: true });
  browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: "en-US" });
  const challenge = (await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Contacts importer" })).challenge!;
  await page.goto(`${fixture.baseUrl}/#/settings/contacts`, { waitUntil: "domcontentloaded" });
  await page.locator(".connection-tabs > button").nth(2).click();
  await page.locator("details.device-authorization__manual > summary").click();
  await page.getByLabel("Joko node address").fill(fixture.baseUrl);
  await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challengeId));
  await page.getByLabel("Device name").fill("Contacts importer");
  await page.locator("form.pair-form button[type=submit]").click();
  const upload = page.locator(".contacts-settings__file");
  await upload.waitFor({ state: "attached", timeout: 20_000 });
  expect(await page.getByRole("button", { name: "Import from macOS Contacts", exact: true }).count()).toBe(0);
  const card = (...fields: string[]) => ["BEGIN:VCARD", "VERSION:3.0", ...fields, "END:VCARD", ""].join("\r\n");
  await upload.setInputFiles({ name: "mixed.vcf", mimeType: "text/vcard",
    buffer: Buffer.from(card(`FN:${"x".repeat(101)}`) + card("FN:Bob", "EMAIL:bob@example.test")) });
  const preview = page.getByRole("dialog", { name: "Review vCard import", exact: true });
  await preview.getByText("Contact display name is invalid.", { exact: true }).waitFor({ state: "visible" });
  expect(await preview.locator(".contact-import-list article").count()).toBe(2);
  const rejected = preview.locator("article").filter({ hasText: "Invalid contact — will be skipped" });
  expect(await rejected.locator("input, select, button").count()).toBe(0);
  expect(await preview.locator(".contact-import-list__decision").count()).toBe(1);
  await preview.getByRole("button", { name: "Import contacts", exact: true }).focus();
  await page.keyboard.press("Enter");
  const result = page.getByRole("dialog", { name: "vCard import complete", exact: true });
  await result.getByText("Created 1, enriched 0, skipped 1.", { exact: true }).waitFor({ state: "visible" });
  await result.getByText("Contact display name is invalid.", { exact: true }).waitFor({ state: "visible" });
  expect((await contact.listContacts({})).contacts.map(entry => entry.displayName)).toEqual(["Bob"]);
  await result.getByRole("button", { name: "Close", exact: true }).last().click();

  const beforeRejectedOnly = (await contact.getContactDirectory({})).directory!;
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  const closeNavigation = page.getByLabel("Task navigation").getByRole("button", { name: "Close navigation" });
  if (await closeNavigation.isVisible()) await closeNavigation.click();
  await upload.setInputFiles({ name: "invalid.vcf", mimeType: "text/vcard", buffer: Buffer.from(
    card(`FN:${"y".repeat(101)}`) + card("FN:Bad title", "ORG:Example", `TITLE:${"x".repeat(1_001)}`)) });
  await preview.getByText("Contact relation note is invalid.", { exact: true }).waitFor({ state: "visible" });
  expect(await preview.locator(".contact-import-list__decision").count()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await preview.getByRole("button", { name: "Import contacts", exact: true }).click();
  await result.getByText("Created 0, enriched 0, skipped 2.", { exact: true }).waitFor({ state: "visible" });
  expect(await result.locator(".contact-import-reason").count()).toBe(2);
  expect((await contact.getContactDirectory({})).directory).toEqual(beforeRejectedOnly);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});

it("serves and restarts the complete authenticated local Contact chain", async () => {
  fixture = await OrchestratorE2eFixture.start({ keepRoot: true });
  rootDirectory = fixture.rootDirectory;
  let paired = await fixture.pair("Contact settings window");
  let contact = paired.clients.contact;

  const initial = (await contact.getContactDirectory({})).directory!;
  expect(initial).toMatchObject({ revision: { value: 1n }, enabled: false, people: 0, organizations: 0 });
  const enabled = (await contact.setContactDirectoryEnabled({ expectedDirectoryRevision: initial.revision, enabled: true })).directory!;

  const created = await contact.createContact({
    expectedDirectoryRevision: enabled.revision,
    contact: {
      kind: ContactKind.PERSON,
      displayName: "Ada Lovelace",
      aliases: ["Augusta Ada King"],
      summary: "Computing pioneer",
      narrative: "Worked on the Analytical Engine.",
      agentNotes: "Private local note",
      status: ContactStatus.PENDING,
      source: ContactSource.MANUAL,
      identities: [{ platform: "email", value: "ada@example.test", label: "work", note: "" }]
    }
  });
  const personId = created.contact!.summary!.contactId;
  const confirmed = await contact.confirmContact({
    contactId: personId,
    expectedRevision: created.contact!.summary!.revision
  });
  let withEvent = await contact.appendContactEvent({
    contactId: personId,
    expectedContactRevision: confirmed.contact!.summary!.revision,
    event: { date: "1843-01-01", text: "Published notes", source: "archive" }
  });
  for (const source of [undefined, "", "   "]) {
    withEvent = await contact.appendContactEvent({ contactId: personId,
      expectedContactRevision: withEvent.contact!.summary!.revision,
      event: { date: "1842-10", text: "Month precision with optional source", ...(source === undefined ? {} : { source }) } });
  }
  expect(withEvent.contact!.events.filter(event => event.text === "Month precision with optional source"))
    .toEqual(Array.from({ length: 3 }, () => expect.objectContaining({ date: "1842-10", source: "" })));
  const group = await contact.createContactGroup({
    expectedDirectoryRevision: withEvent.directory!.revision,
    name: "Computing pioneers",
    description: "Early computing contributors"
  });
  const grouped = await contact.setContactGroupMembership({
    contactId: personId,
    expectedContactRevision: withEvent.contact!.summary!.revision,
    contactGroupId: group.group!.contactGroupId,
    member: true
  });
  const organization = await contact.createContact({
    expectedDirectoryRevision: grouped.directory!.revision,
    contact: {
      kind: ContactKind.ORGANIZATION,
      displayName: "Analytical Engines",
      aliases: [],
      summary: "Research organization",
      narrative: "",
      agentNotes: "",
      status: ContactStatus.CONFIRMED,
      source: ContactSource.MANUAL,
      identities: []
    }
  });
  const related = await contact.addContactRelation({
    fromContactId: personId,
    expectedFromRevision: grouped.contact!.summary!.revision,
    toContactId: organization.contact!.summary!.contactId,
    relation: "works at",
    note: "Relationshipkeyword 通讯录设计方案"
  });
  for (const query of ["Engines", "Relationshipkeyword", "设计方案"]) {
    const found = await contact.listContacts({ query, pageSize: 100 });
    expect(found.total).toBe(2);
    expect(new Set(found.contacts.map((entry) => entry.contactId)))
      .toEqual(new Set([personId, organization.contact!.summary!.contactId]));
  }
  const filtered = await contact.listContacts({ query: "设计方案", kind: ContactKind.PERSON,
    status: ContactStatus.CONFIRMED, contactGroupId: group.group!.contactGroupId, pageSize: 1 });
  expect(filtered).toMatchObject({ total: 1, contacts: [{ contactId: personId }] });
  expect(filtered.nextPageOffset).toBeUndefined();

  const preview = await contact.previewContactVCardImport({
    vcardText: "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ada L.\r\nEMAIL:ada@example.test\r\nEND:VCARD\r\n"
  });
  expect(preview.entries).toEqual([expect.objectContaining({
    disposition: ContactVCardImportDisposition.AUTO_ENRICH,
    existingContactId: personId
  })]);
  const imported = await contact.commitContactVCardImport({
    previewId: preview.previewId,
    expectedDirectoryRevision: preview.directoryRevision,
    decisions: []
  });
  expect(imported).toMatchObject({
    created: 0,
    enriched: 1,
    skipped: 0,
    contactIds: [personId],
    entries: [{ displayName: "Ada L.", outcome: 2, contactId: personId }]
  });
  const exported = await contact.exportContactsVCard({ contactIds: [personId] });
  expect(exported.vcardText).toContain("FN:Ada Lovelace");
  expect(exported.vcardText).toContain("EMAIL;TYPE=WORK:ada@example.test");
  expect(exported.vcardText).not.toContain("Private local note");

  await fixture.close({ removeRoot: false });
  fixture = await OrchestratorE2eFixture.start({ rootDirectory });
  paired = await fixture.pair("Restarted Contact settings window");
  contact = paired.clients.contact;
  const restartedDirectory = (await contact.getContactDirectory({})).directory!;
  expect(restartedDirectory).toMatchObject({ enabled: true, people: 1, organizations: 1, groups: 1, pending: 0 });
  const restarted = (await contact.getContact({ contactId: personId })).contact!;
  expect(restarted).toMatchObject({
    summary: { contactId: personId, aliases: expect.arrayContaining(["Augusta Ada King", "Ada L."]), status: ContactStatus.CONFIRMED },
    identities: [expect.objectContaining({ normalizedValue: "ada@example.test" })],
    events: expect.arrayContaining([expect.objectContaining({ text: "Published notes" }),
      expect.objectContaining({ date: "1842-10", text: "Month precision with optional source", source: "" })]),
    groups: [expect.objectContaining({ name: "Computing pioneers" })],
    relations: [expect.objectContaining({ relatedDisplayName: "Analytical Engines", relation: "works at" })]
  });
  expect(related.directory!.revision!.value).toBeLessThan(restartedDirectory.revision!.value);
  expect((await contact.listContacts({ query: "设计方案", kind: ContactKind.PERSON })).contacts)
    .toEqual([expect.objectContaining({ contactId: personId })]);
});

mountedIt("refreshes the mounted Contacts list and selected profile after another client writes", { timeout: 90_000 }, async () => {
  fixture = await OrchestratorE2eFixture.start({ webDirectory: resolve(process.env.JOKO_MOUNTED_WEB_DIR!) });
  rootDirectory = fixture.rootDirectory;
  const { clients: { contact } } = await fixture.pair("Contact editor");
  const initial = (await contact.getContactDirectory({})).directory!;
  const enabled = (await contact.setContactDirectoryEnabled({ expectedDirectoryRevision: initial.revision, enabled: true })).directory!;
  const original = (await contact.createContact({ expectedDirectoryRevision: enabled.revision,
    contact: { kind: ContactKind.PERSON, displayName: "Ada Lovelace", summary: "Original summary" }
  })).contact!.summary!;

  browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: "en-US" });
  const challenge = (await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Contacts viewer" })).challenge!;
  await page.goto(`${fixture.baseUrl}/#/settings/contacts`, { waitUntil: "domcontentloaded" });
  await page.locator(".connection-tabs > button").nth(2).click();
  await page.locator("details.device-authorization__manual > summary").click();
  await page.getByLabel("Joko node address").fill(fixture.baseUrl);
  await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challengeId));
  await page.getByLabel("Device name").fill("Contacts viewer");
  await page.locator("form.pair-form button[type=submit]").click();
  const panel = page.locator(".contacts-settings");
  const details = panel.locator(".contact-detail");
  await details.getByText("Original summary", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });

  const updated = await contact.updateContact({ contactId: original.contactId, expectedRevision: original.revision,
    patch: { summary: "Updated from a separate connection" } });
  await contact.createContactGroup({ expectedDirectoryRevision: updated.directory!.revision, name: "Computing pioneers" });
  const selected = panel.locator(".contacts-list__item[aria-pressed=true]");
  await selected.getByText("Updated from a separate connection", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  await details.getByText("Updated from a separate connection", { exact: true }).waitFor({ state: "visible" });
  await panel.locator("option").filter({ hasText: "Computing pioneers" }).waitFor({ state: "attached" });
  expect(await panel.locator(".contacts-directory-card__stats").textContent()).toMatch(/1\s*Groups/u);

  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  for (const [width, date, source] of [[1440, "2026-10", ""], [390, "2026-10-12", "meeting"]] as const) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
    const closeNavigation = page.getByLabel("Task navigation").getByRole("button", { name: "Close navigation" });
    if (await closeNavigation.isVisible()) await closeNavigation.click();
    const events = details.locator(".contact-detail__section").filter({ has: page.getByRole("heading", { name: "Events", exact: true }) });
    await events.getByRole("button", { name: "Add", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add event", exact: true });
    await dialog.getByLabel("Date", { exact: true }).fill(date);
    await dialog.getByLabel("Event", { exact: true }).fill(`Recorded ${date}`);
    if (source !== "") await dialog.getByLabel("Source", { exact: true }).fill(source);
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await events.getByText(`Recorded ${date}`, { exact: true }).waitFor({ state: "visible" });
    expect(await events.locator(`time[datetime="${date}"]`).textContent()).toBe(date);
  }
  const afterEvents = (await contact.getContact({ contactId: original.contactId })).contact!;
  expect(afterEvents.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ date: "2026-10", text: "Recorded 2026-10", source: "" }),
    expect.objectContaining({ date: "2026-10-12", text: "Recorded 2026-10-12", source: "meeting" })
  ]));
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await contact.deleteContact({ contactId: original.contactId, expectedRevision: afterEvents.summary!.revision });
  await details.getByText("Select a contact", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  expect(await selected.count()).toBe(0);
});

mountedIt("merges unrelated names from Contact details only after reviewing both current records", { timeout: 90_000 }, async () => {
  fixture = await OrchestratorE2eFixture.start({ webDirectory: resolve(process.env.JOKO_MOUNTED_WEB_DIR!) });
  const dataRoot = fixture.rootDirectory;
  rootDirectory = dataRoot;
  const { clients: { contact } } = await fixture.pair("Contact merge observer");
  const directory = async () => (await contact.getContactDirectory({})).directory!;
  await contact.setContactDirectoryEnabled({ expectedDirectoryRevision: (await directory()).revision, enabled: true });
  const createContact = async (displayName: string, kind: ContactKind, email?: string) => (await contact.createContact({
    expectedDirectoryRevision: (await directory()).revision,
    contact: { kind, displayName, ...(email === undefined ? {} : { identities: [{ platform: "email", value: email }] }) }
  })).contact!.summary!;
  const targetId = (await createContact("张三", ContactKind.PERSON, "target@example.test")).contactId;
  const sourceId = (await createContact("Alex", ContactKind.PERSON, "source@example.test")).contactId;
  const orgId = (await createContact("Northwind", ContactKind.ORGANIZATION)).contactId;
  const read = async (contactId: string) => (await contact.getContact({ contactId })).contact!;
  const group = (await contact.createContactGroup({ expectedDirectoryRevision: (await directory()).revision, name: "Colleagues" })).group!;
  await contact.setContactGroupMembership({ contactId: sourceId, expectedContactRevision: (await read(sourceId)).summary!.revision,
    contactGroupId: group.contactGroupId, member: true });
  await contact.appendContactEvent({ contactId: sourceId, expectedContactRevision: (await read(sourceId)).summary!.revision,
    event: { date: "2026-09", text: "Mentor meeting" } });
  await contact.addContactRelation({ fromContactId: sourceId, expectedFromRevision: (await read(sourceId)).summary!.revision,
    toContactId: orgId, relation: "works at", note: "Product team" });
  expect((await contact.scanContactDuplicates({})).pairs).toEqual([]);

  browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: "en-US" });
  const challenge = (await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Contacts merge window" })).challenge!;
  await page.goto(`${fixture.baseUrl}/#/settings/contacts`, { waitUntil: "domcontentloaded" });
  await page.locator(".connection-tabs > button").nth(2).click();
  await page.locator("details.device-authorization__manual > summary").click();
  await page.getByLabel("Joko node address").fill(fixture.baseUrl);
  await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challengeId));
  await page.getByLabel("Device name").fill("Contacts merge window");
  await page.locator("form.pair-form button[type=submit]").click();

  const catalog = page.locator(".contacts-catalog");
  await catalog.getByRole("textbox", { name: "Search", exact: true }).fill("张三");
  await catalog.getByRole("button", { name: "Search", exact: true }).click();
  const details = page.locator(".contact-detail");
  await details.getByRole("heading", { name: "张三", exact: true }).waitFor({ state: "visible" });
  await catalog.getByRole("button", { name: /^Alex/u }).waitFor({ state: "hidden" });
  const opener = details.getByRole("button", { name: "Merge into this contact", exact: true });
  const picker = page.getByRole("dialog", { name: "Choose a contact to merge", exact: true });
  const search = picker.getByRole("searchbox", { name: "Search contacts to merge", exact: true });
  const confirmation = page.getByRole("alertdialog", { name: "Merge contacts?", exact: true });
  const merge = confirmation.getByRole("button", { name: "Merge contacts", exact: true });
  const selectSource = async (): Promise<void> => {
    await opener.click();
    await search.waitFor({ state: "visible" });
    expect(await search.evaluate(element => element === document.activeElement)).toBe(true);
    await search.fill("Alex");
    await search.press("Enter");
    await picker.getByRole("button", { name: /^Alex/u }).click();
    await confirmation.getByText("Keep 张三 and merge Alex into it? The merged record will be removed.", { exact: true })
      .waitFor({ state: "visible" });
  };

  const beforeCancel = await directory();
  await selectSource();
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await confirmation.waitFor({ state: "hidden" });
  expect(await picker.getByRole("button", { name: /^Alex/u }).evaluate(element => element === document.activeElement)).toBe(true);
  await page.keyboard.press("Escape");
  await picker.waitFor({ state: "hidden" });
  expect(await opener.evaluate(element => element === document.activeElement)).toBe(true);
  expect(await directory()).toEqual(beforeCancel);

  for (const [contactId, summary, label] of [
    [targetId, "Updated keeper", "Target contact"],
    [sourceId, "Updated source", "Merged contact"]
  ] as const) {
    await selectSource();
    await contact.updateContact({ contactId, expectedRevision: (await read(contactId)).summary!.revision, patch: { summary } });
    const beforeConflict = await directory();
    await merge.click();
    await confirmation.getByRole("alert").getByText(`${label} ${contactId} changed concurrently.`, { exact: false }).waitFor({ state: "visible" });
    expect(await merge.isDisabled()).toBe(true);
    expect(await directory()).toEqual(beforeConflict);
    expect((await read(sourceId)).events.map(event => event.text)).toContain("Mentor meeting");
    await confirmation.getByRole("button", { name: "Review current contacts", exact: true }).click();
    await picker.waitFor({ state: "hidden" });
    if (contactId === targetId) await details.getByText(summary, { exact: true }).waitFor({ state: "visible" });
  }

  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  const closeNavigation = page.getByLabel("Task navigation").getByRole("button", { name: "Close navigation" });
  if (await closeNavigation.isVisible()) await closeNavigation.click();
  await selectSource();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await merge.press("Enter");
  await confirmation.waitFor({ state: "hidden" });
  await details.getByText("Mentor meeting", { exact: true }).waitFor({ state: "visible" });
  const kept = await read(targetId);
  expect(kept).toMatchObject({
    summary: { contactId: targetId, displayName: "张三", summary: "Updated keeper", aliases: ["Alex"] },
    identities: expect.arrayContaining([
      expect.objectContaining({ contactId: targetId, value: "target@example.test" }),
      expect.objectContaining({ contactId: targetId, value: "source@example.test" })
    ]),
    events: [expect.objectContaining({ contactId: targetId, text: "Mentor meeting" })],
    groups: [expect.objectContaining({ contactGroupId: group.contactGroupId, memberCount: 1 })],
    relations: [expect.objectContaining({ fromContactId: targetId, toContactId: orgId, note: "Product team" })]
  });
  expect((await contact.listContacts({})).contacts.map(entry => entry.contactId).sort()).toEqual([targetId, orgId].sort());
  await browser.close();
  browser = undefined;
  await fixture.close({ removeRoot: false });
  fixture = await OrchestratorE2eFixture.start({ rootDirectory: dataRoot });
  const reopened = (await fixture.pair("Reopened merge observer")).clients.contact;
  expect((await reopened.getContact({ contactId: targetId })).contact).toEqual(kept);
  expect((await reopened.listContacts({})).contacts.map(entry => entry.contactId)).not.toContain(sourceId);
});
