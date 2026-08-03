export interface ReadinessResult {
  status: "ready" | "failed";
  durationMs: number;
  detail?: string;
}

export interface ReadinessOptions {
  url: string;
  probe(url: string): Promise<boolean>;
  timeoutMs?: number;
  intervalMs?: number;
  wait?(milliseconds: number): Promise<void>;
  now?(): number;
}

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/**
 * A spawned dev server is not necessarily usable yet. This waits for the
 * published address itself, so callers can distinguish a live preview from a
 * process that is still compiling, wedged, or already gone.
 */
export async function waitForReadiness(
  options: ReadinessOptions,
): Promise<ReadinessResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 500;
  const wait = options.wait ?? pause;
  const now = options.now ?? Date.now;
  const startedAt = now();
  let attempted = false;
  let latestFailure: string | undefined;

  while (true) {
    const elapsed = now() - startedAt;
    if (attempted && elapsed >= timeoutMs) {
      const limit =
        timeoutMs >= 1_000 && timeoutMs % 1_000 === 0
          ? `${timeoutMs / 1_000} s`
          : `${timeoutMs} ms`;
      return {
        status: "failed",
        durationMs: elapsed,
        detail: `The preview did not respond within ${limit}.${latestFailure ? ` Last check: ${latestFailure}` : ""}`,
      };
    }

    attempted = true;
    try {
      if (await options.probe(options.url)) {
        return { status: "ready", durationMs: now() - startedAt };
      }
    } catch (error) {
      latestFailure = error instanceof Error ? error.message : String(error);
    }

    const remaining = timeoutMs - (now() - startedAt);
    if (remaining <= 0) continue;
    await wait(Math.min(intervalMs, remaining));
  }
}
