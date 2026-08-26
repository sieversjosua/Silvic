export const sessionRefreshIntervalMs = 10_000;

export interface SessionRefreshLoopOptions {
  isVisible(): boolean;
  refresh(): void | Promise<void>;
}

export function startSessionRefreshLoop(
  options: SessionRefreshLoopOptions,
): () => void {
  const timer = setInterval(() => {
    if (!options.isVisible()) return;
    void Promise.resolve(options.refresh()).catch(() => undefined);
  }, sessionRefreshIntervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
