package app.joko.resourcepressure

import android.content.ComponentCallbacks2
import android.content.Context
import android.content.res.Configuration
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class JokoMobileResourcePressureModule : Module(), ComponentCallbacks2 {
  private var applicationContext: Context? = null
  private var sequence = 0

  override fun definition() = ModuleDefinition {
    Name(MODULE_NAME)
    Events(RESOURCE_PRESSURE_EVENT)

    OnCreate {
      val context = appContext.reactContext?.applicationContext ?: return@OnCreate
      applicationContext = context
      context.registerComponentCallbacks(this@JokoMobileResourcePressureModule)
    }

    OnDestroy {
      applicationContext?.unregisterComponentCallbacks(this@JokoMobileResourcePressureModule)
      applicationContext = null
    }
  }

  override fun onConfigurationChanged(newConfig: Configuration) = Unit

  @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
  override fun onLowMemory() {
    emitPressure("critical")
  }

  @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
  override fun onTrimMemory(level: Int) {
    if (level == ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN
      || level < ComponentCallbacks2.TRIM_MEMORY_RUNNING_MODERATE) return
    val severity = if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL) "critical" else "warning"
    emitPressure(severity)
  }

  private fun emitPressure(severity: String) {
    sequence = if (sequence == Int.MAX_VALUE) 1 else sequence + 1
    sendEvent(RESOURCE_PRESSURE_EVENT, mapOf(
      "sequence" to sequence,
      "severity" to severity,
      "platform" to "android"
    ))
  }

  private companion object {
    const val MODULE_NAME = "JokoMobileResourcePressure"
    const val RESOURCE_PRESSURE_EVENT = "onResourcePressure"
  }
}
