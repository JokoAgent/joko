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
