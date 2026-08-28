---
name: silvic-preview
description: Run and inspect a local Silvic Plot preview when a task needs its declared runtimes, canonical preview URL, readiness, or logs.
---

Use Silvic's MCP tools for the lifecycle; the desktop UI is not part of this workflow.

1. List Plots and select the stable Plot ID matching the workspace. Read status when the choice or current state is unclear.
2. Start all runtimes, or pass a runtime ID only when the task needs one. Inspect every per-runtime outcome before continuing; partial failure is not readiness.
3. Wait for the preview. Wait is a pure observation and never starts a stopped runtime. Use the canonical URL returned by the wait result.
4. Inspect that URL with the available browser tooling.
5. Read runtime logs and diagnostics when start, readiness, or inspection fails.
6. Stop the runtimes started for the task when the preview is no longer needed.

Stopping an externally managed runtime detaches Silvic's route and leaves the external process running. Treat the returned `detached` outcome as success and do not try to terminate that process through another tool.

When start reports `ADOPTION_REQUIRED` or `PROVISIONING_REQUIRED`, use `plan_plot_adoption` and show the provider-changing steps and any automatic-policy rejection reasons before continuing. Use the returned selected stable Plot ID as `confirmPlotId` only after provider changes are explicitly approved. Call `adopt_plot` for adoption or `provision_plot` for an adopted Plot whose provisioning failed. Inspect every member and step result; retry failed work when appropriate. A trusted repository may preapprove one detached disposable Plot through its bounded `isolated-disposable` policy; in that case, inspect the `automaticAdoption` plan and result returned by start. Starting runtimes is otherwise deliberately not an implicit confirmation for provider-changing provisioning.
