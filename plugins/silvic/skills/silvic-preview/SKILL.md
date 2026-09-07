---
name: silvic-preview
description: Run and inspect a local Silvic Plot preview when a task needs its declared runtimes, canonical preview URL, readiness, or logs.
---

Use the bundled CLI at `../../bin/silvic`, resolved relative to this skill file.
Run it from the task's checkout; `--plot` defaults to the current Git root.

For a development preview, run `silvic preview --json` once and inspect the
returned URL with browser tooling. It starts runtimes except those explicitly
marked `autoStart: false`, then waits for readiness.
Select `--runtime preview` for an already-built production preview;
starting a runtime does not rebuild it. Read `--help` for other operations.

Use `status --json` or `logs --json` when an operation fails. For a stale
environment or build, `provision --refresh --confirm ID --json` reruns the
recipe in the existing Plot, stopping its managed runtimes first. The typed
Convex step reuses its deployment; shell steps run as declared. Use the stable ID from status and existing user
authorization for the recipe's changes.

On `ADOPTION_REQUIRED` or `PROVISIONING_REQUIRED`, inspect `adoption-plan --json`.
Use an offered policy or already-authorized adoption/provisioning; ask only for
provider changes not covered by existing authorization. A remedy reporting
`dataLoss` needs authorization for that loss.

Stop only runtimes started for this task. `detached` means an external process
was left running by design. Partial failure is not readiness.
