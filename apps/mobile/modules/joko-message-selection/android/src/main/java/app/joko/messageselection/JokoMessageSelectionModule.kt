package app.joko.messageselection

import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.widget.TextView
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference

class JokoMessageSelectionModule : Module() {
  private data class Binding(
    val view: WeakReference<TextView>,
    val previous: ActionMode.Callback?,
    val installed: ActionMode.Callback,
  )

  private val bindings = mutableMapOf<String, Binding>()

  override fun definition() = ModuleDefinition {
    Name("JokoMessageSelection")
    Events("onQuoteSelection")

    AsyncFunction("attach") { tag: Int, registration: String, label: String ->
      val textView = appContext.findView<View>(tag) as? TextView ?: return@AsyncFunction false
      if (!textView.isTextSelectable || label.isBlank()) return@AsyncFunction false
      detach(registration)
      for (key in bindings.filterValues { it.view.get() === textView }.keys.toList()) detach(key)
      val target = WeakReference(textView)
      val previous = textView.customSelectionActionModeCallback
      val quoteId = View.generateViewId()
      val callback = object : ActionMode.Callback2() {
        private fun ensureQuoteAction(menu: Menu): Boolean {
          if (menu.findItem(quoteId) != null) return false
          menu.add(Menu.NONE, quoteId, 0, label).setShowAsAction(MenuItem.SHOW_AS_ACTION_ALWAYS)
          return true
        }

        override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
          if (previous?.onCreateActionMode(mode, menu) == false) return false
          ensureQuoteAction(menu)
          return true
        }

        override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean {
          val changed = previous?.onPrepareActionMode(mode, menu) ?: false
          return ensureQuoteAction(menu) || changed
        }

        override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
          if (item.itemId != quoteId) return previous?.onActionItemClicked(mode, item) ?: false
          val view = target.get()
          if (view != null && view.isAttachedToWindow && bindings[registration]?.installed === this) {
            val start = minOf(view.selectionStart, view.selectionEnd)
            val end = maxOf(view.selectionStart, view.selectionEnd)
            val body = view.text
            if (start >= 0 && end > start && end <= body.length) {
              sendEvent("onQuoteSelection", mapOf("registration" to registration, "start" to start,
                "end" to end, "text" to body.subSequence(start, end).toString()))
            }
          }
          mode.finish()
          return true
        }

        override fun onDestroyActionMode(mode: ActionMode) {
          previous?.onDestroyActionMode(mode)
        }

        override fun onGetContentRect(mode: ActionMode, view: View, outRect: Rect) {
          if (previous is ActionMode.Callback2) previous.onGetContentRect(mode, view, outRect)
          else super.onGetContentRect(mode, view, outRect)
        }
      }
      bindings[registration] = Binding(target, previous, callback)
      textView.customSelectionActionModeCallback = callback
      true
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("detach") { registration: String -> detach(registration) }.runOnQueue(Queues.MAIN)

    OnDestroy {
      Handler(Looper.getMainLooper()).post { bindings.keys.toList().forEach(::detach) }
    }
  }

  private fun detach(registration: String) {
    val binding = bindings.remove(registration) ?: return
    val view = binding.view.get() ?: return
    if (view.customSelectionActionModeCallback === binding.installed) {
      view.customSelectionActionModeCallback = binding.previous
    }
  }
}
