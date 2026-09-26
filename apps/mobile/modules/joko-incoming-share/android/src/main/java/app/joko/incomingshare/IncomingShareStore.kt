package app.joko.incomingshare

import android.content.ClipData
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Parcelable
import android.provider.OpenableColumns
import android.system.Os
import android.system.OsConstants
import android.webkit.MimeTypeMap
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.text.Normalizer
import java.net.URI
import java.util.Locale
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

internal data class IncomingShareReservation(
  val batchId: String,
  val orderKey: String,
  val createdAtUnixMs: Long
)

private data class IncomingShareManifestItem(
  val itemId: String,
  val ordinal: Int,
  val state: String,
  val kind: String? = null,
  val fileName: String? = null,
  val mediaType: String? = null,
  val byteSize: Long? = null,
  val sha256Hex: String? = null,
  val relativePath: String? = null,
  val reason: String? = null
)

private data class IncomingShareManifest(
  val batchId: String,
  val orderKey: String,
  val createdAtUnixMs: Long,
  val overflowCount: Int,
  val items: List<IncomingShareManifestItem>
)

private data class IncomingShareBinding(
  val batchId: String,
  val profileId: String,
  val boundAtUnixMs: Long
)

private data class IncomingShareClaim(
  val batchId: String,
  val claimId: String,
  val profileId: String,
  val destinationKind: String,
  val sessionId: String?,
  val targetId: String,
  val surfaceOwnerKey: String,
  val policyKey: String,
  val acceptedItemIds: List<String>,
  val acceptedItemProofs: List<IncomingShareItemProof>,
  val claimedAtUnixMs: Long
)

private data class IncomingShareItemProof(
  val itemId: String,
  val kind: String,
  val byteSize: Long,
  val sha256Hex: String,
  val fileName: String?,
  val mediaType: String?
)

private data class ValidatedIncomingShareBatch(
  val directory: File,
  val manifest: IncomingShareManifest,
  val binding: IncomingShareBinding?,
  val claim: IncomingShareClaim?,
  val items: List<Map<String, Any?>>
)

private sealed interface IncomingIntentItem {
  data class Stream(val uri: Uri) : IncomingIntentItem
  data class Text(val value: String) : IncomingIntentItem
  data class Rejected(val reason: String) : IncomingIntentItem
}

private data class StoredIncomingShareFile(
  val fileName: String,
  val mediaType: String,
  val byteSize: Long,
  val sha256Hex: String
)

internal object IncomingShareStore {
  private const val ROOT_NAME = "JokoIncomingShareV1"
  private const val MANIFEST_NAME = "manifest.json"
  private const val BINDING_NAME = "binding.json"
  private const val CLAIM_NAME = "claim.json"
  private const val ORDER_PREFERENCES = "joko-incoming-share-order-v1"
  private const val ORDER_KEY = "lastOrderMicros"
  private const val MAXIMUM_ITEMS = 20
  private const val MAXIMUM_ITEM_BYTES = 30L * 1024L * 1024L
  private const val MAXIMUM_TEXT_ITEM_BYTES = 32 * 1024
  private const val MAXIMUM_URL_ITEM_BYTES = 8 * 1024
  private const val MAXIMUM_TEXT_BATCH_BYTES = 128 * 1024
  private const val MAXIMUM_MANIFEST_BYTES = 256 * 1024
  private const val STAGING_LIFETIME_MS = 24L * 60L * 60L * 1000L

  private val uuidPattern = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
  private val orderPattern = Regex("^batch-[0-9]{20}-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
  private val stagingPattern = Regex("^staging-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
  private val profilePattern = Regex("^[A-Za-z0-9_-]{1,128}$")
  private val mediaTypePattern = Regex("^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$")

  @Synchronized
  fun reserve(context: Context, existingBatchId: String? = null): IncomingShareReservation {
    val batchId = existingBatchId ?: UUID.randomUUID().toString().lowercase(Locale.US)
    assertUuid(batchId, "incoming share")
    val preferences = context.getSharedPreferences(ORDER_PREFERENCES, Context.MODE_PRIVATE)
    val last = preferences.getLong(ORDER_KEY, 0L)
    val wallMicros = Math.multiplyExact(maxOf(1L, System.currentTimeMillis()), 1_000L)
    val next = maxOf(wallMicros, Math.addExact(last, 1L))
    require(preferences.edit().putLong(ORDER_KEY, next).commit()) {
      "The Android incoming-share order could not be reserved."
    }
    return IncomingShareReservation(
      batchId = batchId,
      orderKey = String.format(Locale.US, "batch-%020d-%s", next, batchId),
      createdAtUnixMs = next / 1_000L
    )
  }

  fun restoreReservation(batchId: String, orderKey: String, createdAtUnixMs: Long): IncomingShareReservation {
    val reservation = IncomingShareReservation(batchId, orderKey, createdAtUnixMs)
    assertReservation(reservation)
    return reservation
  }

  @Synchronized
  fun hasPublishedBatch(context: Context, reservation: IncomingShareReservation): Boolean {
    assertReservation(reservation)
    val root = inboxRoot(context, create = false)
    if (!root.exists()) return false
    return batchDirectories(root).any { it.name == reservation.orderKey }
  }

  @Synchronized
  fun persistIntent(context: Context, intent: Intent, reservation: IncomingShareReservation) {
    assertReservation(reservation)
    val root = inboxRoot(context, create = true)
    cleanupStaleStagingDirectories(root)
    val finalDirectory = File(root, reservation.orderKey)
    if (finalDirectory.exists()) {
      validateBatch(context, finalDirectory)
      return
    }
    val stagingDirectory = File(root, "staging-${reservation.batchId}")
    if (stagingDirectory.exists()) deleteTreeWithoutFollowingLinks(stagingDirectory, root)
    require(stagingDirectory.mkdir()) { "The Android incoming-share staging directory could not be created." }
    try {
      val declaredMediaType = declaredIntentMediaType(intent.type)
      val entries = collectIntentItems(intent)
      require(entries.isNotEmpty()) { "No supported content was shared with Joko." }
      var totalTextBytes = 0
      val generatedIds = mutableSetOf<String>()
      val manifestItems = entries.take(MAXIMUM_ITEMS).mapIndexed { ordinal, entry ->
        val itemId = UUID.randomUUID().toString().lowercase(Locale.US)
        require(generatedIds.add(itemId)) { "The Android incoming-share item identity is duplicated." }
        val result = when (entry) {
          is IncomingIntentItem.Rejected -> rejectedItem(itemId, ordinal, entry.reason)
          is IncomingIntentItem.Stream -> storeIntentItem(
            context,
            entry.uri,
            declaredMediaType,
            intent.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0,
            stagingDirectory,
            itemId,
            ordinal
          )
          is IncomingIntentItem.Text -> storeTextItem(
            entry.value,
            declaredMediaType,
            stagingDirectory,
            itemId,
            ordinal,
            MAXIMUM_TEXT_BATCH_BYTES - totalTextBytes
          )
        }
        if (result.state == "ready" && (result.kind == "text" || result.kind == "url")) {
          totalTextBytes += result.byteSize!!.toInt()
        }
        result
      }
      val manifest = IncomingShareManifest(
        batchId = reservation.batchId,
        orderKey = reservation.orderKey,
        createdAtUnixMs = reservation.createdAtUnixMs,
        overflowCount = maxOf(0, entries.size - MAXIMUM_ITEMS),
        items = manifestItems
      )
      val manifestBytes = manifestJson(manifest).toString().toByteArray(StandardCharsets.UTF_8)
      require(manifestBytes.size <= MAXIMUM_MANIFEST_BYTES) {
        "The Android incoming-share manifest is too large."
      }
      writeNewFileAtomically(File(stagingDirectory, MANIFEST_NAME), manifestBytes)
      syncDirectory(stagingDirectory)
      require(stagingDirectory.renameTo(finalDirectory)) {
        "The Android incoming-share batch could not be published."
      }
      syncDirectory(root)
    } catch (error: Exception) {
      if (stagingDirectory.exists()) runCatching { deleteTreeWithoutFollowingLinks(stagingDirectory, root) }
      throw error
    }
  }

  @Synchronized
  fun getNextBatch(context: Context): Map<String, Any?>? {
    val root = inboxRoot(context, create = false)
    if (!root.exists()) return null
    cleanupStaleStagingDirectories(root)
    val directory = batchDirectories(root).firstOrNull() ?: return null
    return try {
      batchDictionary(validateBatch(context, directory))
    } catch (error: Exception) {
      mapOf(
        "status" to "invalid",
        "batchId" to (batchIdFromOrderKey(directory.name) ?: "invalid"),
        "orderKey" to directory.name,
        "createdAtUnixMs" to 0L,
        "overflowCount" to 0,
        "items" to emptyList<Any>(),
        "invalidReason" to exposedMessage(
          error,
          "The Android incoming-share batch failed local validation."
        )
      )
    }
  }

  @Synchronized
  fun bindBatch(context: Context, batchId: String, profileId: String): Map<String, Any?> {
    assertUuid(batchId, "incoming share")
    assertProfileId(profileId)
    val directory = requiredBatchDirectory(context, batchId)
    val current = validateBatch(context, directory)
    current.binding?.let { binding ->
      require(binding.profileId == profileId) {
        "This incoming share is already bound to another Joko connection profile."
      }
      return batchDictionary(current)
    }
    val binding = JSONObject()
      .put("version", 1)
      .put("batchId", batchId)
      .put("profileId", profileId)
      .put("boundAtUnixMs", maxOf(1L, System.currentTimeMillis()))
    writeNewFileAtomically(File(directory, BINDING_NAME), binding.toString().toByteArray(StandardCharsets.UTF_8))
    return batchDictionary(validateBatch(context, directory))
  }

  @Synchronized
  fun claimBatch(
    context: Context,
    batchId: String,
    profileId: String,
    destinationKind: String,
    sessionId: String?,
    targetId: String,
    surfaceOwnerKey: String,
    policyKey: String,
    acceptedItemIds: List<String>
  ): Map<String, Any?> {
    assertUuid(batchId, "incoming share")
    assertProfileId(profileId)
    assertDestination(destinationKind, sessionId)
    assertTargetId(targetId)
    assertOpaqueText(surfaceOwnerKey, allowOwnerSeparators = true)
    assertOpaqueText(policyKey, allowOwnerSeparators = false)
    val directory = requiredBatchDirectory(context, batchId)
    val current = validateBatch(context, directory)
    require(current.binding?.profileId == profileId) {
      "The incoming share is not bound to this Joko connection profile."
    }
    val readyItems = current.manifest.items.sortedBy { it.ordinal }.filter { it.state == "ready" }
    val readyIds = readyItems.map { it.itemId }
    validateAcceptedItemIds(acceptedItemIds, readyIds)
    val acceptedProofs = readyItems.filter { acceptedItemIds.contains(it.itemId) }.map(::itemProof)
    current.claim?.let { claim ->
      require(claim.profileId == profileId && claim.destinationKind == destinationKind
        && claim.sessionId == sessionId && claim.targetId == targetId
        && claim.surfaceOwnerKey == surfaceOwnerKey && claim.policyKey == policyKey
        && claim.acceptedItemIds == acceptedItemIds && claim.acceptedItemProofs == acceptedProofs) {
        "This incoming share is already claimed by another project or model authority."
      }
      return batchDictionary(current)
    }
    val claim = JSONObject()
      .put("version", 1)
      .put("batchId", batchId)
      .put("claimId", UUID.randomUUID().toString().lowercase(Locale.US))
      .put("profileId", profileId)
      .put("destinationKind", destinationKind)
      .apply { sessionId?.let { put("sessionId", it) } }
      .put("targetId", targetId)
      .put("surfaceOwnerKey", surfaceOwnerKey)
      .put("policyKey", policyKey)
      .put("acceptedItemIds", JSONArray(acceptedItemIds))
      .put("acceptedItemProofs", JSONArray(acceptedProofs.map(::proofJson)))
      .put("claimedAtUnixMs", maxOf(1L, System.currentTimeMillis()))
    writeNewFileAtomically(File(directory, CLAIM_NAME), claim.toString().toByteArray(StandardCharsets.UTF_8))
    return batchDictionary(validateBatch(context, directory))
  }

  @Synchronized
  fun acknowledgeBatch(context: Context, batchId: String, profileId: String, claimId: String) {
    assertUuid(batchId, "incoming share")
    assertProfileId(profileId)
    assertUuid(claimId, "incoming-share claim")
    val directory = requiredBatchDirectory(context, batchId)
    val batch = validateBatch(context, directory)
    require(batch.binding?.profileId == profileId && batch.claim?.profileId == profileId
      && batch.claim.claimId == claimId) {
      "The incoming share claim is not owned by this Joko connection profile."
    }
    removeExactBatch(context, directory)
  }

  @Synchronized
  fun discardBatch(context: Context, batchId: String) {
    assertUuid(batchId, "incoming share")
    removeExactBatch(context, requiredBatchDirectory(context, batchId))
  }

  fun exposedMessage(error: Throwable, fallback: String): String {
    return if (error is IncomingShareException || error is IllegalArgumentException
      || error is IllegalStateException) boundedReason(error.message ?: fallback) else fallback
  }

  private fun collectIntentItems(intent: Intent): List<IncomingIntentItem> {
    require(intent.action == Intent.ACTION_SEND || intent.action == Intent.ACTION_SEND_MULTIPLE) {
      "The Android incoming-share action is invalid."
    }
    val extraUris: List<Uri> = when (intent.action) {
      Intent.ACTION_SEND -> listOfNotNull(intent.getParcelableExtraCompat<Uri>(Intent.EXTRA_STREAM))
      Intent.ACTION_SEND_MULTIPLE -> intent.getParcelableArrayListExtraCompat<Uri>(Intent.EXTRA_STREAM)
        ?.toList() ?: emptyList()
      else -> emptyList()
    }
    val entries = mutableListOf<IncomingIntentItem>()
    val clipUriKeys = mutableSetOf<String>()
    val clipTextCounts = mutableMapOf<String, Int>()
    val clipData: ClipData? = intent.clipData
    if (clipData != null) {
      for (index in 0 until clipData.itemCount) {
        val item = clipData.getItemAt(index)
        item.uri?.let { uri ->
          if (clipUriKeys.add(uri.toString())) entries.add(IncomingIntentItem.Stream(uri))
          else entries.add(IncomingIntentItem.Rejected("The same Android content URI was shared more than once."))
        }
        item.text?.toString()?.let { value ->
          entries.add(IncomingIntentItem.Text(value))
          clipTextCounts[value] = (clipTextCounts[value] ?: 0) + 1
        }
      }
    }
    val extraKeys = mutableSetOf<String>()
    for (uri in extraUris) {
      val key = uri.toString()
      if (!extraKeys.add(key)) {
        entries.add(IncomingIntentItem.Rejected("The same Android content URI was shared more than once."))
      } else if (!clipUriKeys.contains(key)) {
        entries.add(IncomingIntentItem.Stream(uri))
      }
    }
    val rawText = intent.extras?.get(Intent.EXTRA_TEXT)
    val extraTexts: List<IncomingIntentItem> = when (rawText) {
      null -> emptyList()
      is CharSequence -> listOf(IncomingIntentItem.Text(rawText.toString()))
      is ArrayList<*> -> rawText.map { value ->
        if (value is CharSequence) IncomingIntentItem.Text(value.toString())
        else IncomingIntentItem.Rejected("The shared Android text value is invalid.")
      }
      else -> listOf(IncomingIntentItem.Rejected("The shared Android text value is invalid."))
    }
    for (entry in extraTexts) {
      if (entry !is IncomingIntentItem.Text) {
        entries.add(entry)
        continue
      }
      val value = entry.value
      val mirroredCount = clipTextCounts[value] ?: 0
      if (mirroredCount > 0) clipTextCounts[value] = mirroredCount - 1
      else entries.add(entry)
    }
    return entries
  }

  private fun storeIntentItem(
    context: Context,
    uri: Uri,
    declaredMediaType: String,
    hasReadGrant: Boolean,
    stagingDirectory: File,
    itemId: String,
    ordinal: Int
  ): IncomingShareManifestItem {
    var safeName: String? = null
    val itemDirectory = File(File(stagingDirectory, "items"), itemId)
    return try {
      require(hasReadGrant) { "The shared Android content did not include read permission." }
      require(uri.scheme == ContentResolver.SCHEME_CONTENT) {
        "Only granted Android content streams can enter the Joko inbox."
      }
      val metadata = queryMetadata(context.contentResolver, uri)
      safeName = metadata.first?.let(::safeFileName)
      val resolverMediaType = context.contentResolver.getType(uri)
      val mediaType = resolvedMediaType(resolverMediaType, declaredMediaType, safeName)
      val fileName = safeName ?: generatedFileName(mediaType)
      validateFileNameAndMediaType(fileName, mediaType)
      val expectedSize = metadata.second
      if (expectedSize != null) {
        require(expectedSize > 0L) { "The shared Android file is empty." }
        require(expectedSize <= MAXIMUM_ITEM_BYTES) {
          "The shared Android file exceeds the 30 MB attachment limit."
        }
      }
      require(itemDirectory.mkdirs()) { "The Android incoming-share item directory could not be created." }
      val stored = copyContentStream(
        context.contentResolver,
        uri,
        itemDirectory,
        fileName,
        mediaType,
        expectedSize
      )
      syncDirectory(itemDirectory.parentFile
        ?: throw IncomingShareException("The Android incoming-share item parent is unavailable."))
      IncomingShareManifestItem(
        itemId = itemId,
        ordinal = ordinal,
        state = "ready",
        kind = "file",
        fileName = stored.fileName,
        mediaType = stored.mediaType,
        byteSize = stored.byteSize,
        sha256Hex = stored.sha256Hex,
        relativePath = "items/$itemId/${stored.fileName}"
      )
    } catch (error: Exception) {
      if (itemDirectory.exists()) runCatching { deleteTreeWithoutFollowingLinks(itemDirectory, stagingDirectory) }
      rejectedItem(
        itemId,
        ordinal,
        exposedMessage(error, "The shared Android item could not be copied into the protected Joko inbox."),
        safeName
      )
    }
  }

  private fun storeTextItem(
    value: String,
    declaredMediaType: String,
    stagingDirectory: File,
    itemId: String,
    ordinal: Int,
    remainingBatchBytes: Int
  ): IncomingShareManifestItem {
    val itemDirectory = File(File(stagingDirectory, "items"), itemId)
    return try {
      val bytes = value.toByteArray(StandardCharsets.UTF_8)
      require(bytes.size <= MAXIMUM_TEXT_ITEM_BYTES) {
        "The shared Android text exceeds its 32 KB limit."
      }
      val validUrl = isHttpUrl(value)
      val kind = if (declaredMediaType == "text/uri-list" || validUrl) "url" else "text"
      if (declaredMediaType == "text/uri-list") require(validUrl) {
        "The shared Android URL is invalid."
      }
      require(value.isNotEmpty() && value.trim().isNotEmpty() && !value.contains('\u0000')
        && String(bytes, StandardCharsets.UTF_8) == value) {
        "The shared Android text is invalid."
      }
      val itemLimit = if (kind == "url") MAXIMUM_URL_ITEM_BYTES else MAXIMUM_TEXT_ITEM_BYTES
      require(bytes.size <= itemLimit) {
        if (kind == "url") "The shared Android URL exceeds its 8 KB limit."
        else "The shared Android text exceeds its 32 KB limit."
      }
      require(bytes.size <= remainingBatchBytes) {
        "The shared Android text batch exceeds its 128 KB limit."
      }
      require(itemDirectory.mkdirs()) { "The Android incoming-share text directory could not be created." }
      val payload = File(itemDirectory, "payload.txt")
      writeNewFileAtomically(payload, bytes)
      require(readBoundedRegularFile(payload, stagingDirectory, itemLimit).contentEquals(bytes)) {
        "The shared Android text failed local readback."
      }
      syncDirectory(itemDirectory.parentFile
        ?: throw IncomingShareException("The Android incoming-share text parent is unavailable."))
      IncomingShareManifestItem(
        itemId = itemId,
        ordinal = ordinal,
        state = "ready",
        kind = kind,
        byteSize = bytes.size.toLong(),
        sha256Hex = MessageDigest.getInstance("SHA-256").digest(bytes).toHex(),
        relativePath = "items/$itemId/payload.txt"
      )
    } catch (error: Exception) {
      if (itemDirectory.exists()) runCatching { deleteTreeWithoutFollowingLinks(itemDirectory, stagingDirectory) }
      rejectedItem(itemId, ordinal, exposedMessage(error, "The shared Android text could not be copied into the protected inbox."))
    }
  }

  private fun isHttpUrl(value: String): Boolean {
    if (!value.startsWith("http://") && !value.startsWith("https://")) return false
    if (value.any { it.isWhitespace() || it.code < 32 || it.code == 127 }) return false
    return runCatching {
      val uri = URI(value)
      (uri.scheme == "http" || uri.scheme == "https")
        && !uri.host.isNullOrEmpty()
    }.getOrDefault(false)
  }

  private fun queryMetadata(resolver: ContentResolver, uri: Uri): Pair<String?, Long?> {
    val cursor = resolver.query(
      uri,
      arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
      null,
      null,
      null
    ) ?: throw IncomingShareException("The shared Android content metadata is unavailable.")
    cursor.use {
      require(it.moveToFirst()) { "The shared Android content metadata is empty." }
      val nameIndex = it.getColumnIndex(OpenableColumns.DISPLAY_NAME)
      val sizeIndex = it.getColumnIndex(OpenableColumns.SIZE)
      val name = if (nameIndex >= 0 && !it.isNull(nameIndex)) it.getString(nameIndex) else null
      val size = if (sizeIndex >= 0 && !it.isNull(sizeIndex)) it.getLong(sizeIndex) else null
      return name to size
    }
  }

  private fun copyContentStream(
    resolver: ContentResolver,
    uri: Uri,
    itemDirectory: File,
    fileName: String,
    mediaType: String,
    expectedSize: Long?
  ): StoredIncomingShareFile {
    val partial = File(itemDirectory, ".partial")
    val destination = File(itemDirectory, fileName)
    require(!partial.exists() && !destination.exists()) {
      "The Android incoming-share item destination already exists."
    }
    val digest = MessageDigest.getInstance("SHA-256")
    var count = 0L
    val input = resolver.openInputStream(uri)
      ?: throw IncomingShareException("The shared Android content stream could not be opened.")
    input.use { source ->
      FileOutputStream(partial).use { output ->
        val buffer = ByteArray(64 * 1024)
        while (true) {
          val read = source.read(buffer)
          if (read < 0) break
          if (read == 0) continue
          count += read.toLong()
          require(count <= MAXIMUM_ITEM_BYTES) {
            "The shared Android file exceeds the 30 MB attachment limit."
          }
          digest.update(buffer, 0, read)
          output.write(buffer, 0, read)
        }
        output.fd.sync()
      }
    }
    require(count > 0L) { "The shared Android file is empty." }
    if (expectedSize != null) require(count == expectedSize) {
      "The shared Android file changed size while it was copied."
    }
    require(partial.renameTo(destination)) { "The verified Android shared file could not be published." }
    syncDirectory(itemDirectory)
    require(destination.isFile && !isSymbolicLink(destination) && destination.length() == count) {
      "The copied Android shared file is invalid."
    }
    val expectedDigest = digest.digest().toHex()
    require(digestFile(destination) == expectedDigest) {
      "The copied Android shared file failed its SHA-256 check."
    }
    return StoredIncomingShareFile(fileName, mediaType, count, expectedDigest)
  }

  private fun validateBatch(context: Context, directory: File): ValidatedIncomingShareBatch {
    val root = inboxRoot(context, create = false)
    assertRegularDirectory(directory, root)
    val derivedBatchId = batchIdFromOrderKey(directory.name)
      ?: throw IncomingShareException("The Android incoming-share directory identity is invalid.")
    val manifestJson = readJsonObject(
      File(directory, MANIFEST_NAME),
      directory,
      MAXIMUM_MANIFEST_BYTES
    )
    require(requiredInteger(manifestJson, "version", 1L, 1L) == 1L)
    val batchId = requiredText(manifestJson, "batchId", 36)
    assertUuid(batchId, "incoming share")
    val orderKey = requiredText(manifestJson, "orderKey", 80)
    val createdAtUnixMs = requiredInteger(manifestJson, "createdAtUnixMs", 1L, Long.MAX_VALUE)
    val overflowCount = requiredInteger(manifestJson, "overflowCount", 0L, 1_000_000L).toInt()
    require(batchId == derivedBatchId && orderKey == directory.name && orderPattern.matches(orderKey)) {
      "The Android incoming-share manifest identity is invalid."
    }
    val rawItems = manifestJson.optJSONArray("items")
      ?: throw IncomingShareException("The Android incoming-share manifest items are invalid.")
    require(rawItems.length() <= MAXIMUM_ITEMS) {
      "The Android incoming-share manifest exceeds its item limit."
    }
    val itemIds = mutableSetOf<String>()
    val ordinals = mutableSetOf<Int>()
    val manifestItems = mutableListOf<IncomingShareManifestItem>()
    val publicItems = mutableListOf<Map<String, Any?>>()
    var totalTextBytes = 0L
    for (index in 0 until rawItems.length()) {
      val raw = rawItems.optJSONObject(index)
        ?: throw IncomingShareException("An Android incoming-share item is malformed.")
      val itemId = requiredText(raw, "itemId", 36)
      assertUuid(itemId, "incoming-share item")
      val ordinal = requiredInteger(raw, "ordinal", 0L, 19L).toInt()
      require(itemIds.add(itemId) && ordinals.add(ordinal)) {
        "The Android incoming share contains a duplicate item identity or order."
      }
      val state = requiredText(raw, "state", 16)
      if (state == "rejected") {
        require(!raw.has("kind") && !raw.has("mediaType") && !raw.has("byteSize") && !raw.has("sha256Hex")
          && !raw.has("relativePath")) {
          "An Android incoming-share rejection record is invalid."
        }
        val reason = requiredText(raw, "reason", 512)
        val fileName = optionalText(raw, "fileName", 512)?.let(::safeFileName)
        manifestItems.add(IncomingShareManifestItem(
          itemId = itemId,
          ordinal = ordinal,
          state = state,
          fileName = fileName,
          reason = reason
        ))
        publicItems.add(buildMap {
          put("state", "rejected")
          put("itemId", itemId)
          put("ordinal", ordinal)
          put("reason", reason)
          if (fileName != null) put("fileName", fileName)
        })
        continue
      }
      require(state == "ready" && !raw.has("reason")) {
        "An Android incoming-share item state is invalid."
      }
      val kind = requiredText(raw, "kind", 8)
      require(kind == "file" || kind == "text" || kind == "url") {
        "An Android incoming-share item kind is invalid."
      }
      val byteSize = requiredInteger(raw, "byteSize", 1L,
        if (kind == "file") MAXIMUM_ITEM_BYTES else if (kind == "url")
          MAXIMUM_URL_ITEM_BYTES.toLong() else MAXIMUM_TEXT_ITEM_BYTES.toLong())
      val sha256Hex = requiredText(raw, "sha256Hex", 64)
      require(sha256Hex.matches(Regex("^[0-9a-f]{64}$"))) {
        "An Android incoming-share SHA-256 is invalid."
      }
      val relativePath = requiredText(raw, "relativePath", 1_024)
      val fileName: String?
      val mediaType: String?
      if (kind == "file") {
        val exactFileName = safeFileName(requiredText(raw, "fileName", 512))
        val exactMediaType = safeMediaType(requiredText(raw, "mediaType", 255))
        require(relativePath == "items/$itemId/$exactFileName") {
          "An Android incoming-share item path is invalid."
        }
        validateFileNameAndMediaType(exactFileName, exactMediaType)
        fileName = exactFileName
        mediaType = exactMediaType
      } else {
        require(!raw.has("fileName") && !raw.has("mediaType")
          && relativePath == "items/$itemId/payload.txt") {
          "An Android incoming-share text record is invalid."
        }
        fileName = null
        mediaType = null
        totalTextBytes += byteSize
        require(totalTextBytes <= MAXIMUM_TEXT_BATCH_BYTES) {
          "The Android incoming-share text batch exceeds its 128 KB limit."
        }
      }
      val file = File(directory, relativePath)
      val bytes = readBoundedRegularFile(file, directory, if (kind == "file")
        MAXIMUM_ITEM_BYTES.toInt() else if (kind == "url") MAXIMUM_URL_ITEM_BYTES else MAXIMUM_TEXT_ITEM_BYTES)
      require(bytes.size.toLong() == byteSize && MessageDigest.getInstance("SHA-256")
        .digest(bytes).toHex() == sha256Hex) {
        "An Android incoming-share item failed size or SHA-256 validation."
      }
      val text = if (kind == "file") null else String(bytes, StandardCharsets.UTF_8).also { decoded ->
        require(decoded.isNotEmpty() && decoded.trim().isNotEmpty() && !decoded.contains('\u0000')
          && decoded.toByteArray(StandardCharsets.UTF_8).contentEquals(bytes)
          && (kind != "url" || isHttpUrl(decoded))) {
          "An Android incoming-share text item is invalid."
        }
      }
      manifestItems.add(IncomingShareManifestItem(
        itemId = itemId,
        ordinal = ordinal,
        state = state,
        kind = kind,
        fileName = fileName,
        mediaType = mediaType,
        byteSize = byteSize,
        sha256Hex = sha256Hex,
        relativePath = relativePath
      ))
      publicItems.add(buildMap {
        put("state", "ready")
        put("kind", kind)
        put("itemId", itemId)
        put("ordinal", ordinal)
        put("byteSize", byteSize)
        put("sha256Hex", sha256Hex)
        if (kind == "file") {
          put("fileName", fileName)
          put("mediaType", mediaType)
          put("uri", Uri.fromFile(file).toString())
        } else {
          put("text", text)
        }
      })
    }
    val manifest = IncomingShareManifest(
      batchId,
      orderKey,
      createdAtUnixMs,
      overflowCount,
      manifestItems.sortedBy { it.ordinal }
    )
    val binding = readBinding(directory, batchId)
    val claim = readClaim(directory, manifest, binding)
    return ValidatedIncomingShareBatch(
      directory,
      manifest,
      binding,
      claim,
      publicItems.sortedBy { it["ordinal"] as Int }
    )
  }

  private fun readBinding(directory: File, batchId: String): IncomingShareBinding? {
    val file = File(directory, BINDING_NAME)
    if (!file.exists()) return null
    val value = readJsonObject(file, directory, 4 * 1024)
    require(requiredInteger(value, "version", 1L, 1L) == 1L)
    val exactBatchId = requiredText(value, "batchId", 36)
    val profileId = requiredText(value, "profileId", 128)
    val boundAt = requiredInteger(value, "boundAtUnixMs", 1L, Long.MAX_VALUE)
    assertUuid(exactBatchId, "incoming share")
    assertProfileId(profileId)
    require(exactBatchId == batchId) { "The Android incoming-share profile binding is invalid." }
    return IncomingShareBinding(exactBatchId, profileId, boundAt)
  }

  private fun readClaim(
    directory: File,
    manifest: IncomingShareManifest,
    binding: IncomingShareBinding?
  ): IncomingShareClaim? {
    val file = File(directory, CLAIM_NAME)
    if (!file.exists()) return null
    require(binding != null) { "The Android incoming-share claim has no profile binding." }
    val value = readJsonObject(file, directory, 64 * 1024)
    require(requiredInteger(value, "version", 1L, 1L) == 1L)
    val batchId = requiredText(value, "batchId", 36)
    val claimId = requiredText(value, "claimId", 36)
    val profileId = requiredText(value, "profileId", 128)
    val destinationKind = requiredText(value, "destinationKind", 16)
    val sessionId = if (value.has("sessionId")) requiredText(value, "sessionId", 128) else null
    val targetId = requiredText(value, "targetId", 128)
    val surfaceOwnerKey = requiredOpaqueText(value, "surfaceOwnerKey", allowOwnerSeparators = true)
    val policyKey = requiredOpaqueText(value, "policyKey", allowOwnerSeparators = false)
    val claimedAt = requiredInteger(value, "claimedAtUnixMs", 1L, Long.MAX_VALUE)
    assertUuid(batchId, "incoming share")
    assertUuid(claimId, "incoming-share claim")
    assertProfileId(profileId)
    assertDestination(destinationKind, sessionId)
    assertTargetId(targetId)
    require(batchId == manifest.batchId && profileId == binding.profileId) {
      "The Android incoming-share claim identity is invalid."
    }
    val accepted = value.optJSONArray("acceptedItemIds")
      ?: throw IncomingShareException("The Android incoming-share accepted item identities are invalid.")
    require(accepted.length() <= MAXIMUM_ITEMS) {
      "The Android incoming-share accepted item identities exceed their limit."
    }
    val acceptedIds = (0 until accepted.length()).map { index ->
      val itemId = accepted.optString(index, "")
      assertUuid(itemId, "incoming-share accepted item")
      itemId
    }
    val readyIds = manifest.items.sortedBy { it.ordinal }.filter { it.state == "ready" }.map { it.itemId }
    validateAcceptedItemIds(acceptedIds, readyIds)
    val proofs = value.optJSONArray("acceptedItemProofs")
      ?: throw IncomingShareException("The Android incoming-share accepted item proofs are invalid.")
    require(proofs.length() == acceptedIds.size) {
      "The Android incoming-share accepted item proofs are invalid."
    }
    val acceptedProofs = (0 until proofs.length()).map { index ->
      val raw = proofs.optJSONObject(index)
        ?: throw IncomingShareException("An Android incoming-share item proof is malformed.")
      val itemId = requiredText(raw, "itemId", 36)
      assertUuid(itemId, "incoming-share proof item")
      val kind = requiredText(raw, "kind", 8)
      require(kind == "file" || kind == "text" || kind == "url") {
        "An Android incoming-share item proof kind is invalid."
      }
      val byteSize = requiredInteger(raw, "byteSize", 1L, MAXIMUM_ITEM_BYTES)
      val sha256Hex = requiredText(raw, "sha256Hex", 64)
      require(sha256Hex.matches(Regex("^[0-9a-f]{64}$"))) {
        "An Android incoming-share item proof SHA-256 is invalid."
      }
      val fileName = if (kind == "file") safeFileName(requiredText(raw, "fileName", 512)) else null
      val mediaType = if (kind == "file") safeMediaType(requiredText(raw, "mediaType", 255)) else null
      require(kind == "file" || (!raw.has("fileName") && !raw.has("mediaType"))) {
        "An Android incoming-share text proof is invalid."
      }
      IncomingShareItemProof(itemId, kind, byteSize, sha256Hex, fileName, mediaType)
    }
    val expectedProofs = manifest.items.sortedBy { it.ordinal }
      .filter { acceptedIds.contains(it.itemId) }.map(::itemProof)
    require(acceptedProofs == expectedProofs) {
      "The Android incoming-share claim content changed after it was selected."
    }
    return IncomingShareClaim(
      batchId,
      claimId,
      profileId,
      destinationKind,
      sessionId,
      targetId,
      surfaceOwnerKey,
      policyKey,
      acceptedIds,
      acceptedProofs,
      claimedAt
    )
  }

  private fun batchDictionary(batch: ValidatedIncomingShareBatch): Map<String, Any?> = buildMap {
    put("status", "ready")
    put("batchId", batch.manifest.batchId)
    put("orderKey", batch.manifest.orderKey)
    put("createdAtUnixMs", batch.manifest.createdAtUnixMs)
    put("overflowCount", batch.manifest.overflowCount)
    put("items", batch.items)
    batch.binding?.let { put("boundProfileId", it.profileId) }
    batch.claim?.let { claim ->
      put("claim", buildMap {
        put("claimId", claim.claimId)
        put("destinationKind", claim.destinationKind)
        claim.sessionId?.let { put("sessionId", it) }
        put("targetId", claim.targetId)
        put("surfaceOwnerKey", claim.surfaceOwnerKey)
        put("policyKey", claim.policyKey)
        put("acceptedItemIds", claim.acceptedItemIds)
        put("acceptedItemProofs", claim.acceptedItemProofs.map(::proofDictionary))
      })
    }
  }

  private fun manifestJson(manifest: IncomingShareManifest): JSONObject = JSONObject()
    .put("version", 1)
    .put("batchId", manifest.batchId)
    .put("orderKey", manifest.orderKey)
    .put("createdAtUnixMs", manifest.createdAtUnixMs)
    .put("overflowCount", manifest.overflowCount)
    .put("items", JSONArray(manifest.items.map { item ->
      JSONObject()
        .put("itemId", item.itemId)
        .put("ordinal", item.ordinal)
        .put("state", item.state)
        .apply {
          item.kind?.let { put("kind", it) }
          item.fileName?.let { put("fileName", it) }
          item.mediaType?.let { put("mediaType", it) }
          item.byteSize?.let { put("byteSize", it) }
          item.sha256Hex?.let { put("sha256Hex", it) }
          item.relativePath?.let { put("relativePath", it) }
          item.reason?.let { put("reason", it) }
        }
    }))

  private fun rejectedItem(
    itemId: String,
    ordinal: Int,
    reason: String,
    fileName: String? = null
  ): IncomingShareManifestItem = IncomingShareManifestItem(
    itemId = itemId,
    ordinal = ordinal,
    state = "rejected",
    fileName = fileName,
    reason = boundedReason(reason)
  )

  private fun itemProof(item: IncomingShareManifestItem): IncomingShareItemProof {
    require(item.state == "ready") { "An Android incoming-share item proof requires ready content." }
    return IncomingShareItemProof(
      item.itemId,
      item.kind ?: throw IncomingShareException("An Android incoming-share item kind is missing."),
      item.byteSize ?: throw IncomingShareException("An Android incoming-share item size is missing."),
      item.sha256Hex ?: throw IncomingShareException("An Android incoming-share item digest is missing."),
      item.fileName,
      item.mediaType
    )
  }

  private fun proofJson(proof: IncomingShareItemProof): JSONObject = JSONObject()
    .put("itemId", proof.itemId)
    .put("kind", proof.kind)
    .put("byteSize", proof.byteSize)
    .put("sha256Hex", proof.sha256Hex)
    .apply {
      proof.fileName?.let { put("fileName", it) }
      proof.mediaType?.let { put("mediaType", it) }
    }

  private fun proofDictionary(proof: IncomingShareItemProof): Map<String, Any> = buildMap {
    put("itemId", proof.itemId)
    put("kind", proof.kind)
    put("byteSize", proof.byteSize)
    put("sha256Hex", proof.sha256Hex)
    proof.fileName?.let { put("fileName", it) }
    proof.mediaType?.let { put("mediaType", it) }
  }

  private fun resolvedMediaType(resolverValue: String?, declaredValue: String, fileName: String?): String {
    val declared = declaredValue.lowercase(Locale.US)
    val resolver = resolverValue?.trim()?.lowercase(Locale.US)?.let(::normalizeMediaTypeAlias)
    if (resolver != null) require(mediaTypePattern.matches(resolver)) {
      "The shared Android content MIME type is invalid."
    }
    val extensionType = fileName?.substringAfterLast('.', "")?.takeIf { it.isNotEmpty() }
      ?.lowercase(Locale.US)?.let { MimeTypeMap.getSingleton().getMimeTypeFromExtension(it) }
      ?.lowercase(Locale.US)?.let(::normalizeMediaTypeAlias)
    var effective = resolver?.takeUnless { it == "application/octet-stream" }
      ?: extensionType
      ?: declared.takeUnless { it == "*/*" || it.endsWith("/*") }
      ?: "application/octet-stream"
    effective = normalizeMediaTypeAlias(effective)
    require(mediaTypePattern.matches(effective)) { "The shared Android content MIME type is invalid." }
    if (declared != "*/*" && declared != "application/octet-stream") {
      require(if (declared.endsWith("/*")) effective.startsWith(declared.removeSuffix("*"))
      else normalizeMediaTypeAlias(declared) == effective) {
        "The shared Android content MIME type does not match the share intent."
      }
    }
    if (resolver != null && resolver != "application/octet-stream" && extensionType != null) {
      require(resolver == extensionType) {
        "The shared Android content MIME type does not match its file extension."
      }
    }
    require(!isAudioOrVideoMediaType(effective)) {
      "Audio and video are not supported by this incoming share surface."
    }
    return effective
  }

  private fun validateFileNameAndMediaType(fileName: String, mediaType: String) {
    safeFileName(fileName)
    val exactMediaType = safeMediaType(mediaType)
    require(!isAudioOrVideoMediaType(exactMediaType)) {
      "Audio and video are not supported by this incoming share surface."
    }
    val extension = fileName.substringAfterLast('.', "").lowercase(Locale.US)
    val byExtension = extension.takeIf { it.isNotEmpty() }
      ?.let { MimeTypeMap.getSingleton().getMimeTypeFromExtension(it) }
      ?.lowercase(Locale.US)?.let(::normalizeMediaTypeAlias)
    if (byExtension != null && exactMediaType != "application/octet-stream") {
      require(byExtension == normalizeMediaTypeAlias(exactMediaType)) {
        "The incoming share MIME type does not match its file extension."
      }
    }
    if (exactMediaType.startsWith("image/") && byExtension != null) {
      require(byExtension.startsWith("image/")) { "The incoming share image extension is inconsistent." }
    }
  }

  private fun generatedFileName(mediaType: String): String {
    val extension = MimeTypeMap.getSingleton().getExtensionFromMimeType(mediaType)
      ?.lowercase(Locale.US)?.takeIf { it.matches(Regex("^[a-z0-9]{1,16}$")) }
    val base = if (mediaType.startsWith("image/")) "Shared image" else "Shared file"
    return if (extension == null) base else "$base.$extension"
  }

  private fun declaredIntentMediaType(value: String?): String {
    val exact = value?.trim()?.lowercase(Locale.US)
      ?: throw IncomingShareException("The Android incoming-share MIME type is missing.")
    require(exact == "*/*" || exact.matches(Regex("^[a-z0-9!#$&^_.+-]+/(?:[a-z0-9!#$&^_.+-]+|\\*)$"))) {
      "The Android incoming-share MIME type is invalid."
    }
    return exact
  }

  private fun normalizeMediaTypeAlias(value: String): String = when (value) {
    "image/jpg" -> "image/jpeg"
    "application/x-zip-compressed" -> "application/zip"
    else -> value
  }

  private fun isAudioOrVideoMediaType(value: String): Boolean {
    return value.startsWith("audio/") || value.startsWith("video/")
      || value == "application/ogg" || value == "application/x-mpegurl"
      || value == "application/vnd.apple.mpegurl" || value == "application/dash+xml"
  }

  private fun safeFileName(value: String): String {
    val normalized = Normalizer.normalize(value, Normalizer.Form.NFC)
    require(normalized.isNotEmpty() && normalized != "." && normalized != ".."
      && !normalized.contains('/') && !normalized.contains('\\')
      && normalized.none { it.code < 32 || it.code == 127 }
      && normalized.toByteArray(StandardCharsets.UTF_8).size <= 240) {
      "An incoming share file name is unsafe."
    }
    return normalized
  }

  private fun safeMediaType(value: String): String {
    val normalized = value.lowercase(Locale.US)
    require(normalized == value && normalized.length <= 255 && mediaTypePattern.matches(normalized)) {
      "An incoming share MIME type is invalid."
    }
    return normalized
  }

  private fun inboxRoot(context: Context, create: Boolean): File {
    val parent = context.noBackupFilesDir.canonicalFile
    val root = File(parent, ROOT_NAME)
    if (create && !root.exists()) {
      require(root.mkdir()) { "The protected Android incoming-share inbox could not be created." }
      syncDirectory(parent)
    }
    if (root.exists()) assertRegularDirectory(root, parent)
    return root
  }

  private fun batchDirectories(root: File): List<File> {
    assertRegularDirectory(root, root.parentFile ?: throw IncomingShareException("The Android inbox root is invalid."))
    return root.listFiles()?.filter { orderPattern.matches(it.name) }?.sortedBy { it.name }
      ?: throw IncomingShareException("The protected Android incoming-share inbox could not be listed.")
  }

  private fun requiredBatchDirectory(context: Context, batchId: String): File {
    val root = inboxRoot(context, create = false)
    require(root.exists()) { "The incoming share batch is no longer available." }
    val matches = batchDirectories(root).filter { batchIdFromOrderKey(it.name) == batchId }
    require(matches.size == 1) {
      if (matches.isEmpty()) "The incoming share batch is no longer available."
      else "The incoming share batch identity is duplicated."
    }
    val directory = matches.single()
    assertRegularDirectory(directory, root)
    return directory
  }

  private fun removeExactBatch(context: Context, directory: File) {
    val root = inboxRoot(context, create = false)
    require(directory.parentFile?.absolutePath == root.absolutePath && orderPattern.matches(directory.name)) {
      "The Android incoming-share deletion target is invalid."
    }
    deleteTreeWithoutFollowingLinks(directory, root)
    require(!directory.exists()) { "The Android incoming-share files could not be removed." }
    syncDirectory(root)
  }

  private fun cleanupStaleStagingDirectories(root: File) {
    val now = System.currentTimeMillis()
    val children = root.listFiles()
      ?: throw IncomingShareException("The protected Android incoming-share inbox could not be listed.")
    for (child in children) {
      if (!stagingPattern.matches(child.name) || now - child.lastModified() < STAGING_LIFETIME_MS) continue
      deleteTreeWithoutFollowingLinks(child, root)
    }
  }

  private fun deleteTreeWithoutFollowingLinks(target: File, lexicalRoot: File) {
    val rootPath = lexicalRoot.absolutePath.trimEnd(File.separatorChar)
    val targetPath = target.absolutePath
    require(targetPath.startsWith("$rootPath${File.separator}") && targetPath != rootPath) {
      "The Android incoming-share cleanup target is outside its inbox."
    }
    if (!isSymbolicLink(target) && target.isDirectory) {
      val children = target.listFiles()
        ?: throw IncomingShareException("An Android incoming-share directory could not be listed for cleanup.")
      for (child in children) deleteTreeWithoutFollowingLinks(child, lexicalRoot)
    }
    require(target.delete()) { "An Android incoming-share path could not be removed." }
  }

  private fun assertRegularDirectory(directory: File, root: File) {
    assertContained(directory, root)
    require(directory.isDirectory && !isSymbolicLink(directory)) {
      "An Android incoming-share directory is invalid."
    }
  }

  private fun assertContained(file: File, root: File) {
    val exactRoot = root.canonicalFile.path.trimEnd(File.separatorChar)
    val exactFile = file.canonicalFile.path
    require(exactFile == exactRoot || exactFile.startsWith("$exactRoot${File.separator}")) {
      "An Android incoming-share path escapes the app-private inbox."
    }
  }

  private fun isSymbolicLink(file: File): Boolean = file.absoluteFile.path != file.canonicalFile.path

  private fun readJsonObject(file: File, root: File, maximumBytes: Int): JSONObject {
    val bytes = readBoundedRegularFile(file, root, maximumBytes)
    return try {
      JSONObject(String(bytes, StandardCharsets.UTF_8))
    } catch (_: Exception) {
      throw IncomingShareException("An Android incoming-share record is malformed.")
    }
  }

  private fun readBoundedRegularFile(file: File, root: File, maximumBytes: Int): ByteArray {
    assertContained(file, root)
    require(file.isFile && !isSymbolicLink(file) && file.length() in 1L..maximumBytes.toLong()) {
      "An Android incoming-share path is not a bounded regular file."
    }
    val output = ByteArrayOutputStream(file.length().toInt())
    FileInputStream(file).use { input -> copyBounded(input, output, maximumBytes) }
    val bytes = output.toByteArray()
    require(bytes.size.toLong() == file.length()) {
      "An Android incoming-share file changed while it was read."
    }
    return bytes
  }

  private fun copyBounded(input: InputStream, output: ByteArrayOutputStream, maximumBytes: Int) {
    val buffer = ByteArray(16 * 1024)
    var total = 0
    while (true) {
      val count = input.read(buffer)
      if (count < 0) return
      if (count == 0) continue
      total += count
      require(total <= maximumBytes) { "An Android incoming-share file exceeds its read limit." }
      output.write(buffer, 0, count)
    }
  }

  private fun writeNewFileAtomically(target: File, bytes: ByteArray) {
    require(!target.exists()) { "The Android incoming-share record already exists." }
    val parent = target.parentFile
      ?: throw IncomingShareException("The Android incoming-share record parent is unavailable.")
    assertRegularDirectory(parent, parent)
    val temporary = File(parent, ".${target.name}.${UUID.randomUUID()}.tmp")
    try {
      FileOutputStream(temporary).use { output ->
        output.write(bytes)
        output.fd.sync()
      }
      require(temporary.isFile && !isSymbolicLink(temporary)) {
        "The Android incoming-share temporary record is invalid."
      }
      Os.link(temporary.path, target.path)
      require(temporary.delete()) { "The Android incoming-share temporary record could not be removed." }
      syncDirectory(parent)
    } catch (error: Exception) {
      if (temporary.exists()) temporary.delete()
      throw error
    }
  }

  private fun syncDirectory(directory: File) {
    val descriptor = Os.open(directory.path, OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW, 0)
    try {
      require(OsConstants.S_ISDIR(Os.fstat(descriptor).st_mode)) {
        "The Android incoming-share sync path is not a directory."
      }
      Os.fsync(descriptor)
    } finally {
      Os.close(descriptor)
    }
  }

  private fun digestFile(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    FileInputStream(file).use { input ->
      val buffer = ByteArray(64 * 1024)
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        if (count > 0) digest.update(buffer, 0, count)
      }
    }
    return digest.digest().toHex()
  }

  private fun requiredText(value: JSONObject, name: String, maximum: Int): String {
    val raw = value.opt(name)
    require(raw is String && raw.isNotEmpty() && raw.length <= maximum
      && raw.none { it.code < 32 || it.code == 127 }) {
      "The Android incoming-share $name is invalid."
    }
    return raw
  }

  private fun optionalText(value: JSONObject, name: String, maximum: Int): String? {
    if (!value.has(name) || value.isNull(name)) return null
    return requiredText(value, name, maximum)
  }

  private fun requiredOpaqueText(value: JSONObject, name: String, allowOwnerSeparators: Boolean): String {
    val raw = value.opt(name)
    require(raw is String) { "The Android incoming-share $name is invalid." }
    assertOpaqueText(raw, allowOwnerSeparators)
    return raw
  }

  private fun requiredInteger(value: JSONObject, name: String, minimum: Long, maximum: Long): Long {
    val raw = value.opt(name)
    require(raw is Number) { "The Android incoming-share $name is invalid." }
    val result = raw.toLong()
    require(raw.toDouble() == result.toDouble() && result in minimum..maximum) {
      "The Android incoming-share $name is invalid."
    }
    return result
  }

  private fun validateAcceptedItemIds(accepted: List<String>, readyIds: List<String>) {
    accepted.forEach { assertUuid(it, "incoming-share accepted item") }
    require(accepted.size <= readyIds.size && accepted.toSet().size == accepted.size
      && accepted.all { readyIds.contains(it) }
      && accepted == readyIds.filter { accepted.contains(it) }) {
      "The incoming share accepted item order is invalid."
    }
  }

  private fun assertReservation(reservation: IncomingShareReservation) {
    assertUuid(reservation.batchId, "incoming share")
    require(orderPattern.matches(reservation.orderKey)
      && batchIdFromOrderKey(reservation.orderKey) == reservation.batchId
      && reservation.createdAtUnixMs > 0L) {
      "The Android incoming-share reservation is invalid."
    }
  }

  private fun assertUuid(value: String, name: String) {
    require(uuidPattern.matches(value) && UUID.fromString(value).toString() == value) {
      "The $name identity is invalid."
    }
  }

  private fun assertProfileId(value: String) {
    require(profilePattern.matches(value)) { "The Joko connection profile identity is invalid." }
  }

  private fun assertTargetId(value: String) {
    require(profilePattern.matches(value)) { "The Joko project identity is invalid." }
  }

  private fun assertDestination(destinationKind: String, sessionId: String?) {
    require(destinationKind == "new_task" || destinationKind == "existing_task") {
      "The incoming share destination kind is invalid."
    }
    if (destinationKind == "new_task") require(sessionId == null) {
      "A new-task share cannot claim an existing task."
    } else require(sessionId != null && profilePattern.matches(sessionId)) {
      "The existing Joko task identity is invalid."
    }
  }

  private fun assertOpaqueText(value: String, allowOwnerSeparators: Boolean) {
    require(value.isNotEmpty() && value.toByteArray(StandardCharsets.UTF_8).size <= 16_384
      && value.none { character ->
        (character.code < 32 && (!allowOwnerSeparators ||
          (character.code != 30 && character.code != 31))) || character.code == 127
      }) {
      "The incoming share authority claim is invalid."
    }
  }

  private fun batchIdFromOrderKey(value: String): String? {
    if (!orderPattern.matches(value)) return null
    val candidate = value.takeLast(36)
    return runCatching { assertUuid(candidate, "incoming share"); candidate }.getOrNull()
  }

  private fun boundedReason(value: String): String {
    val normalized = value.trim().filter { it.code >= 32 && it.code != 127 }
    return (normalized.ifEmpty { "The shared item could not be imported." }).take(512)
  }

  private fun ByteArray.toHex(): String = joinToString(separator = "") { byte ->
    String.format(Locale.US, "%02x", byte.toInt() and 0xff)
  }
}

private class IncomingShareException(message: String) : IllegalStateException(message)

private inline fun <reified T : Parcelable> Intent.getParcelableExtraCompat(name: String): T? {
  return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
    getParcelableExtra(name, T::class.java)
  } else {
    @Suppress("DEPRECATION")
    getParcelableExtra(name)
  }
}

private inline fun <reified T : Parcelable> Intent.getParcelableArrayListExtraCompat(name: String): ArrayList<T>? {
  return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
    getParcelableArrayListExtra(name, T::class.java)
  } else {
    @Suppress("DEPRECATION")
    getParcelableArrayListExtra(name)
  }
}
