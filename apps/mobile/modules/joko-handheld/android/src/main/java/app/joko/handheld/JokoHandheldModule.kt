package app.joko.handheld

import android.app.Activity
import android.app.ActivityOptions
import android.content.Context
import android.content.Intent
import android.hardware.display.DisplayManager
import android.hardware.input.InputManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Display
import android.view.KeyEvent
import android.view.Window
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class JokoHandheldModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private var enabled = false
  private var secondary = false
  private var voiceKey = KeyEvent.KEYCODE_BUTTON_X
  private var capturing = false
  private var keyCaptureRelease: Int? = null
  private var heldDevice: Int? = null
  private var listening = false
  private var foreground = false
  private var initialized = false
  private var placedSecondary: Int? = null
  private var window: Window? = null
  private var callback: HandheldCallback? = null
  private var displayManager: DisplayManager? = null
  private var inputManager: InputManager? = null
  private val hold = Runnable {
    if (enabled && foreground && heldDevice != null && window?.decorView?.hasWindowFocus() == true) {
      listening = true
      sendEvent("onVoiceKey", mapOf("phase" to "start"))
    }
  }

  override fun definition() = ModuleDefinition {
    Name("JokoHandheld")
    Events("onVoiceKey", "onKeyCaptured", "onDisplaysChanged")

    AsyncFunction("read") {
      initialize()
      snapshot()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("configure") { mode: Boolean, key: Int, useSecondary: Boolean ->
      initialize()
      require(KeyEvent.isGamepadButton(key))
      val previous = enabled && secondary
      val editor = preferences().edit().putBoolean("enabled", mode).putInt("voiceKey", key).putBoolean("secondary", useSecondary)
      check(editor.commit())
      if (enabled != mode || voiceKey != key) resetInput()
      enabled = mode
      voiceKey = key
      secondary = useSecondary
      if (previous && !(enabled && secondary)) moveTo(Display.DEFAULT_DISPLAY)
      if (previous != (enabled && secondary)) placedSecondary = null
      reconcileDisplay()
      snapshot()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("captureKey") { active: Boolean ->
      resetInput()
      capturing = active && enabled && foreground
    }.runOnQueue(Queues.MAIN)

    OnActivityEntersForeground { main.post { foreground = true; install(); reconcileDisplay() } }
    OnActivityEntersBackground { main.post { foreground = false; resetInput() } }
    OnActivityDestroys { main.post { resetInput(); removeWindowCallback() } }
    OnDestroy { main.post {
      resetInput()
      removeWindowCallback()
      displayManager?.unregisterDisplayListener(displays)
      inputManager?.unregisterInputDeviceListener(inputs)
      displayManager = null
      inputManager = null
    } }
  }

  private fun preferences() = requireNotNull(appContext.reactContext).getSharedPreferences("joko-handheld-v1", Context.MODE_PRIVATE)

  private fun initialize() {
    if (!initialized) {
      val config = preferences()
      enabled = config.getBoolean("enabled", false)
      voiceKey = config.getInt("voiceKey", KeyEvent.KEYCODE_BUTTON_X).takeIf(KeyEvent::isGamepadButton) ?: KeyEvent.KEYCODE_BUTTON_X
      secondary = config.getBoolean("secondary", false)
      initialized = true
      foreground = appContext.currentActivity?.window?.decorView?.hasWindowFocus() == true
    }
    install()
    reconcileDisplay()
  }

  private fun snapshot(): Map<String, Any> = mapOf("enabled" to enabled, "voiceKey" to voiceKey, "keyName" to KeyEvent.keyCodeToString(voiceKey),
    "secondary" to secondary, "secondaryAvailable" to (secondaryDisplay() != null))

  private fun install() {
    val activity = appContext.currentActivity ?: return
    val current = activity.window ?: return
    if (window !== current || current.callback !== callback) {
      removeWindowCallback()
      val base = current.callback ?: return
      val wrapped = HandheldCallback(base)
      window = current
      callback = wrapped
      current.callback = wrapped
    }
    if (displayManager == null) {
      displayManager = activity.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
      displayManager?.registerDisplayListener(displays, main)
    }
    if (inputManager == null) {
      inputManager = activity.getSystemService(Context.INPUT_SERVICE) as InputManager
      inputManager?.registerInputDeviceListener(inputs, main)
    }
  }

  private fun removeWindowCallback() {
    val old = callback
    if (old != null && window?.callback === old) window?.callback = old.base
    window = null
    callback = null
  }

  private val displays = object : DisplayManager.DisplayListener {
    override fun onDisplayAdded(id: Int) = changed()
    override fun onDisplayChanged(id: Int) = changed()
    override fun onDisplayRemoved(id: Int) {
      if (placedSecondary == id) { placedSecondary = null; moveTo(Display.DEFAULT_DISPLAY) }
      changed()
    }
    private fun changed() {
      reconcileDisplay()
      sendEvent("onDisplaysChanged", snapshot())
    }
  }

  private val inputs = object : InputManager.InputDeviceListener {
    override fun onInputDeviceAdded(id: Int) {}
    override fun onInputDeviceChanged(id: Int) {}
    override fun onInputDeviceRemoved(id: Int) { if (heldDevice == id) resetInput() }
  }

  private fun secondaryDisplay(): Int? = displayManager?.displays?.firstOrNull { it.displayId != Display.DEFAULT_DISPLAY }?.displayId

  private fun reconcileDisplay() {
    if (!initialized || !enabled || !secondary || !foreground) return
    val target = secondaryDisplay() ?: return
    if (placedSecondary != target && moveTo(target)) placedSecondary = target
  }

  private fun moveTo(id: Int): Boolean {
    val activity = appContext.currentActivity ?: return false
    if (currentDisplay(activity) == id) return true
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || displayManager?.getDisplay(id) == null) return false
    val intent = Intent(activity, activity.javaClass).apply {
      action = Intent.ACTION_MAIN
      addCategory(Intent.CATEGORY_LAUNCHER)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    return runCatching { activity.startActivity(intent, ActivityOptions.makeBasic().setLaunchDisplayId(id).toBundle()); true }.getOrDefault(false)
  }

  @Suppress("DEPRECATION")
  private fun currentDisplay(activity: Activity): Int = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
    activity.display?.displayId ?: Display.DEFAULT_DISPLAY else activity.windowManager.defaultDisplay.displayId

  private fun resetInput() {
    main.removeCallbacks(hold)
    if (listening) sendEvent("onVoiceKey", mapOf("phase" to "cancel"))
    heldDevice = null
    listening = false
    capturing = false
    keyCaptureRelease = null
  }

  private inner class HandheldCallback(val base: Window.Callback) : Window.Callback by base {
    override fun onWindowFocusChanged(hasFocus: Boolean) {
      foreground = hasFocus
      if (!hasFocus) resetInput() else reconcileDisplay()
      base.onWindowFocusChanged(hasFocus)
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
      if (!enabled || !foreground || event.device?.isVirtual != false || !KeyEvent.isGamepadButton(event.keyCode)) return base.dispatchKeyEvent(event)
      if (event.keyCode == keyCaptureRelease) {
        if (event.action == KeyEvent.ACTION_UP) keyCaptureRelease = null
        return true
      }
      if (capturing && event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
        capturing = false
        keyCaptureRelease = event.keyCode
        sendEvent("onKeyCaptured", mapOf("key" to event.keyCode))
        return true
      }
      if (event.keyCode != voiceKey) return base.dispatchKeyEvent(event)
      if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0 && heldDevice == null) {
        heldDevice = event.deviceId
        main.postDelayed(hold, 350)
      } else if (event.action == KeyEvent.ACTION_UP && heldDevice == event.deviceId) {
        main.removeCallbacks(hold)
        heldDevice = null
        val phase = if (event.isCanceled) "cancel" else if (listening) "end" else "tap"
        listening = false
        sendEvent("onVoiceKey", mapOf("phase" to phase))
      }
      return true
    }
  }
}
