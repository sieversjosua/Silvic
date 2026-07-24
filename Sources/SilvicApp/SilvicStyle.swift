import SwiftUI
import WorkbenchCore

enum SilvicTheme {
  static let accent = Color(red: 0.93, green: 0.42, blue: 0.18)
  static let canvas = Color(nsColor: .controlBackgroundColor).opacity(0.5)
}

extension WorkspaceOperationalState {
  var systemImage: String {
    switch self {
    case .needsAttention: "exclamationmark.triangle.fill"
    case .active: "play.circle.fill"
    case .changed: "pencil.and.list.clipboard"
    case .waiting: "clock.fill"
    case .readyToLand: "checkmark.seal.fill"
    case .unknown: "questionmark.diamond.fill"
    case .quiet: "pause.circle"
    }
  }

  var tint: Color {
    switch self {
    case .needsAttention: .red
    case .active: .green
    case .changed: .orange
    case .waiting: .blue
    case .readyToLand: .mint
    case .unknown: .yellow
    case .quiet: .secondary
    }
  }
}

extension WorkspacePrimaryAction {
  var systemImage: String {
    switch self {
    case .inspect: "arrow.right"
    case .openRuntime: "safari"
    case .reviewChanges: "doc.text.magnifyingglass"
    case .reviewStatus: "questionmark.diamond"
    case .push: "arrow.up"
    case .openPullRequest: "arrow.up.right.square"
    case .resume: "play.fill"
    }
  }
}
