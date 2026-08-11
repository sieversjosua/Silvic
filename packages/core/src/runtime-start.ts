import type { PlotRuntimeStart } from "@silvic/contracts";

export interface RuntimeStartupProcess {
  id: string;
  status: "starting" | "running" | "stopping" | "stopped" | "failed";
  exitCode?: number;
  advice?: string;
}

export function runtimeStartResult({
  commands,
  processes,
  failures,
  durationMs,
}: {
  commands: readonly string[];
  processes: readonly RuntimeStartupProcess[];
  failures: Readonly<Record<string, string>>;
  durationMs: number;
}): PlotRuntimeStart {
  if (commands.length === 0) {
    return {
      status: "not-required",
      durationMs: 0,
      detail: "This repository declares no auto-starting runtimes.",
    };
  }

  const failed = commands.flatMap((id) => {
    const explicit = failures[id];
    if (explicit) return [[id, explicit] as const];
    const process = processes.find((candidate) => candidate.id === id);
    // A routed preview remains "starting" until its concrete listener and
    // named address both answer. The later readiness phase owns that wait.
    if (process?.status === "starting" || process?.status === "running") {
      return [];
    }
    const reason =
      process?.advice ??
      (process?.exitCode === undefined
        ? "No running process was reported"
        : `Exited with code ${process.exitCode}`);
    return [[id, reason] as const];
  });

  if (failed.length === 0) return { status: "started", durationMs };
  return {
    status: "failed",
    durationMs,
    failedCommands: failed.map(([id]) => id),
    detail: `Runtimes failed during startup: ${failed
      .map(([id, reason]) => `${id} (${reason})`)
      .join(", ")}`,
  };
}
