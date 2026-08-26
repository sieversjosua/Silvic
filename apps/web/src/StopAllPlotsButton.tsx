import { useEffect, useState } from "react";
import { Square } from "lucide-react";

import type { PlotProcess } from "@silvic/contracts";

import { failureMessage } from "./errors";

const activeStatuses = new Set<PlotProcess["status"]>([
  "starting",
  "running",
  "stopping",
]);

export function managedActivePlots(processes: readonly PlotProcess[]): number {
  return new Set(
    processes
      .filter(
        (process) =>
          process.ownership !== "external" &&
          activeStatuses.has(process.status),
      )
      .map((process) => process.plotPath),
  ).size;
}

/** App-level emergency stop for every runtime owned by Silvic. */
export function StopAllPlotsButton({
  processes,
  onFailure,
}: {
  processes: readonly PlotProcess[];
  onFailure(message: string): void;
}) {
  const [working, setWorking] = useState(false);
  const plotCount = managedActivePlots(processes);
  const onlyStopping =
    plotCount > 0 &&
    processes
      .filter(
        (process) =>
          process.ownership !== "external" &&
          activeStatuses.has(process.status),
      )
      .every((process) => process.status === "stopping");
  const stopping = working || onlyStopping;

  useEffect(() => {
    if (plotCount === 0) setWorking(false);
  }, [plotCount]);

  const stopAll = () => {
    if (plotCount === 0 || stopping) return;
    setWorking(true);
    void window.silvic.stopAllPlotCommands().catch((error: unknown) => {
      setWorking(false);
      onFailure(failureMessage(error));
    });
  };

  return (
    <button
      type="button"
      className="rail-action stop-all-plots"
      disabled={plotCount === 0 || stopping}
      aria-label={stopping ? "All plots are stopping" : "Stop all plots"}
      title="Stop every runtime managed by Silvic"
      onClick={stopAll}
    >
      <Square size={12} />
      <span>{stopping ? "Stopping all plots…" : "Stop all plots"}</span>
      {plotCount > 0 && (
        <span className="stop-all-count mono">{plotCount}</span>
      )}
    </button>
  );
}
