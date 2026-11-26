import ActivityKit
import SwiftUI
import WidgetKit

private struct HomeEntry: TimelineEntry {
  let date: Date
  let projection: JokoHomeSurfaceProjection?
}

private struct HomeProvider: TimelineProvider {
  func placeholder(in context: Context) -> HomeEntry { HomeEntry(date: Date(), projection: nil) }

  func getSnapshot(in context: Context, completion: @escaping (HomeEntry) -> Void) {
    let now = Date()
    let value = JokoHomeSurfaceProjection.read()
    completion(HomeEntry(date: now, projection: value.flatMap { $0.expiration > now ? $0 : nil }))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<HomeEntry>) -> Void) {
    let now = Date()
    guard let value = JokoHomeSurfaceProjection.read(), value.expiration > now else {
      completion(Timeline(entries: [HomeEntry(date: now, projection: nil)], policy: .after(now.addingTimeInterval(15 * 60))))
      return
    }
    let resets = Set(value.quotas.compactMap(\.resetsAt).map { Date(timeIntervalSince1970: Double($0) / 1000) })
      .filter { $0 > now && $0 < value.expiration }.sorted()
    let entries = ([now] + resets).map { HomeEntry(date: $0, projection: value) }
      + [HomeEntry(date: value.expiration, projection: nil)]
    completion(Timeline(entries: entries, policy: .after(value.expiration)))
  }
}

private struct QuotaWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: JokoHomeSurfaceProjection.quotaKind, provider: HomeProvider()) { entry in
      QuotaView(entry: entry)
        .containerBackground(.fill.tertiary, for: .widget)
        .widgetURL(URL(string: "joko://settings"))
    }
    .configurationDisplayName("Joko account quotas")
    .description("See remaining quota for the paired node’s model accounts.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

private struct QuotaView: View {
  let entry: HomeEntry
  @Environment(\.widgetFamily) private var family

  var body: some View {
    let chinese = entry.projection?.chinese ?? (Locale.current.language.languageCode?.identifier == "zh")
    let quotas = entry.projection?.quotas.filter { row in
      row.resetsAt.map { Date(timeIntervalSince1970: Double($0) / 1000) > entry.date } ?? true
    } ?? []
    VStack(alignment: .leading, spacing: 8) {
      Label(chinese ? "账户额度" : "Account quotas", systemImage: "gauge.with.needle")
        .font(.headline)
      if quotas.isEmpty {
        Text(chinese ? "打开 Joko 刷新额度" : "Open Joko to refresh.")
          .font(.caption).foregroundStyle(.secondary)
      } else {
        ForEach(Array(quotas.indices.prefix(family == .systemSmall ? 2 : 3)), id: \.self) { index in
          let row = quotas[index]
          HStack {
            Text(row.title).lineLimit(1)
            Spacer(minLength: 4)
            Text(Double(row.remaining) / 100, format: .percent).monospacedDigit()
          }
          .font(.caption)
          .privacySensitive()
        }
      }
      Spacer(minLength: 0)
    }
  }
}

private struct UsageWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: JokoHomeSurfaceProjection.usageKind, provider: HomeProvider()) { entry in
      let chinese = entry.projection?.chinese ?? (Locale.current.language.languageCode?.identifier == "zh")
      VStack(alignment: .leading, spacing: 7) {
        Label(chinese ? "今日用量" : "Daily usage", systemImage: "chart.bar.xaxis")
          .font(.headline)
        if let usage = entry.projection?.usage, let tokens = UInt64(usage.totalTokens) {
          Text(tokens.formatted()).font(.title2.bold()).monospacedDigit().privacySensitive()
          Text(chinese ? "Token · UTC" : "tokens · UTC").font(.caption).foregroundStyle(.secondary)
          if let cost = usage.costUsd {
            Text((usage.estimated == true ? "≈ " : "") + cost.formatted(.currency(code: "USD"))).font(.caption).privacySensitive()
          }
        } else {
          Text(chinese ? "打开 Joko 刷新用量" : "Open Joko to refresh.")
            .font(.caption).foregroundStyle(.secondary)
        }
        Spacer(minLength: 0)
      }
      .containerBackground(.fill.tertiary, for: .widget)
      .widgetURL(URL(string: "joko://settings"))
    }
    .configurationDisplayName("Joko daily usage")
    .description("See recorded token usage and available cost for the paired node.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

private struct TaskActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: JokoTaskActivityAttributes.self) { context in
      HStack(spacing: 12) {
        Image(systemName: context.state.symbol(stale: context.isStale))
        VStack(alignment: .leading, spacing: 2) {
          Text(context.state.status(stale: context.isStale)).font(.caption).foregroundStyle(.secondary)
          if !context.isStale { Text(context.state.title).font(.headline).lineLimit(1).privacySensitive() }
          if !context.isStale && !context.state.taskCounts.isEmpty {
            Text(context.state.taskCounts).font(.caption2).foregroundStyle(.secondary)
          }
        }
        Spacer()
      }
      .padding()
      .widgetURL(context.isStale ? URL(string: "joko://focus") : context.state.taskURL)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.center) {
          Text(context.state.status(stale: context.isStale)).font(.caption)
          if !context.isStale && !context.state.taskCounts.isEmpty {
            Text(context.state.taskCounts).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
          }
        }
        DynamicIslandExpandedRegion(.bottom) {
          if !context.isStale { Text(context.state.title).lineLimit(1).privacySensitive() }
        }
      } compactLeading: {
        Image(systemName: "bolt.fill")
      } compactTrailing: {
        let attention = context.state.attentionCount ?? 0
        let running = context.state.runningCount ?? 0
        if !context.isStale && attention + running > 1 {
          Text(attention > 0 ? "\(attention)" : "\(running)").monospacedDigit().accessibilityLabel(context.state.taskCounts)
        } else {
          Image(systemName: context.isStale || context.state.phase != "running" ? context.state.symbol(stale: context.isStale) : "ellipsis")
        }
      } minimal: {
        Image(systemName: context.state.symbol(stale: context.isStale))
      }
      .widgetURL(context.isStale ? URL(string: "joko://focus") : context.state.taskURL)
    }
  }
}

@main
struct JokoHomeWidgets: WidgetBundle {
  var body: some Widget {
    QuotaWidget()
    UsageWidget()
    TaskActivityWidget()
  }
}
