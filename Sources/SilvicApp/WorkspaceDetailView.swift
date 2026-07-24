import SwiftUI
import WorkbenchCore

struct WorkspaceDetailView: View {
  @EnvironmentObject private var store: WorkspaceStore
  let workspace: WorkspaceSnapshot

  @State private var commitMessage = ""
  @State private var stageAll = true
  @State private var pushAfterCommit = false
  @State private var pullRequestTitle = ""
  @State private var pullRequestBody = ""
  @State private var baseBranch = "main"
  @State private var draftPullRequest = true

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        header
        statusGrid
        runtimes
        changes
        commit
        pullRequest
        integrations
      }
      .padding(24)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .overlay { if store.isWorking { ProgressView().controlSize(.large) } }
    .onAppear {
      if pullRequestTitle.isEmpty {
        pullRequestTitle = workspace.git.branch.replacingOccurrences(of: "-", with: " ").capitalized
      }
    }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(workspace.record.displayName).font(.largeTitle).fontWeight(.semibold)
      HStack {
        Text(workspace.git.branch)
        Text("·")
        Text(workspace.location.kind.displayName)
      }
      .font(.callout)
      .foregroundStyle(.secondary)
      Text(workspace.path).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
      HStack {
        Button("Finder") { store.openInFinder(workspace.path) }
        Button("Terminal") { store.openTerminal(workspace.path) }
        if let url = workspace.runtimes.compactMap(\.url).first {
          Button("Open \(url)") { store.openInBrowser(url) }
        }
      }
    }
  }

  private var statusGrid: some View {
    GroupBox("Git") {
      Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 7) {
        gridRow("Revision", String(workspace.git.revision?.prefix(10) ?? "—"))
        gridRow("Upstream", workspace.git.upstream ?? "Not configured")
        gridRow("Changes", workspace.git.isClean ? "Clean" : "\(workspace.git.changeCount)")
        gridRow("Sync", "↑ \(workspace.git.ahead)  ↓ \(workspace.git.behind)")
        if let pr = workspace.pullRequest {
          gridRow("GitHub", "PR #\(pr.number) · \(pr.state) · checks \(pr.checks.rawValue)")
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(6)
    }
  }

  @ViewBuilder private var runtimes: some View {
    if !workspace.runtimes.isEmpty {
      GroupBox("Local runtimes") {
        VStack(alignment: .leading) {
          ForEach(workspace.runtimes) { runtime in
            HStack {
              Text(runtime.name).fontWeight(.medium)
              Text(runtime.status).foregroundStyle(.secondary)
              Spacer()
              if let url = runtime.url {
                Button(url) { store.openInBrowser(url) }.buttonStyle(.link)
              }
            }
          }
        }.padding(6)
      }
    }
  }

  private var changes: some View {
    GroupBox("Changes") {
      ScrollView([.horizontal, .vertical]) {
        Text(store.changes.isEmpty ? "No changes" : store.changes)
          .font(.system(.caption, design: .monospaced))
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .frame(minHeight: 180, maxHeight: 320)
      .padding(6)
    }
  }

  private var commit: some View {
    GroupBox("Commit and push") {
      VStack(alignment: .leading, spacing: 10) {
        HStack {
          TextField("Commit message", text: $commitMessage)
          Button("Generate with Codex") {
            Task {
              if let generated = await store.generateCommitMessage() { commitMessage = generated }
            }
          }
          .disabled(workspace.git.isClean || store.isWorking)
        }
        Toggle("Stage all changes", isOn: $stageAll)
        Toggle("Push after commit", isOn: $pushAfterCommit)
        HStack {
          Button("Review Commit Plan…") {
            store.prepareCommit(message: commitMessage, stageAll: stageAll, push: pushAfterCommit)
          }
          .disabled(commitMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          Button("Push…") { store.preparePush() }
            .disabled(workspace.git.ahead == 0 && workspace.git.upstream != nil)
        }
      }.padding(6)
    }
  }

  private var pullRequest: some View {
    GroupBox("GitHub pull request") {
      VStack(alignment: .leading, spacing: 10) {
        if let pr = workspace.pullRequest {
          HStack {
            Text("#\(pr.number) \(pr.title)")
            Spacer()
            Button("Open") { store.openInBrowser(pr.url) }
          }
        } else if case .unavailable(let message) = workspace.github {
          Label("GitHub unavailable", systemImage: "exclamationmark.triangle")
            .foregroundStyle(.orange)
          Text(message).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
          Text("PR creation is disabled until GitHub status can be verified.")
            .font(.caption)
        } else {
          TextField("Title", text: $pullRequestTitle)
          TextField("Base branch", text: $baseBranch)
          TextEditor(text: $pullRequestBody)
            .font(.body)
            .frame(minHeight: 120)
            .overlay(RoundedRectangle(cornerRadius: 5).stroke(.quaternary))
          HStack {
            Toggle("Draft", isOn: $draftPullRequest)
            Spacer()
            Button("Generate body with Codex") {
              Task {
                if let generated = await store.generatePullRequestBody(base: baseBranch) {
                  pullRequestBody = generated
                }
              }
            }
            Button("Review PR Plan…") {
              store.preparePullRequest(
                title: pullRequestTitle,
                body: pullRequestBody,
                base: baseBranch,
                draft: draftPullRequest
              )
            }
            .disabled(pullRequestTitle.isEmpty || pullRequestBody.isEmpty)
          }
        }
      }.padding(6)
    }
  }

  @ViewBuilder private var integrations: some View {
    if !workspace.convexDeployments.isEmpty || !workspace.codexThreads.isEmpty {
      GroupBox("Integrations") {
        VStack(alignment: .leading, spacing: 10) {
          ForEach(workspace.convexDeployments) { deployment in
            HStack {
              Text("Convex \(deployment.kind):\(deployment.name)")
              Spacer()
              if let url = deployment.url { Button("Open") { store.openInBrowser(url) } }
            }
          }
          ForEach(workspace.codexThreads) { thread in
            VStack(alignment: .leading) {
              Text(thread.title)
              Text(thread.id).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
          }
        }.padding(6)
      }
    }
  }

  private func gridRow(_ label: String, _ value: String) -> some View {
    GridRow {
      Text(label).foregroundStyle(.secondary)
      Text(value).textSelection(.enabled)
    }
  }
}
