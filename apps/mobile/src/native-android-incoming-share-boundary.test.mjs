import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const project = new URL("../", import.meta.url);
const app = JSON.parse(readFileSync(new URL("app.json", project), "utf8")).expo;
const moduleConfig = JSON.parse(readFileSync(
  new URL("modules/joko-incoming-share/expo-module.config.json", project),
  "utf8"
));
const manifest = readFileSync(
  new URL("modules/joko-incoming-share/android/src/main/AndroidManifest.xml", project),
  "utf8"
);
const receiver = readFileSync(
  new URL(
    "modules/joko-incoming-share/android/src/main/java/app/joko/incomingshare/JokoShareReceiverActivity.kt",
    project
  ),
  "utf8"
);
const store = readFileSync(
  new URL(
    "modules/joko-incoming-share/android/src/main/java/app/joko/incomingshare/IncomingShareStore.kt",
    project
  ),
  "utf8"
);
const moduleSource = readFileSync(
  new URL(
    "modules/joko-incoming-share/android/src/main/java/app/joko/incomingshare/JokoIncomingShareModule.kt",
    project
  ),
  "utf8"
);
const bridge = readFileSync(new URL("src/mobile-incoming-share.ts", project), "utf8");
const surface = readFileSync(new URL("src/App.tsx", project), "utf8");
const messages = readFileSync(new URL("src/mobile-task-messages.ts", project), "utf8");

describe("Android incoming-share native boundary", () => {
  it("declares one exported non-browsable stream receiver without competing Expo MainActivity filters", () => {
    const sharing = app.plugins.find((entry) => Array.isArray(entry) && entry[0] === "expo-sharing");
    expect(sharing?.[1]?.android).toEqual({ enabled: false });
    expect(moduleConfig.android).toEqual({
      modules: ["app.joko.incomingshare.JokoIncomingShareModule"]
    });
    expect(manifest).toContain('android:name="app.joko.incomingshare.JokoShareReceiverActivity"');
    expect(manifest).toContain('android:exported="true"');
    expect(manifest).toContain('android:launchMode="standard"');
    expect(manifest.match(/android\.intent\.action\.SEND"/gu)).toHaveLength(1);
    expect(manifest.match(/android\.intent\.action\.SEND_MULTIPLE"/gu)).toHaveLength(1);
    expect(manifest.match(/android\.intent\.category\.DEFAULT/gu)).toHaveLength(2);
    expect(manifest.match(/android:mimeType="\*\/\*"/gu)).toHaveLength(2);
    expect(manifest).not.toContain("android.intent.category.BROWSABLE");
    expect(manifest).not.toContain("android.intent.action.VIEW");
  });

  it("durably publishes before opening the root app and survives Activity recreation with one reservation", () => {
    expect(receiver).toContain("IncomingShareStore.restoreReservation");
    expect(receiver).toContain("IncomingShareStore.reserve(applicationContext)");
    expect(receiver).toContain("IncomingShareStore.hasPublishedBatch");
    expect(receiver).toContain("IncomingShareStore.persistIntent");
    expect(receiver.indexOf("IncomingShareStore.persistIntent")).toBeLessThan(receiver.indexOf("openJoko()"));
    expect(receiver).toContain("ThreadPoolExecutor(");
    expect(receiver).toContain("LinkedBlockingQueue()");
    expect(receiver).toContain('Uri.parse("joko://expo-sharing")');
    expect(receiver).toContain("STATE_BATCH_ID");
    expect(receiver).toContain("STATE_ORDER_KEY");
    expect(receiver).not.toMatch(/credential|accessToken|refreshToken|client\.create|\.send\(/u);
  });

  it("accepts only granted content streams and records bounded ordered results in unique item directories", () => {
    expect(store).toContain("Intent.FLAG_GRANT_READ_URI_PERMISSION");
    expect(store).toContain("ContentResolver.SCHEME_CONTENT");
    expect(store).toContain("Intent.EXTRA_STREAM");
    expect(store).toContain("intent.clipData");
    expect(store).toContain("private const val MAXIMUM_ITEMS = 20");
    expect(store).toContain("private const val MAXIMUM_ITEM_BYTES = 30L * 1024L * 1024L");
    expect(store).toContain('File(File(stagingDirectory, "items"), itemId)');
    expect(store).toContain("entries.take(MAXIMUM_ITEMS).mapIndexed");
    expect(store).toContain("entries.size - MAXIMUM_ITEMS");
    expect(store).toContain("The same Android content URI was shared more than once.");
    expect(store).toContain("Audio and video are not supported by this incoming share surface.");
    expect(store).not.toContain("cacheDir");
  });

  it("fsyncs bounded copies, verifies SHA, and atomically publishes manifest and batch directories", () => {
    expect(store).toContain("output.fd.sync()");
    expect(store).toContain('MessageDigest.getInstance("SHA-256")');
    expect(store).toContain("digestFile(destination) == expectedDigest");
    expect(store).toContain("writeNewFileAtomically(File(stagingDirectory, MANIFEST_NAME)");
    expect(store).toContain("Os.link(temporary.path, target.path)");
    expect(store).toContain("Os.fsync(descriptor)");
    expect(store).toContain("stagingDirectory.renameTo(finalDirectory)");
    expect(store).toContain("batchDirectories(root).firstOrNull()");
    expect(store).toContain("sortedBy { it.name }");
  });

  it("revalidates app-private containment and removes only exact claimed or discarded batches", () => {
    expect(store).toContain("context.noBackupFilesDir.canonicalFile");
    expect(store).toContain("file.canonicalFile.path");
    expect(store).toContain("!isSymbolicLink(file)");
    expect(store).toContain("batch.claim.claimId == claimId");
    expect(store).toContain("removeExactBatch(context, directory)");
    expect(store).toContain("deleteTreeWithoutFollowingLinks(directory, root)");
    expect(store).not.toMatch(/deleteTreeWithoutFollowingLinks\((?:root|context\.noBackupFilesDir)/u);
  });

  it("exposes the same bind, claim, acknowledge, and discard contract without create or send authority", () => {
    expect(moduleSource).toContain('Name("JokoIncomingShare")');
    expect(moduleSource).toContain('AsyncFunction("getNextBatch")');
    expect(moduleSource).toContain('AsyncFunction("bindBatch")');
    expect(moduleSource).toContain('AsyncFunction("claimBatch")');
    expect(moduleSource).toContain('AsyncFunction("acknowledgeBatch")');
    expect(moduleSource).toContain('AsyncFunction("discardBatch")');
    expect(bridge).toContain('Platform.OS === "ios" || Platform.OS === "android"');
    expect(surface).toContain('mobileMessage(locale, "incoming.waiting"');
    expect(messages).toContain("protected device inbox");
    expect(moduleSource).not.toMatch(/credential|accessToken|refreshToken|client\.create|\.send\(/u);
  });
});
