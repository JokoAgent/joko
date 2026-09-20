package app.joko.incomingshare

import android.content.Context
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class JokoIncomingShareModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("JokoIncomingShare")

    AsyncFunction("getNextBatch") Coroutine { ->
      withContext(Dispatchers.IO) {
        safely("The protected Android incoming-share inbox could not be read.") {
          IncomingShareStore.getNextBatch(applicationContext())
        }
      }
    }

    AsyncFunction("bindBatch") Coroutine { batchId: String, profileId: String ->
      withContext(Dispatchers.IO) {
        safely("The Android incoming-share profile binding could not be saved.") {
          IncomingShareStore.bindBatch(applicationContext(), batchId, profileId)
        }
      }
    }

    AsyncFunction("claimBatch") Coroutine {
        batchId: String,
        profileId: String,
        targetId: String,
        surfaceOwnerKey: String,
        policyKey: String,
        acceptedItemIds: List<String> ->
      withContext(Dispatchers.IO) {
        safely("The Android incoming-share project claim could not be saved.") {
          IncomingShareStore.claimBatch(
            applicationContext(),
            batchId,
            profileId,
            targetId,
            surfaceOwnerKey,
            policyKey,
            acceptedItemIds
          )
        }
      }
    }

    AsyncFunction("acknowledgeBatch") Coroutine { batchId: String, profileId: String, claimId: String ->
      withContext(Dispatchers.IO) {
        safely("The consumed Android incoming share could not be removed.") {
          IncomingShareStore.acknowledgeBatch(applicationContext(), batchId, profileId, claimId)
        }
      }
    }

    AsyncFunction("discardBatch") Coroutine { batchId: String ->
      withContext(Dispatchers.IO) {
        safely("The Android incoming share could not be discarded.") {
          IncomingShareStore.discardBatch(applicationContext(), batchId)
        }
      }
    }
  }

  private fun applicationContext(): Context {
    return appContext.reactContext?.applicationContext
      ?: throw IllegalStateException("The Android application context is unavailable.")
  }

  private inline fun <Result> safely(fallback: String, effect: () -> Result): Result {
    return try {
      effect()
    } catch (error: Exception) {
      throw IllegalStateException(IncomingShareStore.exposedMessage(error, fallback))
    }
  }
}
