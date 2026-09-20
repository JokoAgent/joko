package app.joko.incomingshare

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

class JokoShareReceiverActivity : Activity() {
  private var reservation: IncomingShareReservation? = null
  private var started = false

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    reservation = try {
      val batchId = savedInstanceState?.getString(STATE_BATCH_ID)
      val orderKey = savedInstanceState?.getString(STATE_ORDER_KEY)
      val createdAtUnixMs = savedInstanceState?.getLong(STATE_CREATED_AT, 0L) ?: 0L
      if (batchId != null && orderKey != null && createdAtUnixMs > 0L) {
        IncomingShareStore.restoreReservation(batchId, orderKey, createdAtUnixMs)
      } else {
        IncomingShareStore.reserve(applicationContext)
      }
    } catch (_: Exception) {
      finishWithFailure()
      return
    }
    persistAndOpenIfNeeded()
  }

  override fun onSaveInstanceState(outState: Bundle) {
    reservation?.let { current ->
      outState.putString(STATE_BATCH_ID, current.batchId)
      outState.putString(STATE_ORDER_KEY, current.orderKey)
      outState.putLong(STATE_CREATED_AT, current.createdAtUnixMs)
    }
    super.onSaveInstanceState(outState)
  }

  private fun persistAndOpenIfNeeded() {
    if (started) return
    started = true
    val current = reservation ?: run {
      finishWithFailure()
      return
    }
    val sharedIntent = Intent(intent)
    receiverExecutor.execute {
      val completed = try {
        if (!IncomingShareStore.hasPublishedBatch(applicationContext, current)) {
          IncomingShareStore.persistIntent(applicationContext, sharedIntent, current)
        }
        true
      } catch (_: Exception) {
        false
      }
      runOnUiThread {
        if (completed) openJoko() else finishWithFailure()
      }
    }
  }

  private fun openJoko() {
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    if (launch == null) {
      finishWithFailure()
      return
    }
    launch.action = Intent.ACTION_VIEW
    launch.data = Uri.parse("joko://expo-sharing")
    launch.clipData = null
    launch.type = null
    launch.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or
      Intent.FLAG_ACTIVITY_SINGLE_TOP
    startActivity(launch)
    finish()
  }

  private fun finishWithFailure() {
    Toast.makeText(
      applicationContext,
      "The shared files could not be copied into the protected Joko inbox.",
      Toast.LENGTH_LONG
    ).show()
    finish()
  }

  private companion object {
    const val STATE_BATCH_ID = "jokoIncomingShareBatchId"
    const val STATE_ORDER_KEY = "jokoIncomingShareOrderKey"
    const val STATE_CREATED_AT = "jokoIncomingShareCreatedAt"
    val receiverExecutor = ThreadPoolExecutor(
      0,
      1,
      30L,
      TimeUnit.SECONDS,
      LinkedBlockingQueue()
    )
  }
}
