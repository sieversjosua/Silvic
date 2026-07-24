import SwiftUI
import WorkbenchCore

struct NewEnvironmentSheet: View {
  @EnvironmentObject private var store: WorkspaceStore
  @Environment(\.dismiss) private var dismiss

  let repository: RepositorySnapshot
  let parent: WorkspaceSnapshot

  @State private var displayName = ""
  @State private var purpose = ""
  @State private var branch = "agent/new-task"
  @State private var destinationPath = ""
  @State private var strategy: WorkspaceCreationStrategy = .linkedWorktree
  @State private var isPreparing = false
  @State private var lastGeneratedBranch = "agent/new-task"
  @State private var lastGeneratedPath = ""

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      VStack(alignment: .leading, spacing: 5) {
        Text("New task environment")
          .font(.title2.weight(.semibold))
        Text("Branch from \(parent.record.displayName) in \(repository.name).")
          .foregroundStyle(.secondary)
      }

      Form {
        TextField("Task name", text: $displayName)
        TextField("Purpose", text: $purpose, prompt: Text("What should the agent accomplish?"))
        Picker("Location strategy", selection: $strategy) {
          ForEach(WorkspaceCreationStrategy.allCases) { strategy in
            Text(strategy.title).tag(strategy)
          }
        }
        .pickerStyle(.segmented)
        TextField("Branch", text: $branch)
          .font(.body.monospaced())
        TextField("Location", text: $destinationPath)
          .font(.body.monospaced())
      }
      .formStyle(.grouped)

      HStack {
        Label(
          "Silvic records \(parent.record.displayName) as the parent. The \(strategy.title.lowercased()) is created only after confirmation.",
          systemImage: "point.3.connected.trianglepath.dotted"
        )
        .font(.caption)
        .foregroundStyle(.secondary)
        Spacer()
      }

      HStack {
        Spacer()
        Button("Cancel") { dismiss() }
        Button("Review creation plan") {
          isPreparing = true
          Task {
            await store.prepareEnvironmentCreation(
              in: repository,
              from: parent,
              displayName: displayName,
              purpose: purpose,
              branch: branch,
              destinationPath: destinationPath,
              strategy: strategy
            )
            isPreparing = false
            if store.pendingPlan != nil {
              dismiss()
            }
          }
        }
        .buttonStyle(.borderedProminent)
        .keyboardShortcut(.defaultAction)
        .disabled(
          isPreparing || displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        )
      }
    }
    .padding(24)
    .frame(width: 610)
    .onAppear {
      updateGeneratedValues(for: displayName)
    }
    .onChange(of: displayName) { _, newValue in
      updateGeneratedValues(for: newValue)
    }
  }

  private func updateGeneratedValues(for name: String) {
    let slug = slugify(name)
    let generatedBranch = "agent/\(slug)"
    let generatedPath =
      URL(fileURLWithPath: repository.rootPath)
      .deletingLastPathComponent()
      .appendingPathComponent("\(repository.name)-\(slug)")
      .path

    if branch == lastGeneratedBranch || branch.isEmpty {
      branch = generatedBranch
    }
    if destinationPath == lastGeneratedPath || destinationPath.isEmpty {
      destinationPath = generatedPath
    }
    lastGeneratedBranch = generatedBranch
    lastGeneratedPath = generatedPath
  }

  private func slugify(_ value: String) -> String {
    let lowered = value.folding(options: [.diacriticInsensitive], locale: .current).lowercased()
    let parts = lowered.components(separatedBy: CharacterSet.alphanumerics.inverted)
    let slug = parts.filter { !$0.isEmpty }.joined(separator: "-")
    return slug.isEmpty ? "new-task" : slug
  }
}
