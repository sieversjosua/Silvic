import SwiftUI

@main
struct SilvicApp: App {
  @StateObject private var store = WorkspaceStore()

  var body: some Scene {
    WindowGroup {
      ContentView()
        .environmentObject(store)
        .frame(minWidth: 1100, minHeight: 700)
        .task {
          await store.refreshGitHubAuth()
          await store.refresh()
        }
    }
    .defaultSize(width: 1380, height: 840)
    .commands {
      CommandGroup(after: .newItem) {
        Button("Add Repository Root…") { store.chooseAndAddRoot() }
          .keyboardShortcut("o", modifiers: [.command, .shift])
        Button("Refresh") { Task { await store.refresh() } }
          .keyboardShortcut("r", modifiers: .command)
      }
    }
  }
}
