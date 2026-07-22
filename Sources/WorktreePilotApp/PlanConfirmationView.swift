import SwiftUI
import WorkbenchCore

struct PlanConfirmationView: View {
  @EnvironmentObject private var store: WorkspaceStore
  @Environment(\.dismiss) private var dismiss
  let plan: GitWorkflowPlan

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      Text(plan.title).font(.title2).fontWeight(.semibold)
      Text("Review every state-changing step before execution.")
        .foregroundStyle(.secondary)

      ForEach(Array(plan.steps.enumerated()), id: \.element.id) { index, step in
        HStack(alignment: .top) {
          Text("\(index + 1).")
          VStack(alignment: .leading, spacing: 3) {
            Text(step.summary).fontWeight(.medium)
            Text(commandLine(step.command))
              .font(.system(.caption, design: .monospaced))
              .foregroundStyle(.secondary)
              .textSelection(.enabled)
          }
        }
      }

      ForEach(plan.warnings, id: \.self) { warning in
        Label(warning, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
      }

      HStack {
        Spacer()
        Button("Cancel") {
          store.pendingPlan = nil
          dismiss()
        }
        Button("Execute") {
          Task {
            await store.executePendingPlan()
            dismiss()
          }
        }
        .keyboardShortcut(.defaultAction)
        .disabled(store.isWorking)
      }
    }
    .padding(24)
    .frame(minWidth: 560)
  }

  private func commandLine(_ request: CommandRequest) -> String {
    ([request.executable] + request.arguments.map(shellQuote)).joined(separator: " ")
  }

  private func shellQuote(_ value: String) -> String {
    guard value.contains(where: \.isWhitespace) else { return value }
    return "'\(value.replacingOccurrences(of: "'", with: "'\\''"))'"
  }
}
