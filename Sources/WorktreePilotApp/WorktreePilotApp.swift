import SwiftUI

@main
struct WorktreePilotApp: App {
  @StateObject private var store = WorkspaceStore()

  var body: some Scene {
    WindowGroup {
      ContentView()
        .environmentObject(store)
        .frame(minWidth: 980, minHeight: 620)
        .task {
          await store.refreshGitHubAuth()
          await store.refresh()
        }
    }
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
