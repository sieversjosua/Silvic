import type { PlotProgress, PlotProgressStep } from "@silvic/contracts";

/** Control sequences a terminal would act on and an interface would show. */
const controlSequences = new RegExp("\\u001B\\[[0-9;?]*[ -/]*[@-~]", "g");
const detailLimit = 200;
/**
 * Installers print thousands of lines. Status changes are sent the moment they
 * happen; output is coalesced, because the renderer only shows the newest line
 * and nobody can read faster than this anyway.
 */
const outputQuietPeriodMs = 90;

/**
 * Creating a plot takes minutes and happens entirely in the main process. The
 * reporter is what the renderer watches in the meantime: one step per thing
 * Silvic actually does, in the order it does them.
 */
export class PlotProgressReporter {
  private readonly steps: PlotProgressStep[];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly branch: string,
    steps: readonly { id: string; label: string }[],
    private readonly send: (progress: PlotProgress) => void,
  ) {
    this.steps = steps.map((step) => ({ ...step, status: "pending" }));
  }

  /** The plan, before anything has run. */
  announce(): void {
    this.publish();
  }

  began(id: string): void {
    this.change(id, (step) => ({
      id: step.id,
      label: step.label,
      status: "running",
    }));
    this.publish();
  }

  wrote(id: string, chunk: string): void {
    const detail = newestLine(chunk);
    if (!detail) return;
    const changed = this.change(id, (step) =>
      step.status === "running" ? { ...step, detail } : step,
    );
    if (changed) this.publishSoon();
  }

  finished(id: string, durationMs?: number): void {
    this.change(id, (step) => ({
      id: step.id,
      label: step.label,
      status: "done",
      ...(durationMs === undefined ? {} : { durationMs }),
    }));
    this.publish();
  }

  failed(id: string, detail: string): void {
    const line = newestLine(detail);
    this.change(id, (step) => ({
      id: step.id,
      label: step.label,
      status: "failed",
      ...(line ? { detail: line } : {}),
    }));
    this.publish();
  }

  /**
   * Something threw. The step that was running is the one that failed, even
   * when the error came from around the command rather than from it.
   */
  stumbled(detail: string): void {
    const running = this.steps.find((step) => step.status === "running");
    if (running) this.failed(running.id, detail);
  }

  /** No more events; drop any coalesced send still waiting on its timer. */
  settled(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private change(
    id: string,
    next: (step: PlotProgressStep) => PlotProgressStep,
  ): boolean {
    const index = this.steps.findIndex((step) => step.id === id);
    const current = this.steps[index];
    if (!current) return false;
    this.steps[index] = next(current);
    return true;
  }

  private publish(): void {
    this.settled();
    this.send({
      branch: this.branch,
      steps: this.steps.map((step) => ({ ...step })),
    });
  }

  private publishSoon(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.publish();
    }, outputQuietPeriodMs);
  }
}

/**
 * Progress bars redraw with carriage returns and tools pad with blank lines,
 * so the newest thing worth showing is the last line that says something.
 */
function newestLine(chunk: string): string {
  const lines = chunk.replaceAll(controlSequences, "").split(/\r?\n|\r/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (line) return line.slice(0, detailLimit);
  }
  return "";
}
