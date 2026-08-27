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

When start reports `ADOPTION_REQUIRED` or `PROVISIONING_REQUIRED`, stop and direct the user to adopt the Plot or retry its provisioning in Silvic. Starting runtimes is deliberately not an implicit confirmation for provider-changing provisioning.
