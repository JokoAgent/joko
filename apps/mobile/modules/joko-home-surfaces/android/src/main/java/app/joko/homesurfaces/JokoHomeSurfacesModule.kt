package app.joko.homesurfaces

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import android.util.AtomicFile
import android.widget.RemoteViews
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.math.BigInteger
import java.text.NumberFormat
import java.util.Currency
import java.util.Locale
import org.json.JSONObject

class JokoHomeSurfacesModule : Module() {
  private val bridge = SystemClock.elapsedRealtimeNanos()

  override fun definition() = ModuleDefinition {
    Name("JokoHomeSurfaces")
    AsyncFunction("apply") { sequence: Int, owner: String?, usage: String?, _: String?, _: Boolean ->
      val context = appContext.reactContext?.applicationContext ?: error("The Android widget store is unavailable.")
      HomeWidgets.apply(context, bridge, sequence, owner, usage)
    }
  }
}

class AccountQuotaWidget : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) = HomeWidgets.render(context)
  override fun onDisabled(context: Context) = HomeWidgets.render(context)
}

class DailyUsageWidget : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) = HomeWidgets.render(context)
  override fun onDisabled(context: Context) = HomeWidgets.render(context)
}

class HomeWidgetExpiryReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == HomeWidgets.EXPIRE) HomeWidgets.render(context)
  }
}

private object HomeWidgets {
  const val EXPIRE = "app.joko.homesurfaces.EXPIRE"
  private const val MAXIMUM_BYTES = 12 * 1024
  private const val MAXIMUM_AGE = 20 * 60 * 1000L
  private val ownerPattern = Regex("[a-f0-9]{64}")
  private val tokenPattern = Regex("[0-9]{1,32}")
  private val datePattern = Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}")
  private var latestBridge = 0L
  private var latest = 0

  private data class Quota(val title: String, val remaining: Int, val resetsAt: Long)
  private data class Usage(val tokens: String, val cost: Double?, val estimated: Boolean)
  private data class Projection(val owner: String, val language: String, val expiresAt: Long, val quotas: List<Quota>, val usage: Usage?)

  @Synchronized
  fun apply(context: Context, bridge: Long, sequence: Int, owner: String?, usage: String?) {
    if (bridge < latestBridge || bridge == latestBridge && sequence <= latest) return
    latestBridge = bridge
    latest = sequence
    val file = cache(context)
    val now = System.currentTimeMillis()
    val current = read(file, now)
    if (owner == null || current?.owner != owner || usage == "") file.delete()
    val next = usage?.takeIf { it.isNotEmpty() }?.let { decode(it, now) }
    if (usage != null && next != null && next.owner == owner && next != current) {
      val output = file.startWrite()
      try {
        output.write(usage.toByteArray(Charsets.UTF_8))
        file.finishWrite(output)
      } catch (error: Exception) {
        file.failWrite(output)
        throw error
      }
    }
    if (next != current || current?.owner != owner || usage == "") render(context)
  }

  @Synchronized
  fun render(context: Context) {
    val manager = AppWidgetManager.getInstance(context)
    val quotaIds = manager.getAppWidgetIds(ComponentName(context, AccountQuotaWidget::class.java))
    val usageIds = manager.getAppWidgetIds(ComponentName(context, DailyUsageWidget::class.java))
    val clock = context.getSystemService(AlarmManager::class.java)
    val alarm = PendingIntent.getBroadcast(context, 0, Intent(context, HomeWidgetExpiryReceiver::class.java).setAction(EXPIRE),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    clock?.cancel(alarm)
    if (quotaIds.isEmpty() && usageIds.isEmpty()) return
    val now = System.currentTimeMillis()
    val file = cache(context)
    val projection = read(file, now)
    if (projection == null) file.delete()
    val quotas = projection?.quotas?.filter { it.resetsAt == 0L || it.resetsAt > now } ?: emptyList()
    val language = projection?.language?.let { Locale.forLanguageTag(it).language } ?: Locale.getDefault().language
    val chinese = language == "zh"
    val locale = if (chinese) Locale.SIMPLIFIED_CHINESE else Locale.ENGLISH
    val launch = PendingIntent.getActivity(context, 0, Intent(Intent.ACTION_VIEW, Uri.parse("joko://settings"))
      .setPackage(context.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val empty = if (chinese) "打开 Joko 刷新" else "Open Joko to refresh"
    if (quotaIds.isNotEmpty()) {
      val lines = quotas.take(2).map { "${it.remaining}%  ${it.title}" }
      manager.updateAppWidget(quotaIds, tile(context, launch, if (chinese) "账户额度" else "Account quotas",
        lines.firstOrNull() ?: empty, lines.getOrNull(1) ?: ""))
    }
    if (usageIds.isNotEmpty()) {
      val usage = projection?.usage
      val value = usage?.let {
        val tokens = NumberFormat.getIntegerInstance(locale).format(BigInteger(it.tokens))
        if (chinese) "$tokens 令牌" else "$tokens tokens"
      } ?: empty
      val cost = usage?.cost?.let {
        val format = NumberFormat.getCurrencyInstance(locale).apply { currency = Currency.getInstance("USD") }
        format.format(it) + if (usage?.estimated == true) (if (chinese) "（估算）" else " estimated") else ""
      } ?: ""
      manager.updateAppWidget(usageIds, tile(context, launch, if (chinese) "今日用量" else "Daily usage", value, cost))
    }
    if (projection != null) {
      val next = quotas.mapNotNull { it.resetsAt.takeIf { reset -> reset > now } }.minOrNull() ?: projection.expiresAt
      clock?.set(AlarmManager.RTC, minOf(next, projection.expiresAt), alarm)
    }
  }

  private fun tile(context: Context, launch: PendingIntent, heading: String, value: String, detail: String) =
    RemoteViews(context.packageName, R.layout.joko_home_widget).apply {
      setTextViewText(R.id.joko_widget_heading, heading)
      setTextViewText(R.id.joko_widget_value, value)
      setTextViewText(R.id.joko_widget_detail, detail)
      setOnClickPendingIntent(android.R.id.background, launch)
    }

  private fun cache(context: Context) = AtomicFile(File(context.noBackupFilesDir, "home-surfaces-v1.json"))

  private fun read(file: AtomicFile, now: Long): Projection? = runCatching {
    if (file.baseFile.length() > MAXIMUM_BYTES) null else decode(file.readFully().toString(Charsets.UTF_8), now)
  }.getOrNull()

  private fun decode(json: String, now: Long): Projection? = runCatching {
    require(json.toByteArray(Charsets.UTF_8).size <= MAXIMUM_BYTES)
    val value = JSONObject(json)
    val owner = value.getString("owner")
    val language = value.getString("locale")
    val expiration = value.getLong("expiresAt")
    require(ownerPattern.matches(owner) && language in setOf("en", "zh-CN") && expiration in (now + 1)..(now + MAXIMUM_AGE))
    val windows = value.getJSONArray("quotas")
    require(windows.length() <= 12)
    val quotas = List(windows.length()) { index ->
      val row = windows.getJSONObject(index)
      val title = row.getString("title")
      val remaining = row.getInt("remaining")
      require(title.length in 1..100 && title.none { it.isISOControl() } && remaining in 0..100)
      Quota(title, remaining, row.optLong("resetsAt"))
    }
    val usage = value.optJSONObject("usage")?.let { row ->
      val tokens = row.getString("totalTokens")
      val cost = if (row.isNull("costUsd")) null else row.getDouble("costUsd")
      require(datePattern.matches(row.getString("day")) && tokenPattern.matches(tokens) && (cost == null || cost.isFinite() && cost >= 0))
      Usage(tokens, cost, row.optBoolean("estimated"))
    }
    Projection(owner, language, expiration, quotas, usage)
  }.getOrNull()
}
