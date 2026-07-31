import type { PlotPreview } from "@silvic/contracts";

type PollResult = "ready" | "timed-out" | "cancelled";

interface PollNamedRoutingOptions {
  preview(): Promise<PlotPreview>;
  onPreview(preview: PlotPreview): void;
  wait(milliseconds: number): Promise<void>;
  isCancelled(): boolean;
  maxAttempts?: number;
}

export function namedRoutingReady(preview: PlotPreview | undefined): boolean {
  return preview !== undefined && preview.advice === undefined;
}

export async function pollNamedRouting({
  preview,
  onPreview,
  wait,
  isCancelled,
  maxAttempts = 80,
}: PollNamedRoutingOptions): Promise<PollResult> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await wait(attempt === 0 ? 500 : 1_500);
    if (isCancelled()) return "cancelled";

    const next = await preview();
    if (isCancelled()) return "cancelled";
    onPreview(next);
    if (!next.advice) return "ready";
  }

  return "timed-out";
}
