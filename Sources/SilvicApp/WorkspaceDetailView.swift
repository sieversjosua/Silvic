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

  private var summary: WorkspaceOperationalSummary { workspace.operationalSummary }

  var body: some View {
    VStack(spacing: 0) {
      header
      Divider()

      Picker("Workspace section", selection: $store.inspectorTab) {
        ForEach(InspectorTab.allCases) { candidate in
          Label(candidate.title, systemImage: candidate.systemImage)
            .tag(candidate)
        }
      }
      .pickerStyle(.segmented)
      .labelsHidden()
      .padding(.horizontal, 18)
      .padding(.vertical, 12)

      Divider()

      ScrollView {
        Group {
          switch store.inspectorTab {
          case .overview:
            overview
          case .changes:
            changesAndCommit
          case .ship:
            delivery
          }
        }
        .padding(18)
      }
    }
    .background(Color(nsColor: .windowBackgroundColor))
    .overlay {
      if store.isWorking {
        ZStack {
          Color.black.opacity(0.08)
          ProgressView()
            .controlSize(.large)
            .padding(22)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        }
      }
    }
    .onAppear {
      if pullRequestTitle.isEmpty {
        pullRequestTitle = workspace.git.branch
          .replacingOccurrences(of: "-", with: " ")
          .replacingOccurrences(of: "/", with: " ")
          .capitalized
      }
    }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 12) {
        VStack(alignment: .leading, spacing: 5) {
          HStack(spacing: 7) {
            Circle()
              .fill(summary.state.tint)
              .frame(width: 8, height: 8)
            Text(summary.state.title.uppercased())
              .font(.system(size: 10, weight: .semibold))
              .tracking(0.6)
              .foregroundStyle(summary.state.tint)
          }

          Text(workspace.record.displayName)
            .font(.system(size: 22, weight: .semibold, design: .rounded))
            .lineLimit(2)

          HStack(spacing: 5) {
            Text(workspace.repositoryName)
            Text("·")
            Text(workspace.git.branch)
              .font(.callout.monospaced())
            Text("·")
            Text(workspace.location.kind.displayName)
          }
          .font(.callout)
          .foregroundStyle(.secondary)
          .lineLimit(1)
        }

        Spacer()

        Menu {
          Button("Open in Codex", systemImage: "sparkles") {
            store.openInApplication(named: "Codex", path: workspace.path)
          }
          Button(
            "Open in T3 Code",
            systemImage: "chevron.left.forwardslash.chevron.right"
          ) {
            store.openInApplication(named: "T3 Code", path: workspace.path)
          }
          Button("Open in Claude Code", systemImage: "terminal") {
            store.openCommandLineHarness(.claude, path: workspace.path)
          }
          Button("Open in OpenCode", systemImage: "terminal") {
            store.openCommandLineHarness(.opencode, path: workspace.path)
          }
          Divider()
          Button("Show in Finder", systemImage: "folder") {
            store.openInFinder(workspace.path)
          }
          Button("Open Terminal", systemImage: "terminal") {
            store.openTerminal(workspace.path)
          }
          if let url = workspace.runtimes.compactMap(\.url).first {
            Button("Open \(url)", systemImage: "safari") {
              store.openInBrowser(url)
            }
          }
        } label: {
          Image(systemName: "ellipsis.circle")
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
      }

      HStack(spacing: 10) {
        Label(summary.message, systemImage: summary.state.systemImage)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)

        Spacer()

        Button {
          store.performPrimaryAction(for: workspace)
        } label: {
          Label(summary.action.title, systemImage: summary.action.systemImage)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.small)
      }

      Text(workspace.path)
        .font(.caption2.monospaced())
        .foregroundStyle(.tertiary)
        .lineLimit(1)
        .truncationMode(.middle)
        .textSelection(.enabled)
    }
    .padding(18)
  }

  private var overview: some View {
    VStack(spacing: 14) {
      InspectorPanel(title: "Code", systemImage: "chevron.left.forwardslash.chevron.right") {
        InspectorValueRow(
          label: "Working tree",
          value: workspace.git.isClean ? "Clean" : "\(workspace.git.changeCount) changes",
          tint: workspace.git.isClean ? .green : .orange
        )
        InspectorValueRow(
          label: "Upstream",
          value: workspace.git.upstream ?? "Not configured"
        )
        InspectorValueRow(
          label: "Sync",
          value: "↑ \(workspace.git.ahead)  ↓ \(workspace.git.behind)"
        )
        InspectorValueRow(
          label: "Revision",
          value: String(workspace.git.revision?.prefix(10) ?? "—"),
          monospaced: true
        )

        if !workspace.git.isClean {
          Button("Review changes") { store.inspectorTab = .changes }
            .buttonStyle(.link)
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
      }

      InspectorPanel(title: "Runtime", systemImage: "network") {
        if workspace.runtimes.isEmpty {
          EmptyResourceRow(
            title: "No local runtime detected",
            detail: "Open the Workspace in Terminal to start its development command."
          )
        } else {
          ForEach(workspace.runtimes) { runtime in
            HStack(spacing: 9) {
              Circle()
                .fill(runtime.isActive ? .green : .secondary)
                .frame(width: 7, height: 7)
              VStack(alignment: .leading, spacing: 2) {
                Text(runtime.name)
                  .fontWeight(.medium)
                Text(runtime.status)
                  .font(.caption)
                  .foregroundStyle(.secondary)
              }
              Spacer()
              if let url = runtime.url {
                Button(url) { store.openInBrowser(url) }
                  .buttonStyle(.link)
                  .lineLimit(1)
              }
            }
          }
        }
      }

      InspectorPanel(title: "Environment", systemImage: "cloud") {
        if workspace.convexDeployments.isEmpty {
          EmptyResourceRow(
            title: "No environment attached",
            detail: "Silvic did not find Convex metadata in this checkout."
          )
        } else {
          ForEach(workspace.convexDeployments) { deployment in
            HStack {
              VStack(alignment: .leading, spacing: 2) {
                Text(deployment.name)
                  .fontWeight(.medium)
                Text("Convex · \(deployment.kind)")
                  .font(.caption)
                  .foregroundStyle(.secondary)
              }
              Spacer()
              if let url = deployment.url {
                Button("Open") { store.openInBrowser(url) }
              }
            }
          }
        }
      }

      InspectorPanel(title: "Sessions", systemImage: "bubble.left.and.bubble.right") {
        if workspace.codexThreads.isEmpty {
          EmptyResourceRow(
            title: "No Codex tasks found",
            detail: "Sessions are attached by their working directory."
          )
        } else {
          ForEach(workspace.codexThreads) { thread in
            VStack(alignment: .leading, spacing: 3) {
              Text(thread.title)
                .fontWeight(.medium)
                .lineLimit(2)
              Text(thread.id)
                .font(.caption2.monospaced())
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .textSelection(.enabled)
            }
          }
        }
      }

      InspectorPanel(title: "Review", systemImage: "arrow.triangle.pull") {
        if let pullRequest = workspace.pullRequest {
          HStack {
            VStack(alignment: .leading, spacing: 3) {
              Text("#\(pullRequest.number) \(pullRequest.title)")
                .fontWeight(.medium)
                .lineLimit(2)
              Text("\(pullRequest.state) · checks \(pullRequest.checks.rawValue)")
                .font(.caption)
                .foregroundStyle(checkColor(for: pullRequest.checks))
            }
            Spacer()
            Button("Open") { store.openInBrowser(pullRequest.url) }
          }
        } else if case .unavailable(let reason) = workspace.github {
          EmptyResourceRow(
            title: "GitHub status unavailable",
            detail: reason
          )
          Button("Refresh GitHub status") {
            Task {
              await store.refreshGitHubAuth()
              await store.refresh()
            }
          }
          .buttonStyle(.link)
          .frame(maxWidth: .infinity, alignment: .trailing)
        } else {
          EmptyResourceRow(
            title: "No pull request",
            detail: "Prepare and open a pull request from the Ship section."
          )
          Button("Prepare pull request") { store.inspectorTab = .ship }
            .buttonStyle(.link)
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
      }
    }
  }

  private var changesAndCommit: some View {
    VStack(spacing: 14) {
      InspectorPanel(title: "Changes", systemImage: "doc.text.magnifyingglass") {
        HStack {
          Text(
            workspace.git.isClean
              ? "Working tree is clean"
              : "\(workspace.git.changeCount) uncommitted change\(workspace.git.changeCount == 1 ? "" : "s")"
          )
          .fontWeight(.medium)
          Spacer()
          if workspace.git.staged > 0 {
            InspectorTag("\(workspace.git.staged) staged", tint: .green)
          }
          if workspace.git.unstaged > 0 {
            InspectorTag("\(workspace.git.unstaged) unstaged", tint: .orange)
          }
          if workspace.git.untracked > 0 {
            InspectorTag("\(workspace.git.untracked) new", tint: .blue)
          }
        }

        ScrollView([.horizontal, .vertical]) {
          Text(store.changes.isEmpty ? "No changes" : store.changes)
            .font(.system(size: 11, design: .monospaced))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
        }
        .frame(minHeight: 260, maxHeight: 420)
        .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 7))
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(.quaternary))
      }

      InspectorPanel(title: "Commit", systemImage: "checkmark.circle") {
        TextField("Describe this change", text: $commitMessage)

        HStack {
          Toggle("Stage all", isOn: $stageAll)
          Toggle("Push after commit", isOn: $pushAfterCommit)
          Spacer()
        }
        .toggleStyle(.checkbox)

        HStack {
          Button {
            Task {
              if let generated = await store.generateCommitMessage() {
                commitMessage = generated
              }
            }
          } label: {
            Label("Draft with Codex", systemImage: "sparkles")
          }
          .disabled(workspace.git.isClean || store.isWorking)

          Spacer()

          Button {
            store.prepareCommit(
              message: commitMessage,
              stageAll: stageAll,
              push: pushAfterCommit
            )
          } label: {
            Label("Review commit plan", systemImage: "arrow.right")
          }
          .buttonStyle(.borderedProminent)
          .disabled(commitMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      }
    }
  }

  private var delivery: some View {
    VStack(spacing: 14) {
      InspectorPanel(title: "Branch delivery", systemImage: "arrow.up.circle") {
        InspectorValueRow(label: "Branch", value: workspace.git.branch, monospaced: true)
        InspectorValueRow(
          label: "Upstream",
          value: workspace.git.upstream ?? "Will be configured on push"
        )
        InspectorValueRow(
          label: "Sync",
          value: "↑ \(workspace.git.ahead)  ↓ \(workspace.git.behind)"
        )

        HStack {
          Spacer()
          Button {
            store.preparePush()
          } label: {
            Label("Review push plan", systemImage: "arrow.up")
          }
          .disabled(workspace.git.ahead == 0 && workspace.git.upstream != nil)
        }
      }

      InspectorPanel(title: "Pull request", systemImage: "arrow.triangle.pull") {
        if let pullRequest = workspace.pullRequest {
          VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
              VStack(alignment: .leading, spacing: 4) {
                Text("#\(pullRequest.number)")
                  .font(.caption.monospaced())
                  .foregroundStyle(.secondary)
                Text(pullRequest.title)
                  .font(.headline)
              }
              Spacer()
              InspectorTag(
                pullRequest.checks.rawValue.capitalized,
                tint: checkColor(for: pullRequest.checks)
              )
            }

            Button("Open on GitHub") {
              store.openInBrowser(pullRequest.url)
            }
            .buttonStyle(.borderedProminent)
            .frame(maxWidth: .infinity, alignment: .trailing)
          }
        } else if case .unavailable(let message) = workspace.github {
          EmptyResourceRow(title: "GitHub unavailable", detail: message)
        } else {
          TextField("Pull request title", text: $pullRequestTitle)

          HStack {
            TextField("Base branch", text: $baseBranch)
            Toggle("Draft", isOn: $draftPullRequest)
              .toggleStyle(.checkbox)
              .fixedSize()
          }

          TextEditor(text: $pullRequestBody)
            .font(.body)
            .frame(minHeight: 150)
            .padding(5)
            .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 7))
            .overlay(RoundedRectangle(cornerRadius: 7).stroke(.quaternary))

          HStack {
            Button {
              Task {
                if let generated = await store.generatePullRequestBody(base: baseBranch) {
                  pullRequestBody = generated
                }
              }
            } label: {
              Label("Draft with Codex", systemImage: "sparkles")
            }

            Spacer()

            Button {
              store.preparePullRequest(
                title: pullRequestTitle,
                body: pullRequestBody,
                base: baseBranch,
                draft: draftPullRequest
              )
            } label: {
              Label("Review PR plan", systemImage: "arrow.right")
            }
            .buttonStyle(.borderedProminent)
            .disabled(pullRequestTitle.isEmpty || pullRequestBody.isEmpty)
          }
        }
      }
    }
  }

  private func checkColor(for checks: PullRequestSummary.Checks) -> Color {
    switch checks {
    case .success: .green
    case .failure: .red
    case .pending: .orange
    case .unknown: .secondary
    }
  }
}

enum InspectorTab: String, CaseIterable, Identifiable {
  case overview
  case changes
  case ship

  var id: String { rawValue }

  var title: String {
    switch self {
    case .overview: "Overview"
    case .changes: "Changes"
    case .ship: "Ship"
    }
  }

  var systemImage: String {
    switch self {
    case .overview: "square.grid.2x2"
    case .changes: "doc.text.magnifyingglass"
    case .ship: "arrow.up.right"
    }
  }
}

private struct InspectorPanel<Content: View>: View {
  let title: String
  let systemImage: String
  @ViewBuilder let content: Content

  init(
    title: String,
    systemImage: String,
    @ViewBuilder content: () -> Content
  ) {
    self.title = title
    self.systemImage = systemImage
    self.content = content()
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Label(title, systemImage: systemImage)
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(.secondary)

      content
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.primary.opacity(0.07)))
  }
}

private struct InspectorValueRow: View {
  let label: String
  let value: String
  var tint: Color = .primary
  var monospaced = false

  var body: some View {
    HStack(alignment: .firstTextBaseline) {
      Text(label)
        .foregroundStyle(.secondary)
      Spacer()
      Text(value)
        .font(monospaced ? .callout.monospaced() : .callout)
        .foregroundStyle(tint)
        .multilineTextAlignment(.trailing)
        .textSelection(.enabled)
    }
  }
}

private struct EmptyResourceRow: View {
  let title: String
  let detail: String

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(title)
        .fontWeight(.medium)
      Text(detail)
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }
}

private struct InspectorTag: View {
  let title: String
  let tint: Color

  init(_ title: String, tint: Color) {
    self.title = title
    self.tint = tint
  }

  var body: some View {
    Text(title)
      .font(.caption2.weight(.medium))
      .foregroundStyle(tint)
      .padding(.horizontal, 7)
      .padding(.vertical, 3)
      .background(tint.opacity(0.1), in: Capsule())
  }
}
