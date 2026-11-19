import { createHash, randomUUID } from "node:crypto";

import { create } from "@bufbuild/protobuf";
import { BlobDisposition, EntityKind, InputPartSchema, OperationMutationSchema, RunState } from "@joko/contracts";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { chromium, type Browser } from "playwright-core";
import { expect, it } from "vitest";

import { OrchestratorE2eFixture, waitFor } from "./fixture.js";
import {
  createSessionMutation, pauseQueueMutation, queueItemFrom, resumeQueueMutation, sendInputMutation,
  sessionIdFrom, setQueueItemEditLockMutation, submit
} from "./operations.js";

const browserPath = process.env.JOKO_BROWSER_EXECUTABLE?.trim();
const webDirectory = process.env.JOKO_MOUNTED_WEB_DIR?.trim();
const mountedIt = browserPath && webDirectory ? it : it.skip;

mountedIt("adds, replaces, and clears queued attachments in place before dispatch", { timeout: 120_000 }, async () => {
  const profile = { ...PI_LIKE_PROFILE, capabilities: [...PI_LIKE_PROFILE.capabilities, { key: "input.file", supported: true }] };
  let fixture: OrchestratorE2eFixture | undefined;
  let browser: Browser | undefined;
  try {
    fixture = await OrchestratorE2eFixture.start({ profiles: [profile], webDirectory });
    const { clients, authKey, connectionId } = await fixture.pair("Queue attachments Owner");
    const mutate = (mutation: Parameters<typeof submit>[2]) => submit(clients.operation, connectionId, mutation);
    const sessionId = sessionIdFrom(await mutate(createSessionMutation({
      backendId: profile.id, targetId: fixture.targetId(profile.id), displayName: "Queued attachment edits",
      providerId: "vision", modelId: "multimodal"
    })));
    const control = async () => (await clients.queue.getQueueControl({ sessionId })).queueControl!;
    await mutate(pauseQueueMutation(await control()));
    const generation = BigInt(fixture.application.store.getSession(sessionId).descriptor.binding.generation);
    const originalBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk2gAAAAASUVORK5CYII=", "base64");
    const begin = await clients.artifact.beginBlobUpload({
      fileName: "original.png", mediaType: "image/png", byteSize: BigInt(originalBytes.length),
      sha256Hex: createHash("sha256").update(originalBytes).digest("hex"), disposition: BlobDisposition.ATTACHMENT
    });
    const upload = begin.upload!;
    const uploaded = await fetch(new URL(upload.ticket!.relativeEndpoint, fixture.baseUrl), {
      method: "PUT", headers: { authorization: `Bearer ${authKey}`, "content-type": "application/octet-stream" }, body: originalBytes
    });
    expect(uploaded.ok).toBe(true);
    const originalBlob = (await clients.artifact.completeBlobUpload({ uploadId: upload.uploadId })).blob!;
    const send = sendInputMutation(sessionId, generation, "This input keeps its queue position.");
    if (send.payload.case !== "sendInput" || send.payload.value.input === undefined) throw new Error("The queue source has no input.");
    send.payload.value.input.parts.push(create(InputPartSchema, { content: { case: "image", value: { blob: originalBlob, altText: "original.png" } } }));
    const first = queueItemFrom(await mutate(send));
    const follower = queueItemFrom(await mutate(sendInputMutation(sessionId, generation, "Unchanged later input")));
    const stored = () => fixture!.application.store.getQueueItem(first.queueItemId);
    const firstIdentity = { runId: stored().runId, operationId: stored().operationId, createdAt: stored().createdAt,
      position: stored().position, disposition: stored().disposition };

    const device = "Queue attachments Browser";
    const challenge = (await fixture.anonymous.connection.beginPairing({ deviceDisplayName: device })).challenge!;
    browser = await chromium.launch({ executablePath: browserPath!, headless: true });
    const page = await browser.newPage({ locale: "en-US", viewport: { width: 1440, height: 960 } });
    await page.goto(`${fixture.baseUrl}/#/tasks/${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.locator("details.device-authorization__manual > summary").click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challengeId));
    await page.getByLabel("Device name").fill(device);
    await page.locator("form.pair-form button[type=submit]").click();

    const row = page.locator(`[data-queue-item-id="${first.queueItemId}"]`);
    const editor = row.locator("form.queue-strip__editor");
    const editButton = row.getByRole("button", { name: "Edit queued input", exact: true });
    const findPublic = async () => (await clients.queue.listQueueItems({ sessionId })).queueItems.find(item => item.queueItemId === first.queueItemId);
    const openEditor = async () => {
      await waitFor(async () => {
        const item = await findPublic();
        const browser = await editButton.evaluateAll(nodes => nodes.map(node => ({ disabled: (node as HTMLButtonElement).disabled,
          reason: node.closest(".tip-anchor--disabled")?.getAttribute("aria-label") })));
        const leaseOps = fixture!.application.store.listOperations({ limit: 24 }).filter(operation => operation.kind === "setQueueItemEditLock")
          .map(({ status, error }) => {
            const details = error !== null && typeof error === "object" ? error : {};
            return { status, code: "code" in details && typeof details.code === "string" ? details.code : undefined,
              message: "message" in details && typeof details.message === "string" ? details.message : undefined };
          });
        return { publicItem: item === undefined ? undefined : { editLocked: item.editLocked, state: item.state, mode: item.deliveryMode }, browser, leaseOps };
      }, value => value.publicItem?.editLocked === false && value.browser[0]?.disabled === false, "the original queued input to be editable again");
      await editButton.click();
    };
    const saveButton = editor.getByRole("button", { name: "Save", exact: true });
    const remove = (name: string) => editor.getByRole("button", { name: `Remove ${name} from queued input`, exact: true }).click();
    const pick = async (name: string, content: string): Promise<void> => {
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser"), editor.getByRole("button", { name: "Attach image or file", exact: true }).click()
      ]);
      await chooser.setFiles({ name, mimeType: "text/plain", buffer: Buffer.from(content) });
    };
    const attachmentNames = () => [...stored().body.images, ...stored().body.files].map(part => part.blob.fileName);
    const expectSaved = async (names: readonly string[]): Promise<void> => {
      await editor.waitFor({ state: "hidden" });
      expect(attachmentNames()).toEqual(names);
      expect(stored()).toMatchObject(firstIdentity);
      expect(fixture!.application.store.listQueueItems({ sessionId, states: ["accepted"] }).map(item => item.id))
        .toEqual([first.queueItemId, follower.queueItemId]);
    };
    await openEditor();
    await pick("retained.txt", "The retained file.");
    await saveButton.click();
    await expectSaved(["original.png", "retained.txt"]);
    expect(stored().body.images[0]?.blob.id).toBe(originalBlob.blobId);

    await openEditor();
    await remove("original.png");
    await pick("replacement.txt", "The replacement file.");
    await page.route("**/v1/blobs/upload/**", route => route.fulfill({ status: 503 }), { times: 1 });
    const uploadFailure = page.waitForResponse(response => response.status() === 503 && response.request().method() === "PUT");
    await saveButton.click();
    await uploadFailure;
    expect(attachmentNames()).toEqual(["original.png", "retained.txt"]);
    await editor.getByText("replacement.txt", { exact: true }).waitFor();
    await saveButton.click();
    await expectSaved(["retained.txt", "replacement.txt"]);

    await openEditor();
    await remove("retained.txt");
    await remove("replacement.txt");
    await saveButton.click();
    await expectSaved([]);
    expect(stored().body.text).toBe("This input keeps its queue position.");

    const finalText = "Only this file may reach the Backend.";
    await openEditor();
    await editor.getByRole("textbox", { name: "Queued input text", exact: true }).fill("");
    expect(await saveButton.isDisabled()).toBe(true);
    await pick("final.txt", finalText);
    await saveButton.click();
    await expectSaved(["final.txt"]);
    expect(stored().body.text).toBe("");
    expect(fixture.adapter(profile.id).sendCalls).toHaveLength(0);

    const current = (await waitFor(findPublic, item => item !== undefined && !item.editLocked, "the saved Queue lock to release"))!;
    const lockToken = randomUUID();
    await mutate(setQueueItemEditLockMutation(current, lockToken, true));
    const actualBlob = current.input?.parts.find(part => part.content.case === "file")?.content;
    if (actualBlob?.case !== "file") throw new Error("The saved input has no Blob.");
    const edit = create(OperationMutationSchema, {
      preconditions: [{ entity: { kind: EntityKind.QUEUE_ITEM, id: current.queueItemId },
        expectedRevision: current.version!.revision, expectedGeneration: current.version!.generation }],
      payload: { case: "editQueueItem", value: { queueItemId: current.queueItemId, lockToken,
        input: { parts: [{ content: { case: "file", value: { ...actualBlob.value, sha256Hex: "0".repeat(64) } } }] } } }
    });
    await expect(mutate(edit)).rejects.toThrow("completed attachment upload");
    const version = edit.preconditions[0]!;
    version.expectedRevision = { ...version.expectedRevision!, value: version.expectedRevision!.value - 1n };
    await expect(mutate(edit)).rejects.toThrow("Revision precondition failed");
    expect(attachmentNames()).toEqual(["final.txt"]);
    await mutate(setQueueItemEditLockMutation(current, lockToken, false));

    await browser.close();
    browser = undefined;
    const rootDirectory = fixture.rootDirectory;
    await fixture.close({ removeRoot: false });
    fixture = await OrchestratorE2eFixture.start({ profiles: [profile], webDirectory, rootDirectory });
    expect(stored()).toMatchObject(firstIdentity);
    expect(attachmentNames()).toEqual(["final.txt"]);
    expect(fixture.application.store.getArtifact(originalBlob.blobId).blob.sha256).toBe(originalBlob.sha256Hex);
    const recovered = fixture.clients(authKey);
    const restoredControl = (await recovered.queue.getQueueControl({ sessionId })).queueControl!;
    await submit(recovered.operation, connectionId, resumeQueueMutation(restoredControl));
    await waitFor(() => recovered.run.getRun({ runId: first.runId }), value => value.run?.state === RunState.SUCCEEDED, "the in-place edited Run");
    const sent = fixture.adapter(profile.id).sendCalls[0];
    expect(sent).toMatchObject({ text: "", images: [], files: [{ blob: { id: actualBlob.value.blobId,
      fileName: "final.txt", sha256: createHash("sha256").update(finalText).digest("hex") } }] });
    const { ticket } = await recovered.artifact.getBlobDownloadTicket({ blobId: actualBlob.value.blobId });
    const downloaded = await fetch(new URL(ticket!.relativeEndpoint, fixture.baseUrl), { headers: { authorization: `Bearer ${authKey}` } });
    expect(downloaded.ok).toBe(true);
    expect(await downloaded.text()).toBe(finalText);
  } finally {
    await browser?.close();
    await fixture?.close({ removeRoot: true });
  }
});
