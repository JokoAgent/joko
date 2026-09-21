package app.joko.imageoutput

import android.Manifest
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class JokoImageOutputModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("JokoImageOutput")

    AsyncFunction("saveImage") Coroutine { localUri: String, fileName: String, mediaType: String ->
      withContext(Dispatchers.IO) {
        saveImage(localUri, fileName, mediaType)
      }
    }
  }

  private fun saveImage(localUri: String, fileName: String, mediaType: String) {
    val context = appContext.reactContext ?: error("The Android application context is unavailable.")
    val source = verifiedSource(context, localUri)
    require(source.length() in 1..MAXIMUM_IMAGE_BYTES) { "The image is empty or exceeds the save limit." }
    val exactName = verifiedFileName(fileName)
    val exactMediaType = mediaType.trim().lowercase()
    require(exactMediaType.startsWith("image/") && exactMediaType != "image/gif" && exactMediaType != "image/svg+xml") {
      "Only a verified static raster image can be saved."
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      saveWithMediaStore(context, source, exactName, exactMediaType)
    } else {
      saveLegacy(context, source, exactName, exactMediaType)
    }
  }

  private fun verifiedSource(context: Context, localUri: String): File {
    val uri = Uri.parse(localUri)
    require(uri.scheme == "file") { "The image output source must be an app-owned local file." }
    val path = uri.path ?: error("The image output source path is missing.")
    val source = File(path).canonicalFile
    val root = File(context.cacheDir, OUTPUT_DIRECTORY).canonicalFile
    val prefix = root.path.trimEnd(File.separatorChar) + File.separator
    require(source.path.startsWith(prefix) && source.isFile) {
      "The image output source is outside the app-owned output cache."
    }
    return source
  }

  private fun verifiedFileName(value: String): String {
    val exact = value.trim()
    require(exact.isNotEmpty() && exact.length <= 200 && !exact.contains('/') && !exact.contains('\\')
      && exact.none { it.code < 32 || it.code == 127 } && exact.substringAfterLast('.', "").isNotEmpty()) {
      "The image output file name is invalid."
    }
    return exact
  }

  private fun saveWithMediaStore(context: Context, source: File, fileName: String, mediaType: String) {
    val resolver = context.contentResolver
    val values = ContentValues().apply {
      put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
      put(MediaStore.MediaColumns.MIME_TYPE, mediaType)
      put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/Joko")
      put(MediaStore.MediaColumns.IS_PENDING, 1)
    }
    val target = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
      ?: error("Android could not create the photo-library item.")
    try {
      resolver.openOutputStream(target, "w")?.use { output ->
        source.inputStream().use { input -> input.copyTo(output) }
      } ?: error("Android could not open the photo-library destination.")
      val sourceDigest = digest(FileInputStream(source))
      val targetDigest = resolver.openInputStream(target)?.use(::digest)
        ?: error("Android could not verify the saved photo-library item.")
      require(sourceDigest.contentEquals(targetDigest)) { "The saved photo-library bytes failed verification." }
      require(resolver.update(
        target,
        ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) },
        null,
        null
      ) == 1) { "Android could not publish the verified photo-library item." }
    } catch (error: Throwable) {
      resolver.delete(target, null, null)
      throw error
    }
  }

  @Suppress("DEPRECATION")
  private fun saveLegacy(context: Context, source: File, fileName: String, mediaType: String) {
    require(ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_EXTERNAL_STORAGE)
      == PackageManager.PERMISSION_GRANTED) {
      "Photo-library write permission was not granted."
    }
    val directory = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "Joko")
    require(directory.exists() || directory.mkdirs()) { "Android could not create the Joko photo directory." }
    val target = File(directory, fileName).canonicalFile
    val prefix = directory.canonicalPath.trimEnd(File.separatorChar) + File.separator
    require(target.path.startsWith(prefix) && !target.exists()) { "The photo-library destination is invalid or already exists." }
    try {
      FileInputStream(source).use { input -> FileOutputStream(target).use { output -> input.copyTo(output) } }
      require(digest(FileInputStream(source)).contentEquals(digest(FileInputStream(target)))) {
        "The saved photo-library bytes failed verification."
      }
      val completed = CountDownLatch(1)
      var scannedUri: Uri? = null
      MediaScannerConnection.scanFile(context, arrayOf(target.path), arrayOf(mediaType)) { _, uri ->
        scannedUri = uri
        completed.countDown()
      }
      require(completed.await(10, TimeUnit.SECONDS) && scannedUri != null) {
        "Android could not publish the verified photo-library item."
      }
    } catch (error: Throwable) {
      if (target.exists()) target.delete()
      throw error
    }
  }

  private fun digest(input: java.io.InputStream): ByteArray = input.use { stream ->
    val digest = MessageDigest.getInstance("SHA-256")
    val buffer = ByteArray(16 * 1024)
    while (true) {
      val count = stream.read(buffer)
      if (count < 0) break
      if (count > 0) digest.update(buffer, 0, count)
    }
    digest.digest()
  }

  private companion object {
    const val OUTPUT_DIRECTORY = "joko-image-output"
    const val MAXIMUM_IMAGE_BYTES = 32L * 1024L * 1024L
  }
}
